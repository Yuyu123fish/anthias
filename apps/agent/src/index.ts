export type UserMessage = Readonly<{
  role: "user";
  content: string;
}>;

export type StreamingAssistantMessage = Readonly<{
  role: "assistant";
  content: string;
  status: "streaming";
}>;

export type TerminalAssistantMessage = Readonly<{
  role: "assistant";
  content: string;
  status: "completed" | "aborted" | "failed";
}>;

export type AssistantMessage = StreamingAssistantMessage | TerminalAssistantMessage;
export type AgentMessage = UserMessage | AssistantMessage;
export type EndedMessage = UserMessage | TerminalAssistantMessage;

export type AgentState = Readonly<{
  messages: readonly EndedMessage[];
  currentAssistant: StreamingAssistantMessage | null;
  running: boolean;
  lastError: string | null;
}>;

export type RejectedPromptResult = Readonly<{
  status: "rejected";
  reason: "empty" | "busy";
}>;

export type CompletedPromptResult = Readonly<{ status: "completed" }>;
export type AbortedPromptResult = Readonly<{ status: "aborted" }>;
export type FailedPromptResult = Readonly<{ status: "failed"; error: string }>;
export type TerminalPromptResult = CompletedPromptResult | AbortedPromptResult | FailedPromptResult;
export type PromptResult = RejectedPromptResult | TerminalPromptResult;

export type AgentEvent =
  | Readonly<{ type: "agent_start" }>
  | Readonly<{ type: "message_start"; message: AgentMessage }>
  | Readonly<{
      type: "message_update";
      message: StreamingAssistantMessage;
      delta: string;
    }>
  | Readonly<{ type: "message_end"; message: EndedMessage }>
  | Readonly<{ type: "agent_end"; result: TerminalPromptResult }>;

export type ModelMessage = Readonly<{
  role: "user" | "assistant";
  content: string;
}>;

export type ModelStream = (
  messages: readonly ModelMessage[],
  signal: AbortSignal,
) => AsyncIterable<string>;

export type AgentListener = (event: AgentEvent) => void;

export type Agent = Readonly<{
  readonly state: AgentState;
  prompt(text: string): Promise<PromptResult>;
  abort(): void;
  subscribe(listener: AgentListener): () => void;
}>;

export type CreateAgentOptions = Readonly<{
  modelStream: ModelStream;
}>;

type MutableUserMessage = {
  role: "user";
  content: string;
};

type MutableAssistantMessage = {
  role: "assistant";
  content: string;
  status: "streaming" | "completed" | "aborted" | "failed";
};

type MutableEndedMessage = MutableUserMessage | MutableAssistantMessage;

type ActiveRun = {
  controller: AbortController;
  assistant: MutableAssistantMessage;
  iterator: AsyncIterator<string> | null;
  terminal: TerminalPromptResult | null;
};

const ABORTED = Symbol("aborted");
const SAFE_MODEL_ERROR = "模型请求失败，请检查模型配置或稍后重试。";

const EMPTY_RESULT: RejectedPromptResult = Object.freeze({
  status: "rejected",
  reason: "empty",
});
const BUSY_RESULT: RejectedPromptResult = Object.freeze({
  status: "rejected",
  reason: "busy",
});
const COMPLETED_RESULT: CompletedPromptResult = Object.freeze({ status: "completed" });
const ABORTED_RESULT: AbortedPromptResult = Object.freeze({ status: "aborted" });

