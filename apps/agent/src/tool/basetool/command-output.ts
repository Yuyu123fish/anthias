import { closeSync, mkdtempSync, openSync, writeSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolArtifactIncompleteReason } from "../../message.js";
import { ARTIFACT_BYTE_LIMIT } from "../../session/artifacts.js";
import {
  boundToolOutput,
  TOOL_RESULT_BYTE_LIMIT,
  TOOL_RESULT_LINE_LIMIT,
  type ToolExecutionResult,
} from "../tool-result.js";
import type { CommandExecutionResult, CommandTerminationReason } from "./execute-command.js";

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

/** 保存命令输出中一个按 Node 观察顺序接受的有界片段。 */
type CommandOutputEntry = Readonly<{
  stream: "stdout" | "stderr";
  text: string;
}>;

/** 聚合命令输出并在达到展示边界后继续排空但停止保存。 */
type CommandOutputCollector = Readonly<{
  append(stream: "stdout" | "stderr", text: string): string;
  entries(): readonly CommandOutputEntry[];
  readonly truncated: boolean;
}>;

/** 创建一个只保存有界 UTF-8 文本和行数的命令输出收集器。 */
export function createCommandOutputCollector(): CommandOutputCollector {
  const entries: CommandOutputEntry[] = [];
  let byteCount = 0;
  let lineCount = 0;
  let outputStarted = false;
  let truncated = false;

  return Object.freeze({
    append(stream, text) {
      if (truncated || text.length === 0) {
        return "";
      }
      let acceptedText = "";
      for (const character of text) {
        const characterBytes = Buffer.byteLength(character, "utf8");
        const nextLineCount = lineCount + (!outputStarted || character === "\n" ? 1 : 0);
        if (
          byteCount + characterBytes > TOOL_RESULT_BYTE_LIMIT - 1024 ||
          nextLineCount > TOOL_RESULT_LINE_LIMIT - 16
        ) {
          truncated = true;
          break;
        }
        acceptedText += character;
        byteCount += characterBytes;
        lineCount = nextLineCount;
        outputStarted = true;
      }
      if (acceptedText.length > 0) {
        const previousEntry = entries.at(-1);
        // 相邻同源块合并后只占一个渲染标签，预留的行数才能覆盖最终 ToolResult 元数据。
        if (previousEntry?.stream === stream) {
          entries[entries.length - 1] = Object.freeze({
            stream,
            text: previousEntry.text + acceptedText,
          });
        } else {
          entries.push(Object.freeze({ stream, text: acceptedText }));
        }
      }
      return acceptedText;
    },
    entries: () => Object.freeze([...entries]),
    get truncated() {
      return truncated;
    },
  });
}

/** 将命令终止事实与按观察顺序保存的输出收敛为一个有界 ToolResult。 */
export function createCommandResult(
  reason: CommandTerminationReason,
  exitCode: number | null,
  durationMilliseconds: number,
  outputCollector: CommandOutputCollector,
  cleanupUncertain: boolean,
): CommandExecutionResult {
  const resultLines = [
    `termination: ${reason}`,
    `exitCode: ${exitCode ?? "none"}`,
    `durationMs: ${Math.max(0, Math.round(durationMilliseconds))}`,
    `cleanupUncertain: ${cleanupUncertain}`,
    "output:",
  ];
  for (const entry of outputCollector.entries()) {
    resultLines.push(`[${entry.stream}]`, ...splitCommandOutputLines(entry.text));
  }
  if (outputCollector.truncated) {
    resultLines.push("...[命令输出已截断，管道已继续排空]");
  }
  const rendered = boundToolOutput(resultLines);
  return Object.freeze({
    status: reason === "completed" ? "completed" : "failed",
    content: rendered.content,
    truncated: outputCollector.truncated || rendered.truncated,
    cleanupUncertain,
  });
}

/** 把多行确认或结果文本拆成稳定行，不虚构额外尾行。 */
export function splitCommandOutputLines(text: string): string[] {
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.length === 0 ? [""] : lines;
}
