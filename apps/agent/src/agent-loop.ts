import {
  boundTextToTokenBudget,
  estimateTextTokens,
  TOOL_RESULT_BATCH_TOKEN_LIMIT,
  TOOL_RESULT_TOKEN_LIMIT,
} from "./context/budget.js";
import {
  type AssistantMessage,
  type AssistantToolCallPart,
  isToolCallPart,
  type Message,
  type RunDiagnostic,
  type ToolArtifactReference,
  type ToolResultMessage,
} from "./message.js";
import { createRunDiagnostic, isRetryableModelDiagnostic } from "./model/model-diagnostics.js";
import { waitForRetry } from "./model/model-retry.js";
import {
  type ModelFinishReason,
  type ModelInputMessage,
  type ModelRequest,
  ModelRequestError,
  type ModelStream,
  streamAssistantMessage,
  toModelInputMessage,
} from "./model/model-stream.js";
import type { PermissionMode } from "./permission/permission-mode.js";
import type { SessionArtifactStore } from "./session/artifacts.js";
import type { ModelToolDefinition } from "./tool/definitions.js";
import { finalizeToolResult } from "./tool/tool-result.js";
import type {
  PreparedToolExecution,
  ToolApprovalPlan,
  ToolCallPlan,
  ToolRunner,
} from "./tool/tool-runner.js";
import { selectConcurrentToolBatch } from "./tool/tool-scheduling.js";

/** 枚举 Agent Loop 当前正在推进的活动阶段。 */
export type AgentLoopPhase = "requesting_model" | "awaiting_tool_approval" | "executing_tool";

/** 枚举 Agent Loop 停止迭代时可以交给 Run 的结果。 */
export type AgentLoopResult = (
  | Readonly<{ status: "completed" }>
  | Readonly<{ status: "aborted" }>
  | Readonly<{ status: "failed"; error: string }>
) &
  Readonly<{ diagnostic?: RunDiagnostic }>;

