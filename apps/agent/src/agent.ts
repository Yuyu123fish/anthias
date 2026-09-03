import { randomUUID } from "node:crypto";
import {
  executePreparedCommand,
  type PreparedCommandTool,
  prepareCommandTool,
} from "./command-tool.js";
import {
  executePreparedFileTool,
  isFileToolName,
  type PreparedFileTool,
  prepareFileTool,
} from "./file-tool.js";
import type { Session, SessionRunLease } from "./session.js";
import {
  createCodingSystemPrompt,
  executeReadOnlyTool,
  FIXED_TOOL_DEFINITIONS,
  isReadOnlyToolName,
  type ModelToolDefinition,
} from "./tools.js";

/** 表示一条已经被 Agent 接受的用户文本消息。 */
export type UserMessage = Readonly<{
  role: "user";
  content: string;
}>;

/** 表示 AssistantMessage 中按模型产生顺序保存的文本 part。 */
export type AssistantTextPart = Readonly<{
  type: "text";
  text: string;
}>;

/** 表示 AssistantMessage 中一个已经完整形成的 ToolCall。 */
export type AssistantToolCallPart = Readonly<{
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: unknown;
  invalid: boolean;
}>;

/** 枚举 AssistantMessage 可以持久化的有序内容 part。 */
export type AssistantContentPart = AssistantTextPart | AssistantToolCallPart;

/** 表示活动中或已经终结的一条 Assistant 消息。 */
export type AssistantMessage = Readonly<{
  role: "assistant";
  content: string;
  parts: readonly AssistantContentPart[];
  status: "streaming" | "completed" | "aborted" | "failed";
}>;

/** 表示与一个 ToolCall 一一对应、会进入后续模型上下文的结果消息。 */
export type ToolResultMessage = Readonly<{
  role: "tool";
  toolCallId: string;
  toolName: string;
  status: "completed" | "failed" | "denied" | "aborted" | "unknown";
  content: string;
  truncated: boolean;
}>;

