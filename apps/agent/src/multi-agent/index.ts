import { randomUUID } from "node:crypto";
import type { ModelStream } from "../model/model-stream.js";
import type { AgentInputDetails, Session } from "../session/index.js";
import { locateSessionStorage } from "../session/locations.js";
import type { AgentEvent, PermissionMode } from "../session-agent.js";
import { createSessionArtifactStore } from "../tool/artifacts.js";
import type { GitWorkspace } from "../tool/basetool/git/index.js";
import type { WorkspaceAccess, WorkspaceBlock } from "../tool/workspace-access.js";
import { isPathSameOrInside } from "../tool/workspace-path.js";
import { createMailbox } from "./mailbox.js";
import { createMembers, type MemberFactory, type MemberSummary, validateText } from "./members.js";
import { createSharedNotes } from "./shared-notes.js";
import { createTasks, type TeamSummary, type TeamTask } from "./tasks.js";

export type { MemberSummary, TeamSummary, TeamTask };
export type CollaborationSnapshot = Readonly<{
  rootSessionId?: string;
  workspaceBlocks?: readonly WorkspaceBlock[];
  notice?: string;
  schedulingEnabled?: boolean;
  members: readonly MemberSummary[];
  team: TeamSummary | null;
  tasks: readonly TeamTask[];
}>;

export type CollaborationAction =
  | Readonly<{ action: "workspace_recover"; blockId: string; confirmCleanup?: boolean }>
  | Readonly<{
      action: "spawn" | "team_add";
      task: string;
      name?: string;
      writable?: boolean;
      worktreeId?: string;
      ref?: string;
    }>
  | Readonly<{ action: "list" | "group_continue" | "group_stop" | "team_close" | "notes_read" }>
  | Readonly<{ action: "wait"; memberIds: readonly string[]; timeoutMs?: number }>
  | Readonly<{ action: "stop"; memberId: string; release?: boolean }>
  | Readonly<{
      action: "result";
      memberId: string;
      offset?: number;
      artifactId?: string;
      cursor?: string;
    }>
  | Readonly<{ action: "resume"; memberId: string; task?: string }>
  | Readonly<{ action: "reopen"; memberId: string }>
  | Readonly<{ action: "workspace_bind"; memberId: string; worktreeId?: string }>
  | Readonly<{ action: "team_create"; name: string }>
  | Readonly<{ action: "task_assign"; memberId: string; task: string }>
  | Readonly<{
      action: "task_update";
      taskId: string;
      status: "completed" | "blocked";
      result: string;
    }>
  | Readonly<{ action: "message"; memberId: string; content: string; messageId?: string }>
  | Readonly<{ action: "notes_append"; content: string }>
  | Readonly<{ action: "notes_replace"; content: string; expectedVersion: string }>;

