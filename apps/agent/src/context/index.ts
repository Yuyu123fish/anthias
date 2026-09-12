import type { RequestConfiguration } from "../message.js";
import { retryModelStream } from "../model/model-retry.js";
import {
  type ModelRequest,
  ModelRequestError,
  type ModelStream,
  type ModelUsage,
} from "../model/model-stream.js";
import type { Session } from "../session/index.js";
import {
  isValidCompactionRecord,
  type PersistedUsage,
  type RequestUsageDetails,
} from "../session/schema.js";
import { type ContextBudget, estimateModelRequestTokens } from "./budget.js";
import { generateCompactionSummary } from "./compaction.js";
import { projectCompactionContext, projectContextHistory, snapshotSources } from "./projection.js";
import {
  createContextVersion,
  createUsageAnchor,
  measureRequest,
  type UsageAnchor,
} from "./request.js";
import { selectCompaction } from "./selection.js";
import { type ContextSources, MEMORY_REVOKED_ERROR } from "./sources.js";

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

/** Context 仅持有模型投影和预算；所有事实写入都经 Session 的串行提交。 */
export function createContextController(options: {
  session: Session;
  requestConfiguration?: (purpose: RequestPurpose) => RequestConfiguration | undefined;
  modelStream: ModelStream;
  modelId: string;
  budget: ContextBudget;
  sources?: ContextSources;
}) {
  const { session, modelStream, modelId, budget, sources } = options;
  const contextRecords = () => sources?.safeRecords() ?? session.records;
  const projectHistory = (
    messages: readonly import("../model/model-stream.js").ModelInputMessage[],
  ) => {
    const records = contextRecords();
    return projectContextHistory(records, messages, sources !== undefined, {
      latestCompactionEntryId: session.header.latestCompactionEntryId,
      getEntry: session.getEntry,
    });
  };
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
    runId: string | null;
    manual?: boolean;
    extendRequest?: (request: ModelRequest, requestIdentity: ModelRequest) => ModelRequest;
    beforeRequest?: (signal: AbortSignal) => Promise<void>;
    remainingTaskTimeMs?: () => number;
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
      const configuration = options.requestConfiguration?.(purpose);
      try {
        await session.appendRequestUsage(run.runId, {
          purpose,
          ...(configuration ? { configuration } : {}),
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

    const contextAwareModelStream: ModelStream = async function* (rawRequest, abortSignal) {
      const requestIdentity = rawRequest;
      const recoveryAttempt = rawRequest.recoveryAttempt ?? 0;
      const { recoveryAttempt: _recoveryAttempt, ...providerRequest } = rawRequest;
      rawRequest = providerRequest;
      await run.beforeRequest?.(abortSignal);
      const originalRequest = rawRequest;
      rawRequest = run.extendRequest?.(rawRequest, requestIdentity) ?? rawRequest;

      toolDefinitionTokens =
        estimateModelRequestTokens({ ...rawRequest, messages: [], systemPrompt: "" }) -
        estimateModelRequestTokens({ ...rawRequest, messages: [], systemPrompt: "", tools: [] });
      let projection = projectHistory(rawRequest.messages);
      let request: ModelRequest = {
        ...rawRequest,
        messages: projection.messages,
        tools: [...rawRequest.tools].sort((left, right) => left.name.localeCompare(right.name)),
        purpose: "response",
        maxOutputTokens: budget.responseOutputTokens,
      };
      externalTokens = Math.max(
        0,
        estimateModelRequestTokens({ ...request, tools: [] }) -
          estimateModelRequestTokens({
            ...originalRequest,
            messages: projection.historyMessages,
            tools: [],
          }),
      );
      sources?.markRequest();
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
        (session.records ?? []).findLast(
          (record) => record.type === "message" || record.type === "agent_input",
        );
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
        // 冻结上下文
        const fixedRecords = contextRecords();
        const fixedSourceSnapshot = sources ? snapshotSources(fixedRecords, []) : undefined;
        const fixedMessages = projectCompactionContext(
          fixedRecords,
          [],
          null,
          fixedSourceSnapshot,
        ).messages;
        const fixedTokens = estimateModelRequestTokens({ ...request, messages: fixedMessages });
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
          await sources?.checkExecution(abortSignal);
          await sources?.prepare(abortSignal);
          const candidateRecords = contextRecords();
          const sourceSnapshot = sources
            ? snapshotSources(
                candidateRecords,
                selection.retainedEntries.map((entry) => entry.entryId),
              )
            : undefined;
          // 摘要期间来源换版时，不能用新来源快照替旧摘要背书。
          if (
            fixedSourceSnapshot &&
            JSON.stringify(fixedSourceSnapshot.sourceVersions) !==
              JSON.stringify(sourceSnapshot?.sourceVersions)
          )
            throw new Error(COMPACTION_ERROR);
          if (
            !isValidCompactionRecord(
              {
                ...(sourceSnapshot ? { projection: sourceSnapshot } : {}),
                coversThroughEntryId: selection.coversThroughEntryId,
                firstKeptEntryId: selection.firstKeptEntryId,
                retainedUserEntryIds: selection.retainedUserEntryIds,
              },
              new Map(candidateRecords.map((record) => [record.entryId, record])),
            )
          )
            throw new Error(COMPACTION_ERROR);
          const candidateProjection = projectCompactionContext(
            candidateRecords,
            selection.retainedEntries,
            summary,
            sourceSnapshot,
          );
          const candidate: ModelRequest = {
            ...request,
            messages: candidateProjection.messages,
          };
          const after = estimateModelRequestTokens(candidate);
          if (after >= threshold || after >= before) throw new Error(CAPACITY_ERROR);
          try {
            await session.appendCompaction(run.runId, {
              summary,
              ...(sourceSnapshot ? { projection: sourceSnapshot } : {}),
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
          projection = projectHistory(rawRequest.messages);
          request = { ...candidate, messages: projection.messages };
          sources?.markRequest();
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
        const retryState = { retryCount: recoveryAttempt, deliveredContent: false };
        for (;;) {
          if (abortSignal.aborted) return;
          if (measure().inputTokens >= threshold) throw new Error(CAPACITY_ERROR);
          let emitted = false;
          try {
            for await (const event of retryModelStream({
              modelStream,
              request,
              abortSignal,
              state: retryState,
              ...(run.remainingTaskTimeMs === undefined
                ? {}
                : { remainingTaskTimeMs: run.remainingTaskTimeMs }),
              onAttemptFinished: (usage) =>
                recordUsage("response", requestEntryId, contextVersion, usage),
            })) {
              if (event.type === "finish") {
                await sources?.checkExecution(abortSignal);
                usageAnchor =
                  event.finishReason === "stop" || event.finishReason === "tool_calls"
                    ? createUsageAnchor(request, contextVersion, event.usage)
                    : null;
                if (usageAnchor !== null) {
                  inputTokens = usageAnchor.actualInputTokens;
                  source = "calibrated";
                  run.emit({ type: "context_usage", usage: snapshot() });
                }
              } else if (
                event.type === "tool_call" ||
                ((event.type === "text_delta" ||
                  event.type === "reasoning_delta" ||
                  event.type === "tool_input_delta") &&
                  event.delta.length > 0)
              ) {
                emitted = true;
              }
              yield event;
            }
            return;
          } catch (error) {
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
          }
        }
      } catch (error) {
        if (error instanceof ModelRequestError) throw error;
        if (!abortSignal.aborted) {
          const safeError =
            error instanceof Error &&
            (error.message === CAPACITY_ERROR || error.message === MEMORY_REVOKED_ERROR)
              ? error.message
              : compactionAttempted
                ? COMPACTION_ERROR
                : "模型请求失败，请检查模型配置或稍后重试。";
          run.onFailure(safeError);
        }
        if (error instanceof Error && error.message === CAPACITY_ERROR) {
          throw new ModelRequestError("context_overflow", { retryCount: null });
        }
        throw error;
      }
    };
    return Object.freeze({
      modelStream: contextAwareModelStream,
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
    projectMessages(
      messages: readonly import("../model/model-stream.js").ModelInputMessage[] = [],
    ) {
      return projectHistory(messages).messages;
    },
    async compact(
      request: ModelRequest,
      signal: AbortSignal,
      emit: (event: ContextEvent) => void,
      onStorageFailure: () => void,
    ) {
      const wrapper = wrapRun({
        runId: null,
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
