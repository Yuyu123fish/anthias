import {
  type AssistantMessage,
  type AssistantToolCallPart,
  isToolCallPart,
  type Message,
  type ToolResultMessage,
} from "./message.js";
import {
  type ModelFinishReason,
  type ModelInputMessage,
  type ModelRequest,
  type ModelStream,
  streamAssistantMessage,
  toModelInputMessage,
} from "./model-stream.js";
import type { PermissionMode } from "./permission-mode.js";
import type { ModelToolDefinition } from "./tool/definitions.js";
import type {
  PreparedToolExecution,
  ToolApprovalPlan,
  ToolCallPlan,
  ToolRunner,
} from "./tool/tool-runner.js";

/** 枚举 Agent Loop 当前正在推进的活动阶段。 */
export type AgentLoopPhase = "requesting_model" | "awaiting_tool_approval" | "executing_tool";

/** 枚举 Agent Loop 停止迭代时可以交给 Run 的结果。 */
export type AgentLoopResult =
  | Readonly<{ status: "completed" }>
  | Readonly<{ status: "aborted" }>
  | Readonly<{ status: "failed"; error: string }>;

/** 表示 Agent Loop 等到的一次确认标识及最终决定。 */
export type AgentLoopToolApproval = Readonly<{
  toolApprovalRequestId: string;
  decision: "approve" | "deny" | "aborted";
}>;

/** 枚举 Agent Loop 交给 Run 持久化或发布的有序事实。 */
export type AgentLoopEvent =
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
  modelStream: ModelStream;
  systemPrompt: string;
  toolDefinitions: readonly ModelToolDefinition[];
  permissionMode: PermissionMode;
  toolRunner: ToolRunner;
  abortController: AbortController;
  emit(event: AgentLoopEvent): Promise<void>;
  updatePhase(phase: AgentLoopPhase): void;
  requestToolApproval(
    toolCall: AssistantToolCallPart,
    approvalPlan: ToolApprovalPlan,
  ): Promise<AgentLoopToolApproval>;
}>;

