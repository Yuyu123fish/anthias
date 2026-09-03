import {
  type AssistantMessage,
  type AssistantToolCallPart,
  appendTextPart,
  isToolCallPart,
  type Message,
  type MutableAssistantMessage,
  normalizeToolCall,
  snapshotAssistantMessage,
  snapshotMessage,
  type ToolResultMessage,
} from "./message.js";
import {
  type ModelFinishReason,
  type ModelRequest,
  type ModelStream,
  type ModelStreamEvent,
  type ModelUsage,
  toModelInputMessage,
} from "./model-stream.js";
import { FIXED_TOOL_DEFINITIONS } from "./tool/definitions.js";
import type { PreparedToolExecution, ToolApprovalPlan, ToolRunner } from "./tool/tool-runner.js";

/** 枚举 Agent Loop 当前正在推进的活动阶段。 */
export type AgentLoopPhase = "requesting_model" | "awaiting_tool_approval" | "executing_tool";

/** 报告 Agent Loop 对三类执行预算的实际用量。 */
export type AgentLoopMetrics = Readonly<{
  modelRequestCount: number;
  producedToolCallCount: number;
  processedToolCallCount: number;
  activeDurationMilliseconds: number;
}>;

/** 枚举 Agent Loop 停止迭代时可以交给 Run 的结果。 */
export type AgentLoopResult =
  | Readonly<{ status: "completed" }>
  | Readonly<{ status: "aborted" }>
  | Readonly<{ status: "failed"; error: string }>
  | Readonly<{
      status: "budget_exhausted";
      budget: "model_requests" | "tool_calls" | "active_duration";
    }>;

/** 表示 Agent Loop 等到的一次确认标识及最终决定。 */
export type AgentLoopToolApproval = Readonly<{
  toolApprovalRequestId: string;
  decision: "approve" | "deny" | "aborted";
}>;

/** 提供 Run 投影 Agent Loop 状态所需的完整进度快照。 */
export type AgentLoopProgress = AgentLoopMetrics &
  Readonly<{
    phase: AgentLoopPhase;
    modelUsage: ModelUsage;
    activeDurationExhausted: boolean;
  }>;

/** 枚举 Agent Loop 交给 Run 持久化或发布的有序事实。 */
export type AgentLoopEvent =
  | Readonly<{
      type: "assistant_message_start";
      message: AssistantMessage;
    }>
  | Readonly<{
      type: "assistant_message_update";
      message: AssistantMessage;
      delta: string;
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
  modelStream: ModelStream;
  systemPrompt: string;
  toolRunner: ToolRunner;
  abortController: AbortController;
  emit(event: AgentLoopEvent): Promise<void>;
  updateProgress(progress: AgentLoopProgress): void;
  requestToolApproval(
    toolCall: AssistantToolCallPart,
    approvalPlan: ToolApprovalPlan,
  ): Promise<AgentLoopToolApproval>;
}>;

/** 保存一次 Agent Loop 内部的预算、阶段与计量状态。 */
type AgentLoopState = {
  /** 当前 Agent Loop 的阶段 */
  phase: AgentLoopPhase;
  /** 已经进行的模型请求次数 */
  modelRequestCount: number;
  /** 产生的 Tool Call 次数 */
  producedToolCallCount: number;
  /** 已处理完成的 Tool Call 次数 */
  processedToolCallCount: number;
  /** 累计的模型使用量 */
  cumulativeModelUsage: ModelUsage;
  /** agent 活动阶段累计毫秒数 */
  activeDurationMilliseconds: number;
  /** 当前活跃阶段的开始时间，单位为毫秒，若无则为 null */
  activePhaseStartedAtMilliseconds: number | null;
  /** 控制定时器，在活动期间计时，若无则为 null */
  activeDurationTimer: NodeJS.Timeout | null;
  /** 活动时长是否已耗尽 */
  activeDurationExhausted: boolean;
};

/** 表示一次模型请求形成的 AssistantMessage 与完成原因。 */
type AssistantRequestResult = Readonly<{
  message: AssistantMessage;
  finishReason: ModelFinishReason | null;
}>;

