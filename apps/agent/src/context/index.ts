import {
  type ModelRequest,
  ModelRequestError,
  type ModelStream,
  type ModelUsage,
} from "../model/model-stream.js";
import type { Session, SessionRunLease } from "../session/index.js";
import type { PersistedUsage, RequestUsageDetails } from "../session/schema.js";
import { type ContextBudget, estimateModelRequestTokens } from "./budget.js";
import { generateCompactionSummary } from "./compaction.js";
import {
  createContextVersion,
  createUsageAnchor,
  measureRequest,
  type UsageAnchor,
} from "./request.js";
import { createCompactionMessage, projectContextHistory, selectCompaction } from "./selection.js";

type RequestPurpose = RequestUsageDetails["purpose"];
export type RequestUsageTotals = Readonly<{
  requests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
}>;

/** 当前请求窗口与累计调用用量分别呈现，未知用量不会被计为零。 */
export type ContextUsage = Readonly<{
  externalTokens?: number;
  toolDefinitionTokens?: number;
  contextWindow: number;
  inputTokens: number | null;
  source: "estimated" | "calibrated" | "unknown";
  responseOutputTokens: number;
  summaryOutputTokens: number;
  compactions: number;
  requests: Readonly<Record<RequestPurpose, RequestUsageTotals>>;
}>;

export type ContextEvent =
  | Readonly<{ type: "context_usage"; usage: ContextUsage }>
  | Readonly<{ type: "compaction_start" }>
  | Readonly<{ type: "compaction_end"; inputTokensBefore: number; inputTokensAfter: number }>
  | Readonly<{ type: "compaction_failed"; error: string }>;

const UNKNOWN_USAGE: ModelUsage = Object.freeze({
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  cacheWriteInputTokens: null,
});
const CAPACITY_ERROR =
  "上下文空间不足，无法在保留最新请求和安全余量的前提下继续。请缩短输入或开启新对话。";
const COMPACTION_ERROR = "上下文压缩未成功，原始历史已保留；请重试或开启新对话。";

function emptyTotals(): RequestUsageTotals {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
  };
}
function addUsage(previous: RequestUsageTotals, usage: PersistedUsage): RequestUsageTotals {
  const sum = (left: number | null, right: number | null | undefined) =>
    left == null || right == null ? null : left + right;
  return Object.freeze({
    requests: previous.requests + 1,
    inputTokens: sum(previous.inputTokens, usage.inputTokens),
    outputTokens: sum(previous.outputTokens, usage.outputTokens),
    cachedInputTokens: sum(previous.cachedInputTokens, usage.cachedInputTokens),
    cacheWriteInputTokens: sum(previous.cacheWriteInputTokens, usage.cacheWriteInputTokens),
  });
}

