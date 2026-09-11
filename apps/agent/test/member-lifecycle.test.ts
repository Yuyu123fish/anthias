import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRequest, ModelStream } from "../src/model/model-stream.js";
import {
  createMembers,
  type MemberFactory,
  type MemberSummary,
} from "../src/multi-agent/members.js";
import { type AgentInputDetails, createSession, type Session } from "../src/session/index.js";
import { createSessionAgent } from "../src/session-agent.js";
import { createGitWorkspace } from "../src/tool/basetool/git/index.js";

const execute = promisify(execFile);
const fixtures: string[] = [];
const closeFixtures: Array<() => Promise<void>> = [];
const releaseGates: Array<() => void> = [];
const shell = {
  kind: "powershell" as const,
  executable: "pwsh",
  arguments: ["-NoProfile", "-Command"],
};
const signal = () => new AbortController().signal;

function gate() {
  const completion = Promise.withResolvers<void>();
  releaseGates.push(completion.resolve);
  return completion;
}

afterEach(async () => {
  for (const release of releaseGates.splice(0)) release();
  for (const close of closeFixtures.splice(0).reverse()) await close();
  for (const directory of fixtures.splice(0)) {
    if (relative(resolve(tmpdir()), resolve(directory)).startsWith(".."))
      throw new Error("Unexpected fixture path");
    await rm(directory, { recursive: true, force: true });
  }
});

async function setup(
  modelStream: ModelStream,
  options: {
    repository?: boolean;
    finished?: (summary: MemberSummary) => Promise<void>;
    started?: (summary: MemberSummary) => Promise<void>;
    sessionForAgent?: (session: Session) => Session;
  } = {},
) {
  const fixture = await mkdtemp(join(tmpdir(), "anthias-member-lifecycle-"));
  fixtures.push(fixture);
  const directory = join(fixture, "workspace");
  await mkdir(directory);
  if (options.repository) {
    for (const args of [
      ["init"],
      ["config", "user.name", "Fixture"],
      ["config", "user.email", "fixture@example.invalid"],
    ])
      await execute("git", args, { cwd: directory, windowsHide: true });
    await writeFile(join(directory, "shared.txt"), "baseline");
    await execute("git", ["add", "--", "shared.txt"], { cwd: directory, windowsHide: true });
    await execute("git", ["commit", "-m", "fixture baseline"], {
      cwd: directory,
      windowsHide: true,
    });
  }
  const root = await createSession({
    workspaceRoot: directory,
    sessionDirectory: join(fixture, "sessions"),
    shell,
  });
  const git = createGitWorkspace({
    workspaceRoot: root.workspaceRoot,
    rootSessionId: root.sessionId,
    worktreeDirectory: join(fixture, "worktrees"),
    readRecords: () => root.records.filter((record) => record.type === "coordination"),
    appendRecord: async (details) => {
      await root.appendCoordination(null, details);
    },
  });
  const factoryCalls: string[] = [];
  const factory: MemberFactory = (session, permissionMode, writable) => {
    factoryCalls.push(session.sessionId);
    return createSessionAgent({
      session: options.sessionForAgent?.(session) ?? session,
      permissionMode,
      writable,
      modelStream,
    });
  };
  const members = createMembers({
    root,
    git,
    createMember: factory,
    permissionMode: () => "agent",
    changed() {},
    event() {},
    assigned: async () => undefined,
    finished: options.finished ?? (async () => {}),
    ...(options.started ? { started: options.started } : {}),
  });
  closeFixtures.push(async () => {
    await members.close();
    await root.close();
  });
  return { members, root, git, directory, factory, factoryCalls };
}

const immediate: ModelStream = async function* () {
  yield { type: "text_delta", delta: "done" };
  yield { type: "finish", finishReason: "stop" };
};

async function settled(members: ReturnType<typeof createMembers>, id: string) {
  await vi.waitFor(() => expect(members.busy(id)).toBe(false), { timeout: 5000 });
}

function message(root: Session, content: string): AgentInputDetails {
  return {
    messageId: randomUUID(),
    rootSessionId: root.sessionId,
    fromSessionId: root.sessionId,
    kind: "message",
    content,
  };
}

function userText(request: ModelRequest) {
  return request.messages
    .filter((entry) => entry.role === "user")
    .map((entry) => entry.content)
    .join("\n");
}

