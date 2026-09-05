import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { AssistantMessage } from "@anthias/agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTui } from "../src/index.js";
import { approvalRequest, createFakeAgent } from "./fixtures.js";
import { createTestTerminal } from "./terminal-fixture.js";

const cleanups = new Set<() => Promise<void>>();
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup();
  cleanups.clear();
});

function createHarness(interactive = true, columns = 100, rows = 28) {
  const fake = createFakeAgent();
  const input = new PassThrough();
  input.resume();
  const output = new PassThrough();
  const signals = new EventEmitter();
  let plain = "";
  output.on("data", (chunk: Buffer) => {
    plain += chunk.toString();
  });
  const terminal = createTestTerminal(columns, rows);
  const result = runTui({
    agent: fake.agent,
    input,
    output,
    signalSource: signals,
    ...(interactive ? { terminal: terminal.terminal } : {}),
    terminalCapabilities: { colorDepth: "truecolor", hyperlinks: false, unicode: true },
  });
  cleanups.add(async () => {
    input.end();
    await result;
    terminal.dispose();
  });
  return { ...fake, input, output, signals, result, terminal, plain: () => plain };
}

async function screenContains(terminal: ReturnType<typeof createTestTerminal>, text: string) {
  await vi.waitFor(async () => {
    await terminal.flush();
    expect(terminal.text()).toContain(text);
  });
}
function assistant(
  content: string,
  status: AssistantMessage["status"] = "streaming",
): AssistantMessage {
  return { role: "assistant", status, content: [{ type: "text", text: content }] };
}

