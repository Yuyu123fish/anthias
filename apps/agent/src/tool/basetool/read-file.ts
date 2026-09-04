import { stat } from "node:fs/promises";
import type { AssistantToolCallPart } from "../../message.js";
import {
  hasOnlyKeys,
  isNonEmptyString,
  isOptionalIntegerInRange,
  isRecord,
} from "../input-validation.js";
import {
  boundToolOutput,
  failedToolResult,
  type ToolExecutionResult,
  toSafeToolFileError,
} from "../tool-result.js";
import {
  resolveExistingWorkspacePath,
  type ToolWorkspace,
  validateWorkspaceRelativePath,
} from "../workspace-path.js";
import { readStrictUtf8File, splitTextLines } from "./text-file.js";

/** 表示 read_file 已完成运行时校验后的固定输入。 */
type ReadFileToolInput = Readonly<{
  path: string;
  startLine: number;
  lineCount: number;
}>;

/** 只检查 read_file 的运行时输入形状，不访问文件系统。 */
export function validateReadFileToolCallInput(toolCall: AssistantToolCallPart): string | null {
  const inputResult = parseReadFileToolInput(toolCall);
  return inputResult.ok ? null : inputResult.error;
}

/** 执行 read_file 并返回有范围、继续位置和截断事实的文本。 */
export async function executeReadFileTool(
  toolCall: AssistantToolCallPart,
  workspace: ToolWorkspace,
  abortSignal: AbortSignal,
): Promise<ToolExecutionResult> {
  if (abortSignal.aborted) {
    return failedToolResult("Tool 执行已停止。");
  }
  const inputResult = parseReadFileToolInput(toolCall);
  if (!inputResult.ok) {
    return failedToolResult(inputResult.error);
  }
  try {
    const target = await resolveExistingWorkspacePath(inputResult.input.path, workspace);
    const targetStats = await stat(target.absolutePath);
    if (!targetStats.isFile()) {
      return failedToolResult(`read_file 目标不是文件：${target.relativePath}`);
    }
    const text = await readStrictUtf8File(target.absolutePath);
    if (abortSignal.aborted) {
      return failedToolResult("Tool 执行已停止。");
    }
    const lines = splitTextLines(text);
    const startIndex = Math.min(inputResult.input.startLine - 1, lines.length);
    const selectedLines = lines.slice(startIndex, startIndex + inputResult.input.lineCount);
    const endLine = selectedLines.length === 0 ? startIndex : startIndex + selectedLines.length;
    const hasMoreLines = startIndex + selectedLines.length < lines.length;
    const rendered = boundToolOutput([
      `path: ${target.relativePath}`,
      `lines: ${
        selectedLines.length === 0 ? "none" : `${startIndex + 1}-${endLine}`
      } of ${lines.length}`,
      `nextStartLine: ${hasMoreLines ? endLine + 1 : "none"}`,
      "---",
      ...selectedLines.map((line, index) => `${startIndex + index + 1}| ${line}`),
    ]);
    return Object.freeze({
      status: "completed",
      content: rendered.content,
      truncated: hasMoreLines || rendered.truncated,
    });
  } catch (error) {
    return abortSignal.aborted
      ? failedToolResult("Tool 执行已停止。")
      : failedToolResult(toSafeToolFileError(error));
  }
}

/** 解析 read_file 的精确输入，拒绝未知字段和错误类型。 */
function parseReadFileToolInput(
  toolCall: AssistantToolCallPart,
): Readonly<{ ok: true; input: ReadFileToolInput }> | Readonly<{ ok: false; error: string }> {
  if (toolCall.invalid || toolCall.toolName !== "read_file") {
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
    !hasOnlyKeys(input, ["path", "startLine", "lineCount"]) ||
    !isNonEmptyString(input.path) ||
    !isOptionalIntegerInRange(input.startLine, 1, Number.MAX_SAFE_INTEGER) ||
    !isOptionalIntegerInRange(input.lineCount, 1, 2000)
  ) {
    return Object.freeze({ ok: false, error: "read_file 输入不符合 Schema。" });
  }
  try {
    validateWorkspaceRelativePath(input.path, "read_file path");
  } catch (error) {
    return Object.freeze({
      ok: false,
      error: error instanceof Error ? error.message : "read_file path 无效。",
    });
  }
  return Object.freeze({
    ok: true,
    input: Object.freeze({
      path: input.path,
      startLine: input.startLine ?? 1,
      lineCount: input.lineCount ?? 200,
    }),
  });
}
