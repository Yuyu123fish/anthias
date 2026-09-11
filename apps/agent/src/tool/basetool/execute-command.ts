import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { AssistantToolCallPart } from "../../message.js";
import type { PermissionMode } from "../../permission/permission-mode.js";
import { decideToolPolicy } from "../../permission/tool-policy.js";
import type { SessionShell } from "../../session/index.js";
import {
  hasOnlyKeys,
  isNonEmptyString,
  isOptionalIntegerInRange,
  isOptionalNonEmptyString,
  isRecord,
} from "../input-validation.js";
import {
  createApprovalPlan,
  createRejectedToolCallPlan,
  createToolActivitySummary,
  failedExecution,
  policyResult,
} from "../tool-plan.js";
import {
  boundToolOutput,
  type ToolExecutionResult,
  type ToolFailedResult,
} from "../tool-result.js";
import type { BaseTool, CreateToolRunnerOptions, ToolCallPlan } from "../tool-runner.js";
import { sharedWorkspaceAccess } from "../workspace-access.js";
import {
  arePathsEqual,
  resolveExistingWorkspacePath,
  type ToolWorkspace,
} from "../workspace-path.js";
import {
  createCommandOutputCapture,
  createCommandOutputCollector,
  createCommandResult,
  splitCommandOutputLines,
} from "./command-output.js";

export const executeCommandTool: BaseTool = Object.freeze({
  definition: Object.freeze({
    name: "execute_command",
    description:
      "在 Session 固定 Shell 中执行一次性非交互命令。cwd 是工作区相对目录，省略时为根目录；不要传绝对路径。",
    inputSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["command"],
      properties: {
        command: { type: "string", minLength: 1 },
        cwd: { type: "string", minLength: 1 },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 1800000 },
      },
    }),
  }),
  createPlan(toolCall, permissionMode, options) {
    const validationError = validateCommandToolCallInput(toolCall);
    if (validationError !== null) return createRejectedToolCallPlan(validationError);
    if (options.writable === false) return createRejectedToolCallPlan("当前成员只能读取工作区。");
    return createCommandToolCallPlan(toolCall, permissionMode, options);
  },
});

/** 保存一次已经完成预检、仍未启动子进程的命令调用。 */
export type PreparedCommandTool = Readonly<{
  toolName: "execute_command";
  toolCallId: string;
  workspace: ToolWorkspace;
  target: string;
  preview: string;
  command: string;
  cwd: string;
  cwdIdentity: Readonly<{ device: number; inode: number }>;
  timeoutMilliseconds: number;
  shell: SessionShell;
}>;

/** 表示命令预检成功，或无需确认即可返回模型的安全失败。 */
export type PreparedCommandResult =
  | Readonly<{ ok: true; preparedTool: PreparedCommandTool }>
  | Readonly<{ ok: false; result: ToolFailedResult }>;

/** 描述一次命令执行期间可公开的有界输出增量。 */
export type CommandExecutionUpdate = Readonly<{
  stream: "stdout" | "stderr";
  delta: string;
}>;

/** 保存命令终结结果以及进程树清理是否能够确认。 */
export type CommandExecutionResult = ToolExecutionResult &
  Readonly<{
    cleanupUncertain: boolean;
  }>;

/** 枚举一次命令可以进入的明确终止原因。 */
export type CommandTerminationReason =
  | "completed"
  | "non_zero_exit"
  | "spawn_failed"
  | "timeout"
  | "aborted";

const DEFAULT_COMMAND_TIMEOUT_MILLISECONDS = 120_000;
const MINIMUM_COMMAND_TIMEOUT_MILLISECONDS = 1_000;
const MAXIMUM_COMMAND_TIMEOUT_MILLISECONDS = 1_800_000;
const PROCESS_TREE_SHUTDOWN_GRACE_MILLISECONDS = 2_000;
const PROCESS_TREE_SIGNAL_GRACE_MILLISECONDS = 750;
const PROCESS_TREE_POLL_MILLISECONDS = 25;

