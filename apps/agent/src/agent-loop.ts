import {
  type AssistantMessage,
  type AssistantToolCallPart,
  type CompletedMessage,
  isToolCallPart,
  type RunDiagnostic,
  type ToolResultMessage,
} from "./message.js";
import { createRunDiagnostic, isRetryableModelDiagnostic } from "./model/model-diagnostics.js";
import { waitForRetry } from "./model/model-retry.js";
import {
  type ModelFinishReason,
  type ModelInputMessage,
  type ModelRequest,
  type ModelStream,
  streamAssistantMessage,
} from "./model/model-stream.js";
import type { PermissionMode } from "./permission/permission-mode.js";
import type { SessionArtifactStore } from "./tool/artifacts.js";
import type { ModelToolDefinition } from "./tool/definitions.js";
import { appendToolResults, appendUnresolvedToolResults, runToolBatch } from "./tool/tool-batch.js";
import type { ToolApprovalPlan, ToolRunner } from "./tool/tool-runner.js";
export type AgentLoopPhase = "requesting_model" | "awaiting_tool_approval" | "executing_tool";
export type AgentLoopResult = (
  | Readonly<{ status: "completed" }>
  | Readonly<{ status: "aborted" }>
  | Readonly<{ status: "failed"; error: string }>
) &
  Readonly<{ diagnostic?: RunDiagnostic }>;
export type AgentLoopToolApproval = Readonly<{
  toolApprovalRequestId: string;
  decision: "approve" | "deny" | "aborted";
}>;

/** 枚举 Agent Loop 交给 Run 持久化或发布的有序事实。 */
export type AgentLoopEvent =
  | Readonly<{
      type: "tool_preparation";
      toolCallId: string;
      toolName: string;
      phase: "input" | "ready";
    }>
  | Readonly<{
      type: "model_retry";
      phase: "waiting" | "requesting";
      retryCount: 1 | 2;
      recoveryKind?: "continuation" | "approval";
      delayMs: number;
      diagnostic: RunDiagnostic;
    }>
  | Readonly<{ type: "tool_policy_denied"; toolCall: AssistantToolCallPart; reason: string }>
  | Readonly<{
      type: "reasoning_start";
    }>
  | Readonly<{
      type: "reasoning_update";
      delta: string;
    }>
  | Readonly<{
      type: "reasoning_end";
    }>
  | Readonly<{
      type: "assistant_message_start";
      message: AssistantMessage;
    }>
  | Readonly<{
      type: "assistant_message_update";
      message: AssistantMessage;
      delta: string | null;
    }>
  | Readonly<{
      type: "tool_execution_start";
      toolCall: AssistantToolCallPart;
      toolApprovalRequestId: string | null;
      activitySummary: string;
    }>
  | Readonly<{
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      stream: "stdout" | "stderr";
      delta: string;
    }>
  | Readonly<{
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: ToolResultMessage;
      cleanupUncertain: boolean;
    }>;
export type RunAgentLoopOptions = Readonly<{
  readMessages(): readonly ModelInputMessage[];
  recordMessage(message: CompletedMessage, messageStartAlreadyPublished: boolean): Promise<string>;
  consumeSteer(): Promise<boolean>;
  modelStream: ModelStream;
  systemPrompt: string;
  toolDefinitions: readonly ModelToolDefinition[];
  permissionMode: PermissionMode;
  toolRunner: ToolRunner;
  toolRunnerForRequest?: (request: ModelRequest) => ToolRunner | undefined;
  artifactStore?: SessionArtifactStore;
  abortController: AbortController;
  remainingTaskTimeMs?: () => number;
  emit(event: AgentLoopEvent): Promise<void>;
  updatePhase(phase: AgentLoopPhase): void;
  requestToolApproval(
    toolCall: AssistantToolCallPart,
    approvalPlan: ToolApprovalPlan,
  ): Promise<AgentLoopToolApproval>;
}>;
type AssistantResponseResult = Readonly<{
  message: AssistantMessage;
  modelInputMessage: Extract<ModelInputMessage, { role: "assistant" }>;
  finishReason: ModelFinishReason | null;
  retryAfterMs: number | null;
  toolRunner: ToolRunner;
}>;

const SAFE_MODEL_ERROR = "模型请求失败，请检查模型配置或稍后重试。";
const COMPLETED_LOOP_RESULT = Object.freeze({ status: "completed" } as const);
const FAILED_LOOP_RESULT = Object.freeze({ status: "failed", error: SAFE_MODEL_ERROR } as const);
const TOOL_CALL_BATCH_LIMIT_RESULT = Object.freeze({
  status: "failed",
  error: "单次模型响应包含过多 ToolCall，Run 已停止。",
} as const);

