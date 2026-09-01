export type UserMessage = Readonly<{
  role: "user";
  content: string;
}>;

export type AssistantMessage = Readonly<{
  role: "assistant";
  content: string;
  status: "streaming" | "completed" | "aborted" | "failed";
}>;

export type Message = UserMessage | AssistantMessage;

export type AgentState = Readonly<{
  messageHistory: readonly Message[];
  activeAssistantMessage: AssistantMessage | null;
  running: boolean;
  lastError: string | null;
}>;

export type FinishedPromptResult =
  | Readonly<{ status: "completed" }>
  | Readonly<{ status: "aborted" }>
  | Readonly<{ status: "failed"; error: string }>;

export type PromptResult =
  | Readonly<{ status: "rejected"; reason: "empty" | "busy" }>
  | FinishedPromptResult;

export type AgentEvent =
  | Readonly<{ type: "agent_start" }>
  | Readonly<{ type: "message_start"; message: Message }>
  | Readonly<{
      type: "message_update";
      message: AssistantMessage;
      delta: string;
    }>
  | Readonly<{ type: "message_end"; message: Message }>
  | Readonly<{ type: "agent_end"; result: FinishedPromptResult }>;

export type ModelInputMessage = Readonly<{
  role: "user" | "assistant";
  content: string;
}>;

export type ModelStream = (
  modelMessages: readonly ModelInputMessage[],
  abortSignal: AbortSignal,
) => AsyncIterable<string>;

export type AgentListener = (event: AgentEvent) => void;

export type Agent = Readonly<{
  readonly state: AgentState;
  prompt(promptText: string): Promise<PromptResult>;
  abort(): void;
  subscribe(listener: AgentListener): () => void;
}>;

export type CreateAgentWithModelStreamOptions = Readonly<{
  modelStream: ModelStream;
}>;

type MutableAssistantMessage = {
  role: "assistant";
  content: string;
  status: "streaming" | "completed" | "aborted" | "failed";
};

type ActiveGeneration = {
  abortController: AbortController;
  assistantMessage: MutableAssistantMessage;
  responseIterator: AsyncIterator<string> | null;
  promptResult: FinishedPromptResult | null;
};

const ABORT_SIGNAL_RECEIVED = Symbol("abort-signal-received");
const SAFE_MODEL_ERROR = "模型请求失败，请检查模型配置或稍后重试。";

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

