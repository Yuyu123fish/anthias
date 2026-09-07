import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentEvent, createAgentWithModelStream } from "../src/agent.js";
import type { ModelRequest, ModelStream } from "../src/model/model-stream.js";
import {
  createSession,
  resolveSessionDirectory,
  resolveSessionShell,
} from "../src/session/index.js";

const temporaryDirectories = new Set<string>();
const activeAgents = new Set<ReturnType<typeof createAgentWithModelStream>>();
const sensitiveEnvironmentNames = [
  "ANTHIAS_MODEL_API_KEY",
  "ANTHIAS_TEST_SECRET",
  "GITHUB_TOKEN",
  "NODE_OPTIONS",
  "HTTPS_PROXY",
] as const;
const originalSensitiveEnvironment = new Map(
  sensitiveEnvironmentNames.map((name) => [name, process.env[name]] as const),
);

afterEach(async () => {
  await Promise.all([...activeAgents].map((agent) => agent.close()));
  activeAgents.clear();
  for (const name of sensitiveEnvironmentNames) {
    const originalValue = originalSensitiveEnvironment.get(name);
    if (originalValue === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = originalValue;
    }
  }
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

describe("execute_command Agent Tool Loop", () => {
  it("waits for approval, uses an environment allowlist, and persists execution order", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-command-tool-"));
    temporaryDirectories.add(workspaceRoot);
    for (const name of sensitiveEnvironmentNames) {
      process.env[name] = `fake-${name.toLocaleLowerCase("en-US")}`;
    }
    const sessionDirectory = resolveSessionDirectory(workspaceRoot, {});
    const shell = await resolveSessionShell(process.env);
    const session = await createSession({ workspaceRoot, sessionDirectory, shell });
    const modelRequests: ModelRequest[] = [];
    const command =
      shell.kind === "powershell"
        ? "$names=@('ANTHIAS_MODEL_API_KEY','ANTHIAS_TEST_SECRET','GITHUB_TOKEN','NODE_OPTIONS','HTTPS_PROXY'); foreach($name in $names){ $present=[bool][Environment]::GetEnvironmentVariable($name); Write-Output \"$name=$present\" }; Set-Content -LiteralPath 'command-ran.txt' -Value 'ran'; [Console]::Error.WriteLine('stderr')"
        : `for name in ANTHIAS_MODEL_API_KEY ANTHIAS_TEST_SECRET GITHUB_TOKEN NODE_OPTIONS HTTPS_PROXY; do if printenv "\${name}" >/dev/null; then present=true; else present=false; fi; printf '%s=%s\\n' "\${name}" "\${present}"; done; printf 'ran\\n' > command-ran.txt; printf 'stderr\\n' >&2`;
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
    const agent = createTrackedAgent({ modelStream, session });
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
    expect(approvalRequest.preview).toContain(
      `shell: ${[shell.executable, ...shell.arguments]
        .map((part) => JSON.stringify(part))
        .join(" ")}`,
    );
    expect(approvalRequest.preview).toContain("cwd: .");
    expect(approvalRequest.preview).toContain("timeoutMs: 10000");
    expect(approvalRequest.preview).toContain(`command:\n${command}`);
    expect(approvalRequest.permissionMode).toBe("agent");
    expect(approvalRequest.riskSummary).toContain("当前用户权限");
    expect(approvalRequest.executionBoundary).toContain("无 OS 沙箱");

    expect(agent.respondToToolApproval(approvalRequest.toolApprovalRequestId, "approve")).toEqual({
      status: "accepted",
    });
    await expect(promptResultPromise).resolves.toEqual({ status: "completed" });

    expect(await readFile(join(workspaceRoot, "command-ran.txt"), "utf8")).toContain("ran");
    const serializedEvidence = JSON.stringify({ events, state: agent.state });
    for (const name of sensitiveEnvironmentNames) {
      expect(serializedEvidence).not.toContain(`fake-${name.toLocaleLowerCase("en-US")}`);
      expect(serializedEvidence).toMatch(new RegExp(`${name}=(False|false)`, "u"));
    }
    expect(serializedEvidence).toContain("stderr");
    const executionStart = events.find((event) => event.type === "tool_execution_start");
    expect(executionStart?.activity.summary).toMatch(/^cwd: \.; command: /u);
    expect([...(executionStart?.activity.summary ?? "")]).toHaveLength(160);
    expect(modelRequests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      toolName: "execute_command",
      status: "completed",
    });
    expect(agent.respondToToolApproval(approvalRequest.toolApprovalRequestId, "approve")).toEqual({
      status: "rejected",
      reason: "not_pending",
    });

    const sessionRecords = (await readFile(join(session.storageDirectory, "session.jsonl"), "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(sessionRecords.map((record) => record.type)).toEqual([
      "session_header",
      "message",
      "context_source",
      "context_source",
      "context_source",
      "request_usage",
      "message",
      "approval_decision",
      "tool_execution_started",
      "message",
      "request_usage",
      "message",
      "run_finished",
    ]);
  });

  it("returns bounded failures for non-zero exit and timeout, then lets the model continue", {
    timeout: 15_000,
  }, async () => {
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
    const agent = createTrackedAgent({ modelStream, session });
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

  it("drains byte- and line-bounded command output after truncation", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-command-truncation-"));
    temporaryDirectories.add(workspaceRoot);
    const sessionDirectory = resolveSessionDirectory(workspaceRoot, {});
    const shell = await resolveSessionShell(process.env);
    const session = await createSession({ workspaceRoot, sessionDirectory, shell });
    const commands =
      shell.kind === "powershell"
        ? [
            "$text='x' * 70000; [Console]::Out.Write($text); Set-Content -LiteralPath 'bytes-drained.txt' -Value 'yes'",
            "1..2100 | ForEach-Object { Write-Output 'x' }; Set-Content -LiteralPath 'lines-drained.txt' -Value 'yes'",
          ]
        : [
            "head -c 70000 /dev/zero | tr '\\0' x; printf 'yes\\n' > bytes-drained.txt",
            "i=0; while [ \"$i\" -lt 2100 ]; do printf 'x\\n'; i=$((i+1)); done; printf 'yes\\n' > lines-drained.txt",
          ];
    let modelRequestCount = 0;
    const modelStream: ModelStream = async function* () {
      modelRequestCount += 1;
      if (modelRequestCount <= commands.length) {
        yield {
          type: "tool_call",
          toolCallId: `00000000-0000-4000-8000-${modelRequestCount.toString().padStart(12, "0")}`,
          toolName: "execute_command",
          input: { command: commands[modelRequestCount - 1], timeoutMs: 10_000 },
          invalid: false,
        } as const;
        yield finishEvent("tool_calls");
        return;
      }
      yield { type: "text_delta", delta: "截断验证完成。" } as const;
      yield finishEvent("stop");
    };
    const agent = createTrackedAgent({ modelStream, session });
    agent.subscribe((event) => {
      if (event.type === "tool_approval_requested") {
        agent.respondToToolApproval(event.request.toolApprovalRequestId, "approve");
      }
    });

    await expect(agent.prompt("验证命令输出截断")).resolves.toEqual({ status: "completed" });

    const toolResults = agent.state.messageHistory.filter((message) => message.role === "tool");
    expect(toolResults).toHaveLength(2);
    for (const toolResult of toolResults) {
      expect(toolResult).toMatchObject({ status: "completed", truncated: true });
      expect(toolResult.content).toContain("...[命令输出已截断，管道已继续排空]");
      expect(toolResult.artifact).toMatchObject({ complete: true });
      expect(toolResult.artifact?.byteLength).toBeGreaterThan(0);
      expect(Buffer.byteLength(toolResult.content, "utf8")).toBeLessThanOrEqual(64 * 1024);
      expect(toolResult.content.split("\n").length).toBeLessThanOrEqual(2_000);
    }
    expect(await readFile(join(workspaceRoot, "bytes-drained.txt"), "utf8")).toContain("yes");
    expect(await readFile(join(workspaceRoot, "lines-drained.txt"), "utf8")).toContain("yes");
    expect(modelRequestCount).toBe(3);
    expect(agent.state.running).toBe(false);
  }, 25_000);

  it("continues draining a command when artifact storage is unavailable", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-command-artifact-write-failure-"));
    temporaryDirectories.add(workspaceRoot);
    const sessionDirectory = resolveSessionDirectory(workspaceRoot, {});
    const shell = await resolveSessionShell(process.env);
    const session = await createSession({ workspaceRoot, sessionDirectory, shell });
    await writeFile(join(session.storageDirectory, "artifacts"), "blocked");
    const command =
      shell.kind === "powershell"
        ? "Write-Output 'drained'; Set-Content -LiteralPath 'drain-after-artifact-failure.txt' -Value 'yes'"
        : "printf 'drained\\n'; printf 'yes\\n' > drain-after-artifact-failure.txt";
    const modelStream: ModelStream = async function* () {
      yield {
        type: "tool_call",
        toolCallId: "00000000-0000-4000-8000-000000000055",
        toolName: "execute_command",
        input: { command, timeoutMs: 10_000 },
        invalid: false,
      } as const;
      yield finishEvent("tool_calls");
      return;
    };
    let modelRequestCount = 0;
    const continuingModelStream: ModelStream = async function* (modelRequest, abortSignal) {
      modelRequestCount += 1;
      if (modelRequestCount === 1) {
        yield* modelStream(modelRequest, abortSignal);
        return;
      }
      yield { type: "text_delta", delta: "写盘失败后仍完成。" } as const;
      yield finishEvent("stop");
    };
    const agent = createTrackedAgent({ modelStream: continuingModelStream, session });
    agent.subscribe((event) => {
      if (event.type === "tool_approval_requested") {
        agent.respondToToolApproval(event.request.toolApprovalRequestId, "approve");
      }
    });

    await expect(agent.prompt("写盘失败排空")).resolves.toEqual({ status: "completed" });
    expect(
      await readFile(join(workspaceRoot, "drain-after-artifact-failure.txt"), "utf8"),
    ).toContain("yes");
    const toolResult = agent.state.messageHistory.find((message) => message.role === "tool");
    expect(toolResult).toMatchObject({ status: "completed" });
    expect(toolResult?.content).toContain("drained");
    expect(toolResult?.artifact).toBeUndefined();
    await agent.close();
  });

  it("aborts a running command once and returns to idle after process-tree cleanup", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-command-abort-"));
    temporaryDirectories.add(workspaceRoot);
    const sessionDirectory = resolveSessionDirectory(workspaceRoot, {});
    const shell = await resolveSessionShell(process.env);
    const session = await createSession({ workspaceRoot, sessionDirectory, shell });
    const escapedNodeExecutable = process.execPath.replaceAll("'", "''");
    const command =
      shell.kind === "powershell"
        ? `$child=Start-Process -FilePath '${escapedNodeExecutable}' -ArgumentList @('-e','setTimeout(()=>{},10000)') -WindowStyle Hidden -PassThru; Set-Content -LiteralPath 'child.pid' -Value $child.Id; Write-Output 'started'; Wait-Process -Id $child.Id`
        : "sleep 10 & child=$!; printf '%s' \"$child\" > child.pid; printf 'started\\n'; wait \"$child\"";
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
    const agent = createTrackedAgent({ modelStream, session });
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
    expect(events.filter((event) => event.type === "tool_execution_end")).toEqual([
      expect.objectContaining({ cleanupUncertain: false }),
    ]);
    expect(
      agent.state.messageHistory.filter((message) => message.role === "tool").at(-1),
    ).toMatchObject({
      status: "aborted",
      content: expect.stringContaining("termination: aborted"),
    });
    const childProcessId = Number.parseInt(
      (await readFile(join(workspaceRoot, "child.pid"), "utf8")).trim(),
      10,
    );
    expect(Number.isSafeInteger(childProcessId)).toBe(true);
    await vi.waitFor(() => expect(isProcessAlive(childProcessId)).toBe(false), { timeout: 5_000 });
    expect(agent.state.running).toBe(false);
  });
});

/** 创建一个确定性的 finish 事件。 */
function finishEvent(finishReason: "stop" | "tool_calls") {
  return Object.freeze({
    type: "finish" as const,
    finishReason,
  });
}

/** 判断测试命令创建的后代进程是否仍然存在。 */
function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function createTrackedAgent(options: Parameters<typeof createAgentWithModelStream>[0]) {
  const agent = createAgentWithModelStream(options);
  activeAgents.add(agent);
  return agent;
}
