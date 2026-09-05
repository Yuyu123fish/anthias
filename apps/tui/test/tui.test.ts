import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type {
  Agent,
  AgentEvent,
  AgentListener,
  AgentState,
  AssistantMessage,
  Message,
  PromptResult,
  ToolApprovalRequest,
  ToolApprovalResponse,
} from "@anthias/agent";
import { describe, expect, it, vi } from "vitest";
import { runTui } from "../src/index.js";
import { type TerminalDriver, terminalTextWidth } from "../src/terminal-driver.js";

const TEST_RUN_ID = "00000000-0000-4000-8000-000000000002";

type FakeAgentControls = Readonly<{
  publish(event: AgentEvent): void;
  setRunning(running: boolean): void;
  setPendingToolApproval(request: ToolApprovalRequest | null): void;
}>;

type FakeAgentBehavior = Readonly<{
  prompt(promptText: string, controls: FakeAgentControls): Promise<PromptResult>;
  respondToToolApproval?(
    toolApprovalRequestId: string,
    decision: "approve" | "deny",
    controls: FakeAgentControls,
  ): ToolApprovalResponse;
  abort?(controls: FakeAgentControls): void;
}>;

describe("runTui", () => {
  it("renders Session identity, workspace, and reopened message history", async () => {
    const promptHandler = vi.fn(async (): Promise<PromptResult> => ({ status: "completed" }));
    const agent = createFakeAgent({ prompt: promptHandler }, [
      { role: "user", content: "previous" },
      assistantMessage("", "completed"),
      assistantMessage("answer", "completed"),
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const signalSource = new EventEmitter();
    let rendered = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      rendered += chunk;
    });

    const tuiExit = runTui({ agent, input, output, signalSource });
    input.write("/exit\n");

    await expect(tuiExit).resolves.toBe(0);
    expect(rendered).toContain("Session: 00000000-0000-4000-8000-000000000001\n");
    expect(rendered).toContain("Workspace: C:\\workspace\n");
    expect(rendered).toContain("Mode: Agent\n");
    expect(rendered).toContain("><°> Anthias\n");
    expect(rendered).toContain("cwd: C:\\workspace\n");
    expect(rendered).toContain("Agent │ 等待输入 │ Session 00000000\n");
    expect(rendered).toContain("\nYou\n  previous\n");
    expect(rendered).toContain("\n><°> Anthias\nanswer\n");
    expect(rendered.match(/><°> Anthias/g)).toHaveLength(2);
    expect(promptHandler).not.toHaveBeenCalled();
  });

  it("renders reopened Assistant files and code through the content renderer", async () => {
    const promptHandler = vi.fn(async (): Promise<PromptResult> => ({ status: "completed" }));
    const agent = createFakeAgent(
      { prompt: promptHandler },
      [
        assistantMessage(
          "See `package.json:1`\n```ts\nconst anthias: string = 'fish';\n```",
          "completed",
        ),
      ],
      process.cwd(),
    );
    const input = new PassThrough();
    const output = new PassThrough();
    const signalSource = new EventEmitter();
    let rendered = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      rendered += chunk;
    });

    const tuiExit = runTui({
      agent,
      input,
      output,
      signalSource,
      terminalCapabilities: { colorDepth: "none", hyperlinks: false, unicode: true },
    });
    input.write("/exit\n");

    await expect(tuiExit).resolves.toBe(0);
    expect(rendered).toContain("See ▧ package.json:1");
    expect(rendered).toContain("╭─ ts\nconst anthias: string = 'fish';\n╰─\n");
    expect(promptHandler).not.toHaveBeenCalled();
  });

  it("keeps async syntax highlighting before Run completion and the next prompt", async () => {
    const agent = createFakeAgent(
      {
        prompt: (promptText, controls) =>
          completePrompt(promptText, ["```ts\nconst answer: number = 42;\n```"], controls),
      },
      [],
      process.cwd(),
    );
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: vi.fn((_enabled: boolean) => undefined),
    });
    const output = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 80,
      getColorDepth: () => 24,
    });
    const signalSource = new EventEmitter();
    let rendered = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      rendered += chunk;
    });

    const tuiExit = runTui({
      agent,
      input,
      output,
      signalSource,
      terminalCapabilities: { colorDepth: "truecolor", hyperlinks: false, unicode: true },
    });
    input.write("highlight\n");

    await vi.waitFor(() => expect(rendered).toContain("已完成。\n"));
    const codeEndIndex = rendered.indexOf("╰─\n");
    const runEndIndex = rendered.indexOf("已完成。\n");
    const nextPromptIndex = rendered.lastIndexOf("cwd:");
    expect(codeEndIndex).toBeGreaterThanOrEqual(0);
    expect(codeEndIndex).toBeLessThan(runEndIndex);
    expect(runEndIndex).toBeLessThan(nextPromptIndex);
    expect(rendered).toContain("\u001B[38;2;");

    input.write("/exit\n");
    await expect(tuiExit).resolves.toBe(0);
  });

  it("shows an unfinished Assistant line and reuses one heading across model continuations", async () => {
    const continueRun = Promise.withResolvers<void>();
    const agent = createFakeAgent({
      prompt: async (promptText, controls) => {
        controls.setRunning(true);
        publishPromptOpening(promptText, controls);
        controls.publish({
          type: "message_update",
          message: assistantMessage("first fragment", "streaming"),
          delta: "first fragment",
        });
        await continueRun.promise;
        controls.publish({
          type: "message_end",
          message: assistantMessage("first fragment", "completed"),
        });
        controls.publish({
          type: "message_start",
          message: assistantMessage("", "streaming"),
        });
        controls.publish({
          type: "message_end",
          message: assistantMessage("", "completed"),
        });
        controls.publish({
          type: "message_start",
          message: assistantMessage("", "streaming"),
        });
        controls.publish({
          type: "message_update",
          message: assistantMessage("second fragment", "streaming"),
          delta: "second fragment",
        });
        controls.publish({
          type: "message_end",
          message: assistantMessage("second fragment", "completed"),
        });
        controls.publish({
          type: "run_end",
          runId: TEST_RUN_ID,
          result: { status: "completed" },
        });
        controls.setRunning(false);
        return { status: "completed" };
      },
    });
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: vi.fn((_enabled: boolean) => undefined),
    });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 20 });
    const signalSource = new EventEmitter();
    const stableWrites: string[] = [];
    const dynamicFrames: Array<readonly string[]> = [];
    const terminalDriver: TerminalDriver = {
      kind: "interactive",
      width: () => 20,
      height: () => 24,
      writeStable: (text) => stableWrites.push(text),
      renderDynamic: (frame) => dynamicFrames.push(frame.lines),
      clearDynamic: vi.fn(),
      close: vi.fn(),
    };

    const tuiExit = runTui({
      agent,
      input,
      output,
      signalSource,
      terminalDriver,
      terminalCapabilities: { colorDepth: "none", hyperlinks: false, unicode: true },
    });
    input.write("stream\n");
    await vi.waitFor(() =>
      expect(dynamicFrames.some((frame) => frame.join("\n").includes("first fragment"))).toBe(true),
    );
    expect(dynamicFrames.flat().every((line) => terminalTextWidth(line) <= 19)).toBe(true);

    continueRun.resolve();
    await vi.waitFor(() => expect(stableWrites.join("")).toContain("second fragment\n"));
    expect(stableWrites.filter((text) => text === "\n><°> Anthias\n")).toHaveLength(1);

    input.write("/exit\n");
    await expect(tuiExit).resolves.toBe(0);
  });

  it("keeps requesting_model visible until the first Assistant text arrives", async () => {
    const publishFirstText = Promise.withResolvers<void>();
    const finishResponse = Promise.withResolvers<void>();
    const agent = createFakeAgent({
      prompt: async (promptText, controls) => {
        controls.setRunning(true);
        publishPromptOpening(promptText, controls);
        await publishFirstText.promise;
        controls.publish({
          type: "message_update",
          message: assistantMessage("first token", "streaming"),
          delta: "first token",
        });
        await finishResponse.promise;
        controls.publish({
          type: "message_end",
          message: assistantMessage("first token", "completed"),
        });
        controls.publish({
          type: "run_end",
          runId: TEST_RUN_ID,
          result: { status: "completed" },
        });
        controls.setRunning(false);
        return { status: "completed" };
      },
    });
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: vi.fn((_enabled: boolean) => undefined),
    });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 72 });
    const signalSource = new EventEmitter();
    const dynamicFrames: Array<readonly string[]> = [];
    const terminalDriver: TerminalDriver = {
      kind: "interactive",
      width: () => 72,
      height: () => 24,
      writeStable: vi.fn(),
      renderDynamic: (frame) => dynamicFrames.push(frame.lines),
      clearDynamic: vi.fn(),
      close: vi.fn(),
    };

    const tuiExit = runTui({
      agent,
      input,
      output,
      signalSource,
      terminalDriver,
      terminalCapabilities: { colorDepth: "none", hyperlinks: false, unicode: true },
    });
    input.write("wait\n");
    await vi.waitFor(() => {
      expect(dynamicFrames.some((frame) => frame.join("\n").includes("正在请求模型"))).toBe(true);
    });

    publishFirstText.resolve();
    await vi.waitFor(() => {
      const latestFrame = dynamicFrames.at(-1)?.join("\n") ?? "";
      expect(latestFrame).toContain("first token");
      expect(latestFrame).toContain("正在回答");
    });
    finishResponse.resolve();
    await vi.waitFor(() => expect(agent.state.running).toBe(false));
    input.write("/exit\n");
    await expect(tuiExit).resolves.toBe(0);
  });

  it("keeps non-TTY ASCII output deterministic and free of terminal controls", async () => {
    const agent = createFakeAgent({
      prompt: (promptText, controls) =>
        completePrompt(promptText, ["safe\u001B]8;;https://invalid.example\u0007answer"], controls),
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const signalSource = new EventEmitter();
    let rendered = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      rendered += chunk;
    });

    const tuiExit = runTui({
      agent,
      input,
      output,
      signalSource,
      terminalCapabilities: { colorDepth: "truecolor", hyperlinks: true, unicode: false },
    });
    input.write("plain\n");
    await vi.waitFor(() => expect(rendered).toContain("[ok] 已完成。\n"));
    input.write("/exit\n");
    await expect(tuiExit).resolves.toBe(0);

    expect(rendered).toContain("><o> Anthias\n");
    expect(rendered).toContain("[*] 正在请求模型\n");
    expect(rendered).toContain("Agent | 等待输入 | Session 00000000\n");
    expect(rendered).not.toContain("\u001B");
    expect(rendered).not.toContain("\u009B");
    expect(rendered).not.toContain("\u009D");
  });

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
      expect(rendered).toContain("\nYou\n  hello\n");
      expect(rendered).toContain("\n><°> Anthias\n你好\n");
      expect(rendered).toContain("已完成。\n");
      expect(agent.state.running).toBe(false);
    });

    input.write("again\n");
    await vi.waitFor(() => {
      expect(rendered).toContain("\nYou\n  again\n");
      expect(rendered).toContain("\n><°> Anthias\n再见\n");
      expect(promptHandler.mock.calls.map(([promptText]) => promptText)).toEqual([
        "hello",
        "again",
      ]);
    });

    await vi.waitFor(() => {
      expect(rendered.match(/cwd: C:\\workspace/g)).toHaveLength(3);
    });
    input.write("/exit\n");
    await expect(tuiExit).resolves.toBe(0);
    expect(signalSource.listenerCount("SIGINT")).toBe(0);
  });

  it("keeps the full workspace visible after rejecting empty input", async () => {
    const promptHandler = vi.fn(async (): Promise<PromptResult> => ({ status: "completed" }));
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
    input.write("\n");
    await vi.waitFor(() => {
      expect(rendered).toContain("请输入非空提示词。\n");
      expect(rendered.match(/cwd: C:\\workspace/g)).toHaveLength(2);
    });
    expect(promptHandler).not.toHaveBeenCalled();
    input.write("/exit\n");
    await expect(tuiExit).resolves.toBe(0);
  });

  it("renders Tool lifecycle only from Agent events", async () => {
    const agent = createFakeAgent({
      prompt: async (promptText, controls) => {
        controls.setRunning(true);
        publishPromptOpening(promptText, controls);
        controls.publish({ type: "reasoning_start", runId: TEST_RUN_ID });
        controls.publish({
          type: "reasoning_update",
          runId: TEST_RUN_ID,
          delta: "inspect",
        });
        controls.publish({ type: "reasoning_end", runId: TEST_RUN_ID });
        controls.publish({
          type: "run_phase_changed",
          runId: TEST_RUN_ID,
          phase: "executing_tool",
        });
        controls.publish({
          type: "tool_execution_start",
          activity: {
            toolCallId: "00000000-0000-4000-8000-000000000010",
            toolName: "read_file",
            summary: "path: README.md",
          },
        });
        controls.publish({
          type: "tool_execution_update",
          toolCallId: "00000000-0000-4000-8000-000000000010",
          toolName: "read_file",
          stream: "stdout",
          delta: "chunk",
        });
        const result = {
          role: "tool" as const,
          toolCallId: "00000000-0000-4000-8000-000000000010",
          toolName: "read_file",
          status: "completed" as const,
          content: "path: README.md",
          truncated: false,
        };
        controls.publish({
          type: "tool_execution_end",
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          result,
          cleanupUncertain: false,
        });
        controls.publish({
          type: "message_end",
          message: result,
        });
        controls.publish({
          type: "message_end",
          message: assistantMessage("done", "completed"),
        });
        controls.publish({
          type: "run_end",
          runId: TEST_RUN_ID,
          result: { status: "completed" },
        });
        controls.setRunning(false);
        return { status: "completed" };
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
    input.write("inspect\n");
    await vi.waitFor(() => {
      expect(rendered).toContain("思考中：inspect\n");
      expect(rendered).toContain("状态：正在运行 Tool\n");
      expect(rendered).toContain("◌ [00000010] read_file  path: README.md");
      expect(rendered).toContain("✓ [00000010] read_file  path: README.md");
      expect(rendered).not.toContain("[stdout] chunk");
    });
    input.write("/details\n");
    await vi.waitFor(() => {
      expect(rendered).toContain("Details: on\n");
      expect(rendered).toContain("详情 · [00000010] read_file · 完成");
      expect(rendered).toContain("[stdout] chunk");
      expect(rendered).toContain("[result] path: README.md");
    });
    input.write("/exit\n");
    await expect(tuiExit).resolves.toBe(0);
  });

  it("measures Reasoning duration when events arrive instead of when rendering catches up", async () => {
    let monotonicTime = 0;
    const agent = createFakeAgent({
      prompt: async (_promptText, controls) => {
        controls.setRunning(true);
        controls.publish({ type: "run_start", runId: TEST_RUN_ID });
        monotonicTime = 100;
        controls.publish({ type: "reasoning_start", runId: TEST_RUN_ID });
        monotonicTime = 1_100;
        controls.publish({ type: "reasoning_update", runId: TEST_RUN_ID, delta: "timed" });
        monotonicTime = 1_600;
        controls.publish({ type: "reasoning_end", runId: TEST_RUN_ID });
        monotonicTime = 1_700;
        controls.publish({
          type: "run_end",
          runId: TEST_RUN_ID,
          result: { status: "completed" },
        });
        controls.setRunning(false);
        return { status: "completed" };
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

    const tuiExit = runTui({
      agent,
      input,
      output,
      signalSource,
      now: () => monotonicTime,
    });
    input.write("time\n");
    await vi.waitFor(() => expect(rendered).toContain("思考了 1.5 s"));
    input.write("/exit\n");
    await expect(tuiExit).resolves.toBe(0);
  });

  it("keeps publishing Reasoning details after details are enabled during a Run", async () => {
    const continueReasoning = Promise.withResolvers<void>();
    const agent = createFakeAgent({
      prompt: async (promptText, controls) => {
        controls.setRunning(true);
        publishPromptOpening(promptText, controls);
        controls.publish({ type: "reasoning_start", runId: TEST_RUN_ID });
        controls.publish({
          type: "reasoning_update",
          runId: TEST_RUN_ID,
          delta: "first thought",
        });
        await continueReasoning.promise;
        controls.publish({
          type: "reasoning_update",
          runId: TEST_RUN_ID,
          delta: "second thought",
        });
        controls.publish({ type: "reasoning_end", runId: TEST_RUN_ID });
        controls.publish({
          type: "message_end",
          message: assistantMessage("done", "completed"),
        });
        controls.publish({
          type: "run_end",
          runId: TEST_RUN_ID,
          result: { status: "completed" },
        });
        controls.setRunning(false);
        return { status: "completed" };
      },
    });
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: vi.fn((_enabled: boolean) => undefined),
    });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 72 });
    const signalSource = new EventEmitter();
    const stableWrites: string[] = [];
    const dynamicFrames: Array<readonly string[]> = [];
    const terminalDriver: TerminalDriver = {
      kind: "interactive",
      width: () => 72,
      height: () => 12,
      writeStable: (text) => stableWrites.push(text),
      renderDynamic: (frame) => dynamicFrames.push(frame.lines),
      clearDynamic: vi.fn(),
      close: vi.fn(),
    };

    const tuiExit = runTui({
      agent,
      input,
      output,
      signalSource,
      terminalDriver,
      terminalCapabilities: { colorDepth: "none", hyperlinks: false, unicode: true },
    });
    input.write("reason\n");
    await vi.waitFor(() => expect(agent.state.running).toBe(true));
    input.write("/details\n");
    await vi.waitFor(() => {
      expect(dynamicFrames.at(-1)?.join("\n")).toContain("first thought");
    });
    expect(dynamicFrames.at(-1)?.length).toBeLessThanOrEqual(11);
    expect(stableWrites.join("")).not.toContain("first thought");

    continueReasoning.resolve();
    await vi.waitFor(() => {
      expect(dynamicFrames.at(-1)?.join("\n")).toContain("second thought");
    });
    input.write("/details\n");
    await vi.waitFor(() => {
      expect(stableWrites.join("")).toContain("Details: off");
      expect(dynamicFrames.at(-1)?.join("\n")).not.toContain("first thought");
    });
    input.write("/exit\n");
    await expect(tuiExit).resolves.toBe(0);
  });

  it("paginates retained details without exceeding the terminal height", async () => {
    const reasoningLines = Array.from(
      { length: 30 },
      (_, index) => `reasoning-line-${String(index + 1).padStart(2, "0")}`,
    ).join("\n");
    const agent = createFakeAgent({
      prompt: async (promptText, controls) => {
        controls.setRunning(true);
        publishPromptOpening(promptText, controls);
        controls.publish({ type: "reasoning_start", runId: TEST_RUN_ID });
        controls.publish({ type: "reasoning_update", runId: TEST_RUN_ID, delta: reasoningLines });
        controls.publish({ type: "reasoning_end", runId: TEST_RUN_ID });
        controls.publish({
          type: "message_end",
          message: assistantMessage("done", "completed"),
        });
        controls.publish({
          type: "run_end",
          runId: TEST_RUN_ID,
          result: { status: "completed" },
        });
        controls.setRunning(false);
        return { status: "completed" };
      },
    });
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: vi.fn((_enabled: boolean) => undefined),
    });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 72, rows: 12 });
    const signalSource = new EventEmitter();
    const dynamicFrames: Array<readonly string[]> = [];
    const terminalDriver: TerminalDriver = {
      kind: "interactive",
      width: () => 72,
      height: () => 12,
      writeStable: vi.fn(),
      renderDynamic: (frame) => dynamicFrames.push(frame.lines),
      clearDynamic: vi.fn(),
      close: vi.fn(),
    };

    const tuiExit = runTui({
      agent,
      input,
      output,
      signalSource,
      terminalDriver,
      terminalCapabilities: { colorDepth: "none", hyperlinks: false, unicode: true },
    });
    input.write("many details\n");
    await vi.waitFor(() => expect(agent.state.running).toBe(false));
    input.write("/details\n");
    await vi.waitFor(() => expect(dynamicFrames.at(-1)?.join("\n")).toContain("详情 6/6"));
    expect(dynamicFrames.at(-1)?.length).toBeLessThanOrEqual(11);
    expect(dynamicFrames.at(-1)?.join("\n")).toContain("reasoning-line-30");

    input.write("/details prev\n");
    await vi.waitFor(() => expect(dynamicFrames.at(-1)?.join("\n")).toContain("详情 5/6"));
    expect(dynamicFrames.at(-1)?.length).toBeLessThanOrEqual(11);
    expect(dynamicFrames.at(-1)?.join("\n")).toContain("reasoning-line-24");

    input.write("/details\n");
    await vi.waitFor(() => expect(dynamicFrames.at(-1)?.join("\n")).not.toContain("详情 "));
    input.write("/exit\n");
    await expect(tuiExit).resolves.toBe(0);
  });

  it("retains a Tool result without a preceding execution event for later details", async () => {
    const deniedResult = {
      role: "tool" as const,
      toolCallId: "00000000-0000-4000-8000-000000000013",
      toolName: "edit_file" as const,
      status: "denied" as const,
      content: "permission denied by user",
      truncated: false,
    };
    const agent = createFakeAgent({
      prompt: async (promptText, controls) => {
        controls.setRunning(true);
        publishPromptOpening(promptText, controls);
        controls.publish({ type: "message_end", message: deniedResult });
        controls.publish({
          type: "run_end",
          runId: TEST_RUN_ID,
          result: { status: "completed" },
        });
        controls.setRunning(false);
        return { status: "completed" };
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
    input.write("deny\n");
    await vi.waitFor(() => expect(rendered).toContain("⊘ [00000013] edit_file  已拒绝"));
    input.write("/details\n");
    await vi.waitFor(() => {
      expect(rendered).toContain("详情 · [00000013] edit_file · 已拒绝");
      expect(rendered).toContain("[result] permission denied by user");
    });
    input.write("/exit\n");
    await expect(tuiExit).resolves.toBe(0);
  });

  it("keeps concurrent Tool updates and out-of-order completions with their toolCallId", async () => {
    const readToolCallId = "00000000-0000-4000-8000-000000000011";
    const grepToolCallId = "00000000-0000-4000-8000-000000000012";
    const readResult = {
      role: "tool" as const,
      toolCallId: readToolCallId,
      toolName: "read_file" as const,
      status: "completed" as const,
      content: "read-result",
      truncated: false,
    };
    const grepResult = {
      role: "tool" as const,
      toolCallId: grepToolCallId,
      toolName: "grep" as const,
      status: "completed" as const,
      content: "grep-result",
      truncated: false,
    };
    const agent = createFakeAgent({
      prompt: async (promptText, controls) => {
        controls.setRunning(true);
        publishPromptOpening(promptText, controls);
        controls.publish({
          type: "run_phase_changed",
          runId: TEST_RUN_ID,
          phase: "executing_tool",
        });
        controls.publish({
          type: "tool_execution_start",
          activity: {
            toolCallId: readToolCallId,
            toolName: "read_file",
            summary: "path: README.md",
          },
        });
        controls.publish({
          type: "tool_execution_start",
          activity: {
            toolCallId: grepToolCallId,
            toolName: "grep",
            summary: "query: Anthias in src",
          },
        });
        controls.publish({
          type: "tool_execution_update",
          toolCallId: readToolCallId,
          toolName: "read_file",
          stream: "stdout",
          delta: "read-output",
        });
        controls.publish({
          type: "tool_execution_update",
          toolCallId: grepToolCallId,
          toolName: "grep",
          stream: "stdout",
          delta: "grep-output",
        });
        controls.publish({
          type: "tool_execution_end",
          toolCallId: grepToolCallId,
          toolName: "grep",
          result: grepResult,
          cleanupUncertain: false,
        });
        controls.publish({
          type: "tool_execution_end",
          toolCallId: readToolCallId,
          toolName: "read_file",
          result: readResult,
          cleanupUncertain: false,
        });
        controls.publish({ type: "message_end", message: readResult });
        controls.publish({ type: "message_end", message: grepResult });
        controls.publish({
          type: "message_end",
          message: assistantMessage("done", "completed"),
        });
        controls.publish({
          type: "run_end",
          runId: TEST_RUN_ID,
          result: { status: "completed" },
        });
        controls.setRunning(false);
        return { status: "completed" };
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
    input.write("parallel\n");
    await vi.waitFor(() => expect(rendered).toContain("✓ [00000011] read_file  path: README.md"));

    const grepCompletionIndex = rendered.indexOf("✓ [00000012] grep  query: Anthias in src");
    const readCompletionIndex = rendered.indexOf("✓ [00000011] read_file  path: README.md");
    expect(grepCompletionIndex).toBeGreaterThanOrEqual(0);
    expect(grepCompletionIndex).toBeLessThan(readCompletionIndex);

    input.write("/details\n");
    await vi.waitFor(() => expect(rendered).toContain("详情 · [00000012] grep · 完成"));
    const readDetailsStart = rendered.lastIndexOf("详情 · [00000011] read_file · 完成");
    const grepDetailsStart = rendered.lastIndexOf("详情 · [00000012] grep · 完成");
    expect(readDetailsStart).toBeGreaterThanOrEqual(0);
    expect(readDetailsStart).toBeLessThan(grepDetailsStart);
    const readDetails = rendered.slice(readDetailsStart, grepDetailsStart);
    const grepDetails = rendered.slice(grepDetailsStart);
    expect(readDetails).toContain("[stdout] read-output");
    expect(readDetails).toContain("[result] read-result");
    expect(readDetails).not.toContain("grep-output");
    expect(grepDetails).toContain("[stdout] grep-output");
    expect(grepDetails).toContain("[result] grep-result");
    expect(grepDetails).not.toContain("read-output");

    input.write("/exit\n");
    await expect(tuiExit).resolves.toBe(0);
  });

  it.each([
    {
      inputDecision: "y",
      expectedDecision: "approve" as const,
      renderedDecision: "已批准本次调用。",
    },
    { inputDecision: "", expectedDecision: "deny" as const, renderedDecision: "已拒绝本次调用。" },
  ])(
    "maps '$inputDecision' to the current Tool approval",
    async ({ inputDecision, expectedDecision, renderedDecision }) => {
      const promptCompletion = Promise.withResolvers<PromptResult>();
      const approvalRequest = Object.freeze({
        toolApprovalRequestId: "00000000-0000-4000-8000-000000000030",
        toolCallId: "00000000-0000-4000-8000-000000000031",
        toolName: "edit_file" as const,
        target: "src/example.ts",
        preview: Array.from(
          { length: 30 },
          (_, index) => `preview-line-${String(index + 1).padStart(2, "0")}`,
        ).join("\n"),
        permissionMode: "agent" as const,
        riskSummary: "将修改工作区文件。",
        executionBoundary: "一次只写入一个精确文件。",
      });
      const approvalHandler = vi.fn(
        (
          toolApprovalRequestId: string,
          decision: "approve" | "deny",
          controls: FakeAgentControls,
        ): ToolApprovalResponse => {
          if (toolApprovalRequestId !== approvalRequest.toolApprovalRequestId) {
            return { status: "rejected", reason: "request_mismatch" };
          }
          controls.setPendingToolApproval(null);
          controls.publish({
            type: "tool_approval_resolved",
            request: approvalRequest,
            decision,
          });
          controls.publish({
            type: "run_end",
            runId: TEST_RUN_ID,
            result: { status: "completed" },
          });
          controls.setRunning(false);
          promptCompletion.resolve({ status: "completed" });
          return { status: "accepted" };
        },
      );
      const agent = createFakeAgent({
        prompt: async (promptText, controls) => {
          controls.setRunning(true);
          publishPromptOpening(promptText, controls);
          controls.setPendingToolApproval(approvalRequest);
          controls.publish({ type: "tool_approval_requested", request: approvalRequest });
          return promptCompletion.promise;
        },
        respondToToolApproval: approvalHandler,
      });
      const input = Object.assign(new PassThrough(), {
        isTTY: true,
        setRawMode: vi.fn((_enabled: boolean) => undefined),
      });
      const output = Object.assign(new PassThrough(), { isTTY: true, columns: 72 });
      const signalSource = new EventEmitter();
      let rendered = "";
      output.setEncoding("utf8");
      output.on("data", (chunk: string) => {
        rendered += chunk;
      });

      const tuiExit = runTui({
        agent,
        input,
        output,
        signalSource,
        terminalCapabilities: { colorDepth: "none", hyperlinks: false, unicode: true },
      });
      input.write("change\n");
      await vi.waitFor(() => expect(rendered).toContain("需要确认"));
      expect(rendered).toContain("权限模式: Agent");
      expect(rendered).toContain("风险: 将修改工作区文件。");
      expect(rendered).toContain("边界: 一次只写入一个精确文件。");
      expect(rendered).toContain("[y] 允许一次    [n] 拒绝");
      expect(rendered).toContain("preview-line-01");
      expect(rendered).toContain("preview-line-30");
      input.write("/mode plan\n");
      await vi.waitFor(() => expect(rendered).toContain("不能切换权限模式"));
      expect(approvalHandler).not.toHaveBeenCalled();
      input.write("maybe\n");
      await vi.waitFor(() => expect(rendered).toContain("请输入 y/yes 批准"));
      expect(approvalHandler).not.toHaveBeenCalled();
      input.write(`${inputDecision}\n`);
      await vi.waitFor(() => expect(rendered).toContain(renderedDecision));

      expect(approvalHandler).toHaveBeenCalledWith(
        approvalRequest.toolApprovalRequestId,
        expectedDecision,
        expect.anything(),
      );
      const resolvedCardStart = rendered.lastIndexOf("╭─ 确认结果");
      const resolvedCard = rendered.slice(resolvedCardStart);
      expect(resolvedCardStart).toBeGreaterThanOrEqual(0);
      expect(resolvedCard).toContain("调用: [00000031]");
      expect(resolvedCard).toContain("目标: src/example.ts");
      expect(resolvedCard).toContain("风险: 将修改工作区文件。");
      expect(resolvedCard).toContain("边界: 一次只写入一个精确文件。");
      expect(resolvedCard).toContain("preview-line-01");
      expect(resolvedCard).toContain("preview-line-30");
      expect(resolvedCard).toContain(renderedDecision);
      input.write("/exit\n");
      await expect(tuiExit).resolves.toBe(0);
    },
  );

  it("queries and changes mode without submitting a prompt", async () => {
    const promptHandler = vi.fn(async (): Promise<PromptResult> => ({ status: "completed" }));
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
    input.write("/mode\n");
    input.write("/mode plan\n");

    await vi.waitFor(() => {
      expect(agent.state.permissionMode).toBe("plan");
      expect(rendered).toContain("模式：Plan\n");
    });
    expect(promptHandler).not.toHaveBeenCalled();

    input.write("/mode invalid\n");
    await vi.waitFor(() => expect(rendered).toContain("用法：/mode"));
    input.write("/exit\n");
    await expect(tuiExit).resolves.toBe(0);
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
        message: assistantMessage("partial", "aborted"),
      });
      controls.publish({
        type: "run_end",
        runId: TEST_RUN_ID,
        result: { status: "aborted" },
      });
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
    await vi.waitFor(() => {
      expect(agent.state.running).toBe(true);
      expect(rendered.match(/><°> Anthias/g)?.length).toBeGreaterThanOrEqual(2);
    });

    signalSource.emit("SIGINT");
    await vi.waitFor(() => {
      expect(abortHandler).toHaveBeenCalledOnce();
      expect(rendered).toContain("partial\n");
      expect(rendered).toContain("■ 已停止当前响应，可以继续输入。\n");
      expect(agent.state.running).toBe(false);
    });

    input.write("continue\n");
    await vi.waitFor(() => {
      expect(rendered).toContain("\nYou\n  continue\n");
      expect(rendered).toContain("\n><°> Anthias\nrecovered\n");
    });

    signalSource.emit("SIGINT");
    await expect(tuiExit).resolves.toBe(0);
    expect(signalSource.listenerCount("SIGINT")).toBe(0);
  });

  it("preserves input through interactive resize and cleans terminal resources", async () => {
    const promptHandler = vi.fn(
      async (promptText: string, controls: FakeAgentControls): Promise<PromptResult> => {
        controls.setRunning(true);
        publishPromptOpening(promptText, controls);
        controls.publish({ type: "reasoning_start", runId: TEST_RUN_ID });
        controls.publish({
          type: "reasoning_update",
          runId: TEST_RUN_ID,
          delta: "line1\nline2\nline3\nline4\nline5",
        });
        controls.publish({ type: "reasoning_end", runId: TEST_RUN_ID });
        controls.publish({
          type: "message_update",
          message: assistantMessage("resized", "streaming"),
          delta: "resized",
        });
        controls.publish({
          type: "message_end",
          message: assistantMessage("resized", "completed"),
        });
        controls.publish({
          type: "run_end",
          runId: TEST_RUN_ID,
          result: { status: "completed" },
        });
        controls.setRunning(false);
        return { status: "completed" };
      },
    );
    const setRawMode = vi.fn((_enabled: boolean) => undefined);
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode });
    const output = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 76,
      rows: 24,
      getColorDepth: () => 24,
    });
    const signalSource = new EventEmitter();
    const agent = createFakeAgent(
      { prompt: promptHandler },
      [],
      "C:\\projects\\anthias-demo-with-a-long-workspace-name",
    );
    let rendered = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      rendered += chunk;
    });

    const tuiExit = runTui({
      agent,
      input,
      output,
      signalSource,
      terminalCapabilities: { colorDepth: "truecolor", hyperlinks: true, unicode: true },
    });
    await vi.waitFor(() => expect(rendered).toContain("cwd: C:\\projects\\anthias-demo"));
    input.write("draft");
    const renderedLengthBeforeCompactResize = rendered.length;
    output.columns = 10;
    output.rows = 8;
    output.emit("resize");
    await vi.waitFor(() =>
      expect(rendered.slice(renderedLengthBeforeCompactResize)).toContain("已暂停提交与确认"),
    );
    const compactOutput = rendered.slice(renderedLengthBeforeCompactResize);
    expect(compactOutput).toContain("cwd: C:\\projects\\anthias-demo-with-a-long-workspace-name");
    expect(compactOutput).toContain("Agent │ 等待输入 │ Session 00000000");
    input.write("\n");
    await vi.waitFor(() => expect(rendered).toContain("请放大窗口后重试"));
    expect(promptHandler).not.toHaveBeenCalled();

    output.columns = 76;
    output.rows = 24;
    output.emit("resize");
    input.write("draft\n");
    await vi.waitFor(() => expect(promptHandler).toHaveBeenCalledWith("draft", expect.anything()));
    await vi.waitFor(() => {
      expect(rendered).toContain("▸ 思考了");
      expect(rendered).toContain("resized");
    });
    input.write("/details\n");
    await vi.waitFor(() => {
      expect(rendered).toContain("详情 · Reasoning");
      expect(rendered).toContain("line1\nline2\nline3\nline4\nline5");
    });
    input.write("/exit\n");

    await expect(tuiExit).resolves.toBe(0);
    expect(rendered.match(/Session: 00000000-0000-4000-8000-000000000001/g)).toHaveLength(1);
    expect(rendered.match(/You/g)).toHaveLength(1);
    expect(rendered).toContain("\u001B[2K");
    expect(rendered).toContain("\u001B[?25h");
    expect(setRawMode).toHaveBeenCalledWith(true);
    expect(setRawMode).toHaveBeenCalledWith(false);
    expect(output.listenerCount("resize")).toBe(0);
    expect(signalSource.listenerCount("SIGINT")).toBe(0);
  });

  it("restores terminal resources and exits non-zero after an interactive render failure", async () => {
    const agent = createFakeAgent({
      prompt: async (): Promise<PromptResult> => ({ status: "completed" }),
    });
    const setRawMode = vi.fn((_enabled: boolean) => undefined);
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 72 });
    const signalSource = new EventEmitter();
    const stableWrites: string[] = [];
    const close = vi.fn();
    const terminalDriver: TerminalDriver = {
      kind: "interactive",
      width: () => 72,
      height: () => 24,
      writeStable: (text) => stableWrites.push(text),
      renderDynamic: () => {
        throw new Error("render failed");
      },
      clearDynamic: vi.fn(),
      close,
    };

    const tuiExit = runTui({
      agent,
      input,
      output,
      signalSource,
      terminalDriver,
      terminalCapabilities: { colorDepth: "none", hyperlinks: false, unicode: true },
    });

    await expect(tuiExit).resolves.toBe(1);
    expect(stableWrites.join("")).toContain("内容呈现失败，TUI 即将安全退出。");
    expect(close).toHaveBeenCalledOnce();
    expect(setRawMode).toHaveBeenCalledWith(true);
    expect(setRawMode).toHaveBeenCalledWith(false);
    expect(output.listenerCount("resize")).toBe(0);
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
          message: assistantMessage("partial", "failed"),
        });
        controls.publish({
          type: "run_end",
          runId: TEST_RUN_ID,
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
      expect(rendered).toContain("\n><°> Anthias\npartial\n");
      expect(rendered).toContain("✕ 运行失败：");
      expect(rendered).toContain("可修改输入后重试。\n");
      expect(agent.state.running).toBe(false);
    });

    input.write("/exit\n");
    await expect(tuiExit).resolves.toBe(0);
  });
});

