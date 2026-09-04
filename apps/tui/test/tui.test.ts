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
    expect(rendered).toContain("You: previous\nAssistant: answer\n");
    expect(promptHandler).not.toHaveBeenCalled();
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

  it("renders Tool lifecycle only from Agent events", async () => {
    const agent = createFakeAgent({
      prompt: async (promptText, controls) => {
        controls.setRunning(true);
        publishPromptOpening(promptText, controls);
        controls.publish({
          type: "tool_execution_start",
          toolCallId: "00000000-0000-4000-8000-000000000010",
          toolName: "read_file",
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
          type: "message_end",
          message: result,
        });
        controls.publish({
          type: "tool_execution_end",
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          result,
          cleanupUncertain: false,
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
      expect(rendered).toContain("Tool: read_file");
      expect(rendered).toContain("ToolResult: read_file completed\npath: README.md\n");
    });
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
        preview: "--- old\n+++ new",
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
      const input = new PassThrough();
      const output = new PassThrough();
      const signalSource = new EventEmitter();
      let rendered = "";
      output.setEncoding("utf8");
      output.on("data", (chunk: string) => {
        rendered += chunk;
      });

      const tuiExit = runTui({ agent, input, output, signalSource });
      input.write("change\n");
      await vi.waitFor(() => expect(rendered).toContain("允许执行？[y/N]"));
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
      input.write("/exit\n");
      await expect(tuiExit).resolves.toBe(0);
    },
  );

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
      expect(rendered).toContain("Assistant: partial\n错误：");
      expect(agent.state.running).toBe(false);
    });

    input.write("/exit\n");
    await expect(tuiExit).resolves.toBe(0);
  });
});

function createFakeAgent(
  { prompt, respondToToolApproval, abort }: FakeAgentBehavior,
  messageHistory: readonly Message[] = [],
): Agent {
  const listeners = new Set<AgentListener>();
  let running = false;
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
        workspaceRoot: "C:\\workspace",
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
