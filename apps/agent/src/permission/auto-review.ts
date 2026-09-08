import {
  type ContextBudget,
  estimateModelRequestTokens,
  estimateTextTokens,
} from "../context/budget.js";
import type { AssistantToolCallPart } from "../message.js";
import type {
  ModelFinishReason,
  ModelRequest,
  ModelStream,
  ModelUsage,
} from "../model/model-stream.js";
import { APPROVAL_REVIEW_SYSTEM_PROMPT } from "../prompts/approval-review-prompt.js";
import type { SessionRecord } from "../session/schema.js";
import { hasOnlyKeys, isRecord } from "../tool/input-validation.js";
import type { ToolApprovalPlan } from "../tool/tool-runner.js";

export type ToolApprovalReviewResult = Readonly<{
  decision: "allow" | "needs_user" | "aborted";
  reason: string;
  authorizationEntryIds: readonly string[];
}>;

type ReviewToolApprovalOptions = Readonly<{
  modelStream: ModelStream;
  budget: ContextBudget;
  records: readonly SessionRecord[];
  workspaceRoot: string;
  toolCall: AssistantToolCallPart;
  approvalPlan: ToolApprovalPlan;
  abortSignal: AbortSignal;
  onUsage: (usage: ModelUsage | undefined) => Promise<void>;
}>;

type AuthorizationSource = Readonly<{
  entryId: string;
  seq: number;
  source: "user";
  content: string;
}>;

type AssistantContext = Readonly<{
  entryId: string;
  seq: number;
  source: "assistant";
  content: string;
}>;

const APPROVAL_INPUT_TOKEN_LIMIT = 8_000;
const APPROVAL_OUTPUT_TOKEN_LIMIT = 2_000;
const APPROVAL_OUTPUT_CHARACTER_LIMIT = 8_000;

/** 对固定准备动作最多发起一次审核；用量持久化失败必须交回 Run 停止处理。 */
export async function reviewToolApproval(
  options: ReviewToolApprovalOptions,
): Promise<ToolApprovalReviewResult> {
  if (options.abortSignal.aborted) {
    return abortedReview();
  }
  if (
    options.budget.modelMaxOutputTokens !== undefined &&
    options.budget.modelMaxOutputTokens < APPROVAL_OUTPUT_TOKEN_LIMIT
  ) {
    return needsUser("模型输出能力不足以完成 2,000 token 审核，请人工确认。");
  }
  const inputTokenLimit = Math.min(
    APPROVAL_INPUT_TOKEN_LIMIT,
    options.budget.contextWindow - 20_000 - APPROVAL_OUTPUT_TOKEN_LIMIT,
  );
  if (
    options.toolCall.invalid ||
    options.toolCall.toolName !== options.approvalPlan.toolName ||
    !/^[a-f0-9]{64}$/u.test(options.approvalPlan.actionFingerprint)
  ) {
    return needsUser("待审动作信息无效，无法自动审核，请人工确认。");
  }
  if (estimateModelRequestTokens(createReviewRequest(options, [])) > inputTokenLimit) {
    return needsUser("完整动作超过自动审核输入预算，请人工确认。");
  }

  // 历史人工批准只审计已绑定动作；其文件正文不能挤掉当前任务或更新限制。
  const authorizationSources: AuthorizationSource[] = [];
  for (const record of options.records) {
    if (record.type === "message" && record.message.type === "user") {
      authorizationSources.push({
        entryId: record.entryId,
        seq: record.seq,
        source: "user",
        content: record.message.content.map((part) => part.text).join(""),
      });
    }
  }
  if (authorizationSources.length === 0) {
    return needsUser("没有可完整核验的真实用户授权，请人工确认。");
  }
  const authorizationRequest = createReviewRequest(options, authorizationSources);
  // 不截断或挑选部分用户原文，否则可能丢失仍有效的任务或后续限制。
  if (estimateModelRequestTokens(authorizationRequest) > inputTokenLimit) {
    return needsUser(
      "全部真实用户原文与当前动作超过自动审核输入预算，无法完整核验任务及更新限制，请人工确认。",
    );
  }
  // 用户之前的 Assistant 文本只解释编号或指代，不能自行成为授权；当前动作的自述不混入。
  const lastUserSequence = authorizationSources.at(-1)?.seq ?? 0;
  const assistantContext: AssistantContext[] = [];
  for (const record of options.records) {
    if (
      record.seq >= lastUserSequence ||
      record.type !== "message" ||
      record.message.type !== "assistant"
    )
      continue;
    const content = record.message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (content.length > 0)
      assistantContext.push({
        entryId: record.entryId,
        seq: record.seq,
        source: "assistant",
        content,
      });
  }
  const modelRequest = createReviewRequest(options, authorizationSources, assistantContext);
  if (estimateModelRequestTokens(modelRequest) > inputTokenLimit) {
    return needsUser(
      "完整用户授权与指代上下文超过自动审核输入预算，不能裁剪方案后判断授权，请人工确认。",
    );
  }
  if (options.abortSignal.aborted) {
    return abortedReview();
  }

  let responseText = "";
  let finishReason: ModelFinishReason | null = null;
  let usage: ModelUsage | undefined;
  let invalidResponse = false;
  let responseTooLarge = false;
  let modelFailed = false;
  try {
    for await (const event of options.modelStream(modelRequest, options.abortSignal)) {
      if (options.abortSignal.aborted) {
        break;
      }
      if (event.type === "text_delta") {
        if (responseText.length + event.delta.length > APPROVAL_OUTPUT_CHARACTER_LIMIT) {
          responseTooLarge = true;
        } else if (!responseTooLarge) {
          responseText += event.delta;
        }
      } else if (
        event.type === "tool_call" ||
        event.type === "tool_input_start" ||
        event.type === "tool_input_delta"
      ) {
        invalidResponse = true;
      } else if (event.type === "finish") {
        finishReason = event.finishReason;
        usage = isModelUsage(event.usage) ? event.usage : undefined;
        break;
      }
      // 审核 Reasoning 既不积累，也不发布到主对话或事件。
    }
  } catch {
    modelFailed = true;
  }

  // 每个实际 attempt 恰好记一次；回调失败不能伪装为可继续执行的人工降级。
  await options.onUsage(usage);
  if (options.abortSignal.aborted) {
    return abortedReview();
  }
  if (modelFailed || finishReason === "error") {
    return needsUser("自动审核模型调用失败，请人工确认。");
  }
  if (finishReason === "length") {
    return needsUser("自动审核模型达到输出上限（output_limit），请人工确认。");
  }
  if (responseTooLarge || estimateTextTokens(responseText) > APPROVAL_OUTPUT_TOKEN_LIMIT) {
    return needsUser("自动审核结果超过输出预算，请人工确认。");
  }
  if (invalidResponse) {
    return needsUser("自动审核返回了不允许的工具调用，请人工确认。");
  }
  if (finishReason !== "stop") {
    return needsUser("自动审核模型未正常结束，请人工确认。");
  }
  if (usage === undefined) {
    return needsUser("自动审核缺少有效用量记录，请人工确认。");
  }
  return parseReviewResult(
    responseText,
    new Set(authorizationSources.map((source) => source.entryId)),
  );
}