/** 使用内部 Model Stream 创建内存 Agent；仅供生产装配和 Agent Module 测试使用。 */
export function createAgentWithModelStream({
  modelStream,
}: CreateAgentWithModelStreamOptions): Agent {
  const messageHistory: Message[] = [];
  const eventListeners = new Set<AgentListener>();
  let activeAssistantMessage: MutableAssistantMessage | null = null;
  let lastError: string | null = null;
  let activeGeneration: ActiveGeneration | null = null;

  /** 生成只读状态快照，避免调用者通过保留引用修改 Agent 内部消息。 */
  function createStateSnapshot(): AgentState {
    return Object.freeze({
      messageHistory: Object.freeze([...messageHistory]),
      activeAssistantMessage: activeAssistantMessage
        ? snapshotAssistantMessage(activeAssistantMessage)
        : null,
      running: activeGeneration !== null,
      lastError,
    });
  }

  /** 按注册顺序同步发布事件，并隔离订阅者异常对 Agent Loop 的影响。 */
  function publishEvent(event: AgentEvent): void {
    const eventSnapshot = Object.freeze(event);
    for (const listener of [...eventListeners]) {
      // 订阅者只负责观察；渲染回调的同步异常不能破坏 Agent 的唯一终结路径。
      try {
        void listener(eventSnapshot);
      } catch {
        // Feature 001 不增加第二条监听器错误通道。
      }
    }
  }

  /** 注册事件订阅，并返回可重复调用的取消订阅函数。 */
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

  /** 请求取消当前生成；实际终结仍由统一生成路径完成。 */
  function abortActiveGeneration(): void {
    activeGeneration?.abortController.abort();
  }

  /** 接纳提示词并推进一次完整生成，直到 completed、aborted 或 failed。 */
  async function submitPrompt(promptText: string): Promise<PromptResult> {
    if (promptText.trim().length === 0) {
      return EMPTY_PROMPT_RESULT;
    }
    if (activeGeneration !== null) {
      return BUSY_PROMPT_RESULT;
    }

    lastError = null;
    const abortController = new AbortController();
    const assistantMessage: MutableAssistantMessage = {
      role: "assistant",
      content: "",
      status: "streaming",
    };
    const generation: ActiveGeneration = {
      abortController,
      assistantMessage,
      responseIterator: null,
      promptResult: null,
    };
    activeGeneration = generation;

    const userMessage: UserMessage = Object.freeze({ role: "user", content: promptText });
    messageHistory.push(userMessage);
    publishEvent({ type: "agent_start" });
    publishEvent({ type: "message_start", message: userMessage });
    publishEvent({ type: "message_end", message: userMessage });
    activeAssistantMessage = assistantMessage;
    publishEvent({
      type: "message_start",
      message: snapshotAssistantMessage(assistantMessage),
    });

    if (abortController.signal.aborted) {
      return finishGeneration(generation, ABORTED_PROMPT_RESULT);
    }

    try {
      const modelMessages = Object.freeze(messageHistory.map(toModelInputMessage));
      // 拿到异步迭代器，通过while循环，不断读取模型流中的数据，直到迭代器结束。
      const responseIterator = modelStream(modelMessages, abortController.signal)[
        Symbol.asyncIterator
      ]();
      generation.responseIterator = responseIterator;

      while (true) {
        const nextChunkResult = await readNextChunkOrAbort(
          responseIterator,
          abortController.signal,
        );
        if (nextChunkResult === ABORT_SIGNAL_RECEIVED || abortController.signal.aborted) {
          return finishGeneration(generation, ABORTED_PROMPT_RESULT);
        }
        if (nextChunkResult.done) {
          return finishGeneration(generation, COMPLETED_PROMPT_RESULT);
        }
        if (
          nextChunkResult.value.length === 0 ||
          generation.promptResult !== null ||
          activeGeneration !== generation
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
        return finishGeneration(generation, ABORTED_PROMPT_RESULT);
      }
      return finishGeneration(
        generation,
        Object.freeze({ status: "failed", error: SAFE_MODEL_ERROR }),
      );
    }
  }

  /** 将当前生成收敛到唯一终态，发布结束事件并释放活动资源。 */
  function finishGeneration(
    generation: ActiveGeneration,
    promptResult: FinishedPromptResult,
  ): FinishedPromptResult {
    // 完成、失败、取消可能相邻发生；第一次进入终态后，其余路径只能读取既有结果。
    if (generation.promptResult !== null) {
      return generation.promptResult;
    }
    generation.promptResult = promptResult;

    generation.assistantMessage.status = promptResult.status;
    const finalAssistantMessage = snapshotAssistantMessage(generation.assistantMessage);
    messageHistory.push(finalAssistantMessage);
    activeAssistantMessage = null;
    if (promptResult.status === "failed") {
      lastError = promptResult.error;
    }

    const responseIterator = generation.responseIterator;
    generation.responseIterator = null;

    // 保留 activeGeneration 直到 agent_end 已同步交付，避免订阅者重入 prompt 打断事件骨架。
    publishEvent({ type: "message_end", message: finalAssistantMessage });
    publishEvent({ type: "agent_end", result: promptResult });

    if (promptResult.status === "aborted" && responseIterator?.return) {
      // AbortSignal 负责立即取消底层请求；return 只做不阻塞终态的迭代器收尾。
      void responseIterator.return().catch(() => undefined);
    }
    if (activeGeneration === generation) {
      activeGeneration = null;
    }
    return promptResult;
  }

  return Object.freeze({
    get state() {
      return createStateSnapshot();
    },
    prompt: submitPrompt,
    abort: abortActiveGeneration,
    subscribe: subscribeToEvents,
  });
}

/** 将内部可变 Assistant 消息复制为可公开的只读快照。 */
function snapshotAssistantMessage(message: MutableAssistantMessage): AssistantMessage {
  return Object.freeze({
    role: "assistant",
    content: message.content,
    status: message.status,
  });
}

/** 将领域消息收敛为模型只需要的 role 与 content。 */
function toModelInputMessage(message: Message): ModelInputMessage {
  return Object.freeze({ role: message.role, content: message.content });
}

/** 在模型增量与 AbortSignal 之间竞速，使取消不依赖底层迭代器主动结束。 */
function readNextChunkOrAbort(
  responseIterator: AsyncIterator<string>,
  abortSignal: AbortSignal,
): Promise<IteratorResult<string> | typeof ABORT_SIGNAL_RECEIVED> {
  if (abortSignal.aborted) {
    return Promise.resolve(ABORT_SIGNAL_RECEIVED);
  }

  // 某些迭代器不会立即响应 AbortSignal；竞速可让 Agent 先进入唯一中止终态。
  return new Promise((resolve, reject) => {
    const handleAbort = () => {
      removeAbortListener();
      resolve(ABORT_SIGNAL_RECEIVED);
    };
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