/** 只检查 command Tool 的运行时输入形状，不解析路径或启动进程。 */
export function validateCommandToolCallInput(toolCall: AssistantToolCallPart): string | null {
  const inputResult = parseCommandInput(toolCall);
  return inputResult.ok ? null : inputResult.error;
}

/** 无副作用地校验并形成每次 execute_command 确认所需的完整预览。 */
export async function prepareCommandTool(
  toolCall: AssistantToolCallPart,
  workspace: ToolWorkspace,
  shell: SessionShell,
): Promise<PreparedCommandResult> {
  const inputResult = parseCommandInput(toolCall);
  if (!inputResult.ok) {
    return failedPreparation(inputResult.error);
  }

  try {
    const resolvedCwd = await resolveExistingWorkspacePath(inputResult.input.cwd, workspace);
    const cwdStats = await stat(resolvedCwd.absolutePath);
    if (!cwdStats.isDirectory()) {
      return failedPreparation("execute_command cwd 不是目录。");
    }
    const target = resolvedCwd.relativePath.length === 0 ? "." : resolvedCwd.relativePath;
    const previewResult = boundToolOutput([
      "operation: execute command",
      `shell: ${renderShell(shell)}`,
      `cwd: ${target}`,
      `timeoutMs: ${inputResult.input.timeoutMilliseconds}`,
      "command:",
      ...splitCommandOutputLines(inputResult.input.command),
    ]);
    if (previewResult.truncated) {
      return failedPreparation("execute_command 确认内容超过 64 KiB 或 2,000 行，请缩短命令。");
    }
    return Object.freeze({
      ok: true,
      preparedTool: Object.freeze({
        toolName: "execute_command",
        toolCallId: toolCall.toolCallId,
        workspace,
        target,
        preview: previewResult.content,
        command: inputResult.input.command,
        cwd: resolvedCwd.absolutePath,
        cwdIdentity: Object.freeze({ device: cwdStats.dev, inode: cwdStats.ino }),
        timeoutMilliseconds: inputResult.input.timeoutMilliseconds,
        shell,
      }),
    });
  } catch (error) {
    return failedPreparation(toSafeCommandError(error));
  }
}

/** 启动一次已经展示并批准的固定 Shell 命令，并收口输出、超时与取消。 */
export async function executePreparedCommand(
  preparedTool: PreparedCommandTool,
  abortSignal: AbortSignal,
  publishUpdate: (update: CommandExecutionUpdate) => void,
): Promise<CommandExecutionResult> {
  if (abortSignal.aborted) {
    return createCommandResult("aborted", null, 0, createCommandOutputCollector(), false);
  }

  const workspace = preparedTool.workspace;
  const workspaceAccess = workspace.workspaceAccess ?? sharedWorkspaceAccess;
  let releaseWrite: (() => void) | undefined;
  let retainWriteLease = false;
  workspace.resourceState?.(preparedTool.toolCallId, "waiting");
  try {
    releaseWrite = await workspaceAccess.acquireExclusiveWrite(
      [workspace.workspaceRoot, preparedTool.cwd],
      abortSignal,
    );
    workspace.resourceState?.(preparedTool.toolCallId, "acquired");
    workspace.assertWriteAllowed?.(preparedTool.toolCallId);
    const result = await executeCommandWithWriteAccess(preparedTool, abortSignal, publishUpdate);
    // 进程树清理不明时保留独占权，不能让后续写入与可能仍存活的命令竞争。
    retainWriteLease = result.cleanupUncertain;
    return result;
  } catch (error) {
    return abortSignal.aborted
      ? createCommandResult("aborted", null, 0, createCommandOutputCollector(), false)
      : {
          status: "failed",
          content: toSafeCommandError(error),
          truncated: false,
          cleanupUncertain: false,
        };
  } finally {
    if (!retainWriteLease) {
      releaseWrite?.();
      workspace.resourceState?.(preparedTool.toolCallId, "released");
    }
  }
}