/** 枚举 Agent 对外可见的线性消息。 */
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/** 描述公开状态中当前 Run 的身份、阶段和实际预算用量。 */
export type ActiveRun = Readonly<{
  runId: string;
  phase: "requesting_model" | "awaiting_tool_approval" | "executing_tool";
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

/** 描述当前唯一等待用户决定的副作用 ToolCall。 */
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
      result: ToolResultMessage;
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

/** 表示送入 Model Adapter 的一条 Agent 自有消息。 */
export type ModelInputMessage =
  | Readonly<{ role: "user"; content: string }>
  | Readonly<{ role: "assistant"; content: readonly AssistantContentPart[] }>
  | ToolResultMessage;

/** 描述一次 Model Adapter 调用需要的完整 Agent 自有输入。 */
export type ModelRequest = Readonly<{
  systemPrompt: string;
  messages: readonly ModelInputMessage[];
  tools: readonly ModelToolDefinition[];
}>;

/** 保存一次模型请求可以累加到 Run 的标准化用量。 */
export type ModelUsage = Readonly<{
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}>;

/** 枚举 Agent 理解的模型完成原因。 */
export type ModelFinishReason =
  | "stop"
  | "tool_calls"
  | "length"
  | "content_filter"
  | "error"
  | "other";

/** 枚举生产 Adapter 和确定性测试 Adapter 产生的结构化事件。 */
export type ModelStreamEvent =
  | Readonly<{ type: "text_delta"; delta: string }>
  | Readonly<{
      type: "tool_call";
      toolCallId: string;
      toolName: string;
      input: unknown;
      invalid: boolean;
    }>
  | Readonly<{ type: "finish"; finishReason: ModelFinishReason; usage: ModelUsage }>;

/** 定义可被生产 Adapter 与确定性测试实现替换的结构化模型流。 */
export type ModelStream = (
  modelRequest: ModelRequest,
  abortSignal: AbortSignal,
) => AsyncIterable<ModelStreamEvent>;

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

/** 配置内部 Model Stream 与已打开 Session 的 Agent 装配。 */
export type CreateAgentWithModelStreamOptions = Readonly<{
  modelStream: ModelStream;
  session: Session;
}>;

/** 保存当前模型流正在累积的可变 Assistant 消息。 */
type MutableAssistantMessage = {
  role: "assistant";
  content: string;
  parts: AssistantContentPart[];
  status: "streaming" | "completed" | "aborted" | "failed";
};

/** 集中持有一个活动 Run 的取消、Session lease、预算与唯一终态。 */
type ActiveRunOwnership = {
  runId: string;
  phase: ActiveRun["phase"];
  sessionLease: SessionRunLease;
  abortController: AbortController;
  abortReason: "user" | "active_duration" | null;
  responseIterator: AsyncIterator<ModelStreamEvent> | null;
  modelRequestCount: number;
  observedToolCallCount: number;
  processedToolCallCount: number;
  cumulativeModelUsage: ModelUsage;
  activeDurationMilliseconds: number;
  activePhaseStartedAtMilliseconds: number | null;
  activeDurationTimer: NodeJS.Timeout | null;
  sessionWriteFailed: boolean;
  terminalResult: FinishedPromptResult | null;
  terminalResultPromise: Promise<FinishedPromptResult> | null;
};

/** 表示一次模型请求已经持久化的 Assistant 及其完成原因。 */
type AssistantRequestResult = Readonly<{
  message: AssistantMessage;
  finishReason: ModelFinishReason | null;
}>;

/** 枚举已经完成无副作用预检、可以请求确认的 Tool。 */
type PreparedSideEffectTool = PreparedCommandTool | PreparedFileTool;

/** 持有当前确认 Promise 的唯一解决入口和对应请求。 */
type PendingToolApproval = Readonly<{
  runId: string;
  request: ToolApprovalRequest;
  resolve(decision: "approve" | "deny" | "aborted"): void;
}>;

const ABORT_SIGNAL_RECEIVED = Symbol("abort-signal-received");
const SAFE_MODEL_ERROR = "模型请求失败，请检查模型配置或稍后重试。";
const SAFE_SESSION_ERROR = "Session 写入失败，请检查本地存储后重试。";
const SAFE_SESSION_RELEASE_ERROR = "Session 资源释放失败，已停止继续写入；请重新打开 Session。";
const UNKNOWN_MODEL_USAGE = Object.freeze({
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
} satisfies ModelUsage);
const MODEL_REQUEST_LIMIT = 12;
const TOOL_CALL_LIMIT = 32;
const ACTIVE_DURATION_LIMIT_MILLISECONDS = 30 * 60 * 1000;

const SESSION_FAILED_RESULT = Object.freeze({
  status: "failed",
  error: SAFE_SESSION_ERROR,
} as const);
const SESSION_RELEASE_FAILED_RESULT = Object.freeze({
  status: "failed",
  error: SAFE_SESSION_RELEASE_ERROR,
} as const);
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
const COMPLETED_PROMPT_RESULT = Object.freeze({ status: "completed" } as const);
const ABORTED_PROMPT_RESULT = Object.freeze({ status: "aborted" } as const);
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

/** 使用内部 Model Stream 与已打开 Session 创建 Agent。 */
export function createAgentWithModelStream({
  modelStream,
  session,
}: CreateAgentWithModelStreamOptions): Agent {
  const messageHistory: Message[] = session.messageHistory.map(snapshotMessage);
  const eventListeners = new Set<AgentListener>();
  let activeAssistantMessage: MutableAssistantMessage | null = null;
  let lastError: string | null = null;
  let activeRun: ActiveRunOwnership | null = null;
  let sessionUnavailableResult: FinishedPromptResult | null = null;
  let sessionLeaseAcquisitionPending = false;
  let sessionChanged = false;
  let pendingToolApproval: PendingToolApproval | null = null;

  /** 生成只读状态快照，避免调用者通过保留引用修改 Agent 内部消息。 */
  function createStateSnapshot(): AgentState {
    return Object.freeze({
      sessionId: session.sessionId,
      workspaceRoot: session.workspaceRoot,
      messageHistory: Object.freeze(messageHistory.map(snapshotMessage)),
      activeAssistantMessage: activeAssistantMessage
        ? snapshotAssistantMessage(activeAssistantMessage)
        : null,
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

  /** 按注册顺序同步发布事件，并隔离订阅者异常对 Agent Loop 的影响。 */
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

  /** 请求中止当前 Run，实际终结继续由统一收口路径完成。 */
  function abortActiveRun(): void {
    const currentRun = activeRun;
    if (currentRun === null || currentRun.abortController.signal.aborted) {
      return;
    }
    currentRun.abortReason = "user";
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

  /** 解决当前 Run 唯一待决确认；晚到或其他 Run 的请求保持不变。 */
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

  /** 发布准确预览并等待当前 ToolCall 的一次性批准、拒绝或停止。 */
  function waitForToolApproval(
    currentRun: ActiveRunOwnership,
    toolCall: AssistantToolCallPart,
    preparedTool: PreparedSideEffectTool,
  ): Promise<Readonly<{ request: ToolApprovalRequest; decision: "approve" | "deny" | "aborted" }>> {
    pauseActivePhase(currentRun);
    currentRun.phase = "awaiting_tool_approval";
    const request: ToolApprovalRequest = Object.freeze({
      toolApprovalRequestId: randomUUID(),
      toolCallId: toolCall.toolCallId,
      toolName: preparedTool.toolName,
      target: preparedTool.target,
      preview: preparedTool.preview,
    });
    return new Promise((resolve) => {
      pendingToolApproval = Object.freeze({
        runId: currentRun.runId,
        request,
        resolve: (decision) => resolve(Object.freeze({ request, decision })),
      });
      publishEvent({ type: "tool_approval_requested", request });
      if (currentRun.abortController.signal.aborted) {
        resolvePendingToolApproval(currentRun, "aborted");
      }
    });
  }

  /** 开始累计模型请求或 Tool 执行活动时间，并为剩余预算建立唯一计时器。 */
  function beginActivePhase(currentRun: ActiveRunOwnership, phase: ActiveRun["phase"]): boolean {
    pauseActivePhase(currentRun);
    if (currentRun.abortController.signal.aborted) {
      return false;
    }
    const remainingMilliseconds = remainingActiveDurationMilliseconds(currentRun);
    if (remainingMilliseconds <= 0) {
      exhaustActiveDuration(currentRun);
      return false;
    }
    currentRun.phase = phase;
    currentRun.activePhaseStartedAtMilliseconds = Date.now();
    currentRun.activeDurationTimer = setTimeout(
      () => exhaustActiveDuration(currentRun),
      remainingMilliseconds,
    );
    return true;
  }

  /** 暂停活动时长累计；确认等待和持久化耗时不会消耗该预算。 */
  function pauseActivePhase(currentRun: ActiveRunOwnership): void {
    const phaseStartedAtMilliseconds = currentRun.activePhaseStartedAtMilliseconds;
    if (phaseStartedAtMilliseconds !== null) {
      currentRun.activeDurationMilliseconds = Math.min(
        ACTIVE_DURATION_LIMIT_MILLISECONDS,
        currentRun.activeDurationMilliseconds +
          Math.max(0, Date.now() - phaseStartedAtMilliseconds),
      );
      currentRun.activePhaseStartedAtMilliseconds = null;
    }
    if (currentRun.activeDurationTimer !== null) {
      clearTimeout(currentRun.activeDurationTimer);
      currentRun.activeDurationTimer = null;
    }
  }

  /** 计算当前 Run 尚可用于模型请求或 Tool 执行的活动毫秒数。 */
  function remainingActiveDurationMilliseconds(currentRun: ActiveRunOwnership): number {
    const activeElapsedMilliseconds =
      currentRun.activePhaseStartedAtMilliseconds === null
        ? 0
        : Math.max(0, Date.now() - currentRun.activePhaseStartedAtMilliseconds);
    return Math.max(
      0,
      ACTIVE_DURATION_LIMIT_MILLISECONDS -
        currentRun.activeDurationMilliseconds -
        activeElapsedMilliseconds,
    );
  }

  /** 让活动时长预算成为根取消的唯一首个原因。 */
  function exhaustActiveDuration(currentRun: ActiveRunOwnership): void {
    if (currentRun.abortController.signal.aborted) {
      return;
    }
    pauseActivePhase(currentRun);
    currentRun.activeDurationMilliseconds = ACTIVE_DURATION_LIMIT_MILLISECONDS;
    currentRun.abortReason = "active_duration";
    currentRun.abortController.abort();
  }

  /** 将根取消原因映射成公开的用户停止或活动预算终态。 */
  function getAbortPromptResult(currentRun: ActiveRunOwnership): FinishedPromptResult {
    return currentRun.abortReason === "active_duration"
      ? ACTIVE_DURATION_BUDGET_RESULT
      : ABORTED_PROMPT_RESULT;
  }

  /** 接纳提示词并推进 Model → Tool → Model，直到进入唯一终态。 */
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
      abortReason: null,
      responseIterator: null,
      modelRequestCount: 0,
      observedToolCallCount: 0,
      processedToolCallCount: 0,
      cumulativeModelUsage: Object.freeze({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }),
      activeDurationMilliseconds: 0,
      activePhaseStartedAtMilliseconds: null,
      activeDurationTimer: null,
      sessionWriteFailed: false,
      terminalResult: null,
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
      const requestedResult = await executeModelToolLoop(currentRun);
      return finishRun(currentRun, requestedResult);
    } catch {
      return finishRun(
        currentRun,
        currentRun.abortController.signal.aborted
          ? getAbortPromptResult(currentRun)
          : Object.freeze({ status: "failed", error: SAFE_MODEL_ERROR }),
      );
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
    currentRun.terminalResult = failedResult;
    lastError = failedResult.status === "failed" ? failedResult.error : SAFE_SESSION_ERROR;
    sessionUnavailableResult = failedResult;
    if (activeRun === currentRun) {
      activeRun = null;
    }
    return failedResult;
  }

  /** 推进多次模型请求和串行 ToolCall，并只返回尚未持久化的 Run 终态。 */
  async function executeModelToolLoop(
    currentRun: ActiveRunOwnership,
  ): Promise<FinishedPromptResult> {
    while (true) {
      if (currentRun.abortController.signal.aborted) {
        return getAbortPromptResult(currentRun);
      }
      if (currentRun.modelRequestCount >= MODEL_REQUEST_LIMIT) {
        return MODEL_BUDGET_RESULT;
      }
      if (!beginActivePhase(currentRun, "requesting_model")) {
        return getAbortPromptResult(currentRun);
      }

      const assistantRequest = await requestAssistantMessage(currentRun);
      if (assistantRequest.message.status === "aborted") {
        await appendUnresolvedToolResults(currentRun, assistantRequest.message, "aborted");
        return getAbortPromptResult(currentRun);
      }
      if (assistantRequest.message.status === "failed") {
        await appendUnresolvedToolResults(currentRun, assistantRequest.message, "aborted");
        return Object.freeze({ status: "failed", error: SAFE_MODEL_ERROR });
      }

      const toolCalls = assistantRequest.message.parts.filter(isToolCallPart);
      currentRun.observedToolCallCount += toolCalls.length;
      if (toolCalls.length === 0) {
        return assistantRequest.finishReason === "stop"
          ? COMPLETED_PROMPT_RESULT
          : Object.freeze({ status: "failed", error: SAFE_MODEL_ERROR });
      }
      if (assistantRequest.finishReason !== "tool_calls") {
        await appendToolResults(currentRun, toolCalls, "aborted", "模型未正常结束 ToolCall。");
        return Object.freeze({ status: "failed", error: SAFE_MODEL_ERROR });
      }

      for (let toolIndex = 0; toolIndex < toolCalls.length; toolIndex += 1) {
        const toolCall = toolCalls[toolIndex];
        if (toolCall === undefined) {
          throw new Error("ToolCall 顺序状态缺失。");
        }
        if (currentRun.processedToolCallCount >= TOOL_CALL_LIMIT) {
          await appendToolResults(
            currentRun,
            toolCalls.slice(toolIndex),
            "failed",
            "Run ToolCall 预算已耗尽，调用未执行。",
          );
          return TOOL_BUDGET_RESULT;
        }
        currentRun.processedToolCallCount += 1;
        await processToolCall(currentRun, toolCall);
        if (currentRun.abortController.signal.aborted) {
          await appendToolResults(
            currentRun,
            toolCalls.slice(toolIndex + 1),
            "aborted",
            "Run 已停止，调用未执行。",
          );
          return getAbortPromptResult(currentRun);
        }
      }
    }
  }

  /** 请求并持久化一条完整 AssistantMessage，Tool 处理只能在其后发生。 */
  async function requestAssistantMessage(
    currentRun: ActiveRunOwnership,
  ): Promise<AssistantRequestResult> {
    currentRun.modelRequestCount += 1;
    const mutableMessage: MutableAssistantMessage = {
      role: "assistant",
      content: "",
      parts: [],
      status: "streaming",
    };
    activeAssistantMessage = mutableMessage;
    publishEvent({ type: "message_start", message: snapshotAssistantMessage(mutableMessage) });
    let finishReason: ModelFinishReason | null = null;
    let finishUsageObserved = false;

    try {
      const modelRequest: ModelRequest = Object.freeze({
        systemPrompt: createCodingSystemPrompt(session.workspaceRoot, session.shell),
        messages: Object.freeze(messageHistory.map(toModelInputMessage)),
        tools: FIXED_TOOL_DEFINITIONS,
      });
      const responseIterator = modelStream(modelRequest, currentRun.abortController.signal)[
        Symbol.asyncIterator
      ]();
      currentRun.responseIterator = responseIterator;
      const toolCallIds = new Set<string>();

      while (finishReason === null) {
        const nextEventResult = await readNextModelEventOrAbort(
          responseIterator,
          currentRun.abortController.signal,
        );
        if (
          nextEventResult === ABORT_SIGNAL_RECEIVED ||
          currentRun.abortController.signal.aborted
        ) {
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
            publishEvent({
              type: "message_update",
              message: snapshotAssistantMessage(mutableMessage),
              delta: modelEvent.delta,
            });
          }
          continue;
        }
        if (modelEvent.type === "tool_call") {
          const normalizedToolCall = normalizeToolCall(modelEvent, toolCallIds);
          toolCallIds.add(normalizedToolCall.toolCallId);
          mutableMessage.parts.push(normalizedToolCall);
          continue;
        }
        finishReason = modelEvent.finishReason;
        finishUsageObserved = true;
        currentRun.cumulativeModelUsage = addModelUsage(
          currentRun.cumulativeModelUsage,
          modelEvent.usage,
        );
        mutableMessage.status = isSuccessfulAssistantFinish(
          finishReason,
          mutableMessage.parts.some(isToolCallPart),
        )
          ? "completed"
          : "failed";
      }
    } catch {
      mutableMessage.status = currentRun.abortController.signal.aborted ? "aborted" : "failed";
    } finally {
      if (!finishUsageObserved) {
        currentRun.cumulativeModelUsage = UNKNOWN_MODEL_USAGE;
      }
      const responseIterator = currentRun.responseIterator;
      currentRun.responseIterator = null;
      await closeResponseIterator(responseIterator);
      pauseActivePhase(currentRun);
    }

    const finalMessage = snapshotAssistantMessage(mutableMessage);
    await appendCompletedMessage(currentRun, finalMessage, true);
    activeAssistantMessage = null;
    return Object.freeze({ message: finalMessage, finishReason });
  }

  /** 执行或拒绝一个 ToolCall，并在下一次模型请求前持久化唯一 ToolResult。 */
  async function processToolCall(
    currentRun: ActiveRunOwnership,
    toolCall: AssistantToolCallPart,
  ): Promise<void> {
    if (isReadOnlyToolName(toolCall.toolName)) {
      await processReadOnlyToolCall(currentRun, toolCall);
      return;
    }
    if (toolCall.toolName === "execute_command") {
      await processCommandToolCall(currentRun, toolCall);
      return;
    }
    if (isFileToolName(toolCall.toolName)) {
      await processFileToolCall(currentRun, toolCall);
      return;
    }

    await appendToolResult(currentRun, toolCall, {
      status: "failed",
      content: toolCall.invalid
        ? `${toolCall.toolName} 输入无法解析或不符合 Schema。`
        : `未知或尚不可执行的 Tool：${toolCall.toolName}`,
      truncated: false,
    });
  }

  /** 自动执行一个只读 Tool，并在结束事件前持久化其唯一结果。 */
  async function processReadOnlyToolCall(
    currentRun: ActiveRunOwnership,
    toolCall: AssistantToolCallPart,
  ): Promise<void> {
    if (!beginActivePhase(currentRun, "executing_tool")) {
      await appendToolResult(currentRun, toolCall, {
        status: "aborted",
        content: "Run 活动执行时长预算已耗尽，Tool 未执行。",
        truncated: false,
      });
      return;
    }
    publishEvent({
      type: "tool_execution_start",
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
    });
    const executionResult = await executeReadOnlyTool(
      toolCall,
      {
        workspaceRoot: session.workspaceRoot,
        sessionDirectory: session.sessionDirectory,
      },
      currentRun.abortController.signal,
    );
    pauseActivePhase(currentRun);
    const status = currentRun.abortController.signal.aborted ? "aborted" : executionResult.status;
    const resultMessage = await appendToolResult(currentRun, toolCall, {
      status,
      content: executionResult.content,
      truncated: executionResult.truncated,
    });
    publishEvent({
      type: "tool_execution_end",
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      result: resultMessage,
      cleanupUncertain: false,
    });
  }

  /** 预检一个文件修改，再交给共享副作用生命周期确认与执行。 */
  async function processFileToolCall(
    currentRun: ActiveRunOwnership,
    toolCall: AssistantToolCallPart,
  ): Promise<void> {
    if (!beginActivePhase(currentRun, "executing_tool")) {
      await appendToolResult(currentRun, toolCall, {
        status: "aborted",
        content: "Run 活动执行时长预算已耗尽，文件未写入。",
        truncated: false,
      });
      return;
    }
    const preparedResult = await prepareFileTool(toolCall, {
      workspaceRoot: session.workspaceRoot,
      sessionDirectory: session.sessionDirectory,
    });
    pauseActivePhase(currentRun);
    if (currentRun.abortController.signal.aborted) {
      await appendToolResult(currentRun, toolCall, {
        status: "aborted",
        content: "Run 已停止，文件未写入。",
        truncated: false,
      });
      return;
    }
    if (!preparedResult.ok) {
      await appendToolResult(currentRun, toolCall, preparedResult.result);
      return;
    }

    await confirmAndExecuteSideEffectTool(
      currentRun,
      toolCall,
      preparedResult.preparedTool,
      `用户拒绝执行 ${preparedResult.preparedTool.toolName}。`,
      "Run 已停止，文件未写入。",
      async (abortSignal) => ({
        ...(await executePreparedFileTool(preparedResult.preparedTool, abortSignal)),
        cleanupUncertain: false,
      }),
    );
  }

  /** 预检一个命令，再交给共享副作用生命周期确认与执行。 */
  async function processCommandToolCall(
    currentRun: ActiveRunOwnership,
    toolCall: AssistantToolCallPart,
  ): Promise<void> {
    if (!beginActivePhase(currentRun, "executing_tool")) {
      await appendToolResult(currentRun, toolCall, {
        status: "aborted",
        content: "Run 活动执行时长预算已耗尽，命令未启动。",
        truncated: false,
      });
      return;
    }
    const preparedResult = await prepareCommandTool(
      toolCall,
      { workspaceRoot: session.workspaceRoot, sessionDirectory: session.sessionDirectory },
      session.shell,
      remainingActiveDurationMilliseconds(currentRun),
    );
    pauseActivePhase(currentRun);
    if (currentRun.abortController.signal.aborted) {
      await appendToolResult(currentRun, toolCall, {
        status: "aborted",
        content: "Run 已停止，命令未启动。",
        truncated: false,
      });
      return;
    }
    if (!preparedResult.ok) {
      await appendToolResult(currentRun, toolCall, preparedResult.result);
      return;
    }

    await confirmAndExecuteSideEffectTool(
      currentRun,
      toolCall,
      preparedResult.preparedTool,
      "用户拒绝执行 execute_command。",
      "Run 已停止，命令未启动。",
      (abortSignal) =>
        executePreparedCommand(preparedResult.preparedTool, abortSignal, (update) => {
          if (!abortSignal.aborted) {
            publishEvent({
              type: "tool_execution_update",
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              stream: update.stream,
              delta: update.delta,
            });
          }
        }),
    );
  }

  /** 统一副作用 Tool 的确认、开始事实、执行与结果收口顺序。 */
  async function confirmAndExecuteSideEffectTool(
    currentRun: ActiveRunOwnership,
    toolCall: AssistantToolCallPart,
    preparedTool: PreparedSideEffectTool,
    deniedContent: string,
    abortedContent: string,
    executePreparedTool: (abortSignal: AbortSignal) => Promise<
      Readonly<{
        status: "completed" | "failed";
        content: string;
        truncated: boolean;
        cleanupUncertain: boolean;
      }>
    >,
  ): Promise<void> {
    const approval = await waitForToolApproval(currentRun, toolCall, preparedTool);
    if (approval.decision !== "approve" || currentRun.abortController.signal.aborted) {
      await appendToolResult(currentRun, toolCall, {
        status: approval.decision === "deny" ? "denied" : "aborted",
        content: approval.decision === "deny" ? deniedContent : abortedContent,
        truncated: false,
      });
      return;
    }

    await appendToolExecutionStarted(currentRun, toolCall, approval.request);
    if (!beginActivePhase(currentRun, "executing_tool")) {
      await appendToolResult(currentRun, toolCall, {
        status: "aborted",
        content: abortedContent,
        truncated: false,
      });
      return;
    }
    publishEvent({
      type: "tool_execution_start",
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
    });

    let executionResult: Awaited<ReturnType<typeof executePreparedTool>>;
    try {
      executionResult = await executePreparedTool(currentRun.abortController.signal);
    } catch {
      executionResult = Object.freeze({
        status: "failed",
        content: "Tool 执行失败。",
        truncated: false,
        cleanupUncertain: preparedTool.toolName === "execute_command",
      });
    } finally {
      pauseActivePhase(currentRun);
    }
    const resultMessage = await appendToolResult(currentRun, toolCall, {
      status: currentRun.abortController.signal.aborted ? "aborted" : executionResult.status,
      content: executionResult.content,
      truncated: executionResult.truncated,
    });
    publishEvent({
      type: "tool_execution_end",
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      result: resultMessage,
      cleanupUncertain: executionResult.cleanupUncertain,
    });
  }

  /** 刷新副作用开始事实；失败时封存 Session，绝不继续本地执行。 */
  async function appendToolExecutionStarted(
    currentRun: ActiveRunOwnership,
    toolCall: AssistantToolCallPart,
    approvalRequest: ToolApprovalRequest,
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
        toolApprovalRequestId: approvalRequest.toolApprovalRequestId,
      });
    } catch {
      currentRun.sessionWriteFailed = true;
      sessionUnavailableResult = SESSION_FAILED_RESULT;
      lastError = SAFE_SESSION_ERROR;
      throw new Error(SAFE_SESSION_ERROR);
    }
  }

  /** 持久化并发布一条 ToolResultMessage。 */
  async function appendToolResult(
    currentRun: ActiveRunOwnership,
    toolCall: AssistantToolCallPart,
    result: Readonly<{
      status: ToolResultMessage["status"];
      content: string;
      truncated: boolean;
    }>,
  ): Promise<ToolResultMessage> {
    const resultMessage: ToolResultMessage = Object.freeze({
      role: "tool",
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      status: result.status,
      content: result.content,
      truncated: result.truncated,
    });
    await appendCompletedMessage(currentRun, resultMessage, false);
    return resultMessage;
  }

  /** 按调用顺序为一组未执行 ToolCall 补齐终结结果。 */
  async function appendToolResults(
    currentRun: ActiveRunOwnership,
    toolCalls: readonly AssistantToolCallPart[],
    status: Extract<ToolResultMessage["status"], "failed" | "aborted">,
    content: string,
  ): Promise<void> {
    for (const toolCall of toolCalls) {
      await appendToolResult(currentRun, toolCall, { status, content, truncated: false });
    }
  }

  /** 为一条异常终止的 AssistantMessage 补齐其全部 ToolResult。 */
  async function appendUnresolvedToolResults(
    currentRun: ActiveRunOwnership,
    assistantMessage: AssistantMessage,
    status: "aborted",
  ): Promise<void> {
    await appendToolResults(
      currentRun,
      assistantMessage.parts.filter(isToolCallPart),
      status,
      "模型请求未正常完成，ToolCall 未执行。",
    );
  }

  /** 先刷新一条已完成消息，再更新内存投影并发布结束事件。 */
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
    messageHistory.push(snapshotMessage(message));
    if (!messageStartAlreadyPublished) {
      publishEvent({ type: "message_start", message });
    }
    publishEvent({ type: "message_end", message });
  }

  /** 将当前 Run 收敛到唯一终态，先刷新事实，再同步发布结束事件。 */
  function finishRun(
    currentRun: ActiveRunOwnership,
    requestedResult: FinishedPromptResult,
  ): Promise<FinishedPromptResult> {
    if (currentRun.terminalResultPromise !== null) {
      return currentRun.terminalResultPromise;
    }
    currentRun.terminalResult = requestedResult;
    currentRun.terminalResultPromise = finalizeRun(currentRun, requestedResult);
    return currentRun.terminalResultPromise;
  }

  /** 写入唯一 RunFinishedRecord，交付 run_end 后释放 Session 所有权。 */
  async function finalizeRun(
    currentRun: ActiveRunOwnership,
    requestedResult: FinishedPromptResult,
  ): Promise<FinishedPromptResult> {
    let finalResult = requestedResult;
    pauseActivePhase(currentRun);
    resolvePendingToolApproval(currentRun, "aborted");
    activeAssistantMessage = null;
    await closeResponseIterator(currentRun.responseIterator);
    currentRun.responseIterator = null;
    if (finalResult.status === "failed") {
      lastError = finalResult.error;
    }
    try {
      if (currentRun.sessionWriteFailed) {
        throw new Error(SAFE_SESSION_ERROR);
      }
      const metrics = Object.freeze({
        modelRequestCount: currentRun.modelRequestCount,
        producedToolCallCount: currentRun.observedToolCallCount,
        processedToolCallCount: currentRun.processedToolCallCount,
        activeDurationMilliseconds: Math.max(0, Math.round(currentRun.activeDurationMilliseconds)),
      } satisfies RunMetrics);
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
      currentRun.terminalResult = finalResult;
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
      currentRun.responseIterator = null;
    } finally {
      try {
        await currentRun.sessionLease.release();
      } catch {
        sessionUnavailableResult = SESSION_RELEASE_FAILED_RESULT;
        lastError = SAFE_SESSION_RELEASE_ERROR;
      }
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
    // 模型流清理失败不能覆盖已经确定并持久化的 Run 终态。
  }
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

/** 累加 Provider 已报告的标准化 usage；任何缺失维度保持未知。 */
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

/** 将内部可变 Assistant 消息复制为只读公开快照。 */
function snapshotAssistantMessage(message: MutableAssistantMessage): AssistantMessage {
  return Object.freeze({
    role: "assistant",
    content: message.content,
    parts: Object.freeze(message.parts.map(snapshotAssistantPart)),
    status: message.status,
  });
}

/** 深复制并冻结一条公开消息。 */
function snapshotMessage(message: Message): Message {
  if (message.role === "user") {
    return Object.freeze({ role: "user", content: message.content });
  }
  if (message.role === "tool") {
    return Object.freeze({ ...message });
  }
  return Object.freeze({
    role: "assistant",
    content: message.content,
    parts: Object.freeze(message.parts.map(snapshotAssistantPart)),
    status: message.status,
  });
}

/** 将线性消息投影成内部 Model Stream 所需的 Provider 无关形状。 */
function toModelInputMessage(message: Message): ModelInputMessage {
  if (message.role === "user") {
    return Object.freeze({ role: "user", content: message.content });
  }
  if (message.role === "tool") {
    return Object.freeze({ ...message });
  }
  return Object.freeze({
    role: "assistant",
    content: Object.freeze(message.parts.map(snapshotAssistantPart)),
  });
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
    /** AbortSignal 触发时先解除监听，再让取消赢得竞速。 */
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

/** 把相邻文本增量合并为一个持久 text part，同时保留 ToolCall 相对顺序。 */
function appendTextPart(parts: AssistantContentPart[], delta: string): void {
  const previousPart = parts.at(-1);
  if (previousPart?.type === "text") {
    parts[parts.length - 1] = Object.freeze({ type: "text", text: previousPart.text + delta });
    return;
  }
  parts.push(Object.freeze({ type: "text", text: delta }));
}

/** 复制并冻结一个 Assistant 内容 part。 */
function snapshotAssistantPart(part: AssistantContentPart): AssistantContentPart {
  return part.type === "text"
    ? Object.freeze({ type: "text", text: part.text })
    : Object.freeze({
        type: "tool_call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: structuredClone(part.input),
        invalid: part.invalid,
      });
}

/** 规范化 ToolCall 身份与 JSON 输入，防止 Provider 值破坏 Session Schema。 */
function normalizeToolCall(
  modelEvent: Extract<ModelStreamEvent, { type: "tool_call" }>,
  existingToolCallIds: ReadonlySet<string>,
): AssistantToolCallPart {
  const toolCallId =
    isUuid(modelEvent.toolCallId) && !existingToolCallIds.has(modelEvent.toolCallId)
      ? modelEvent.toolCallId
      : randomUUID();
  const jsonInput = toJsonValue(modelEvent.input);
  return Object.freeze({
    type: "tool_call",
    toolCallId,
    toolName: modelEvent.toolName,
    input: jsonInput.value,
    invalid: modelEvent.invalid || !jsonInput.valid,
  });
}

/** 判断 Assistant 内容 part 是否为 ToolCall。 */
function isToolCallPart(part: AssistantContentPart): part is AssistantToolCallPart {
  return part.type === "tool_call";
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

/** 把未知输入复制为 JSON 值，无法表示时使用 null 并标记 invalid。 */
function toJsonValue(value: unknown): Readonly<{ valid: boolean; value: unknown }> {
  try {
    const serializedValue = JSON.stringify(value);
    if (serializedValue === undefined) {
      return Object.freeze({ valid: false, value: null });
    }
    return Object.freeze({ valid: true, value: JSON.parse(serializedValue) as unknown });
  } catch {
    return Object.freeze({ valid: false, value: null });
  }
}

/** 判断字符串是否为 Schema 1 接受的 UUID v4。 */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
