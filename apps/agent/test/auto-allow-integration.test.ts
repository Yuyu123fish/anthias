import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentWithModelStream } from "../src/agent.js";
import type { AssistantToolCallPart } from "../src/message.js";
import {
  type ModelRequest,
  ModelRequestError,
  type ModelStream,
} from "../src/model/model-stream.js";
import { createSession, openSession, type Session } from "../src/session/index.js";

import { promptToCompletion } from "./prompt-helper.js";

const cleanup: Array<() => Promise<void>> = [];
const shell = {
  kind: "powershell" as const,
  executable: process.env.SystemRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  arguments: ["-NoProfile", "-NonInteractive", "-Command"],
};
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});
async function createFixture() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-auto-"));
  cleanup.push(() => rm(workspaceRoot, { recursive: true, force: true }));
  const session = await createSession({
    workspaceRoot,
    sessionDirectory: join(workspaceRoot, "sessions"),
    shell,
  });
  cleanup.push(() => session.close());
  return session;
}
const usage = {
  inputTokens: 80,
  outputTokens: 20,
  cachedInputTokens: null,
  cacheWriteInputTokens: null,
};
function toolCall(
  input: AssistantToolCallPart["input"],
  toolName = "write_file",
): AssistantToolCallPart {
  return { type: "tool_call", toolCallId: randomUUID(), toolName, input, invalid: false };
}
function reviewJson(session: Session, decision = "allow") {
  const authorizationEntryId = session.records.findLast(
    (record) => record.type === "message" && record.message.role === "user",
  )?.entryId;
  return JSON.stringify({
    decision,
    reason: "当前用户明确授权本次临时文件操作。",
    authorizationEntryIds: [authorizationEntryId],
  });
}
function makeAgent(session: Session, call: AssistantToolCallPart, review: ModelStream) {
  const purposes: string[] = [];
  let responseCount = 0;
  const agent = createAgentWithModelStream({
    session,
    permissionMode: "auto_allow",
    modelStream: async function* (request, signal) {
      purposes.push(request.purpose ?? "");
      if (request.purpose === "approval") {
        yield* review(request, signal);
      } else if (responseCount++ === 0) {
        yield { ...call, type: "tool_call" };
        yield { type: "finish", finishReason: "tool_calls", usage };
      } else {
        yield { type: "text_delta", delta: "已报告操作结果。" };
        yield { type: "finish", finishReason: "stop", usage };
      }
    },
  });
  cleanup.push(() => agent.close());
  return { agent, purposes };
}
function allowed(session: Session): ModelStream {
  return async function* () {
    yield { type: "text_delta", delta: reviewJson(session) };
    yield { type: "finish", finishReason: "stop", usage };
  };
}