const ABORT_SIGNAL_RECEIVED = Symbol("abort-signal-received");
const SAFE_MODEL_ERROR = "模型请求失败，请检查模型配置或稍后重试。";
const MODEL_REQUEST_LIMIT = 12;
const TOOL_CALL_LIMIT = 32;
const ACTIVE_DURATION_LIMIT_MILLISECONDS = 30 * 60 * 1000;
const UNKNOWN_MODEL_USAGE = Object.freeze({
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
} satisfies ModelUsage);
const COMPLETED_LOOP_RESULT = Object.freeze({ status: "completed" } as const);
const ABORTED_LOOP_RESULT = Object.freeze({ status: "aborted" } as const);
const FAILED_LOOP_RESULT = Object.freeze({ status: "failed", error: SAFE_MODEL_ERROR } as const);
const MODEL_BUDGET_RESULT = Object.freeze({
  status: "budget_exhausted",
  budget: "model_requests",
} as const);
const TOOL_BUDGET_RESULT = Object.freeze({
  status: "budget_exhausted",
  budget: "tool_calls",
} as const);
const ACTIVE_DURATION_BUDGET_RESULT = Object.freeze({
  status: "budget_exhausted",
  budget: "active_duration",
} as const);

/** 推进 Model → Tool → Model，直到完成、失败、停止或预算耗尽。 */
export async function runAgentLoop(options: RunAgentLoopOptions): Promise<AgentLoopResult> {
  const messageHistory = options.messages.map(snapshotMessage);
  // 初始化 Agent Loop 状态
  const loopState: AgentLoopState = {
    phase: "requesting_model",
    modelRequestCount: 0,
    producedToolCallCount: 0,
    processedToolCallCount: 0,
    cumulativeModelUsage: Object.freeze({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    }),
    activeDurationMilliseconds: 0,
    activePhaseStartedAtMilliseconds: null,
    activeDurationTimer: null,
    activeDurationExhausted: false,
  };
  updateLoopProgress(loopState, options);

  try {
    while (true) {
      if (options.abortController.signal.aborted) {
        return getAbortLoopResult(loopState);
      }
      if (loopState.modelRequestCount >= MODEL_REQUEST_LIMIT) {
        return MODEL_BUDGET_RESULT;
      }
      if (!beginActivePhase(loopState, "requesting_model", options)) {
        return getAbortLoopResult(loopState);
      }

      loopState.modelRequestCount += 1;
      updateLoopProgress(loopState, options);
      const assistantRequest = await requestAssistantMessage(loopState, messageHistory, options);
      if (assistantRequest.message.status === "aborted") {
        await appendUnresolvedToolResults(assistantRequest.message, messageHistory, options);
        return getAbortLoopResult(loopState);
      }
      if (assistantRequest.message.status === "failed") {
        await appendUnresolvedToolResults(assistantRequest.message, messageHistory, options);
        return FAILED_LOOP_RESULT;
      }

      const toolCalls = assistantRequest.message.parts.filter(isToolCallPart);
      loopState.producedToolCallCount += toolCalls.length;
      updateLoopProgress(loopState, options);
      if (toolCalls.length === 0) {
        return assistantRequest.finishReason === "stop"
          ? COMPLETED_LOOP_RESULT
          : FAILED_LOOP_RESULT;
      }
      if (assistantRequest.finishReason !== "tool_calls") {
        await appendToolResults(
          toolCalls,
          "aborted",
          "模型未正常结束 ToolCall。",
          messageHistory,
          options,
        );
        return FAILED_LOOP_RESULT;
      }

      for (let toolIndex = 0; toolIndex < toolCalls.length; toolIndex += 1) {
        const toolCall = toolCalls[toolIndex];
        if (toolCall === undefined) {
          throw new Error("ToolCall 顺序状态缺失。");
        }
        if (loopState.processedToolCallCount >= TOOL_CALL_LIMIT) {
          await appendToolResults(
            toolCalls.slice(toolIndex),
            "failed",
            "Run ToolCall 预算已耗尽，调用未执行。",
            messageHistory,
            options,
          );
          return TOOL_BUDGET_RESULT;
        }

        loopState.processedToolCallCount += 1;
        updateLoopProgress(loopState, options);
        await processToolCall(loopState, toolCall, messageHistory, options);
        if (options.abortController.signal.aborted) {
          await appendToolResults(
            toolCalls.slice(toolIndex + 1),
            "aborted",
            "Run 已停止，调用未执行。",
            messageHistory,
            options,
          );
          return getAbortLoopResult(loopState);
        }
      }
    }
  } finally {
    pauseActivePhase(loopState, options);
  }
}

