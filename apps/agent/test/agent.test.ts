import { describe, expect, it, vi } from "vitest";
import { type AgentEvent, createAgent, type Message, type ModelStream } from "../src/index.js";

describe("Agent", () => {
  it("streams one assistant message through the public interface", async () => {
    const modelStream: ModelStream = async function* (modelMessages, abortSignal) {
      expect(modelMessages).toEqual([{ role: "user", content: "你好" }]);
      expect(abortSignal.aborted).toBe(false);
      yield "你";
      yield "好";
    };
    const agent = createAgent({ modelStream });
    const events: string[] = [];
    const updateSnapshots: string[] = [];
    agent.subscribe((event) => {
      events.push(event.type);
      if (event.type === "message_update") {
        updateSnapshots.push(event.message.content);
      }
    });

    const promptResult = await agent.prompt("你好");

    expect(promptResult).toEqual({ status: "completed" });
    expect(agent.state).toEqual({
      messageHistory: [
        { role: "user", content: "你好" },
        { role: "assistant", content: "你好", status: "completed" },
      ],
      activeAssistantMessage: null,
      running: false,
      lastError: null,
    });
    expect(events).toEqual([
      "agent_start",
      "message_start",
      "message_end",
      "message_start",
      "message_update",
      "message_update",
      "message_end",
      "agent_end",
    ]);
    expect(updateSnapshots).toEqual(["你", "你好"]);
    expect(Object.isFrozen(agent.state)).toBe(true);
    expect(Object.isFrozen(agent.state.messageHistory)).toBe(true);
    expect(Object.isFrozen(agent.state.messageHistory[0])).toBe(true);
  });

  it("keeps ordered context and rejects empty prompts without events", async () => {
    const modelMessageBatches: unknown[] = [];
    const modelStream: ModelStream = async function* (modelMessages) {
      modelMessageBatches.push(modelMessages);
      yield modelMessageBatches.length === 1 ? "first" : "second";
    };
    const agent = createAgent({ modelStream });
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
        { role: "assistant", content: "first" },
        { role: "user", content: "two" },
      ],
    ]);
  });

  it("rejects a busy prompt without changing the active request", async () => {
    const responseGate = Promise.withResolvers<void>();
    let modelCallCount = 0;
    const modelStream: ModelStream = async function* () {
      modelCallCount += 1;
      yield "working";
      await responseGate.promise;
      yield " done";
    };
    const agent = createAgent({ modelStream });
    const firstPromptResult = agent.prompt("first");
    await vi.waitFor(() => expect(agent.state.activeAssistantMessage?.content).toBe("working"));

    await expect(agent.prompt("second")).resolves.toEqual({
      status: "rejected",
      reason: "busy",
    });
    expect(modelCallCount).toBe(1);
    expect(agent.state.messageHistory).toEqual([{ role: "user", content: "first" }]);

    responseGate.resolve();
    await expect(firstPromptResult).resolves.toEqual({ status: "completed" });
  });

  it("stays busy until agent_end has been delivered", async () => {
    const modelStream: ModelStream = async function* () {
      yield "done";
    };
    const agent = createAgent({ modelStream });
    const eventTypes: string[] = [];
    let reentrantPromptResult: ReturnType<typeof agent.prompt> | undefined;
    agent.subscribe((event) => {
      eventTypes.push(event.type);
      if (event.type === "message_end" && event.message.role === "assistant") {
        reentrantPromptResult = agent.prompt("too early");
      }
    });

    await expect(agent.prompt("first")).resolves.toEqual({ status: "completed" });
    if (!reentrantPromptResult) {
      throw new Error("expected the terminal subscriber to attempt a prompt");
    }
    await expect(reentrantPromptResult).resolves.toEqual({ status: "rejected", reason: "busy" });
    expect(eventTypes).toEqual([
      "agent_start",
      "message_start",
      "message_end",
      "message_start",
      "message_update",
      "message_end",
      "agent_end",
    ]);
    expect(agent.state.running).toBe(false);
    expect(agent.state.messageHistory).toHaveLength(2);
  });

  it("aborts immediately, ignores late deltas, and can continue", async () => {
    const lateChunkGate = Promise.withResolvers<void>();
    let modelCallCount = 0;
    const modelStream: ModelStream = async function* () {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        yield "partial";
        await lateChunkGate.promise;
        yield " late";
        return;
      }
      yield "recovered";
    };
    const agent = createAgent({ modelStream });
    const eventTypes: string[] = [];
    agent.subscribe((event) => eventTypes.push(event.type));
    const firstPromptResult = agent.prompt("stop this");
    await vi.waitFor(() => expect(agent.state.activeAssistantMessage?.content).toBe("partial"));

    agent.abort();
    await expect(firstPromptResult).resolves.toEqual({ status: "aborted" });
    const finalAssistantMessage = agent.state.messageHistory.at(-1);
    expect(finalAssistantMessage).toEqual({
      role: "assistant",
      content: "partial",
      status: "aborted",
    });
    expect(eventTypes.filter((type) => type === "agent_end")).toHaveLength(1);

    lateChunkGate.resolve();
    await Promise.resolve();
    expect(agent.state.messageHistory.at(-1)).toEqual(finalAssistantMessage);
    await expect(agent.prompt("continue")).resolves.toEqual({ status: "completed" });
  });

  it("keeps provider errors out of assistant text and recovers", async () => {
    let modelCallCount = 0;
    const modelStream: ModelStream = async function* () {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        yield "partial";
        throw new Error("Authorization: Bearer secret-value");
      }
      yield "ok";
    };
    const agent = createAgent({ modelStream });

    const failedPromptResult = await agent.prompt("fail");

    expect(failedPromptResult.status).toBe("failed");
    if (failedPromptResult.status === "failed") {
      expect(failedPromptResult.error).not.toContain("secret-value");
      expect(agent.state.lastError).toBe(failedPromptResult.error);
    }
    expect(agent.state.messageHistory.at(-1)).toEqual({
      role: "assistant",
      content: "partial",
      status: "failed",
    });
    expect(JSON.stringify(agent.state)).not.toContain("secret-value");

    await expect(agent.prompt("recover")).resolves.toEqual({ status: "completed" });
    expect(agent.state.lastError).toBeNull();
  });

  it("does not await subscriber promises and unsubscribes idempotently", async () => {
    const neverSettles = new Promise<void>(() => undefined);
    const modelStream: ModelStream = async function* () {
      yield "ok";
    };
    const agent = createAgent({ modelStream });
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
      yield "safe";
    };
    const agent = createAgent({ modelStream });
    await agent.prompt("hello");
    const state = agent.state;

    expect(() => {
      (state.messageHistory as Message[]).push({ role: "user", content: "mutated" });
    }).toThrow();
    expect(agent.state.messageHistory).toHaveLength(2);
  });
});