/** 表示一次模型请求形成的 AssistantMessage 与完成原因。 */
type AssistantRequestResult = Readonly<{
  message: AssistantMessage;
  modelInputMessage: Extract<ModelInputMessage, { role: "assistant" }>;
  finishReason: ModelFinishReason | null;
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

const SAFE_MODEL_ERROR = "模型请求失败，请检查模型配置或稍后重试。";
const MODEL_REQUEST_LIMIT = 12;
const TOOL_CALL_BATCH_LIMIT = 32;
const READ_ONLY_TOOL_CONCURRENCY_LIMIT = 4;
const COMPLETED_LOOP_RESULT = Object.freeze({ status: "completed" } as const);
const ABORTED_LOOP_RESULT = Object.freeze({ status: "aborted" } as const);
const FAILED_LOOP_RESULT = Object.freeze({ status: "failed", error: SAFE_MODEL_ERROR } as const);
const MODEL_REQUEST_LIMIT_RESULT = Object.freeze({
  status: "failed",
  error: "模型连续请求次数超过安全上限，Run 已停止。",
} as const);
const TOOL_CALL_BATCH_LIMIT_RESULT = Object.freeze({
  status: "failed",
  error: "单次模型响应包含过多 ToolCall，Run 已停止。",
} as const);

/** 推进 Model → Tool → Model，并用内部上限阻止异常循环和过大调用批次。 */
export async function runAgentLoop(options: RunAgentLoopOptions): Promise<AgentLoopResult> {
  const messageHistory = [...options.messages];
  const transientModelMessages = new Map<
    AssistantMessage,
    Extract<ModelInputMessage, { role: "assistant" }>
  >();
  let modelRequestCount = 0;

  while (true) {
    if (options.abortController.signal.aborted) {
      return ABORTED_LOOP_RESULT;
    }
    if (modelRequestCount >= MODEL_REQUEST_LIMIT) {
      return MODEL_REQUEST_LIMIT_RESULT;
    }

    options.updatePhase("requesting_model");
    modelRequestCount += 1;
    const assistantRequest = await streamAssistantResponse(
      messageHistory,
      transientModelMessages,
      options,
    );
    if (assistantRequest.message.status === "aborted") {
      await appendUnresolvedToolResults(assistantRequest.message, messageHistory, options);
      return ABORTED_LOOP_RESULT;
    }
    if (assistantRequest.message.status === "failed") {
      await appendUnresolvedToolResults(assistantRequest.message, messageHistory, options);
      return FAILED_LOOP_RESULT;
    }

    // 获取 ToolCall 列表
    const toolCalls = assistantRequest.message.content.filter(isToolCallPart);
    if (toolCalls.length === 0) {
      return assistantRequest.finishReason === "stop" ? COMPLETED_LOOP_RESULT : FAILED_LOOP_RESULT;
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
    if (toolCalls.length > TOOL_CALL_BATCH_LIMIT) {
      await appendToolResults(
        toolCalls,
        "failed",
        "单次模型响应包含过多 ToolCall，调用未执行。",
        messageHistory,
        options,
      );
      return TOOL_CALL_BATCH_LIMIT_RESULT;
    }

    const plannedToolCalls = toolCalls.map((toolCall, sourceIndex) =>
      Object.freeze({
        sourceIndex,
        toolCall,
        plan: options.toolRunner.createPlan(toolCall, options.permissionMode),
      }),
    );
    const parallelReadOnlyBatch = plannedToolCalls.every(
      ({ plan }) => plan.scheduling === "parallel_read_only",
    );
    if (parallelReadOnlyBatch) {
      const toolResultMessages = await executeParallelReadOnlyBatch(plannedToolCalls, options);
      for (const toolResultMessage of toolResultMessages) {
        await appendToolResultMessage(toolResultMessage, messageHistory, options);
      }
      if (options.abortController.signal.aborted) {
        return ABORTED_LOOP_RESULT;
      }
      continue;
    }

    for (let toolIndex = 0; toolIndex < plannedToolCalls.length; toolIndex += 1) {
      const plannedToolCall = plannedToolCalls[toolIndex];
      if (plannedToolCall === undefined) {
        throw new Error("ToolCall 顺序状态缺失。");
      }
      const toolResultMessage = await formToolResultMessage(plannedToolCall, options, null);
      await appendToolResultMessage(toolResultMessage, messageHistory, options);
      if (options.abortController.signal.aborted) {
        await appendToolResults(
          plannedToolCalls.slice(toolIndex + 1).map(({ toolCall }) => toolCall),
          "aborted",
          "Run 已停止，调用未执行。",
          messageHistory,
          options,
        );
        return ABORTED_LOOP_RESULT;
      }
    }
  }
}

/** 流式形成一条完整 AssistantMessage，Tool 处理只能在其持久化后发生。 */
async function streamAssistantResponse(
  messageHistory: Message[],
  transientModelMessages: Map<AssistantMessage, Extract<ModelInputMessage, { role: "assistant" }>>,
  options: RunAgentLoopOptions,
): Promise<AssistantRequestResult> {
  let finalMessage: AssistantMessage | null = null;
  let finalModelInputMessage: Extract<ModelInputMessage, { role: "assistant" }> | null = null;
  let finishReason: ModelFinishReason | null = null;

  const modelRequest: ModelRequest = Object.freeze({
    systemPrompt: options.systemPrompt,
    messages: Object.freeze(
      messageHistory.map((message) =>
        message.role === "assistant"
          ? (transientModelMessages.get(message) ?? toModelInputMessage(message))
          : toModelInputMessage(message),
      ),
    ),
    tools: options.toolDefinitions,
  });

  // 异步遍历可迭代模型响应
  for await (const messageEvent of streamAssistantMessage(
    options.modelStream,
    modelRequest,
    options.abortController.signal,
  )) {
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
  }

  if (finalMessage === null || finalModelInputMessage === null) {
    throw new Error("Model Stream 未形成最终 AssistantMessage。");
  }
  await options.emit({ type: "assistant_message_end", message: finalMessage });
  transientModelMessages.set(finalMessage, finalModelInputMessage);
  messageHistory.push(finalMessage);
  return Object.freeze({
    message: finalMessage,
    modelInputMessage: finalModelInputMessage,
    finishReason,
  });
}

/** 按源索引保存并发结果，并为未领取调用补齐 aborted 消息。 */
async function executeParallelReadOnlyBatch(
  plannedToolCalls: readonly PlannedToolCall[],
  options: RunAgentLoopOptions,
): Promise<readonly ToolResultMessage[]> {
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
      toolResultMessages[sourceIndex] = await formToolResultMessage(
        plannedToolCall,
        options,
        startGate,
      );
    }
  }

  const workerCount = Math.min(READ_ONLY_TOOL_CONCURRENCY_LIMIT, plannedToolCalls.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  for (const plannedToolCall of plannedToolCalls) {
    toolResultMessages[plannedToolCall.sourceIndex] ??= createAbortedToolResultMessage(
      plannedToolCall.toolCall,
      "Run 已停止，调用未执行。",
    );
  }
  return Object.freeze(
    toolResultMessages.map((toolResultMessage) => {
      if (toolResultMessage === undefined) {
        throw new Error("ToolCall 结果缺失。");
      }
      return toolResultMessage;
    }),
  );
}

/** 通过统一 Tool Module 预检、确认并形成一条尚未提交的结果消息。 */
async function formToolResultMessage(
  plannedToolCall: PlannedToolCall,
  options: RunAgentLoopOptions,
  startGate: SourceOrderStartGate | null,
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
    return createToolResultMessage(toolCall, preparation.result);
  }
  return executePreparedToolCall(
    plannedToolCall,
    preparation.preparedExecution,
    options,
    startGate,
  );
}

