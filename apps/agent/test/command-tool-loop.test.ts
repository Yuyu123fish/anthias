import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AgentEvent,
  createAgentWithModelStream,
  type ModelRequest,
  type ModelStream,
} from "../src/agent.js";
import { createSession, resolveSessionDirectory, resolveSessionShell } from "../src/session.js";

const temporaryDirectories = new Set<string>();
const originalApiKey = process.env.ANTHIAS_MODEL_API_KEY;

afterEach(async () => {
  if (originalApiKey === undefined) {
    delete process.env.ANTHIAS_MODEL_API_KEY;
  } else {
    process.env.ANTHIAS_MODEL_API_KEY = originalApiKey;
  }
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

describe("execute_command Agent Tool Loop", () => {
  it("waits for approval, removes the model API key, and persists execution order", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-command-tool-"));
    temporaryDirectories.add(workspaceRoot);
    process.env.ANTHIAS_MODEL_API_KEY = "fake-command-secret";
    const sessionDirectory = resolveSessionDirectory(workspaceRoot, {});
    const shell = await resolveSessionShell(process.env);
    const session = await createSession({ workspaceRoot, sessionDirectory, shell });
    const modelRequests: ModelRequest[] = [];
    const command =
      shell.kind === "powershell"
        ? "$present=[bool]$env:ANTHIAS_MODEL_API_KEY; Set-Content -LiteralPath 'command-ran.txt' -Value 'ran'; Write-Output \"key=$present\"; [Console]::Error.WriteLine('stderr')"
        : `present=\${ANTHIAS_MODEL_API_KEY:+true}; printf 'ran\\n' > command-ran.txt; printf 'key=%s\\n' "\${present:-false}"; printf 'stderr\\n' >&2`;
    const modelStream: ModelStream = async function* (modelRequest) {
      modelRequests.push(modelRequest);
      if (modelRequests.length === 1) {
        yield {
          type: "tool_call",
          toolCallId: "00000000-0000-4000-8000-000000000021",
          toolName: "execute_command",
          input: { command, timeoutMs: 10_000 },
          invalid: false,
        } as const;
        yield finishEvent("tool_calls");
        return;
      }
      yield { type: "text_delta", delta: "命令验证完成。" } as const;
      yield finishEvent("stop");
    };
    const agent = createAgentWithModelStream({ modelStream, session });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => events.push(event));

    const promptResultPromise = agent.prompt("执行验证命令");
    await vi.waitFor(() => expect(agent.state.pendingToolApproval).not.toBeNull());
    const approvalRequest = agent.state.pendingToolApproval;
    if (approvalRequest === null) {
      throw new Error("expected pending approval");
    }
    await expect(access(join(workspaceRoot, "command-ran.txt"))).rejects.toThrow();
    expect(approvalRequest.preview).toContain("operation: execute command");
    expect(approvalRequest.preview).toContain("timeoutMs: 10000");

    expect(agent.respondToToolApproval(approvalRequest.toolApprovalRequestId, "approve")).toEqual({
      status: "accepted",
    });
    await expect(promptResultPromise).resolves.toEqual({ status: "completed" });

    expect(await readFile(join(workspaceRoot, "command-ran.txt"), "utf8")).toContain("ran");
    const serializedEvidence = JSON.stringify({ events, state: agent.state });
    expect(serializedEvidence).not.toContain("fake-command-secret");
    expect(serializedEvidence).toMatch(/key=(False|false)/u);
    expect(serializedEvidence).toContain("stderr");
    expect(modelRequests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      toolName: "execute_command",
      status: "completed",
    });
    expect(agent.respondToToolApproval(approvalRequest.toolApprovalRequestId, "approve")).toEqual({
      status: "rejected",
      reason: "not_pending",
    });

    const sessionRecords = (
      await readFile(join(sessionDirectory, `${session.sessionId}.jsonl`), "utf8")
    )
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(sessionRecords.map((record) => record.type)).toEqual([
      "session_header",
      "message",
      "message",
      "tool_execution_started",
      "message",
      "message",
      "run_finished",
    ]);
  });

  it("returns bounded failures for non-zero exit and timeout, then lets the model continue", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-command-failures-"));
    temporaryDirectories.add(workspaceRoot);
    const sessionDirectory = resolveSessionDirectory(workspaceRoot, {});
    const shell = await resolveSessionShell(process.env);
    const session = await createSession({ workspaceRoot, sessionDirectory, shell });
    const commands =
      shell.kind === "powershell"
        ? [
            "Write-Output 'out'; [Console]::Error.WriteLine('err'); exit 7",
            "Start-Sleep -Seconds 30",
          ]
        : ["printf 'out\\n'; printf 'err\\n' >&2; exit 7", "sleep 30"];
    let modelRequestCount = 0;
    const modelStream: ModelStream = async function* () {
      modelRequestCount += 1;
      if (modelRequestCount <= commands.length) {
        yield {
          type: "tool_call",
          toolCallId: `00000000-0000-4000-8000-${modelRequestCount.toString().padStart(12, "0")}`,
          toolName: "execute_command",
          input: {
            command: commands[modelRequestCount - 1],
            timeoutMs: modelRequestCount === 1 ? 10_000 : 1_000,
          },
          invalid: false,
        } as const;
        yield finishEvent("tool_calls");
        return;
      }
      yield { type: "text_delta", delta: "已记录命令失败。" } as const;
      yield finishEvent("stop");
    };
    const agent = createAgentWithModelStream({ modelStream, session });
    const executionEndEvents: Extract<AgentEvent, { type: "tool_execution_end" }>[] = [];
    agent.subscribe((event) => {
      if (event.type === "tool_approval_requested") {
        agent.respondToToolApproval(event.request.toolApprovalRequestId, "approve");
      }
      if (event.type === "tool_execution_end") {
        executionEndEvents.push(event);
      }
    });

    await expect(agent.prompt("检查失败命令")).resolves.toEqual({ status: "completed" });

    const toolResults = agent.state.messageHistory.filter((message) => message.role === "tool");
    expect(toolResults).toHaveLength(2);
    expect(toolResults[0]).toMatchObject({ status: "failed" });
    expect(toolResults[0]?.content).toContain("termination: non_zero_exit");
    expect(toolResults[0]?.content).toContain("exitCode: 7");
    expect(toolResults[0]?.content).toContain("[stdout]");
    expect(toolResults[0]?.content).toContain("[stderr]");
    expect(toolResults[1]).toMatchObject({ status: "failed" });
    expect(toolResults[1]?.content).toContain("termination: timeout");
    expect(executionEndEvents).toHaveLength(2);
    expect(executionEndEvents[1]?.cleanupUncertain).toBe(false);
    expect(agent.state.running).toBe(false);
  });

  it("aborts a running command once and returns to idle after process-tree cleanup", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-command-abort-"));
    temporaryDirectories.add(workspaceRoot);
    const sessionDirectory = resolveSessionDirectory(workspaceRoot, {});
    const shell = await resolveSessionShell(process.env);
    const session = await createSession({ workspaceRoot, sessionDirectory, shell });
    const command =
      shell.kind === "powershell"
        ? "Write-Output 'started'; Start-Sleep -Seconds 30"
        : "printf 'started\\n'; sleep 30";
    const modelStream: ModelStream = async function* () {
      yield {
        type: "tool_call",
        toolCallId: "00000000-0000-4000-8000-000000000040",
        toolName: "execute_command",
        input: { command, timeoutMs: 30_000 },
        invalid: false,
      } as const;
      yield finishEvent("tool_calls");
    };
    const agent = createAgentWithModelStream({ modelStream, session });
    const events: AgentEvent[] = [];
    let abortRequested = false;
    agent.subscribe((event) => {
      events.push(event);
      if (event.type === "tool_approval_requested") {
        agent.respondToToolApproval(event.request.toolApprovalRequestId, "approve");
      }
      if (
        event.type === "tool_execution_update" &&
        event.delta.includes("started") &&
        !abortRequested
      ) {
        abortRequested = true;
        agent.abort();
      }
    });

    await expect(agent.prompt("停止命令")).resolves.toEqual({ status: "aborted" });

    expect(abortRequested).toBe(true);
    expect(events.filter((event) => event.type === "run_end")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool_execution_end")).toHaveLength(1);
    expect(
      agent.state.messageHistory.filter((message) => message.role === "tool").at(-1),
    ).toMatchObject({
      status: "aborted",
      content: expect.stringContaining("termination: aborted"),
    });
    expect(agent.state.running).toBe(false);
  });
});

/** 创建一个没有 token 计量的确定性 finish 事件。 */
function finishEvent(finishReason: "stop" | "tool_calls") {
  return Object.freeze({
    type: "finish" as const,
    finishReason,
    usage: Object.freeze({ inputTokens: null, outputTokens: null, totalTokens: null }),
  });
}
