import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentFromEnvironment } from "../src/index.js";

const temporaryDirectories = new Set<string>();

afterEach(async () => {
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
        ANTHIAS_SESSION_DIR: sessionDirectory,
      },
      workspaceRoot,
    });

    expect(creationResult).toEqual({
      ok: false,
      error: "缺少模型配置：ANTHIAS_MODEL_BASE_URL、ANTHIAS_MODEL_ID。请通过本地环境变量提供。",
    });
    expect(JSON.stringify(creationResult)).not.toContain("secret-value");
    await expect(stat(sessionDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates an idle Agent and a Session from valid configuration", async () => {
    const workspaceRoot = await createTemporaryDirectory("anthias-startup-valid-");
    const sessionDirectory = join(workspaceRoot, "sessions");
    const environment = await createValidEnvironment(sessionDirectory);
    const creationResult = await createAgentFromEnvironment({
      environment,
      workspaceRoot,
    });

    expect(creationResult.ok).toBe(true);
    if (creationResult.ok) {
      expect(creationResult.agent.state).toEqual({
        sessionId: expect.any(String),
        workspaceRoot,
        messageHistory: [],
        activeAssistantMessage: null,
        activeRun: null,
        pendingToolApproval: null,
        running: false,
        lastError: null,
      });
      expect(await readdir(sessionDirectory)).toEqual([
        ".gitignore",
        `${creationResult.agent.state.sessionId}.jsonl`,
      ]);
      await expect(readFile(join(sessionDirectory, ".gitignore"), "utf8")).resolves.toBe("*\n");
    }
  });

  it("stores a default Session under workspace data/conversation", async () => {
    const workspaceRoot = await createTemporaryDirectory("anthias-startup-default-session-");
    const environment = await createValidEnvironment(join(workspaceRoot, "unused-sessions"));
    delete environment.ANTHIAS_SESSION_DIR;

    const creationResult = await createAgentFromEnvironment({ environment, workspaceRoot });

    expect(creationResult.ok).toBe(true);
    if (!creationResult.ok) {
      return;
    }
    const sessionDirectory = join(workspaceRoot, "data", "conversation");
    expect(await readdir(sessionDirectory)).toEqual([
      ".gitignore",
      `${creationResult.agent.state.sessionId}.jsonl`,
    ]);
    await expect(readFile(join(sessionDirectory, ".gitignore"), "utf8")).resolves.toBe("*\n");
  });

  it("reopens a requested Session in the same workspace", async () => {
    const workspaceRoot = await createTemporaryDirectory("anthias-startup-reopen-");
    const sessionDirectory = join(workspaceRoot, "sessions");
    const environment = await createValidEnvironment(sessionDirectory);
    const firstCreationResult = await createAgentFromEnvironment({
      environment,
      workspaceRoot,
    });
    if (!firstCreationResult.ok) {
      throw new Error("expected initial Agent creation to succeed");
    }

    const reopenedCreationResult = await createAgentFromEnvironment({
      environment,
      workspaceRoot,
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
    const firstCreationResult = await createAgentFromEnvironment({ environment, workspaceRoot });
    if (!firstCreationResult.ok) {
      throw new Error("expected initial Agent creation to succeed");
    }
    const lockDirectory = join(
      sessionDirectory,
      `${firstCreationResult.agent.state.sessionId}.lock`,
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
      sessionId: firstCreationResult.agent.state.sessionId,
    });

    expect(busyCreationResult).toEqual({
      ok: false,
      error: "Session 启动失败，请检查 Session ID、工作区与本地 Session 文件。",
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
      sessionId: "",
    });

    expect(creationResult).toEqual({
      ok: false,
      error: "Session 启动失败，请检查 Session ID、工作区与本地 Session 文件。",
    });
    await expect(stat(sessionDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects reopening when the recorded fixed Shell is no longer available", async () => {
    const workspaceRoot = await createTemporaryDirectory("anthias-startup-shell-missing-");
    const sessionDirectory = join(workspaceRoot, "sessions");
    const environment = await createValidEnvironment(sessionDirectory);
    const firstCreationResult = await createAgentFromEnvironment({ environment, workspaceRoot });
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
        sessionId: firstCreationResult.agent.state.sessionId,
      }),
    ).resolves.toEqual({
      ok: false,
      error: "Session 启动失败，请检查 Session ID、工作区与本地 Session 文件。",
    });
  });
});

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
    ANTHIAS_MODEL_API_KEY: "local-key",
    ANTHIAS_SESSION_DIR: sessionDirectory,
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
