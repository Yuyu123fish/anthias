import { spawn } from "node:child_process";

const DEFAULT_OUTPUT_BYTE_LIMIT = 128 * 1024;
const DEFAULT_TIMEOUT_MILLISECONDS = 120_000;
const TERMINATION_GRACE_MILLISECONDS = 2_000;

export type GitCommandResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}>;

export class GitCommandError extends Error {
  readonly result: GitCommandResult;

  constructor(message: string, result: GitCommandResult) {
    super(message);
    this.name = "GitCommandError";
    this.result = result;
  }
}

export class GitCommandAbortedError extends Error {
  constructor() {
    super("Git 操作已取消。");
    this.name = "GitCommandAbortedError";
  }
}

type RunGitOptions = Readonly<{
  cwd: string;
  arguments: readonly string[];
  signal?: AbortSignal;
  allowedExitCodes?: readonly number[];
  outputByteLimit?: number;
  readOnly?: boolean;
}>;

/** 使用固定 argv 执行 Git，并在取消后等待子进程退出。 */
export async function runGit(options: RunGitOptions): Promise<GitCommandResult> {
  if (options.signal?.aborted) {
    throw new GitCommandAbortedError();
  }
  const allowedExitCodes = options.allowedExitCodes ?? [0];
  const outputByteLimit = options.outputByteLimit ?? DEFAULT_OUTPUT_BYTE_LIMIT;
  const commandArguments = [
    "--no-pager",
    "-c",
    "color.ui=false",
    "-c",
    "core.quotepath=false",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    ...options.arguments,
  ];
  const childProcess = spawn("git", commandArguments, {
    cwd: options.cwd,
    env: createGitEnvironment(options.readOnly === true),
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolve, reject) => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let truncated = false;
    let aborted = false;
    let timedOut = false;
    let settled = false;
    let terminationTimer: NodeJS.Timeout | undefined;

    const appendOutput = (current: Buffer, chunk: Buffer): Buffer => {
      if (current.byteLength >= outputByteLimit) {
        truncated = true;
        return current;
      }
      const remaining = outputByteLimit - current.byteLength;
      if (chunk.byteLength > remaining) {
        truncated = true;
        return Buffer.concat([current, chunk.subarray(0, remaining)]);
      }
      return Buffer.concat([current, chunk]);
    };

    const requestTermination = () => {
      if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
        return;
      }
      terminateProcessTree(childProcess.pid);
      terminationTimer = setTimeout(() => {
        forceTerminateProcessTree(childProcess.pid);
      }, TERMINATION_GRACE_MILLISECONDS);
    };

    const handleAbort = () => {
      aborted = true;
      requestTermination();
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      requestTermination();
    }, DEFAULT_TIMEOUT_MILLISECONDS);

    const finish = (result: GitCommandResult | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (terminationTimer !== undefined) clearTimeout(terminationTimer);
      options.signal?.removeEventListener("abort", handleAbort);
      childProcess.stdout?.destroy();
      childProcess.stderr?.destroy();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    childProcess.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk);
    });
    childProcess.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk);
    });
    childProcess.once("error", (error) => finish(error));
    childProcess.once("close", (exitCode) => {
      const result = Object.freeze({
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        exitCode: exitCode ?? -1,
        truncated,
      });
      if (aborted) {
        finish(new GitCommandAbortedError());
        return;
      }
      if (timedOut) {
        finish(new GitCommandError("Git 操作超时。", result));
        return;
      }
      if (!allowedExitCodes.includes(result.exitCode)) {
        const diagnostic = result.stderr.trim() || result.stdout.trim();
        const boundedDiagnostic =
          diagnostic.length > 4096 ? `${diagnostic.slice(0, 4096)}…` : diagnostic;
        finish(
          new GitCommandError(
            boundedDiagnostic.length > 0 ? `Git 操作失败：${boundedDiagnostic}` : "Git 操作失败。",
            result,
          ),
        );
        return;
      }
      finish(result);
    });

    options.signal?.addEventListener("abort", handleAbort, { once: true });
    if (options.signal?.aborted) handleAbort();
  });
}

function createGitEnvironment(readOnly: boolean): NodeJS.ProcessEnv {
  const allowedNames =
    process.platform === "win32"
      ? [
          "PATH",
          "PATHEXT",
          "SYSTEMROOT",
          "WINDIR",
          "COMSPEC",
          "SYSTEMDRIVE",
          "TEMP",
          "TMP",
          "OS",
          "PROCESSOR_ARCHITECTURE",
          "NUMBER_OF_PROCESSORS",
        ]
      : ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR"];
  const allowedNameSet = new Set(allowedNames.map((name) => name.toLocaleLowerCase("en-US")));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) => value !== undefined && allowedNameSet.has(name.toLocaleLowerCase("en-US")),
    ),
  );
  return {
    ...environment,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GIT_PAGER: "cat",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
    GIT_OPTIONAL_LOCKS: readOnly ? "0" : "1",
    LC_ALL: "C",
    LANG: "C",
  };
}

function terminateProcessTree(processId: number | undefined): void {
  if (processId === undefined) return;
  try {
    if (process.platform === "win32") {
      const terminator = spawn("taskkill.exe", ["/PID", String(processId), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      terminator.unref();
      return;
    }
    process.kill(-processId, "SIGTERM");
  } catch {
    // close 事件仍是唯一终态；宽限结束后会再尝试强制终止。
  }
}

function forceTerminateProcessTree(processId: number | undefined): void {
  if (processId === undefined) return;
  try {
    process.kill(process.platform === "win32" ? processId : -processId, "SIGKILL");
  } catch {
    // 进程可能已在正常取消路径中退出。
  }
}