export function createAgent({ modelStream }: CreateAgentOptions): Agent {
  const messages: MutableEndedMessage[] = [];
  const listeners = new Set<AgentListener>();
  let currentAssistant: MutableAssistantMessage | null = null;
  let lastError: string | null = null;
  let activeRun: ActiveRun | null = null;

  function getState(): AgentState {
    return Object.freeze({
      messages: Object.freeze(messages.map(snapshotEndedMessage)),
      currentAssistant: currentAssistant
        ? (snapshotAssistant(currentAssistant) as StreamingAssistantMessage)
        : null,
      running: activeRun !== null,
      lastError,
    });
  }

  function emit(event: AgentEvent): void {
    const frozenEvent = Object.freeze(event);
    for (const listener of [...listeners]) {
      // 订阅者只负责观察；渲染回调的同步异常不能破坏 Agent 的唯一终结路径。
      try {
        void listener(frozenEvent);
      } catch {
        // Feature 001 不增加第二条监听器错误通道。
      }
    }
  }

  function subscribe(listener: AgentListener): () => void {
    listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      listeners.delete(listener);
    };
  }

  function abort(): void {
    activeRun?.controller.abort();
  }

  async function prompt(text: string): Promise<PromptResult> {
    if (text.trim().length === 0) {
      return EMPTY_RESULT;
    }
    if (activeRun !== null) {
      return BUSY_RESULT;
    }

    lastError = null;
    const controller = new AbortController();
    const assistant: MutableAssistantMessage = {
      role: "assistant",
      content: "",
      status: "streaming",
    };
    const run: ActiveRun = {
      controller,
      assistant,
      iterator: null,
      terminal: null,
    };
    activeRun = run;

    const userMessage: MutableUserMessage = { role: "user", content: text };
    messages.push(userMessage);
    emit({ type: "agent_start" });
    emit({ type: "message_start", message: snapshotUser(userMessage) });
    emit({ type: "message_end", message: snapshotUser(userMessage) });
    currentAssistant = assistant;
    emit({ type: "message_start", message: snapshotAssistant(assistant) });

    if (controller.signal.aborted) {
      return finishRun(run, ABORTED_RESULT);
    }

    try {
      const context = Object.freeze(messages.map(toModelMessage));
      const iterator = modelStream(context, controller.signal)[Symbol.asyncIterator]();
      run.iterator = iterator;

      while (true) {
        const next = await nextWithAbort(iterator, controller.signal);
        if (next === ABORTED || controller.signal.aborted) {
          return finishRun(run, ABORTED_RESULT);
        }
        if (next.done) {
          return finishRun(run, COMPLETED_RESULT);
        }
        if (next.value.length === 0 || run.terminal !== null || activeRun !== run) {
          continue;
        }

        assistant.content += next.value;
        emit({
          type: "message_update",
          message: snapshotAssistant(assistant) as StreamingAssistantMessage,
          delta: next.value,
        });
      }
    } catch {
      if (controller.signal.aborted) {
        return finishRun(run, ABORTED_RESULT);
      }
      return finishRun(run, Object.freeze({ status: "failed", error: SAFE_MODEL_ERROR }));
    }
  }

  function finishRun(run: ActiveRun, requested: TerminalPromptResult): TerminalPromptResult {
    // 完成、失败、取消可能相邻发生；第一次进入终态后，其余路径只能读取既有结果。
    if (run.terminal !== null) {
      return run.terminal;
    }
    run.terminal = requested;

    const status = requested.status;
    run.assistant.status = status;
    const endedAssistant = snapshotAssistant(run.assistant) as TerminalAssistantMessage;
    messages.push({ ...run.assistant });
    currentAssistant = null;
    if (status === "failed") {
      lastError = requested.error;
    }

    const iterator = run.iterator;
    run.iterator = null;

    // 保留 activeRun 直到 agent_end 已同步交付，避免订阅者重入 prompt 打断事件骨架。
    emit({ type: "message_end", message: endedAssistant });
    emit({ type: "agent_end", result: requested });

    if (status === "aborted" && iterator?.return) {
      // AbortSignal 负责立即取消底层请求；return 只做不阻塞终态的迭代器收尾。
      void iterator.return().catch(() => undefined);
    }
    if (activeRun === run) {
      activeRun = null;
    }
    return requested;
  }

  return Object.freeze({
    get state() {
      return getState();
    },
    prompt,
    abort,
    subscribe,
  });
}

function snapshotUser(message: MutableUserMessage): UserMessage {
  return Object.freeze({ role: "user", content: message.content });
}

function snapshotAssistant(message: MutableAssistantMessage): AssistantMessage {
  return Object.freeze({
    role: "assistant",
    content: message.content,
    status: message.status,
  });
}

function snapshotEndedMessage(message: MutableEndedMessage): EndedMessage {
  return message.role === "user"
    ? snapshotUser(message)
    : (snapshotAssistant(message) as EndedMessage);
}

function toModelMessage(message: MutableEndedMessage): ModelMessage {
  return Object.freeze({ role: message.role, content: message.content });
}

function nextWithAbort(
  iterator: AsyncIterator<string>,
  signal: AbortSignal,
): Promise<IteratorResult<string> | typeof ABORTED> {
  if (signal.aborted) {
    return Promise.resolve(ABORTED);
  }

  // 某些迭代器不会立即响应 AbortSignal；竞速可让 Agent 先进入唯一中止终态。
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      resolve(ABORTED);
    };
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(iterator.next()).then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}
