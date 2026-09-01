import { randomUUID } from "node:crypto";
import type { Session } from "./session.js";

/** 表示一条已经被 Agent 接受的用户文本消息。 */
export type UserMessage = Readonly<{
  role: "user";
  content: string;
}>;

/** 表示活动中或已经终结的一条 Assistant 文本消息。 */
export type AssistantMessage = Readonly<{
  role: "assistant";
  content: string;
  status: "streaming" | "completed" | "aborted" | "failed";
}>;

/** 枚举 Stage 01 对外可见的线性消息。 */
export type Message = UserMessage | AssistantMessage;

/** 描述公开状态中当前文本 Run 的身份与阶段。 */
export type ActiveRun = Readonly<{
  runId: string;
  phase: "requesting_model";
}>;

/** 提供交互 Adapter 可读取但不能修改的 Agent 状态快照。 */
export type AgentState = Readonly<{
  sessionId: string;
  workspaceRoot: string;
  messageHistory: readonly Message[];
  activeAssistantMessage: AssistantMessage | null;
  activeRun: ActiveRun | null;
  running: boolean;
  lastError: string | null;
}>;

/** 枚举一个已接受文本 Run 的公开终态。 */
export type FinishedPromptResult =
  | Readonly<{ status: "completed" }>
  | Readonly<{ status: "aborted" }>
  | Readonly<{ status: "failed"; error: string }>;

/** 表示提示词被拒绝或完成一次 Run 后的结果。 */
export type PromptResult =
  | Readonly<{ status: "rejected"; reason: "empty" | "busy" }>
  | FinishedPromptResult;

/** 枚举 Agent 按实际发生顺序同步发布的瞬时事件。 */
export type AgentEvent =
  | Readonly<{ type: "run_start" }>
  | Readonly<{ type: "message_start"; message: Message }>
  | Readonly<{
      type: "message_update";
      message: AssistantMessage;
      delta: string;
    }>
  | Readonly<{ type: "message_end"; message: Message }>
  | Readonly<{ type: "run_end"; result: FinishedPromptResult }>;

/** 表示 Stage 01 传给内部 Model Stream 的最小消息。 */
export type ModelInputMessage = Readonly<{
  role: "user" | "assistant";
  content: string;
}>;

/** 定义可被生产 Adapter 与确定性测试实现替换的文本模型流。 */
export type ModelStream = (
  modelMessages: readonly ModelInputMessage[],
  abortSignal: AbortSignal,
) => AsyncIterable<string>;

/** 定义同步观察 AgentEvent 的监听器。 */
export type AgentListener = (event: AgentEvent) => void;

/** 暴露交互 Adapter 操作 Agent 所需的最小公开 Interface。 */
export type Agent = Readonly<{
  readonly state: AgentState;
  prompt(promptText: string): Promise<PromptResult>;
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
  status: "streaming" | "completed" | "aborted" | "failed";
};

/** 集中持有一个活动文本 Run 的取消、模型流与唯一终态。 */
type ActiveRunOwnership = {
  runId: string;
  phase: "requesting_model";
  startedAtMilliseconds: number;
  abortController: AbortController;
  assistantMessage: MutableAssistantMessage;
  responseIterator: AsyncIterator<string> | null;
  modelRequestCount: number;
  terminalResult: FinishedPromptResult | null;
  terminalResultPromise: Promise<FinishedPromptResult> | null;
};

const ABORT_SIGNAL_RECEIVED = Symbol("abort-signal-received");
const SAFE_MODEL_ERROR = "模型请求失败，请检查模型配置或稍后重试。";
const SAFE_SESSION_ERROR = "Session 写入失败，请检查本地存储后重试。";
const SESSION_FAILED_RESULT = Object.freeze({
  status: "failed",
  error: SAFE_SESSION_ERROR,
} as const);

const EMPTY_PROMPT_RESULT = Object.freeze({
  status: "rejected",
  reason: "empty",
} as const);
const BUSY_PROMPT_RESULT = Object.freeze({
  status: "rejected",
  reason: "busy",
} as const);
const COMPLETED_PROMPT_RESULT = Object.freeze({ status: "completed" } as const);
const ABORTED_PROMPT_RESULT = Object.freeze({ status: "aborted" } as const);

