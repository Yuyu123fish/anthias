import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Agent,
  createAgentFromEnvironment as createProductionAgentFromEnvironment,
} from "../src/index.js";
import { locateSessionStorage } from "../src/session/locations.js";
import { getSessionLockDirectory } from "../src/session/lock.js";

const temporaryDirectories = new Set<string>();
const activeAgents = new Set<Agent>();

afterEach(async () => {
  await Promise.all([...activeAgents].map((agent) => agent.close()));
  activeAgents.clear();
  await Promise.all(
    [...temporaryDirectories].map((temporaryDirectory) =>
      rm(temporaryDirectory, { recursive: true, force: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe("createAgentFromEnvironment", () => {
  it("validates model configuration before Session side effects", async () => {
    const workspaceRoot = await createTemporaryDirectory("anthias-startup-invalid-");
    const sessionDirectory = join(workspaceRoot, "must-not-exist");

    const creationResult = await createAgentFromEnvironment({
      environment: {
        ANTHIAS_MODEL_API_KEY: "secret-value",
      },
      workspaceRoot,
      sessionDirectory,
    });

    expect(creationResult).toEqual({
      ok: false,
      reason: "model_configuration",
      error: "缺少模型配置：ANTHIAS_MODEL_BASE_URL、ANTHIAS_MODEL_ID。请通过本地环境变量提供。",
    });
    expect(JSON.stringify(creationResult)).not.toContain("secret-value");
    await expect(stat(sessionDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects invalid Workspace and relative Session paths before Session side effects", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-startup-invalid-paths-");
    const workspaceFile = join(fixtureRoot, "workspace.txt");
    const sessionDirectory = join(fixtureRoot, "must-not-exist");
    await writeFile(workspaceFile, "not a directory", "utf8");
    const environment = await createValidEnvironment(sessionDirectory);

    await expect(
      createAgentFromEnvironment({
        environment,
        workspaceRoot: workspaceFile,
        sessionDirectory,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "workspace_unavailable",
      error: "Workspace 必须是存在且可访问的目录。",
    });
    await expect(
      createAgentFromEnvironment({
        environment,
        workspaceRoot: fixtureRoot,
        sessionDirectory: "relative/sessions",
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "storage_unavailable",
      error: "Session Directory 必须是绝对路径。",
    });
    await expect(stat(sessionDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates an idle Agent and a Session from valid configuration", async () => {
    const workspaceRoot = await createTemporaryDirectory("anthias-startup-valid-");
    const sessionDirectory = join(workspaceRoot, "sessions");
    const environment = await createValidEnvironment(sessionDirectory);
    const creationResult = await createAgentFromEnvironment({
      environment,
      workspaceRoot,
      sessionDirectory,
    });

    expect(creationResult.ok).toBe(true);
    if (creationResult.ok) {
      expect(creationResult.agent.state).toEqual({
        sessionId: expect.any(String),
        workspaceRoot,
        permissionMode: "agent",
        contextUsage: expect.objectContaining({
          contextWindow: 128000,
          inputTokens: null,
          source: "unknown",
        }),
        messageHistory: [],
        activeAssistantMessage: null,
        activeRun: null,
        pendingToolApproval: null,
        running: false,
        lastError: null,
      });
      await expectSessionStorage(sessionDirectory, creationResult.agent.state.sessionId);
      await expect(readFile(join(sessionDirectory, ".gitignore"), "utf8")).resolves.toBe("*\n");
    }
  });

  it("stores a Session only in the explicitly assembled directory", async () => {
    const workspaceRoot = await createTemporaryDirectory("anthias-startup-explicit-session-");
    const anthiasDataRoot = await createTemporaryDirectory("anthias-data-root-");
    const sessionDirectory = join(anthiasDataRoot, "data", "conversation");
    const environment = await createValidEnvironment(sessionDirectory);

    const creationResult = await createAgentFromEnvironment({
      environment,
      workspaceRoot,
      sessionDirectory,
    });

    expect(creationResult.ok).toBe(true);
    if (!creationResult.ok) {
      return;
    }
    await expectSessionStorage(sessionDirectory, creationResult.agent.state.sessionId);
    await expect(readFile(join(sessionDirectory, ".gitignore"), "utf8")).resolves.toBe("*\n");
  });

  it("returns a storage reason without exposing a filesystem error", async () => {
    const workspaceRoot = await createTemporaryDirectory("anthias-startup-storage-");
    const blockedParent = join(workspaceRoot, "not-a-directory");
    const sessionDirectory = join(blockedParent, "conversation");
    await writeFile(blockedParent, "file", "utf8");
    const environment = await createValidEnvironment(join(workspaceRoot, "shell-fixture"));

    const creationResult = await createAgentFromEnvironment({
      environment,
      workspaceRoot,
      sessionDirectory,
    });

    expect(creationResult).toEqual({
      ok: false,
      reason: "storage_unavailable",
      error: "Session 存储不可用，请检查 Anthias data 目录权限与磁盘状态。",
    });
    expect(JSON.stringify(creationResult)).not.toContain("ENOTDIR");
  });

  it("creates a Plan-mode Agent without persisting the runtime mode", async () => {
    const workspaceRoot = await createTemporaryDirectory("anthias-startup-plan-");
    const sessionDirectory = join(workspaceRoot, "sessions");
    const environment = await createValidEnvironment(sessionDirectory);

    const creationResult = await createAgentFromEnvironment({
      environment,
      workspaceRoot,
      sessionDirectory,
      permissionMode: "plan",
    });

    expect(creationResult.ok).toBe(true);
    if (!creationResult.ok) {
      return;
    }
    expect(creationResult.agent.state.permissionMode).toBe("plan");
    const location = await locateSessionStorage(
      sessionDirectory,
      creationResult.agent.state.sessionId,
    );
    const sessionText = await readFile(location.sessionFilePath, "utf8");
    expect(sessionText).not.toContain("permissionMode");
  });

  it("reopens a requested Session in the same workspace", async () => {
    const workspaceRoot = await createTemporaryDirectory("anthias-startup-reopen-");
    const sessionDirectory = join(workspaceRoot, "sessions");
    const environment = await createValidEnvironment(sessionDirectory);
    const firstCreationResult = await createAgentFromEnvironment({
      environment,
      workspaceRoot,
      sessionDirectory,
    });
    if (!firstCreationResult.ok) {
      throw new Error("expected initial Agent creation to succeed");
    }

    const reopenedCreationResult = await createAgentFromEnvironment({
      environment,
      workspaceRoot,
      sessionDirectory,
      sessionId: firstCreationResult.agent.state.sessionId,
    });

    expect(reopenedCreationResult.ok).toBe(true);
    if (reopenedCreationResult.ok) {
      expect(reopenedCreationResult.agent.state.sessionId).toBe(
        firstCreationResult.agent.state.sessionId,
      );
    }
  });

  it("rejects a live startup lock without returning an Agent", async () => {
    const workspaceRoot = await createTemporaryDirectory("anthias-startup-busy-");
    const sessionDirectory = join(workspaceRoot, "sessions");
    const environment = await createValidEnvironment(sessionDirectory);
    const firstCreationResult = await createAgentFromEnvironment({
      environment,
      workspaceRoot,
      sessionDirectory,
    });
    if (!firstCreationResult.ok) {
      throw new Error("expected initial Agent creation to succeed");
    }
    const lockDirectory = getSessionLockDirectory(
      sessionDirectory,
      firstCreationResult.agent.state.sessionId,
    );
    await mkdir(lockDirectory);
    await writeFile(
      join(lockDirectory, "owner.json"),
      `${JSON.stringify({
        pid: process.pid,
        ownerToken: "00000000-0000-4000-8000-000000000010",
        acquiredAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    const busyCreationResult = await createAgentFromEnvironment({
      environment,
      workspaceRoot,
      sessionDirectory,
      sessionId: firstCreationResult.agent.state.sessionId,
    });

    expect(busyCreationResult).toEqual({
      ok: false,
      reason: "session_busy",
      error: "Session 正被其他进程使用，请稍后重试。",
    });
    await expect(stat(lockDirectory)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("rejects an empty requested Session ID without creating a Session", async () => {
    const workspaceRoot = await createTemporaryDirectory("anthias-startup-empty-session-");
    const sessionDirectory = join(workspaceRoot, "sessions");
    const environment = await createValidEnvironment(sessionDirectory);

    const creationResult = await createAgentFromEnvironment({
      environment,
      workspaceRoot,
      sessionDirectory,
      sessionId: "",
    });

    expect(creationResult).toEqual({
      ok: false,
      reason: "invalid_session",
      error: "Session ID 或 Session 文件无效，请检查后重试。",
    });
    await expect(stat(sessionDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects reopening when the recorded fixed Shell is no longer available", async () => {
    const workspaceRoot = await createTemporaryDirectory("anthias-startup-shell-missing-");
    const sessionDirectory = join(workspaceRoot, "sessions");
    const environment = await createValidEnvironment(sessionDirectory);
    const firstCreationResult = await createAgentFromEnvironment({
      environment,
      workspaceRoot,
      sessionDirectory,
    });
    if (!firstCreationResult.ok) {
      throw new Error("expected initial Agent creation to succeed");
    }
    const shellExecutable =
      process.platform === "win32" ? join(String(environment.Path), "pwsh.exe") : environment.SHELL;
    if (!shellExecutable) {
      throw new Error("expected test Shell executable");
    }
    await rm(shellExecutable);

    await expect(
      createAgentFromEnvironment({
        environment,
        workspaceRoot,
        sessionDirectory,
        sessionId: firstCreationResult.agent.state.sessionId,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "shell_unavailable",
      error: "Session Shell 不可用或与记录不一致，请检查本机 Shell。",
    });
  });

  it("reports both workspaces when reopening a Session from the wrong workspace", async () => {
    const recordedWorkspaceRoot = await createTemporaryDirectory("anthias-startup-recorded-");
    const requestedWorkspaceRoot = await createTemporaryDirectory("anthias-startup-requested-");
    const sessionDirectory = join(recordedWorkspaceRoot, "sessions");
    const environment = await createValidEnvironment(sessionDirectory);
    const firstCreationResult = await createAgentFromEnvironment({
      environment,
      workspaceRoot: recordedWorkspaceRoot,
      sessionDirectory,
    });
    if (!firstCreationResult.ok) {
      throw new Error("expected initial Agent creation to succeed");
    }

    const originalDirectoryEntries = await readdir(sessionDirectory);
    const originalLocation = await locateSessionStorage(
      sessionDirectory,
      firstCreationResult.agent.state.sessionId,
    );
    const originalSessionBytes = await readFile(originalLocation.sessionFilePath);

    const mismatchResult = await createAgentFromEnvironment({
      environment,
      workspaceRoot: requestedWorkspaceRoot,
      sessionDirectory,
      sessionId: firstCreationResult.agent.state.sessionId,
    });

    expect(mismatchResult).toEqual({
      ok: false,
      reason: "workspace_mismatch",
      error: `Session 属于工作区 ${recordedWorkspaceRoot}，当前工作区是 ${requestedWorkspaceRoot}。请回到原工作区或创建新 Session。`,
    });
    expect(await readdir(sessionDirectory)).toEqual(originalDirectoryEntries);
    expect(await readFile(originalLocation.sessionFilePath)).toEqual(originalSessionBytes);
  });
});

async function createAgentFromEnvironment(
  options: Parameters<typeof createProductionAgentFromEnvironment>[0],
) {
  const result = await createProductionAgentFromEnvironment(options);
  if (result.ok) {
    activeAgents.add(result.agent);
  }
  return result;
}

async function expectSessionStorage(sessionDirectory: string, sessionId: string): Promise<void> {
  const location = await locateSessionStorage(sessionDirectory, sessionId);
  expect(location.source).toBe("schema2");
  const sessionText = await readFile(location.sessionFilePath, "utf8");
  const header = JSON.parse(sessionText.trimEnd().split("\n")[0] ?? "") as Record<string, unknown>;
  expect(header).toMatchObject({ schemaVersion: 2, sessionId });
  const createdAt = String(header.createdAt);
  expect(location.storageDirectory).toBe(
    join(
      sessionDirectory,
      createdAt.slice(0, 10),
      `${createdAt.replace(/[-:.]/g, "")}-${sessionId}`,
    ),
  );
  await expect(
    readFile(join(location.storageDirectory, "session.index.json"), "utf8"),
  ).resolves.toContain(sessionId);
  expect(await readdir(sessionDirectory)).toEqual([
    ".gitignore",
    ".maintenance",
    createdAt.slice(0, 10),
    "session-locations.json",
  ]);
}

async function createValidEnvironment(sessionDirectory: string): Promise<NodeJS.ProcessEnv> {
  const shellDirectory = join(sessionDirectory, "..", "test-bin");
  await mkdir(shellDirectory, { recursive: true });
  const shellExecutable = join(
    shellDirectory,
    process.platform === "win32" ? "pwsh.exe" : "test-sh",
  );
  await writeFile(shellExecutable, "test executable", "utf8");
  if (process.platform !== "win32") {
    await chmod(shellExecutable, 0o755);
  }
  return {
    ANTHIAS_MODEL_BASE_URL: "https://example.com/v1/",
    ANTHIAS_MODEL_ID: "model-id",
    ANTHIAS_MODEL_CONTEXT_WINDOW: "128000",
    ANTHIAS_MODEL_API_KEY: "local-key",
    ...(process.platform === "win32"
      ? { Path: shellDirectory }
      : { PATH: shellDirectory, SHELL: shellExecutable }),
  };
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.add(temporaryDirectory);
  return temporaryDirectory;
}
