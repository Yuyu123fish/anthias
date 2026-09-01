import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Agent, AgentEvent, AgentListener, AgentState, PromptResult } from "@anthias/agent";
import { describe, expect, it, vi } from "vitest";
import { runTui } from "../src/index.js";

type FakeAgentControls = Readonly<{
  publish(event: AgentEvent): void;
  setRunning(running: boolean): void;
}>;

type FakeAgentBehavior = Readonly<{
  prompt(promptText: string, controls: FakeAgentControls): Promise<PromptResult>;
  abort?(controls: FakeAgentControls): void;
}>;

describe("runTui", () => {
  it("renders Agent events and submits multiple prompts", async () => {
    let promptCount = 0;
    const promptHandler = vi.fn(
      async (promptText: string, controls: FakeAgentControls): Promise<PromptResult> => {
        promptCount += 1;
        return completePrompt(promptText, promptCount === 1 ? ["你", "好"] : ["再见"], controls);
      },
    );
    const agent = createFakeAgent({ prompt: promptHandler });
    const input = new PassThrough();
    const output = new PassThrough();
    const signalSource = new EventEmitter();
    let rendered = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      rendered += chunk;
    });

    const tuiExit = runTui({ agent, input, output, signalSource });
    input.write("hello\n");

    await vi.waitFor(() => {
      expect(rendered).toContain("You: hello\nAssistant: 你好\n");
      expect(rendered).toContain("已完成。\n");
      expect(agent.state.running).toBe(false);
    });

    input.write("again\n");
    await vi.waitFor(() => {
      expect(rendered).toContain("You: again\nAssistant: 再见\n");
      expect(promptHandler.mock.calls.map(([promptText]) => promptText)).toEqual([
        "hello",
        "again",
      ]);
    });

    input.write("/exit\n");
    await expect(tuiExit).resolves.toBe(0);
    expect(signalSource.listenerCount("SIGINT")).toBe(0);
  });

  it("maps active SIGINT to abort and accepts another prompt", async () => {
    const firstPromptCompletion = Promise.withResolvers<PromptResult>();
    let promptCount = 0;
    const promptHandler = vi.fn(
      (promptText: string, controls: FakeAgentControls): Promise<PromptResult> => {
        promptCount += 1;
        if (promptCount > 1) {
          return completePrompt(promptText, ["recovered"], controls);
        }

        controls.setRunning(true);
        publishPartialResponse(promptText, "partial", controls);
        return firstPromptCompletion.promise;
      },
    );
    const abortHandler = vi.fn((controls: FakeAgentControls) => {
      controls.publish({
        type: "message_end",
        message: { role: "assistant", content: "partial", status: "aborted" },
      });
      controls.publish({ type: "agent_end", result: { status: "aborted" } });
      controls.setRunning(false);
      firstPromptCompletion.resolve({ status: "aborted" });
    });
    const agent = createFakeAgent({ prompt: promptHandler, abort: abortHandler });
    const input = new PassThrough();
    const output = new PassThrough();
    const signalSource = new EventEmitter();
    let rendered = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      rendered += chunk;
    });

    const tuiExit = runTui({ agent, input, output, signalSource });
    input.write("stop\n");
    await vi.waitFor(() => expect(rendered).toContain("Assistant: partial"));

    signalSource.emit("SIGINT");
    await vi.waitFor(() => {
      expect(abortHandler).toHaveBeenCalledOnce();
      expect(rendered).toContain("已停止当前响应。\n");
      expect(agent.state.running).toBe(false);
    });

    input.write("continue\n");
    await vi.waitFor(() => {
      expect(rendered).toContain("You: continue\nAssistant: recovered\n");
    });

    signalSource.emit("SIGINT");
    await expect(tuiExit).resolves.toBe(0);
    expect(signalSource.listenerCount("SIGINT")).toBe(0);
  });

  it("aborts an active Agent and cleans listeners on EOF", async () => {
    const pendingPromptCompletion = Promise.withResolvers<PromptResult>();
    const promptHandler = vi.fn(
      (promptText: string, controls: FakeAgentControls): Promise<PromptResult> => {
        controls.setRunning(true);
        publishPartialResponse(promptText, "partial", controls);
        return pendingPromptCompletion.promise;
      },
    );
    const abortHandler = vi.fn((controls: FakeAgentControls) => {
      controls.setRunning(false);
      pendingPromptCompletion.resolve({ status: "aborted" });
    });
    const agent = createFakeAgent({ prompt: promptHandler, abort: abortHandler });
    const input = new PassThrough();
    const output = new PassThrough();
    const signalSource = new EventEmitter();

    const tuiExit = runTui({ agent, input, output, signalSource });
    input.write("stop on eof\n");
    await vi.waitFor(() => expect(agent.state.running).toBe(true));

    input.end();
    await expect(tuiExit).resolves.toBe(0);
    expect(abortHandler).toHaveBeenCalledOnce();
    expect(agent.state.running).toBe(false);
    expect(signalSource.listenerCount("SIGINT")).toBe(0);
  });

  it("renders a safe Agent failure without model knowledge", async () => {
    const agent = createFakeAgent({
      prompt: async (promptText, controls) => {
        controls.setRunning(true);
        publishPartialResponse(promptText, "partial", controls);
        controls.publish({
          type: "message_end",
          message: { role: "assistant", content: "partial", status: "failed" },
        });
        controls.publish({
          type: "agent_end",
          result: { status: "failed", error: "模型请求失败，请检查模型配置或稍后重试。" },
        });
        controls.setRunning(false);
        return { status: "failed", error: "模型请求失败，请检查模型配置或稍后重试。" };
      },
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const signalSource = new EventEmitter();
    let rendered = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      rendered += chunk;
    });

    const tuiExit = runTui({ agent, input, output, signalSource });
    input.write("fail\n");
    await vi.waitFor(() => {
      expect(rendered).toContain("Assistant: partial\n错误：");
      expect(agent.state.running).toBe(false);
    });

    input.write("/exit\n");
    await expect(tuiExit).resolves.toBe(0);
  });
});

