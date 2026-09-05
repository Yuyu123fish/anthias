import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Agent,
  type AgentEvent,
  createAgentWithModelStream,
  type ToolApprovalRequest,
} from "../src/agent.js";
import type { ModelRequest, ModelStream } from "../src/model-stream.js";
import {
  createSession,
  openSession,
  resolveSessionDirectory,
  resolveSessionShell,
} from "../src/session/index.js";

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

describe("file Agent Tool Loop", () => {
  it("applies an approved edit, create, and overwrite with one confirmation each", async () => {
    const fixture = await createFileToolFixture("alpha\n");
    const modelRequests: ModelRequest[] = [];
    const modelStream: ModelStream = async function* (modelRequest) {
      modelRequests.push(modelRequest);
      if (modelRequests.length === 1) {
        yield toolCallEvent(1, "edit_file", {
          path: "existing.txt",
          replacements: [{ oldText: "alpha", newText: "beta" }],
        });
        yield finishEvent("tool_calls");
        return;
      }
      if (modelRequests.length === 2) {
        yield toolCallEvent(2, "write_file", { path: "created.txt", content: "created\n" });
        yield finishEvent("tool_calls");
        return;
      }
      if (modelRequests.length === 3) {
        yield toolCallEvent(3, "write_file", {
          path: "existing.txt",
          content: "overwritten\n",
        });
        yield finishEvent("tool_calls");
        return;
      }
      yield { type: "text_delta", delta: "文件修改完成。" } as const;
      yield finishEvent("stop");
    };
    const agent = createAgentWithModelStream({ modelStream, session: fixture.session });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => events.push(event));
    const promptResultPromise = agent.prompt("修改文件");

    const editApproval = await waitForNextApproval(agent);
    expect(editApproval.preview).toContain("operation: edit");
    expect(editApproval.preview).toContain("-alpha");
    expect(editApproval.preview).toContain("+beta");
    expect(await readFile(fixture.existingFilePath, "utf8")).toBe("alpha\n");
    agent.respondToToolApproval(editApproval.toolApprovalRequestId, "approve");

    const createApproval = await waitForNextApproval(agent, editApproval.toolApprovalRequestId);
    expect(createApproval.preview).toContain("operation: create");
    await expect(access(join(fixture.workspaceRoot, "created.txt"))).rejects.toThrow();
    agent.respondToToolApproval(createApproval.toolApprovalRequestId, "approve");

    const overwriteApproval = await waitForNextApproval(
      agent,
      createApproval.toolApprovalRequestId,
    );
    expect(overwriteApproval.preview).toContain("operation: overwrite");
    expect(await readFile(fixture.existingFilePath, "utf8")).toBe("beta\n");
    agent.respondToToolApproval(overwriteApproval.toolApprovalRequestId, "approve");

    await expect(promptResultPromise).resolves.toEqual({ status: "completed" });
    expect(await readFile(join(fixture.workspaceRoot, "created.txt"), "utf8")).toBe("created\n");
    expect(await readFile(fixture.existingFilePath, "utf8")).toBe("overwritten\n");
    expect(modelRequests).toHaveLength(4);
    expect(modelRequests[3]?.messages.filter((message) => message.role === "tool")).toHaveLength(3);
    expect(
      events
        .filter((event) => event.type === "tool_execution_start")
        .map((event) => event.activity.summary),
    ).toEqual(["target: existing.txt", "target: created.txt", "target: existing.txt"]);
    expect(
      JSON.stringify(events.filter((event) => event.type === "tool_execution_start")),
    ).not.toMatch(/alpha|beta|created\\n|overwritten/u);

    const records = await readSessionRecords(fixture.sessionFilePath);
    expect(records.filter((record) => record.type === "tool_execution_started")).toHaveLength(3);
    for (const startedRecord of records.filter(
      (record) => record.type === "tool_execution_started",
    )) {
      const startedIndex = records.indexOf(startedRecord);
      const resultIndex = records.findIndex(
        (record, index) =>
          index > startedIndex &&
          record.type === "message" &&
          (record.message as Record<string, unknown> | undefined)?.type === "tool_result",
      );
      expect(resultIndex).toBeGreaterThan(startedIndex);
    }
  });

  it("rejects a stale edit after approval without overwriting the external change", async () => {
    const fixture = await createFileToolFixture("before\n");
    let modelRequestCount = 0;
    const modelStream: ModelStream = async function* () {
      modelRequestCount += 1;
      if (modelRequestCount === 1) {
        yield toolCallEvent(10, "edit_file", {
          path: "existing.txt",
          replacements: [{ oldText: "before", newText: "agent" }],
        });
        yield finishEvent("tool_calls");
        return;
      }
      yield { type: "text_delta", delta: "已看到陈旧目标失败。" } as const;
      yield finishEvent("stop");
    };
    const agent = createAgentWithModelStream({ modelStream, session: fixture.session });
    const promptResultPromise = agent.prompt("编辑文件");
    const approval = await waitForNextApproval(agent);

    await writeFile(fixture.existingFilePath, "external\n", "utf8");
    agent.respondToToolApproval(approval.toolApprovalRequestId, "approve");

    await expect(promptResultPromise).resolves.toEqual({ status: "completed" });
    expect(await readFile(fixture.existingFilePath, "utf8")).toBe("external\n");
    expect(
      agent.state.messageHistory.filter((message) => message.role === "tool").at(-1),
    ).toMatchObject({
      status: "failed",
      content: expect.stringContaining("stale target"),
    });
  });

  it("denies a file change without a start record and rejects a repeated response", async () => {
    const fixture = await createFileToolFixture("unchanged\n");
    let modelRequestCount = 0;
    const modelStream: ModelStream = async function* () {
      modelRequestCount += 1;
      if (modelRequestCount === 1) {
        yield toolCallEvent(20, "write_file", { path: "denied.txt", content: "no\n" });
        yield finishEvent("tool_calls");
        return;
      }
      yield { type: "text_delta", delta: "已接受拒绝。" } as const;
      yield finishEvent("stop");
    };
    const agent = createAgentWithModelStream({ modelStream, session: fixture.session });
    const promptResultPromise = agent.prompt("拒绝写入");
    const approval = await waitForNextApproval(agent);

    expect(agent.respondToToolApproval(approval.toolApprovalRequestId, "deny")).toEqual({
      status: "accepted",
    });
    expect(agent.respondToToolApproval(approval.toolApprovalRequestId, "approve")).toEqual({
      status: "rejected",
      reason: "not_pending",
    });
    await expect(promptResultPromise).resolves.toEqual({ status: "completed" });
    await expect(access(join(fixture.workspaceRoot, "denied.txt"))).rejects.toThrow();
    const records = await readSessionRecords(fixture.sessionFilePath);
    expect(records.some((record) => record.type === "tool_execution_started")).toBe(false);
    expect(
      agent.state.messageHistory.filter((message) => message.role === "tool").at(-1),
    ).toMatchObject({
      status: "denied",
    });
  });

  it("aborts an approval wait once without starting the file Tool", async () => {
    const fixture = await createFileToolFixture("unchanged\n");
    const modelStream: ModelStream = async function* () {
      yield toolCallEvent(30, "edit_file", {
        path: "existing.txt",
        replacements: [{ oldText: "unchanged", newText: "changed" }],
      });
      yield finishEvent("tool_calls");
    };
    const agent = createAgentWithModelStream({ modelStream, session: fixture.session });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => events.push(event));
    const promptResultPromise = agent.prompt("停止确认");
    const approval = await waitForNextApproval(agent);

    agent.abort();
    await expect(promptResultPromise).resolves.toEqual({ status: "aborted" });

    expect(agent.respondToToolApproval(approval.toolApprovalRequestId, "approve")).toEqual({
      status: "rejected",
      reason: "not_pending",
    });
    expect(await readFile(fixture.existingFilePath, "utf8")).toBe("unchanged\n");
    expect(events.filter((event) => event.type === "run_end")).toHaveLength(1);
    expect(events.some((event) => event.type === "tool_execution_start")).toBe(false);
    expect(
      agent.state.messageHistory.filter((message) => message.role === "tool").at(-1),
    ).toMatchObject({
      status: "aborted",
    });
    const reopenedSession = await openSession({
      sessionId: fixture.session.sessionId,
      workspaceRoot: fixture.workspaceRoot,
      sessionDirectory: fixture.sessionDirectory,
      shell: fixture.shell,
    });
    expect(reopenedSession.messageHistory.at(-1)).toMatchObject({
      role: "tool",
      status: "aborted",
    });
  });

  it("fails invalid, reserved, and oversized file calls without requesting approval", async () => {
    const fixture = await createFileToolFixture("same same\n");
    let modelRequestCount = 0;
    const modelStream: ModelStream = async function* () {
      modelRequestCount += 1;
      if (modelRequestCount === 1) {
        yield toolCallEvent(40, "edit_file", {
          path: "existing.txt",
          replacements: [{ oldText: "same", newText: "different" }],
        });
        yield toolCallEvent(41, "write_file", {
          path: "data/conversation/forbidden.txt",
          content: "forbidden",
        });
        yield toolCallEvent(42, "write_file", {
          path: "oversized.txt",
          content: "x".repeat(70 * 1024),
        });
        yield finishEvent("tool_calls");
        return;
      }
      yield { type: "text_delta", delta: "已看到失败。" } as const;
      yield finishEvent("stop");
    };
    const agent = createAgentWithModelStream({ modelStream, session: fixture.session });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => events.push(event));

    await expect(agent.prompt("非法文件调用")).resolves.toEqual({ status: "completed" });

    const toolResults = agent.state.messageHistory.filter((message) => message.role === "tool");
    expect(toolResults).toHaveLength(3);
    expect(toolResults.every((message) => message.status === "failed")).toBe(true);
    expect(toolResults.map((message) => message.content).join("\n")).toContain("Session 保留目录");
    expect(toolResults.map((message) => message.content).join("\n")).toContain("64 KiB");
    expect(events.some((event) => event.type === "tool_approval_requested")).toBe(false);
    expect(events.some((event) => event.type === "tool_execution_start")).toBe(false);
    expect(await readFile(fixture.existingFilePath, "utf8")).toBe("same same\n");
    await expect(access(join(fixture.workspaceRoot, "oversized.txt"))).rejects.toThrow();
  });
});

