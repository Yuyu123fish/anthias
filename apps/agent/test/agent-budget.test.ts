import { glob, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentWithModelStream,
  type ModelStream,
  type ModelStreamEvent,
} from "../src/agent.js";
import { createSession, resolveSessionDirectory, resolveSessionShell } from "../src/session.js";

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

describe("Agent Run budgets", () => {
  it("never sends a thirteenth model request", async () => {
    const { agent, sessionDirectory } = await createBudgetTestAgent(async function* () {
      modelRequestCount += 1;
      yield toolCallEvent(modelRequestCount, "unknown_tool", {});
      yield finishEvent("tool_calls");
    });
    let modelRequestCount = 0;

    await expect(agent.prompt("loop")).resolves.toEqual({
      status: "budget_exhausted",
      budget: "model_requests",
    });

    expect(modelRequestCount).toBe(12);
    expect(agent.state.messageHistory.filter((message) => message.role === "tool")).toHaveLength(
      12,
    );
    expect(await finalSessionRecord(sessionDirectory)).toMatchObject({
      status: "budget_exhausted",
      budgetKind: "model_requests",
      modelRequestCount: 12,
      toolCallCount: 12,
      processedToolCallCount: 12,
    });
  });

  it("fails the thirty-third formed ToolCall without executing it", async () => {
    let modelRequestCount = 0;
    const { agent, sessionDirectory } = await createBudgetTestAgent(async function* () {
      modelRequestCount += 1;
      for (let index = 1; index <= 33; index += 1) {
        yield toolCallEvent(index, "unknown_tool", {});
      }
      yield finishEvent("tool_calls");
    });

    await expect(agent.prompt("many tools")).resolves.toEqual({
      status: "budget_exhausted",
      budget: "tool_calls",
    });

    expect(modelRequestCount).toBe(1);
    const toolResults = agent.state.messageHistory.filter((message) => message.role === "tool");
    expect(toolResults).toHaveLength(33);
    expect(toolResults.at(-1)).toMatchObject({
      status: "failed",
      content: "Run ToolCall 预算已耗尽，调用未执行。",
    });
    expect(await finalSessionRecord(sessionDirectory)).toMatchObject({
      status: "budget_exhausted",
      budgetKind: "tool_calls",
      modelRequestCount: 1,
      toolCallCount: 33,
      processedToolCallCount: 32,
    });
  });

  it("stops an active model request at thirty minutes", async () => {
    vi.useFakeTimers();
    const modelRequestStarted = Promise.withResolvers<void>();
    const { agent, sessionDirectory } = await createBudgetTestAgent(
      async function* (_modelRequest, abortSignal) {
        modelRequestStarted.resolve();
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    );

    const promptResultPromise = agent.prompt("wait forever");
    await modelRequestStarted.promise;
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

    await expect(promptResultPromise).resolves.toEqual({
      status: "budget_exhausted",
      budget: "active_duration",
    });
    expect(await finalSessionRecord(sessionDirectory)).toMatchObject({
      status: "budget_exhausted",
      budgetKind: "active_duration",
      activeDurationMilliseconds: 30 * 60 * 1000,
    });
  });

  it("does not count approval waiting against active duration", async () => {
    vi.useFakeTimers();
    const { workspaceRoot, sessionDirectory, shell } = await createTestSession();
    let modelRequestCount = 0;
    const modelStream: ModelStream = async function* () {
      modelRequestCount += 1;
      if (modelRequestCount === 1) {
        yield toolCallEvent(1, "execute_command", { command: "ignored because denied" });
        yield finishEvent("tool_calls");
        return;
      }
      yield { type: "text_delta", delta: "已接受拒绝。" } as const;
      yield finishEvent("stop");
    };
    const session = await createSession({ workspaceRoot, sessionDirectory, shell });
    const agent = createAgentWithModelStream({ modelStream, session });
    const approvalRequested = Promise.withResolvers<string>();
    agent.subscribe((event) => {
      if (event.type === "tool_approval_requested") {
        approvalRequested.resolve(event.request.toolApprovalRequestId);
      }
    });

    const promptResultPromise = agent.prompt("ask then wait");
    const approvalRequestId = await approvalRequested.promise;
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(agent.state.pendingToolApproval?.toolApprovalRequestId).toBe(approvalRequestId);
    expect(agent.respondToToolApproval(approvalRequestId, "deny")).toEqual({ status: "accepted" });

    await expect(promptResultPromise).resolves.toEqual({ status: "completed" });
    expect(await finalSessionRecord(sessionDirectory)).toMatchObject({
      status: "completed",
      activeDurationMilliseconds: 0,
    });
  });
});

/** 创建一个临时 Session 与使用给定模型流的 Agent。 */
async function createBudgetTestAgent(modelStream: ModelStream) {
  const { workspaceRoot, sessionDirectory, shell } = await createTestSession();
  const session = await createSession({ workspaceRoot, sessionDirectory, shell });
  return Object.freeze({
    agent: createAgentWithModelStream({ modelStream, session }),
    sessionDirectory,
  });
}

/** 创建只位于系统临时目录的 Session 路径与固定 Shell。 */
async function createTestSession() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-agent-budget-"));
  temporaryDirectories.add(workspaceRoot);
  const sessionDirectory = resolveSessionDirectory(workspaceRoot, {});
  const shell = await resolveSessionShell(process.env);
  return Object.freeze({
    workspaceRoot,
    sessionDirectory,
    shell,
  });
}

/** 读取指定 Session 目录中唯一 JSONL 文件的最终记录。 */
async function finalSessionRecord(sessionDirectory: string) {
  const sessionFiles: string[] = [];
  for await (const sessionFileName of glob("*.jsonl", { cwd: sessionDirectory })) {
    sessionFiles.push(sessionFileName);
  }
  const [sessionFileName] = sessionFiles;
  if (sessionFileName === undefined) {
    throw new Error("expected Session JSONL");
  }
  const lines = (await readFile(join(sessionDirectory, sessionFileName), "utf8"))
    .trimEnd()
    .split("\n");
  return JSON.parse(lines.at(-1) ?? "null") as Record<string, unknown>;
}

/** 创建一个稳定 UUID 的确定性 ToolCall 事件。 */
function toolCallEvent(index: number, toolName: string, input: unknown): ModelStreamEvent {
  return Object.freeze({
    type: "tool_call",
    toolCallId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    toolName,
    input,
    invalid: false,
  });
}

/** 创建一个没有 token 计量的确定性 finish 事件。 */
function finishEvent(finishReason: "stop" | "tool_calls"): ModelStreamEvent {
  return Object.freeze({
    type: "finish",
    finishReason,
    usage: Object.freeze({ inputTokens: null, outputTokens: null, totalTokens: null }),
  });
}
