import { randomUUID } from "node:crypto";
import {
  type AgentLoopEvent,
  type AgentLoopProgress,
  type AgentLoopResult,
  type AgentLoopToolApproval,
  runAgentLoop,
} from "./agent.js";
import type { AssistantMessage, AssistantToolCallPart, Message, UserMessage } from "./message.js";
import type { ModelStream, ModelUsage } from "./model-stream.js";
import { createCodingSystemPrompt } from "./prompts/coding-system-prompt.js";
import type { Session, SessionRunLease } from "./session.js";
import { createToolRunner, type ToolApprovalPlan } from "./tool/tool-runner.js";

/** 枚举 Run 对外交付的活动阶段。 */
type RunPhase = "requesting_model" | "awaiting_tool_approval" | "executing_tool";

/** 描述公开状态中当前 Run 的身份、阶段和实际预算用量。 */
export type ActiveRun = Readonly<{
  runId: string;
  phase: RunPhase;
  modelRequestCount: number;
  toolCallCount: number;
}>;

/** 报告一个 Run 对三类执行预算的最终实际用量。 */
export type RunMetrics = Readonly<{
  modelRequestCount: number;
  producedToolCallCount: number;
  processedToolCallCount: number;
  activeDurationMilliseconds: number;
}>;

/** 描述交互 Adapter 需要呈现的一次副作用 Tool 确认请求。 */
export type ToolApprovalRequest = Readonly<{
  toolApprovalRequestId: string;
  toolCallId: string;
  toolName: "edit_file" | "write_file" | "execute_command";
  target: string;
  preview: string;
}>;

/** 表示 TUI 对当前 Tool 确认响应的同步接纳结果。 */
export type ToolApprovalResponse =
  | Readonly<{ status: "accepted" }>
  | Readonly<{ status: "rejected"; reason: "not_pending" | "request_mismatch" }>;

/** 提供交互 Adapter 可读取但不能修改的 Agent 状态快照。 */
export type AgentState = Readonly<{
  sessionId: string;
  workspaceRoot: string;
  messageHistory: readonly Message[];
  activeAssistantMessage: AssistantMessage | null;
  activeRun: ActiveRun | null;
  pendingToolApproval: ToolApprovalRequest | null;
  running: boolean;
  lastError: string | null;
}>;

/** 枚举一个已接受 Run 的公开终态。 */
export type FinishedPromptResult =
  | Readonly<{ status: "completed" }>
  | Readonly<{ status: "aborted" }>
  | Readonly<{ status: "failed"; error: string }>
  | Readonly<{
      status: "budget_exhausted";
      budget: "model_requests" | "tool_calls" | "active_duration";
    }>;

/** 表示提示词被拒绝或完成一次 Run 后的结果。 */
export type PromptResult =
  | Readonly<{
      status: "rejected";
      reason: "empty" | "busy" | "session_busy" | "session_changed";
    }>
  | FinishedPromptResult;

/** 枚举 Agent 按实际发生顺序同步发布的瞬时事件。 */
export type AgentEvent =
  | Readonly<{ type: "run_start"; runId: string }>
  | Readonly<{ type: "message_start"; message: Message }>
  | Readonly<{ type: "message_update"; message: AssistantMessage; delta: string }>
  | Readonly<{ type: "message_end"; message: Message }>
  | Readonly<{ type: "tool_execution_start"; toolCallId: string; toolName: string }>
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
      result: Extract<Message, { role: "tool" }>;
      cleanupUncertain: boolean;
    }>
  | Readonly<{ type: "tool_approval_requested"; request: ToolApprovalRequest }>
  | Readonly<{
      type: "tool_approval_resolved";
      request: ToolApprovalRequest;
      decision: "approve" | "deny" | "aborted";
    }>
  | Readonly<{
      type: "run_end";
      runId: string;
      result: FinishedPromptResult;
      metrics: RunMetrics;
    }>;

/** 定义同步观察 AgentEvent 的监听器。 */
export type AgentListener = (event: AgentEvent) => void;

