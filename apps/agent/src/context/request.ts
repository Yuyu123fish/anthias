import { createHash } from "node:crypto";
import type { ModelRequest, ModelUsage } from "../model/model-stream.js";
import { type ContextBudget, estimateModelRequestTokens } from "./budget.js";

export type UsageAnchor = Readonly<{
  contextVersion: string;
  messages: readonly string[];
  estimatedInputTokens: number;
  actualInputTokens: number;
  usage: ModelUsage;
}>;

export function createContextVersion(
  modelId: string,
  budget: ContextBudget,
  request: ModelRequest,
  checkpointId: string | null,
): string {
  return createHash("sha256")
    .update(JSON.stringify([modelId, budget, request.systemPrompt, request.tools, checkpointId]))
    .digest("hex");
}

/** 校准只覆盖完全相同的已发送前缀；Reasoning 移除、摘要替换和 Schema 变化都会使锚点失效。 */
export function measureRequest(
  request: ModelRequest,
  contextVersion: string,
  anchor: UsageAnchor | null,
): Readonly<{
  inputTokens: number;
  estimatedInputTokens: number;
  source: "estimated" | "calibrated";
}> {
  const estimatedInputTokens = estimateModelRequestTokens(request);
  if (
    anchor !== null &&
    anchor.contextVersion === contextVersion &&
    request.messages.length >= anchor.messages.length &&
    anchor.messages.every((message, index) => message === JSON.stringify(request.messages[index]))
  ) {
    return {
      inputTokens:
        anchor.actualInputTokens + Math.max(0, estimatedInputTokens - anchor.estimatedInputTokens),
      estimatedInputTokens,
      source: "calibrated",
    };
  }
  return { inputTokens: estimatedInputTokens, estimatedInputTokens, source: "estimated" };
}

export function createUsageAnchor(
  request: ModelRequest,
  contextVersion: string,
  usage: ModelUsage | undefined,
): UsageAnchor | null {
  if (
    usage?.inputTokens == null ||
    !Number.isSafeInteger(usage.inputTokens) ||
    usage.inputTokens < 0
  )
    return null;
  return {
    contextVersion,
    messages: request.messages.map((message) => JSON.stringify(message)),
    estimatedInputTokens: estimateModelRequestTokens(request),
    actualInputTokens: usage.inputTokens,
    usage: Object.freeze({ ...usage }),
  };
}