/** 请求并形成一条完整 AssistantMessage，Tool 处理只能在其持久化后发生。 */
async function requestAssistantMessage(
  loopState: AgentLoopState,
  messageHistory: Message[],
  options: RunAgentLoopOptions,
): Promise<AssistantRequestResult> {
  const mutableMessage: MutableAssistantMessage = {
    role: "assistant",
    content: "",
    parts: [],
    status: "streaming",
  };
  let finishReason: ModelFinishReason | null = null;
  let finishUsageObserved = false;
  let responseIterator: AsyncIterator<ModelStreamEvent> | null = null;

  try {
    await options.emit({
      type: "assistant_message_start",
      message: snapshotAssistantMessage(mutableMessage),
    });
    const modelRequest: ModelRequest = Object.freeze({
      systemPrompt: options.systemPrompt,
      messages: Object.freeze(messageHistory.map(toModelInputMessage)),
      tools: FIXED_TOOL_DEFINITIONS,
    });

    try {
      responseIterator = options
        .modelStream(modelRequest, options.abortController.signal)
        [Symbol.asyncIterator]();
    } catch {
      mutableMessage.status = options.abortController.signal.aborted ? "aborted" : "failed";
    }

    while (responseIterator !== null && finishReason === null) {
      let nextEventResult: IteratorResult<ModelStreamEvent> | typeof ABORT_SIGNAL_RECEIVED;
      try {
        nextEventResult = await readNextModelEventOrAbort(
          responseIterator,
          options.abortController.signal,
        );
      } catch {
        mutableMessage.status = options.abortController.signal.aborted ? "aborted" : "failed";
        break;
      }

      if (nextEventResult === ABORT_SIGNAL_RECEIVED || options.abortController.signal.aborted) {
        mutableMessage.status = "aborted";
        break;
      }
      if (nextEventResult.done) {
        mutableMessage.status = "failed";
        break;
      }

      const modelEvent = nextEventResult.value;
      if (modelEvent.type === "text_delta") {
        if (modelEvent.delta.length > 0) {
          mutableMessage.content += modelEvent.delta;
          appendTextPart(mutableMessage.parts, modelEvent.delta);
          await options.emit({
            type: "assistant_message_update",
            message: snapshotAssistantMessage(mutableMessage),
            delta: modelEvent.delta,
          });
        }
        continue;
      }
      if (modelEvent.type === "tool_call") {
        const toolCallIds = new Set(
          mutableMessage.parts.filter(isToolCallPart).map((part) => part.toolCallId),
        );
        mutableMessage.parts.push(normalizeToolCall(modelEvent, toolCallIds));
        continue;
      }

      finishReason = modelEvent.finishReason;
      finishUsageObserved = true;
      loopState.cumulativeModelUsage = addModelUsage(
        loopState.cumulativeModelUsage,
        modelEvent.usage,
      );
      updateLoopProgress(loopState, options);
      mutableMessage.status = isSuccessfulAssistantFinish(
        finishReason,
        mutableMessage.parts.some(isToolCallPart),
      )
        ? "completed"
        : "failed";
    }
  } finally {
    if (!finishUsageObserved) {
      loopState.cumulativeModelUsage = UNKNOWN_MODEL_USAGE;
      updateLoopProgress(loopState, options);
    }
    await closeResponseIterator(responseIterator);
    pauseActivePhase(loopState, options);
  }

  const finalMessage = snapshotAssistantMessage(mutableMessage);
  await options.emit({ type: "assistant_message_end", message: finalMessage });
  messageHistory.push(finalMessage);
  return Object.freeze({ message: finalMessage, finishReason });
}

