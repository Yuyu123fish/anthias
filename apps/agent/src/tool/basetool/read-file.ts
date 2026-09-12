import { readFile, stat } from "node:fs/promises";
import type { AssistantToolCallPart } from "../../message.js";
import {
  hasOnlyKeys,
  isNonEmptyString,
  isOptionalIntegerInRange,
  isRecord,
} from "../input-validation.js";
import { createReadOnlyToolCallPlan, createRejectedToolCallPlan } from "../tool-plan.js";
import {
  failedToolResult,
  renderToolFilePage,
  type ToolExecutionResult,
  toSafeToolFileError,
} from "../tool-result.js";
import type { BaseTool } from "../tool-runner.js";
import {
  resolveExistingWorkspacePath,
  type ToolWorkspace,
  validateWorkspaceRelativePath,
} from "../workspace-path.js";
import { decodeStrictUtf8, fileContentVersion, splitTextLines } from "./text-file.js";

export const readFileTool: BaseTool = Object.freeze({
  definition: Object.freeze({
    name: "read_file",
    description:
      "读取 UTF-8 文件的指定行范围，返回同次读取的全文件 SHA-256 version；修改时把该版本作为 expectedVersion。按 nextStartLine 继续分页；Full Access 可使用工作区外路径。",
    inputSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string", minLength: 1 },
        startLine: { type: "integer", minimum: 1 },
        lineCount: { type: "integer", minimum: 1, maximum: 2000 },
      },
    }),
  }),
  createPlan(toolCall, permissionMode, options) {
    const parsed = parseReadFileToolInput(toolCall, options.workspace);
    if (!parsed.ok) return createRejectedToolCallPlan(parsed.error);
    const input = parsed.input;
    return createReadOnlyToolCallPlan(
      toolCall,
      "read_file",
      permissionMode,
      options.workspace,
      `path: ${input.path}${typeof toolCall.input === "object" && toolCall.input !== null && ("startLine" in toolCall.input || "lineCount" in toolCall.input) ? `; lines: ${input.startLine}-${input.startLine + input.lineCount - 1}` : ""}`,
      false,
      executeReadFileTool,
    );
  },
});

/** 表示 read_file 已完成运行时校验后的固定输入。 */
type ReadFileToolInput = Readonly<{
  path: string;
  startLine: number;
  lineCount: number;
}>;

/** 执行 read_file 并返回有范围、继续位置和截断事实的文本。 */
export async function executeReadFileTool(
  toolCall: AssistantToolCallPart,
  workspace: ToolWorkspace,
  abortSignal: AbortSignal,
): Promise<ToolExecutionResult> {
  if (abortSignal.aborted) {
    return failedToolResult("Tool 执行已停止。");
  }
  const inputResult = parseReadFileToolInput(toolCall, workspace);
  if (!inputResult.ok) {
    return failedToolResult(inputResult.error);
  }
  try {
    const target = await resolveExistingWorkspacePath(inputResult.input.path, workspace);
    const targetStats = await stat(target.absolutePath);
    if (!targetStats.isFile()) {
      return failedToolResult(`read_file 目标不是文件：${target.relativePath}`);
    }
    const originalBytes = await readFile(target.absolutePath);
    const text = decodeStrictUtf8(originalBytes);
    if (abortSignal.aborted) {
      return failedToolResult("Tool 执行已停止。");
    }
    const lines = splitTextLines(text);
    const startIndex = Math.min(inputResult.input.startLine - 1, lines.length);
    const selectedLines = lines.slice(startIndex, startIndex + inputResult.input.lineCount);
    const hasMoreLines = startIndex + selectedLines.length < lines.length;

    const filePage = {
      path: target.relativePath,
      version: fileContentVersion(originalBytes),
      startLine: startIndex + 1,
      totalLines: lines.length,
      lines: selectedLines,
    };
    return Object.freeze({
      status: "completed",
      content: renderToolFilePage(filePage),
      filePage,
      truncated: hasMoreLines,
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
  workspace?: ToolWorkspace,
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
    if (!workspace?.allowExternalPaths) validateWorkspaceRelativePath(input.path, "read_file path");
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
