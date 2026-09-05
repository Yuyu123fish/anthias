import type { AssistantToolCallPart } from "../../message.js";
import type { SessionArtifactStore } from "../../session/artifacts.js";
import {
  hasOnlyKeys,
  isNonEmptyString,
  isOptionalIntegerInRange,
  isOptionalNonEmptyString,
  isRecord,
} from "../input-validation.js";
import { failedToolResult, type ToolExecutionResult } from "../tool-result.js";

type ReadArtifactToolInput = Readonly<{
  artifactId: string;
  cursor?: string;
  lineCount?: number;
  search?: string;
}>;

/** 只检查 read_artifact 的输入形状，不访问文件系统。 */
export function validateReadArtifactToolCallInput(toolCall: AssistantToolCallPart): string | null {
  const inputResult = parseReadArtifactToolInput(toolCall);
  return inputResult.ok ? null : inputResult.error;
}

/** 读取当前 Session 已引用的产物，不执行来源 Tool，也不生成新产物。 */
export async function executeReadArtifactTool(
  toolCall: AssistantToolCallPart,
  artifactStore: SessionArtifactStore | undefined,
  abortSignal: AbortSignal,
  resultTokenBudget?: number,
): Promise<ToolExecutionResult> {
  if (abortSignal.aborted) {
    return failedToolResult("Tool 执行已停止。");
  }
  const inputResult = parseReadArtifactToolInput(toolCall);
  if (!inputResult.ok) {
    return failedToolResult(inputResult.error);
  }
  if (artifactStore === undefined) {
    return failedToolResult("当前 Session 未提供产物读取能力。");
  }
  try {
    const readResult = await artifactStore.readArtifact(inputResult.input, resultTokenBudget);
    return Object.freeze({
      status: readResult.status,
      content: readResult.content,
      truncated: readResult.truncated,
    });
  } catch {
    return failedToolResult("产物读取失败。");
  }
}

function parseReadArtifactToolInput(
  toolCall: AssistantToolCallPart,
): Readonly<{ ok: true; input: ReadArtifactToolInput }> | Readonly<{ ok: false; error: string }> {
  if (toolCall.invalid || toolCall.toolName !== "read_artifact") {
    return Object.freeze({
      ok: false,
      error: toolCall.toolName + " 输入无法解析或不符合 Schema。",
    });
  }
  if (!isRecord(toolCall.input)) {
    return Object.freeze({ ok: false, error: "read_artifact 输入必须是 JSON 对象。" });
  }
  const input = toolCall.input;
  if (
    !hasOnlyKeys(input, ["artifactId", "cursor", "lineCount", "search"]) ||
    !isNonEmptyString(input.artifactId) ||
    !isOptionalNonEmptyString(input.cursor) ||
    !isOptionalIntegerInRange(input.lineCount, 1, 200) ||
    !isOptionalNonEmptyString(input.search)
  ) {
    return Object.freeze({ ok: false, error: "read_artifact 输入不符合 Schema。" });
  }
  return Object.freeze({
    ok: true,
    input: Object.freeze({
      artifactId: input.artifactId,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.lineCount === undefined ? {} : { lineCount: input.lineCount }),
      ...(input.search === undefined ? {} : { search: input.search }),
    }),
  });
}