function createFakeAgent({ prompt, abort }: FakeAgentBehavior): Agent {
  const listeners = new Set<AgentListener>();
  let running = false;
  const controls: FakeAgentControls = {
    publish(event) {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
    setRunning(nextRunning) {
      running = nextRunning;
    },
  };

  return Object.freeze({
    get state(): AgentState {
      return Object.freeze({
        messageHistory: Object.freeze([]),
        activeAssistantMessage: null,
        running,
        lastError: null,
      });
    },
    prompt: (promptText) => prompt(promptText, controls),
    abort: () => abort?.(controls),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
}

async function completePrompt(
  promptText: string,
  chunks: readonly string[],
  controls: FakeAgentControls,
): Promise<PromptResult> {
  controls.setRunning(true);
  publishPromptOpening(promptText, controls);

  let content = "";
  for (const chunk of chunks) {
    content += chunk;
    controls.publish({
      type: "message_update",
      message: { role: "assistant", content, status: "streaming" },
      delta: chunk,
    });
  }

  controls.publish({
    type: "message_end",
    message: { role: "assistant", content, status: "completed" },
  });
  controls.publish({ type: "agent_end", result: { status: "completed" } });
  controls.setRunning(false);
  return { status: "completed" };
}

function publishPartialResponse(
  promptText: string,
  assistantContent: string,
  controls: FakeAgentControls,
): void {
  publishPromptOpening(promptText, controls);
  controls.publish({
    type: "message_update",
    message: { role: "assistant", content: assistantContent, status: "streaming" },
    delta: assistantContent,
  });
}

function publishPromptOpening(promptText: string, controls: FakeAgentControls): void {
  controls.publish({ type: "agent_start" });
  controls.publish({
    type: "message_start",
    message: { role: "user", content: promptText },
  });
  controls.publish({
    type: "message_end",
    message: { role: "user", content: promptText },
  });
  controls.publish({
    type: "message_start",
    message: { role: "assistant", content: "", status: "streaming" },
  });
}