/** Context 仅持有模型投影和预算；所有事实写入都复用当前 Run 的 lease。 */
export function createContextController(options: {
  session: Session;
  modelStream: ModelStream;
  modelId: string;
  budget: ContextBudget;
}) {
  const { session, modelStream, modelId, budget } = options;
  let usageAnchor: UsageAnchor | null = null;
  let inputTokens: number | null = null;
  let source: ContextUsage["source"] = "unknown";
  const totals: Record<RequestPurpose, RequestUsageTotals> = {
    response: emptyTotals(),
    compaction: emptyTotals(),
    approval: emptyTotals(),
  };
  for (const record of session.records ?? []) {
    if (record.type === "request_usage")
      totals[record.purpose] = addUsage(totals[record.purpose], record.usage);
  }
  let externalTokens = 0;
  let toolDefinitionTokens = 0;
  function snapshot(): ContextUsage {
    return Object.freeze({
      externalTokens,
      toolDefinitionTokens,
      contextWindow: budget.contextWindow,
      inputTokens,
      source,
      responseOutputTokens: budget.responseOutputTokens,
      summaryOutputTokens: budget.summaryOutputTokens,
      compactions: (session.records ?? []).filter((record) => record.type === "compaction").length,
      requests: Object.freeze({ ...totals }),
    });
  }

  function wrapRun(run: {
    lease: Pick<SessionRunLease, "appendCompaction" | "appendRequestUsage">;
    manual?: boolean;
    extendRequest?: (request: ModelRequest) => ModelRequest;
    emit: (event: ContextEvent) => void;
    onFailure: (error: string) => void;
    onStorageFailure: () => void;
  }) {
    async function recordUsage(
      purpose: RequestPurpose,
      requestEntryId: string | null,
      contextVersion: string,
      usage: ModelUsage | undefined,
    ) {
      const normalizedUsage = usage ?? UNKNOWN_USAGE;
      try {
        await run.lease.appendRequestUsage({
          purpose,
          requestEntryId,
          contextVersion,
          usage: normalizedUsage,
        });
      } catch {
        run.onStorageFailure();
        throw new Error("Session 用量写入失败。");
      }
      totals[purpose] = addUsage(totals[purpose], normalizedUsage);
      run.emit({ type: "context_usage", usage: snapshot() });
    }

    const requestWithContext: ModelStream = async function* (rawRequest, abortSignal) {
      const originalRequest = rawRequest;
      rawRequest = run.extendRequest?.(rawRequest) ?? rawRequest;
      externalTokens =
        estimateModelRequestTokens({ ...rawRequest, messages: [], tools: [] }) -
        estimateModelRequestTokens({ ...originalRequest, messages: [], tools: [] });
      toolDefinitionTokens =
        estimateModelRequestTokens({ ...rawRequest, messages: [], systemPrompt: "" }) -
        estimateModelRequestTokens({ ...rawRequest, messages: [], systemPrompt: "", tools: [] });
      let projection = projectContextHistory(session.records ?? [], rawRequest.messages);
      let request: ModelRequest = {
        ...rawRequest,
        messages: projection.messages,
        purpose: "response",
        maxOutputTokens: budget.responseOutputTokens,
      };
      let contextVersion = createContextVersion(
        modelId,
        budget,
        request,
        projection.checkpoint?.entryId ?? null,
      );
      const threshold =
        budget.contextWindow -
        budget.safetyTokens -
        Math.max(budget.responseOutputTokens, budget.summaryOutputTokens);
      const latestMessage = () =>
        (session.records ?? []).findLast((record) => record.type === "message");
      const requestEntryId = latestMessage()?.entryId ?? null;
      let compactionAttempted = false;

      function measure() {
        const measurement = measureRequest(request, contextVersion, usageAnchor);
        inputTokens = measurement.inputTokens;
        source = measurement.source;
        run.emit({ type: "context_usage", usage: snapshot() });
        return measurement;
      }

      async function compact(force: boolean) {
        if (abortSignal.aborted) throw new Error("cancelled");
        const checkpoint = projection.checkpoint;
        const latestRecord = latestMessage();
        const previousBoundary =
          checkpoint === null
            ? null
            : (session.records ?? []).findLast(
                (record) => record.type === "message" && record.seq < checkpoint.seq,
              );
        // 同一条消息前缀只尝试一次；时间戳相同不影响序号和身份判断。
        if (
          compactionAttempted ||
          (checkpoint !== null && previousBoundary?.entryId === latestRecord?.entryId)
        ) {
          throw new Error(CAPACITY_ERROR);
        }
        compactionAttempted = true;
        const before = inputTokens ?? estimateModelRequestTokens(request);
        const fixedTokens = estimateModelRequestTokens({ ...request, messages: [] });
        const retainedTarget = Math.max(
          0,
          Math.min(
            run.manual ? 0 : force ? Math.floor(budget.retainedTokens / 2) : budget.retainedTokens,
            threshold - fixedTokens - budget.summaryOutputTokens,
          ),
        );
        const latestUser = request.messages.findLast((message) => message.role === "user");
        if (
          latestUser !== undefined &&
          estimateModelRequestTokens({ ...request, messages: [latestUser] }) >= threshold
        )
          throw new Error(CAPACITY_ERROR);
        const selection = selectCompaction(projection, retainedTarget);
        if (selection === null) throw new Error(CAPACITY_ERROR);
        run.emit({ type: "compaction_start" });
        try {
          const summary = await generateCompactionSummary({
            groups: selection.summaryGroups,
            previousSummary: checkpoint?.summary ?? null,
            modelStream,
            budget,
            abortSignal,
            onUsage: (usage) => recordUsage("compaction", requestEntryId, contextVersion, usage),
          });
          if (abortSignal.aborted) throw new Error("cancelled");
          const candidate: ModelRequest = {
            ...request,
            messages: [
              createCompactionMessage(summary),
              ...selection.retainedEntries.map((entry) => entry.message),
            ],
          };
          const after = estimateModelRequestTokens(candidate);
          if (after >= threshold || after >= before) throw new Error(CAPACITY_ERROR);
          try {
            await run.lease.appendCompaction({
              summary,
              coversThroughEntryId: selection.coversThroughEntryId,
              firstKeptEntryId: selection.firstKeptEntryId,
              retainedUserEntryIds: selection.retainedUserEntryIds,
              usageBefore:
                measureRequest(request, contextVersion, usageAnchor).source === "calibrated"
                  ? (usageAnchor?.usage ?? UNKNOWN_USAGE)
                  : UNKNOWN_USAGE,
              inputTokenEstimateAfter: after,
              modelId,
              contextVersion,
            });
          } catch {
            run.onStorageFailure();
            throw new Error("Session 压缩写入失败。");
          }
          // 刷盘成功才切换投影。取消发生在提交期间也不允许发起下一次模型请求。
          projection = projectContextHistory(session.records, rawRequest.messages);
          request = { ...candidate, messages: projection.messages };
          contextVersion = createContextVersion(
            modelId,
            budget,
            request,
            projection.checkpoint?.entryId ?? null,
          );
          usageAnchor = null;
          inputTokens = after;
          source = "estimated";
          run.emit({ type: "compaction_end", inputTokensBefore: before, inputTokensAfter: after });
          run.emit({ type: "context_usage", usage: snapshot() });
        } catch {
          if (!abortSignal.aborted)
            run.emit({ type: "compaction_failed", error: COMPACTION_ERROR });
          throw new Error(COMPACTION_ERROR);
        }
      }

      try {
        if (run.manual) {
          measure();
          await compact(true);
          return;
        }
        if (measure().inputTokens >= threshold) await compact(false);
        let overflowRecoveryAttempted = false;
        for (;;) {
          if (abortSignal.aborted) return;
          if (measure().inputTokens >= threshold) throw new Error(CAPACITY_ERROR);
          let recorded = false;
          let emitted = false;
          try {
            for await (const event of modelStream(request, abortSignal)) {
              if (event.type === "finish") {
                recorded = true;
                await recordUsage("response", requestEntryId, contextVersion, event.usage);
                usageAnchor =
                  event.finishReason === "stop" || event.finishReason === "tool_calls"
                    ? createUsageAnchor(request, contextVersion, event.usage)
                    : null;
                if (usageAnchor !== null) {
                  inputTokens = usageAnchor.actualInputTokens;
                  source = "calibrated";
                  run.emit({ type: "context_usage", usage: snapshot() });
                }
              } else {
                emitted = true;
              }
              yield event;
            }
            if (!recorded) {
              recorded = true;
              await recordUsage("response", requestEntryId, contextVersion, undefined);
            }
            return;
          } catch (error) {
            if (!recorded) {
              recorded = true;
              await recordUsage("response", requestEntryId, contextVersion, undefined);
            }
            if (
              error instanceof ModelRequestError &&
              error.reason === "context_overflow" &&
              !overflowRecoveryAttempted &&
              !emitted &&
              !abortSignal.aborted
            ) {
              overflowRecoveryAttempted = true;
              await compact(true);
              continue;
            }
            throw error;
          } finally {
            // 消费者在 finish 后提前关闭 iterator 时也由当前 Run 收口调用事实。
            if (!recorded) await recordUsage("response", requestEntryId, contextVersion, undefined);
          }
        }
      } catch (error) {
        if (!abortSignal.aborted) {
          const safeError =
            error instanceof Error && error.message === CAPACITY_ERROR
              ? CAPACITY_ERROR
              : compactionAttempted
                ? COMPACTION_ERROR
                : "模型请求失败，请检查模型配置或稍后重试。";
          run.onFailure(safeError);
        }
        throw error;
      }
    };
    return Object.freeze({
      modelStream: requestWithContext,
      recordApprovalUsage: (usage: ModelUsage | undefined, actionFingerprint: string) =>
        recordUsage(
          "approval",
          session.records.findLast((record) => record.type === "message")?.entryId ?? null,
          "approval:" + modelId + ":" + actionFingerprint,
          usage,
        ),
    });
  }
  return Object.freeze({
    snapshot,
    wrapRun,
    async compact(
      request: ModelRequest,
      signal: AbortSignal,
      emit: (event: ContextEvent) => void,
      onStorageFailure: () => void,
    ) {
      const wrapper = wrapRun({
        lease: session,
        manual: true,
        emit,
        onFailure: () => undefined,
        onStorageFailure,
      });
      const iterator = wrapper.modelStream(request, signal);
      // 手动压缩只消费摘要，沿用事实写锁；不会生成普通回复或虚构用户消息。
      for await (const event of iterator) {
        void event;
      }
    },
  });
}
