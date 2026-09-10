import type { AssistantToolCallPart } from "../../message.js";
import type { PermissionMode } from "../../permission/permission-mode.js";
import { decideToolPolicy } from "../../permission/tool-policy.js";
import type { SessionArtifactStore } from "../artifacts.js";
import {
  hasOnlyKeys,
  isNonEmptyString,
  isOptionalIntegerInRange,
  isOptionalNonEmptyString,
  isRecord,
} from "../input-validation.js";
import {
  createPolicyDeniedPlan,
  createRejectedToolCallPlan,
  createToolActivitySummary,
} from "../tool-plan.js";
import { failedToolResult, type ToolExecutionResult } from "../tool-result.js";
import type { BaseTool, PreparedToolExecution, ToolCallPlan } from "../tool-runner.js";

export const readArtifactTool: BaseTool = Object.freeze({
  definition: Object.freeze({
    name: "read_artifact",
    description: "读取当前 Session 已引用的 Tool 原文产物。",
    inputSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["artifactId"],
      properties: {
        artifactId: { type: "string", minLength: 1 },
        cursor: { type: "string", minLength: 1 },
        lineCount: { type: "integer", minimum: 1, maximum: 200 },
        search: { type: "string", minLength: 1 },
      },
    }),
  }),
  createPlan(toolCall, permissionMode, options) {
    const validationError = validateReadArtifactToolCallInput(toolCall);
    if (validationError !== null) return createRejectedToolCallPlan(validationError);
    return createReadArtifactToolCallPlan(toolCall, permissionMode, options.artifactStore);
  },
});

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

function createReadArtifactToolCallPlan(
  toolCall: AssistantToolCallPart,
  permissionMode: PermissionMode,
  artifactStore: SessionArtifactStore | undefined,
): ToolCallPlan {
  const policyDecision = decideToolPolicy({ permissionMode, toolName: "read_artifact" });
  if (policyDecision.kind !== "allow") {
    return createPolicyDeniedPlan(policyDecision);
  }
  return Object.freeze({
    scheduling: "parallel",
    abortedPreparationContent: "Tool 执行已停止。",
    prepare: () =>
      Promise.resolve(
        Object.freeze({
          ok: true,
          preparedExecution: Object.freeze({
            approval: null,
            activitySummary: createToolActivitySummary(
              `artifactId: ${isRecord(toolCall.input) ? String(toolCall.input.artifactId) : ""}`,
            ),
            executionUnavailableContent: "Run 已停止，Tool 未执行。",
            async execute(
              abortSignal: AbortSignal,
              _publishUpdate: Parameters<PreparedToolExecution["execute"]>[1],
              resultTokenBudget?: number,
            ) {
              return Object.freeze({
                ...(await executeReadArtifactTool(
                  toolCall,
                  artifactStore,
                  abortSignal,
                  resultTokenBudget,
                )),
                cleanupUncertain: false,
              });
            },
          }),
        }),
      ),
  });
}
