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

export type CreateAgentOptions = Readonly<{
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

export function createAgent({ modelStream }: CreateAgentOptions): Agent {
  const messageHistory: Message[] = [];
  const eventListeners = new Set<AgentListener>();
  let activeAssistantMessage: MutableAssistantMessage | null = null;
  let lastError: string | null = null;
  let activeGeneration: ActiveGeneration | null = null;

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

  function abortActiveGeneration(): void {
    activeGeneration?.abortController.abort();
  }

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

function snapshotAssistantMessage(message: MutableAssistantMessage): AssistantMessage {
  return Object.freeze({
    role: "assistant",
    content: message.content,
    status: message.status,
  });
}

function toModelInputMessage(message: Message): ModelInputMessage {
  return Object.freeze({ role: message.role, content: message.content });
}

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