/** 表示 Agent Loop 等到的一次确认标识及最终决定。 */
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
      type: "assistant_message_end";
      message: AssistantMessage;
    }>
  | Readonly<{
      type: "tool_result";
      message: ToolResultMessage;
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

/** 配置一次纯 Agent Loop 所需的上下文、能力与 Run 回调。 */
export type RunAgentLoopOptions = Readonly<{
  messages: readonly Message[];
  messageEntryId?: (message: Message) => string | undefined;
  modelStream: ModelStream;
  systemPrompt: string;
  toolDefinitions: readonly ModelToolDefinition[];
  permissionMode: PermissionMode;
  toolRunner: ToolRunner;
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

/** 表示一次模型请求形成的 AssistantMessage 与完成原因。 */
type AssistantResponseResult = Readonly<{
  message: AssistantMessage;
  modelInputMessage: Extract<ModelInputMessage, { role: "assistant" }>;
  finishReason: ModelFinishReason | null;
  retryAfterMs: number | null;
}>;

/** 保存批次中一个 ToolCall 的源位置和一次性执行计划。 */
type PlannedToolCall = Readonly<{
  sourceIndex: number;
  toolCall: AssistantToolCallPart;
  plan: ToolCallPlan;
}>;

/** 表示 Tool 预检已返回、失败，或因 Run 停止而不再等待。 */
type ToolPreparationWaitResult =
  | Readonly<{ status: "prepared"; preparation: Awaited<ReturnType<ToolCallPlan["prepare"]>> }>
  | Readonly<{ status: "failed" }>
  | Readonly<{ status: "aborted" }>;

/** 协调并发调用按源顺序发布 execution start。 */
type SourceOrderStartGate = Readonly<{
  waitForTurn(sourceIndex: number): Promise<void>;
  completeTurn(sourceIndex: number): void;
}>;

/** 保存同一条 Assistant ToolCall 回复尚未消耗的结果预算。 */
type ToolResultBudget = {
  tokenBudgetPerResult: number;
  remainingTokens: number;
};

const SAFE_MODEL_ERROR = "模型请求失败，请检查模型配置或稍后重试。";
const TOOL_CALL_BATCH_LIMIT = 32;
const TOOL_CONCURRENCY_LIMIT = 4;
const COMPLETED_LOOP_RESULT = Object.freeze({ status: "completed" } as const);
const FAILED_LOOP_RESULT = Object.freeze({ status: "failed", error: SAFE_MODEL_ERROR } as const);
const TOOL_CALL_BATCH_LIMIT_RESULT = Object.freeze({
  status: "failed",
  error: "单次模型响应包含过多 ToolCall，Run 已停止。",
} as const);

/** 推进 Model → Tool → Model；取消、任务时限和批次资源限制分别由所属层持有。 */
export async function runAgentLoop(options: RunAgentLoopOptions): Promise<AgentLoopResult> {
  const messageHistory = [...options.messages];
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
    AssistantMessage,
    Extract<ModelInputMessage, { role: "assistant" }>
  >();

  while (true) {
    if (options.abortController.signal.aborted) {
      return abortedResult();
    }
    options.updatePhase("requesting_model");
    const assistantResponseResult = await streamAssistantResponse(
      messageHistory,
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
      await appendUnresolvedToolResults(assistantResponseResult.message, messageHistory, options);
      return abortedResult();
    }
    if (assistantResponseResult.message.status === "failed") {
      // 先封存失败消息和未执行 ToolCall，再以新生成恢复；绝不拼接旧流或重放工具。
      await appendUnresolvedToolResults(assistantResponseResult.message, messageHistory, options);
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

    // 获取 ToolCall 列表
    const toolCalls = assistantResponseResult.message.content.filter(isToolCallPart);
    if (toolCalls.length === 0) {
      return {
        ...(assistantResponseResult.finishReason === "stop"
          ? COMPLETED_LOOP_RESULT
          : FAILED_LOOP_RESULT),
        ...(latestDiagnostic === undefined ? {} : { diagnostic: latestDiagnostic }),
      };
    }
    if (assistantResponseResult.finishReason !== "tool_calls") {
      await appendToolResults(
        toolCalls,
        "aborted",
        "模型未正常结束 ToolCall。",
        messageHistory,
        options,
      );
      return {
        status: "failed",
        error: latestDiagnostic?.summary ?? SAFE_MODEL_ERROR,
        ...(latestDiagnostic === undefined ? {} : { diagnostic: latestDiagnostic }),
      };
    }
    if (toolCalls.length > TOOL_CALL_BATCH_LIMIT) {
      await appendToolResults(
        toolCalls,
        "failed",
        "单次模型响应包含过多 ToolCall，调用未执行。",
        messageHistory,
        options,
      );
      return {
        ...TOOL_CALL_BATCH_LIMIT_RESULT,
        diagnostic: createRunDiagnostic("resource_limit", {
          ...(latestDiagnostic ?? {}),
          retryCount: runRetryCount,
        }),
      };
    }

    const plannedToolCalls = toolCalls.map((toolCall, sourceIndex) =>
      Object.freeze({
        sourceIndex,
        toolCall,
        plan: options.toolRunner.createPlan(toolCall, options.permissionMode),
      }),
    );

    const toolResultBudget = createToolResultBudget(plannedToolCalls.length);
    for (let offset = 0; offset < plannedToolCalls.length; ) {
      const selectedPlans = selectConcurrentToolBatch(
        plannedToolCalls.map(({ plan }) => plan),
        offset,
      );
      const batch = plannedToolCalls
        .slice(offset, offset + selectedPlans.length)
        .map((plannedToolCall, sourceIndex) => ({ ...plannedToolCall, sourceIndex }));
      const toolBatchResult = await executeConcurrentToolBatch(
        batch,
        options,
        toolResultBudget.tokenBudgetPerResult,
      );
      for (const toolResult of toolBatchResult.toolResults) {
        await appendToolResultMessage(
          boundToolResultForBudget(toolResult, toolResultBudget),
          messageHistory,
          options,
        );
      }
      offset += batch.length;
      if (toolBatchResult.approvalFailure !== null) {
        await appendToolResults(
          plannedToolCalls.slice(offset).map(({ toolCall }) => toolCall),
          "aborted",
          "自动审核技术故障，后续调用未执行。",
          messageHistory,
          options,
          toolResultBudget,
        );
        return {
          status: "failed",
          error: "自动审核技术故障：" + toolBatchResult.approvalFailure.diagnostic.summary,
          diagnostic: toolBatchResult.approvalFailure.diagnostic,
        };
      }
      if (options.abortController.signal.aborted) {
        await appendToolResults(
          plannedToolCalls.slice(offset).map(({ toolCall }) => toolCall),
          "aborted",
          "Run 已停止，调用未执行。",
          messageHistory,
          options,
          toolResultBudget,
        );
        return abortedResult();
      }
    }
  }
}

/** 流式形成一条完整 AssistantMessage，Tool 处理只能在其持久化后发生。 */
async function streamAssistantResponse(
  messageHistory: Message[],
  transientModelMessages: Map<AssistantMessage, Extract<ModelInputMessage, { role: "assistant" }>>,
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
      messageHistory.map((message) => {
        const modelMessage =
          message.role === "assistant"
            ? (transientModelMessages.get(message) ?? toModelInputMessage(message))
            : toModelInputMessage(message);
        const entryId = options.messageEntryId?.(message);
        return entryId ? { ...modelMessage, entryId } : modelMessage;
      }),
    ),
    tools: options.toolDefinitions,
  });

  // 异步遍历可迭代模型响应
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
  await options.emit({ type: "assistant_message_end", message: finalMessage });
  if (finalMessage.status === "completed")
    transientModelMessages.set(finalMessage, finalModelInputMessage);
  messageHistory.push(finalMessage);
  return Object.freeze({
    message: finalMessage,
    modelInputMessage: finalModelInputMessage,
    finishReason,
    retryAfterMs,
  });
}