async function executeCommandWithWriteAccess(
  preparedTool: PreparedCommandTool,
  abortSignal: AbortSignal,
  publishUpdate: (update: CommandExecutionUpdate) => void,
): Promise<CommandExecutionResult> {
  // 批准只绑定准备时的真实目录；同路径目录被替换或转成链接后不得复用旧批准。
  let cwdUnchanged = false;
  try {
    const currentCwd = await realpath(preparedTool.cwd);
    const currentCwdStats = await stat(currentCwd);
    cwdUnchanged =
      arePathsEqual(currentCwd, preparedTool.cwd) &&
      currentCwdStats.isDirectory() &&
      currentCwdStats.dev === preparedTool.cwdIdentity.device &&
      currentCwdStats.ino === preparedTool.cwdIdentity.inode;
  } catch {
    cwdUnchanged = false;
  }
  if (abortSignal.aborted) {
    return createCommandResult("aborted", null, 0, createCommandOutputCollector(), false);
  }
  if (!cwdUnchanged) {
    return Object.freeze({
      status: "failed",
      content: "execute_command cwd 已变化，命令未启动。",
      truncated: false,
      cleanupUncertain: false,
    });
  }

  preparedTool.workspace.assertWriteAllowed?.(preparedTool.toolCallId);
  if (abortSignal.aborted) {
    return createCommandResult("aborted", null, 0, createCommandOutputCollector(), false);
  }
  const startedAtMilliseconds = Date.now();
  const outputCollector = createCommandOutputCollector();
  const outputCapture = createCommandOutputCapture();
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let childProcess: ReturnType<typeof spawn>;
  try {
    childProcess = spawn(
      preparedTool.shell.executable,
      [...preparedTool.shell.arguments, preparedTool.command],
      {
        cwd: preparedTool.cwd,
        env: createSanitizedEnvironment(process.env),
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    return createCommandResult(
      "spawn_failed",
      null,
      Date.now() - startedAtMilliseconds,
      outputCollector,
      false,
    );
  }

  return new Promise((resolve) => {
    let settled = false;
    let terminationReason: "timeout" | "aborted" | null = null;
    let terminationPromise: Promise<boolean> | null = null;
    let cleanupUncertain = false;
    let shutdownFallbackTimer: NodeJS.Timeout | null = null;

    /** 只交付一次命令终态，并移除所有由本次执行持有的资源。 */
    const settle = (exitCode: number | null, spawnFailed = false) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(commandTimeout);
      if (shutdownFallbackTimer !== null) {
        clearTimeout(shutdownFallbackTimer);
      }
      abortSignal.removeEventListener("abort", handleAbort);
      const finalStdout = stdoutDecoder.end();
      const finalStderr = stderrDecoder.end();
      publishAcceptedOutput("stdout", finalStdout);
      publishAcceptedOutput("stderr", finalStderr);
      childProcess.stdout?.removeAllListeners();
      childProcess.stderr?.removeAllListeners();
      childProcess.removeAllListeners();
      childProcess.stdout?.destroy();
      childProcess.stderr?.destroy();
      const reason: CommandTerminationReason = spawnFailed
        ? "spawn_failed"
        : (terminationReason ?? (exitCode === 0 ? "completed" : "non_zero_exit"));
      resolve({
        ...createCommandResult(
          reason,
          exitCode,
          Date.now() - startedAtMilliseconds,
          outputCollector,
          cleanupUncertain,
        ),
        ...outputCapture.finish(),
      });
    };

    /** 保存并发布仍落在统一边界内的输出，订阅者异常不能破坏子进程收口。 */
    const publishAcceptedOutput = (stream: "stdout" | "stderr", text: string) => {
      outputCapture.append(text);
      const acceptedText = outputCollector.append(stream, text);
      if (acceptedText.length === 0 || settled) {
        return;
      }
      try {
        publishUpdate(Object.freeze({ stream, delta: acceptedText }));
      } catch {
        // 呈现失败不影响命令结果、进程回收或 JSONL 事实。
      }
    };

    /** 在中止或超时时仅请求一次进程树终止，并为无法确认的情况设置收口上限。 */
    const requestTermination = (reason: "timeout" | "aborted") => {
      if (terminationReason !== null || settled) {
        return;
      }
      terminationReason = reason;
      terminationPromise = terminateProcessTree(childProcess).then((uncertain) => {
        cleanupUncertain ||= uncertain;
        return uncertain;
      });
      shutdownFallbackTimer = setTimeout(() => {
        cleanupUncertain = true;
        forceTerminateProcessTree(childProcess);
        settle(null);
      }, PROCESS_TREE_SHUTDOWN_GRACE_MILLISECONDS);
    };

    /** 根 AbortSignal 只请求进程回收，Run 终态由 Agent 统一决定。 */
    const handleAbort = () => requestTermination("aborted");

    childProcess.stdout?.on("data", (chunk: Buffer) => {
      publishAcceptedOutput("stdout", stdoutDecoder.write(chunk));
    });
    childProcess.stderr?.on("data", (chunk: Buffer) => {
      publishAcceptedOutput("stderr", stderrDecoder.write(chunk));
    });
    childProcess.once("error", () => settle(null, true));
    childProcess.once("close", (exitCode) => {
      if (terminationPromise === null) {
        settle(exitCode);
        return;
      }
      void terminationPromise.finally(() => settle(exitCode));
    });
    const commandTimeout = setTimeout(
      () => requestTermination("timeout"),
      preparedTool.timeoutMilliseconds,
    );
    abortSignal.addEventListener("abort", handleAbort, { once: true });
    if (abortSignal.aborted) {
      handleAbort();
    }
  });
}

/** 精确解析 execute_command 输入并拒绝未知字段或错误类型。 */
function parseCommandInput(toolCall: AssistantToolCallPart):
  | Readonly<{
      ok: true;
      input: Readonly<{ command: string; cwd: string; timeoutMilliseconds: number }>;
    }>
  | Readonly<{ ok: false; error: string }> {
  if (toolCall.invalid || toolCall.toolName !== "execute_command" || !isRecord(toolCall.input)) {
    return Object.freeze({ ok: false, error: "execute_command 输入无法解析或不符合 Schema。" });
  }
  const input = toolCall.input;
  if (
    !hasOnlyKeys(input, ["command", "cwd", "timeoutMs"]) ||
    !isNonEmptyString(input.command) ||
    !isOptionalNonEmptyString(input.cwd) ||
    !isOptionalIntegerInRange(
      input.timeoutMs,
      MINIMUM_COMMAND_TIMEOUT_MILLISECONDS,
      MAXIMUM_COMMAND_TIMEOUT_MILLISECONDS,
    )
  ) {
    return Object.freeze({ ok: false, error: "execute_command 输入不符合 Schema。" });
  }
  return Object.freeze({
    ok: true,
    input: Object.freeze({
      command: input.command,
      cwd: input.cwd ?? ".",
      timeoutMilliseconds: input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MILLISECONDS,
    }),
  });
}

/** 终止本次命令拥有的进程树，并在无法确认时返回 true。 */
async function terminateProcessTree(childProcess: ReturnType<typeof spawn>): Promise<boolean> {
  const processId = childProcess.pid;
  if (processId === undefined) {
    return true;
  }
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      let taskkillProcess: ReturnType<typeof spawn>;
      try {
        taskkillProcess = spawn("taskkill.exe", ["/PID", String(processId), "/T", "/F"], {
          shell: false,
          windowsHide: true,
          stdio: "ignore",
        });
      } catch {
        resolve(true);
        return;
      }
      taskkillProcess.once("error", () => resolve(true));
      taskkillProcess.once("close", (exitCode) => resolve(exitCode !== 0));
    });
  }
  if (!signalPosixProcessGroup(processId, "SIGTERM")) {
    return false;
  }
  if (await waitForPosixProcessGroupExit(processId, PROCESS_TREE_SIGNAL_GRACE_MILLISECONDS)) {
    return false;
  }
  if (!signalPosixProcessGroup(processId, "SIGKILL")) {
    return false;
  }
  return !(await waitForPosixProcessGroupExit(processId, PROCESS_TREE_SIGNAL_GRACE_MILLISECONDS));
}