function createFakeAgent(
  { prompt, respondToToolApproval, abort }: FakeAgentBehavior,
  messageHistory: readonly Message[] = [],
  workspaceRoot = "C:\\workspace",
): Agent {
  const listeners = new Set<AgentListener>();
  let running = false;
  let permissionMode: "agent" | "plan" = "agent";
  let pendingToolApproval: ToolApprovalRequest | null = null;
  const controls: FakeAgentControls = {
    publish(event) {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
    setRunning(nextRunning) {
      running = nextRunning;
    },
    setPendingToolApproval(request) {
      pendingToolApproval = request;
    },
  };

  return Object.freeze({
    get state(): AgentState {
      return Object.freeze({
        sessionId: "00000000-0000-4000-8000-000000000001",
        workspaceRoot,
        permissionMode,
        messageHistory: Object.freeze([...messageHistory]),
        activeAssistantMessage: null,
        activeRun: running
          ? Object.freeze({
              runId: "00000000-0000-4000-8000-000000000002",
              phase:
                pendingToolApproval === null
                  ? ("requesting_model" as const)
                  : ("awaiting_tool_approval" as const),
            })
          : null,
        pendingToolApproval,
        running,
        lastError: null,
      });
    },
    prompt: (promptText) => prompt(promptText, controls),
    setPermissionMode(nextPermissionMode) {
      if (running) {
        return Object.freeze({ status: "rejected", reason: "busy" });
      }
      if (permissionMode !== nextPermissionMode) {
        permissionMode = nextPermissionMode;
        controls.publish({ type: "permission_mode_changed", permissionMode });
      }
      return Object.freeze({ status: "accepted", permissionMode });
    },
    respondToToolApproval: (toolApprovalRequestId, decision) =>
      respondToToolApproval?.(toolApprovalRequestId, decision, controls) ??
      Object.freeze({ status: "rejected", reason: "not_pending" }),
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
      message: assistantMessage(content, "streaming"),
      delta: chunk,
    });
  }

  controls.publish({
    type: "message_end",
    message: assistantMessage(content, "completed"),
  });
  controls.publish({
    type: "run_end",
    runId: TEST_RUN_ID,
    result: { status: "completed" },
  });
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
    message: assistantMessage(assistantContent, "streaming"),
    delta: assistantContent,
  });
}

function publishPromptOpening(promptText: string, controls: FakeAgentControls): void {
  controls.publish({ type: "run_start", runId: TEST_RUN_ID });
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
    message: assistantMessage("", "streaming"),
  });
}

/** 创建与公开结构化消息合同一致的 Assistant 测试消息。 */
function assistantMessage(content: string, status: AssistantMessage["status"]): AssistantMessage {
  return Object.freeze({
    role: "assistant",
    content: Object.freeze(content.length === 0 ? [] : [{ type: "text" as const, text: content }]),
    status,
  });
}