/** 使用内部 Model Stream 与已打开 Session 创建 Agent。 */
export function createAgentWithModelStream({
  modelStream,
  session,
}: CreateAgentWithModelStreamOptions): Agent {
  const messageHistory: Message[] = [...session.messageHistory];
  const eventListeners = new Set<AgentListener>();
  let activeAssistantMessage: MutableAssistantMessage | null = null;
  let lastError: string | null = null;
  let activeRun: ActiveRunOwnership | null = null;
  let sessionUnavailable = false;

  /** 生成只读状态快照，避免调用者通过保留引用修改 Agent 内部消息。 */
  function createStateSnapshot(): AgentState {
    return Object.freeze({
      sessionId: session.sessionId,
      workspaceRoot: session.workspaceRoot,
      messageHistory: Object.freeze([...messageHistory]),
      activeAssistantMessage: activeAssistantMessage
        ? snapshotAssistantMessage(activeAssistantMessage)
        : null,
      activeRun: activeRun
        ? Object.freeze({ runId: activeRun.runId, phase: activeRun.phase })
        : null,
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
    activeRun?.abortController.abort();
  }

  /** 接纳提示词并推进一次文本 Run，直到 completed、aborted 或 failed。 */
  async function submitPrompt(promptText: string): Promise<PromptResult> {
    if (promptText.trim().length === 0) {
      return EMPTY_PROMPT_RESULT;
    }
    if (activeRun !== null) {
      return BUSY_PROMPT_RESULT;
    }
    if (sessionUnavailable) {
      return SESSION_FAILED_RESULT;
    }

    lastError = null;
    const abortController = new AbortController();
    const assistantMessage: MutableAssistantMessage = {
      role: "assistant",
      content: "",
      status: "streaming",
    };
    const currentRun: ActiveRunOwnership = {
      runId: randomUUID(),
      phase: "requesting_model",
      startedAtMilliseconds: Date.now(),
      abortController,
      assistantMessage,
      responseIterator: null,
      modelRequestCount: 0,
      terminalResult: null,
      terminalResultPromise: null,
    };
    activeRun = currentRun;

    const userMessage: UserMessage = Object.freeze({ role: "user", content: promptText });
    try {
      // UserMessage 刷新成功后 Run 才算被接受，后续事件与副作用才能开始。
      await session.appendMessage(currentRun.runId, userMessage);
    } catch {
      const failedResult = SESSION_FAILED_RESULT;
      currentRun.terminalResult = failedResult;
      lastError = failedResult.error;
      sessionUnavailable = true;
      if (activeRun === currentRun) {
        activeRun = null;
      }
      return failedResult;
    }

    messageHistory.push(userMessage);
    publishEvent({ type: "run_start" });
    publishEvent({ type: "message_start", message: userMessage });
    publishEvent({ type: "message_end", message: userMessage });
    activeAssistantMessage = assistantMessage;
    publishEvent({
      type: "message_start",
      message: snapshotAssistantMessage(assistantMessage),
    });

    if (abortController.signal.aborted) {
      return finishRun(currentRun, ABORTED_PROMPT_RESULT);
    }

    try {
      const modelMessages = Object.freeze(messageHistory.map(toModelInputMessage));
      currentRun.modelRequestCount = 1;
      const responseIterator = modelStream(modelMessages, abortController.signal)[
        Symbol.asyncIterator
      ]();
      currentRun.responseIterator = responseIterator;

      while (true) {
        const nextChunkResult = await readNextChunkOrAbort(
          responseIterator,
          abortController.signal,
        );
        if (nextChunkResult === ABORT_SIGNAL_RECEIVED || abortController.signal.aborted) {
          return finishRun(currentRun, ABORTED_PROMPT_RESULT);
        }
        if (nextChunkResult.done) {
          return finishRun(currentRun, COMPLETED_PROMPT_RESULT);
        }
        if (
          nextChunkResult.value.length === 0 ||
          currentRun.terminalResult !== null ||
          activeRun !== currentRun
        ) {
          continue;
        }

        assistantMessage.content += nextChunkResult.value;
        publishEvent({
          type: "message_update",
          message: snapshotAssistantMessage(assistantMessage),
          delta: nextChunkResult.value,
        });
      }
    } catch {
      if (abortController.signal.aborted) {
        return finishRun(currentRun, ABORTED_PROMPT_RESULT);
      }
      return finishRun(currentRun, Object.freeze({ status: "failed", error: SAFE_MODEL_ERROR }));
    }
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

  /** 刷新最终消息和终态记录，再发布唯一 run_end 并释放所有权。 */
  async function finalizeRun(
    currentRun: ActiveRunOwnership,
    requestedResult: FinishedPromptResult,
  ): Promise<FinishedPromptResult> {
    let finalResult = requestedResult;
    currentRun.assistantMessage.status = finalResult.status;
    let finalAssistantMessage = snapshotAssistantMessage(currentRun.assistantMessage);
    let assistantMessagePersisted = false;

    try {
      await session.appendMessage(currentRun.runId, finalAssistantMessage);
      assistantMessagePersisted = true;
    } catch {
      finalResult = SESSION_FAILED_RESULT;
      currentRun.terminalResult = finalResult;
      currentRun.assistantMessage.status = "failed";
      finalAssistantMessage = snapshotAssistantMessage(currentRun.assistantMessage);
      sessionUnavailable = true;
    }

    activeAssistantMessage = null;
    if (finalResult.status === "failed") {
      lastError = finalResult.error;
    }

    const responseIterator = currentRun.responseIterator;
    currentRun.responseIterator = null;
    if (assistantMessagePersisted) {
      messageHistory.push(finalAssistantMessage);
      publishEvent({ type: "message_end", message: finalAssistantMessage });

      try {
        await session.appendRunFinished(currentRun.runId, {
          status: finalResult.status,
          modelRequestCount: currentRun.modelRequestCount,
          toolCallCount: 0,
          activeDurationMilliseconds: Math.max(0, Date.now() - currentRun.startedAtMilliseconds),
        });
      } catch {
        finalResult = SESSION_FAILED_RESULT;
        currentRun.terminalResult = finalResult;
        lastError = finalResult.error;
        sessionUnavailable = true;
      }
    }

    // activeRun 保留到 run_end 同步交付后，阻止终态订阅者重入 prompt。
    publishEvent({ type: "run_end", result: finalResult });

    if (requestedResult.status !== "completed") {
      closeResponseIterator(responseIterator);
    }
    if (activeRun === currentRun) {
      activeRun = null;
    }
    return finalResult;
  }

  return Object.freeze({
    get state() {
      return createStateSnapshot();
    },
    prompt: submitPrompt,
    abort: abortActiveRun,
    subscribe: subscribeToEvents,
  });
}

/** 非阻塞关闭异常终态持有的模型迭代器，并隔离同步或异步清理失败。 */
function closeResponseIterator(responseIterator: AsyncIterator<string> | null): void {
  if (!responseIterator?.return) {
    return;
  }
  try {
    void Promise.resolve(responseIterator.return()).catch(() => undefined);
  } catch {
    // 模型流清理失败不能覆盖已经确定并持久化的 Run 终态。
  }
}

/** 将内部可变 Assistant 消息复制为只读公开快照。 */
function snapshotAssistantMessage(message: MutableAssistantMessage): AssistantMessage {
  return Object.freeze({
    role: "assistant",
    content: message.content,
    status: message.status,
  });
}

/** 将线性消息投影成内部 Model Stream 所需的 role 与文本。 */
function toModelInputMessage(message: Message): ModelInputMessage {
  return Object.freeze({ role: message.role, content: message.content });
}

/** 在下一段模型增量与根 AbortSignal 之间竞速。 */
function readNextChunkOrAbort(
  responseIterator: AsyncIterator<string>,
  abortSignal: AbortSignal,
): Promise<IteratorResult<string> | typeof ABORT_SIGNAL_RECEIVED> {
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
      (nextChunkResult) => {
        removeAbortListener();
        resolve(nextChunkResult);
      },
      (error: unknown) => {
        removeAbortListener();
        reject(error);
      },
    );
  });
}
