import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LOCAL_ENVIRONMENT_TEMPLATE, loadLocalConfiguration } from "../src/local-config.js";
import { readModelConfig } from "../src/model/model-config.js";

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

describe("Anthias local configuration", () => {
  it("creates the credential-free template once and never copies process credentials", async () => {
    const anthiasRoot = await temporaryRoot();
    const result = await loadLocalConfiguration({
      anthiasRoot,
      environment: { ANTHIAS_MODEL_API_KEY: "synthetic-process-key" },
    });
    expect(result).toMatchObject({ ok: true, permissionMode: "agent" });
    const generatedText = await readFile(join(anthiasRoot, ".env"), "utf8");
    expect(generatedText).toBe(LOCAL_ENVIRONMENT_TEMPLATE);
    expect(generatedText).not.toContain("synthetic-process-key");
    expect(generatedText).toBe(
      await readFile(fileURLToPath(new URL("../../../.env-example", import.meta.url)), "utf8"),
    );
    if (process.platform !== "win32")
      expect((await stat(join(anthiasRoot, ".env"))).mode & 0o777).toBe(0o600);
  });

  it("uses only the installation root and keeps existing file bytes unchanged", async () => {
    const anthiasRoot = await temporaryRoot();
    const workspaceRoot = join(anthiasRoot, "task-workspace");
    await mkdir(workspaceRoot);
    const configuration =
      "ANTHIAS_MODEL_API_KEY='synthetic-root-key' # local\nANTHIAS_PERMISSION_MODE=plan\n";
    await writeFile(join(anthiasRoot, ".env"), configuration);
    await writeFile(
      join(workspaceRoot, ".env"),
      "ANTHIAS_MODEL_API_KEY=wrong-workspace-key\nANTHIAS_PERMISSION_MODE=auto_allow\n",
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await loadLocalConfiguration({ anthiasRoot, environment: {} });
      expect(result).toMatchObject({
        ok: true,
        permissionMode: "plan",
        environment: { ANTHIAS_MODEL_API_KEY: "synthetic-root-key" },
      });
    }
    expect(await readFile(join(anthiasRoot, ".env"), "utf8")).toBe(configuration);
  });

  it("gives explicit mode and process values precedence including empty credentials", async () => {
    const anthiasRoot = await temporaryRoot();
    await writeFile(
      join(anthiasRoot, ".env"),
      "ANTHIAS_MODEL_API_KEY=file-key\nANTHIAS_PERMISSION_MODE=auto_allow\nSEARCHAPI_API_KEY=file-search-key\n",
    );
    const result = await loadLocalConfiguration({
      anthiasRoot,
      environment: {
        ANTHIAS_MODEL_API_KEY: "",
        SEARCHAPI_API_KEY: undefined,
        ANTHIAS_PERMISSION_MODE: "plan",
      },
      permissionMode: "agent",
    });
    expect(result).toMatchObject({
      ok: true,
      permissionMode: "agent",
      environment: { ANTHIAS_MODEL_API_KEY: "", SEARCHAPI_API_KEY: undefined },
    });
    if (result.ok) expect(readModelConfig(result.environment)).toMatchObject({ ok: false });
    expect(
      await loadLocalConfiguration({
        anthiasRoot,
        environment: { ANTHIAS_PERMISSION_MODE: "plan" },
      }),
    ).toMatchObject({ ok: true, permissionMode: "plan" });
    expect(
      await loadLocalConfiguration({ anthiasRoot, environment: { ANTHIAS_PERMISSION_MODE: "" } }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("ANTHIAS_PERMISSION_MODE") });
  });

  it("accepts explicit Full Access while preserving configuration precedence and the default", async () => {
    const anthiasRoot = await temporaryRoot();
    expect(await loadLocalConfiguration({ anthiasRoot, environment: {} })).toMatchObject({
      ok: true,
      permissionMode: "agent",
    });
    await writeFile(join(anthiasRoot, ".env"), "ANTHIAS_PERMISSION_MODE=full_access\n");
    expect(await loadLocalConfiguration({ anthiasRoot, environment: {} })).toMatchObject({
      ok: true,
      permissionMode: "full_access",
    });
    expect(
      await loadLocalConfiguration({
        anthiasRoot,
        environment: { ANTHIAS_PERMISSION_MODE: "plan" },
      }),
    ).toMatchObject({ ok: true, permissionMode: "plan" });
    expect(
      await loadLocalConfiguration({
        anthiasRoot,
        environment: { ANTHIAS_PERMISSION_MODE: "plan" },
        permissionMode: "full_access",
      }),
    ).toMatchObject({ ok: true, permissionMode: "full_access" });
  });

  it("rejects malformed values without exposing configuration text", async () => {
    const anthiasRoot = await temporaryRoot();
    await writeFile(join(anthiasRoot, ".env"), 'ANTHIAS_MODEL_API_KEY="synthetic-unclosed-key\n');
    const malformed = await loadLocalConfiguration({ anthiasRoot, environment: {} });
    expect(malformed).toMatchObject({ ok: false, error: expect.stringContaining("第 1 行") });
    expect(JSON.stringify(malformed)).not.toContain("synthetic-unclosed-key");
    await writeFile(join(anthiasRoot, ".env"), "ANTHIAS_PERMISSION_MODE=synthetic-invalid-mode\n");
    const invalidMode = await loadLocalConfiguration({ anthiasRoot, environment: {} });
    expect(invalidMode).toMatchObject({
      ok: false,
      error: expect.stringContaining("ANTHIAS_PERMISSION_MODE"),
    });
    expect(JSON.stringify(invalidMode)).not.toContain("synthetic-invalid-mode");
  });

  it("reports an unavailable file and allows sufficient process configuration when creation fails", async () => {
    const anthiasRoot = join(await temporaryRoot(), "missing-installation");
    const warnings: string[] = [];
    const result = await loadLocalConfiguration({
      anthiasRoot,
      environment: {
        ANTHIAS_MODEL_BASE_URL: "https://example.com/v1",
        ANTHIAS_MODEL_ID: "test-model",
        ANTHIAS_MODEL_CONTEXT_WINDOW: "128000",
        ANTHIAS_MODEL_API_KEY: "synthetic-environment-only-key",
      },
      onConfigurationWarning: (warning) => warnings.push(warning),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(readModelConfig(result.environment).ok).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(join(anthiasRoot, ".env"));
    expect(warnings[0]).not.toContain("synthetic-environment-only-key");
    const unreadableRoot = await temporaryRoot();
    await mkdir(join(unreadableRoot, ".env"));
    expect(
      await loadLocalConfiguration({ anthiasRoot: unreadableRoot, environment: {} }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("普通文件") });
  });
});

async function temporaryRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "anthias-local-config-"));
  temporaryDirectories.add(directory);
  return directory;
}