/** 通过统一 Tool Module 预检并处理一个 ToolCall。 */
async function processToolCall(
  loopState: AgentLoopState,
  toolCall: AssistantToolCallPart,
  messageHistory: Message[],
  options: RunAgentLoopOptions,
): Promise<void> {
  const toolCallPlan = options.toolRunner.createPlan(toolCall);
  let preparation: Awaited<ReturnType<typeof toolCallPlan.prepare>>;

  if (toolCallPlan.preparationConsumesActiveDuration) {
    if (!beginActivePhase(loopState, "executing_tool", options)) {
      await appendToolResult(
        toolCall,
        {
          status: "aborted",
          content: toolCallPlan.preparationUnavailableContent,
          truncated: false,
        },
        messageHistory,
        options,
      );
      return;
    }
    try {
      preparation = await toolCallPlan.prepare(remainingActiveDurationMilliseconds(loopState));
    } finally {
      pauseActivePhase(loopState, options);
    }
    if (options.abortController.signal.aborted) {
      await appendToolResult(
        toolCall,
        {
          status: "aborted",
          content: toolCallPlan.abortedPreparationContent,
          truncated: false,
        },
        messageHistory,
        options,
      );
      return;
    }
  } else {
    preparation = await toolCallPlan.prepare(remainingActiveDurationMilliseconds(loopState));
  }

  if (!preparation.ok) {
    await appendToolResult(toolCall, preparation.result, messageHistory, options);
    return;
  }
  await executePreparedToolCall(
    loopState,
    toolCall,
    preparation.preparedExecution,
    messageHistory,
    options,
  );
}

/** 协调一个已预检 Tool 的确认、执行、输出与结果顺序。 */
async function executePreparedToolCall(
  loopState: AgentLoopState,
  toolCall: AssistantToolCallPart,
  preparedExecution: PreparedToolExecution,
  messageHistory: Message[],
  options: RunAgentLoopOptions,
): Promise<void> {
  let toolApprovalRequestId: string | null = null;
  const approvalPlan = preparedExecution.approval;
  if (approvalPlan !== null) {
    setLoopPhase(loopState, "awaiting_tool_approval", options);
    const approval = await options.requestToolApproval(toolCall, approvalPlan);
    toolApprovalRequestId = approval.toolApprovalRequestId;
    if (approval.decision !== "approve" || options.abortController.signal.aborted) {
      await appendToolResult(
        toolCall,
        {
          status: approval.decision === "deny" ? "denied" : "aborted",
          content:
            approval.decision === "deny"
              ? approvalPlan.deniedContent
              : preparedExecution.executionUnavailableContent,
          truncated: false,
        },
        messageHistory,
        options,
      );
      return;
    }
  }

  if (!beginActivePhase(loopState, "executing_tool", options)) {
    await appendToolResult(
      toolCall,
      {
        status: "aborted",
        content: preparedExecution.executionUnavailableContent,
        truncated: false,
      },
      messageHistory,
      options,
    );
    return;
  }

  await options.emit({ type: "tool_execution_start", toolCall, toolApprovalRequestId });
  let executionResult: Awaited<ReturnType<PreparedToolExecution["execute"]>>;
  try {
    executionResult = await preparedExecution.execute(options.abortController.signal, (update) => {
      if (!options.abortController.signal.aborted) {
        void options.emit({
          type: "tool_execution_update",
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          stream: update.stream,
          delta: update.delta,
        });
      }
    });
  } finally {
    pauseActivePhase(loopState, options);
  }

  const resultMessage = await appendToolResult(
    toolCall,
    {
      status: options.abortController.signal.aborted ? "aborted" : executionResult.status,
      content: executionResult.content,
      truncated: executionResult.truncated,
    },
    messageHistory,
    options,
  );
  await options.emit({
    type: "tool_execution_end",
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    result: resultMessage,
    cleanupUncertain: executionResult.cleanupUncertain,
  });
}