function createReviewRequest(
  options: ReviewToolApprovalOptions,
  authorizationSources: readonly AuthorizationSource[],
  assistantContext: readonly AssistantContext[] = [],
): ModelRequest {
  return Object.freeze({
    purpose: "approval",
    maxOutputTokens: APPROVAL_OUTPUT_TOKEN_LIMIT,
    systemPrompt: APPROVAL_REVIEW_SYSTEM_PROMPT,
    tools: Object.freeze([]),
    messages: Object.freeze([
      Object.freeze({
        role: "user" as const,
        content: JSON.stringify({
          action: {
            toolCallId: options.toolCall.toolCallId,
            toolName: options.toolCall.toolName,
            input: options.toolCall.input,
            workspaceRoot: options.workspaceRoot,
            target: options.approvalPlan.target,
            preview: options.approvalPlan.preview,
            ruleId: options.approvalPlan.ruleId,
            riskSummary: options.approvalPlan.riskSummary,
            executionBoundary: options.approvalPlan.executionBoundary,
            actionFingerprint: options.approvalPlan.actionFingerprint,
          },
          authorizationSources,
          assistantContext,
        }),
      }),
    ]),
  });
}

function parseReviewResult(
  responseText: string,
  suppliedEntryIds: ReadonlySet<string>,
): ToolApprovalReviewResult {
  let response: unknown;
  try {
    response = JSON.parse(responseText);
  } catch {
    return needsUser("自动审核结果 JSON 解析失败，请人工确认。");
  }
  if (
    !isRecord(response) ||
    !hasOnlyKeys(response, ["decision", "reason", "authorizationEntryIds"]) ||
    (response.decision !== "allow" &&
      response.decision !== "needs_user" &&
      response.decision !== "deny") ||
    typeof response.reason !== "string" ||
    response.reason.trim().length === 0 ||
    Array.from(response.reason).length > 300 ||
    Array.from(response.reason).some((character) => {
      const characterCode = character.charCodeAt(0);
      return characterCode < 32 || (characterCode >= 127 && characterCode <= 159);
    }) ||
    !Array.isArray(response.authorizationEntryIds) ||
    response.authorizationEntryIds.some(
      (entryId) => typeof entryId !== "string" || !suppliedEntryIds.has(entryId),
    ) ||
    new Set(response.authorizationEntryIds).size !== response.authorizationEntryIds.length ||
    (response.decision === "allow" && response.authorizationEntryIds.length === 0)
  ) {
    return needsUser("自动审核结果或授权引用无效，请人工确认。");
  }
  return Object.freeze({
    decision: response.decision === "allow" ? "allow" : "needs_user",
    reason: response.reason.trim(),
    authorizationEntryIds: Object.freeze([...response.authorizationEntryIds]),
  });
}

function isModelUsage(value: unknown): value is ModelUsage {
  return (
    isRecord(value) &&
    ["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteInputTokens"].every(
      (field) =>
        value[field] === null ||
        (typeof value[field] === "number" &&
          Number.isSafeInteger(value[field]) &&
          value[field] >= 0),
    )
  );
}

function needsUser(reason: string): ToolApprovalReviewResult {
  return Object.freeze({
    decision: "needs_user",
    reason,
    authorizationEntryIds: Object.freeze([]),
  });
}

function abortedReview(): ToolApprovalReviewResult {
  return Object.freeze({
    decision: "aborted",
    reason: "自动审核已取消。",
    authorizationEntryIds: Object.freeze([]),
  });
}
