import { access, appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AssistantMessage, Message } from "../src/index.js";
import {
  type ModelRequest,
  type ModelStream,
  type ModelStreamEvent,
  streamAssistantMessage,
} from "../src/model-stream.js";
import { type Agent, createAgentWithModelStream } from "../src/run.js";
import {
  createSession,
  openSession,
  type Session,
  type SessionShell,
} from "../src/session/index.js";

const temporaryDirectories = new Set<string>();
const sessionFilePaths = new WeakMap<Agent, string>();
const TEST_SHELL: SessionShell = Object.freeze({
  kind: "powershell",
  executable: "pwsh",
  arguments: Object.freeze(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]),
});

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((temporaryDirectory) =>
      rm(temporaryDirectory, { recursive: true, force: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe("Agent", () => {
  it("streams one assistant message through the public interface", async () => {
    const modelStream: ModelStream = async function* (modelRequest, abortSignal) {
      expect(modelRequest.messages).toEqual([{ role: "user", content: "你好" }]);
      expect(abortSignal.aborted).toBe(false);
      yield textDelta("你");
      yield textDelta("好");
      yield stopFinish();
    };
    const agent = await createTestAgent(modelStream);
    const events: string[] = [];
    const updateMessages: AssistantMessage[] = [];
    agent.subscribe((event) => {
      events.push(event.type);
      if (event.type === "message_update") {
        updateMessages.push(event.message);
      }
    });

    const promptResult = await agent.prompt("你好");

    expect(promptResult).toEqual({ status: "completed" });
    expect(agent.state).toEqual({
      messageHistory: [
        { role: "user", content: "你好" },
        {
          role: "assistant",
          content: [{ type: "text", text: "你好" }],
          status: "completed",
        },
      ],
      activeAssistantMessage: null,
      activeRun: null,
      pendingToolApproval: null,
      running: false,
      lastError: null,
      sessionId: expect.any(String),
      workspaceRoot: expect.any(String),
    });
    expect(events).toEqual([
      "run_start",
      "message_start",
      "message_end",
      "message_start",
      "message_update",
      "message_update",
      "message_end",
      "run_end",
    ]);
    expect(updateMessages.map(assistantText)).toEqual(["你", "你好"]);
    expect(Object.isFrozen(agent.state)).toBe(true);
    expect(Object.isFrozen(agent.state.messageHistory)).toBe(true);
    expect(Object.isFrozen(agent.state.messageHistory[0])).toBe(true);
    expect((await readSessionRecords(agent)).at(-1)).toMatchObject({
      type: "run_finished",
      status: "completed",
    });
  });

  it("freezes nested ToolCall input before publishing a partial message", async () => {
    const modelRequest: ModelRequest = Object.freeze({
      systemPrompt: "test",
      messages: Object.freeze([]),
      tools: Object.freeze([]),
    });
    let toolCallMessage: AssistantMessage | null = null;

    for await (const event of streamAssistantMessage(
      async function* () {
        yield Object.freeze({
          type: "tool_call",
          toolCallId: "00000000-0000-4000-8000-000000000001",
          toolName: "read_file",
          input: { range: { lines: [1, 2] } },
          invalid: false,
        });
        yield Object.freeze({
          type: "finish",
          finishReason: "tool_calls",
        });
      },
      modelRequest,
      new AbortController().signal,
    )) {
      if (event.type === "update") {
        toolCallMessage = event.partialAssistantMessage;
      }
    }

    const toolCall = toolCallMessage?.content[0];
    if (toolCall?.type !== "tool_call") {
      throw new Error("expected a ToolCall partial");
    }
    const input = toolCall.input as { range: { lines: number[] } };
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.range)).toBe(true);
    expect(Object.isFrozen(input.range.lines)).toBe(true);
  });

  it("keeps ordered context and rejects empty prompts without events", async () => {
    const modelMessageBatches: unknown[] = [];
    const modelStream: ModelStream = async function* (modelRequest) {
      modelMessageBatches.push(modelRequest.messages);
      yield textDelta(modelMessageBatches.length === 1 ? "first" : "second");
      yield stopFinish();
    };
    const agent = await createTestAgent(modelStream);
    const events: AgentEvent[] = [];
    agent.subscribe((event) => events.push(event));

    await expect(agent.prompt("   ")).resolves.toEqual({
      status: "rejected",
      reason: "empty",
    });
    expect(events).toHaveLength(0);
    await expect(agent.prompt("one")).resolves.toEqual({ status: "completed" });
    await expect(agent.prompt("two")).resolves.toEqual({ status: "completed" });

    expect(modelMessageBatches).toEqual([
      [{ role: "user", content: "one" }],
      [
        { role: "user", content: "one" },
        { role: "assistant", content: [{ type: "text", text: "first" }] },
        { role: "user", content: "two" },
      ],
    ]);
  });

  it("rejects a busy prompt without changing the active request", async () => {
    const responseGate = Promise.withResolvers<void>();
    let modelCallCount = 0;
    const modelStream: ModelStream = async function* () {
      modelCallCount += 1;
      yield textDelta("working");
      await responseGate.promise;
      yield textDelta(" done");
      yield stopFinish();
    };
    const agent = await createTestAgent(modelStream);
    const firstPromptResult = agent.prompt("first");
    await vi.waitFor(() =>
      expect(agent.state.activeAssistantMessage?.content).toEqual([
        { type: "text", text: "working" },
      ]),
    );

    await expect(agent.prompt("second")).resolves.toEqual({
      status: "rejected",
      reason: "busy",
    });
    expect(modelCallCount).toBe(1);
    expect(agent.state.messageHistory).toEqual([{ role: "user", content: "first" }]);

    responseGate.resolve();
    await expect(firstPromptResult).resolves.toEqual({ status: "completed" });
  });

  it("stays busy until run_end has been delivered", async () => {
    const modelStream: ModelStream = async function* () {
      yield textDelta("done");
      yield stopFinish();
    };
    const agent = await createTestAgent(modelStream);
    const eventTypes: string[] = [];
    let reentrantPromptResult: ReturnType<typeof agent.prompt> | undefined;
    let lockObservedDuringRunEnd: Promise<void> | undefined;
    agent.subscribe((event) => {
      eventTypes.push(event.type);
      if (event.type === "message_end" && event.message.role === "assistant") {
        reentrantPromptResult = agent.prompt("too early");
      }
      if (event.type === "run_end") {
        lockObservedDuringRunEnd = access(getSessionLockPath(agent));
      }
    });

    await expect(agent.prompt("first")).resolves.toEqual({ status: "completed" });
    if (!reentrantPromptResult) {
      throw new Error("expected the terminal subscriber to attempt a prompt");
    }
    await expect(reentrantPromptResult).resolves.toEqual({ status: "rejected", reason: "busy" });
    await expect(lockObservedDuringRunEnd).resolves.toBeUndefined();
    await expect(access(getSessionLockPath(agent))).rejects.toThrow();
    expect(eventTypes).toEqual([
      "run_start",
      "message_start",
      "message_end",
      "message_start",
      "message_update",
      "message_end",
      "run_end",
    ]);
    expect(agent.state.running).toBe(false);
    expect(agent.state.messageHistory).toHaveLength(2);
  });

  it("aborts immediately, ignores late deltas, and can continue", async () => {
    const abortObserved = Promise.withResolvers<void>();
    const streamCleanupFinished = Promise.withResolvers<void>();
    let modelCallCount = 0;
    const modelStream: ModelStream = async function* (_modelRequest, abortSignal) {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        try {
          yield textDelta("partial");
          if (abortSignal.aborted) {
            abortObserved.resolve();
          } else {
            await new Promise<void>((resolve) => {
              abortSignal.addEventListener(
                "abort",
                () => {
                  abortObserved.resolve();
                  resolve();
                },
                { once: true },
              );
            });
          }
          yield textDelta(" late");
        } finally {
          streamCleanupFinished.resolve();
        }
        return;
      }
      yield textDelta("recovered");
      yield stopFinish();
    };
    const agent = await createTestAgent(modelStream);
    const eventTypes: string[] = [];
    agent.subscribe((event) => eventTypes.push(event.type));
    const firstPromptResult = agent.prompt("stop this");
    await vi.waitFor(() =>
      expect(agent.state.activeAssistantMessage?.content).toEqual([
        { type: "text", text: "partial" },
      ]),
    );

    agent.abort();
    await abortObserved.promise;
    await expect(firstPromptResult).resolves.toEqual({ status: "aborted" });
    await streamCleanupFinished.promise;
    const finalAssistantMessage = agent.state.messageHistory.at(-1);
    expect(finalAssistantMessage).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "partial" }],
      status: "aborted",
    });
    expect(eventTypes.filter((type) => type === "run_end")).toHaveLength(1);
    expect((await readSessionRecords(agent)).at(-1)).toMatchObject({
      type: "run_finished",
      status: "aborted",
    });
    expect(agent.state.messageHistory.at(-1)).toEqual(finalAssistantMessage);
    await expect(agent.prompt("continue")).resolves.toEqual({ status: "completed" });
  });

  it("keeps provider errors out of assistant text and recovers", async () => {
    let modelCallCount = 0;
    const modelStream: ModelStream = async function* () {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        yield textDelta("partial");
        throw new Error("Authorization: Bearer secret-value");
      }
      yield textDelta("ok");
      yield stopFinish();
    };
    const agent = await createTestAgent(modelStream);

    const failedPromptResult = await agent.prompt("fail");

    expect(failedPromptResult.status).toBe("failed");
    if (failedPromptResult.status === "failed") {
      expect(failedPromptResult.error).not.toContain("secret-value");
      expect(agent.state.lastError).toBe(failedPromptResult.error);
    }
    expect(agent.state.messageHistory.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "partial" }],
      status: "failed",
    });
    expect(JSON.stringify(agent.state)).not.toContain("secret-value");
    expect((await readSessionRecords(agent)).at(-1)).toMatchObject({
      type: "run_finished",
      status: "failed",
    });
    await expect(agent.prompt("recover")).resolves.toEqual({ status: "completed" });
    expect(agent.state.lastError).toBeNull();
  });

  it("does not publish an assistant message when its persistence fails", async () => {
    let appendedRunFinishedCount = 0;
    let releasedLeaseCount = 0;
    const session: Session = Object.freeze({
      sessionId: "00000000-0000-4000-8000-000000000001",
      workspaceRoot: "C:\\workspace",
      sessionDirectory: "C:\\workspace\\data\\conversation",
      shell: TEST_SHELL,
      messageHistory: Object.freeze([]),
      async acquireRun() {
        return Object.freeze({
          status: "acquired",
          lease: Object.freeze({
            async appendMessage(message: Message) {
              if (message.role === "assistant") {
                throw new Error("disk failure with secret-value");
              }
            },
            async appendToolExecutionStarted() {},
            async appendRunFinished() {
              appendedRunFinishedCount += 1;
            },
            async release() {
              releasedLeaseCount += 1;
            },
          }),
        });
      },
    });
    const agent = createAgentWithModelStream({
      session,
      modelStream: async function* () {
        yield textDelta("not durable");
        yield stopFinish();
      },
    });
    const assistantMessageEndEvents: AgentEvent[] = [];
    agent.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        assistantMessageEndEvents.push(event);
      }
    });

    const promptResult = await agent.prompt("persist this");

    expect(promptResult.status).toBe("failed");
    expect(JSON.stringify(promptResult)).not.toContain("secret-value");
    expect(agent.state.messageHistory).toEqual([{ role: "user", content: "persist this" }]);
    expect(agent.state.activeAssistantMessage).toBeNull();
    expect(assistantMessageEndEvents).toHaveLength(0);
    expect(appendedRunFinishedCount).toBe(0);
    expect(releasedLeaseCount).toBe(1);
  });

  it("reports and seals a Session when User persistence and lease release both fail", async () => {
    let acquisitionCount = 0;
    let modelCallCount = 0;
    const session: Session = Object.freeze({
      sessionId: "00000000-0000-4000-8000-000000000011",
      workspaceRoot: "C:\\workspace",
      sessionDirectory: "C:\\workspace\\data\\conversation",
      shell: TEST_SHELL,
      messageHistory: Object.freeze([]),
      async acquireRun() {
        acquisitionCount += 1;
        return Object.freeze({
          status: "acquired",
          lease: Object.freeze({
            async appendMessage() {
              throw new Error("append secret-value");
            },
            async appendToolExecutionStarted() {
              throw new Error("must not append ToolExecutionStarted");
            },
            async appendRunFinished() {
              throw new Error("must not append RunFinished");
            },
            async release() {
              throw new Error("release secret-value");
            },
          }),
        });
      },
    });
    const agent = createAgentWithModelStream({
      session,
      modelStream: async function* () {
        modelCallCount += 1;
        yield textDelta("must not run");
      },
    });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => events.push(event));

    const firstPromptResult = await agent.prompt("persist me");
    const secondPromptResult = await agent.prompt("must stay sealed");

    expect(firstPromptResult).toEqual({
      status: "failed",
      error: "Session 资源释放失败，已停止继续写入；请重新打开 Session。",
    });
    if (firstPromptResult.status !== "failed") {
      throw new Error("expected Session release failure");
    }
    expect(secondPromptResult).toEqual(firstPromptResult);
    expect(agent.state.lastError).toBe(firstPromptResult.error);
    expect(JSON.stringify({ firstPromptResult, state: agent.state })).not.toContain("secret-value");
    expect(acquisitionCount).toBe(1);
    expect(modelCallCount).toBe(0);
    expect(events).toHaveLength(0);
  });

  it("seals the Agent after run completion persistence fails", async () => {
    let appendedMessageCount = 0;
    let appendedRunFinishedCount = 0;
    let modelCallCount = 0;
    let releasedLeaseCount = 0;
    const session: Session = Object.freeze({
      sessionId: "00000000-0000-4000-8000-000000000002",
      workspaceRoot: "C:\\workspace",
      sessionDirectory: "C:\\workspace\\data\\conversation",
      shell: TEST_SHELL,
      messageHistory: Object.freeze([]),
      async acquireRun() {
        return Object.freeze({
          status: "acquired",
          lease: Object.freeze({
            async appendMessage() {
              appendedMessageCount += 1;
            },
            async appendToolExecutionStarted() {},
            async appendRunFinished() {
              appendedRunFinishedCount += 1;
              throw new Error("run completion persistence failed");
            },
            async release() {
              releasedLeaseCount += 1;
            },
          }),
        });
      },
    });
    const agent = createAgentWithModelStream({
      session,
      modelStream: async function* () {
        modelCallCount += 1;
        yield textDelta("durable assistant");
        yield stopFinish();
      },
    });
    const eventTypes: string[] = [];
    agent.subscribe((event) => eventTypes.push(event.type));

    const firstPromptResult = await agent.prompt("first");
    const secondPromptResult = await agent.prompt("must not start");

    expect(firstPromptResult.status).toBe("failed");
    expect(secondPromptResult).toEqual(firstPromptResult);
    expect(appendedMessageCount).toBe(2);
    expect(appendedRunFinishedCount).toBe(1);
    expect(releasedLeaseCount).toBe(1);
    expect(modelCallCount).toBe(1);
    expect(eventTypes.filter((eventType) => eventType === "run_start")).toHaveLength(1);
  });

  it.each(["session_busy", "session_changed"] as const)(
    "rejects %s before events or model work and seals only a changed Session",
    async (reason) => {
      let acquisitionCount = 0;
      let modelCallCount = 0;
      const session: Session = Object.freeze({
        sessionId: randomSessionId(),
        workspaceRoot: "C:\\workspace",
        sessionDirectory: "C:\\workspace\\data\\conversation",
        shell: TEST_SHELL,
        messageHistory: Object.freeze([]),
        async acquireRun() {
          acquisitionCount += 1;
          return Object.freeze({ status: "rejected", reason });
        },
      });
      const agent = createAgentWithModelStream({
        session,
        modelStream: async function* () {
          modelCallCount += 1;
          yield textDelta("must not run");
        },
      });
      const events: AgentEvent[] = [];
      agent.subscribe((event) => events.push(event));

      await expect(agent.prompt("first")).resolves.toEqual({ status: "rejected", reason });
      await expect(agent.prompt("second")).resolves.toEqual({ status: "rejected", reason });
      expect(acquisitionCount).toBe(reason === "session_changed" ? 1 : 2);
      expect(modelCallCount).toBe(0);
      expect(events).toHaveLength(0);
      expect(agent.state.messageHistory).toEqual([]);
    },
  );

  it("rejects an externally appended Session and leaves the old projection untouched", async () => {
    let modelCallCount = 0;
    const agent = await createTestAgent(async function* () {
      modelCallCount += 1;
      yield textDelta("must not run");
    });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => events.push(event));
    await appendFile(getSessionFilePath(agent), " ");

    await expect(agent.prompt("stale")).resolves.toEqual({
      status: "rejected",
      reason: "session_changed",
    });
    expect(modelCallCount).toBe(0);
    expect(events).toHaveLength(0);
    expect(agent.state.messageHistory).toEqual([]);
  });

  it.each(["completed", "aborted", "failed"] as const)(
    "releases the Session Run lock after a %s terminal result",
    async (terminalStatus) => {
      const responseGate = Promise.withResolvers<void>();
      const agent = await createTestAgent(async function* () {
        if (terminalStatus === "failed") {
          throw new Error("model failed");
        }
        yield textDelta("partial");
        if (terminalStatus === "aborted") {
          await responseGate.promise;
        } else {
          yield stopFinish();
        }
      });
      const promptResultPromise = agent.prompt("terminal");
      if (terminalStatus === "aborted") {
        await vi.waitFor(() =>
          expect(agent.state.activeAssistantMessage?.content).toEqual([
            { type: "text", text: "partial" },
          ]),
        );
        agent.abort();
        responseGate.resolve();
      }

      const promptResult = await promptResultPromise;
      expect(promptResult.status).toBe(terminalStatus);
      await expect(access(getSessionLockPath(agent))).rejects.toThrow();
    },
  );

  it("does not await subscriber promises and unsubscribes idempotently", async () => {
    const neverSettles = new Promise<void>(() => undefined);
    const modelStream: ModelStream = async function* () {
      yield textDelta("ok");
      yield stopFinish();
    };
    const agent = await createTestAgent(modelStream);
    const events: AgentEvent[] = [];
    agent.subscribe(async () => {
      await neverSettles;
    });
    const unsubscribe = agent.subscribe((event) => events.push(event));

    await expect(agent.prompt("one")).resolves.toEqual({ status: "completed" });
    expect(events.length).toBeGreaterThan(0);
    unsubscribe();
    unsubscribe();
    const receivedEventCount = events.length;

    await expect(agent.prompt("two")).resolves.toEqual({ status: "completed" });
    expect(events).toHaveLength(receivedEventCount);
  });

  it("does not expose mutable references to internal messages", async () => {
    const modelStream: ModelStream = async function* () {
      yield textDelta("safe");
      yield stopFinish();
    };
    const agent = await createTestAgent(modelStream);
    await agent.prompt("hello");
    const state = agent.state;

    expect(() => {
      (state.messageHistory as Message[]).push({ role: "user", content: "mutated" });
    }).toThrow();
    expect(agent.state.messageHistory).toHaveLength(2);
  });

  it("uses the reopened Session projection as the next model context", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-agent-reopen-"));
    temporaryDirectories.add(workspaceRoot);
    const sessionDirectory = join(workspaceRoot, "sessions");
    const session = await createSession({ workspaceRoot, sessionDirectory, shell: TEST_SHELL });
    const firstAgent = createAgentWithModelStream({
      session,
      modelStream: async function* () {
        yield textDelta("first answer");
        yield stopFinish();
      },
    });
    await firstAgent.prompt("first question");

    const reopenedSession = await openSession({
      sessionId: session.sessionId,
      workspaceRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const modelMessageBatches: unknown[] = [];
    const reopenedAgent = createAgentWithModelStream({
      session: reopenedSession,
      modelStream: async function* (modelRequest) {
        modelMessageBatches.push(modelRequest.messages);
        yield textDelta("second answer");
        yield stopFinish();
      },
    });

    expect(reopenedAgent.state.messageHistory).toEqual([
      { role: "user", content: "first question" },
      {
        role: "assistant",
        content: [{ type: "text", text: "first answer" }],
        status: "completed",
      },
    ]);
    await reopenedAgent.prompt("second question");
    expect(modelMessageBatches).toEqual([
      [
        { role: "user", content: "first question" },
        { role: "assistant", content: [{ type: "text", text: "first answer" }] },
        { role: "user", content: "second question" },
      ],
    ]);
  });
});