/** 形成并交付一条 ToolResultMessage，再把它加入下一轮模型上下文。 */
async function appendToolResult(
  toolCall: AssistantToolCallPart,
  result: Readonly<{
    status: ToolResultMessage["status"];
    content: string;
    truncated: boolean;
  }>,
  messageHistory: Message[],
  options: RunAgentLoopOptions,
): Promise<ToolResultMessage> {
  const resultMessage: ToolResultMessage = Object.freeze({
    role: "tool",
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    status: result.status,
    content: result.content,
    truncated: result.truncated,
  });
  await options.emit({ type: "tool_result", message: resultMessage });
  messageHistory.push(resultMessage);
  return resultMessage;
}

/** 按模型给出的顺序为一组未执行 ToolCall 补齐结果。 */
async function appendToolResults(
  toolCalls: readonly AssistantToolCallPart[],
  status: Extract<ToolResultMessage["status"], "failed" | "aborted">,
  content: string,
  messageHistory: Message[],
  options: RunAgentLoopOptions,
): Promise<void> {
  for (const toolCall of toolCalls) {
    await appendToolResult(
      toolCall,
      { status, content, truncated: false },
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
    assistantMessage.parts.filter(isToolCallPart),
    "aborted",
    "模型请求未正常完成，ToolCall 未执行。",
    messageHistory,
    options,
  );
}

/** 开始累计模型请求或 Tool 执行的活动时间。 */
function beginActivePhase(
  loopState: AgentLoopState,
  phase: Exclude<AgentLoopPhase, "awaiting_tool_approval">,
  options: RunAgentLoopOptions,
): boolean {
  pauseActivePhase(loopState, options);
  if (options.abortController.signal.aborted) {
    return false;
  }
  const remainingMilliseconds = remainingActiveDurationMilliseconds(loopState);
  if (remainingMilliseconds <= 0) {
    exhaustActiveDuration(loopState, options);
    return false;
  }

  loopState.phase = phase;
  loopState.activePhaseStartedAtMilliseconds = Date.now();
  loopState.activeDurationTimer = setTimeout(
    () => exhaustActiveDuration(loopState, options),
    remainingMilliseconds,
  );
  updateLoopProgress(loopState, options);
  return true;
}

/** 暂停活动时间累计，使人工确认和持久化耗时不进入预算。 */
function pauseActivePhase(loopState: AgentLoopState, options: RunAgentLoopOptions): void {
  const phaseStartedAtMilliseconds = loopState.activePhaseStartedAtMilliseconds;
  if (phaseStartedAtMilliseconds !== null) {
    loopState.activeDurationMilliseconds = Math.min(
      ACTIVE_DURATION_LIMIT_MILLISECONDS,
      loopState.activeDurationMilliseconds + Math.max(0, Date.now() - phaseStartedAtMilliseconds),
    );
    loopState.activePhaseStartedAtMilliseconds = null;
  }
  if (loopState.activeDurationTimer !== null) {
    clearTimeout(loopState.activeDurationTimer);
    loopState.activeDurationTimer = null;
  }
  updateLoopProgress(loopState, options);
}

/** 切换到不计入活动预算的 Agent Loop 阶段。 */
function setLoopPhase(
  loopState: AgentLoopState,
  phase: Extract<AgentLoopPhase, "awaiting_tool_approval">,
  options: RunAgentLoopOptions,
): void {
  pauseActivePhase(loopState, options);
  loopState.phase = phase;
  updateLoopProgress(loopState, options);
}

/** 计算模型请求或 Tool 执行仍可使用的活动毫秒数。 */
function remainingActiveDurationMilliseconds(loopState: AgentLoopState): number {
  const activeElapsedMilliseconds =
    loopState.activePhaseStartedAtMilliseconds === null
      ? 0
      : Math.max(0, Date.now() - loopState.activePhaseStartedAtMilliseconds);
  return Math.max(
    0,
    ACTIVE_DURATION_LIMIT_MILLISECONDS -
      loopState.activeDurationMilliseconds -
      activeElapsedMilliseconds,
  );
}

/** 让活动时长预算耗尽成为根 AbortSignal 的首个原因。 */
function exhaustActiveDuration(loopState: AgentLoopState, options: RunAgentLoopOptions): void {
  if (options.abortController.signal.aborted) {
    return;
  }
  pauseActivePhase(loopState, options);
  loopState.activeDurationMilliseconds = ACTIVE_DURATION_LIMIT_MILLISECONDS;
  loopState.activeDurationExhausted = true;
  updateLoopProgress(loopState, options);
  options.abortController.abort();
}

/** 将当前根取消映射为用户停止或活动时长预算结果。 */
function getAbortLoopResult(loopState: AgentLoopState): AgentLoopResult {
  return loopState.activeDurationExhausted ? ACTIVE_DURATION_BUDGET_RESULT : ABORTED_LOOP_RESULT;
}

/** 把当前 Loop 状态里的可变计量字段做一份快照，方便 Run 过程安全地读取和展示进度。 */
function updateLoopProgress(loopState: AgentLoopState, options: RunAgentLoopOptions): void {
  options.updateProgress(
    Object.freeze({
      phase: loopState.phase,
      modelRequestCount: loopState.modelRequestCount,
      producedToolCallCount: loopState.producedToolCallCount,
      processedToolCallCount: loopState.processedToolCallCount,
      activeDurationMilliseconds: Math.max(
        0,
        Math.round(
          loopState.activeDurationMilliseconds +
            (loopState.activePhaseStartedAtMilliseconds === null
              ? 0
              : Math.max(0, Date.now() - loopState.activePhaseStartedAtMilliseconds)),
        ),
      ),
      modelUsage: Object.freeze({ ...loopState.cumulativeModelUsage }),
      activeDurationExhausted: loopState.activeDurationExhausted,
    }),
  );
}

/** 等待模型迭代器释放，并隔离同步或异步清理失败。 */
async function closeResponseIterator(
  responseIterator: AsyncIterator<ModelStreamEvent> | null,
): Promise<void> {
  if (!responseIterator?.return) {
    return;
  }
  try {
    await responseIterator.return();
  } catch {
    // 模型流清理失败不能覆盖 Agent Loop 已经确定的停止原因。
  }
}

/** 在下一条模型事件与根 AbortSignal 之间竞速。 */
function readNextModelEventOrAbort(
  responseIterator: AsyncIterator<ModelStreamEvent>,
  abortSignal: AbortSignal,
): Promise<IteratorResult<ModelStreamEvent> | typeof ABORT_SIGNAL_RECEIVED> {
  if (abortSignal.aborted) {
    return Promise.resolve(ABORT_SIGNAL_RECEIVED);
  }
  return new Promise((resolve, reject) => {
    /** AbortSignal 触发时解除监听并让取消赢得竞速。 */
    const handleAbort = () => {
      removeAbortListener();
      resolve(ABORT_SIGNAL_RECEIVED);
    };
    /** 移除当前读取操作注册的 AbortSignal 监听器。 */
    const removeAbortListener = () => {
      abortSignal.removeEventListener("abort", handleAbort);
    };
    abortSignal.addEventListener("abort", handleAbort, { once: true });
    Promise.resolve(responseIterator.next()).then(
      (nextEventResult) => {
        removeAbortListener();
        resolve(nextEventResult);
      },
      (error: unknown) => {
        removeAbortListener();
        reject(error);
      },
    );
  });
}

/** 判断 finish reason 与 ToolCall 组合是否形成完整 AssistantMessage。 */
function isSuccessfulAssistantFinish(
  finishReason: ModelFinishReason,
  hasToolCall: boolean,
): boolean {
  return (
    (finishReason === "stop" && !hasToolCall) || (finishReason === "tool_calls" && hasToolCall)
  );
}

/** 累加 Provider 报告的标准化 usage，任一未知维度继续保持未知。 */
function addModelUsage(currentUsage: ModelUsage, requestUsage: ModelUsage): ModelUsage {
  return Object.freeze({
    inputTokens: addKnownTokenCounts(currentUsage.inputTokens, requestUsage.inputTokens),
    outputTokens: addKnownTokenCounts(currentUsage.outputTokens, requestUsage.outputTokens),
    totalTokens: addKnownTokenCounts(currentUsage.totalTokens, requestUsage.totalTokens),
  });
}

/** 只在两侧都可知时返回准确 token 合计。 */
function addKnownTokenCounts(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left + right;
}
