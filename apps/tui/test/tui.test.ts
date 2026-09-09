import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type {
  AgentState,
  AssistantMessage,
  CollaborationSnapshot,
  Message,
  PromptResult,
  RunDiagnostic,
} from "@anthias/agent";
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
  initialState: Partial<AgentState> = {},
) {
  const fake = createFakeAgent();
  fake.setState(initialState);
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
        content: "Read completed\nFirst preview line\nSpecific file contents",
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
    expect(harness.terminal.text()).toContain("Read completed");
    clickText(harness.terminal, "执行过程");
    await screenContains(harness.terminal, "Reasoning");
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
      expect(harness.terminal.text()).not.toContain("Specific file contents");
    });
    expect(harness.terminal.text()).toContain("Read completed");
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
    expect(harness.terminal.text()).not.toContain("Intermediate plan 0");
    clickText(harness.terminal, "执行过程");
    await screenContains(harness.terminal, "中间回复");
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
    expect(harness.terminal.text()).not.toContain("Result 0 line 59");
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
      expect(harness.terminal.text()).not.toContain("Result 0 line 3");
    });
    clickText(harness.terminal, "[next-0]");
    await screenContains(harness.terminal, "Separate result 0");
  });

  it("retains failed and stopped status without closing user-opened details at run end", async () => {
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
      await screenContains(harness.terminal, `Retained ${status} reasoning`);
      harness.terminal.send("\u0014");
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

describe("daily usage interactions", () => {
  it("keeps streamed progress after command results and bounds long command output", async () => {
    const harness = createHarness(true, 110, 32);
    await screenContains(harness.terminal, "Workspace:");
    harness.setState({ running: true });
    harness.emit({ type: "message_start", message: { role: "user", content: "Build the page" } });
    harness.emit({ type: "message_start", message: assistant("BEFORE_COMMAND") });
    harness.terminal.send("/context");
    harness.terminal.send("\r");
    await screenContains(harness.terminal, "/context");
    harness.emit({
      type: "message_update",
      message: assistant("BEFORE_COMMAND\n\nAFTER_COMMAND"),
      delta: "\n\nAFTER_COMMAND",
    });
    await screenContains(harness.terminal, "AFTER_COMMAND");
    expect(harness.terminal.locate("AFTER_COMMAND").y).toBeGreaterThan(
      harness.terminal.locate("/context").y,
    );
    expect(harness.terminal.text().match(/BEFORE_COMMAND/gu)).toHaveLength(1);
    harness.terminal.send("/help");
    harness.terminal.send("\r");
    await screenContains(harness.terminal, "/help · [详情]");
    expect(harness.terminal.text()).not.toContain("Shift+Enter");
    clickText(harness.terminal, "/help · [详情]");
    await screenContains(harness.terminal, "详情 2/2");
    harness.terminal.send("\u001b[1;5F");
    await screenContains(harness.terminal, "// 开头会将一个 /");
    harness.terminal.send("\u001b");
    await screenContains(harness.terminal, "AFTER_COMMAND");
    harness.emit({
      type: "message_update",
      message: assistant("BEFORE_COMMAND\n\nAFTER_COMMAND\n\nLATEST_PROGRESS"),
      delta: "\n\nLATEST_PROGRESS",
    });
    await screenContains(harness.terminal, "LATEST_PROGRESS");
    expect(harness.terminal.locate("LATEST_PROGRESS").y).toBeGreaterThan(
      harness.terminal.locate("/help ·").y,
    );
  });

  it("restores rejected multiline input and protects a newer draft from asynchronous rejection", async () => {
    const harness = createHarness(true, 100, 30);
    await screenContains(harness.terminal, "Workspace:");
    vi.mocked(harness.agent.prompt).mockResolvedValueOnce({ status: "rejected", reason: "busy" });
    harness.terminal.send("\u001b[200~第一行草稿\n第二行草稿\u001b[201~");
    harness.terminal.send("\r");
    await vi.waitFor(async () => {
      await harness.terminal.flush();
      expect(harness.terminal.text().split("\n").slice(-6).join("\n")).toContain("第二行草稿");
    });
    harness.input.end();
    await harness.result;

    const next = createHarness(true, 100, 30);
    const rejection = Promise.withResolvers<PromptResult>();
    vi.mocked(next.agent.prompt).mockReturnValueOnce(rejection.promise);
    await screenContains(next.terminal, "Workspace:");
    next.terminal.send("PREVIOUS_DRAFT");
    next.terminal.send("\r");
    next.terminal.send("NEW_DRAFT");
    rejection.resolve({ status: "rejected", reason: "session_busy" });
    await screenContains(next.terminal, "/draft");
    expect(next.terminal.text().split("\n").slice(-4).join("\n")).toContain("NEW_DRAFT");
    next.terminal.send("\u0015");
    next.terminal.send("/draft");
    next.terminal.send("\r");
    await vi.waitFor(async () => {
      await next.terminal.flush();
      expect(next.terminal.text().split("\n").slice(-4).join("\n")).toContain("PREVIOUS_DRAFT");
    });
  });

  it("tracks tool preparation, approval and failure with one card and keeps member identities separate", async () => {
    const harness = createHarness(true, 140, 42);
    await screenContains(harness.terminal, "Workspace:");
    harness.emit({ type: "message_start", message: { role: "user", content: "Edit files" } });
    harness.emit({
      type: "tool_preparation",
      runId: "run-1",
      toolCallId: "shared-call",
      toolName: "write_file",
      phase: "input",
    });
    await screenContains(harness.terminal, "参数生成中");
    harness.emit({
      type: "tool_preparation",
      runId: "run-1",
      toolCallId: "shared-call",
      toolName: "write_file",
      phase: "ready",
    });
    await screenContains(harness.terminal, "等待执行");
    harness.emit({
      type: "tool_preparation",
      runId: "member-run",
      toolCallId: "shared-call",
      toolName: "read_file",
      phase: "ready",
      memberSessionId: "member-1",
      memberName: "Checker",
    });
    const request = { ...approvalRequest(), toolCallId: "shared-call", toolName: "write_file" };
    harness.setState({ pendingToolApproval: request, running: true });
    harness.emit({ type: "tool_approval_requested", request });
    await screenContains(harness.terminal, "等待批准");
    harness.setState({ pendingToolApproval: null });
    harness.emit({ type: "tool_approval_resolved", request, decision: "approve" });
    harness.emit({
      type: "tool_execution_start",
      activity: { toolCallId: "shared-call", toolName: "write_file", summary: "note.md" },
    });
    const result = {
      role: "tool" as const,
      toolCallId: "shared-call",
      toolName: "write_file",
      status: "failed" as const,
      content: "Expected a workspace-relative path; outside target rejected.",
      truncated: false,
    };
    harness.emit({
      type: "tool_execution_end",
      toolCallId: "shared-call",
      toolName: "write_file",
      result,
      cleanupUncertain: false,
    });
    harness.emit({ type: "message_end", message: result });
    harness.emit({
      type: "run_end",
      runId: "run-1",
      result: { status: "failed", error: "Safe local failure" },
    });
    await screenContains(harness.terminal, "outside target rejected");
    expect(harness.terminal.text()).toContain("成员 Checker");
    expect(harness.terminal.text().match(/write_file \[red-call\]/gu)).toHaveLength(1);
    harness.terminal.send("\u0014");
    await screenContains(harness.terminal, "详情 2/2");
  });

  it.each([true, false])(
    "shows missing workspace authorization at startup with interactive=%s",
    async (interactive) => {
      const harness = createHarness(interactive, 110, 30, undefined, {
        permissionMode: "auto_allow",
      });
      if (interactive) await screenContains(harness.terminal, "自动审核不等于工作区授权");
      else await vi.waitFor(() => expect(harness.plain()).toContain("自动审核不等于工作区授权"));
      expect(harness.agent.permissions.grant).not.toHaveBeenCalled();
      expect(harness.agent.prompt).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    "shows FullAccess and explains how to leave it with interactive=%s",
    async (interactive) => {
      const harness = createHarness(interactive, 130, 32, undefined, {
        permissionMode: "full_access",
      });
      if (interactive) await screenContains(harness.terminal, "访问能力不等于任务授权");
      else await vi.waitFor(() => expect(harness.plain()).toContain("Mode: FullAccess"));
      if (interactive) {
        harness.terminal.send("/permissions revoke");
        harness.terminal.send("\r");
        await screenContains(harness.terminal, "FullAccess 仍然生效");
      } else {
        harness.input.write("/permissions revoke\n");
        await vi.waitFor(() => expect(harness.plain()).toContain("FullAccess 仍然生效"));
      }
      expect(harness.agent.state.permissionMode).toBe("full_access");
      expect(harness.agent.setPermissionMode).not.toHaveBeenCalled();
      expect(harness.agent.prompt).not.toHaveBeenCalled();
    },
  );

  it("reviews the merged command prefix and only grants after reaching its boundary", async () => {
    const harness = createHarness(true, 110, 30);
    await screenContains(harness.terminal, "Workspace:");
    harness.terminal.send('/permissions command --remember --prefix --cwd "web app" -- python -u');
    harness.terminal.send("\r");
    await screenContains(harness.terminal, "python -u");
    expect(harness.agent.permissions.grant).not.toHaveBeenCalled();
    harness.terminal.send("grant");
    harness.terminal.send("\r");
    await screenContains(harness.terminal, "请完整浏览授权范围");
    expect(harness.agent.permissions.grant).not.toHaveBeenCalled();
    harness.terminal.send("\u001b[1;5F");
    await screenContains(harness.terminal, "不限于测试");
    harness.terminal.send("grant");
    harness.terminal.send("\r");
    await vi.waitFor(() =>
      expect(harness.agent.permissions.grant).toHaveBeenCalledWith({
        remember: true,
        includeMembers: false,
        commands: [
          { command: "pnpm test", cwd: "." },
          { command: "python -u", cwd: "web app", allowArguments: true },
        ],
      }),
    );
    expect(harness.agent.respondToToolApproval).not.toHaveBeenCalled();
  });

  it("rejects a reviewed grant after authorization is revoked", async () => {
    const harness = createHarness(false);
    harness.input.write("/permissions command --prefix -- python\n");
    await vi.waitFor(() => expect(harness.plain()).toContain("完整浏览后输入 grant"));
    vi.mocked(harness.agent.permissions.snapshot).mockReturnValue({
      workspaceRoot: harness.agent.state.workspaceRoot,
      grant: null,
      revoked: true,
      availableCommands: [{ command: "pnpm test", cwd: "." }],
    });
    harness.input.write("grant\n");
    await vi.waitFor(() => expect(harness.plain()).toContain("当前授权状态已变化"));
    expect(harness.agent.permissions.grant).not.toHaveBeenCalled();
  });

  it("keeps workspace grants separate from pending tool approval", async () => {
    const harness = createHarness(false);
    harness.input.write("/permissions command --prefix -- python\n");
    await vi.waitFor(() => expect(harness.plain()).toContain("完整浏览后输入 grant"));
    const request = approvalRequest();
    harness.setState({ pendingToolApproval: request, running: true });
    harness.emit({ type: "tool_approval_requested", request });
    expect(harness.plain()).toContain("已取消尚未确认的工作区授权");
    harness.input.write("grant\n");
    harness.input.write("/permissions command --prefix -- python\n");
    await vi.waitFor(() => expect(harness.plain()).toContain("新增工作区授权不会批准当前动作"));
    expect(harness.agent.permissions.grant).not.toHaveBeenCalled();
    expect(harness.agent.respondToToolApproval).not.toHaveBeenCalled();
    expect(harness.agent.prompt).not.toHaveBeenCalled();
  });

  it("restores permission preview commands rejected by a pending tool approval", async () => {
    const harness = createHarness(true, 140, 36, undefined, {
      pendingToolApproval: approvalRequest(),
      running: true,
    });
    await screenContains(harness.terminal, "Workspace:");
    for (const command of ["/permissions grant", "/permissions command -- pnpm test"]) {
      harness.terminal.send("\u0015");
      harness.terminal.send(command);
      harness.terminal.send("\r");
      await vi.waitFor(async () => {
        await harness.terminal.flush();
        expect(harness.terminal.text().replace(/\s/gu, "")).toContain(
          "新增工作区授权不会批准当前动作",
        );
        expect(harness.terminal.text().split("\n").slice(-5).join("\n")).toContain(command);
      });
    }
    expect(harness.agent.permissions.grant).not.toHaveBeenCalled();
    expect(harness.agent.respondToToolApproval).not.toHaveBeenCalled();
    expect(harness.agent.prompt).not.toHaveBeenCalled();
  });

  it("requires an explicit reviewed grant and keeps revocation available during a run", async () => {
    const harness = createHarness(true, 110, 30);
    await screenContains(harness.terminal, "Workspace:");
    harness.setState({ running: true });
    harness.terminal.send("/permissions grant --remember --members");
    harness.terminal.send("\r");
    await screenContains(harness.terminal, "工作区授权");
    expect(harness.agent.permissions.grant).not.toHaveBeenCalled();
    harness.terminal.send("\u001b[1;5F");
    await screenContains(harness.terminal, "当前系统用户");
    expect(harness.terminal.text()).toContain("OS 沙箱");
    harness.terminal.send("grant");
    harness.terminal.send("\r");
    await vi.waitFor(() =>
      expect(harness.agent.permissions.grant).toHaveBeenCalledWith({
        remember: true,
        includeMembers: true,
      }),
    );
    expect(harness.agent.setPermissionMode).not.toHaveBeenCalled();
    harness.terminal.send("/permissions revoke");
    harness.terminal.send("\r");
    await vi.waitFor(() => expect(harness.agent.permissions.revoke).toHaveBeenCalledOnce());
    await screenContains(harness.terminal, "已产生副作用不回滚");
    expect(harness.agent.prompt).not.toHaveBeenCalled();
  });

  it("shows safe retry and restored failure diagnostics and continues only after user input", async () => {
    const harness = createHarness(true, 120, 36);
    await screenContains(harness.terminal, "Workspace:");
    const diagnostic: RunDiagnostic = {
      category: "network",
      summary: "模型请求遇到暂时网络错误。",
      providerFinishReason: null,
      usage: null,
      retryCount: 1,
      abortSource: null,
      httpStatus: null,
      retryStopReason: "exhausted",
    };
    harness.setState({ running: true });
    harness.emit({
      type: "tool_preparation",
      runId: "retry-run",
      toolCallId: "retry-input",
      toolName: "read_file",
      phase: "input",
    });
    harness.emit({
      type: "model_retry",
      runId: "retry-run",
      phase: "waiting",
      retryCount: 1,
      delayMs: 500,
      diagnostic,
    });
    await screenContains(harness.terminal, "重试 1/2");
    harness.emit({
      type: "model_retry",
      runId: "retry-run",
      phase: "requesting",
      retryCount: 1,
      delayMs: 0,
      diagnostic,
    });
    await screenContains(harness.terminal, "准备已中断");
    harness.emit({
      type: "tool_preparation",
      runId: "retry-run",
      toolCallId: "retry-input",
      toolName: "read_file",
      phase: "input",
    });
    await screenContains(harness.terminal, "参数生成中");
    expect(harness.terminal.text().split("read_file [ry-input]")).toHaveLength(2);
    harness.signals.emit("SIGINT");
    expect(harness.agent.abort).toHaveBeenCalledOnce();
    harness.setState({ running: false, lastRunDiagnostic: diagnostic });
    harness.emit({
      type: "run_end",
      runId: "retry-run",
      result: { status: "failed", error: diagnostic.summary },
      diagnostic,
    });
    await screenContains(harness.terminal, "输入 /continue");
    expect(harness.agent.prompt).not.toHaveBeenCalled();
    harness.emit({ type: "session_changed", sessionId: harness.agent.state.sessionId });
    await screenContains(harness.terminal, "最近运行诊断");
    harness.terminal.send("\u0014");
    await screenContains(harness.terminal, "输入 未知");
    harness.terminal.send("\u0014");
    harness.terminal.send("/continue 保留完成的文件");
    harness.terminal.send("\r");
    await vi.waitFor(() =>
      expect(harness.agent.prompt).toHaveBeenCalledWith("继续上一任务。补充要求：\n保留完成的文件"),
    );
  });
});

describe("permission review feedback", () => {
  it("keeps current reading open until approval is explicitly selected", async () => {
    const harness = createHarness(true, 80, 28);
    await screenContains(harness.terminal, "Workspace:");
    harness.terminal.send("/help");
    harness.terminal.send("\r");
    await screenContains(harness.terminal, "/help · [详情]");
    clickText(harness.terminal, "/help · [详情]");
    await screenContains(harness.terminal, "详情 1/1");
    const request = approvalRequest();
    harness.setState({ pendingToolApproval: request, running: true });
    harness.emit({ type: "tool_approval_requested", request });
    await screenContains(harness.terminal, "详情 1/2");
    expect(harness.terminal.text()).not.toContain("Risk:");
    harness.terminal.send("/approval");
    harness.terminal.send("\r");
    await screenContains(harness.terminal, "Risk:");
    expect(harness.agent.respondToToolApproval).not.toHaveBeenCalled();
  });

  it("reports a failed remembered save with the actual session scope", async () => {
    const harness = createHarness(true, 110, 38);
    await screenContains(harness.terminal, "Workspace:");
    vi.mocked(harness.agent.permissions.grant).mockImplementationOnce(async () => {
      vi.mocked(harness.agent.permissions.snapshot).mockReturnValue({
        workspaceRoot: harness.agent.state.workspaceRoot,
        revoked: false,
        grant: {
          remember: false,
          includeMembers: false,
          files: true,
          commands: [{ command: "pnpm test", cwd: "." }],
        },
        availableCommands: [{ command: "pnpm test", cwd: "." }],
      });
      return { ok: false, error: "本次会话授权已生效，但跨启动设置未保存。" };
    });
    harness.terminal.send("/permissions grant --remember");
    harness.terminal.send("\r");
    await screenContains(harness.terminal, "完整浏览后输入 grant");
    harness.terminal.send("\u001b[1;5F");
    harness.terminal.send("grant");
    harness.terminal.send("\r");
    await screenContains(harness.terminal, "跨启动设置未保存");
    await screenContains(harness.terminal, "有效范围：仅本次会话");
    expect(harness.terminal.text()).not.toContain("已生效并记住");
  });
});

it("keeps member runs separate and preserves root streaming across failure and resume", async () => {
  const harness = createHarness(true, 170, 56);
  await screenContains(harness.terminal, "Workspace:");
  harness.setState({ running: true, activeRun: { runId: "root-run", phase: "requesting_model" } });
  harness.emit({ type: "message_start", message: { role: "user", content: "Root task" } });
  harness.emit({ type: "message_start", message: assistant("ROOT_STREAM") });
  harness.emit({
    type: "tool_preparation",
    runId: "root-run",
    toolCallId: "root-tool",
    toolName: "read_file",
    phase: "input",
  });
  const memberSource = { memberSessionId: "member-1", memberName: "Checker" };
  harness.emit({
    type: "tool_preparation",
    runId: "member-run",
    toolCallId: "member-tool",
    toolName: "grep",
    phase: "input",
    ...memberSource,
  });
  await screenContains(harness.terminal, "成员 Checker [member-1]");
  expect(harness.terminal.text()).not.toContain("grep [ber-tool]");
  harness.emit({
    type: "run_end",
    runId: "member-run",
    ...memberSource,
    result: { status: "failed", error: "Member model failed before completing parameters" },
  });
  await screenContains(harness.terminal, "Member model failed");
  expect(harness.terminal.text()).not.toContain("grep [ber-tool]");
  const memberHeading = harness.terminal.locate("成员 Checker [member-1]");
  harness.terminal.mouse(0, memberHeading.x, memberHeading.y);
  harness.emit({
    type: "run_end",
    runId: "member-run",
    ...memberSource,
    result: { status: "failed", error: "Updated failure while clicking" },
  });
  await screenContains(harness.terminal, "Updated failure while clicking");
  harness.terminal.mouse(0, memberHeading.x, memberHeading.y, true);
  await screenContains(harness.terminal, "grep [ber-tool] · 未执行");
  expect(harness.terminal.text()).toContain("read_file [oot-tool] · 参数生成中");
  expect(harness.terminal.text()).toContain("执行过程 · 1 步 · 运行中");
  harness.emit({
    type: "message_update",
    message: assistant("ROOT_STREAM_CONTINUES"),
    delta: "_CONTINUES",
  });
  await screenContains(harness.terminal, "ROOT_STREAM_CONTINUES");
  harness.emit({
    type: "tool_preparation",
    runId: "resumed-member-run",
    toolCallId: "member-tool",
    toolName: "grep",
    phase: "input",
    ...memberSource,
  });
  // 同一成员恢复后的请求复用 Tool ID 时，旧结束事件仍只能完成旧 Run 的呈现。
  harness.emit({
    type: "run_end",
    runId: "member-run",
    ...memberSource,
    result: { status: "failed", error: "Late old run end" },
  });
  await screenContains(harness.terminal, "Run resumed-member-run");
  expect(harness.terminal.text()).toContain("grep [ber-tool] · 未执行");
  expect(harness.terminal.text()).toContain("grep [ber-tool] · 参数生成中");
  expect(harness.terminal.text().match(/执行过程 · 1 步 · 运行中/gu)).toHaveLength(2);
  expect(harness.terminal.text()).not.toContain("Late old run end");
  harness.terminal.send("\u0014");
  await screenContains(harness.terminal, "详情 3/3");
  expect(harness.terminal.text()).toContain("根 Session");
  expect(harness.terminal.text()).toContain("Run resumed-member-run");
  expect(harness.agent.state.lastRunDiagnostic).toBeUndefined();
  expect(harness.agent.abort).not.toHaveBeenCalled();
});

it("restores root and member summaries without opening member sessions", async () => {
  const rootSessionId = "00000000-0000-4000-8000-000000000001";
  const snapshot: CollaborationSnapshot = {
    rootSessionId,
    team: null,
    tasks: [],
    members: [
      {
        sessionId: "closed-member",
        name: "Reviewer",
        kind: "teammate",
        status: "closed",
        workspaceRoot: process.cwd(),
        writable: false,
        task: "Review existing changes",
        result: "Saved review result",
      },
      {
        sessionId: "missing-member",
        name: "",
        kind: "subagent",
        status: "failed",
        workspaceRoot: process.cwd(),
        writable: false,
        task: "Check source files",
        error: "Member log is missing",
      },
    ],
  };
  const harness = createHarness(true, 140, 44, undefined, {
    collaboration: snapshot,
    messageHistory: [assistant("Saved root answer", "completed")],
  });
  await screenContains(harness.terminal, "主 Agent · 根 Session " + rootSessionId);
  expect(harness.terminal.text()).toContain("Saved root answer");
  expect(harness.terminal.text()).toContain("成员 Reviewer [closed-member] · teammate · 已释放");
  expect(harness.terminal.text()).toContain("Review existing changes");
  expect(harness.terminal.text()).toContain("Saved review result");
  expect(harness.terminal.text()).toContain(
    "成员 missing-member [missing-member] · subagent · 失败",
  );
  expect(harness.terminal.text()).toContain("尚无结果摘要。");
  expect(harness.terminal.text()).toContain("Member log is missing");
  clickText(harness.terminal, "成员 Reviewer");
  await screenContains(harness.terminal, "/agent result closed-member");
  expect(harness.agent.collaboration.execute).not.toHaveBeenCalled();
  expect(harness.agent.sessions.open).not.toHaveBeenCalled();
  expect(harness.agent.sessions.create).not.toHaveBeenCalled();
  expect(harness.agent.prompt).not.toHaveBeenCalled();
  harness.terminal.send("Continue in the root");
  harness.terminal.send("\r");
  await vi.waitFor(() => expect(harness.agent.prompt).toHaveBeenCalledWith("Continue in the root"));
  expect(harness.agent.state.sessionId).toBe(rootSessionId);
});

it("keeps plain member process in sourced details and relabels interrupted root output", async () => {
  const harness = createHarness(false);
  await vi.waitFor(() => expect(harness.plain()).toContain("根会话 Session:"));
  harness.emit({ type: "message_start", message: assistant("") });
  harness.emit({ type: "message_update", message: assistant("ROOT_START"), delta: "ROOT_START" });
  const memberSource = { memberSessionId: "member-1", memberName: "Checker" };
  harness.emit({
    type: "tool_preparation",
    runId: "member-run",
    toolCallId: "member-tool",
    toolName: "execute_command",
    phase: "input",
    ...memberSource,
  });
  harness.emit({
    type: "tool_execution_update",
    toolCallId: "member-tool",
    toolName: "execute_command",
    stream: "stdout",
    delta: "MEMBER_PRIVATE_PROCESS",
    ...memberSource,
  });
  expect(harness.plain()).not.toContain("MEMBER_PRIVATE_PROCESS");
  expect(harness.plain()).not.toContain("参数生成中");
  const request = { ...approvalRequest(), toolCallId: "member-tool", ...memberSource };
  harness.setState({ pendingToolApproval: request });
  harness.emit({ type: "tool_approval_requested", request });
  await vi.waitFor(() => expect(harness.plain()).toContain("成员: Checker"));
  harness.emit({
    type: "message_update",
    message: assistant("ROOT_START_AFTER_APPROVAL"),
    delta: "_AFTER_APPROVAL",
  });
  expect(harness.plain()).toContain("主 Agent（继续）\n_AFTER_APPROVAL");
  harness.setState({ pendingToolApproval: null });
  harness.emit({ type: "tool_approval_resolved", request, decision: "deny" });
  harness.emit({
    type: "run_end",
    runId: "member-run",
    ...memberSource,
    result: { status: "completed" },
  });
  harness.emit({
    type: "message_update",
    message: assistant("ROOT_START_AFTER_APPROVAL_AFTER_MEMBER"),
    delta: "_AFTER_MEMBER",
  });
  expect(harness.plain()).toContain("主 Agent（继续）\n_AFTER_MEMBER");
  expect(harness.plain()).toContain("输入仍发送给主 Agent");
  harness.input.write("/details\n");
  await vi.waitFor(() => expect(harness.plain()).toContain("MEMBER_PRIVATE_PROCESS"));
  expect(harness.plain()).toContain("成员 Checker [member-1]");
  expect(harness.agent.prompt).not.toHaveBeenCalled();
  harness.input.write("Follow the root task\n");
  await vi.waitFor(() => expect(harness.agent.prompt).toHaveBeenCalledWith("Follow the root task"));
  expect(harness.agent.sessions.open).not.toHaveBeenCalled();
  expect(harness.agent.collaboration.execute).not.toHaveBeenCalled();
});