/** 按源索引保存并发结果，并为未领取调用补齐 aborted 消息。 */
async function executeConcurrentToolBatch(
  plannedToolCalls: readonly PlannedToolCall[],
  options: RunAgentLoopOptions,
  resultTokenBudget: number,
): Promise<
  Readonly<{
    toolResults: readonly ToolResultMessage[];
    approvalFailure: ModelRequestError | null;
  }>
> {
  const toolResultMessages: Array<ToolResultMessage | undefined> = Array.from({
    length: plannedToolCalls.length,
  });
  const startGate = createSourceOrderStartGate(plannedToolCalls.length);
  let nextSourceIndex = 0;

  /** 单个 worker 每次只领取下一个递增索引，abort 后不再领取。 */
  async function runWorker(): Promise<void> {
    while (!options.abortController.signal.aborted) {
      const sourceIndex = nextSourceIndex;
      if (sourceIndex >= plannedToolCalls.length) {
        return;
      }
      nextSourceIndex += 1;
      const plannedToolCall = plannedToolCalls[sourceIndex];
      if (plannedToolCall === undefined) {
        throw new Error("ToolCall 并发队列状态缺失。");
      }

      try {
        toolResultMessages[sourceIndex] = await formToolResultMessage(
          plannedToolCall,
          options,
          startGate,
          resultTokenBudget,
        );
      } catch (error) {
        options.abortController.abort();
        await skipExecutionStart(sourceIndex, startGate);
        throw error;
      }
    }
  }

  const workerCount = Math.min(TOOL_CONCURRENCY_LIMIT, plannedToolCalls.length);
  // 持久化或事件失败时先取消并收齐其他 worker，不能让副作用逃出 Run 生命周期。
  const workerResults = await Promise.allSettled(
    Array.from({ length: workerCount }, () => runWorker()),
  );
  // 审核技术故障仍须保存其他 worker 的真实结果；存储失败优先向外传播。
  const rejectedWorkers = workerResults.filter((result) => result.status === "rejected");
  const unexpectedFailure = rejectedWorkers.find(
    (result) => !(result.reason instanceof ModelRequestError),
  );
  if (unexpectedFailure !== undefined) throw unexpectedFailure.reason;
  const approvalFailure = rejectedWorkers[0]?.reason;
  if (approvalFailure !== undefined && !(approvalFailure instanceof ModelRequestError))
    throw approvalFailure;
  for (const plannedToolCall of plannedToolCalls) {
    toolResultMessages[plannedToolCall.sourceIndex] ??= createAbortedToolResultMessage(
      plannedToolCall.toolCall,
      "Run 已停止，调用未执行。",
    );
  }
  return Object.freeze({
    approvalFailure: approvalFailure ?? null,
    toolResults: Object.freeze(
      toolResultMessages.map((toolResultMessage) => {
        if (toolResultMessage === undefined) throw new Error("ToolCall 结果缺失。");
        return toolResultMessage;
      }),
    ),
  });
}