/** 协调一个已预检 Tool 的确认、执行和事件，结果由调用方串行提交。 */
async function executePreparedToolCall(
  plannedToolCall: PlannedToolCall,
  preparedExecution: PreparedToolExecution,
  options: RunAgentLoopOptions,
  startGate: SourceOrderStartGate | null,
): Promise<ToolResultMessage> {
  const { toolCall, sourceIndex } = plannedToolCall;
  let toolApprovalRequestId: string | null = null;
  const approvalPlan = preparedExecution.approval;
  if (approvalPlan !== null) {
    if (startGate !== null) {
      await skipExecutionStart(sourceIndex, startGate);
      return createToolResultMessage(toolCall, {
        status: "failed",
        content: "只读并发计划不能请求副作用确认。",
        truncated: false,
      });
    }
    // 需要人工确认的 ToolCall，切换到等待人工确认阶段
    options.updatePhase("awaiting_tool_approval");
    const approval = await options.requestToolApproval(toolCall, approvalPlan);
    toolApprovalRequestId = approval.toolApprovalRequestId;
    if (approval.decision !== "approve" || options.abortController.signal.aborted) {
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

  options.updatePhase("executing_tool");
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
  } catch {
    executionResult = Object.freeze({
      status: "failed",
      content: "Tool 执行失败。",
      truncated: false,
      cleanupUncertain: true,
    });
  }

  const toolResultMessage = createToolResultMessage(toolCall, {
    status:
      executionResult.status === "completed"
        ? "completed"
        : options.abortController.signal.aborted
          ? "aborted"
          : "failed",
    content: executionResult.content,
    truncated: executionResult.truncated,
  });
  await options.emit({
    type: "tool_execution_end",
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    result: toolResultMessage,
    cleanupUncertain: executionResult.cleanupUncertain,
  });
  return toolResultMessage;
}

/** abort 后立即结束对无副作用预检的等待，迟到的预检结果不会进入执行。 */
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
    const handleAbort = () => finish(Object.freeze({ status: "aborted" }));
    abortSignal.addEventListener("abort", handleAbort, { once: true });
    if (abortSignal.aborted) {
      handleAbort();
      return;
    }
    void Promise.resolve()
      .then(() => plan.prepare())
      .then(
        (preparation) => finish(Object.freeze({ status: "prepared", preparation })),
        () => finish(Object.freeze({ status: "failed" })),
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
  }>,
): ToolResultMessage {
  return Object.freeze({
    role: "tool",
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    status: result.status,
    content: result.content,
    truncated: result.truncated,
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
  startGate: SourceOrderStartGate | null,
): Promise<void> {
  if (startGate === null) {
    return;
  }
  await startGate.waitForTurn(sourceIndex);
  startGate.completeTurn(sourceIndex);
}

/** 在 gate 内按源顺序发布 start，并在 abort 时只释放后续调用。 */
async function publishExecutionStart(
  plannedToolCall: PlannedToolCall,
  toolApprovalRequestId: string | null,
  activitySummary: string,
  options: RunAgentLoopOptions,
  startGate: SourceOrderStartGate | null,
): Promise<boolean> {
  if (startGate !== null) {
    await startGate.waitForTurn(plannedToolCall.sourceIndex);
  }
  try {
    if (options.abortController.signal.aborted) {
      return false;
    }
    await options.emit({
      type: "tool_execution_start",
      toolCall: plannedToolCall.toolCall,
      toolApprovalRequestId,
      activitySummary,
    });
    return true;
  } finally {
    startGate?.completeTurn(plannedToolCall.sourceIndex);
  }
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
    const toolResultMessage = createToolResultMessage(toolCall, {
      status,
      content,
      truncated: false,
    });
    await appendToolResultMessage(toolResultMessage, messageHistory, options);
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