describe("Persistent member lifecycle", () => {
  it("queues beyond nine executions and reuses idle sessions without reserving execution slots", async () => {
    const releaseModels = gate();
    let activeModels = 0;
    let peakModels = 0;
    const { members, root, factoryCalls, git } = await setup(
      async function* (_request, abortSignal) {
        activeModels += 1;
        peakModels = Math.max(peakModels, activeModels);
        try {
          await Promise.race([
            releaseModels.promise,
            new Promise<void>((resolveAbort) =>
              abortSignal.addEventListener("abort", () => resolveAbort(), { once: true }),
            ),
          ]);
          abortSignal.throwIfAborted();
          yield { type: "text_delta", delta: "done" };
          yield { type: "finish", finishReason: "stop" };
        } finally {
          activeModels -= 1;
        }
      },
    );
    const spawned = await Promise.all(
      Array.from({ length: 11 }, (_, index) => members.spawn({ task: `task ${index}` }, signal())),
    );
    await vi.waitFor(() => expect(activeModels).toBe(9), { timeout: 5000 });
    expect(members.list().filter((member) => member.status === "queued")).toHaveLength(2);
    expect(
      spawned.every((member) => member.workspaceRoot === root.workspaceRoot && member.writable),
    ).toBe(true);
    expect(git.listWorktrees()).toHaveLength(0);
    releaseModels.resolve();
    await vi.waitFor(() => expect(members.busy()).toBe(false), { timeout: 5000 });
    expect(
      members.list().every((member) => member.status === "idle" && member.kind === "teammate"),
    ).toBe(true);
    const first = spawned[0];
    if (!first) throw new Error("Missing member");
    await members.wake(first.sessionId, message(root, "continue in the same session"));
    await settled(members, first.sessionId);
    expect(factoryCalls).toHaveLength(11);
    expect(
      (await members.history(first.sessionId)).records.filter(
        (record) => record.type === "run_finished",
      ),
    ).toHaveLength(2);
    expect(peakModels).toBe(9);
  });

  it("keeps the last user stop effective while an earlier run is still being sealed", async () => {
    const resultReady = gate();
    const releaseResult = gate();
    let runs = 0;
    const { members, root } = await setup(
      async function* () {
        runs += 1;
        yield { type: "text_delta", delta: "finished" };
        yield { type: "finish", finishReason: "stop" };
      },
      {
        finished: async () => {
          resultReady.resolve();
          await releaseResult.promise;
        },
      },
    );
    const member = await members.spawn({ task: "original" }, signal());
    await resultReady.promise;
    const firstStop = members.stop(member.sessionId, false, "user");
    await expect(
      members.resume(member.sessionId, "root override", undefined, signal()),
    ).rejects.toThrow("只能由用户");
    await members.resume(member.sessionId, "resume during cleanup", undefined, signal(), "user");
    const lastStop = members.stop(member.sessionId, false, "user");
    await members.wake(member.sessionId, message(root, "cannot wake a paused member"));
    expect(members.get(member.sessionId)).toMatchObject({ status: "paused", pausedBy: "user" });
    releaseResult.resolve();
    await Promise.all([firstStop, lastStop]);
    await settled(members, member.sessionId);
    expect(runs).toBe(1);
    expect(members.get(member.sessionId)).toMatchObject({ status: "paused", pausedBy: "user" });
    await members.resume(
      member.sessionId,
      "explicit user continuation",
      undefined,
      signal(),
      "user",
    );
    await settled(members, member.sessionId);
    expect(runs).toBe(2);
  });

  it("retains resource ownership until approval cancellation and session close finish", async () => {
    const closeEntered = gate();
    const releaseClose = gate();
    let requests = 0;
    const { members, root, directory } = await setup(
      async function* () {
        requests += 1;
        if (requests === 1) {
          yield {
            type: "tool_call",
            toolCallId: randomUUID(),
            toolName: "write_file",
            input: { path: "should-not-exist.txt", content: "denied", expectedVersion: "missing" },
            invalid: false,
          };
          yield { type: "finish", finishReason: "tool_calls" };
        } else {
          yield { type: "text_delta", delta: "reopened" };
          yield { type: "finish", finishReason: "stop" };
        }
      },
      {
        sessionForAgent: (session) => ({
          ...session,
          get records() {
            return session.records;
          },
          get header() {
            return session.header;
          },
          async close() {
            closeEntered.resolve();
            await releaseClose.promise;
            await session.close();
          },
        }),
      },
    );
    const member = await members.spawn({ task: "prepare a write" }, signal());
    await vi.waitFor(
      () => expect(members.agent(member.sessionId)?.state.pendingToolApproval).toBeTruthy(),
      { timeout: 5000 },
    );
    const close = members.stop(member.sessionId, true);
    await closeEntered.promise;
    expect(members.get(member.sessionId).status).toBe("closing");
    expect(members.agent(member.sessionId)).not.toBeNull();
    await expect(members.wake(member.sessionId, message(root, "late message"))).rejects.toThrow(
      "关闭",
    );
    await expect(members.reopen(member.sessionId, signal())).rejects.toThrow("清理完成");
    releaseClose.resolve();
    await close;
    expect(members.get(member.sessionId).status).toBe("closed");
    expect(members.agent(member.sessionId)).toBeNull();
    await expect(readFile(join(directory, "should-not-exist.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await members.reopen(member.sessionId, signal());
    await members.wake(member.sessionId, message(root, "continue after explicit reopen"));
    await settled(members, member.sessionId);
    expect(members.get(member.sessionId).status).toBe("idle");
    expect(
      (await members.history(member.sessionId)).records.filter(
        (record) => record.type === "run_finished",
      ),
    ).toHaveLength(2);
  });

  it("cancels queued work, preserves its session, and gives an explicit task priority over a message", async () => {
    const requests: ModelRequest[] = [];
    const startedTasks: string[] = [];
    const { members, root, factoryCalls } = await setup(
      async function* (request) {
        requests.push(request);
        yield { type: "text_delta", delta: "done" };
        yield { type: "finish", finishReason: "stop" };
      },
      {
        started: async (member) => {
          startedTasks.push(member.task);
        },
      },
    );
    members.setSchedulingEnabled(false);
    const member = await members.spawn({ task: "not started" }, signal());
    const controller = new AbortController();
    const queuedTaskId = randomUUID();
    await members.resume(member.sessionId, "replacement task B", queuedTaskId, controller.signal);
    expect(members.get(member.sessionId)).toMatchObject({
      task: "replacement task B",
      taskId: queuedTaskId,
      status: "queued",
    });
    expect(startedTasks).toHaveLength(0);
    controller.abort();
    await settled(members, member.sessionId);
    expect(members.get(member.sessionId).status).toBe("paused");
    expect(
      (await members.history(member.sessionId)).records.filter(
        (record) => record.type === "run_finished",
      ),
    ).toHaveLength(0);
    expect(factoryCalls).toHaveLength(0);
    await members.resume(member.sessionId, undefined, undefined, signal());
    members.setSchedulingEnabled(true);
    await settled(members, member.sessionId);
    expect(startedTasks).toEqual(["replacement task B"]);
    const resumedRequest = requests[0];
    if (!resumedRequest) throw new Error("Missing resumed task request");
    expect(userText(resumedRequest)).toContain("replacement task B");
    expect(userText(resumedRequest)).not.toContain("not started");
    await members.stop(member.sessionId, true);
    await members.reopen(member.sessionId, signal());
    members.setSchedulingEnabled(true);
    await members.wake(member.sessionId, message(root, "first conversation"));
    await settled(members, member.sessionId);
    const ordinaryMessage = members.wake(member.sessionId, message(root, "ordinary message"));
    const formalTask = members.resume(
      member.sessionId,
      "formal root assignment",
      undefined,
      signal(),
    );
    expect(members.get(member.sessionId).status).toBe("queued");
    expect(requests).toHaveLength(2);
    await Promise.all([ordinaryMessage, formalTask]);
    await settled(members, member.sessionId);
    expect(requests).toHaveLength(3);
    const formalRequest = requests[2];
    if (!formalRequest) throw new Error("Missing formal task request");
    expect(userText(formalRequest)).toContain("formal root assignment");
    expect(userText(formalRequest)).not.toContain("ordinary message");
  });

  it("keeps a member closed when persisting its explicit reopen fails", async () => {
    const { members, root, git, factory } = await setup(immediate);
    const member = await members.spawn({ task: "already completed" }, signal());
    await settled(members, member.sessionId);
    await members.stop(member.sessionId, true);
    let rejectReopen = true;
    const failingRoot: Session = {
      ...root,
      get records() {
        return root.records;
      },
      get header() {
        return root.header;
      },
      async appendCoordination(runId, details) {
        if (
          rejectReopen &&
          details.kind === "member" &&
          typeof details.payload === "object" &&
          details.payload !== null &&
          !Array.isArray(details.payload) &&
          "status" in details.payload &&
          details.payload.status === "idle"
        ) {
          rejectReopen = false;
          throw new Error("Fixture persistence failure");
        }
        return root.appendCoordination(runId, details);
      },
    };
    const restored = createMembers({
      root: failingRoot,
      git,
      createMember: factory,
      permissionMode: () => "agent",
      changed() {},
      event() {},
      assigned: async () => undefined,
      finished: async () => {},
    });
    closeFixtures.push(async () => {
      await restored.close();
    });
    await expect(restored.reopen(member.sessionId, signal())).rejects.toThrow(
      "Fixture persistence failure",
    );
    expect(restored.get(member.sessionId).status).toBe("closed");
    expect(restored.agent(member.sessionId)).toBeNull();
    expect(restored.busy()).toBe(false);
    await expect(
      restored.wake(member.sessionId, message(root, "cannot bypass failed reopen")),
    ).rejects.toThrow("关闭");
    await restored.reopen(member.sessionId, signal());
    expect(restored.get(member.sessionId).status).toBe("idle");
  });
  it("normalizes legacy members and restores history without starting model execution", async () => {
    const { members, root, git, factory, factoryCalls } = await setup(immediate);
    const legacy = await createSession({
      workspaceRoot: root.workspaceRoot,
      sessionDirectory: root.sessionDirectory,
      shell,
      rootSessionId: root.sessionId,
      sessionKind: "subagent",
    });
    await legacy.close();
    await root.appendCoordination(null, {
      kind: "member",
      key: legacy.sessionId,
      payload: {
        sessionId: legacy.sessionId,
        name: "legacy",
        kind: "subagent",
        status: "completed",
        workspaceRoot: root.workspaceRoot,
        task: "old task",
        writable: false,
      },
    });
    const restored = createMembers({
      root,
      git,
      createMember: factory,
      permissionMode: () => "agent",
      changed() {},
      event() {},
      assigned: async () => undefined,
      finished: async () => {},
    });
    closeFixtures.push(async () => {
      await restored.close();
    });
    expect(restored.get(legacy.sessionId)).toMatchObject({
      kind: "teammate",
      status: "interrupted",
    });
    await restored.wake(legacy.sessionId, message(root, "late message after restart"));
    expect(factoryCalls).toHaveLength(0);
    await restored.resume(legacy.sessionId, undefined, undefined, signal(), "user");
    await settled(restored, legacy.sessionId);
    expect(restored.get(legacy.sessionId).status).toBe("idle");
    expect(members.list()).toHaveLength(0);
  });

  it("binds an existing managed worktree while retaining the original session header and root changes", async () => {
    const { members, root, git, directory } = await setup(immediate, { repository: true });
    const member = await members.spawn({ task: "work in shared root" }, signal());
    await settled(members, member.sessionId);
    await writeFile(join(directory, "shared.txt"), "uncommitted root changes");
    const worktree = await git.createWorktree({}, signal());
    await expect(members.bindWorkspace(member.sessionId, worktree.id, signal())).rejects.toThrow(
      "先停止",
    );
    await members.stop(member.sessionId);
    const bound = await members.bindWorkspace(member.sessionId, worktree.id, signal());
    expect(bound.workspaceRoot).toBe(worktree.path);
    expect(bound.workspaceNotice).toContain("未提交修改保留原地");
    expect((await members.history(member.sessionId)).header.workspaceRoot).toBe(root.workspaceRoot);
    expect(await readFile(join(directory, "shared.txt"), "utf8")).toBe("uncommitted root changes");
    expect(await readFile(join(worktree.path, "shared.txt"), "utf8")).toBe("baseline");
    await members.resume(member.sessionId, "continue in worktree", undefined, signal());
    await settled(members, member.sessionId);
    expect(members.agent(member.sessionId)?.state.workspaceRoot).toBe(worktree.path);
    const direct = await members.spawn(
      { task: "explicitly select a worktree", worktreeId: worktree.id },
      signal(),
    );
    await settled(members, direct.sessionId);
    expect(direct.workspaceRoot).toBe(worktree.path);
  }, 20_000);
});