/** 通过统一 Tool Module 预检、确认并形成一条尚未提交的结果消息。 */
async function formToolResultMessage(
  plannedToolCall: PlannedToolCall,
  options: RunAgentLoopOptions,
  startGate: SourceOrderStartGate,
  resultTokenBudget: number,
): Promise<ToolResultMessage> {
  const { plan, toolCall } = plannedToolCall;
  const preparationWaitResult = await waitForPreparationOrAbort(
    plan,
    options.abortController.signal,
  );
  if (preparationWaitResult.status === "aborted") {
    await skipExecutionStart(plannedToolCall.sourceIndex, startGate);
    return createAbortedToolResultMessage(toolCall, plan.abortedPreparationContent);
  }
  if (preparationWaitResult.status === "failed") {
    await skipExecutionStart(plannedToolCall.sourceIndex, startGate);
    return createToolResultMessage(toolCall, {
      status: "failed",
      content: "Tool 预检失败。",
      truncated: false,
    });
  }
  const { preparation } = preparationWaitResult;
  if (options.abortController.signal.aborted) {
    await skipExecutionStart(plannedToolCall.sourceIndex, startGate);
    return createAbortedToolResultMessage(toolCall, plan.abortedPreparationContent);
  }

  if (!preparation.ok) {
    await skipExecutionStart(plannedToolCall.sourceIndex, startGate);
    if (preparation.result.status === "denied")
      await options.emit({
        type: "tool_policy_denied",
        toolCall,
        reason: preparation.result.content,
      });
    return createToolResultMessage(toolCall, preparation.result);
  }
  return executePreparedToolCall(
    plannedToolCall,
    preparation.preparedExecution,
    options,
    startGate,
    resultTokenBudget,
  );
}

/** 协调一个已预检 Tool 的确认、执行和事件，结果由调用方串行提交。 */
async function executePreparedToolCall(
  plannedToolCall: PlannedToolCall,
  preparedExecution: PreparedToolExecution,
  options: RunAgentLoopOptions,
  startGate: SourceOrderStartGate,
  resultTokenBudget: number,
): Promise<ToolResultMessage> {
  const { toolCall, sourceIndex } = plannedToolCall;
  let toolApprovalRequestId: string | null = null;
  const approvalPlan = preparedExecution.approval;
  if (approvalPlan !== null) {
    await startGate.waitForTurn(sourceIndex);
    // 需要人工确认的 ToolCall，切换到等待人工确认阶段
    options.updatePhase("awaiting_tool_approval");
    const approval = await options.requestToolApproval(toolCall, approvalPlan);
    toolApprovalRequestId = approval.toolApprovalRequestId;
    if (approval.decision !== "approve" || options.abortController.signal.aborted) {
      await skipExecutionStart(sourceIndex, startGate);
      return createToolResultMessage(toolCall, {
        status: approval.decision === "deny" ? "denied" : "aborted",
        content:
          approval.decision === "deny"
            ? approvalPlan.deniedContent
            : preparedExecution.executionUnavailableContent,
        truncated: false,
      });
    }
  }

  if (options.abortController.signal.aborted) {
    await skipExecutionStart(sourceIndex, startGate);
    return createAbortedToolResultMessage(toolCall, preparedExecution.executionUnavailableContent);
  }

  const executionStarted = await publishExecutionStart(
    plannedToolCall,
    toolApprovalRequestId,
    preparedExecution.activitySummary,
    options,
    startGate,
  );
  if (!executionStarted) {
    return createAbortedToolResultMessage(toolCall, preparedExecution.executionUnavailableContent);
  }

  let executionResult: Awaited<ReturnType<PreparedToolExecution["execute"]>>;
  try {
    executionResult = await preparedExecution.execute(
      options.abortController.signal,
      (update) => {
        if (!options.abortController.signal.aborted) {
          void options.emit({
            type: "tool_execution_update",
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            stream: update.stream,
            delta: update.delta,
          });
        }
      },
      resultTokenBudget,
    );
  } catch {
    executionResult = Object.freeze({
      status: "failed",
      content: "Tool 执行失败。",
      truncated: false,
      cleanupUncertain: true,
    });
  }

  const finalizedResult = await finalizeToolResult(
    toolCall.toolCallId,
    executionResult,
    options.artifactStore,
    resultTokenBudget,
    executionResult.status === "completed"
      ? "completed"
      : options.abortController.signal.aborted
        ? "aborted"
        : "failed",
  );
  const toolResultMessage = createToolResultMessage(toolCall, {
    status:
      executionResult.status === "completed"
        ? "completed"
        : options.abortController.signal.aborted
          ? "aborted"
          : "failed",
    content: finalizedResult.content,
    truncated: finalizedResult.truncated,
    ...(finalizedResult.artifact === undefined ? {} : { artifact: finalizedResult.artifact }),
  });
  await options.emit({
    type: "tool_execution_end",
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    result: toolResultMessage,
    cleanupUncertain: executionResult.cleanupUncertain || finalizedResult.cleanupUncertain === true,
  });
  return toolResultMessage;
}

