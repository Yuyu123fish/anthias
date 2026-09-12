import { access, appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Agent, createAgentWithModelStream } from "../src/agent.js";
import type { AgentEvent, AssistantMessage, Message } from "../src/index.js";
import {
  type ModelRequest,
  type ModelStream,
  type ModelStreamEvent,
  streamAssistantMessage,
} from "../src/model/model-stream.js";
import {
  createSession,
  openSession,
  type Session,
  type SessionShell,
} from "../src/session/index.js";
import { getSessionLockDirectory } from "../src/session/lock.js";
import { promptToCompletion } from "./prompt-helper.js";

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
  it("waits for an accepted input write before closing and never starts model work", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-agent-close-"));
    temporaryDirectories.add(workspaceRoot);
    const session = await createSession({
      workspaceRoot,
      sessionDirectory: join(workspaceRoot, "sessions"),
      shell: TEST_SHELL,
    });
    const acquired = Promise.withResolvers<void>();
    const continueAcquisition = Promise.withResolvers<void>();
    const closeSession = vi.fn(() => session.close());
    let modelRequests = 0;
    let writeError: unknown;
    const delayedSession: Session = {
      ...session,
      async appendMessage(runId, message) {
        acquired.resolve();
        await continueAcquisition.promise;
        try {
          return await session.appendMessage(runId, message);
        } catch (error) {
          writeError = error;
          throw error;
        }
      },
      async appendRunFinished(runId, details) {
        try {
          return await session.appendRunFinished(runId, details);
        } catch (error) {
          writeError = error;
          throw error;
        }
      },
      get records() {
        return session.records;
      },
      close: closeSession,
    };
    const agent = createAgentWithModelStream({
      session: delayedSession,
      modelStream: async function* () {
        modelRequests += 1;
        yield stopFinish();
      },
    });
    const promptResult = promptToCompletion(agent, "pending");
    await acquired.promise;
    const closed = agent.close();
    expect(agent.close()).toBe(closed);
    expect(closeSession).not.toHaveBeenCalled();
    await expect(promptToCompletion(agent, "late")).resolves.toEqual({
      status: "rejected",
      reason: "closed",
    });
    continueAcquisition.resolve();
    const result = await promptResult;
    await closed;
    expect(writeError).toBeUndefined();
    expect(result).toEqual({ status: "aborted" });
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(modelRequests).toBe(0);
    expect(agent.state.messageHistory).toEqual([{ role: "user", content: "pending" }]);
  });

  it("delivers the aborted Run before releasing Session resources on close", async () => {
    const started = Promise.withResolvers<void>();
    const agent = await createTestAgent(async function* (_request, signal) {
      yield textDelta("partial");
      started.resolve();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => events.push(event));
    const promptResult = promptToCompletion(agent, "start");
    await started.promise;
    await agent.close();
    await expect(promptResult).resolves.toEqual({ status: "aborted" });
    expect(events.at(-1)).toMatchObject({ type: "run_end", result: { status: "aborted" } });
    expect(agent.state.running).toBe(false);
    expect(agent.setPermissionMode("auto_allow")).toEqual({ status: "rejected", reason: "closed" });
  });

  it("normalizes visible reasoning spans without changing the durable AssistantMessage", async () => {
    const modelRequest: ModelRequest = Object.freeze({
      systemPrompt: "test",
      messages: Object.freeze([]),
      tools: Object.freeze([]),
    });
    const events = [];

    for await (const event of streamAssistantMessage(
      async function* () {
        yield Object.freeze({ type: "reasoning_start" as const });
        yield Object.freeze({ type: "reasoning_delta" as const, delta: "" });
        yield Object.freeze({ type: "reasoning_delta" as const, delta: "first" });
        yield Object.freeze({ type: "reasoning_start" as const });
        yield Object.freeze({ type: "reasoning_delta" as const, delta: "second" });
        yield textDelta("answer");
        yield stopFinish();
      },
      modelRequest,
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "reasoning_start",
      "reasoning_update",
      "reasoning_end",
      "reasoning_start",
      "reasoning_update",
      "reasoning_end",
      "update",
      "finish",
    ]);
    const finalEvent = events.at(-1);
    expect(finalEvent).toMatchObject({
      type: "finish",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        status: "completed",
      },
      modelInputMessage: {
        role: "assistant",
        content: [
          { type: "reasoning", text: "first" },
          { type: "reasoning", text: "second" },
          { type: "text", text: "answer" },
        ],
      },
    });
  });

  it.each(["provider_error", "abort"] as const)(
    "closes visible reasoning before a %s terminal message",
    async (terminalBoundary) => {
      const abortController = new AbortController();
      const modelRequest: ModelRequest = Object.freeze({
        systemPrompt: "test",
        messages: Object.freeze([]),
        tools: Object.freeze([]),
      });
      const events = [];

      for await (const event of streamAssistantMessage(
        async function* () {
          yield Object.freeze({ type: "reasoning_start" as const });
          yield Object.freeze({ type: "reasoning_delta" as const, delta: "working" });
          if (terminalBoundary === "provider_error") {
            throw new Error("provider failed");
          }
          abortController.abort();
        },
        modelRequest,
        abortController.signal,
      )) {
        events.push(event);
      }

      expect(events.map((event) => event.type)).toEqual([
        "start",
        "reasoning_start",
        "reasoning_update",
        "reasoning_end",
        "finish",
      ]);
      expect(events.at(-1)).toMatchObject({
        type: "finish",
        message: { status: terminalBoundary === "abort" ? "aborted" : "failed" },
      });
    },
  );

  it("keeps reasoning in same-Run Tool continuation but out of state, Session, and later Runs", async () => {
    const reasoningMarker = "VISIBLE_REASONING_NOT_DURABLE";
    const modelRequests: ModelRequest[] = [];
    const modelStream: ModelStream = async function* (modelRequest) {
      modelRequests.push(modelRequest);
      if (modelRequests.length === 1) {
        yield Object.freeze({ type: "reasoning_start" as const });
        yield Object.freeze({ type: "reasoning_delta" as const, delta: reasoningMarker });
        yield Object.freeze({ type: "reasoning_end" as const });
        yield Object.freeze({
          type: "tool_call" as const,
          toolCallId: "00000000-0000-4000-8000-000000000021",
          toolName: "read_file",
          input: { path: "missing.txt" },
          invalid: false,
        });
        yield Object.freeze({ type: "finish" as const, finishReason: "tool_calls" as const });
        return;
      }
      yield textDelta(modelRequests.length === 2 ? "first done" : "second done");
      yield stopFinish();
    };
    const agent = await createTestAgent(modelStream);
    const events: AgentEvent[] = [];
    agent.subscribe((event) => events.push(event));

    await expect(promptToCompletion(agent, "first")).resolves.toEqual({ status: "completed" });

    const firstRunId = events.find((event) => event.type === "run_start")?.runId;
    expect(
      events
        .filter((event) => event.type.startsWith("reasoning_"))
        .map((event) => ({ type: event.type, runId: "runId" in event ? event.runId : null })),
    ).toEqual([
      { type: "reasoning_start", runId: firstRunId },
      { type: "reasoning_update", runId: firstRunId },
      { type: "reasoning_end", runId: firstRunId },
    ]);
    expect(JSON.stringify(modelRequests[1])).toContain(reasoningMarker);
    expect(JSON.stringify(agent.state)).not.toContain(reasoningMarker);
    expect(JSON.stringify(await readSessionRecords(agent))).not.toContain(reasoningMarker);

    await expect(promptToCompletion(agent, "second")).resolves.toEqual({ status: "completed" });
    expect(JSON.stringify(modelRequests[2])).not.toContain(reasoningMarker);
  });

  it("streams one assistant message through the public interface", async () => {
    const modelStream: ModelStream = async function* (modelRequest, abortSignal) {
      expect(modelRequest.messages.at(-1)).toMatchObject({
        role: "user",
        content: "你好",
        entryId: expect.any(String),
      });
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

    const promptResult = await promptToCompletion(agent, "你好");

    expect(promptResult).toEqual({ status: "completed" });
    expect(agent.state).toMatchObject({
      operation: null,
      collaboration: {
        rootSessionId: agent.state.sessionId,
        members: [],
        team: { id: agent.state.sessionId, name: "协作群组" },
        tasks: [],
      },
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
      permissionMode: "agent",
      contextUsage: expect.objectContaining({ contextWindow: 128000, source: "estimated" }),
    });
    expect(events.filter((type) => type !== "context_usage" && !type.startsWith("input_"))).toEqual(
      [
        "run_start",
        "message_start",
        "message_end",
        "message_start",
        "message_update",
        "message_update",
        "message_end",
        "run_end",
      ],
    );
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
      modelMessageBatches.push(
        modelRequest.messages
          .filter(
            (message) => !(message.role === "user" && message.content.startsWith("[上下文来源：")),
          )
          .map(({ entryId: _entryId, ...message }) => message),
      );
      yield textDelta(modelMessageBatches.length === 1 ? "first" : "second");
      yield stopFinish();
    };
    const agent = await createTestAgent(modelStream);
    const events: AgentEvent[] = [];
    agent.subscribe((event) => events.push(event));

    await expect(promptToCompletion(agent, "   ")).resolves.toEqual({
      status: "rejected",
      reason: "empty",
    });
    expect(events).toHaveLength(0);
    await expect(promptToCompletion(agent, "one")).resolves.toEqual({ status: "completed" });
    await expect(promptToCompletion(agent, "two")).resolves.toEqual({ status: "completed" });

    expect(modelMessageBatches).toEqual([
      [{ role: "user", content: "one" }],
      [
        { role: "user", content: "one" },
        { role: "assistant", content: [{ type: "text", text: "first" }] },
        { role: "user", content: "two" },
      ],
    ]);
  });

  it("queues a busy prompt until the current response is durable", async () => {
    const responseGate = Promise.withResolvers<void>();
    let modelCallCount = 0;
    const agent = await createTestAgent(async function* () {
      modelCallCount += 1;
      yield textDelta("working");
      await responseGate.promise;
      yield stopFinish();
    });
    const first = promptToCompletion(agent, "first");
    await vi.waitFor(() => expect(modelCallCount).toBe(1));
    expect(await agent.prompt("second")).toMatchObject({ status: "queued", durable: false });
    expect(agent.state.messageHistory).toEqual([{ role: "user", content: "first" }]);
    responseGate.resolve();
    expect((await first).status).toBe("completed");
    await vi.waitFor(() => expect(modelCallCount).toBe(2));
    expect(agent.state.messageHistory.filter((message) => message.role === "user")).toEqual([
      { role: "user", content: "first" },
      { role: "user", content: "second" },
    ]);
    await agent.close();
  });

  it("hands terminal subscriber input to the next Run and retains the Session lock", async () => {
    const agent = await createTestAgent(async function* () {
      yield textDelta("done");
      yield stopFinish();
    });
    const events: AgentEvent[] = [];
    let second: ReturnType<typeof promptToCompletion> | undefined;
    agent.subscribe((event) => {
      events.push(event);
      if (event.type === "run_end" && !second) second = promptToCompletion(agent, "next run");
    });
    await promptToCompletion(agent, "first");
    await second;
    expect(events.filter((event) => event.type === "run_end")).toHaveLength(2);
    expect(
      new Set(events.filter((event) => event.type === "run_start").map((event) => event.runId))
        .size,
    ).toBe(2);
    await expect(access(getSessionLockPath(agent))).resolves.toBeUndefined();
    await agent.close();
    await expect(access(getSessionLockPath(agent))).rejects.toThrow();
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
    const firstPromptResult = promptToCompletion(agent, "stop this");
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
    expect(finalAssistantMessage).toMatchObject({
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
    await expect(promptToCompletion(agent, "continue")).resolves.toEqual({ status: "completed" });
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

    const failedPromptResult = await promptToCompletion(agent, "fail");

    expect(failedPromptResult.status).toBe("failed");
    if (failedPromptResult.status === "failed") {
      expect(failedPromptResult.error).not.toContain("secret-value");
      expect(agent.state.lastError).toBe(failedPromptResult.error);
    }
    expect(agent.state.messageHistory.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "partial" }],
      status: "failed",
    });
    expect(JSON.stringify(agent.state)).not.toContain("secret-value");
    expect((await readSessionRecords(agent)).at(-1)).toMatchObject({
      type: "run_finished",
      status: "failed",
    });
    await expect(promptToCompletion(agent, "recover")).resolves.toEqual({ status: "completed" });
    expect(agent.state.lastError).toBeNull();
  });

  it.each(["user", "assistant", "run_finished"] as const)(
    "seals the Session when %s persistence fails without inventing durable completion",
    async (failurePoint) => {
      const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-agent-persistence-"));
      temporaryDirectories.add(workspaceRoot);
      const session = await createSession({
        workspaceRoot,
        sessionDirectory: join(workspaceRoot, "sessions"),
        shell: TEST_SHELL,
      });
      let modelCalls = 0;
      let messageWrites = 0;
      let terminalWrites = 0;
      const failingSession: Session = {
        ...session,
        get records() {
          return session.records;
        },
        get header() {
          return session.header;
        },
        async appendMessage(runId, message) {
          messageWrites += 1;
          if (message.role === failurePoint) throw new Error("disk secret-value");
          return session.appendMessage(runId, message);
        },
        async appendRunFinished(runId, details) {
          terminalWrites += 1;
          if (failurePoint === "run_finished") throw new Error("terminal secret-value");
          return session.appendRunFinished(runId, details);
        },
      };
      const agent = createAgentWithModelStream({
        session: failingSession,
        modelStream: async function* () {
          modelCalls += 1;
          yield textDelta("answer");
          yield stopFinish();
        },
      });
      const events: AgentEvent[] = [];
      agent.subscribe((event) => events.push(event));
      const first = await promptToCompletion(agent, "persist this");
      expect(first.status).toBe("failed");
      expect(JSON.stringify({ first, state: agent.state })).not.toContain("secret-value");
      expect(await agent.prompt("sealed")).toEqual({
        status: "rejected",
        reason: "session_unavailable",
      });
      expect(events.filter((event) => event.type === "run_end")).toHaveLength(0);
      expect(events.filter((event) => event.type === "session_unavailable")).toHaveLength(1);
      expect(agent.state.messageHistory).toHaveLength(
        failurePoint === "user" ? 0 : failurePoint === "assistant" ? 1 : 2,
      );
      expect(modelCalls).toBe(failurePoint === "user" ? 0 : 1);
      expect(messageWrites).toBe(failurePoint === "user" ? 1 : 2);
      expect(terminalWrites).toBe(failurePoint === "run_finished" ? 1 : 0);
      expect(agent.state.inputQueue.paused).toBe(true);
      await agent.close();
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

    await expect(promptToCompletion(agent, "stale")).resolves.toEqual({
      status: "failed",
      error: "Session 写入失败，请检查本地存储后重试。",
    });
    expect(modelCallCount).toBe(0);
    expect(
      events.filter((event) => event.type === "message_end" || event.type === "run_end"),
    ).toHaveLength(0);
    expect(agent.state.messageHistory).toEqual([]);
  });

  it.each(["completed", "aborted", "failed"] as const)(
    "retains the Session write lock after a %s terminal result until close",
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
      const promptResultPromise = promptToCompletion(agent, "terminal");
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
      await expect(access(getSessionLockPath(agent))).resolves.toBeUndefined();
      await agent.close();
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

    await expect(promptToCompletion(agent, "one")).resolves.toEqual({ status: "completed" });
    expect(events.length).toBeGreaterThan(0);
    unsubscribe();
    unsubscribe();
    const receivedEventCount = events.length;

    await expect(promptToCompletion(agent, "two")).resolves.toEqual({ status: "completed" });
    expect(events).toHaveLength(receivedEventCount);
  });

  it("does not expose mutable references to internal messages", async () => {
    const modelStream: ModelStream = async function* () {
      yield textDelta("safe");
      yield stopFinish();
    };
    const agent = await createTestAgent(modelStream);
    await promptToCompletion(agent, "hello");
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
    await promptToCompletion(firstAgent, "first question");
    await firstAgent.close();

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
        modelMessageBatches.push(
          modelRequest.messages
            .filter(
              (message) =>
                !(message.role === "user" && message.content.startsWith("[上下文来源：")),
            )
            .map(({ entryId: _entryId, ...message }) => message),
        );
        yield textDelta("second answer");
        yield stopFinish();
      },
    });

    expect(reopenedAgent.state.messageHistory).toMatchObject([
      { role: "user", content: "first question" },
      {
        role: "assistant",
        content: [{ type: "text", text: "first answer" }],
        status: "completed",
      },
    ]);
    await promptToCompletion(reopenedAgent, "second question");
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
  sessionFilePaths.set(agent, join(session.storageDirectory, "session.jsonl"));
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
  return getSessionLockDirectory(
    dirname(dirname(dirname(getSessionFilePath(agent)))),
    agent.state.sessionId,
  );
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