/** 向 POSIX 进程组发送信号；组已经消失时返回 false。 */
function signalPosixProcessGroup(processId: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-processId, signal);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** 在短宽限内确认 POSIX 进程组已经消失，避免把仅发送信号当作清理完成。 */
async function waitForPosixProcessGroupExit(
  processId: number,
  graceMilliseconds: number,
): Promise<boolean> {
  const deadlineMilliseconds = Date.now() + graceMilliseconds;
  while (Date.now() < deadlineMilliseconds) {
    try {
      process.kill(-processId, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return true;
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, PROCESS_TREE_POLL_MILLISECONDS));
  }
  try {
    process.kill(-processId, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** 在宽限结束后升级终止请求；失败事实由调用方的 cleanupUncertain 暴露。 */
function forceTerminateProcessTree(childProcess: ReturnType<typeof spawn>): void {
  const processId = childProcess.pid;
  try {
    if (process.platform !== "win32" && processId !== undefined) {
      process.kill(-processId, "SIGKILL");
      return;
    }
    childProcess.kill("SIGKILL");
  } catch {
    // 调用方已经把结果标记为 cleanupUncertain，不能继续无限等待。
  }
}

/** 从宿主环境的明确允许列表构造命令环境，避免隐式继承凭据和注入配置。 */
function createSanitizedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) => value !== undefined && allowedNameSet.has(name.toLocaleLowerCase("en-US")),
    ),
  );
}

