import type { AssistantToolCallPart } from "../../message.js";
import {
  hasOnlyKeys,
  isNonEmptyString,
  isOptionalNonEmptyString,
  isRecord,
} from "../input-validation.js";
import {
  boundToolOutput,
  failedToolResult,
  type ToolExecutionResult,
  toSafeToolFileError,
} from "../tool-result.js";
import type { ToolWorkspace } from "../workspace-path.js";
import { discoverWorkspaceFiles } from "./workspace-file-discovery.js";

/** 表示 glob 已完成运行时校验后的固定输入。 */
type GlobToolInput = Readonly<{
  pattern: string;
  path: string;
}>;

/** 只检查 glob 的运行时输入形状，不访问文件系统。 */
export function validateGlobToolCallInput(toolCall: AssistantToolCallPart): string | null {
  const inputResult = parseGlobToolInput(toolCall);
  return inputResult.ok ? null : inputResult.error;
}

/** 执行 glob 并稳定排序工作区相对文件路径。 */
export async function executeGlobTool(
  toolCall: AssistantToolCallPart,
  workspace: ToolWorkspace,
  abortSignal: AbortSignal,
): Promise<ToolExecutionResult> {
  if (abortSignal.aborted) {
    return failedToolResult("Tool 执行已停止。");
  }
  const inputResult = parseGlobToolInput(toolCall);
  if (!inputResult.ok) {
    return failedToolResult(inputResult.error);
  }
  try {
    const discoveredFiles = await discoverWorkspaceFiles(
      inputResult.input.pattern,
      inputResult.input.path,
      workspace,
      abortSignal,
    );
    const rendered = boundToolOutput([
      `pattern: ${inputResult.input.pattern}`,
      `base: ${inputResult.input.path}`,
      ...discoveredFiles.paths.map((file) => file.relativePath),
    ]);
    return Object.freeze({
      status: "completed",
      content: rendered.content,
      truncated: discoveredFiles.truncated || rendered.truncated,
    });
  } catch (error) {
    return abortSignal.aborted
      ? failedToolResult("Tool 执行已停止。")
      : failedToolResult(toSafeToolFileError(error));
  }
}

/** 解析 glob 的精确输入，拒绝未知字段和错误类型。 */
function parseGlobToolInput(
  toolCall: AssistantToolCallPart,
): Readonly<{ ok: true; input: GlobToolInput }> | Readonly<{ ok: false; error: string }> {
  if (toolCall.invalid || toolCall.toolName !== "glob") {
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
    !hasOnlyKeys(input, ["pattern", "path"]) ||
    !isNonEmptyString(input.pattern) ||
    !isOptionalNonEmptyString(input.path)
  ) {
    return Object.freeze({ ok: false, error: "glob 输入不符合 Schema。" });
  }
  return Object.freeze({
    ok: true,
    input: Object.freeze({ pattern: input.pattern, path: input.path ?? "." }),
  });
}