/** 取消阻止迟到预检进入执行；持有进程的预检先完成取消收口。 */
function waitForPreparationOrAbort(
  plan: ToolCallPlan,
  abortSignal: AbortSignal,
): Promise<ToolPreparationWaitResult> {
  if (abortSignal.aborted) {
    return Promise.resolve(Object.freeze({ status: "aborted" }));
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ToolPreparationWaitResult) => {
      if (settled) {
        return;
      }
      settled = true;
      abortSignal.removeEventListener("abort", handleAbort);
      resolve(result);
    };
    const handleAbort = () => {
      if (!plan.waitForPreparationOnAbort) finish(Object.freeze({ status: "aborted" }));
    };
    abortSignal.addEventListener("abort", handleAbort, { once: true });
    if (abortSignal.aborted) {
      finish(Object.freeze({ status: "aborted" }));
      return;
    }
    void Promise.resolve()
      .then(() => plan.prepare(abortSignal))
      .then(
        (preparation) =>
          finish(
            abortSignal.aborted
              ? Object.freeze({ status: "aborted" })
              : Object.freeze({ status: "prepared", preparation }),
          ),
        () => finish(Object.freeze({ status: abortSignal.aborted ? "aborted" : "failed" })),
      );
  });
}

function createAbortedToolResultMessage(
  toolCall: AssistantToolCallPart,
  content: string,
): ToolResultMessage {
  return createToolResultMessage(toolCall, { status: "aborted", content, truncated: false });
}

/** 串行提交已经形成的结果消息，再把它加入下一轮模型上下文。 */
async function appendToolResultMessage(
  toolResultMessage: ToolResultMessage,
  messageHistory: Message[],
  options: RunAgentLoopOptions,
): Promise<void> {
  await options.emit({ type: "tool_result", message: toolResultMessage });
  messageHistory.push(toolResultMessage);
}

function createToolResultMessage(
  toolCall: AssistantToolCallPart,
  result: Readonly<{
    status: ToolResultMessage["status"];
    content: string;
    truncated: boolean;
    artifact?: ToolArtifactReference;
  }>,
): ToolResultMessage {
  return Object.freeze({
    role: "tool",
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    status: result.status,
    content: result.content,
    truncated: result.truncated,
    ...(result.artifact === undefined ? {} : { artifact: result.artifact }),
  });
}

/** 建立一组只在前一个索引完成 start 决策后开放的有界 gate。 */
function createSourceOrderStartGate(toolCallCount: number): SourceOrderStartGate {
  const turns = Array.from({ length: toolCallCount }, () => Promise.withResolvers<void>());
  turns[0]?.resolve();
  return Object.freeze({
    async waitForTurn(sourceIndex) {
      await turns[sourceIndex]?.promise;
    },
    completeTurn(sourceIndex) {
      turns[sourceIndex + 1]?.resolve();
    },
  });
}

/** 对不执行的调用也按源顺序释放后续 start gate。 */
async function skipExecutionStart(
  sourceIndex: number,
  startGate: SourceOrderStartGate,
): Promise<void> {
  await startGate.waitForTurn(sourceIndex);
  startGate.completeTurn(sourceIndex);
}

