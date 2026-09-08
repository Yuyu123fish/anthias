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
  const { modelStream, request, abortSignal, state } = options;
  for (;;) {
    if (abortSignal.aborted) return;
    let recorded = false;
    const recordAttempt = async (usage?: ModelUsage) => {
      if (recorded) return;
      recorded = true;
      await options.onAttemptFinished?.(usage);
    };
    try {
      for await (const event of modelStream(request, abortSignal)) {
        if (abortSignal.aborted) return;
        if (event.type === "finish") {
          await recordAttempt(event.usage);
          yield Object.freeze({ ...event, retryCount: state.retryCount });
          return;
        }
        state.deliveredContent ||= isDeliveredContent(event);
        yield event;
      }
      return;
    } catch (error) {
      await recordAttempt();
      if (abortSignal.aborted) return;
      const failure = error instanceof ModelRequestError ? error : new ModelRequestError("unknown");
      const temporaryFailure = isRetryableModelDiagnostic(failure.diagnostic);
      if (!temporaryFailure || (request.purpose !== undefined && request.purpose !== "response")) {
        throw new ModelRequestError(failure.diagnostic.category, {
          ...failure.diagnostic,
          retryAfterMs: failure.retryAfterMs,
          retryCount: state.retryCount,
        });
      }
      let retryStopReason: "content_delivered" | "exhausted" | "wait_too_long" | "deadline" | null =
        null;
      const delayMs = Math.max(500 * 2 ** state.retryCount, failure.retryAfterMs ?? 0);
      if (state.deliveredContent) retryStopReason = "content_delivered";
      else if (state.retryCount >= 2) retryStopReason = "exhausted";
      else if (delayMs > 30_000) retryStopReason = "wait_too_long";
      else if (delayMs >= (options.remainingTaskTimeMs?.() ?? Number.POSITIVE_INFINITY))
        retryStopReason = "deadline";
      if (retryStopReason !== null) {
        throw new ModelRequestError(failure.diagnostic.category, {
          ...failure.diagnostic,
          retryCount: state.retryCount,
          retryStopReason,
        });
      }
      const retryCount = state.retryCount === 0 ? 1 : 2;
      const diagnostic = createRunDiagnostic(failure.diagnostic.category, {
        ...failure.diagnostic,
        retryCount: state.retryCount,
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
        throw new ModelRequestError(failure.diagnostic.category, {
          ...failure.diagnostic,
          retryCount: state.retryCount,
          retryStopReason: "deadline",
        });
      }
      const previousRetryCount = state.retryCount;
      state.retryCount = retryCount;
      yield Object.freeze({
        type: "model_retry",
        phase: "requesting",
        retryCount,
        delayMs: 0,
        diagnostic: createRunDiagnostic(failure.diagnostic.category, {
          ...failure.diagnostic,
          retryCount,
        }),
      });
      // 事件订阅者可能同步停止；尚未进入下一次 ModelStream 时不能计为已重试。
      if (abortSignal.aborted) {
        state.retryCount = previousRetryCount;
        throw new ModelRequestError("aborted", {
          retryCount: previousRetryCount,
          abortSource: "unknown",
        });
      }
      if ((options.remainingTaskTimeMs?.() ?? Number.POSITIVE_INFINITY) <= 0) {
        state.retryCount = previousRetryCount;
        throw new ModelRequestError(failure.diagnostic.category, {
          ...failure.diagnostic,
          retryCount: previousRetryCount,
          retryStopReason: "deadline",
        });
      }
    } finally {
      // 每个真实请求恰好记录一次已知或未知用量；等待取消不能虚增下一次调用。
      await recordAttempt();
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