/** 创建一个含已有文本文件和真实 Session 的临时 Tool 工作区。 */
async function createFileToolFixture(existingContent: string) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-file-tool-"));
  temporaryDirectories.add(workspaceRoot);
  const existingFilePath = join(workspaceRoot, "existing.txt");
  await writeFile(existingFilePath, existingContent, "utf8");
  const sessionDirectory = resolveSessionDirectory(workspaceRoot, {});
  const shell = await resolveSessionShell(process.env);
  const session = await createSession({ workspaceRoot, sessionDirectory, shell });
  return Object.freeze({
    workspaceRoot,
    existingFilePath,
    session,
    sessionDirectory,
    shell,
    sessionFilePath: join(session.storageDirectory, "session.jsonl"),
  });
}

/** 等待 Agent 发布一个不同于上一请求的当前确认。 */
async function waitForNextApproval(
  agent: Agent,
  previousRequestId?: string,
): Promise<ToolApprovalRequest> {
  await vi.waitFor(() => {
    expect(agent.state.pendingToolApproval?.toolApprovalRequestId).not.toBe(previousRequestId);
    expect(agent.state.pendingToolApproval).not.toBeNull();
  });
  const request = agent.state.pendingToolApproval;
  if (request === null) {
    throw new Error("expected pending Tool approval");
  }
  return request;
}

/** 读取测试 Session 中 Header 后的全部 JSONL 记录。 */
async function readSessionRecords(sessionFilePath: string): Promise<Record<string, unknown>[]> {
  return (await readFile(sessionFilePath, "utf8"))
    .trimEnd()
    .split("\n")
    .slice(1)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** 创建一个稳定 UUID 的确定性 ToolCall 事件。 */
function toolCallEvent(index: number, toolName: string, input: unknown) {
  return Object.freeze({
    type: "tool_call" as const,
    toolCallId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    toolName,
    input,
    invalid: false,
  });
}

/** 创建一个确定性的 finish 事件。 */
function finishEvent(finishReason: "stop" | "tool_calls") {
  return Object.freeze({
    type: "finish" as const,
    finishReason,
  });
}
