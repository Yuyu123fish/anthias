import {
  type ContextBudget,
  estimateModelRequestTokens,
  estimateTextTokens,
} from "../context/budget.js";
import type { AssistantToolCallPart } from "../message.js";
import { isRetryableModelDiagnostic } from "../model/model-diagnostics.js";
import {
  type ModelFinishReason,
  type ModelRequest,
  ModelRequestError,
  type ModelStream,
  type ModelStreamEvent,
  type ModelUsage,
} from "../model/model-stream.js";
import { APPROVAL_REVIEW_SYSTEM_PROMPT } from "../prompts/approval-review-prompt.js";
import { type SessionRecord, userAuthorizationText } from "../session/schema.js";
import { hasOnlyKeys, isRecord } from "../tool/input-validation.js";
import type { ToolApprovalPlan } from "../tool/tool-runner.js";

export type ToolApprovalReviewResult = Readonly<{
  decision: "allow" | "needs_user" | "deny" | "aborted";
  reason: string;
  authorizationEntryIds: readonly string[];
}>;

type ReviewToolApprovalOptions = Readonly<{
  modelStream: ModelStream;
  budget: ContextBudget;
  records: readonly SessionRecord[];
  executionRecords: readonly SessionRecord[];
  runId: string;
  workspaceRoot: string;
  toolCall: AssistantToolCallPart;
  approvalPlan: ToolApprovalPlan;
  abortSignal: AbortSignal;
  onUsage: (usage: ModelUsage | undefined) => Promise<void>;
  onRetry?: (event: Extract<ModelStreamEvent, { type: "model_retry" }>) => void;
  remainingTaskTimeMs?: () => number;
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

/** 每个新动作独立核验授权；技术故障最多恢复一次，用量持久化失败立即停止 Run。 */
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
    throw new ModelRequestError("configuration", { retryCount: 0 });
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
    throw new ModelRequestError("invalid_request", { retryCount: 0 });
  }
  if (estimateModelRequestTokens(createReviewRequest(options, [])) > inputTokenLimit) {
    return needsUser("完整动作超过自动审核输入预算，请人工确认。");
  }

  // 历史人工批准只审计已绑定动作；其文件正文不能挤掉当前任务或更新限制。
  const authorizationSources: AuthorizationSource[] = [];
  for (const record of options.records) {
    const content = userAuthorizationText(record);
    if (content !== null) {
      authorizationSources.push({
        entryId: record.entryId,
        seq: record.seq,
        source: "user",
        content,
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
      record.message.role !== "assistant"
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

  let retryCount = 0;
  for (;;) {
    const attemptResult = await requestApprovalReview(options, modelRequest, authorizationSources);
    if ("decision" in attemptResult) return attemptResult;
    const { failure, retryable } = attemptResult;
    const delayMs = Math.max(500, failure.retryAfterMs ?? 0);
    const retryStopReason = !retryable
      ? null
      : retryCount >= 1
        ? "exhausted"
        : delayMs > 30_000
          ? "wait_too_long"
          : delayMs >= (options.remainingTaskTimeMs?.() ?? Number.POSITIVE_INFINITY)
            ? "deadline"
            : null;
    const requestFailure = new ModelRequestError(failure.diagnostic.category, {
      ...failure.diagnostic,
      retryAfterMs: failure.retryAfterMs,
      retryCount,
      retryStopReason,
    });
    if (!retryable || retryStopReason !== null) throw requestFailure;
    options.onRetry?.({
      type: "model_retry",
      phase: "waiting",
      retryCount: 1,
      delayMs,
      diagnostic: requestFailure.diagnostic,
    });
    if (!(await waitForReviewRetry(delayMs, options.abortSignal))) return abortedReview();
    if ((options.remainingTaskTimeMs?.() ?? Number.POSITIVE_INFINITY) <= 0)
      throw new ModelRequestError(failure.diagnostic.category, {
        ...failure.diagnostic,
        retryCount,
        retryStopReason: "deadline",
      });
    options.onRetry?.({
      type: "model_retry",
      phase: "requesting",
      retryCount: 1,
      delayMs: 0,
      diagnostic: new ModelRequestError(failure.diagnostic.category, {
        ...failure.diagnostic,
        retryCount: 1,
      }).diagnostic,
    });
    // 订阅者可同步取消；尚未进入下一次审核不能消耗用量或重新作出授权判断。
    if (options.abortSignal.aborted) return abortedReview();
    if ((options.remainingTaskTimeMs?.() ?? Number.POSITIVE_INFINITY) <= 0)
      throw new ModelRequestError(failure.diagnostic.category, {
        ...failure.diagnostic,
        retryCount,
        retryStopReason: "deadline",
      });
    retryCount = 1;
  }
}

async function requestApprovalReview(
  options: ReviewToolApprovalOptions,
  modelRequest: ModelRequest,
  authorizationSources: readonly AuthorizationSource[],
): Promise<
  ToolApprovalReviewResult | Readonly<{ failure: ModelRequestError; retryable: boolean }>
> {
  let responseText = "";
  let finishReason: ModelFinishReason | null = null;
  let usage: ModelUsage | undefined;
  let invalidResponse = false;
  let responseTooLarge = false;
  let modelFailure: ModelRequestError | null = null;
  try {
    for await (const event of options.modelStream(modelRequest, options.abortSignal)) {
      if (options.abortSignal.aborted) break;
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
  } catch (error) {
    modelFailure = error instanceof ModelRequestError ? error : new ModelRequestError("unknown");
  }

  // 每个实际 attempt 恰好记一次；持久化失败不能进入模型重试或人工降级。
  await options.onUsage(usage);
  if (options.abortSignal.aborted) return abortedReview();
  if (modelFailure !== null)
    return {
      failure: modelFailure,
      retryable: isRetryableModelDiagnostic(modelFailure.diagnostic),
    };
  if (finishReason === "error")
    return { failure: new ModelRequestError("service", { usage: usage ?? null }), retryable: true };
  if (
    finishReason === "length" ||
    responseTooLarge ||
    estimateTextTokens(responseText) > APPROVAL_OUTPUT_TOKEN_LIMIT
  )
    return {
      failure: new ModelRequestError("output_limit", {
        providerFinishReason: finishReason,
        usage: usage ?? null,
      }),
      retryable: true,
    };
  if (finishReason === "content_filter")
    return {
      failure: new ModelRequestError("content_filter", {
        providerFinishReason: finishReason,
        usage: usage ?? null,
      }),
      retryable: false,
    };
  if (invalidResponse || finishReason !== "stop" || usage === undefined)
    return {
      failure: new ModelRequestError("unknown", {
        providerFinishReason: finishReason,
        usage: usage ?? null,
      }),
      retryable: true,
    };
  try {
    return parseReviewResult(
      responseText,
      new Set(authorizationSources.map((source) => source.entryId)),
    );
  } catch {
    return {
      failure: new ModelRequestError("unknown", {
        providerFinishReason: finishReason,
        usage: usage ?? null,
      }),
      retryable: true,
    };
  }
}

/** 等待只持有一个计时器；同一 AbortSignal 取消等待后不会再请求审核模型。 */
function waitForReviewRetry(delayMs: number, abortSignal: AbortSignal): Promise<boolean> {
  if (abortSignal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (ready: boolean) => {
      clearTimeout(retryTimer);
      abortSignal.removeEventListener("abort", handleAbort);
      resolve(ready);
    };
    const handleAbort = () => finish(false);
    const retryTimer = setTimeout(() => finish(true), delayMs);
    abortSignal.addEventListener("abort", handleAbort, { once: true });
    if (abortSignal.aborted) handleAbort();
  });
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
          executionHistory: createActionExecutionHistory(options),
        }),
      }),
    ]),
  });
}