it("skips both approval paths in Full Access despite workspace revocation and reopens without inheriting it", async () => {
  const session = await createFixture();
  let responseCount = 0;
  let approvalRequests = 0;
  let manualApprovals = 0;
  let revocation: ReturnType<typeof agent.permissions.revoke> | undefined;
  const agent = createAgentWithModelStream({
    session,
    permissionMode: "full_access",
    modelStream: async function* (request) {
      if (request.purpose === "approval") {
        approvalRequests++;
        throw new Error("Full Access must not call the reviewer");
      }
      if (responseCount++ === 0) {
        yield {
          ...toolCall({ path: "full.txt", content: "full access fixture" }),
          type: "tool_call",
        };
        yield { type: "finish", finishReason: "tool_calls", usage };
      } else {
        yield { type: "text_delta", delta: "done" };
        yield { type: "finish", finishReason: "stop", usage };
      }
    },
  });
  cleanup.push(() => agent.close());
  agent.subscribe((event) => {
    if (event.type === "tool_approval_requested") {
      manualApprovals++;
      agent.respondToToolApproval(event.request.toolApprovalRequestId, "deny");
    }
    if (
      event.type === "tool_authorization" &&
      event.source === "policy" &&
      event.decision === "allowed"
    ) {
      revocation = agent.permissions.revoke();
    }
  });
  expect((await promptToCompletion(agent, "写入 full.txt。")).status).toBe("completed");
  await revocation;
  expect(approvalRequests).toBe(0);
  expect(manualApprovals).toBe(0);
  expect(agent.permissions.snapshot().revoked).toBe(true);
  expect(await readFile(join(session.workspaceRoot, "full.txt"), "utf8")).toBe(
    "full access fixture",
  );
  await agent.close();
  const reopened = await openSession({
    sessionId: session.sessionId,
    workspaceRoot: session.workspaceRoot,
    sessionDirectory: session.sessionDirectory,
    shell,
  });
  cleanup.push(() => reopened.close());
  expect(reopened.records.find((record) => record.type === "approval_decision")).toMatchObject({
    permissionMode: "full_access",
    decisionSource: "policy",
    decision: "allowed",
  });
  const reopenedAgent = createAgentWithModelStream({
    session: reopened,
    modelStream: () => {
      throw new Error("history must not run the model");
    },
  });
  cleanup.push(() => reopenedAgent.close());
  expect(reopenedAgent.state.permissionMode).toBe("agent");
});

