import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createAgent, type ModelStream } from "@anthias/agent";
import { describe, expect, it, vi } from "vitest";
import { runTui } from "../src/index.js";

describe("runTui", () => {
  it("renders a deterministic streamed response and returns to input", async () => {
    let calls = 0;
    const modelStream: ModelStream = async function* () {
      calls += 1;
      if (calls === 1) {
        yield "你";
        yield "好";
        return;
      }
      yield "再见";
    };
    const agent = createAgent({ modelStream });
    const input = new PassThrough();
    const output = new PassThrough();
    const signals = new EventEmitter();
    let rendered = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      rendered += chunk;
    });

    const running = runTui({ agent, input, output, signals });
    input.write("hello\n");

    await vi.waitFor(() => {
      expect(rendered).toContain("You: hello\nAssistant: 你好\n");
      expect(rendered).toContain("已完成。\n");
      expect(agent.state.running).toBe(false);
    });

    input.write("again\n");
    await vi.waitFor(() => {
      expect(rendered).toContain("You: again\nAssistant: 再见\n");
      expect(agent.state.messages).toHaveLength(4);
    });

    input.write("/exit\n");
    await expect(running).resolves.toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("aborts on SIGINT, ignores late output, and accepts another prompt", async () => {
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
    const input = new PassThrough();
    const output = new PassThrough();
    const signals = new EventEmitter();
    let rendered = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      rendered += chunk;
    });

    const running = runTui({ agent, input, output, signals });
    input.write("stop\n");
    await vi.waitFor(() => expect(rendered).toContain("Assistant: partial"));

    signals.emit("SIGINT");
    await vi.waitFor(() => {
      expect(rendered).toContain("已停止当前响应。\n");
      expect(agent.state.running).toBe(false);
    });
    late.resolve();
    input.write("continue\n");
    await vi.waitFor(() => {
      expect(rendered).toContain("You: continue\nAssistant: recovered\n");
      expect(rendered).not.toContain("partial late");
    });

    signals.emit("SIGINT");
    await expect(running).resolves.toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("aborts an active response and cleans listeners on EOF", async () => {
    const late = Promise.withResolvers<void>();
    const modelStream: ModelStream = async function* () {
      yield "partial";
      await late.promise;
      yield " late";
    };
    const agent = createAgent({ modelStream });
    const input = new PassThrough();
    const output = new PassThrough();
    const signals = new EventEmitter();
    let rendered = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      rendered += chunk;
    });

    const running = runTui({ agent, input, output, signals });
    input.write("stop on eof\n");
    await vi.waitFor(() => expect(rendered).toContain("Assistant: partial"));

    input.end();
    await expect(running).resolves.toBe(0);
    expect(agent.state.running).toBe(false);
    expect(agent.state.messages.at(-1)).toEqual({
      role: "assistant",
      content: "partial",
      status: "aborted",
    });
    expect(signals.listenerCount("SIGINT")).toBe(0);

    late.resolve();
    await Promise.resolve();
    expect(agent.state.messages.at(-1)).toEqual({
      role: "assistant",
      content: "partial",
      status: "aborted",
    });
  });

  it("shows a safe failure without appending it to assistant text", async () => {
    const modelStream: ModelStream = async function* () {
      yield "partial";
      throw new Error("Authorization: Bearer secret-value");
    };
    const agent = createAgent({ modelStream });
    const input = new PassThrough();
    const output = new PassThrough();
    const signals = new EventEmitter();
    let rendered = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      rendered += chunk;
    });

    const running = runTui({ agent, input, output, signals });
    input.write("fail\n");
    await vi.waitFor(() => {
      expect(rendered).toContain("Assistant: partial\n错误：");
      expect(agent.state.running).toBe(false);
    });
    expect(rendered).not.toContain("secret-value");
    expect(agent.state.messages.at(-1)).toEqual({
      role: "assistant",
      content: "partial",
      status: "failed",
    });

    input.write("/exit\n");
    await expect(running).resolves.toBe(0);
  });
});
