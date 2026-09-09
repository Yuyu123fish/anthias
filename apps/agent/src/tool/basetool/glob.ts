import type { AssistantToolCallPart } from "../../message.js";
import {
  hasOnlyKeys,
  isNonEmptyString,
  isOptionalNonEmptyString,
  isRecord,
} from "../input-validation.js";
import { createReadOnlyToolCallPlan, createRejectedToolCallPlan } from "../tool-plan.js";
import {
  boundToolOutput,
  failedToolResult,
  type ToolExecutionResult,
  toSafeToolFileError,
} from "../tool-result.js";
import type { BaseTool } from "../tool-runner.js";
import { type ToolWorkspace, validateWorkspaceRelativePath } from "../workspace-path.js";
import { discoverWorkspaceFiles } from "./workspace-file-discovery.js";

export const globTool: BaseTool = Object.freeze({
  definition: Object.freeze({
    name: "glob",
    description: "按相对 Glob 模式发现文件；path 是搜索基准目录，Full Access 可使用工作区外目录。",
    inputSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["pattern"],
      properties: {
        pattern: { type: "string", minLength: 1 },
        path: { type: "string", minLength: 1 },
      },
    }),
  }),
  createPlan(toolCall, permissionMode, options) {
    const parsed = parseGlobToolInput(toolCall, options.workspace);
    if (!parsed.ok) return createRejectedToolCallPlan(parsed.error);
    const input = parsed.input;
    return createReadOnlyToolCallPlan(
      toolCall,
      "glob",
      permissionMode,
      options.workspace,
      `pattern: ${input.pattern}; base: ${input.path}`,
      true,
      executeGlobTool,
    );
  },
});

/** 表示 glob 已完成运行时校验后的固定输入。 */
type GlobToolInput = Readonly<{
  pattern: string;
  path: string;
}>;

/** 执行 glob 并稳定排序工作区相对文件路径。 */
export async function executeGlobTool(
  toolCall: AssistantToolCallPart,
  workspace: ToolWorkspace,
  abortSignal: AbortSignal,
): Promise<ToolExecutionResult> {
  if (abortSignal.aborted) {
    return failedToolResult("Tool 执行已停止。");
  }
  const inputResult = parseGlobToolInput(toolCall, workspace);
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
    const resultLines = [
      `pattern: ${inputResult.input.pattern}`,
      `base: ${inputResult.input.path}`,
      ...discoveredFiles.paths.map((file) => file.relativePath),
    ];
    const rendered = boundToolOutput(resultLines);
    return Object.freeze({
      status: "completed",
      content: rendered.content,
      originalContent: resultLines.join("\n"),
      ...(discoveredFiles.truncated ? { sourceIncomplete: "source_failed" as const } : {}),
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
  workspace?: ToolWorkspace,
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
  try {
    validateWorkspaceRelativePath(input.pattern, "glob pattern");
    if (!workspace?.allowExternalPaths)
      validateWorkspaceRelativePath(input.path ?? ".", "glob path");
  } catch (error) {
    return Object.freeze({
      ok: false,
      error: error instanceof Error ? error.message : "glob path 无效。",
    });
  }
  return Object.freeze({
    ok: true,
    input: Object.freeze({ pattern: input.pattern, path: input.path ?? "." }),
  });
}
