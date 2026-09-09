import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { type Agent, createAgentWithModelStream } from "../src/agent.js";
import { memoryHash } from "../src/memory/schema.js";
import type { ModelRequest, ModelStream } from "../src/model/model-stream.js";
import type { MemberSummary } from "../src/multi-agent/index.js";
import { readSessionHistory } from "../src/session/history.js";
import { createSession, openSession } from "../src/session/index.js";
import { locateSessionStorage } from "../src/session/locations.js";

const execute = promisify(execFile);
const roots: string[] = [];
const agents: Agent[] = [];
const shell = {
  kind: "powershell" as const,
  executable: "pwsh",
  arguments: ["-NoProfile", "-Command"],
};
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
  for (const directory of roots.splice(0)) {
    const expectedParent = resolve(tmpdir());
    if (relative(expectedParent, resolve(directory)).startsWith(".."))
      throw new Error("unexpected fixture path");
    await rm(directory, { recursive: true, force: true });
  }
});
async function setup(modelStream: ModelStream, repository = false) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "anthias-multi-agent-"));
  roots.push(fixtureRoot);
  const directory = join(fixtureRoot, "workspace");
  await mkdir(directory);
  if (repository) {
    for (const args of [
      ["init"],
      ["config", "user.name", "Fixture"],
      ["config", "user.email", "fixture@example.invalid"],
    ])
      await execute("git", args, { cwd: directory, windowsHide: true });
    await writeFile(join(directory, "shared.txt"), "committed baseline");
    await execute("git", ["add", "--", "shared.txt"], { cwd: directory, windowsHide: true });
    await execute("git", ["commit", "-m", "fixture baseline"], {
      cwd: directory,
      windowsHide: true,
    });
  }
  const sessionDirectory = join(fixtureRoot, "conversation");
  const worktreeDirectory = join(fixtureRoot, "worktrees");
  const session = await createSession({ workspaceRoot: directory, sessionDirectory, shell });
  const agent = createAgentWithModelStream({
    session,
    modelStream,
    worktreeDirectory,
  });
  agents.push(agent);
  return { directory, session, sessionDirectory, worktreeDirectory, agent };
}
function value(result: Readonly<{ ok: true; value: string } | { ok: false; error: string }>) {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
async function spawn(agent: Agent, task: string, writable = false): Promise<MemberSummary> {
  return JSON.parse(
    value(await agent.collaboration.execute({ action: "spawn", task, writable })),
  ) as MemberSummary;
}
async function wait(agent: Agent, id: string) {
  await agent.collaboration.execute({ action: "wait", memberIds: [id], timeoutMs: 5000 });
  expect(
    agent.collaboration.snapshot().members.find((member) => member.sessionId === id)?.status,
  ).not.toBe("running");
}
function userText(request: ModelRequest) {
  return request.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
}

describe("MultiAgent through the Agent interface", () => {
  it("reads referenced member artifacts through the root interface without sharing files across members", async () => {
    const { agent, session, sessionDirectory, directory } = await setup(async function* (request) {
      if (
        userText(request).includes("short result") ||
        request.messages.some((message) => message.role === "tool")
      ) {
        yield { type: "text_delta", delta: "member finished" };
        yield { type: "finish", finishReason: "stop" };
      } else {
        yield {
          type: "tool_call",
          toolCallId: randomUUID(),
          toolName: "read_file",
          input: { path: "large.txt", lineCount: 200 },
          invalid: false,
        };
        yield { type: "finish", finishReason: "tool_calls" };
      }
    });
    await writeFile(
      join(directory, "large.txt"),
      ("member-output-" + "中".repeat(400) + "\n").repeat(100),
    );
    const first = await spawn(agent, "read the large file");
    await wait(agent, first.sessionId);
    const second = await spawn(agent, "short result");
    await wait(agent, second.sessionId);
    value(await agent.collaboration.execute({ action: "team_create", name: "Archive check" }));
    const third = JSON.parse(
      value(await agent.collaboration.execute({ action: "team_add", task: "short result" })),
    ) as MemberSummary;
    await wait(agent, third.sessionId);
    const saved = JSON.parse(
      value(await agent.collaboration.execute({ action: "result", memberId: first.sessionId })),
    ) as {
      artifacts: Array<{ sessionId: string; artifactId: string }>;
    };
    const artifact = saved.artifacts[0];
    if (artifact === undefined) throw new Error("expected durable member artifact");
    expect(artifact.sessionId).toBe(first.sessionId);
    const page = JSON.parse(
      value(
        await agent.collaboration.execute({
          action: "result",
          memberId: first.sessionId,
          artifactId: artifact.artifactId,
        }),
      ),
    ) as { status: string; content: string };
    expect(page.status).toBe("completed");
    expect(page.content).toContain("member-output-");
    for (const memberId of [second.sessionId, third.sessionId]) {
      const denied = await agent.collaboration.execute({
        action: "result",
        memberId,
        artifactId: artifact.artifactId,
      });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error).toContain("未被该成员历史引用");
    }
    expect(
      (
        await agent.collaboration.execute({
          action: "result",
          memberId: first.sessionId,
          artifactId: randomUUID(),
        })
      ).ok,
    ).toBe(false);
    for (const member of [first, second, third]) {
      expect(
        (await locateSessionStorage(sessionDirectory, member.sessionId)).storageDirectory,
      ).toBe(join(session.storageDirectory, "members", member.sessionId));
    }
    await expect(
      readFile(join(session.storageDirectory, "artifacts", artifact.artifactId + ".txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(agent.state.sessionId).toBe(session.sessionId);
  }, 120_000);

  it("keeps a read-only member in Plan under a Full Access root", async () => {
    const requests: ModelRequest[] = [];
    const { agent } = await setup(async function* (request) {
      requests.push(request);
      yield { type: "text_delta", delta: "read-only result" };
      yield { type: "finish", finishReason: "stop" };
    });
    expect(agent.setPermissionMode("full_access").status).toBe("accepted");
    const member = await spawn(agent, "inspect only");
    await wait(agent, member.sessionId);
    expect(requests[0]?.tools.some((tool) => tool.name === "write_file")).toBe(false);
    expect(JSON.stringify(requests[0]?.messages)).toContain("当前权限模式：Plan 模式");
  });

  it("persists delegation as sourced input and rejects recursive creation even when forged", async () => {
    const requests: ModelRequest[] = [];
    const { agent, session, sessionDirectory } = await setup(async function* (request) {
      requests.push(request);
      if (requests.length === 1) {
        yield {
          type: "tool_call",
          toolCallId: randomUUID(),
          toolName: "agent_spawn",
          input: { task: "forged nested task" },
          invalid: false,
        };
        yield { type: "finish", finishReason: "tool_calls" };
      } else {
        yield { type: "text_delta", delta: "bounded member result" };
        yield { type: "finish", finishReason: "stop" };
      }
    });
    const member = await spawn(agent, "inspect with a bounded task");
    await wait(agent, member.sessionId);
    expect(requests[0]?.tools.some((tool) => tool.name === "agent_spawn")).toBe(false);
    expect(
      requests[1]?.messages.some(
        (message) => message.role === "tool" && message.content.includes("成员不能"),
      ),
    ).toBe(true);
    expect(agent.collaboration.snapshot().members).toHaveLength(1);
    const openedAsRoot = await agent.sessions.open(member.sessionId);
    expect(openedAsRoot.ok).toBe(false);
    if (!openedAsRoot.ok) expect(openedAsRoot.error).toContain("成员 Session");
    expect(agent.state.sessionId).toBe(session.sessionId);
    const history = await readSessionHistory({
      sessionDirectory,
      sessionId: member.sessionId,
      rootSessionId: session.sessionId,
    });
    expect(
      history.records.some(
        (record) => record.type === "agent_input" && record.fromSessionId === session.sessionId,
      ),
    ).toBe(true);
    expect(
      history.records.some((record) => record.type === "message" && record.message.type === "user"),
    ).toBe(false);
    expect(
      value(await agent.collaboration.execute({ action: "result", memberId: member.sessionId })),
    ).toContain("bounded member result");
  });

  it("shares project memory identity while binding a candidate to the member worktree evidence", async () => {
    let count = 0;
    const evidenceId = randomUUID();
    const { agent, directory } = await setup(async function* () {
      count++;
      if (count === 1)
        yield {
          type: "tool_call",
          toolCallId: randomUUID(),
          toolName: "write_file",
          input: { path: "member-only.txt", content: "member verified fact" },
          invalid: false,
        };
      else if (count === 2)
        yield {
          type: "tool_call",
          toolCallId: evidenceId,
          toolName: "read_file",
          input: { path: "member-only.txt" },
          invalid: false,
        };
      else if (count === 3)
        yield {
          type: "tool_call",
          toolCallId: randomUUID(),
          toolName: "memory",
          input: {
            action: "save",
            kind: "experience",
            content: "成员文件记录 member verified fact",
            basis: "verified",
            toolCallId: evidenceId,
            quote: "member verified fact",
          },
          invalid: false,
        };
      else {
        yield { type: "finish", finishReason: "stop" };
        return;
      }
      yield { type: "finish", finishReason: "tool_calls" };
    }, true);
    agent.subscribe((event) => {
      if (event.type === "tool_approval_requested")
        agent.respondToToolApproval(event.request.toolApprovalRequestId, "approve");
    });
    const member = await spawn(agent, "验证成员自己的新文件并提交经验候选", true);
    await wait(agent, member.sessionId);
    const queried = await agent.memory.query({ status: "all" });
    if (!queried.ok) throw new Error(queried.error);
    const entry = queried.value.entries[0];
    expect(entry).toMatchObject({
      status: "candidate",
      scope: queried.value.projectId,
      conditions: {
        files: [{ path: "member-only.txt", fingerprint: memoryHash("member verified fact") }],
      },
      source: { kind: "verified", sessionId: member.sessionId },
    });
    expect(await readFile(join(member.workspaceRoot, "member-only.txt"), "utf8")).toBe(
      "member verified fact",
    );
    await expect(readFile(join(directory, "member-only.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    if (!entry) throw new Error("candidate");
    const confirmation = await agent.memory.execute({
      action: "confirm",
      id: entry.id,
      revision: entry.revision,
    });
    expect(confirmation.ok && confirmation.value.entries[0]?.status).toBe("review");
    expect(confirmation.ok && confirmation.value.entries[0]?.source.sessionId).toBe(
      member.sessionId,
    );
    expect(confirmation.ok && confirmation.value.entries[0]?.userConfirmed).toBe(true);
  }, 30_000);

  it("continues root and member requests beyond the former shared count", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const counts = { root: 0, member: 0 };
    const { agent } = await setup(async function* (request) {
      const owner = request.messages.some(
        (message) => message.role === "user" && message.content === "root budget",
      )
        ? "root"
        : "member";
      const count = ++counts[owner];
      if (owner === "member" && count === 1) {
        entered.resolve();
        await release.promise;
      }
      if (owner === "root") release.resolve();
      if (count <= 32) {
        yield {
          type: "tool_call",
          toolCallId: randomUUID(),
          toolName: "unknown_tool",
          input: {},
          invalid: false,
        };
        yield { type: "finish", finishReason: "tool_calls" };
      } else {
        yield { type: "text_delta", delta: "请求已完成" };
        yield { type: "finish", finishReason: "stop" };
      }
    });
    const member = await spawn(agent, "member budget");
    await entered.promise;
    expect((await agent.prompt("root budget")).status).toBe("completed");
    await wait(agent, member.sessionId);
    expect(counts).toEqual({ root: 33, member: 33 });
  }, 60_000);

  it("isolates writable members and delivers Git results through approved controls", async () => {
    const requests = new Map<string, number>();
    const { agent, directory } = await setup(async function* (request) {
      const task = userText(request).includes("member B") ? "B" : "A";
      const count = (requests.get(task) ?? 0) + 1;
      requests.set(task, count);
      if (count === 1) {
        yield {
          type: "tool_call",
          toolCallId: randomUUID(),
          toolName: "write_file",
          input: { path: "shared.txt", content: "result " + task },
          invalid: false,
        };
        yield { type: "finish", finishReason: "tool_calls" };
      } else {
        yield { type: "text_delta", delta: "finished " + task };
        yield { type: "finish", finishReason: "stop" };
      }
    }, true);
    await writeFile(join(directory, "shared.txt"), "uncommitted root change");
    const approvalOwners: string[] = [];
    agent.subscribe((event) => {
      if (event.type === "tool_approval_requested") {
        if (event.request.memberSessionId) approvalOwners.push(event.request.memberSessionId);
        agent.respondToToolApproval(event.request.toolApprovalRequestId, "approve");
      }
    });
    const first = await spawn(agent, "member A", true);
    const second = await spawn(agent, "member B", true);
    await wait(agent, first.sessionId);
    await wait(agent, second.sessionId);
    expect(first.workspaceRoot).not.toBe(second.workspaceRoot);
    expect(await readFile(join(first.workspaceRoot, "shared.txt"), "utf8")).toBe("result A");
    expect(await readFile(join(second.workspaceRoot, "shared.txt"), "utf8")).toBe("result B");
    expect(await readFile(join(directory, "shared.txt"), "utf8")).toBe("uncommitted root change");
    expect(new Set(approvalOwners)).toEqual(new Set([first.sessionId, second.sessionId]));
    await writeFile(join(directory, "shared.txt"), "committed baseline");
    if (!first.worktreeId) throw new Error("missing managed worktree");
    const committed = JSON.parse(
      value(
        await agent.git.execute({
          action: "commit",
          worktreeId: first.worktreeId,
          paths: ["shared.txt"],
          message: "deliver member A",
        }),
      ),
    ) as { commit: string };
    value(
      await agent.git.execute({
        action: "integrate",
        worktreeId: first.worktreeId,
        commit: committed.commit,
      }),
    );
    expect(value(await agent.git.execute({ action: "diff" }))).toContain("result A");
    value(await agent.git.execute({ action: "continue" }));
    expect(await readFile(join(directory, "shared.txt"), "utf8")).toBe("result A");
    value(await agent.git.execute({ action: "remove", worktreeId: first.worktreeId }));
    expect(
      value(await agent.collaboration.execute({ action: "result", memberId: first.sessionId })),
    ).toContain("finished A");
  }, 120_000);

  it("keeps team messages queued while idle and resumes explicitly after reopening", async () => {
    const requests: ModelRequest[] = [];
    const stream: ModelStream = async function* (request) {
      requests.push(request);
      yield { type: "text_delta", delta: "team result" };
      yield { type: "finish", finishReason: "stop" };
    };
    const { agent, session, sessionDirectory, directory, worktreeDirectory } = await setup(stream);
    value(await agent.collaboration.execute({ action: "team_create", name: "Review" }));
    const member = JSON.parse(
      value(await agent.collaboration.execute({ action: "team_add", task: "initial review" })),
    ) as MemberSummary;
    await wait(agent, member.sessionId);
    expect(agent.collaboration.snapshot().tasks[0]?.status).toBe("completed");
    const before = requests.length;
    value(
      await agent.collaboration.execute({
        action: "message",
        memberId: member.sessionId,
        content: "queued instruction",
      }),
    );
    expect(requests).toHaveLength(before);
    await agent.close();
    const reopenedSession = await openSession({
      workspaceRoot: directory,
      sessionDirectory,
      sessionId: session.sessionId,
      shell,
    });
    const reopened = createAgentWithModelStream({
      session: reopenedSession,
      modelStream: stream,
      worktreeDirectory,
    });
    agents.push(reopened);
    expect(requests).toHaveLength(before);
    expect(reopened.collaboration.snapshot().members[0]?.status).toBe("interrupted");
    value(
      await reopened.collaboration.execute({
        action: "task_assign",
        memberId: member.sessionId,
        task: "followup review",
      }),
    );
    await wait(reopened, member.sessionId);
    expect(userText(requests.at(-1) as ModelRequest)).toContain("queued instruction");
    const history = await readSessionHistory({
      sessionDirectory,
      sessionId: member.sessionId,
      rootSessionId: session.sessionId,
    });
    expect(
      history.records.filter(
        (record) => record.type === "agent_input" && record.content === "queued instruction",
      ),
    ).toHaveLength(1);
    expect(reopened.collaboration.snapshot().tasks.at(-1)?.status).toBe("completed");
  });

  it("enforces member capacity and cancels members and pending waits before close returns", async () => {
    const entered = Promise.withResolvers<void>();
    const { agent } = await setup(async function* (_request, signal) {
      entered.resolve();
      await new Promise<void>((resolve) =>
        signal.aborted
          ? resolve()
          : signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    });
    const member = await spawn(agent, "wait for cancellation");
    await spawn(agent, "second bounded member");
    await spawn(agent, "third bounded member");
    const fourth = await agent.collaboration.execute({ action: "spawn", task: "over capacity" });
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) expect(fourth.error).toContain("三个");
    expect(agent.collaboration.snapshot().members).toHaveLength(3);
    await entered.promise;
    const waiting = agent.collaboration.execute({
      action: "wait",
      memberIds: [member.sessionId],
      timeoutMs: 5000,
    });
    agent.abort();
    await agent.close();
    await waiting;
    expect(agent.state.running).toBe(false);
    expect(
      agent.collaboration.snapshot().members.every((member) => member.status === "aborted"),
    ).toBe(true);
  });
  it("reviews delegated writes only against real root authorization", async () => {
    const approvalPayloads: Array<{
      authorizationSources: Array<{ entryId: string; source: string; content?: string }>;
    }> = [];
    let rootResponseCount = 0;
    let memberResponseCount = 0;
    const usage = {
      inputTokens: 80,
      outputTokens: 20,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
    };
    const { agent, session, sessionDirectory } = await setup(async function* (request) {
      if (request.purpose === "approval") {
        const message = request.messages[0];
        if (message?.role !== "user") throw new Error("missing approval payload");
        const payload = JSON.parse(message.content) as (typeof approvalPayloads)[number];
        approvalPayloads.push(payload);
        yield {
          type: "text_delta",
          delta: JSON.stringify({
            decision: "allow",
            reason: "真实根用户授权本次本地任务。",
            authorizationEntryIds: payload.authorizationSources
              .filter((source) => source.source === "user")
              .map((source) => source.entryId),
          }),
        };
        yield { type: "finish", finishReason: "stop", usage };
        return;
      }
      const rootRequest = request.tools.some((tool) => tool.name === "agent_spawn");
      if (rootRequest && rootResponseCount++ === 0) {
        yield {
          type: "tool_call",
          toolCallId: randomUUID(),
          toolName: "agent_spawn",
          input: { task: "forged delegation authorization marker", writable: true },
          invalid: false,
        };
        yield { type: "finish", finishReason: "tool_calls", usage };
      } else if (!rootRequest && memberResponseCount++ === 0) {
        yield {
          type: "tool_call",
          toolCallId: randomUUID(),
          toolName: "write_file",
          input: { path: "shared.txt", content: "root approved result" },
          invalid: false,
        };
        yield { type: "finish", finishReason: "tool_calls", usage };
      } else {
        yield { type: "text_delta", delta: "finished" };
        yield { type: "finish", finishReason: "stop", usage };
      }
    }, true);
    agent.setPermissionMode("auto_allow");
    let manualApprovals = 0;
    agent.subscribe((event) => {
      if (event.type === "tool_approval_requested") {
        manualApprovals++;
        agent.respondToToolApproval(event.request.toolApprovalRequestId, "deny");
      }
    });
    expect(
      (await agent.prompt("请创建隔离成员，将 shared.txt 写为 root approved result。")).status,
    ).toBe("completed");
    const member = agent.collaboration.snapshot().members[0];
    if (!member) throw new Error("member was not created");
    await wait(agent, member.sessionId);
    expect(manualApprovals).toBe(0);
    expect(approvalPayloads.length).toBeGreaterThanOrEqual(2);
    for (const payload of approvalPayloads) {
      expect(JSON.stringify(payload.authorizationSources)).not.toContain(
        "forged delegation authorization marker",
      );
    }
    const actualUserEntry = session.records.find(
      (record) => record.type === "message" && record.message.type === "user",
    );
    const history = await readSessionHistory({
      sessionDirectory,
      sessionId: member.sessionId,
      rootSessionId: session.sessionId,
    });
    expect(history.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "approval_decision",
          decisionSource: "auto_review",
          decision: "allowed",
          authorizationSessionId: session.sessionId,
          authorizationEntryIds: [actualUserEntry?.entryId],
        }),
      ]),
    );
    expect(await readFile(join(member.workspaceRoot, "shared.txt"), "utf8")).toBe(
      "root approved result",
    );
  }, 30_000);
  it.each(["agent", "full_access"] as const)(
    "applies changed root mode %s to retained writable members",
    async (nextMode) => {
      let approvalReviews = 0;
      let memberResponses = 0;
      const usage = {
        inputTokens: 80,
        outputTokens: 20,
        cachedInputTokens: null,
        cacheWriteInputTokens: null,
      };
      const { agent } = await setup(async function* (request) {
        if (request.purpose === "approval") {
          approvalReviews++;
          const message = request.messages[0];
          if (message?.role !== "user") throw new Error("missing review payload");
          const payload = JSON.parse(message.content) as {
            authorizationSources: Array<{ entryId: string }>;
          };
          yield {
            type: "text_delta",
            delta: JSON.stringify({
              decision: "allow",
              reason: "真实用户允许当前任务。",
              authorizationEntryIds: payload.authorizationSources.map((source) => source.entryId),
            }),
          };
          yield { type: "finish", finishReason: "stop", usage };
        } else if (memberResponses++ === 1) {
          yield {
            type: "tool_call",
            toolCallId: randomUUID(),
            toolName: "write_file",
            input: { path: "shared.txt", content: "second task result" },
            invalid: false,
          };
          yield { type: "finish", finishReason: "tool_calls", usage };
        } else {
          yield { type: "text_delta", delta: "done" };
          yield { type: "finish", finishReason: "stop", usage };
        }
      }, true);
      agent.setPermissionMode("auto_allow");
      const manualMemberApprovals: string[] = [];
      agent.subscribe((event) => {
        if (event.type === "tool_approval_requested") {
          if (event.request.memberSessionId)
            manualMemberApprovals.push(event.request.memberSessionId);
          agent.respondToToolApproval(event.request.toolApprovalRequestId, "approve");
        }
      });
      value(await agent.collaboration.execute({ action: "team_create", name: "Permissions" }));
      const member = JSON.parse(
        value(
          await agent.collaboration.execute({
            action: "team_add",
            task: "first task",
            writable: true,
          }),
        ),
      ) as MemberSummary;
      await wait(agent, member.sessionId);
      const previousReviews = approvalReviews;
      expect(agent.setPermissionMode(nextMode).status).toBe("accepted");
      value(
        await agent.collaboration.execute({
          action: "task_assign",
          memberId: member.sessionId,
          task: "second task",
        }),
      );
      await wait(agent, member.sessionId);
      expect(manualMemberApprovals).toEqual(nextMode === "agent" ? [member.sessionId] : []);
      expect(approvalReviews).toBe(previousReviews);
    },
    30_000,
  );
});