async function createTestAgent(modelStream: ModelStream): Promise<Agent> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-agent-workspace-"));
  temporaryDirectories.add(workspaceRoot);
  const session = await createSession({
    workspaceRoot,
    sessionDirectory: join(workspaceRoot, "sessions"),
    shell: TEST_SHELL,
  });
  const agent = createAgentWithModelStream({ modelStream, session });
  sessionFilePaths.set(agent, join(workspaceRoot, "sessions", `${session.sessionId}.jsonl`));
  return agent;
}

async function readSessionRecords(agent: Agent): Promise<Record<string, unknown>[]> {
  const sessionFilePath = getSessionFilePath(agent);
  const sessionText = await readFile(sessionFilePath, "utf8");
  return sessionText
    .trimEnd()
    .split("\n")
    .slice(1)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function getSessionFilePath(agent: Agent): string {
  const sessionFilePath = sessionFilePaths.get(agent);
  if (!sessionFilePath) {
    throw new Error("expected test Agent to have a Session file");
  }
  return sessionFilePath;
}

function getSessionLockPath(agent: Agent): string {
  return getSessionFilePath(agent).replace(/\.jsonl$/u, ".lock");
}

function randomSessionId(): string {
  return "00000000-0000-4000-8000-000000000003";
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/** 创建一个确定性文本增量事件。 */
function textDelta(delta: string): ModelStreamEvent {
  return Object.freeze({ type: "text_delta", delta });
}

/** 创建一个正常停止事件。 */
function stopFinish(): ModelStreamEvent {
  return Object.freeze({
    type: "finish",
    finishReason: "stop",
  });
}