/** 推进 Model → Tool → Model；取消、任务时限和批次资源限制分别由所属层持有。 */
export async function runAgentLoop(options: RunAgentLoopOptions): Promise<AgentLoopResult> {
  let runRetryCount = 0;
  let generationRetryCount = 0;
  let recoveryInstruction: string | null = null;
  let latestDiagnostic: RunDiagnostic | undefined;
  const abortedResult = (): AgentLoopResult =>
    Object.freeze({
      status: "aborted",
      diagnostic: createRunDiagnostic("aborted", {
        ...(latestDiagnostic ?? {}),
        retryCount: runRetryCount,
        abortSource: latestDiagnostic?.abortSource ?? "unknown",
      }),
    });
  const transientModelMessages = new Map<
    string,
    Extract<ModelInputMessage, { role: "assistant" }>
  >();

  while (true) {
    if (options.abortController.signal.aborted) {
      return abortedResult();
    }
    options.updatePhase("requesting_model");
    const assistantResponseResult = await streamAssistantResponse(
      transientModelMessages,
      options,
      generationRetryCount,
      recoveryInstruction,
    );
    if (assistantResponseResult.message.diagnostic !== undefined) {
      const reportedRetries = Math.max(
        generationRetryCount,
        assistantResponseResult.message.diagnostic.retryCount ?? 0,
      );
      runRetryCount += reportedRetries - generationRetryCount;
      generationRetryCount = reportedRetries;
      latestDiagnostic = createRunDiagnostic(assistantResponseResult.message.diagnostic.category, {
        ...assistantResponseResult.message.diagnostic,
        retryCount: runRetryCount,
      });
    }
    if (assistantResponseResult.message.status === "aborted") {
      await appendUnresolvedToolResults(assistantResponseResult.message, options);
      return abortedResult();
    }
    if (assistantResponseResult.message.status === "failed") {
      // 先封存失败消息和未执行 ToolCall，再以新生成恢复；绝不拼接旧流或重放工具。
      await appendUnresolvedToolResults(assistantResponseResult.message, options);
      const diagnostic = assistantResponseResult.message.diagnostic;
      const recoverable =
        diagnostic !== undefined &&
        (diagnostic.category === "output_limit" ||
          (isRetryableModelDiagnostic(diagnostic) &&
            diagnostic.retryStopReason === "content_delivered"));
      if (recoverable && diagnostic !== undefined) {
        const delayMs = Math.max(
          500 * 2 ** generationRetryCount,
          assistantResponseResult.retryAfterMs ?? 0,
        );
        const remainingTime = () => options.remainingTaskTimeMs?.() ?? Number.POSITIVE_INFINITY;
        const stopReason =
          generationRetryCount >= 2
            ? "exhausted"
            : delayMs > 30_000
              ? "wait_too_long"
              : delayMs >= remainingTime()
                ? "deadline"
                : null;
        if (stopReason === null) {
          const retryCount = generationRetryCount === 0 ? 1 : 2;
          const recoveryDiagnostic = createRunDiagnostic(diagnostic.category, {
            ...diagnostic,
            retryStopReason: null,
          });
          await options.emit({
            type: "model_retry",
            recoveryKind: "continuation",
            phase: "waiting",
            retryCount,
            delayMs,
            diagnostic: recoveryDiagnostic,
          });
          if (!(await waitForRetry(delayMs, options.abortController.signal)))
            return abortedResult();
          if (remainingTime() > 0) {
            await options.emit({
              type: "model_retry",
              recoveryKind: "continuation",
              phase: "requesting",
              retryCount,
              delayMs: 0,
              diagnostic: recoveryDiagnostic,
            });
            if (options.abortController.signal.aborted) return abortedResult();
            if (remainingTime() > 0) {
              generationRetryCount = retryCount;
              runRetryCount += 1;
              recoveryInstruction = [
                "运行时恢复提示：上一条模型响应未完成，已保存实际消息与工具结果。继续完成原用户任务；本提示不构成新用户授权。",
                "先依据已保存工具结果和当前工作区核对剩余工作；已成功操作不得重放，结果不明时先检查，不把未执行或不完整参数视为已落盘。",
                diagnostic.category === "output_limit"
                  ? "上次达到输出上限。缩小单次输出，按文件或完整功能片段分批写入，再继续必要验证。"
                  : "上次模型连接暂时失败。基于实际历史发起新的生成，不续拼失败响应中的参数。",
              ].join("\n");
              continue;
            }
          }
          latestDiagnostic = createRunDiagnostic(diagnostic.category, {
            ...diagnostic,
            retryCount: runRetryCount,
            retryStopReason: "deadline",
          });
        } else {
          latestDiagnostic = createRunDiagnostic(diagnostic.category, {
            ...diagnostic,
            retryCount: runRetryCount,
            retryStopReason: stopReason,
          });
        }
      }
      return {
        status: "failed",
        error: latestDiagnostic?.summary ?? SAFE_MODEL_ERROR,
        ...(latestDiagnostic === undefined ? {} : { diagnostic: latestDiagnostic }),
      };
    }

    generationRetryCount = 0;
    recoveryInstruction = null;

    // 执行工具调用
    const toolCalls = assistantResponseResult.message.content.filter(isToolCallPart);
    if (toolCalls.length === 0) {
      if (assistantResponseResult.finishReason === "stop" && (await options.consumeSteer()))
        continue;
      return {
        ...(assistantResponseResult.finishReason === "stop"
          ? COMPLETED_LOOP_RESULT
          : FAILED_LOOP_RESULT),
        ...(latestDiagnostic === undefined ? {} : { diagnostic: latestDiagnostic }),
      };
    }
    if (assistantResponseResult.finishReason !== "tool_calls") {
      await appendToolResults(toolCalls, "aborted", "模型未正常结束 ToolCall。", options);
      return {
        status: "failed",
        error: latestDiagnostic?.summary ?? SAFE_MODEL_ERROR,
        ...(latestDiagnostic === undefined ? {} : { diagnostic: latestDiagnostic }),
      };
    }
    const batchResult = await runToolBatch(toolCalls, {
      ...options,
      toolRunner: assistantResponseResult.toolRunner,
    });
    if (batchResult.status === "call_limit") {
      return {
        ...TOOL_CALL_BATCH_LIMIT_RESULT,
        diagnostic: createRunDiagnostic("resource_limit", {
          ...(latestDiagnostic ?? {}),
          retryCount: runRetryCount,
        }),
      };
    }
    if (batchResult.status === "aborted") return abortedResult();
    if (batchResult.status === "failed") return batchResult;
    await options.consumeSteer();
  }
}