/** 暴露交互 Adapter 操作 Agent 所需的最小公开 Interface。 */
export type Agent = Readonly<{
  readonly state: AgentState;
  prompt(promptText: string): Promise<PromptResult>;
  respondToToolApproval(
    toolApprovalRequestId: string,
    decision: "approve" | "deny",
  ): ToolApprovalResponse;
  abort(): void;
  subscribe(listener: AgentListener): () => void;
}>;

/** 配置内部 Model Stream 与已打开 Session 的 Agent 运行宿主。 */
export type CreateAgentWithModelStreamOptions = Readonly<{
  modelStream: ModelStream;
  session: Session;
}>;

/** 集中持有一个活动 Run 的取消、Session lease、Loop 投影与唯一终态。 */
type ActiveRunOwnership = {
  runId: string;
  phase: RunPhase;
  sessionLease: SessionRunLease;
  abortController: AbortController;
  modelRequestCount: number;
  observedToolCallCount: number;
  processedToolCallCount: number;
  cumulativeModelUsage: ModelUsage;
  activeDurationMilliseconds: number;
  activeDurationExhausted: boolean;
  sessionWriteFailed: boolean;
  terminalResultPromise: Promise<FinishedPromptResult> | null;
};

/** 持有当前确认 Promise 的唯一解决入口和对应请求。 */
type PendingToolApproval = Readonly<{
  runId: string;
  request: ToolApprovalRequest;
  resolve(decision: "approve" | "deny" | "aborted"): void;
}>;

const SAFE_MODEL_ERROR = "模型请求失败，请检查模型配置或稍后重试。";
const SAFE_SESSION_ERROR = "Session 写入失败，请检查本地存储后重试。";
const SAFE_SESSION_RELEASE_ERROR = "Session 资源释放失败，已停止继续写入；请重新打开 Session。";
const SESSION_FAILED_RESULT = Object.freeze({
  status: "failed",
  error: SAFE_SESSION_ERROR,
} as const);
const SESSION_RELEASE_FAILED_RESULT = Object.freeze({
  status: "failed",
  error: SAFE_SESSION_RELEASE_ERROR,
} as const);
const MODEL_FAILED_RESULT = Object.freeze({ status: "failed", error: SAFE_MODEL_ERROR } as const);
const EMPTY_PROMPT_RESULT = Object.freeze({ status: "rejected", reason: "empty" } as const);
const BUSY_PROMPT_RESULT = Object.freeze({ status: "rejected", reason: "busy" } as const);
const SESSION_BUSY_PROMPT_RESULT = Object.freeze({
  status: "rejected",
  reason: "session_busy",
} as const);
const SESSION_CHANGED_PROMPT_RESULT = Object.freeze({
  status: "rejected",
  reason: "session_changed",
} as const);
const ABORTED_PROMPT_RESULT = Object.freeze({ status: "aborted" } as const);
const ACTIVE_DURATION_BUDGET_RESULT = Object.freeze({
  status: "budget_exhausted",
  budget: "active_duration",
} as const);

