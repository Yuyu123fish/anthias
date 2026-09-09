import { randomUUID } from "node:crypto";
import type { ModelStream } from "../model/model-stream.js";
import { createSessionArtifactStore } from "../session/artifacts.js";
import type { Session, SessionRunLease } from "../session/index.js";
import { locateSessionStorage } from "../session/locations.js";
import type { AgentEvent, PermissionMode } from "../session-agent.js";
import type { GitWorkspace } from "../tool/basetool/git/index.js";
import { isRecord } from "../tool/input-validation.js";
import { createAgentTeam, type TeamSummary, type TeamTask } from "./agent-team.js";
import {
  createMembers,
  type MemberFactory,
  type MemberSummary,
  type SpawnMemberInput,
  validateText,
} from "./members.js";

export type { MemberSummary, TeamSummary, TeamTask };
export type CollaborationSnapshot = Readonly<{
  rootSessionId?: string;
  notice?: string;
  members: readonly MemberSummary[];
  team: TeamSummary | null;
  tasks: readonly TeamTask[];
}>;

export type CollaborationAction =
  | Readonly<{ action: "spawn"; task: string; name?: string; writable?: boolean; ref?: string }>
  | Readonly<{ action: "list" }>
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
  | Readonly<{ action: "team_create"; name: string }>
  | Readonly<{ action: "team_close" }>
  | Readonly<{ action: "team_add"; task: string; name?: string; writable?: boolean; ref?: string }>
  | Readonly<{ action: "task_assign"; memberId: string; task: string }>
  | Readonly<{
      action: "task_update";
      taskId: string;
      status: "completed" | "blocked";
      result: string;
    }>
  | Readonly<{ action: "message"; memberId: string; content: string; messageId?: string }>;

type Delivery = Readonly<{
  messageId: string;
  rootSessionId: string;
  fromSessionId: string;
  toSessionId: string;
  kind: "message";
  content: string;
  status: "queued" | "delivered";
}>;

