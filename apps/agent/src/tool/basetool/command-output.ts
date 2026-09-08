import { closeSync, mkdtempSync, openSync, writeSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolArtifactIncompleteReason } from "../../message.js";
import { ARTIFACT_BYTE_LIMIT } from "../../session/artifacts.js";
import { TOOL_RESULT_BYTE_LIMIT, type ToolExecutionResult } from "../tool-result.js";

/** 命令独占的输出收集：短输出留内存，超过阈值才创建临时文件，句柄在交付前关闭。 */
export function createCommandOutputCapture() {
  const buffered: Buffer[] = [];
  let capturedBytes = 0;
  let directory: string | undefined;
  let outputPath: string | undefined;
  let descriptor: number | undefined;
  let incompleteReason: ToolArtifactIncompleteReason | undefined;
  let finished = false;
  function write(bytes: Buffer) {
    if (descriptor === undefined) return;
    for (let offset = 0; offset < bytes.length; ) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written === 0) throw new Error("命令输出写入未前进。");
      offset += written;
    }
  }
  return {
    append(text: string) {
      if (finished || incompleteReason !== undefined || text.length === 0) return;
      const bytes = Buffer.from(text, "utf8");
      const acceptedBytes = bytes.subarray(0, Math.max(0, ARTIFACT_BYTE_LIMIT - capturedBytes));
      try {
        if (
          descriptor === undefined &&
          capturedBytes + acceptedBytes.length > TOOL_RESULT_BYTE_LIMIT
        ) {
          directory = mkdtempSync(join(tmpdir(), "anthias-command-output-"));
          outputPath = join(directory, "output.txt");
          descriptor = openSync(outputPath, "wx", 0o600);
          for (const previous of buffered) write(previous);
          buffered.length = 0;
        }
        if (descriptor === undefined) buffered.push(acceptedBytes);
        else write(acceptedBytes);
        capturedBytes += acceptedBytes.length;
        if (acceptedBytes.length < bytes.length) incompleteReason = "artifact_limit";
      } catch {
        incompleteReason = "write_failed";
      }
    },
    finish(): Pick<ToolExecutionResult, "originalContent" | "outputFile" | "sourceIncomplete"> {
      finished = true;
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          incompleteReason ??= "write_failed";
        }
        descriptor = undefined;
      }
      const ownedDirectory = directory;
      const file = outputPath;
      return {
        ...(file === undefined
          ? { originalContent: Buffer.concat(buffered).toString("utf8") }
          : {
              outputFile: {
                path: file,
                async dispose() {
                  // 目录来自本次 mkdtemp，绝不从 Tool 参数或模型输出构造清理目标。
                  if (ownedDirectory !== undefined)
                    await rm(ownedDirectory, { recursive: true, force: true });
                },
              },
            }),
        ...(incompleteReason === undefined ? {} : { sourceIncomplete: incompleteReason }),
      };
    },
  };
}
