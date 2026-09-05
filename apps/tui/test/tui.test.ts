import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { AssistantMessage, Message } from "@anthias/agent";
import { Markdown } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalCapabilities } from "../src/content-renderer.js";
import { runTui } from "../src/index.js";
import { approvalRequest, createFakeAgent } from "./fixtures.js";
import { createTestTerminal } from "./terminal-fixture.js";

const cleanups = new Set<() => Promise<void>>();
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup();
  cleanups.clear();
});

function createHarness(
  interactive = true,
  columns = 100,
  rows = 28,
  capabilities: TerminalCapabilities = {
    colorDepth: "truecolor",
    hyperlinks: false,
    unicode: true,
  },
) {
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
    terminalCapabilities: capabilities,
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
function clickText(terminal: ReturnType<typeof createTestTerminal>, text: string): void {
  const { x, y } = terminal.locate(text);
  terminal.mouse(0, x, y);
  terminal.mouse(0, x, y, true);
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
    const contentRows = () =>
      Array.from(
        { length: 19 },
        (_, index) =>
          harness.terminal.screen.buffer.active
            .getLine(index + 2)
            ?.translateToString(true, 0, 99) ?? "",
      ).join("\n");
    const readingScreen = contentRows();
    text += "\n\nNew last line";
    harness.emit({ type: "message_update", message: assistant(text), delta: "\n\nNew last line" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    await harness.terminal.flush();
    expect(contentRows()).toBe(readingScreen);
    expect(harness.terminal.text()).toContain("Workspace:");
    expect(harness.terminal.text()).not.toContain("New last line");
    harness.terminal.send("\u001b[1;5F");
    await screenContains(harness.terminal, "New last line");
  });

  it("collapses a finished process and expands its individual steps with mouse clicks", async () => {
    const harness = createHarness();
    await screenContains(harness.terminal, "Workspace:");
    harness.emit({
      type: "message_start",
      message: { role: "user", content: "Inspect the project" },
    });
    harness.emit({ type: "reasoning_start", runId: "fold-run" });
    harness.emit({
      type: "reasoning_update",
      runId: "fold-run",
      delta: "Inspecting the folder tree",
    });
    harness.emit({ type: "reasoning_end", runId: "fold-run" });
    harness.emit({
      type: "tool_execution_start",
      activity: { toolCallId: "inspect-1", toolName: "read_file", summary: "README.md" },
    });
    harness.emit({
      type: "tool_execution_end",
      toolCallId: "inspect-1",
      toolName: "read_file",
      cleanupUncertain: false,
      result: {
        role: "tool",
        toolCallId: "inspect-1",
        toolName: "read_file",
        status: "completed",
        content: "Specific file contents",
        truncated: false,
      },
    });
    harness.emit({ type: "message_start", message: assistant("The final answer is ready.") });
    harness.emit({
      type: "message_end",
      message: assistant("The final answer is ready.", "completed"),
    });
    harness.emit({ type: "run_end", runId: "fold-run", result: { status: "completed" } });
    await screenContains(harness.terminal, "执行过程");
    expect(harness.terminal.text()).toContain("The final answer is ready.");
    expect(harness.terminal.text()).not.toContain("read_file");
    clickText(harness.terminal, "执行过程");
    await screenContains(harness.terminal, "read_file");
    expect(harness.terminal.text()).not.toContain("Specific file contents");
    clickText(harness.terminal, "read_file");
    await screenContains(harness.terminal, "Specific file contents");
    clickText(harness.terminal, "read_file");
    await vi.waitFor(async () => {
      await harness.terminal.flush();
      expect(harness.terminal.text()).not.toContain("Specific file contents");
    });
    clickText(harness.terminal, "执行过程");
    await vi.waitFor(async () => {
      await harness.terminal.flush();
      expect(harness.terminal.text()).not.toContain("read_file");
    });
    expect(harness.terminal.text()).toContain("The final answer is ready.");
  });

  it.each([true, false])(
    "shows a scrollbar thumb and preserves native mouse dragging (unicode: %s)",
    async (unicode) => {
      const harness = createHarness(true, 80, 24, {
        colorDepth: unicode ? "truecolor" : "none",
        hyperlinks: false,
        unicode,
      });
      await screenContains(harness.terminal, "Workspace:");
      harness.emit({
        type: "message_start",
        message: assistant(
          Array.from({ length: 100 }, (_, index) => `Scrollable line ${index}`).join("\n\n"),
        ),
      });
      await screenContains(harness.terminal, "Scrollable line 99");
      const thumbRows = Array.from({ length: 24 }, (_, row) => row).filter(
        (row) =>
          harness.terminal.screen.buffer.active.getLine(row)?.getCell(79)?.getChars() ===
          (unicode ? "┃" : "#"),
      );
      expect(thumbRows.length).toBeGreaterThan(0);
      harness.terminal.mouse(0, 79, thumbRows[0] ?? 0);
      harness.terminal.mouse(32, 79, 2);
      harness.terminal.mouse(0, 79, 2, true);
      await screenContains(harness.terminal, "Scrollable line 0");
      expect(harness.terminal.text()).not.toContain("Scrollable line 99");
    },
  );

  it("reuses rendered Markdown during wheel scrolling and input changes", async () => {
    const harness = createHarness();
    await screenContains(harness.terminal, "Workspace:");
    harness.emit({
      type: "message_start",
      message: assistant(
        Array.from({ length: 80 }, (_, index) => `Cached paragraph ${index}`).join("\n\n"),
      ),
    });
    await screenContains(harness.terminal, "Cached paragraph 79");
    // 等待正文已有的异步文件装饰完成，再测量纯滚轮路径。
    await new Promise((resolve) => setTimeout(resolve, 120));
    await harness.terminal.flush();
    const markdownRender = vi.spyOn(Markdown.prototype, "render");
    try {
      for (let index = 0; index < 8; index += 1) {
        harness.terminal.mouse(64, 20, 10);
        await new Promise((resolve) => setTimeout(resolve, 25));
        await harness.terminal.flush();
      }
      harness.terminal.send("a draft");
      await screenContains(harness.terminal, "a draft");
      expect(harness.terminal.text()).not.toContain("Cached paragraph 79");
      expect(markdownRender).not.toHaveBeenCalled();
    } finally {
      markdownRender.mockRestore();
    }
  });

  it("restores grouped history and keeps mouse controls accurate after scrolling and resize", async () => {
    const harness = createHarness(true, 120, 28);
    await screenContains(harness.terminal, "Workspace:");
    const history: Message[] = [];
    for (let index = 0; index < 8; index += 1) {
      history.push(
        { role: "user", content: `Historical task ${index}` },
        {
          role: "assistant",
          status: "completed",
          content: [
            { type: "text", text: `Intermediate plan ${index}` },
            {
              type: "tool_call",
              toolCallId: `call-${index}`,
              toolName: "read_file",
              input: {},
              invalid: false,
            },
          ],
        },
        {
          role: "tool",
          toolCallId: `call-${index}`,
          toolName: "read_file",
          status: "completed",
          content: Array.from({ length: 60 }, (_, line) => `Result ${index} line ${line}`).join(
            "\n",
          ),
          truncated: false,
        },
        {
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "tool_call",
              toolCallId: `next-${index}`,
              toolName: "read_file",
              input: {},
              invalid: false,
            },
          ],
        },
        {
          role: "tool",
          toolCallId: `next-${index}`,
          toolName: "read_file",
          status: "completed",
          content: `Separate result ${index}`,
          truncated: false,
        },
        assistant(`Historical answer ${index}`, "completed"),
      );
    }
    harness.setState({ messageHistory: history });
    harness.emit({ type: "session_changed", sessionId: harness.agent.state.sessionId });
    await screenContains(harness.terminal, "Historical answer 7");
    expect(harness.terminal.text()).not.toContain("Reasoning");
    harness.terminal.send("\u001b[1;5H");
    await screenContains(harness.terminal, "Historical task 0");
    harness.terminal.mouse(65, 20, 8);
    await vi.waitFor(async () => {
      await harness.terminal.flush();
      expect(harness.terminal.locate("Historical task 0").y).toBe(2);
    });
    expect(harness.terminal.text()).toContain("执行过程 · 3 步");
    const processTitle = harness.terminal.locate("执行过程");
    harness.terminal.mouse(0, processTitle.x, processTitle.y);
    harness.terminal.mouse(32, processTitle.x + 1, processTitle.y);
    harness.terminal.mouse(0, processTitle.x + 1, processTitle.y, true);
    await harness.terminal.flush();
    expect(harness.terminal.text()).not.toContain("read_file");
    clickText(harness.terminal, "执行过程");
    await screenContains(harness.terminal, "[call-0]");
    expect(harness.terminal.locate("执行过程").y).toBe(processTitle.y);
    clickText(harness.terminal, "中间回复");
    await screenContains(harness.terminal, "Intermediate plan 0");
    clickText(harness.terminal, "中间回复");
    await vi.waitFor(async () => {
      await harness.terminal.flush();
      expect(harness.terminal.text()).not.toContain("Intermediate plan 0");
    });
    const stepTitle = harness.terminal.locate("[call-0]");
    clickText(harness.terminal, "[call-0]");
    await screenContains(harness.terminal, "Result 0 line 0");
    expect(harness.terminal.locate("[call-0]").y).toBe(stepTitle.y);
    expect(harness.terminal.text()).not.toContain("Separate result 0");
    const content = harness.terminal.locate("Result 0 line 0");
    harness.terminal.mouse(0, content.x, content.y);
    harness.terminal.mouse(32, content.x + 5, content.y);
    harness.terminal.mouse(0, content.x + 5, content.y, true);
    await vi.waitFor(() =>
      expect(harness.terminal.writes.some((write) => write.startsWith("\u001b]52;"))).toBe(true),
    );
    expect(harness.terminal.text()).toContain("Result 0 line 0");
    harness.terminal.send("\u0014");
    await screenContains(harness.terminal, "详情 16/16");
    clickText(harness.terminal, "[<]");
    await screenContains(harness.terminal, "详情 15/16");
    harness.terminal.resize(80, 28);
    await vi.waitFor(async () => {
      await harness.terminal.flush();
      expect(harness.terminal.text()).not.toContain("Historical task 0");
    });
    expect(harness.terminal.text()).toContain("详情 15/16");
    clickText(harness.terminal, "[>]");
    await screenContains(harness.terminal, "Separate result 7");
    expect(harness.terminal.screen.buffer.active.getLine(4)?.getCell(79)?.getChars()).toBe("┃");
    clickText(harness.terminal, "[x]");
    await screenContains(harness.terminal, "[call-0]");
    harness.terminal.mouse(0, 5, 25);
    harness.terminal.mouse(0, 5, 25, true);
    expect(harness.terminal.text()).toContain("Result 0 line 0");
    clickText(harness.terminal, "[call-0]");
    await vi.waitFor(async () => {
      await harness.terminal.flush();
      expect(harness.terminal.text()).not.toContain("Result 0 line 0");
    });
    clickText(harness.terminal, "[next-0]");
    await screenContains(harness.terminal, "Separate result 0");
  });

  it("retains failed and stopped process status and closes intermediate details at run end", async () => {
    const harness = createHarness(true, 80, 26);
    await screenContains(harness.terminal, "Workspace:");
    for (const status of ["failed", "aborted"] as const) {
      harness.emit({ type: "message_start", message: { role: "user", content: `Task ${status}` } });
      harness.emit({ type: "reasoning_start", runId: status });
      harness.emit({
        type: "reasoning_update",
        runId: status,
        delta: `Retained ${status} reasoning`,
      });
      harness.emit({ type: "reasoning_end", runId: status });
      harness.terminal.send("\u0014");
      await screenContains(harness.terminal, `Retained ${status} reasoning`);
      harness.emit({ type: "message_start", message: assistant(`Partial answer ${status}`) });
      harness.emit({ type: "message_end", message: assistant(`Partial answer ${status}`, status) });
      harness.emit({
        type: "run_end",
        runId: status,
        result: status === "failed" ? { status, error: "Local failure" } : { status },
      });
      await screenContains(harness.terminal, `Partial answer ${status}`);
      expect(harness.terminal.text()).not.toContain(`Retained ${status} reasoning`);
      expect(harness.terminal.text()).toContain(
        status === "failed" ? "执行过程 · 1 步 · 失败" : "执行过程 · 1 步 · 已停止",
      );
    }
    harness.terminal.send("\u001b[1;5H");
    await screenContains(harness.terminal, "执行过程 · 1 步 · 失败");
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
    harness.terminal.send("\u0014");
    harness.terminal.send("\u001b");
    harness.terminal.mouse(0, 20, 2);
    harness.terminal.mouse(0, 20, 2, true);
    await screenContains(harness.terminal, "执行确认");
    expect(harness.terminal.text()).not.toContain("[x]");
    harness.terminal.send("approve");
    harness.terminal.send("\r");
    expect(harness.agent.respondToToolApproval).not.toHaveBeenCalled();
    harness.terminal.mouse(0, 79, 3);
    harness.terminal.mouse(32, 79, 19);
    harness.terminal.mouse(0, 79, 19, true);
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
