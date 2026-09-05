import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentWithModelStream } from "../src/agent.js";
import type { AssistantToolCallPart } from "../src/message.js";
import type { ModelStream } from "../src/model/model-stream.js";
import { createSession, openSession, type Session } from "../src/session/index.js";

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
    (record) => record.type === "message" && record.message.type === "user",
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

describe("AutoAllow Agent integration", () => {
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
    expect((await agent.prompt("准备临时文件操作。")).status).toBe("completed");
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
    expect(await agent.prompt("请在当前临时工作区创建 note.txt，内容 approved。")).toEqual({
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

  it.each(["malformed", "deny"])(
    "falls back to one manual decision for %s review",
    async (kind) => {
      const session = await createFixture();
      const { agent, purposes } = makeAgent(
        session,
        toolCall({ path: "note.txt", content: "approved" }),
        async function* () {
          yield {
            type: "text_delta",
            delta: kind === "malformed" ? "invalid" : reviewJson(session, "deny"),
          };
          yield { type: "finish", finishReason: "stop", usage };
        },
      );
      let manualCount = 0;
      agent.subscribe((event) => {
        if (event.type === "tool_approval_requested") {
          manualCount += 1;
          agent.respondToToolApproval(event.request.toolApprovalRequestId, "deny");
        }
      });
      expect((await agent.prompt("请修改临时文件。")).status).toBe("completed");
      expect(manualCount).toBe(1);
      expect(purposes.filter((purpose) => purpose === "approval")).toHaveLength(1);
      expect(session.records.filter((record) => record.type === "approval_decision")).toMatchObject(
        [
          { decisionSource: "auto_review", decision: "needs_user" },
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
    expect((await agent.prompt("允许执行这个命令。")).status).toBe("completed");
    expect(purposes).toEqual(["response", "response"]);
    expect(session.records.some((record) => record.type === "tool_execution_started")).toBe(false);
    expect(session.records.find((record) => record.type === "approval_decision")).toMatchObject({
      decisionSource: "policy",
      decision: "denied",
    });
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
    const result = agent.prompt("请创建临时文件。");
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
    expect((await agent.prompt("请更新 note.txt。")).status).toBe("completed");
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
      async acquireRun(runId) {
        const acquired = await session.acquireRun(runId);
        if (acquired.status !== "acquired") return acquired;
        return {
          status: "acquired",
          lease: {
            ...acquired.lease,
            async appendApprovalDecision() {
              throw new Error("forced disk failure");
            },
          },
        };
      },
    };
    const { agent } = makeAgent(
      faultSession,
      toolCall({ path: "note.txt", content: "approved" }),
      allowed(session),
    );
    expect(await agent.prompt("请创建 note.txt。")).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Session"),
    });
    await expect(access(join(session.workspaceRoot, "note.txt"))).rejects.toThrow();
    expect(session.records.some((record) => record.type === "tool_execution_started")).toBe(false);
  });
});