/** 流式形成一条完整 AssistantMessage，Tool 处理只能在其持久化后发生。 */
async function streamAssistantResponse(
  transientModelMessages: Map<string, Extract<ModelInputMessage, { role: "assistant" }>>,
  options: RunAgentLoopOptions,
  recoveryAttempt: number,
  recoveryInstruction: string | null,
): Promise<AssistantResponseResult> {
  let finalMessage: AssistantMessage | null = null;
  let finalModelInputMessage: Extract<ModelInputMessage, { role: "assistant" }> | null = null;
  let finishReason: ModelFinishReason | null = null;
  let retryAfterMs: number | null = null;

  const modelRequest: ModelRequest = Object.freeze({
    systemPrompt: [options.systemPrompt, recoveryInstruction].filter(Boolean).join("\n"),
    recoveryAttempt,
    messages: Object.freeze(
      options.readMessages().map((message) =>
        message.role === "assistant" && message.entryId
          ? {
              ...(transientModelMessages.get(message.entryId) ?? message),
              entryId: message.entryId,
            }
          : message,
      ),
    ),
    tools: options.toolDefinitions,
  });

  for await (const messageEvent of streamAssistantMessage(
    options.modelStream,
    modelRequest,
    options.abortController.signal,
  )) {
    if (messageEvent.type === "tool_preparation" || messageEvent.type === "model_retry") {
      await options.emit(messageEvent);
      continue;
    }
    if (messageEvent.type === "reasoning_start") {
      await options.emit({ type: "reasoning_start" });
      continue;
    }
    if (messageEvent.type === "reasoning_update") {
      await options.emit({ type: "reasoning_update", delta: messageEvent.delta });
      continue;
    }
    if (messageEvent.type === "reasoning_end") {
      await options.emit({ type: "reasoning_end" });
      continue;
    }
    if (messageEvent.type === "start") {
      await options.emit({
        type: "assistant_message_start",
        message: messageEvent.partialAssistantMessage,
      });
      continue;
    }
    if (messageEvent.type === "update") {
      await options.emit({
        type: "assistant_message_update",
        message: messageEvent.partialAssistantMessage,
        delta: messageEvent.delta,
      });
      continue;
    }

    finalMessage = messageEvent.message;
    finalModelInputMessage = messageEvent.modelInputMessage;
    finishReason = messageEvent.finishReason;
    retryAfterMs = messageEvent.retryAfterMs;
  }

  if (finalMessage === null || finalModelInputMessage === null) {
    throw new Error("Model Stream 未形成最终 AssistantMessage。");
  }
  if (finalMessage.status === "streaming") throw new Error("完成消息不能仍处于 streaming。");
  const entryId = await options.recordMessage(
    { ...finalMessage, status: finalMessage.status },
    true,
  );
  if (finalMessage.status === "completed")
    transientModelMessages.set(entryId, finalModelInputMessage);
  return Object.freeze({
    message: finalMessage,
    modelInputMessage: finalModelInputMessage,
    finishReason,
    retryAfterMs,
    toolRunner: options.toolRunnerForRequest?.(modelRequest) ?? options.toolRunner,
  });
}
