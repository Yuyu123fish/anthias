import { describe, expect, it, vi } from "vitest";
import { type AgentEvent, type AgentMessage, createAgent, type ModelStream } from "../src/index.js";

describe("Agent", () => {
  it("streams one assistant message through the public interface", async () => {
    const modelStream: ModelStream = async function* (messages, signal) {
      expect(messages).toEqual([{ role: "user", content: "你好" }]);
      expect(signal.aborted).toBe(false);
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

    const result = await agent.prompt("你好");

    expect(result).toEqual({ status: "completed" });
    expect(agent.state).toEqual({
      messages: [
        { role: "user", content: "你好" },
        { role: "assistant", content: "你好", status: "completed" },
      ],
      currentAssistant: null,
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
    expect(Object.isFrozen(agent.state.messages)).toBe(true);
    expect(Object.isFrozen(agent.state.messages[0])).toBe(true);
  });

  it("keeps ordered context and rejects empty prompts without events", async () => {
    const contexts: unknown[] = [];
    const modelStream: ModelStream = async function* (messages) {
      contexts.push(messages);
      yield contexts.length === 1 ? "first" : "second";
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

    expect(contexts).toEqual([
      [{ role: "user", content: "one" }],
      [
        { role: "user", content: "one" },
        { role: "assistant", content: "first" },
        { role: "user", content: "two" },
      ],
    ]);
  });

  it("rejects a busy prompt without changing the active request", async () => {
    const gate = Promise.withResolvers<void>();
    let calls = 0;
    const modelStream: ModelStream = async function* () {
      calls += 1;
      yield "working";
      await gate.promise;
      yield " done";
    };
    const agent = createAgent({ modelStream });
    const first = agent.prompt("first");
    await vi.waitFor(() => expect(agent.state.currentAssistant?.content).toBe("working"));

    await expect(agent.prompt("second")).resolves.toEqual({
      status: "rejected",
      reason: "busy",
    });
    expect(calls).toBe(1);
    expect(agent.state.messages).toEqual([{ role: "user", content: "first" }]);

    gate.resolve();
    await expect(first).resolves.toEqual({ status: "completed" });
  });

  it("stays busy until agent_end has been delivered", async () => {
    const modelStream: ModelStream = async function* () {
      yield "done";
    };
    const agent = createAgent({ modelStream });
    const eventTypes: string[] = [];
    let reentrantPrompt: ReturnType<typeof agent.prompt> | undefined;
    agent.subscribe((event) => {
      eventTypes.push(event.type);
      if (event.type === "message_end" && event.message.role === "assistant") {
        reentrantPrompt = agent.prompt("too early");
      }
    });

    await expect(agent.prompt("first")).resolves.toEqual({ status: "completed" });
    if (!reentrantPrompt) {
      throw new Error("expected the terminal subscriber to attempt a prompt");
    }
    await expect(reentrantPrompt).resolves.toEqual({ status: "rejected", reason: "busy" });
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
    expect(agent.state.messages).toHaveLength(2);
  });

  it("aborts immediately, ignores late deltas, and can continue", async () => {
    const late = Promise.withResolvers<void>();
    let calls = 0;
    const modelStream: ModelStream = async function* () {
      calls += 1;
      if (calls === 1) {
        yield "partial";
        await late.promise;
        yield " late";
        return;
      }
      yield "recovered";
    };
    const agent = createAgent({ modelStream });
    const eventTypes: string[] = [];
    agent.subscribe((event) => eventTypes.push(event.type));
    const first = agent.prompt("stop this");
    await vi.waitFor(() => expect(agent.state.currentAssistant?.content).toBe("partial"));

    agent.abort();
    await expect(first).resolves.toEqual({ status: "aborted" });
    const ended = agent.state.messages.at(-1);
    expect(ended).toEqual({ role: "assistant", content: "partial", status: "aborted" });
    expect(eventTypes.filter((type) => type === "agent_end")).toHaveLength(1);

    late.resolve();
    await Promise.resolve();
    expect(agent.state.messages.at(-1)).toEqual(ended);
    await expect(agent.prompt("continue")).resolves.toEqual({ status: "completed" });
  });

  it("keeps provider errors out of assistant text and recovers", async () => {
    let calls = 0;
    const modelStream: ModelStream = async function* () {
      calls += 1;
      if (calls === 1) {
        yield "partial";
        throw new Error("Authorization: Bearer secret-value");
      }
      yield "ok";
    };
    const agent = createAgent({ modelStream });

    const failed = await agent.prompt("fail");

    expect(failed.status).toBe("failed");
    if (failed.status === "failed") {
      expect(failed.error).not.toContain("secret-value");
      expect(agent.state.lastError).toBe(failed.error);
    }
    expect(agent.state.messages.at(-1)).toEqual({
      role: "assistant",
      content: "partial",
      status: "failed",
    });
    expect(JSON.stringify(agent.state)).not.toContain("secret-value");

    await expect(agent.prompt("recover")).resolves.toEqual({ status: "completed" });
    expect(agent.state.lastError).toBeNull();
  });

  it("does not await subscriber promises and unsubscribes idempotently", async () => {
    const never = new Promise<void>(() => undefined);
    const modelStream: ModelStream = async function* () {
      yield "ok";
    };
    const agent = createAgent({ modelStream });
    const events: AgentEvent[] = [];
    agent.subscribe(async () => {
      await never;
    });
    const unsubscribe = agent.subscribe((event) => events.push(event));

    await expect(agent.prompt("one")).resolves.toEqual({ status: "completed" });
    expect(events.length).toBeGreaterThan(0);
    unsubscribe();
    unsubscribe();
    const count = events.length;

    await expect(agent.prompt("two")).resolves.toEqual({ status: "completed" });
    expect(events).toHaveLength(count);
  });

  it("does not expose mutable references to internal messages", async () => {
    const modelStream: ModelStream = async function* () {
      yield "safe";
    };
    const agent = createAgent({ modelStream });
    await agent.prompt("hello");
    const state = agent.state;

    expect(() => {
      (state.messages as AgentMessage[]).push({ role: "user", content: "mutated" });
    }).toThrow();
    expect(agent.state.messages).toHaveLength(2);
  });
});