/** 在 gate 内按源顺序发布 start，并在 abort 时只释放后续调用。 */
async function publishExecutionStart(
  plannedToolCall: PlannedToolCall,
  toolApprovalRequestId: string | null,
  activitySummary: string,
  options: RunAgentLoopOptions,
  startGate: SourceOrderStartGate,
): Promise<boolean> {
  await startGate.waitForTurn(plannedToolCall.sourceIndex);
  try {
    if (options.abortController.signal.aborted) {
      return false;
    }
    options.updatePhase("executing_tool");
    await options.emit({
      type: "tool_execution_start",
      toolCall: plannedToolCall.toolCall,
      toolApprovalRequestId,
      activitySummary,
    });
    return true;
  } finally {
    startGate.completeTurn(plannedToolCall.sourceIndex);
  }
}

/** 按模型给出的顺序为一组未执行 ToolCall 补齐结果。 */
async function appendToolResults(
  toolCalls: readonly AssistantToolCallPart[],
  status: Extract<ToolResultMessage["status"], "failed" | "aborted">,
  content: string,
  messageHistory: Message[],
  options: RunAgentLoopOptions,
  toolResultBudget: ToolResultBudget = createToolResultBudget(toolCalls.length),
): Promise<void> {
  for (const toolCall of toolCalls) {
    const toolResultMessage = createToolResultMessage(toolCall, {
      status,
      content,
      truncated: false,
    });
    await appendToolResultMessage(
      boundToolResultForBudget(toolResultMessage, toolResultBudget),
      messageHistory,
      options,
    );
  }
}

/** 为异常终止的 AssistantMessage 补齐其中尚未执行的 ToolCall。 */
async function appendUnresolvedToolResults(
  assistantMessage: AssistantMessage,
  messageHistory: Message[],
  options: RunAgentLoopOptions,
): Promise<void> {
  await appendToolResults(
    assistantMessage.content.filter(isToolCallPart),
    "aborted",
    "模型请求未正常完成，ToolCall 未执行。",
    messageHistory,
    options,
  );
}

function createToolResultBudget(resultCount = 1): ToolResultBudget {
  const normalizedResultCount = Math.max(1, resultCount);
  return {
    tokenBudgetPerResult: Math.min(
      TOOL_RESULT_TOKEN_LIMIT,
      Math.max(1, Math.floor(TOOL_RESULT_BATCH_TOKEN_LIMIT / normalizedResultCount)),
    ),
    remainingTokens: TOOL_RESULT_BATCH_TOKEN_LIMIT,
  };
}

/** 按单项和批次双重上限收口 ToolResult；预算消耗严格跟随模型源顺序。 */
function boundToolResultForBudget(
  toolResultMessage: ToolResultMessage,
  toolResultBudget: ToolResultBudget,
): ToolResultMessage {
  const availableTokenBudget = Math.max(
    0,
    Math.min(toolResultBudget.tokenBudgetPerResult, toolResultBudget.remainingTokens),
  );
  const contentTokenBudget = availableTokenBudget;
  const boundedContent = boundTextToTokenBudget(
    toolResultMessage.content,
    contentTokenBudget,
    getToolResultTruncationMarker(
      toolResultMessage.content,
      toolResultMessage.artifact !== undefined,
    ),
  );
  const resultContent = boundedContent.content || getTerminalStateContent(toolResultMessage.status);
  const consumedTokens = Math.min(availableTokenBudget, estimateTextTokens(resultContent));
  toolResultBudget.remainingTokens = Math.max(0, toolResultBudget.remainingTokens - consumedTokens);
  return Object.freeze({
    ...toolResultMessage,
    content: resultContent,
    truncated: toolResultMessage.truncated || boundedContent.truncated,
  });
}
/** 预算截断时区分可回读、部分保存和完全未保存的结果。 */
function getToolResultTruncationMarker(content: string, artifactAvailable: boolean): string {
  const commandMarker = "...[命令输出已截断，管道已继续排空]";
  const preservationMessage = artifactAvailable
    ? "...[结果已截断，原文可通过产物读取]"
    : "...[结果已截断，原文产物未保存，无法回读]";
  return content.includes(commandMarker)
    ? `${commandMarker}\n${preservationMessage}`
    : preservationMessage;
}

function getTerminalStateContent(status: ToolResultMessage["status"]): string {
  return status === "completed"
    ? "Tool 已完成。"
    : status === "aborted"
      ? "Tool 已停止。"
      : "Tool 执行失败。";
}
