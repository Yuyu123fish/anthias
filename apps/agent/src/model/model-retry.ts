import { createRunDiagnostic, isRetryableModelDiagnostic } from "./model-diagnostics.js";
import {
  type ModelRequest,
  ModelRequestError,
  type ModelStream,
  type ModelStreamEvent,
  type ModelUsage,
} from "./model-stream.js";

/** 同一普通生成及其有界压缩恢复共享尝试计数，压缩不会重置重试预算。 */
export type ModelRetryState = { retryCount: number; deliveredContent: boolean };

/** 只恢复尚未交付内容的普通生成；Tool、压缩和审核不经过此请求循环。 */
export async function* retryModelStream(options: {
  modelStream: ModelStream;
  request: ModelRequest;
  abortSignal: AbortSignal;
  state: ModelRetryState;
  remainingTaskTimeMs?: () => number;
  onAttemptFinished?: (usage: ModelUsage | undefined) => Promise<void>;
}): AsyncIterable<ModelStreamEvent> {
  const { modelStream, request: modelRequest, abortSignal, state: retryState } = options;
  for (;;) {
    if (abortSignal.aborted) return;
    let attemptUsageRecorded = false;
    const recordAttemptUsage = async (usage?: ModelUsage) => {
      if (attemptUsageRecorded) return;
      attemptUsageRecorded = true;
      await options.onAttemptFinished?.(usage);
    };
    try {
      for await (const event of modelStream(modelRequest, abortSignal)) {
        if (abortSignal.aborted) return;
        if (event.type === "finish") {
          await recordAttemptUsage(event.usage);
          yield Object.freeze({ ...event, retryCount: retryState.retryCount });
          return;
        }
        retryState.deliveredContent ||= isDeliveredContent(event);
        yield event;
      }
      return;
    } catch (error) {
      await recordAttemptUsage();
      if (abortSignal.aborted) return;
      const requestFailure =
        error instanceof ModelRequestError ? error : new ModelRequestError("unknown");
      const temporaryFailure = isRetryableModelDiagnostic(requestFailure.diagnostic);
      if (
        !temporaryFailure ||
        (modelRequest.purpose !== undefined && modelRequest.purpose !== "response")
      ) {
        throw new ModelRequestError(requestFailure.diagnostic.category, {
          ...requestFailure.diagnostic,
          retryAfterMs: requestFailure.retryAfterMs,
          retryCount: retryState.retryCount,
        });
      }
      let retryStopReason: "content_delivered" | "exhausted" | "wait_too_long" | "deadline" | null =
        null;
      const delayMs = Math.max(500 * 2 ** retryState.retryCount, requestFailure.retryAfterMs ?? 0);
      if (retryState.deliveredContent) retryStopReason = "content_delivered";
      else if (retryState.retryCount >= 2) retryStopReason = "exhausted";
      else if (delayMs > 30_000) retryStopReason = "wait_too_long";
      else if (delayMs >= (options.remainingTaskTimeMs?.() ?? Number.POSITIVE_INFINITY))
        retryStopReason = "deadline";
      if (retryStopReason !== null) {
        throw new ModelRequestError(requestFailure.diagnostic.category, {
          ...requestFailure.diagnostic,
          retryCount: retryState.retryCount,
          retryStopReason,
        });
      }
      const retryCount = retryState.retryCount === 0 ? 1 : 2;
      const diagnostic = createRunDiagnostic(requestFailure.diagnostic.category, {
        ...requestFailure.diagnostic,
        retryCount: retryState.retryCount,
      });
      yield Object.freeze({
        type: "model_retry",
        phase: "waiting",
        retryCount,
        delayMs,
        diagnostic,
      });
      if (!(await waitForRetry(delayMs, abortSignal))) return;
      if (abortSignal.aborted) return;
      if ((options.remainingTaskTimeMs?.() ?? Number.POSITIVE_INFINITY) <= 0) {
        throw new ModelRequestError(requestFailure.diagnostic.category, {
          ...requestFailure.diagnostic,
          retryCount: retryState.retryCount,
          retryStopReason: "deadline",
        });
      }
      const previousRetryCount = retryState.retryCount;
      retryState.retryCount = retryCount;
      yield Object.freeze({
        type: "model_retry",
        phase: "requesting",
        retryCount,
        delayMs: 0,
        diagnostic: createRunDiagnostic(requestFailure.diagnostic.category, {
          ...requestFailure.diagnostic,
          retryCount,
        }),
      });
      // 事件订阅者可能同步停止；尚未进入下一次 ModelStream 时不能计为已重试。
      if (abortSignal.aborted) {
        retryState.retryCount = previousRetryCount;
        throw new ModelRequestError("aborted", {
          retryCount: previousRetryCount,
          abortSource: "unknown",
        });
      }
      if ((options.remainingTaskTimeMs?.() ?? Number.POSITIVE_INFINITY) <= 0) {
        retryState.retryCount = previousRetryCount;
        throw new ModelRequestError(requestFailure.diagnostic.category, {
          ...requestFailure.diagnostic,
          retryCount: previousRetryCount,
          retryStopReason: "deadline",
        });
      }
    } finally {
      // 每个真实请求恰好记录一次已知或未知用量；等待取消不能虚增下一次调用。
      await recordAttemptUsage();
    }
  }
}

function isDeliveredContent(event: ModelStreamEvent): boolean {
  return (
    event.type === "tool_call" ||
    ((event.type === "text_delta" ||
      event.type === "reasoning_delta" ||
      event.type === "tool_input_delta") &&
      event.delta.length > 0)
  );
}

/** 取消释放计时器与监听器，并在发起下一次请求前再次检查同一 Signal。 */
function waitForRetry(delayMs: number, abortSignal: AbortSignal): Promise<boolean> {
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