/** 使用内部 Model Stream 与已打开 Session 创建 Agent 运行宿主。 */
export function createAgentWithModelStream({
  modelStream,
  session,
}: CreateAgentWithModelStreamOptions): Agent {
  const messageHistory: Message[] = [...session.messageHistory];
  const toolRunner = createToolRunner({
    workspace: Object.freeze({
      workspaceRoot: session.workspaceRoot,
      sessionDirectory: session.sessionDirectory,
    }),
    shell: session.shell,
  });
  const systemPrompt = createCodingSystemPrompt(session.workspaceRoot, session.shell);
  const eventListeners = new Set<AgentListener>();
  let activeAssistantMessage: AssistantMessage | null = null;
  let lastError: string | null = null;
  let activeRun: ActiveRunOwnership | null = null;
  let sessionUnavailableResult: FinishedPromptResult | null = null;
  let sessionLeaseAcquisitionPending = false;
  let sessionChanged = false;
  let pendingToolApproval: PendingToolApproval | null = null;

  /** 生成只读状态投影；完成消息与活动 partial 的生命周期由各自形成边界持有。 */
  function createStateSnapshot(): AgentState {
    return Object.freeze({
      sessionId: session.sessionId,
      workspaceRoot: session.workspaceRoot,
      messageHistory: Object.freeze([...messageHistory]),
      activeAssistantMessage,
      activeRun: activeRun
        ? Object.freeze({
            runId: activeRun.runId,
            phase: activeRun.phase,
            modelRequestCount: activeRun.modelRequestCount,
            toolCallCount: activeRun.processedToolCallCount,
          })
        : null,
      pendingToolApproval: pendingToolApproval?.request ?? null,
      running: activeRun !== null,
      lastError,
    });
  }

  /** 按注册顺序同步发布事件，并隔离订阅者异常。 */
  function publishEvent(event: AgentEvent): void {
    const eventSnapshot = Object.freeze(event);
    for (const listener of [...eventListeners]) {
      try {
        void listener(eventSnapshot);
      } catch {
        // 订阅者没有第二条错误通道；呈现异常不能破坏 Run 的唯一终结路径。
      }
    }
  }

  /** 注册事件监听器，并返回可重复调用的取消订阅函数。 */
  function subscribeToEvents(listener: AgentListener): () => void {
    eventListeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      eventListeners.delete(listener);
    };
  }

  /** 请求中止当前 Run，实际终结继续由 Agent Loop 和统一收口路径完成。 */
  function abortActiveRun(): void {
    const currentRun = activeRun;
    if (currentRun === null || currentRun.abortController.signal.aborted) {
      return;
    }
    currentRun.abortController.abort();
    resolvePendingToolApproval(currentRun, "aborted");
  }

  /** 只解决当前标识完全匹配的确认，不直接执行任何 Tool。 */
  function respondToToolApproval(
    toolApprovalRequestId: string,
    decision: "approve" | "deny",
  ): ToolApprovalResponse {
    const pendingApproval = pendingToolApproval;
    if (pendingApproval === null) {
      return Object.freeze({ status: "rejected", reason: "not_pending" });
    }
    if (pendingApproval.request.toolApprovalRequestId !== toolApprovalRequestId) {
      return Object.freeze({ status: "rejected", reason: "request_mismatch" });
    }
    if (
      activeRun?.runId !== pendingApproval.runId ||
      activeRun.phase !== "awaiting_tool_approval"
    ) {
      return Object.freeze({ status: "rejected", reason: "request_mismatch" });
    }

    pendingToolApproval = null;
    publishEvent({
      type: "tool_approval_resolved",
      request: pendingApproval.request,
      decision,
    });
    pendingApproval.resolve(decision);
    return Object.freeze({ status: "accepted" });
  }

  /** 解决当前 Run 唯一待决确认，晚到或其他 Run 的请求保持不变。 */
  function resolvePendingToolApproval(currentRun: ActiveRunOwnership, decision: "aborted"): void {
    const pendingApproval = pendingToolApproval;
    if (pendingApproval === null || pendingApproval.runId !== currentRun.runId) {
      return;
    }
    pendingToolApproval = null;
    publishEvent({
      type: "tool_approval_resolved",
      request: pendingApproval.request,
      decision,
    });
    pendingApproval.resolve(decision);
  }

  /** 发布完整预览并等待当前 ToolCall 的一次性确认决定。 */
  function waitForToolApproval(
    currentRun: ActiveRunOwnership,
    toolCall: AssistantToolCallPart,
    approvalPlan: ToolApprovalPlan,
  ): Promise<AgentLoopToolApproval> {
    const request: ToolApprovalRequest = Object.freeze({
      toolApprovalRequestId: randomUUID(),
      toolCallId: toolCall.toolCallId,
      toolName: approvalPlan.toolName,
      target: approvalPlan.target,
      preview: approvalPlan.preview,
    });
    return new Promise((resolve) => {
      pendingToolApproval = Object.freeze({
        runId: currentRun.runId,
        request,
        resolve: (decision) =>
          resolve(
            Object.freeze({
              toolApprovalRequestId: request.toolApprovalRequestId,
              decision,
            }),
          ),
      });
      publishEvent({ type: "tool_approval_requested", request });
      if (currentRun.abortController.signal.aborted) {
        resolvePendingToolApproval(currentRun, "aborted");
      }
    });
  }

  /** 接纳提示词、建立一次 Run，并把实际迭代委托给 Agent Loop。 */
  async function submitPrompt(promptText: string): Promise<PromptResult> {
    if (promptText.trim().length === 0) {
      return EMPTY_PROMPT_RESULT;
    }
    if (activeRun !== null || sessionLeaseAcquisitionPending) {
      return BUSY_PROMPT_RESULT;
    }
    if (sessionChanged) {
      return SESSION_CHANGED_PROMPT_RESULT;
    }
    if (sessionUnavailableResult !== null) {
      return sessionUnavailableResult;
    }

    lastError = null;
    const runId = randomUUID();
    sessionLeaseAcquisitionPending = true;
    let sessionRunAcquisition: Awaited<ReturnType<Session["acquireRun"]>>;
    try {
      sessionRunAcquisition = await session.acquireRun(runId);
    } catch {
      sessionUnavailableResult = SESSION_FAILED_RESULT;
      lastError = SAFE_SESSION_ERROR;
      return SESSION_FAILED_RESULT;
    } finally {
      sessionLeaseAcquisitionPending = false;
    }
    if (sessionRunAcquisition.status === "rejected") {
      if (sessionRunAcquisition.reason === "session_changed") {
        sessionChanged = true;
        return SESSION_CHANGED_PROMPT_RESULT;
      }
      return SESSION_BUSY_PROMPT_RESULT;
    }

    const currentRun: ActiveRunOwnership = {
      runId,
      phase: "requesting_model",
      sessionLease: sessionRunAcquisition.lease,
      abortController: new AbortController(),
      modelRequestCount: 0,
      observedToolCallCount: 0,
      processedToolCallCount: 0,
      cumulativeModelUsage: Object.freeze({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }),
      activeDurationMilliseconds: 0,
      activeDurationExhausted: false,
      sessionWriteFailed: false,
      terminalResultPromise: null,
    };
    activeRun = currentRun;

    const userMessage: UserMessage = Object.freeze({ role: "user", content: promptText });
    try {
      // UserMessage 刷新成功后 Run 才算被接受，后续事件与 Tool 才能开始。
      await currentRun.sessionLease.appendMessage(userMessage);
    } catch {
      return failBeforeRunStart(currentRun);
    }

    messageHistory.push(userMessage);
    publishEvent({ type: "run_start", runId });
    publishEvent({ type: "message_start", message: userMessage });
    publishEvent({ type: "message_end", message: userMessage });

    try {
      const loopResult = await runAgentLoop({
        messages: messageHistory,
        modelStream,
        systemPrompt,
        toolRunner,
        abortController: currentRun.abortController,
        emit: (event) => processAgentLoopEvent(currentRun, event),
        updateProgress: (progress) => updateRunProgress(currentRun, progress),
        requestToolApproval: (toolCall, approvalPlan) =>
          waitForToolApproval(currentRun, toolCall, approvalPlan),
      });
      return finishRun(currentRun, toFinishedPromptResult(loopResult));
    } catch {
      const requestedResult = currentRun.sessionWriteFailed
        ? SESSION_FAILED_RESULT
        : currentRun.abortController.signal.aborted
          ? currentRun.activeDurationExhausted
            ? ACTIVE_DURATION_BUDGET_RESULT
            : ABORTED_PROMPT_RESULT
          : MODEL_FAILED_RESULT;
      return finishRun(currentRun, requestedResult);
    }
  }

  /** 在 run_start 之前安全处理首条 UserMessage 或 lease 释放失败。 */
  async function failBeforeRunStart(currentRun: ActiveRunOwnership): Promise<FinishedPromptResult> {
    let failedResult: FinishedPromptResult = SESSION_FAILED_RESULT;
    try {
      await currentRun.sessionLease.release();
    } catch {
      failedResult = SESSION_RELEASE_FAILED_RESULT;
    }
    lastError = failedResult.status === "failed" ? failedResult.error : SAFE_SESSION_ERROR;
    sessionUnavailableResult = failedResult;
    if (activeRun === currentRun) {
      activeRun = null;
    }
    return failedResult;
  }

  /** 用 Agent Loop 的完整快照更新 Run 对外投影与最终计量。 */
  function updateRunProgress(currentRun: ActiveRunOwnership, progress: AgentLoopProgress): void {
    currentRun.phase = progress.phase;
    currentRun.modelRequestCount = progress.modelRequestCount;
    currentRun.observedToolCallCount = progress.producedToolCallCount;
    currentRun.processedToolCallCount = progress.processedToolCallCount;
    currentRun.cumulativeModelUsage = progress.modelUsage;
    currentRun.activeDurationMilliseconds = progress.activeDurationMilliseconds;
    currentRun.activeDurationExhausted = progress.activeDurationExhausted;
  }

  /** 持久化 Agent Loop 事实，再投影为稳定的公开 AgentEvent。 */
  async function processAgentLoopEvent(
    currentRun: ActiveRunOwnership,
    event: AgentLoopEvent,
  ): Promise<void> {
    switch (event.type) {
      case "assistant_message_start":
        activeAssistantMessage = event.message;
        publishEvent({ type: "message_start", message: event.message });
        return;
      case "assistant_message_update":
        activeAssistantMessage = event.message;
        if (event.delta !== null) {
          publishEvent({
            type: "message_update",
            message: event.message,
            delta: event.delta,
          });
        }
        return;
      case "assistant_message_end":
        await appendCompletedMessage(currentRun, event.message, true);
        activeAssistantMessage = null;
        return;
      case "tool_result":
        await appendCompletedMessage(currentRun, event.message, false);
        return;
      case "tool_execution_start":
        if (event.toolApprovalRequestId !== null) {
          await appendToolExecutionStarted(currentRun, event.toolCall, event.toolApprovalRequestId);
        }
        publishEvent({
          type: "tool_execution_start",
          toolCallId: event.toolCall.toolCallId,
          toolName: event.toolCall.toolName,
        });
        return;
      case "tool_execution_update":
        publishEvent(event);
        return;
      case "tool_execution_end":
        publishEvent(event);
        return;
    }
  }

  /** 刷新副作用开始事实，失败时封存 Session 且不执行副作用。 */
  async function appendToolExecutionStarted(
    currentRun: ActiveRunOwnership,
    toolCall: AssistantToolCallPart,
    toolApprovalRequestId: string,
  ): Promise<void> {
    if (
      toolCall.toolName !== "edit_file" &&
      toolCall.toolName !== "write_file" &&
      toolCall.toolName !== "execute_command"
    ) {
      throw new Error("副作用 Tool 名称无效。");
    }
    try {
      await currentRun.sessionLease.appendToolExecutionStarted({
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        toolApprovalRequestId,
      });
    } catch {
      currentRun.sessionWriteFailed = true;
      sessionUnavailableResult = SESSION_FAILED_RESULT;
      lastError = SAFE_SESSION_ERROR;
      throw new Error(SAFE_SESSION_ERROR);
    }
  }

  /** 先刷新完成消息，再更新内存投影并发布结束事件。 */
  async function appendCompletedMessage(
    currentRun: ActiveRunOwnership,
    message: Message,
    messageStartAlreadyPublished: boolean,
  ): Promise<void> {
    try {
      await currentRun.sessionLease.appendMessage(message);
    } catch {
      currentRun.sessionWriteFailed = true;
      sessionUnavailableResult = SESSION_FAILED_RESULT;
      lastError = SAFE_SESSION_ERROR;
      throw new Error(SAFE_SESSION_ERROR);
    }
    messageHistory.push(message);
    if (!messageStartAlreadyPublished) {
      publishEvent({ type: "message_start", message });
    }
    publishEvent({ type: "message_end", message });
  }

  /** 将当前 Run 收敛到唯一终态。 */
  function finishRun(
    currentRun: ActiveRunOwnership,
    requestedResult: FinishedPromptResult,
  ): Promise<FinishedPromptResult> {
    if (currentRun.terminalResultPromise !== null) {
      return currentRun.terminalResultPromise;
    }
    currentRun.terminalResultPromise = finalizeRun(currentRun, requestedResult);
    return currentRun.terminalResultPromise;
  }

  /** 写入唯一 RunFinishedRecord，交付 run_end 后释放 Session 所有权。 */
  async function finalizeRun(
    currentRun: ActiveRunOwnership,
    requestedResult: FinishedPromptResult,
  ): Promise<FinishedPromptResult> {
    let finalResult = requestedResult;
    resolvePendingToolApproval(currentRun, "aborted");
    activeAssistantMessage = null;
    if (finalResult.status === "failed") {
      lastError = finalResult.error;
    }

    try {
      if (currentRun.sessionWriteFailed) {
        throw new Error(SAFE_SESSION_ERROR);
      }
      const metrics = createRunMetrics(currentRun);
      await currentRun.sessionLease.appendRunFinished(
        finalResult.status === "budget_exhausted"
          ? {
              status: "budget_exhausted",
              budgetKind: finalResult.budget,
              modelRequestCount: metrics.modelRequestCount,
              toolCallCount: metrics.producedToolCallCount,
              processedToolCallCount: metrics.processedToolCallCount,
              activeDurationMilliseconds: metrics.activeDurationMilliseconds,
              modelUsage: currentRun.cumulativeModelUsage,
            }
          : {
              status: finalResult.status,
              modelRequestCount: metrics.modelRequestCount,
              toolCallCount: metrics.producedToolCallCount,
              processedToolCallCount: metrics.processedToolCallCount,
              activeDurationMilliseconds: metrics.activeDurationMilliseconds,
              modelUsage: currentRun.cumulativeModelUsage,
            },
      );
    } catch {
      finalResult = SESSION_FAILED_RESULT;
      lastError = finalResult.error;
      sessionUnavailableResult = SESSION_FAILED_RESULT;
    }

    // activeRun 保留到 run_end 同步交付后，阻止终态订阅者重入 prompt。
    publishEvent({
      type: "run_end",
      runId: currentRun.runId,
      result: finalResult,
      metrics: createRunMetrics(currentRun),
    });
    try {
      await currentRun.sessionLease.release();
    } catch {
      sessionUnavailableResult = SESSION_RELEASE_FAILED_RESULT;
      lastError = SAFE_SESSION_RELEASE_ERROR;
    } finally {
      if (activeRun === currentRun) {
        activeRun = null;
      }
    }
    return finalResult;
  }

  return Object.freeze({
    get state() {
      return createStateSnapshot();
    },
    prompt: submitPrompt,
    respondToToolApproval,
    abort: abortActiveRun,
    subscribe: subscribeToEvents,
  });
}

/** 形成 run_end 对三类预算的不可变最终计量。 */
function createRunMetrics(currentRun: ActiveRunOwnership): RunMetrics {
  return Object.freeze({
    modelRequestCount: currentRun.modelRequestCount,
    producedToolCallCount: currentRun.observedToolCallCount,
    processedToolCallCount: currentRun.processedToolCallCount,
    activeDurationMilliseconds: Math.max(0, Math.round(currentRun.activeDurationMilliseconds)),
  });
}

/** 把内部 Loop 终态复制为由 Run Module 拥有的公开结果。 */
function toFinishedPromptResult(loopResult: AgentLoopResult): FinishedPromptResult {
  switch (loopResult.status) {
    case "completed":
      return Object.freeze({ status: "completed" });
    case "aborted":
      return Object.freeze({ status: "aborted" });
    case "failed":
      return Object.freeze({ status: "failed", error: loopResult.error });
    case "budget_exhausted":
      return Object.freeze({
        status: "budget_exhausted",
        budget: loopResult.budget,
      });
  }
}
