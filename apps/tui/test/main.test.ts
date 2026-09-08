import { spawn, spawnSync } from "node:child_process";
import {
  cp,
  glob,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveStartupPaths } from "../src/startup.js";

const temporaryDirectories = new Set<string>();
let isolatedMainPath: string;
let isolatedAnthiasRoot: string;

beforeEach(async () => {
  isolatedAnthiasRoot = await createIsolatedAnthiasProject();
  isolatedMainPath = join(isolatedAnthiasRoot, "apps", "tui", "dist", "main.js");
});

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((temporaryDirectory) =>
      rm(temporaryDirectory, { recursive: true, force: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe("Anthias CLI", () => {
  it("derives one Anthias Data Root independently from different invocation workspaces", async () => {
    const firstWorkspace = await createTemporaryDirectory("anthias-cli-first-workspace-");
    const secondWorkspace = await createTemporaryDirectory("anthias-cli-second-workspace-");

    const firstPaths = await resolveStartupPaths({
      invocationWorkingDirectory: firstWorkspace,
      environment: {},
    });
    const secondPaths = await resolveStartupPaths({
      invocationWorkingDirectory: secondWorkspace,
      environment: {},
    });

    expect(firstPaths.workspaceRoot).toBe(await realpath(firstWorkspace));
    expect(secondPaths.workspaceRoot).toBe(await realpath(secondWorkspace));
    expect(firstPaths.anthiasProjectRoot).toBe(secondPaths.anthiasProjectRoot);
    expect(firstPaths.sessionDirectory).toBe(
      join(firstPaths.anthiasProjectRoot, "data", "conversation"),
    );
    expect(secondPaths.sessionDirectory).toBe(firstPaths.sessionDirectory);

    const selectedWorkspace = join(firstWorkspace, "selected");
    await mkdir(selectedWorkspace);
    const relativeSelection = await resolveStartupPaths({
      invocationWorkingDirectory: firstWorkspace,
      requestedWorkspace: "selected",
      environment: {},
    });
    const absoluteSelection = await resolveStartupPaths({
      invocationWorkingDirectory: secondWorkspace,
      requestedWorkspace: selectedWorkspace,
      environment: {},
    });
    expect(relativeSelection.workspaceRoot).toBe(absoluteSelection.workspaceRoot);
  });

  it("starts the compiled CLI in two selected workspaces without writing Session data there", async () => {
    const anthiasProjectRoot = await createIsolatedAnthiasProject();
    const firstWorkspace = await createTemporaryDirectory("anthias-cli-first-selected-");
    const secondWorkspace = await createTemporaryDirectory("anthias-cli-second-selected-");
    const sessionDirectory = join(anthiasProjectRoot, "data", "conversation");
    const isolatedMainPath = join(anthiasProjectRoot, "apps", "tui", "dist", "main.js");
    const environment = createModelEnvironment();

    const firstProcessResult = spawnCli(
      [],
      environment,
      firstWorkspace,
      "/exit\n",
      isolatedMainPath,
    );
    const secondProcessResult = spawnCli(
      [],
      environment,
      secondWorkspace,
      "/exit\n",
      isolatedMainPath,
    );

    expect(firstProcessResult.status).toBe(0);
    expect(secondProcessResult.status).toBe(0);
    expect(firstProcessResult.stderr).toBe("");
    expect(secondProcessResult.stderr).toBe("");
    const sessionFiles = await findSessionFiles(sessionDirectory);
    expect(sessionFiles).toHaveLength(2);
    const recordedWorkspaces = await Promise.all(
      sessionFiles.map(async (sessionFile) => {
        const headerLine = (await readFile(join(sessionDirectory, sessionFile), "utf8")).split(
          "\n",
        )[0];
        return (JSON.parse(headerLine ?? "") as { workspaceRoot: string }).workspaceRoot;
      }),
    );
    expect(new Set(recordedWorkspaces)).toEqual(
      new Set([await realpath(firstWorkspace), await realpath(secondWorkspace)]),
    );
    await expect(stat(join(firstWorkspace, "data"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(secondWorkspace, "data"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(anthiasProjectRoot, "apps", "tui", "data"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("loads one root configuration from another workspace and honors process and CLI modes", async () => {
    const workspaceRoot = await createTemporaryDirectory("anthias-cli-root-config-");
    const configuration = [
      "ANTHIAS_MODEL_BASE_URL=https://example.com/v1",
      "ANTHIAS_MODEL_ID=fixture-model",
      "ANTHIAS_MODEL_CONTEXT_WINDOW=128000",
      "ANTHIAS_MODEL_API_KEY=synthetic-root-model-key",
      "ANTHIAS_PERMISSION_MODE=auto_allow",
      "",
    ].join("\n");
    await writeFile(join(isolatedAnthiasRoot, ".env"), configuration);
    await writeFile(
      join(workspaceRoot, ".env"),
      "ANTHIAS_PERMISSION_MODE=invalid-workspace-mode\n",
    );
    const environment = createTestProcessEnvironment();
    const fromFile = spawnCli([], environment, workspaceRoot, "/mode plan\n/exit\n");
    expect(fromFile.status).toBe(0);
    expect(fromFile.stdout).toContain("Mode: AutoAllow\n");
    expect(fromFile.stderr).toBe("");
    const fromProcess = spawnCli(
      [],
      { ...environment, ANTHIAS_PERMISSION_MODE: "plan" },
      workspaceRoot,
      "/exit\n",
    );
    expect(fromProcess.status).toBe(0);
    expect(fromProcess.stdout).toContain("Mode: Plan\n");
    const fromCli = spawnCli(
      ["--mode", "agent"],
      { ...environment, ANTHIAS_PERMISSION_MODE: "plan" },
      workspaceRoot,
      "/exit\n",
    );
    expect(fromCli.stdout).toContain("Mode: Agent\n");
    const emptyKey = spawnCli(
      [],
      { ...environment, ANTHIAS_MODEL_API_KEY: "" },
      workspaceRoot,
      "/exit\n",
    );
    expect(emptyKey.status).toBe(1);
    expect(emptyKey.stderr).toContain("ANTHIAS_MODEL_API_KEY");
    expect(JSON.stringify([fromFile, fromProcess, fromCli, emptyKey])).not.toContain(
      "synthetic-root-model-key",
    );
    expect(await readFile(join(isolatedAnthiasRoot, ".env"), "utf8")).toBe(configuration);
  });
  it("creates a Session without arguments and reopens the same UUID", async () => {
    const workspaceRoot = await createTemporaryDirectory("anthias-cli-reopen-");
    const normalizedWorkspaceRoot = await realpath(workspaceRoot);
    const sessionDirectory = join(workspaceRoot, "sessions");
    const environment = {
      ...createTestProcessEnvironment(),
      SEARCHAPI_API_KEY: "",
      ANTHIAS_PERMISSION_MODE: "agent",
      ANTHIAS_MODEL_BASE_URL: "https://example.com/v1/",
      ANTHIAS_MODEL_ID: "model-id",
      ANTHIAS_MODEL_CONTEXT_WINDOW: "128000",
      ANTHIAS_MODEL_API_KEY: "local-key",
      ANTHIAS_SESSION_DIR: sessionDirectory,
    };

    const firstProcessResult = spawnCli([], environment, workspaceRoot, "/exit\n");

    expect(firstProcessResult.status).toBe(0);
    expect(firstProcessResult.stderr).toBe("");
    const sessionIdMatch = firstProcessResult.stdout.match(
      /^Session: ([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/m,
    );
    expect(sessionIdMatch).not.toBeNull();
    const sessionId = sessionIdMatch?.[1];
    if (!sessionId) {
      throw new Error("expected CLI to print the created Session UUID");
    }
    expect(firstProcessResult.stdout).toContain(`Workspace: ${normalizedWorkspaceRoot}\n`);
    expect(firstProcessResult.stdout).toContain("Mode: Agent\n");
    const sessionFiles = await findSessionFiles(sessionDirectory);
    expect(sessionFiles).toHaveLength(1);
    const sessionFile = sessionFiles[0];
    if (sessionFile === undefined) throw new Error("expected a time-partitioned Session");
    const sessionHeader = JSON.parse(
      (await readFile(join(sessionDirectory, sessionFile), "utf8")).split("\n")[0] ?? "",
    ) as Record<string, unknown>;
    expect(sessionHeader).toMatchObject({
      type: "session_header",
      schemaVersion: 3,
      sessionKind: "primary",
      rootSessionId: sessionId,
      sessionId,
      workspaceRoot: normalizedWorkspaceRoot,
    });

    const reopenedProcessResult = spawnCli(
      ["--session", sessionId],
      environment,
      workspaceRoot,
      "/exit\n",
    );

    expect(reopenedProcessResult.status).toBe(0);
    expect(reopenedProcessResult.stderr).toBe("");
    expect(reopenedProcessResult.stdout).toContain(`Session: ${sessionId}\n`);
    expect(reopenedProcessResult.stdout).toContain(`Workspace: ${normalizedWorkspaceRoot}\n`);
    expect(reopenedProcessResult.stdout).toContain("Mode: Agent\n");
    expect(await findSessionFiles(sessionDirectory)).toEqual(sessionFiles);
  });

  it("exits after /exit while the parent keeps the input pipe open", async () => {
    const workspaceRoot = await createTemporaryDirectory("anthias-cli-open-input-");
    const child = spawn(process.execPath, [isolatedMainPath], {
      cwd: workspaceRoot,
      env: createModelEnvironment(join(workspaceRoot, "sessions")),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let sentExit = false;
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (!sentExit && stdout.includes("/help")) {
        sentExit = true;
        // 父进程持续持有管道，避免 EOF 替 /exit 释放输入资源而掩盖泄漏。
        child.stdin.write("/exit\n");
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 5_000);
    try {
      const exitStatus = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect(sentExit).toBe(true);
      expect(timedOut).toBe(false);
      expect(exitStatus).toBe(0);
      expect(stderr).toBe("");
    } finally {
      clearTimeout(deadline);
      child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  }, 8_000);

  it("exits before Session creation when model configuration is missing", async () => {
    const sessionDirectory = join(
      await createTemporaryDirectory("anthias-cli-missing-config-"),
      "sessions",
    );
    const environment: NodeJS.ProcessEnv = {
      ...createTestProcessEnvironment(),
      SEARCHAPI_API_KEY: "",
      ANTHIAS_PERMISSION_MODE: "agent",
      ANTHIAS_SESSION_DIR: sessionDirectory,
    };
    delete environment.ANTHIAS_MODEL_BASE_URL;
    delete environment.ANTHIAS_MODEL_ID;
    delete environment.ANTHIAS_MODEL_API_KEY;

    const processResult = spawnCli([], environment);

    expect(processResult.status).toBe(1);
    expect(processResult.stderr).toContain("缺少模型配置");
    expect(processResult.stderr).toContain("ANTHIAS_MODEL_API_KEY");
  });

  it("rejects unknown CLI arguments before startup", () => {
    const processResult = spawnCli(["--unknown"], { ...createTestProcessEnvironment() });

    expect(processResult.status).toBe(1);
    expect(processResult.stderr).toContain("命令行参数无效");
  });

  it("rejects relative Session overrides and invalid workspaces before Session creation", async () => {
    const invocationDirectory = await createTemporaryDirectory("anthias-cli-invalid-paths-");
    const workspaceFile = join(invocationDirectory, "not-a-directory.txt");
    await writeFile(workspaceFile, "not a workspace", "utf8");
    const absoluteSessionDirectory = join(invocationDirectory, "sessions");

    const relativeOverrideResult = spawnCli(
      [],
      createModelEnvironment("relative/sessions"),
      invocationDirectory,
    );
    expect(relativeOverrideResult.status).toBe(1);
    expect(relativeOverrideResult.stderr).toContain("ANTHIAS_SESSION_DIR 必须是绝对路径");
    await expect(stat(join(invocationDirectory, "relative"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const invalidWorkspaceResult = spawnCli(
      ["--workspace", workspaceFile],
      createModelEnvironment(absoluteSessionDirectory),
      invocationDirectory,
    );
    expect(invalidWorkspaceResult.status).toBe(1);
    expect(invalidWorkspaceResult.stderr).toContain("Workspace 必须是存在的目录");
    await expect(stat(absoluteSessionDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts Plan, AutoAllow and FullAccess modes and rejects an unknown mode before startup", async () => {
    const workspaceRoot = await createTemporaryDirectory("anthias-cli-mode-");
    const sessionDirectory = join(workspaceRoot, "sessions");
    const environment = {
      ...createTestProcessEnvironment(),
      SEARCHAPI_API_KEY: "",
      ANTHIAS_PERMISSION_MODE: "agent",
      ANTHIAS_MODEL_BASE_URL: "https://example.com/v1/",
      ANTHIAS_MODEL_ID: "model-id",
      ANTHIAS_MODEL_CONTEXT_WINDOW: "128000",
      ANTHIAS_MODEL_API_KEY: "local-key",
      ANTHIAS_SESSION_DIR: sessionDirectory,
    };

    const planResult = spawnCli(["--mode", "plan"], environment, workspaceRoot, "/exit\n");
    expect(planResult.status).toBe(0);
    expect(planResult.stdout).toContain("Mode: Plan\n");

    const autoResult = spawnCli(["--mode", "auto_allow"], environment, workspaceRoot, "/exit\n");
    expect(autoResult.status).toBe(0);
    expect(autoResult.stdout).toContain("Mode: AutoAllow\n");
    const fullResult = spawnCli(["--mode", "full_access"], environment, workspaceRoot, "/exit\n");
    expect(fullResult.status).toBe(0);
    expect(fullResult.stdout).toContain("Mode: FullAccess\n");
    expect(fullResult.stdout).toContain("访问能力不等于任务授权");
    const invalidResult = spawnCli(["--mode", "unsafe"], environment, workspaceRoot);
    expect(invalidResult.status).toBe(1);
    expect(invalidResult.stderr).toContain("--mode <agent|plan|auto_allow|full_access>");
  });

  it("rejects an invalid --session UUID without a model request", async () => {
    const sessionDirectory = join(
      await createTemporaryDirectory("anthias-cli-invalid-session-"),
      "sessions",
    );
    const processResult = spawnCli(["--session", "../outside"], {
      ...createTestProcessEnvironment(),
      SEARCHAPI_API_KEY: "",
      ANTHIAS_PERMISSION_MODE: "agent",
      ANTHIAS_MODEL_BASE_URL: "https://example.com/v1/",
      ANTHIAS_MODEL_ID: "model-id",
      ANTHIAS_MODEL_CONTEXT_WINDOW: "128000",
      ANTHIAS_MODEL_API_KEY: "local-key",
      ANTHIAS_SESSION_DIR: sessionDirectory,
    });

    expect(processResult.status).toBe(1);
    expect(processResult.stderr).toContain("Session ID 或 Session 文件无效");
  });
});

function spawnCli(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  cwd?: string,
  input?: string,
  mainPath = isolatedMainPath,
) {
  return spawnSync(process.execPath, [mainPath, ...arguments_], {
    cwd,
    env: environment,
    encoding: "utf8",
    input,
    timeout: 5_000,
  });
}

async function createIsolatedAnthiasProject(): Promise<string> {
  const anthiasProjectRoot = await createTemporaryDirectory("anthias-cli-project-");
  const isolatedTuiRoot = join(anthiasProjectRoot, "apps", "tui");
  await mkdir(isolatedTuiRoot, { recursive: true });
  await cp(fileURLToPath(new URL("../dist", import.meta.url)), join(isolatedTuiRoot, "dist"), {
    recursive: true,
  });
  await writeFile(
    join(anthiasProjectRoot, "package.json"),
    `${JSON.stringify({ name: "anthias", private: true, type: "module" })}\n`,
    "utf8",
  );
  const isolatedAgentRoot = join(anthiasProjectRoot, "apps", "agent");
  await mkdir(isolatedAgentRoot, { recursive: true });
  await cp(
    fileURLToPath(new URL("../../agent/dist", import.meta.url)),
    join(isolatedAgentRoot, "dist"),
    { recursive: true },
  );
  await cp(
    fileURLToPath(new URL("../../agent/package.json", import.meta.url)),
    join(isolatedAgentRoot, "package.json"),
  );
  await symlink(
    fileURLToPath(new URL("../../agent/node_modules", import.meta.url)),
    join(isolatedAgentRoot, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const originalTuiModules = fileURLToPath(new URL("../node_modules", import.meta.url));
  const isolatedTuiModules = join(isolatedTuiRoot, "node_modules");
  await mkdir(join(isolatedTuiModules, "@anthias"), { recursive: true });
  for (const name of await readdir(originalTuiModules)) {
    if (name === "@anthias" || name.startsWith(".")) continue;
    await symlink(
      join(originalTuiModules, name),
      join(isolatedTuiModules, name),
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  // Agent 也必须来自隔离安装目录，避免其配置模块读取开发者项目中的真实 .env。
  await symlink(
    isolatedAgentRoot,
    join(isolatedTuiModules, "@anthias", "agent"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return anthiasProjectRoot;
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.add(temporaryDirectory);
  return temporaryDirectory;
}

function createTestProcessEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    "SystemRoot",
    "WINDIR",
    "PATH",
    "Path",
    "PATHEXT",
    "ComSpec",
    "TEMP",
    "TMP",
    "SHELL",
    "HOME",
    "USERPROFILE",
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}
function createModelEnvironment(sessionDirectory?: string): NodeJS.ProcessEnv {
  return {
    ...createTestProcessEnvironment(),
    SEARCHAPI_API_KEY: "",
    ANTHIAS_PERMISSION_MODE: "agent",
    ANTHIAS_MODEL_BASE_URL: "https://example.com/v1/",
    ANTHIAS_MODEL_ID: "model-id",
    ANTHIAS_MODEL_CONTEXT_WINDOW: "128000",
    ANTHIAS_MODEL_API_KEY: "local-key",
    ...(sessionDirectory === undefined ? {} : { ANTHIAS_SESSION_DIR: sessionDirectory }),
  };
}

async function findSessionFiles(sessionDirectory: string): Promise<string[]> {
  const sessionFiles: string[] = [];
  for await (const sessionFile of glob("*/*/session.jsonl", { cwd: sessionDirectory })) {
    sessionFiles.push(sessionFile);
  }
  return sessionFiles;
}