describe("Anthias TUI", () => {
  it("keeps plain output free of controls and routes local commands without model calls", async () => {
    const harness = createHarness(false);
    harness.input.write("/help\n");
    harness.input.write("/mode plan\n");
    harness.input.write("/context\n");
    await vi.waitFor(() => expect(harness.plain()).toContain("外部上下文 200"));
    expect(harness.plain()).toContain(harness.agent.state.workspaceRoot);
    expect(harness.plain()).not.toContain("\u001b");
    expect(harness.agent.prompt).not.toHaveBeenCalled();
    harness.input.write("hello /world\n");
    await vi.waitFor(() => expect(harness.agent.prompt).toHaveBeenCalledWith("hello /world"));
    harness.input.write("//help\n");
    await vi.waitFor(() => expect(harness.agent.prompt).toHaveBeenCalledWith("/help"));
    harness.input.write("/exit\n");
    await expect(harness.result).resolves.toBe(0);
  });

  it("renders unclosed code immediately and coalesces a burst into one synchronized frame", async () => {
    const harness = createHarness();
    await screenContains(harness.terminal, "Workspace:");
    const before = harness.terminal.writes.length;
    harness.emit({ type: "message_start", message: assistant("") });
    let text = "```ts\n";
    for (let index = 0; index < 8; index += 1) {
      text += `const value${index} = ${index};\n`;
      harness.emit({
        type: "message_update",
        message: assistant(text),
        delta: `const value${index} = ${index};\n`,
      });
    }
    await screenContains(harness.terminal, "const value7 = 7;");
    const frames = harness.terminal.writes
      .slice(before)
      .filter((write) => write.includes("\u001b[?2026h"));
    expect(frames).toHaveLength(1);
    expect(frames[0]).not.toContain("\u001b[2J");
    expect(harness.terminal.screen.buffer.active.type).toBe("alternate");
  });

  it("keeps fixed panels and a reading anchor while streamed content grows", async () => {
    const harness = createHarness(true, 100, 25);
    await screenContains(harness.terminal, "Workspace:");
    let text = Array.from({ length: 70 }, (_, index) => `Line ${index}`).join("\n\n");
    harness.emit({ type: "message_start", message: assistant(text) });
    await screenContains(harness.terminal, "Line 69");
    harness.terminal.send("\u001b[5~");
    await vi.waitFor(async () => {
      await harness.terminal.flush();
      expect(harness.terminal.text()).not.toContain("Line 69");
    });
    const readingScreen = harness.terminal.text().split("\n").slice(2, -4).join("\n");
    text += "\n\nNew last line";
    harness.emit({ type: "message_update", message: assistant(text), delta: "\n\nNew last line" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    await harness.terminal.flush();
    expect(harness.terminal.text().split("\n").slice(2, -4).join("\n")).toBe(readingScreen);
    expect(harness.terminal.text()).toContain("Workspace:");
    expect(harness.terminal.text()).not.toContain("New last line");
    harness.terminal.send("\u001b[1;5F");
    await screenContains(harness.terminal, "New last line");
  });

  it("keeps multiline paste and Chinese input through resize as one submission", async () => {
    const harness = createHarness(true, 100, 24);
    await screenContains(harness.terminal, "Workspace:");
    harness.terminal.send("\u001b[200~第一行\nsecond line\u001b[201~");
    await screenContains(harness.terminal, "第一行");
    expect(harness.agent.prompt).not.toHaveBeenCalled();
    harness.terminal.resize(42, 18);
    await screenContains(harness.terminal, "second line");
    harness.terminal.send("\r");
    await vi.waitFor(() =>
      expect(harness.agent.prompt).toHaveBeenCalledWith("第一行\nsecond line"),
    );
    expect(harness.agent.prompt).toHaveBeenCalledOnce();
  });

  it("preserves prompt whitespace before the editor submits and keeps live reasoning readable", async () => {
    const harness = createHarness();
    await screenContains(harness.terminal, "Workspace:");
    harness.terminal.send("  keep this text  ");
    harness.terminal.send("\r");
    await vi.waitFor(() => expect(harness.agent.prompt).toHaveBeenCalledWith("  keep this text  "));
    harness.emit({ type: "reasoning_start", runId: "reasoning-run" });
    harness.emit({ type: "reasoning_update", runId: "reasoning-run", delta: "正在检查项目结构" });
    await screenContains(harness.terminal, "正在检查项目结构");
    harness.emit({ type: "reasoning_end", runId: "reasoning-run" });
    await screenContains(harness.terminal, "已思考");
  });

  it("shows slash completion and keeps invalid commands local", async () => {
    const harness = createHarness();
    await screenContains(harness.terminal, "Workspace:");
    harness.terminal.send("/comp");
    await screenContains(harness.terminal, "compact");
    harness.terminal.send("\t");
    harness.terminal.send("\r");
    await vi.waitFor(() => expect(harness.agent.compact).toHaveBeenCalledOnce());
    expect(harness.agent.prompt).not.toHaveBeenCalled();
  });

  it("requires complete approval review and allows denial without reading", async () => {
    const harness = createHarness(true, 80, 24);
    await screenContains(harness.terminal, "Workspace:");
    const request = approvalRequest(
      Array.from({ length: 50 }, (_, index) => `command line ${index}`).join("\n"),
    );
    harness.setState({ pendingToolApproval: request, running: true });
    harness.emit({ type: "tool_approval_requested", request });
    await screenContains(harness.terminal, "Risk:");
    harness.terminal.send("approve");
    harness.terminal.send("\r");
    expect(harness.agent.respondToToolApproval).not.toHaveBeenCalled();
    harness.terminal.send("\u001b[1;5F");
    await screenContains(harness.terminal, "command line 49");
    harness.terminal.send("approve");
    harness.terminal.send("\r");
    await vi.waitFor(() =>
      expect(harness.agent.respondToToolApproval).toHaveBeenCalledWith(
        request.toolApprovalRequestId,
        "approve",
      ),
    );
    harness.terminal.resize(12, 5);
    harness.terminal.send("deny");
    harness.terminal.send("\r");
    await vi.waitFor(() =>
      expect(harness.agent.respondToToolApproval).toHaveBeenCalledWith(
        request.toolApprovalRequestId,
        "deny",
      ),
    );
  });

  it("blocks an approval with hidden controls and recovers a small approval viewport after resize", async () => {
    const harness = createHarness(true, 15, 6);
    const request = approvalRequest();
    harness.setState({ pendingToolApproval: request, running: true });
    harness.emit({ type: "tool_approval_requested", request });
    harness.terminal.resize(100, 30);
    await screenContains(harness.terminal, "echo hello");
    harness.terminal.send("\u001b[1;5F");
    harness.terminal.send("approve");
    harness.terminal.send("\r");
    await vi.waitFor(() => expect(harness.agent.respondToToolApproval).toHaveBeenCalledOnce());
    const hidden = { ...request, toolApprovalRequestId: "hidden", preview: "safe\u001b[2Jhidden" };
    harness.setState({ pendingToolApproval: hidden });
    harness.emit({ type: "tool_approval_requested", request: hidden });
    harness.terminal.send("approve");
    harness.terminal.send("\r");
    expect(harness.agent.respondToToolApproval).toHaveBeenCalledOnce();
    harness.terminal.send("deny");
    harness.terminal.send("\r");
    expect(harness.agent.respondToToolApproval).toHaveBeenLastCalledWith("hidden", "deny");
  });

  it("retains concurrent Tool output by identity and sanitizes hostile terminal text", async () => {
    const harness = createHarness();
    await screenContains(harness.terminal, "Workspace:");
    for (const id of ["one", "two"])
      harness.emit({
        type: "tool_execution_start",
        activity: { toolCallId: id, toolName: "read_file", summary: id },
      });
    harness.emit({
      type: "tool_execution_update",
      toolCallId: "two",
      toolName: "read_file",
      stream: "stdout",
      delta: "two output\u001b[2J",
    });
    harness.emit({
      type: "tool_execution_end",
      toolCallId: "two",
      toolName: "read_file",
      cleanupUncertain: false,
      result: {
        role: "tool",
        toolCallId: "two",
        toolName: "read_file",
        status: "completed",
        content: "two result",
        truncated: false,
      },
    });
    harness.terminal.send("\u0014");
    await screenContains(harness.terminal, "two output�[2J");
    expect(harness.terminal.text()).toContain("two result");
    harness.terminal.send("/details prev");
    harness.terminal.send("\r");
    await screenContains(harness.terminal, "read_file [one]");
    harness.emit({
      type: "tool_execution_start",
      activity: { toolCallId: "three", toolName: "read_file", summary: "third file" },
    });
    await screenContains(harness.terminal, "详情 1/3");
  });

  it("aborts active work on SIGINT and waits for close on EOF before restoring the screen", async () => {
    const harness = createHarness();
    await screenContains(harness.terminal, "Workspace:");
    const closeCompletion = Promise.withResolvers<void>();
    vi.mocked(harness.agent.close).mockReturnValue(closeCompletion.promise);
    harness.setState({ running: true });
    harness.signals.emit("SIGINT");
    expect(harness.agent.abort).toHaveBeenCalledOnce();
    harness.input.end();
    await vi.waitFor(() => expect(harness.agent.close).toHaveBeenCalledOnce());
    expect(harness.terminal.terminal.stop).not.toHaveBeenCalled();
    closeCompletion.resolve();
    await expect(harness.result).resolves.toBe(0);
    await harness.terminal.flush();
    expect(harness.terminal.screen.buffer.active.type).toBe("normal");
    expect(harness.terminal.terminal.stop).toHaveBeenCalledOnce();
    expect(harness.terminal.terminal.drainInput).toHaveBeenCalledOnce();
    expect(harness.listenerCount()).toBe(0);
    expect(harness.signals.listenerCount("SIGINT")).toBe(0);
  });

  it("restores terminal resources after output fails", async () => {
    const harness = createHarness();
    await screenContains(harness.terminal, "Workspace:");
    const originalWrite = harness.terminal.terminal.write;
    let failed = false;
    harness.terminal.terminal.write = (data) => {
      if (!failed) {
        failed = true;
        throw new Error("terminal unavailable");
      }
      originalWrite(data);
    };
    harness.emit({ type: "message_start", message: assistant("new content") });
    await expect(harness.result).resolves.toBe(1);
    expect(harness.agent.close).toHaveBeenCalledOnce();
    expect(harness.terminal.terminal.stop).toHaveBeenCalledOnce();
  });
});