/** 只统计当前 Run 已刷新执行开始的同一动作；审批记录本身不代表已执行。 */
function createActionExecutionHistory(options: ReviewToolApprovalOptions) {
  const matchingApprovals = new Map(
    options.executionRecords.flatMap((record) =>
      record.type === "approval_decision" &&
      record.runId === options.runId &&
      record.decision === "allowed" &&
      record.actionFingerprint === options.approvalPlan.actionFingerprint &&
      record.toolApprovalRequestId !== undefined
        ? [[record.toolApprovalRequestId, record] as const]
        : [],
    ),
  );
  const startedExecutions = options.executionRecords.filter(
    (record) =>
      record.type === "tool_execution_started" &&
      record.runId === options.runId &&
      matchingApprovals.get(record.toolApprovalRequestId)?.toolCallId === record.toolCallId &&
      matchingApprovals.get(record.toolApprovalRequestId)?.toolName === record.toolName,
  );
  const latestExecution = startedExecutions.at(-1);
  if (latestExecution?.type !== "tool_execution_started")
    return { runId: options.runId, startedCount: 0, latestExecution: null };
  const latestResult = options.executionRecords.findLast(
    (record) =>
      record.type === "message" &&
      record.runId === options.runId &&
      record.seq > latestExecution.seq &&
      record.message.role === "tool" &&
      record.message.toolCallId === latestExecution.toolCallId,
  );
  const resultMessage =
    latestResult?.type === "message" && latestResult.message.role === "tool"
      ? latestResult.message
      : null;
  return {
    runId: options.runId,
    startedCount: startedExecutions.length,
    latestExecution: {
      toolCallId: latestExecution.toolCallId,
      startedEntryId: latestExecution.entryId,
      // 开始后缺少持久结果仍占一次；未知结果不能被解释成未执行或自动重做的授权。
      result:
        resultMessage === null
          ? null
          : {
              entryId: latestResult?.entryId,
              status: resultMessage.status,
              content: resultMessage.content.slice(0, 600),
              truncated: resultMessage.truncated || resultMessage.content.length > 600,
            },
    },
  };
}
function parseReviewResult(
  responseText: string,
  suppliedEntryIds: ReadonlySet<string>,
): ToolApprovalReviewResult {
  let response: unknown;
  try {
    response = JSON.parse(responseText);
  } catch {
    throw new ModelRequestError("unknown");
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
    throw new ModelRequestError("unknown");
  }
  return Object.freeze({
    decision: response.decision,
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
