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
import { FIXED_TOOL_DEFINITIONS } from "./tool/definitions.js";
import type { PreparedToolExecution, ToolApprovalPlan, ToolRunner } from "./tool/tool-runner.js";

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

const SAFE_MODEL_ERROR = "模型请求失败，请检查模型配置或稍后重试。";
const MODEL_REQUEST_LIMIT = 12;
const TOOL_CALL_BATCH_LIMIT = 32;
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

    // 执行工具调用
    for (let toolIndex = 0; toolIndex < toolCalls.length; toolIndex += 1) {
      const toolCall = toolCalls[toolIndex];
      if (toolCall === undefined) {
        throw new Error("ToolCall 顺序状态缺失。");
      }
      await processToolCall(toolCall, messageHistory, options);
      if (options.abortController.signal.aborted) {
        await appendToolResults(
          toolCalls.slice(toolIndex + 1),
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
    tools: FIXED_TOOL_DEFINITIONS,
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

/** 通过统一 Tool Module 预检并处理一个 ToolCall。 */
async function processToolCall(
  toolCall: AssistantToolCallPart,
  messageHistory: Message[],
  options: RunAgentLoopOptions,
): Promise<void> {
  const toolCallPlan = options.toolRunner.createPlan(toolCall);
  options.updatePhase("executing_tool");
  const preparation = await toolCallPlan.prepare();
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

  if (!preparation.ok) {
    await appendToolResult(toolCall, preparation.result, messageHistory, options);
    return;
  }
  await executePreparedToolCall(toolCall, preparation.preparedExecution, messageHistory, options);
}

/** 协调一个已预检 Tool 的确认、执行、输出与结果顺序。 */
async function executePreparedToolCall(
  toolCall: AssistantToolCallPart,
  preparedExecution: PreparedToolExecution,
  messageHistory: Message[],
  options: RunAgentLoopOptions,
): Promise<void> {
  let toolApprovalRequestId: string | null = null;
  const approvalPlan = preparedExecution.approval;
  if (approvalPlan !== null) {
    // 需要人工确认的 ToolCall，切换到等待人工确认阶段
    options.updatePhase("awaiting_tool_approval");
    const approval = await options.requestToolApproval(toolCall, approvalPlan);
    toolApprovalRequestId = approval.toolApprovalRequestId;
    if (approval.decision !== "approve" || options.abortController.signal.aborted) {
      // 如果人工确认被拒绝或被 abort，则写入 aborted 的 ToolResult
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

  if (options.abortController.signal.aborted) {
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

  options.updatePhase("executing_tool");
  // 开始执行 ToolCall
  await options.emit({ type: "tool_execution_start", toolCall, toolApprovalRequestId });
  const executionResult = await preparedExecution.execute(
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
  );

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
    assistantMessage.content.filter(isToolCallPart),
    "aborted",
    "模型请求未正常完成，ToolCall 未执行。",
    messageHistory,
    options,
  );
}
