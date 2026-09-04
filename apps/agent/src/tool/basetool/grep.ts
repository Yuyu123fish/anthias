import type { AssistantToolCallPart } from "../../message.js";
import {
  hasOnlyKeys,
  isOptionalIntegerInRange,
  isOptionalNonEmptyString,
  isRecord,
} from "../input-validation.js";
import {
  boundToolOutput,
  failedToolResult,
  TOOL_RESULT_LINE_LIMIT,
  type ToolExecutionResult,
  toSafeToolFileError,
} from "../tool-result.js";
import { type ToolWorkspace, validateWorkspaceRelativePath } from "../workspace-path.js";
import { readStrictUtf8File, splitTextLines } from "./text-file.js";
import { discoverWorkspaceFiles } from "./workspace-file-discovery.js";

/** 表示 grep 已完成运行时校验后的固定输入。 */
type GrepToolInput = Readonly<{
  pattern: string;
  searchPattern: RegExp;
  path: string;
  filePattern: string;
  contextLines: number;
}>;

/** 只检查 grep 的运行时输入形状，不访问文件系统。 */
export function validateGrepToolCallInput(toolCall: AssistantToolCallPart): string | null {
  const inputResult = parseGrepToolInput(toolCall);
  return inputResult.ok ? null : inputResult.error;
}

/** 执行 grep，并用相对路径、行号和可选上下文呈现匹配。 */
export async function executeGrepTool(
  toolCall: AssistantToolCallPart,
  workspace: ToolWorkspace,
  abortSignal: AbortSignal,
): Promise<ToolExecutionResult> {
  if (abortSignal.aborted) {
    return failedToolResult("Tool 执行已停止。");
  }
  const inputResult = parseGrepToolInput(toolCall);
  if (!inputResult.ok) {
    return failedToolResult(inputResult.error);
  }
  try {
    const searchPattern = inputResult.input.searchPattern;
    const discoveredFiles = await discoverWorkspaceFiles(
      inputResult.input.filePattern,
      inputResult.input.path,
      workspace,
      abortSignal,
    );
    const resultLines: string[] = [
      `pattern: ${inputResult.input.pattern}`,
      `base: ${inputResult.input.path}`,
    ];
    let skippedFileCount = 0;
    let resultTruncated = discoveredFiles.truncated;

    for (const file of discoveredFiles.paths) {
      if (abortSignal.aborted) {
        return failedToolResult("Tool 执行已停止。");
      }
      let text: string;
      try {
        text = await readStrictUtf8File(file.absolutePath);
      } catch {
        skippedFileCount += 1;
        continue;
      }
      const fileLines = splitTextLines(text);
      for (let lineIndex = 0; lineIndex < fileLines.length; lineIndex += 1) {
        if (!searchPattern.test(fileLines[lineIndex] ?? "")) {
          continue;
        }
        const contextStart = Math.max(0, lineIndex - inputResult.input.contextLines);
        const contextEnd = Math.min(
          fileLines.length - 1,
          lineIndex + inputResult.input.contextLines,
        );
        for (let contextIndex = contextStart; contextIndex <= contextEnd; contextIndex += 1) {
          const marker = contextIndex === lineIndex ? ":" : "-";
          resultLines.push(
            `${file.relativePath}${marker}${contextIndex + 1}${marker}${
              fileLines[contextIndex] ?? ""
            }`,
          );
        }
        if (resultLines.length > TOOL_RESULT_LINE_LIMIT * 2) {
          resultTruncated = true;
          break;
        }
      }
      if (resultTruncated && resultLines.length > TOOL_RESULT_LINE_LIMIT * 2) {
        break;
      }
    }
    resultLines.splice(2, 0, `skippedNonUtf8OrBinaryFiles: ${skippedFileCount}`);
    const rendered = boundToolOutput(resultLines);
    return Object.freeze({
      status: "completed",
      content: rendered.content,
      truncated: resultTruncated || rendered.truncated,
    });
  } catch (error) {
    return abortSignal.aborted
      ? failedToolResult("Tool 执行已停止。")
      : failedToolResult(toSafeToolFileError(error));
  }
}

/** 解析 grep 的精确输入，拒绝未知字段和错误类型。 */
function parseGrepToolInput(
  toolCall: AssistantToolCallPart,
): Readonly<{ ok: true; input: GrepToolInput }> | Readonly<{ ok: false; error: string }> {
  if (toolCall.invalid || toolCall.toolName !== "grep") {
    return Object.freeze({
      ok: false,
      error: `${toolCall.toolName} 输入无法解析或不符合 Schema。`,
    });
  }
  if (!isRecord(toolCall.input)) {
    return Object.freeze({ ok: false, error: `${toolCall.toolName} 输入必须是 JSON 对象。` });
  }
  const input = toolCall.input;
  if (
    !hasOnlyKeys(input, ["pattern", "path", "filePattern", "contextLines"]) ||
    typeof input.pattern !== "string" ||
    !isOptionalNonEmptyString(input.path) ||
    !isOptionalNonEmptyString(input.filePattern) ||
    !isOptionalIntegerInRange(input.contextLines, 0, 10)
  ) {
    return Object.freeze({ ok: false, error: "grep 输入不符合 Schema。" });
  }
  let searchPattern: RegExp;
  try {
    searchPattern = new RegExp(input.pattern, "u");
    validateWorkspaceRelativePath(input.path ?? ".", "grep path");
    validateWorkspaceRelativePath(input.filePattern ?? "**/*", "grep filePattern");
  } catch (error) {
    return Object.freeze({
      ok: false,
      error:
        error instanceof SyntaxError
          ? "grep pattern 不是有效的 JavaScript Unicode 正则。"
          : error instanceof Error
            ? error.message
            : "grep 输入无效。",
    });
  }
  return Object.freeze({
    ok: true,
    input: Object.freeze({
      pattern: input.pattern,
      searchPattern,
      path: input.path ?? ".",
      filePattern: input.filePattern ?? "**/*",
      contextLines: input.contextLines ?? 0,
    }),
  });
}