describe("AutoAllow Agent integration", () => {
  it("reviews repeated command calls against actual executions and preserves a two-call user limit", async () => {
    const session = await createFixture();
    let responseCount = 0;
    let manualRequests = 0;
    const executionHistories: unknown[] = [];
    const agent = createAgentWithModelStream({
      session,
      permissionMode: "auto_allow",
      modelStream: async function* (request) {
        if (request.purpose === "approval") {
          const message = request.messages[0];
          if (message?.role !== "user") throw new Error("Missing review input");
          const executionHistory = JSON.parse(message.content).executionHistory;
          executionHistories.push(executionHistory);
          const decision = (executionHistory?.startedCount ?? 0) < 2 ? "allow" : "needs_user";
          yield { type: "text_delta", delta: reviewJson(session, decision) };
          yield { type: "finish", finishReason: "stop", usage };
        } else if (responseCount++ < 3) {
          yield {
            ...toolCall({ command: "Write-Output 'diagnostic-ok'", cwd: "." }, "execute_command"),
            type: "tool_call",
          };
          yield { type: "finish", finishReason: "tool_calls", usage };
        } else {
          yield { type: "text_delta", delta: "已执行两次并尊重次数限制。" };
          yield { type: "finish", finishReason: "stop", usage };
        }
      },
    });
    cleanup.push(() => agent.close());
    agent.subscribe((event) => {
      if (event.type === "tool_approval_requested") {
        manualRequests++;
        agent.respondToToolApproval(event.request.toolApprovalRequestId, "deny");
      }
    });
    expect(
      (await promptToCompletion(agent, "只执行两次 Write-Output 'diagnostic-ok'，不要执行第三次。"))
        .status,
    ).toBe("completed");
    expect(executionHistories).toEqual([
      expect.objectContaining({ startedCount: 0, latestExecution: null }),
      expect.objectContaining({
        startedCount: 1,
        latestExecution: expect.objectContaining({
          result: expect.objectContaining({ status: "completed" }),
        }),
      }),
      expect.objectContaining({
        startedCount: 2,
        latestExecution: expect.objectContaining({
          result: expect.objectContaining({ status: "completed" }),
        }),
      }),
    ]);
    expect(manualRequests).toBe(1);
    expect(
      session.records.filter((record) => record.type === "tool_execution_started"),
    ).toHaveLength(2);
    expect(
      agent.state.messageHistory
        .filter((message) => message.role === "tool")
        .map((message) => message.status),
    ).toEqual(["completed", "completed", "denied"]);
  });

  it("does not review a repeated action after the user has denied its first call", async () => {
    const session = await createFixture();
    let normalRequests = 0;
    let reviewRequests = 0;
    let manualRequests = 0;
    const agent = createAgentWithModelStream({
      session,
      permissionMode: "auto_allow",
      modelStream: async function* (request) {
        if (request.purpose === "approval") {
          reviewRequests += 1;
          yield { type: "text_delta", delta: reviewJson(session, "deny") };
          yield { type: "finish", finishReason: "stop", usage };
        } else if (normalRequests++ < 2) {
          yield { ...toolCall({ path: "note.txt", content: "same action" }), type: "tool_call" };
          yield { type: "finish", finishReason: "tool_calls", usage };
        } else {
          yield { type: "text_delta", delta: "尊重用户拒绝。" };
          yield { type: "finish", finishReason: "stop", usage };
        }
      },
    });
    cleanup.push(() => agent.close());
    agent.subscribe((event) => {
      if (event.type === "tool_approval_requested") {
        manualRequests += 1;
        agent.respondToToolApproval(event.request.toolApprovalRequestId, "deny");
      }
    });
    expect((await promptToCompletion(agent, "准备临时文件操作。")).status).toBe("completed");
    expect(reviewRequests).toBe(1);
    expect(manualRequests).toBe(1);
    expect(
      agent.state.messageHistory
        .filter((message) => message.role === "tool")
        .map((message) => message.status),
    ).toEqual(["denied", "denied"]);
    expect(session.records.some((record) => record.type === "tool_execution_started")).toBe(false);
    await expect(access(join(session.workspaceRoot, "note.txt"))).rejects.toThrow();
  });

  it("preserves the task for later review after manually approving a large file once", async () => {
    const session = await createFixture();
    const largeContent = "已批准正文".repeat(2_000);
    const calls = [
      toolCall({ path: "large.txt", content: largeContent }),
      toolCall({ path: "note.txt", content: "approved" }),
    ];
    const requests: ModelRequest[] = [];
    let responseCount = 0;
    let manualCount = 0;
    const agent = createAgentWithModelStream({
      session,
      permissionMode: "auto_allow",
      modelStream: async function* (request) {
        if (request.purpose === "approval") {
          requests.push(request);
          yield { type: "text_delta", delta: reviewJson(session) };
          yield { type: "finish", finishReason: "stop", usage };
        } else {
          const call = calls[responseCount++];
          if (call !== undefined) {
            yield { ...call, type: "tool_call" };
            yield { type: "finish", finishReason: "tool_calls", usage };
          } else {
            yield { type: "text_delta", delta: "已创建两份任务文件。" };
            yield { type: "finish", finishReason: "stop", usage };
          }
        }
      },
    });
    cleanup.push(() => agent.close());
    agent.subscribe((event) => {
      if (event.type === "tool_approval_requested") {
        manualCount++;
        agent.respondToToolApproval(
          event.request.toolApprovalRequestId,
          manualCount === 1 ? "approve" : "deny",
        );
      }
    });
    const task = "请在当前工作区创建 large.txt 和 note.txt，不要写入工作区外。";
    expect((await promptToCompletion(agent, task)).status).toBe("completed");
    expect(manualCount).toBe(1);
    expect(requests).toHaveLength(1);
    const request = requests[0];
    const message = request?.messages[0];
    if (message?.role !== "user") throw new Error("Missing review input");
    expect(JSON.parse(message.content).authorizationSources).toEqual([
      expect.objectContaining({ source: "user", content: task }),
    ]);
    expect(message.content).not.toContain(largeContent);
    expect(await readFile(join(session.workspaceRoot, "large.txt"), "utf8")).toBe(largeContent);
    expect(await readFile(join(session.workspaceRoot, "note.txt"), "utf8")).toBe("approved");
    expect(
      session.records.filter(
        (record) => record.type === "approval_decision" && record.decisionSource === "user",
      ),
    ).toEqual([
      expect.objectContaining({
        decision: "allowed",
        toolCallId: calls[0]?.toolCallId,
        actionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        toolApprovalRequestId: expect.any(String),
      }),
    ]);
  });

  it("persists automatic approval and execution start before writing and reopens with default Agent mode", async () => {
    const session = await createFixture();
    const { agent, purposes } = makeAgent(
      session,
      toolCall({ path: "note.txt", content: "approved" }),
      allowed(session),
    );
    const events: string[] = [];
    agent.subscribe((event) => {
      events.push(event.type);
      if (event.type === "tool_auto_review_start")
        expect(agent.setPermissionMode("plan").status).toBe("rejected");
    });
    expect(
      await promptToCompletion(agent, "请在当前临时工作区创建 note.txt，内容 approved。"),
    ).toEqual({
      status: "completed",
    });
    expect(await readFile(join(session.workspaceRoot, "note.txt"), "utf8")).toBe("approved");
    expect(purposes).toEqual(["response", "approval", "response"]);
    expect(events).not.toContain("tool_approval_requested");
    const decisionIndex = session.records.findIndex(
      (record) => record.type === "approval_decision",
    );
    const startIndex = session.records.findIndex(
      (record) => record.type === "tool_execution_started",
    );
    expect(decisionIndex).toBeGreaterThan(-1);
    expect(startIndex).toBeGreaterThan(decisionIndex);
    expect(session.records[decisionIndex]).toMatchObject({
      decisionSource: "auto_review",
      decision: "allowed",
      actionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(agent.state.contextUsage.requests.approval.requests).toBe(1);
    await agent.close();
    const reopened = await openSession({
      workspaceRoot: session.workspaceRoot,
      sessionDirectory: session.sessionDirectory,
      sessionId: session.sessionId,
      shell,
    });
    const reopenedAgent = createAgentWithModelStream({
      session: reopened,
      modelStream: allowed(reopened),
    });
    cleanup.push(() => reopenedAgent.close());
    expect(reopenedAgent.state.permissionMode).toBe("agent");
  });

  it.each(["needs_user", "deny"])(
    "asks once for a manual decision after a valid %s review",
    async (decision) => {
      const session = await createFixture();
      const { agent, purposes } = makeAgent(
        session,
        toolCall({ path: "note.txt", content: "approved" }),
        async function* () {
          yield { type: "text_delta", delta: reviewJson(session, decision) };
          yield { type: "finish", finishReason: "stop", usage };
        },
      );
      let manualCount = 0;
      agent.subscribe((event) => {
        if (event.type === "tool_approval_requested") {
          manualCount++;
          agent.respondToToolApproval(event.request.toolApprovalRequestId, "deny");
        }
      });
      expect((await promptToCompletion(agent, "请修改临时文件。")).status).toBe("completed");
      expect(manualCount).toBe(1);
      expect(purposes.filter((purpose) => purpose === "approval")).toHaveLength(1);
      expect(session.records.filter((record) => record.type === "approval_decision")).toMatchObject(
        [
          {
            decisionSource: "auto_review",
            decision: decision === "deny" ? "denied" : "needs_user",
            reason: "当前用户明确授权本次临时文件操作。",
          },
          { decisionSource: "user", decision: "denied" },
        ],
      );
      await expect(access(join(session.workspaceRoot, "note.txt"))).rejects.toThrow();
    },
  );
  it("keeps hard denials ahead of model review even with explicit permission", async () => {
    const session = await createFixture();
    const { agent, purposes } = makeAgent(
      session,
      toolCall({ command: "rm -rf /" }, "execute_command"),
      allowed(session),
    );
    expect((await promptToCompletion(agent, "允许执行这个命令。")).status).toBe("completed");
    expect(purposes).toEqual(["response", "response"]);
    expect(session.records.some((record) => record.type === "tool_execution_started")).toBe(false);
    expect(session.records.find((record) => record.type === "approval_decision")).toMatchObject({
      decisionSource: "policy",
      decision: "denied",
    });
  });

  it("stops with a paired unexecuted tool result after review recovery is exhausted", async () => {
    const session = await createFixture();
    const call = toolCall({ path: "review-failed.txt", content: "must not execute" });
    let manualRequests = 0;
    let attempts = 0;
    const { agent, purposes } = makeAgent(session, call, () => {
      attempts++;
      throw new ModelRequestError("service");
    });
    agent.subscribe((event) => {
      if (event.type === "tool_approval_requested") {
        manualRequests++;
        agent.respondToToolApproval(event.request.toolApprovalRequestId, "deny");
      }
    });
    expect(await promptToCompletion(agent, "请创建 review-failed.txt。")).toMatchObject({
      status: "failed",
      error: expect.stringContaining("自动审核"),
    });
    expect(attempts).toBe(2);
    expect(purposes).toEqual(["response", "approval", "approval"]);
    expect(manualRequests).toBe(0);
    expect(agent.state.messageHistory.find((message) => message.role === "tool")).toMatchObject({
      toolCallId: call.toolCallId,
      status: "aborted",
    });
    expect(
      session.records.filter(
        (record) => record.type === "request_usage" && record.purpose === "approval",
      ),
    ).toHaveLength(2);
    expect(
      session.records.some(
        (record) => record.type === "tool_execution_started" || record.type === "approval_decision",
      ),
    ).toBe(false);
    expect(session.records.findLast((record) => record.type === "run_finished")).toMatchObject({
      status: "failed",
      diagnostic: { category: "service", retryCount: 1, retryStopReason: "exhausted" },
    });
    await expect(access(join(session.workspaceRoot, "review-failed.txt"))).rejects.toThrow();
  });
  it("discards a late automatic approval after cancellation", async () => {
    const session = await createFixture();
    const started = Promise.withResolvers<void>();
    const { agent } = makeAgent(
      session,
      toolCall({ path: "late.txt", content: "late" }),
      async function* (_request, signal) {
        started.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        yield { type: "text_delta", delta: reviewJson(session) };
        yield { type: "finish", finishReason: "stop", usage };
      },
    );
    const result = promptToCompletion(agent, "请创建临时文件。");
    await started.promise;
    agent.abort();
    expect(await result).toEqual({ status: "aborted" });
    await expect(access(join(session.workspaceRoot, "late.txt"))).rejects.toThrow();
    expect(session.records.some((record) => record.type === "tool_execution_started")).toBe(false);
  });

  it("rejects the old file snapshot when the target changes during review", async () => {
    const session = await createFixture();
    const path = join(session.workspaceRoot, "note.txt");
    await writeFile(path, "original");
    const { agent } = makeAgent(
      session,
      toolCall({ path: "note.txt", content: "approved" }),
      async function* () {
        await writeFile(path, "external update");
        yield { type: "text_delta", delta: reviewJson(session) };
        yield { type: "finish", finishReason: "stop", usage };
      },
    );
    expect((await promptToCompletion(agent, "请更新 note.txt。")).status).toBe("completed");
    expect(await readFile(path, "utf8")).toBe("external update");
    expect(agent.state.messageHistory.find((message) => message.role === "tool")).toMatchObject({
      status: "failed",
      content: expect.stringContaining("stale target"),
    });
  });

  it("stops without side effects when approval persistence fails", async () => {
    const session = await createFixture();
    const faultSession: Session = {
      ...session,
      get records() {
        return session.records;
      },
      async appendApprovalDecision() {
        throw new Error("forced disk failure");
      },
    };
    const { agent } = makeAgent(
      faultSession,
      toolCall({ path: "note.txt", content: "approved" }),
      allowed(session),
    );
    expect(await promptToCompletion(agent, "请创建 note.txt。")).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Session"),
    });
    await expect(access(join(session.workspaceRoot, "note.txt"))).rejects.toThrow();
    expect(session.records.some((record) => record.type === "tool_execution_started")).toBe(false);
  });
});