/** 根持有群组调度和权力；单 Session 执行器继续独占模型、输入安全点与 Run。 */
export function createMultiAgent(options: {
  root: Session;
  workspaceAccess?: WorkspaceAccess;
  git: GitWorkspace;
  modelStream: ModelStream;
  createMember: MemberFactory;
  permissionMode(): PermissionMode;
  changed(snapshot: CollaborationSnapshot): void;
  memberEvent(member: MemberSummary, event: AgentEvent): void;
  receiveRootInput(input: AgentInputDetails): void;
  abortRoot(source?: "user" | "parent" | "shutdown" | "task_deadline"): void;
}) {
  const tasks = createTasks(options.root);
  const mailbox = createMailbox(options.root);
  const notes = createSharedNotes(options.root);
  let closed = false;
  let taskState: "restored" | "active" | "paused" | "finished" = "restored";
  let pausedBy = tasks.snapshot().team.pausedBy;
  let deadline = 0;
  let limitNotice: string | undefined;
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  let serializedOperation: Promise<unknown> = Promise.resolve();
  const memberControlRevisions = new Map<string, number>();
  let groupControlRevision = 0;
  const wakingMembers = new Set<string>();
  let wakeScheduled = false;
  const members = createMembers({
    root: options.root,
    git: options.git,
    createMember: options.createMember,
    permissionMode: options.permissionMode,
    changed,
    event: options.memberEvent,
    async assigned(member) {
      const task = await tasks.assign(member.sessionId, member.task);
      return task.id;
    },
    async started(member) {
      if (member.taskId) await tasks.update(member.taskId, "running");
    },
    async finished(member) {
      if (member.taskId) {
        const task = tasks.task(member.taskId);
        if (task && (task.status === "running" || task.status === "pending"))
          await tasks.update(
            task.id,
            member.status === "idle" ? "completed" : "blocked",
            member.result || member.error || "",
          );
      }
      changed();
    },
  });
  members.setSchedulingEnabled(false);

  function workspaceBlocks() {
    const roots = [
      options.root.workspaceRoot,
      ...members.list().map((member) => member.workspaceRoot),
    ];
    return (
      options.workspaceAccess
        ?.snapshot()
        .filter((block) =>
          block.workspaceRoots.some((blockedRoot) =>
            roots.some(
              (root) =>
                isPathSameOrInside(root, blockedRoot) || isPathSameOrInside(blockedRoot, root),
            ),
          ),
        ) ?? []
    );
  }
  function compactMember(member: MemberSummary) {
    return {
      sessionId: member.sessionId,
      name: member.name,
      status: member.status,
      phase: member.phase,
      workspaceRoot: member.workspaceRoot,
      taskId: member.taskId,
      pausedBy: member.pausedBy,
      error: member.error,
      result: member.result?.slice(0, 1200),
    };
  }
  const unsubscribeWorkspace = options.workspaceAccess?.subscribe(() => {
    for (const block of workspaceBlocks())
      members.reportWorkspaceBlock(
        block.sessionId,
        "workspace_blocked: " + block.blockId + "; " + block.reason,
      );
    changed(true);
  });
  function snapshot(): CollaborationSnapshot {
    return {
      rootSessionId: options.root.sessionId,
      workspaceBlocks: workspaceBlocks(),
      ...(limitNotice ? { notice: limitNotice } : {}),
      schedulingEnabled: taskState === "active",
      members: members.list(),
      ...tasks.snapshot(),
    };
  }
  function changed(force = false) {
    if (force || members.list().length > 0 || workspaceBlocks().length > 0)
      options.changed(snapshot());
    if (!wakeScheduled && taskState === "active" && !closed) {
      wakeScheduled = true;
      queueMicrotask(() => {
        wakeScheduled = false;
        wakePendingMembers();
      });
    }
  }
  function wakePendingMembers() {
    if (closed || taskState !== "active") return;
    for (const member of members.list()) {
      if (
        member.status !== "idle" ||
        members.busy(member.sessionId) ||
        wakingMembers.has(member.sessionId)
      )
        continue;
      const input = mailbox.pendingInputs(member.sessionId)[0];
      if (!input) continue;
      wakingMembers.add(member.sessionId);
      void Promise.resolve(members.wake(member.sessionId, input))
        .catch((error: unknown) => {
          limitNotice = error instanceof Error ? error.message : "成员消息尚未执行。";
          options.changed(snapshot());
        })
        .finally(() => wakingMembers.delete(member.sessionId));
    }
  }
  async function recordUserTask(action: CollaborationAction, source: "root" | "user") {
    if (source !== "user") return;
    await options.root.appendCoordination(null, {
      kind: "user_request",
      key: randomUUID(),
      payload: { source: "user", content: "用户通过协作入口明确请求：" + JSON.stringify(action) },
    });
  }
  function cancelMemberContinuation(memberId: string) {
    memberControlRevisions.set(memberId, (memberControlRevisions.get(memberId) ?? 0) + 1);
  }
  function continuationGuard(memberId: string, signal: AbortSignal) {
    cancelMemberContinuation(memberId);
    const memberRevision = memberControlRevisions.get(memberId);
    const groupRevision = groupControlRevision;
    return () => {
      signal.throwIfAborted();
      if (
        closed ||
        groupRevision !== groupControlRevision ||
        memberRevision !== memberControlRevisions.get(memberId)
      )
        throw new Error("继续请求已被后来的停止或控制操作取消。");
    };
  }
  function assertRoot(caller: string) {
    if (caller !== options.root.sessionId) throw new Error("只有根 Agent 可以管理成员和分派任务。");
  }
  function serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const completion = serializedOperation.then(operation);
    serializedOperation = completion.catch(() => undefined);
    return completion;
  }
  function abort(source: "user" | "parent" | "shutdown" | "task_deadline" = "parent") {
    groupControlRevision += 1;
    if (source === "task_deadline" || (deadline !== 0 && Date.now() >= deadline))
      limitNotice = "整组运行时限已达到上限，请明确新的任务后继续。";
    taskState = "paused";
    pausedBy = pausedBy === "user" || source === "user" ? "user" : "root";
    if (members.list().length > 0 || pausedBy === "user")
      void serialize(() => tasks.pause(pausedBy ?? "root")).catch(() => undefined);
    members.setSchedulingEnabled(false);
    members.abort(source);
    changed();
  }
  function beginTask(source: "root" | "user" = "user") {
    if (closed) return;
    if (pausedBy === "user" && source !== "user") throw new Error("用户暂停的群组只能由用户继续。");
    pausedBy = undefined;
    // 消息与活动任务中的后续 Run 共享期限；只有明确的新任务或继续重新启动已结束的预算。
    if (taskState !== "active") {
      groupControlRevision += 1;
      if (!members.busy() || deadline === 0 || Date.now() >= deadline)
        deadline = Date.now() + 30 * 60_000;
      clearTimeout(budgetTimer);
      budgetTimer = setTimeout(
        () => {
          limitNotice = "整组运行已达到三十分钟上限，请明确新的任务后继续。";
          abort("task_deadline");
          options.abortRoot("task_deadline");
        },
        Math.max(0, deadline - Date.now()),
      );
      budgetTimer.unref?.();
    }
    taskState = "active";
    limitNotice = undefined;
    members.setSchedulingEnabled(true);
    if (members.list().length > 0)
      void serialize(() => tasks.activate()).catch(() => {
        limitNotice = "群组状态保存失败，已暂停调度。";
        abort();
      });
    changed();
  }
  function endTask() {
    if (closed || taskState !== "active") return;
    taskState = "finished";
    members.setSchedulingEnabled(false);
    if (tasks.snapshot().team.status === "active")
      void serialize(() => tasks.close()).catch(() => {
        limitNotice = "群组结束状态保存失败，历史保留。";
        changed();
      });
    changed();
  }
  const modelStream: ModelStream = async function* (request, signal) {
    signal.throwIfAborted();
    if (closed) throw new Error("Agent 已关闭。");
    if (deadline !== 0 && Date.now() >= deadline) {
      abort("task_deadline");
      options.abortRoot("task_deadline");
      limitNotice = "整组运行时限已达到上限，请明确新的任务后继续。";
      changed();
      throw new Error(limitNotice);
    }
    yield* options.modelStream(request, signal);
  };

  async function send(caller: string, action: Extract<CollaborationAction, { action: "message" }>) {
    validateText(action.content);
    const recipient =
      action.memberId === options.root.sessionId ? null : members.get(action.memberId);
    if (recipient && ["closing", "closed"].includes(recipient.status))
      throw new Error("目标成员已关闭，请根 Agent 显式重新打开。");
    const associatedTaskId =
      recipient?.taskId ??
      (caller !== options.root.sessionId ? members.get(caller).taskId : undefined);
    const delivery = await mailbox.send({
      fromSessionId: caller,
      toSessionId: action.memberId,
      ...(associatedTaskId ? { taskId: associatedTaskId } : {}),
      content: action.content,
      ...(action.messageId ? { messageId: action.messageId } : {}),
      retained: taskState === "finished",
    });
    if (delivery.status === "queued") {
      if (recipient === null && taskState === "active") options.receiveRootInput(delivery);
      else if (recipient !== null) members.agent(recipient.sessionId)?.queueInternal(delivery);
    }
    changed();
    return delivery;
  }
  async function acknowledgeInput(input: AgentInputDetails) {
    await mailbox.acknowledge(input);
    changed();
  }
  async function readResult(
    caller: string,
    action: Extract<CollaborationAction, { action: "result" }>,
  ) {
    const member = members.get(action.memberId);
    // 根可检查自己的全部委派；成员只可读自身或同队已经交付的结果。
    if (caller !== options.root.sessionId && caller !== member.sessionId) {
      members.get(caller);
      if (!member.result) throw new Error("该结果没有向当前成员分享。");
      if (action.artifactId || action.offset !== undefined)
        throw new Error("成员间只分享结果摘要，完整历史由根 Agent 查看。");
      return JSON.stringify({ memberSessionId: member.sessionId, result: member.result });
    }
    const saved = await members.history(member.sessionId);
    if (action.artifactId) {
      const reference = saved.messages.find(
        (message) => message.role === "tool" && message.artifact?.artifactId === action.artifactId,
      );
      if (reference?.role !== "tool" || !reference.artifact)
        throw new Error("产物未被该成员历史引用。");
      const location = await locateSessionStorage(options.root.sessionDirectory, member.sessionId);
      const artifactStore = createSessionArtifactStore({
        sessionId: member.sessionId,
        storageDirectory: location.storageDirectory,
      });
      try {
        artifactStore.registerReference(reference.artifact);
        return JSON.stringify(
          await artifactStore.readArtifact({
            artifactId: action.artifactId,
            ...(action.cursor ? { cursor: action.cursor } : {}),
            lineCount: 100,
          }),
        );
      } finally {
        await artifactStore.close();
      }
    }
    const offset = action.offset ?? 0;
    const text = saved.records
      .filter((record) => record.type === "message" || record.type === "agent_input")
      .map((record) => {
        if (record.type === "agent_input")
          return "[来源 " + record.fromSessionId + " / " + record.kind + "] " + record.content;
        if (record.type !== "message") return "";
        return JSON.stringify(record.message);
      })
      .join("\n");
    return JSON.stringify({
      memberSessionId: member.sessionId,
      workspaceRoot: member.workspaceRoot,
      worktreeId: member.worktreeId,
      status: member.status,
      result: member.result,
      history: text.slice(offset, offset + 12_000),
      nextOffset: offset + 12_000 < text.length ? offset + 12_000 : null,
      artifacts: saved.messages.flatMap((message) =>
        message.role === "tool" && message.artifact
          ? [{ sessionId: member.sessionId, ...message.artifact }]
          : [],
      ),
    });
  }

  async function execute(
    caller: string,
    action: CollaborationAction,
    signal: AbortSignal,
    source: "root" | "user" = "root",
  ): Promise<string> {
    signal.throwIfAborted();
    if (closed) throw new Error("协作运行时已关闭。");
    if (caller !== options.root.sessionId) {
      const member = members.get(caller);
      if (["closing", "closed"].includes(member.status)) throw new Error("当前成员已经关闭。");
    }
    if (action.action === "list") {
      const current = snapshot();
      return JSON.stringify({
        rootSessionId: current.rootSessionId,
        schedulingEnabled: current.schedulingEnabled,
        notice: current.notice,
        members: current.members.map(compactMember),
        workspaceBlocks: current.workspaceBlocks,
      });
    }
    if (action.action === "workspace_recover") {
      assertRoot(caller);
      if (action.confirmCleanup && source !== "user")
        throw new Error("外部清理确认只能由用户直接提交。");
      if (!workspaceBlocks().some((block) => block.blockId === action.blockId))
        throw new Error("阻塞不属于当前群组工作区，或已经解除。");
      if (!options.workspaceAccess) throw new Error("当前工作区未装配恢复入口。");
      const recovery = await options.workspaceAccess.recover(
        action.blockId,
        signal,
        action.confirmCleanup,
      );
      if (recovery.status === "recovered") members.clearWorkspaceBlock(action.blockId);
      return JSON.stringify(recovery);
    }
    if (action.action === "result") return readResult(caller, action);
    if (action.action === "message") return JSON.stringify(await send(caller, action));
    if (action.action === "notes_read") return JSON.stringify(await notes.read());
    if (action.action === "notes_append") {
      validateText(action.content);
      return JSON.stringify(await notes.append(caller, action.content, signal));
    }
    if (action.action === "notes_replace") {
      assertRoot(caller);
      if (Buffer.byteLength(action.content) > 256 * 1024) throw new Error("共享笔记最多 256 KiB。");
      return JSON.stringify(
        await notes.replace(caller, action.content, action.expectedVersion, signal),
      );
    }
    if (action.action === "task_update") {
      const task = tasks.task(action.taskId);
      if (!task || (caller !== options.root.sessionId && task.memberSessionId !== caller))
        throw new Error("不能更新其他成员的任务。");
      validateText(action.result);
      const result = await serialize(() => tasks.update(task.id, action.status, action.result));
      changed();
      return JSON.stringify(result);
    }
    assertRoot(caller);
    if (
      pausedBy === "user" &&
      source !== "user" &&
      !["wait", "stop", "group_stop", "team_close"].includes(action.action)
    )
      throw new Error("用户暂停的群组只能由用户继续。");
    if (action.action === "wait") {
      if (!action.memberIds.length || action.memberIds.length > 9)
        throw new Error("等待需要一至九个成员 ID。");
      return JSON.stringify(
        (
          await members.wait(
            action.memberIds,
            Math.max(1, Math.min(action.timeoutMs ?? 30_000, 60_000)),
            signal,
          )
        ).map(compactMember),
      );
    }
    if (action.action === "stop") {
      cancelMemberContinuation(action.memberId);
      return JSON.stringify(await members.stop(action.memberId, action.release, source));
    }
    if (action.action === "group_stop" || action.action === "team_close") {
      const stopRevision = ++groupControlRevision;
      taskState = "paused";
      pausedBy = pausedBy === "user" || source === "user" ? "user" : "root";
      members.setSchedulingEnabled(false);
      if (source === "user") options.abortRoot("user");
      await Promise.all(
        members
          .list()
          .filter((member) => member.status !== "closed")
          .map((member) => members.stop(member.sessionId, false, source)),
      );
      if (groupControlRevision === stopRevision)
        await serialize(() => tasks.pause(pausedBy ?? "root"));
      changed();
      return JSON.stringify(snapshot());
    }
    if (action.action === "group_continue") {
      beginTask(source);
      const continuationRevision = ++groupControlRevision;
      const selectedMembers = members
        .list()
        .map((member) => ({ member, revision: memberControlRevisions.get(member.sessionId) }));
      for (const { member, revision } of selectedMembers) {
        signal.throwIfAborted();
        if (closed || groupControlRevision !== continuationRevision)
          throw new Error("群组继续已被后来的停止取消。");
        if (revision !== memberControlRevisions.get(member.sessionId)) continue;
        if (
          ["paused", "interrupted"].includes(member.status) &&
          (source === "user" || member.pausedBy !== "user")
        )
          await members.resume(member.sessionId, undefined, member.taskId, signal, source);
      }
      for (const input of mailbox.pendingInputs(options.root.sessionId))
        options.receiveRootInput(input);
      return JSON.stringify(snapshot());
    }
    if (action.action === "team_create") {
      validateText(action.name);
      beginTask(source);
      const group = await serialize(() => tasks.activate(action.name));
      changed();
      return JSON.stringify(group);
    }
    if (action.action === "workspace_bind")
      return JSON.stringify(
        await members.bindWorkspace(action.memberId, action.worktreeId, signal),
      );
    if (action.action === "reopen") {
      beginTask(source);
      const result = await members.reopen(action.memberId, signal, source);
      changed();
      return JSON.stringify(result);
    }
    if (action.action === "spawn" || action.action === "team_add") {
      beginTask(source);
      const spawnRevision = groupControlRevision;
      await recordUserTask(action, source);
      await serialize(() => tasks.activate());
      signal.throwIfAborted();
      if (closed || groupControlRevision !== spawnRevision)
        throw new Error("成员创建已被后来的群组停止取消。");
      if (action.ref && !action.worktreeId)
        throw new Error("请先显式创建受管工作树，再用 worktreeId 绑定成员。");
      return JSON.stringify(
        await members.spawn({ ...action, teamId: options.root.sessionId }, signal),
      );
    }
    if (action.action === "resume" || action.action === "task_assign") {
      const member = members.get(action.memberId);
      if (member.pausedBy === "user" && source !== "user")
        throw new Error("用户暂停的成员只能由用户继续。");
      if (member.status === "closed") throw new Error("成员已关闭，请显式重新打开。");
      beginTask(source);
      const checkContinuation = continuationGuard(action.memberId, signal);
      const description = action.task ?? member.task;
      validateText(description);
      await recordUserTask(action, source);
      checkContinuation();
      const task = await serialize(() => tasks.assign(member.sessionId, description));
      try {
        checkContinuation();
        const result = await members.resume(member.sessionId, description, task.id, signal, source);
        checkContinuation();
        changed();
        return JSON.stringify(
          action.action === "task_assign" ? { task: tasks.task(task.id), member: result } : result,
        );
      } catch (error) {
        await tasks.update(
          task.id,
          "blocked",
          error instanceof Error ? error.message : "任务未启动。",
        );
        throw error;
      }
    }
    throw new Error("未知协作操作。");
  }
  return {
    snapshot,
    modelStream,
    beginTask,
    endTask,
    execute,
    acknowledgeInput,
    pendingInputs: mailbox.pendingInputs,
    schedulingEnabled: () => taskState === "active",
    remainingTaskTimeMs: () => (deadline === 0 ? 30 * 60_000 : Math.max(0, deadline - Date.now())),
    busy: members.busy,
    member: members.get,
    respondToToolApproval(id: string, decision: "approve" | "deny") {
      for (const member of members.list()) {
        const agent = members.agent(member.sessionId);
        if (agent?.state.pendingToolApproval?.toolApprovalRequestId === id)
          return agent.respondToToolApproval(id, decision);
      }
      return { status: "rejected" as const, reason: "not_pending" as const };
    },
    assertWorktreeIdle(id: string) {
      if (
        members.list().some((member) => member.worktreeId === id && members.busy(member.sessionId))
      )
        throw new Error("成员尚未停止，不能修改或移除它的 Git 工作区。");
    },
    abort,
    async close() {
      closed = true;
      unsubscribeWorkspace?.();
      groupControlRevision += 1;
      members.setSchedulingEnabled(false);
      clearTimeout(budgetTimer);
      await members.close();
      await Promise.all([serializedOperation, mailbox.settle(), notes.settle()]);
    },
  };
}

export type MultiAgent = ReturnType<typeof createMultiAgent>;
export type CollaborationControls = Readonly<{
  snapshot(): CollaborationSnapshot;
  execute(
    action: CollaborationAction,
  ): Promise<Readonly<{ ok: true; value: string } | { ok: false; error: string }>>;
}>;
