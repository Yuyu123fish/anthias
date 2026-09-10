import { access, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ARTIFACT_BYTE_LIMIT } from "../src/tool/artifacts.js";
import { createCommandOutputCapture } from "../src/tool/basetool/command-output.js";
import { finalizeToolResult } from "../src/tool/tool-result.js";

describe("Command output ownership", () => {
  it("caps the spool and removes its closed file even when artifact preservation is unavailable", async () => {
    const capture = createCommandOutputCapture();
    const chunk = "x".repeat(1024 * 1024);
    for (let index = 0; index < 34; index += 1) capture.append(chunk);
    const output = capture.finish();
    const outputFile = output.outputFile;
    if (outputFile === undefined) throw new Error("expected spooled output");
    try {
      expect(output.sourceIncomplete).toBe("artifact_limit");
      expect((await stat(outputFile.path)).size).toBe(ARTIFACT_BYTE_LIMIT);
      const finalized = await finalizeToolResult(
        "spooled-command",
        {
          status: "failed",
          content: "command aborted",
          truncated: true,
          ...output,
        },
        undefined,
        4_000,
        "aborted",
      );
      expect(finalized).toMatchObject({ status: "failed", truncated: true });
      expect(finalized.artifact).toBeUndefined();
      expect(finalized.content).toContain("原文产物未保存");
      expect(finalized.cleanupUncertain).toBeUndefined();
      await expect(access(outputFile.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await outputFile.dispose();
    }
  });
});
