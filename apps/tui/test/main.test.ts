import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Anthias CLI", () => {
  it("exits before a request when model configuration is missing", () => {
    const env = { ...process.env };
    delete env.ANTHIAS_MODEL_BASE_URL;
    delete env.ANTHIAS_MODEL_ID;
    delete env.ANTHIAS_MODEL_API_KEY;
    const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));

    const result = spawnSync(process.execPath, [mainPath], {
      env,
      encoding: "utf8",
      timeout: 5_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("缺少模型配置");
    expect(result.stderr).toContain("ANTHIAS_MODEL_API_KEY");
  });
});