/** 协调层只持有同一根 Session 的成员、任务和队列，不复制单会话执行循环。 */
export function createMultiAgent(options: {
  root: Session;
  git: GitWorkspace;
  modelStream: ModelStream;
  createMember: MemberFactory;
  permissionMode(): PermissionMode;
  changed(snapshot: CollaborationSnapshot): void;
  memberEvent(member: MemberSummary, event: AgentEvent): void;
  abortRoot(source?: "parent" | "shutdown" | "task_deadline"): void;
}) {
  const team = createAgentTeam(options.root);
  const deliveries = new Map<string, Delivery>();
  let closed = false;
  let deadline = 0;
  let limitNotice: string | undefined;
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  let serialization: Promise<unknown> = Promise.resolve();
  const members = createMembers({
    root: options.root,
    git: options.git,
    createMember: options.createMember,
    permissionMode: options.permissionMode,
    changed: () => changed(),
    event: options.memberEvent,
    async assigned(member) {
      if (!member.teamId) return undefined;
      const task = await team.assign(member.sessionId, member.task);
      await team.update(task.id, "running");
      return task.id;
    },
    async finished(member) {
      if (member.taskId) {
        const task = team.task(member.taskId);
        if (
          task &&
          (task.status === "running" ||
            task.status === "pending" ||
            !["idle", "completed"].includes(member.status))
        ) {
          await team.update(
            task.id,
            member.status === "idle" || member.status === "completed" ? "completed" : "blocked",
            member.result || member.error || "",
          );
          changed();
        }
      }
    },
  });
  for (const record of options.root.records) {
    if (record.type !== "coordination" || record.kind !== "delivery" || !isRecord(record.payload))
      continue;
    const value = record.payload;
    if (
      typeof value.messageId === "string" &&
      value.rootSessionId === options.root.sessionId &&
      typeof value.fromSessionId === "string" &&
      typeof value.toSessionId === "string" &&
      typeof value.content === "string" &&
      value.kind === "message" &&
      (value.status === "queued" || value.status === "delivered")
    ) {
      deliveries.set(value.messageId, {
        messageId: value.messageId,
        rootSessionId: value.rootSessionId,
        fromSessionId: value.fromSessionId,
        toSessionId: value.toSessionId,
        content: value.content,
        kind: "message",
        status: value.status,
      });
    }
  }
  function snapshot(): CollaborationSnapshot {
    return {
      rootSessionId: options.root.sessionId,
      ...(limitNotice ? { notice: limitNotice } : {}),
      members: members.list(),
      ...team.snapshot(),
    };
  }
  function changed() {
    options.changed(snapshot());
  }
  function assertRoot(caller: string) {
    if (caller !== options.root.sessionId)
      throw new Error("成员不能创建 Agent、管理团队或分派其他成员任务。");
  }
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = serialization.then(operation);
    serialization = result.catch(() => undefined);
    return result;
  }
  function abort(source: "parent" | "shutdown" | "task_deadline" = "parent") {
    members.abort(source);
    options.abortRoot(source);
  }
  function beginTask() {
    if (members.busy()) return;
    limitNotice = undefined;
    deadline = Date.now() + 30 * 60_000;
    clearTimeout(budgetTimer);
    budgetTimer = setTimeout(() => {
      limitNotice = "整组运行已达到三十分钟上限，请明确新的任务后继续。";
      changed();
      abort("task_deadline");
    }, 30 * 60_000);
    budgetTimer.unref?.();
  }
  const modelStream: ModelStream = async function* (request, signal) {
    if (deadline === 0) beginTask();
    signal.throwIfAborted();
    if (closed) {
      abort("shutdown");
      throw new Error("Agent 已关闭。");
    }
    if (Date.now() >= deadline) {
      limitNotice = "整组运行时限已达到上限，请明确新的任务后继续。";
      changed();
      abort("task_deadline");
      throw new Error(limitNotice);
    }
    yield* options.modelStream(request, signal);
  };
  async function send(caller: string, action: Extract<CollaborationAction, { action: "message" }>) {
    validateText(action.content);
    const currentTeam = team.snapshot().team;
    const recipient =
      action.memberId === options.root.sessionId ? null : members.get(action.memberId);
    const sender = caller === options.root.sessionId ? null : members.get(caller);
    if (
      currentTeam?.status !== "active" ||
      (sender !== null && sender.teamId !== currentTeam.id) ||
      (recipient !== null && recipient.teamId !== currentTeam.id)
    )
      throw new Error("消息只允许在当前活动 Team 内发送。");
    if (recipient?.status === "closed") throw new Error("目标成员已释放，请先显式继续。");
    const id = action.messageId ?? randomUUID();
    const previous = deliveries.get(id);
    if (previous) {
      if (
        previous.fromSessionId !== caller ||
        previous.toSessionId !== action.memberId ||
        previous.content !== action.content
      )
        throw new Error("消息 ID 已绑定其他内容。");
      return previous;
    }
    if (
      [...deliveries.values()].filter(
        (delivery) => delivery.toSessionId === action.memberId && delivery.status === "queued",
      ).length >= 32
    )
      throw new Error("目标消息队列已满，请等待消费后重试。");
    const delivery: Delivery = {
      messageId: id,
      rootSessionId: options.root.sessionId,
      fromSessionId: caller,
      toSessionId: action.memberId,
      content: action.content,
      kind: "message",
      status: "queued",
    };
    await options.root.appendCoordination({ kind: "delivery", key: id, payload: delivery });
    deliveries.set(id, delivery);
    changed();
    return delivery;
  }
  async function drain(sessionId: string, lease: SessionRunLease, signal: AbortSignal) {
    for (const delivery of deliveries.values()) {
      if (delivery.toSessionId !== sessionId || delivery.status !== "queued") continue;
      signal.throwIfAborted();
      await lease.appendAgentInput({
        messageId: delivery.messageId,
        rootSessionId: delivery.rootSessionId,
        fromSessionId: delivery.fromSessionId,
        kind: delivery.kind,
        content: delivery.content,
      });
      const delivered: Delivery = { ...delivery, status: "delivered" };
      await options.root.appendCoordination({
        kind: "delivery",
        key: delivery.messageId,
        payload: delivered,
      });
      deliveries.set(delivery.messageId, delivered);
    }
  }
  async function readResult(
    caller: string,
    action: Extract<CollaborationAction, { action: "result" }>,
  ) {
    const member = members.get(action.memberId);
    // 根可检查自己的全部委派；成员只可读自身或同队已经交付的结果。
    if (caller !== options.root.sessionId && caller !== member.sessionId) {
      const sender = members.get(caller);
      if (!sender.teamId || sender.teamId !== member.teamId || !member.result)
        throw new Error("该结果没有向当前成员分享。");
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
  ): Promise<string> {
    signal.throwIfAborted();
    if (closed) throw new Error("协作运行时已关闭。");
    if (caller !== options.root.sessionId) members.get(caller);
    if (action.action === "list") {
      if (caller === options.root.sessionId) return JSON.stringify(snapshot());
      const member = members.get(caller);
      return JSON.stringify(
        member.teamId && member.teamId === team.snapshot().team?.id
          ? {
              rootSessionId: options.root.sessionId,
              members: members.list().filter((candidate) => candidate.teamId === member.teamId),
              ...team.snapshot(),
            }
          : { member },
      );
    }
    if (action.action === "result") return readResult(caller, action);
    if (action.action === "message")
      return JSON.stringify(await serialize(() => send(caller, action)));
    if (action.action === "task_update") {
      const task = team.task(action.taskId);
      if (!task || (caller !== options.root.sessionId && task.memberSessionId !== caller))
        throw new Error("不能更新其他成员的任务。");
      validateText(action.result);
      const updated = await serialize(() => team.update(task.id, action.status, action.result));
      changed();
      return JSON.stringify(updated);
    }
    assertRoot(caller);
    if (action.action === "wait") {
      if (!action.memberIds.length || action.memberIds.length > 3)
        throw new Error("等待需要一至三个成员 ID。");
      return JSON.stringify(
        await members.wait(
          action.memberIds,
          Math.max(1, Math.min(action.timeoutMs ?? 30_000, 60_000)),
          signal,
        ),
      );
    }
    if (action.action === "stop")
      return JSON.stringify(await members.stop(action.memberId, action.release));
    if (action.action === "spawn") return JSON.stringify(await members.spawn(action, signal));
    if (action.action === "resume") {
      const member = members.get(action.memberId);
      if (
        member.teamId &&
        (member.teamId !== team.snapshot().team?.id || team.snapshot().team?.status !== "active")
      )
        throw new Error("原 Team 已结束；请在新团队中分派任务，旧成员历史仍可查看。");
      if (member.taskId) await team.update(member.taskId, "running");
      try {
        return JSON.stringify(
          await members.resume(action.memberId, action.task, member.taskId, signal),
        );
      } catch (error) {
        if (member.taskId)
          await team.update(
            member.taskId,
            "blocked",
            error instanceof Error ? error.message : "任务未恢复。",
          );
        throw error;
      }
    }
    if (action.action === "team_create") {
      validateText(action.name);
      const result = await serialize(() => team.create(action.name));
      changed();
      return JSON.stringify(result);
    }
    if (action.action === "team_close") {
      const current = team.snapshot().team;
      if (current?.status !== "active") throw new Error("没有活动 Team。");
      for (const member of members.list().filter((candidate) => candidate.teamId === current.id))
        await members.stop(member.sessionId, true);
      for (const task of team.snapshot().tasks) {
        if (task.status === "pending" || task.status === "running")
          await team.update(task.id, "blocked", "团队已结束，未完成成果保留。");
      }
      const result = await serialize(() => team.close());
      changed();
      return JSON.stringify(result);
    }
    if (action.action === "team_add") {
      const current = team.snapshot().team;
      if (current?.status !== "active") throw new Error("请先创建 Team。");
      const details: SpawnMemberInput = { ...action, teamId: current.id };
      return JSON.stringify(await members.spawn(details, signal));
    }
    if (action.action === "task_assign") {
      const member = members.get(action.memberId);
      if (member.teamId !== team.snapshot().team?.id || team.snapshot().team?.status !== "active")
        throw new Error("成员不属于当前活动 Team。");
      validateText(action.task);
      const task = await serialize(() => team.assign(member.sessionId, action.task));
      try {
        await team.update(task.id, "running");
        const started = await members.resume(member.sessionId, action.task, task.id, signal);
        changed();
        return JSON.stringify({ task: team.task(task.id), member: started });
      } catch (error) {
        await team.update(
          task.id,
          "blocked",
          error instanceof Error ? error.message : "任务未启动。",
        );
        changed();
        throw error;
      }
    }
    throw new Error("未知协作操作。");
  }
  return {
    snapshot,
    modelStream,
    beginTask,
    remainingTaskTimeMs: () => (deadline === 0 ? 30 * 60_000 : Math.max(0, deadline - Date.now())),
    drain,
    execute,
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
        members
          .list()
          .some(
            (member) =>
              member.worktreeId === id &&
              (member.status === "preparing" || member.status === "running"),
          )
      )
        throw new Error("成员尚未停止，不能修改或移除它的 Git 工作区。");
    },
    abort: members.abort,
    async close() {
      closed = true;
      clearTimeout(budgetTimer);
      await members.close();
      await serialization;
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

/** 查询、等待和停止必须能作用于活动 Run；其余动作通过持久化 Tool Run 进入权限与取消协议。 */
export function isDirectCollaborationControl(action: CollaborationAction): boolean {
  return (
    action.action === "list" ||
    action.action === "result" ||
    action.action === "wait" ||
    action.action === "stop"
  );
}
