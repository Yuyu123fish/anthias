import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
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
    const creationResult = await createAgentFromEnvironment({
      environment: createValidEnvironment(sessionDirectory),
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
        running: false,
        lastError: null,
      });
      expect(await readdir(sessionDirectory)).toEqual([
        `${creationResult.agent.state.sessionId}.jsonl`,
      ]);
    }
  });

  it("reopens a requested Session in the same workspace", async () => {
    const workspaceRoot = await createTemporaryDirectory("anthias-startup-reopen-");
    const sessionDirectory = join(workspaceRoot, "sessions");
    const environment = createValidEnvironment(sessionDirectory);
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

  it("rejects an empty requested Session ID without creating a Session", async () => {
    const workspaceRoot = await createTemporaryDirectory("anthias-startup-empty-session-");
    const sessionDirectory = join(workspaceRoot, "sessions");

    const creationResult = await createAgentFromEnvironment({
      environment: createValidEnvironment(sessionDirectory),
      workspaceRoot,
      sessionId: "",
    });

    expect(creationResult).toEqual({
      ok: false,
      error: "Session 启动失败，请检查 Session ID、工作区与本地 Session 文件。",
    });
    await expect(stat(sessionDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function createValidEnvironment(sessionDirectory: string): NodeJS.ProcessEnv {
  return {
    ANTHIAS_MODEL_BASE_URL: "https://example.com/v1/",
    ANTHIAS_MODEL_ID: "model-id",
    ANTHIAS_MODEL_API_KEY: "local-key",
    ANTHIAS_SESSION_DIR: sessionDirectory,
  };
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.add(temporaryDirectory);
  return temporaryDirectory;
}