/** 用不会混淆 executable 与参数边界的形式展示固定 Session Shell。 */
function renderShell(shell: SessionShell): string {
  return [shell.executable, ...shell.arguments].map((part) => JSON.stringify(part)).join(" ");
}

/** 创建一个无需确认即可返回模型的命令预检失败。 */
function failedPreparation(error: string): PreparedCommandResult {
  return Object.freeze({
    ok: false,
    result: Object.freeze({ status: "failed", content: error, truncated: false }),
  });
}

/** 收敛路径和系统错误，避免绝对路径或堆栈进入消息。 */
function toSafeCommandError(error: unknown): string {
  const errorCode = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof errorCode === "string") {
    return `execute_command 预检失败：${errorCode}`;
  }
  return error instanceof Error ? error.message : "execute_command 预检失败。";
}

/** 创建需要预检、分类和人工确认的命令 Tool 计划。 */
function createCommandToolCallPlan(
  toolCall: AssistantToolCallPart,
  permissionMode: PermissionMode,
  options: CreateToolRunnerOptions,
): ToolCallPlan {
  return Object.freeze({
    scheduling: "serial",
    abortedPreparationContent: "Run 已停止，命令未启动。",
    async prepare() {
      const preparedResult = await prepareCommandTool(toolCall, options.workspace, options.shell);
      if (!preparedResult.ok) {
        return Object.freeze({ ok: false, result: preparedResult.result });
      }
      const preparedTool = preparedResult.preparedTool;
      const policyDecision = decideToolPolicy({
        permissionMode,
        toolName: "execute_command",
        command: preparedTool.command,
      });
      if (policyDecision.kind === "deny") {
        return Object.freeze({ ok: false, result: policyResult(policyDecision) });
      }
      return Object.freeze({
        ok: true,
        preparedExecution: Object.freeze({
          approval: createApprovalPlan(preparedTool, policyDecision),
          activitySummary: createToolActivitySummary(
            `cwd: ${preparedTool.target}; command: ${preparedTool.command}`,
          ),
          executionUnavailableContent: "Run 已停止，命令未启动。",
          async execute(
            abortSignal: AbortSignal,
            publishUpdate: (update: CommandExecutionUpdate) => void,
          ) {
            try {
              return await executePreparedCommand(preparedTool, abortSignal, publishUpdate);
            } catch {
              return failedExecution(true);
            }
          },
        }),
      });
    },
  });
}
