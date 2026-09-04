import {
  type AssistantMessage,
  type AssistantToolCallPart,
  isToolCallPart,
  type Message,
  type ToolResultMessage,
} from "./message.js";
import {
  type ModelFinishReason,
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
  finishReason: ModelFinishReason | null;
}>;

/** 保存批次中一个 ToolCall 的源位置和一次性执行计划。 */
type PlannedToolCall = Readonly<{
  sourceIndex: number;
  toolCall: AssistantToolCallPart;
  plan: ToolCallPlan;
}>;

/** 保存尚未提交到 Session 的一个完整 Tool 结果。 */
type ToolOutcome = Readonly<{
  sourceIndex: number;
  message: ToolResultMessage;
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
    const assistantRequest = await streamAssistantResponse(messageHistory, options);
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
      const outcomes = await executeParallelReadOnlyBatch(plannedToolCalls, options);
      for (const outcome of outcomes) {
        await appendToolOutcome(outcome, messageHistory, options);
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
      const outcome = await formToolOutcome(plannedToolCall, options, null);
      await appendToolOutcome(outcome, messageHistory, options);
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
  options: RunAgentLoopOptions,
): Promise<AssistantRequestResult> {
  let finalMessage: AssistantMessage | null = null;
  let finishReason: ModelFinishReason | null = null;

  const modelRequest: ModelRequest = Object.freeze({
    systemPrompt: options.systemPrompt,
    messages: Object.freeze(messageHistory.map(toModelInputMessage)),
    tools: options.toolDefinitions,
  });

  // 异步遍历可迭代模型响应
  for await (const messageEvent of streamAssistantMessage(
    options.modelStream,
    modelRequest,
    options.abortController.signal,
  )) {
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
    finishReason = messageEvent.finishReason;
  }

  if (finalMessage === null) {
    throw new Error("Model Stream 未形成最终 AssistantMessage。");
  }
  await options.emit({ type: "assistant_message_end", message: finalMessage });
  messageHistory.push(finalMessage);
  return Object.freeze({ message: finalMessage, finishReason });
}

/** 使用固定 worker 数执行纯只读批次，并为未领取调用补齐 aborted outcome。 */
async function executeParallelReadOnlyBatch(
  plannedToolCalls: readonly PlannedToolCall[],
  options: RunAgentLoopOptions,
): Promise<readonly ToolOutcome[]> {
  const outcomes: Array<ToolOutcome | undefined> = Array.from({
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
      outcomes[sourceIndex] = await formToolOutcome(plannedToolCall, options, startGate);
    }
  }

  const workerCount = Math.min(READ_ONLY_TOOL_CONCURRENCY_LIMIT, plannedToolCalls.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  for (const plannedToolCall of plannedToolCalls) {
    outcomes[plannedToolCall.sourceIndex] ??= createAbortedOutcome(
      plannedToolCall,
      "Run 已停止，调用未执行。",
    );
  }
  return Object.freeze(
    outcomes.map((outcome) => {
      if (outcome === undefined) {
        throw new Error("ToolCall outcome 缺失。");
      }
      return outcome;
    }),
  );
}

/** 通过统一 Tool Module 预检、确认并形成一个尚未提交的 outcome。 */
async function formToolOutcome(
  plannedToolCall: PlannedToolCall,
  options: RunAgentLoopOptions,
  startGate: SourceOrderStartGate | null,
): Promise<ToolOutcome> {
  const { plan } = plannedToolCall;
  options.updatePhase("executing_tool");
  const preparationWaitResult = await waitForPreparationOrAbort(
    plan,
    options.abortController.signal,
  );
  if (preparationWaitResult.status === "aborted") {
    await skipExecutionStart(plannedToolCall.sourceIndex, startGate);
    return createAbortedOutcome(plannedToolCall, plan.abortedPreparationContent);
  }
  if (preparationWaitResult.status === "failed") {
    await skipExecutionStart(plannedToolCall.sourceIndex, startGate);
    return createOutcome(plannedToolCall, {
      status: "failed",
      content: "Tool 预检失败。",
      truncated: false,
    });
  }
  const { preparation } = preparationWaitResult;
  if (options.abortController.signal.aborted) {
    await skipExecutionStart(plannedToolCall.sourceIndex, startGate);
    return createAbortedOutcome(plannedToolCall, plan.abortedPreparationContent);
  }

  if (!preparation.ok) {
    await skipExecutionStart(plannedToolCall.sourceIndex, startGate);
    return createOutcome(plannedToolCall, preparation.result);
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
): Promise<ToolOutcome> {
  const { toolCall, sourceIndex } = plannedToolCall;
  let toolApprovalRequestId: string | null = null;
  const approvalPlan = preparedExecution.approval;
  if (approvalPlan !== null) {
    if (startGate !== null) {
      await skipExecutionStart(sourceIndex, startGate);
      return createOutcome(plannedToolCall, {
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
      return createOutcome(plannedToolCall, {
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
    return createAbortedOutcome(plannedToolCall, preparedExecution.executionUnavailableContent);
  }

  options.updatePhase("executing_tool");
  const executionStarted = await publishExecutionStart(
    plannedToolCall,
    toolApprovalRequestId,
    options,
    startGate,
  );
  if (!executionStarted) {
    return createAbortedOutcome(plannedToolCall, preparedExecution.executionUnavailableContent);
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

  const outcome = createOutcome(plannedToolCall, {
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
    result: outcome.message,
    cleanupUncertain: executionResult.cleanupUncertain,
  });
  return outcome;
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

/** 按源位置创建一条尚未持久化的 ToolResultMessage。 */
function createOutcome(
  plannedToolCall: PlannedToolCall,
  result: Readonly<{
    status: ToolResultMessage["status"];
    content: string;
    truncated: boolean;
  }>,
): ToolOutcome {
  return Object.freeze({
    sourceIndex: plannedToolCall.sourceIndex,
    message: createToolResultMessage(plannedToolCall.toolCall, result),
  });
}

function createAbortedOutcome(plannedToolCall: PlannedToolCall, content: string): ToolOutcome {
  return createOutcome(plannedToolCall, { status: "aborted", content, truncated: false });
}

/** 串行提交已经形成的 outcome，再把它加入下一轮模型上下文。 */
async function appendToolOutcome(
  outcome: ToolOutcome,
  messageHistory: Message[],
  options: RunAgentLoopOptions,
): Promise<void> {
  await options.emit({ type: "tool_result", message: outcome.message });
  messageHistory.push(outcome.message);
}

/** 形成并立即交付一条 ToolResultMessage。 */
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
  const resultMessage = createToolResultMessage(toolCall, result);
  await appendToolOutcome(
    Object.freeze({ sourceIndex: 0, message: resultMessage }),
    messageHistory,
    options,
  );
  return resultMessage;
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
    assistantMessage.content.filter(isToolCallPart),
    "aborted",
    "模型请求未正常完成，ToolCall 未执行。",
    messageHistory,
    options,
  );
}
