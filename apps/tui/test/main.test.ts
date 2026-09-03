import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((temporaryDirectory) =>
      rm(temporaryDirectory, { recursive: true, force: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe("Anthias CLI", () => {
  it("creates a Session without arguments and reopens the same UUID", async () => {
    const workspaceRoot = await createTemporaryDirectory("anthias-cli-reopen-");
    const normalizedWorkspaceRoot = await realpath(workspaceRoot);
    const sessionDirectory = join(workspaceRoot, "sessions");
    const environment = {
      ...process.env,
      ANTHIAS_MODEL_BASE_URL: "https://example.com/v1/",
      ANTHIAS_MODEL_ID: "model-id",
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
    expect((await readdir(sessionDirectory)).sort()).toEqual([".gitignore", `${sessionId}.jsonl`]);
    const sessionHeader = JSON.parse(
      (await readFile(join(sessionDirectory, `${sessionId}.jsonl`), "utf8")).trimEnd(),
    ) as Record<string, unknown>;
    expect(sessionHeader).toMatchObject({
      type: "session_header",
      schemaVersion: 1,
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
    expect((await readdir(sessionDirectory)).sort()).toEqual([".gitignore", `${sessionId}.jsonl`]);
  });

  it("exits before Session creation when model configuration is missing", async () => {
    const sessionDirectory = join(
      await createTemporaryDirectory("anthias-cli-missing-config-"),
      "sessions",
    );
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
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
    const processResult = spawnCli(["--unknown"], { ...process.env });

    expect(processResult.status).toBe(1);
    expect(processResult.stderr).toContain("命令行参数无效");
  });

  it("rejects an invalid --session UUID without a model request", async () => {
    const sessionDirectory = join(
      await createTemporaryDirectory("anthias-cli-invalid-session-"),
      "sessions",
    );
    const processResult = spawnCli(["--session", "../outside"], {
      ...process.env,
      ANTHIAS_MODEL_BASE_URL: "https://example.com/v1/",
      ANTHIAS_MODEL_ID: "model-id",
      ANTHIAS_MODEL_API_KEY: "local-key",
      ANTHIAS_SESSION_DIR: sessionDirectory,
    });

    expect(processResult.status).toBe(1);
    expect(processResult.stderr).toContain("Session 启动失败");
  });
});

function spawnCli(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  cwd?: string,
  input?: string,
) {
  const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));
  return spawnSync(process.execPath, [mainPath, ...arguments_], {
    cwd,
    env: environment,
    encoding: "utf8",
    input,
    timeout: 5_000,
  });
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.add(temporaryDirectory);
  return temporaryDirectory;
}
