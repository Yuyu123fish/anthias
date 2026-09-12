import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import {
  type AgentInputDetails,
  createSession,
  openSession,
  type Session,
} from "../session/index.js";
import { readSessionHistory } from "../session/query.js";
import { areSameWorkspace } from "../session/schema.js";
import type { AgentEvent, PermissionMode, RunPhase, SessionAgent } from "../session-agent.js";
import type { GitWorkspace } from "../tool/basetool/git/index.js";
import { isRecord } from "../tool/input-validation.js";

export type MemberSummary = Readonly<{
  sessionId: string;
  name: string;
  kind: "subagent" | "teammate";
  status:
    | "queued"
    | "preparing"
    | "running"
    | "idle"
    | "paused"
    | "closing"
    | "completed"
    | "failed"
    | "aborted"
    | "interrupted"
    | "closed";
  workspaceRoot: string;
  writable: boolean;
  task: string;
  taskId?: string;
  teamId?: string;
  worktreeId?: string;
  workspaceNotice?: string;
  pausedBy?: "user" | "root";
  phase?: RunPhase;
  lastActivityAt?: string;
  result?: string;
  error?: string;
}>;

export type SpawnMemberInput = Readonly<{
  name?: string;
  task: string;
  writable?: boolean;
  ref?: string;
  worktreeId?: string;
  teamId?: string;
}>;

type PendingStart = {
  input: AgentInputDetails;
  taskId?: string;
  signal?: AbortSignal;
  cancel(): void;
};

type MemberExecution = {
  controller: AbortController;
  completion: Promise<void>;
};

type MemberOwnership = {
  summary: MemberSummary;
  session: Session | null;
  agent: SessionAgent | null;
  unsubscribe: (() => void) | null;
  revision: number;
  closeRequested: boolean;
  initialization: Promise<void> | null;
  initializationController: AbortController | null;
  execution: MemberExecution | null;
  pending: PendingStart | null;
  settlement: Promise<void> | null;
  release: Promise<void> | null;
};

export type MemberFactory = (
  session: Session,
  permissionMode: PermissionMode,
  writable: boolean,
) => SessionAgent;

/** 根持有成员的长期 Session；只有准备执行和活动 Run 占用九个成员执行位置。 */
export function createMembers(options: {
  root: Session;
  git: GitWorkspace;
  createMember: MemberFactory;
  permissionMode(): PermissionMode;
  changed(): void;
  event(member: MemberSummary, event: AgentEvent): void;
  assigned(member: MemberSummary): Promise<string | undefined>;
  started?(member: MemberSummary): Promise<void>;
  finished(member: MemberSummary): Promise<void>;
}) {
  const deliveredFaults = new Map<string, number>();
  const faultRevisions = new Map<string, number>();
  const members = new Map<string, MemberOwnership>();
  const waiters = new Set<() => void>();
  let closing = false;
  let schedulingEnabled = true;
  let schedulingRequested = false;
  let closeCompletion: Promise<void> | null = null;

  for (const record of options.root.records) {
    if (record.type !== "coordination" || record.kind !== "member" || !isRecord(record.payload))
      continue;
    const value = record.payload;
    if (
      typeof value.sessionId !== "string" ||
      value.sessionId !== record.key ||
      typeof value.name !== "string" ||
      (value.kind !== "subagent" && value.kind !== "teammate") ||
      typeof value.workspaceRoot !== "string" ||
      typeof value.task !== "string" ||
      typeof value.writable !== "boolean" ||
      ![
        "queued",
        "preparing",
        "running",
        "idle",
        "paused",
        "closing",
        "completed",
        "failed",
        "aborted",
        "interrupted",
        "closed",
      ].includes(String(value.status))
    )
      continue;
    const summary: MemberSummary = {
      sessionId: value.sessionId,
      name: value.name,
      kind: "teammate",
      // 恢复历史不恢复执行意图；未完成的关闭也不能冒充已经释放资源。
      status: value.status === "closed" || value.status === "paused" ? value.status : "interrupted",
      workspaceRoot: value.workspaceRoot,
      task: value.task,
      writable: value.writable,
      ...(typeof value.taskId === "string" ? { taskId: value.taskId } : {}),
      ...(typeof value.teamId === "string" ? { teamId: value.teamId } : {}),
      ...(typeof value.worktreeId === "string" ? { worktreeId: value.worktreeId } : {}),
      ...(typeof value.workspaceNotice === "string"
        ? { workspaceNotice: value.workspaceNotice }
        : {}),
      ...(value.pausedBy === "user" || value.pausedBy === "root"
        ? { pausedBy: value.pausedBy }
        : {}),
      ...(typeof value.lastActivityAt === "string" ? { lastActivityAt: value.lastActivityAt } : {}),
      ...(typeof value.result === "string" ? { result: value.result } : {}),
      ...(typeof value.error === "string" ? { error: value.error } : {}),
    };
    members.set(summary.sessionId, ownership(summary));
  }

  function ownership(summary: MemberSummary): MemberOwnership {
    return {
      summary,
      session: null,
      agent: null,
      unsubscribe: null,
      revision: 0,
      closeRequested: summary.status === "closed",
      initialization: null,
      initializationController: null,
      execution: null,
      pending: null,
      settlement: null,
      release: null,
    };
  }

  function notify() {
    if (members.size > 0) options.changed();
    for (const waiter of [...waiters]) waiter();
  }

  function save(member: MemberOwnership, summary: MemberSummary): Promise<void> {
    member.summary = { ...summary, lastActivityAt: new Date().toISOString() };
    // 先更新门闩可见的内存事实，再按调用顺序追加；迟到的落盘完成不回写旧状态。
    const recording = options.root.appendCoordination(null, {
      kind: "member",
      key: member.summary.sessionId,
      payload: member.summary,
    });
    notify();
    return recording.then(() => undefined);
  }

  function get(id: string) {
    const member = members.get(id);
    if (!member) throw new Error("成员不属于当前根 Session。");
    return member;
  }

  function assertOpen() {
    if (closing) throw new Error("协作运行时已关闭。");
  }

  function assertResumeAuthority(member: MemberOwnership, source: "user" | "root") {
    if (member.summary.pausedBy === "user" && source !== "user")
      throw new Error("用户暂停的成员只能由用户继续。");
  }

  function busy(id?: string): boolean {
    return (id ? [get(id)] : [...members.values()]).some(
      (member) =>
        member.execution !== null ||
        member.initialization !== null ||
        member.settlement !== null ||
        member.pending !== null,
    );
  }

  async function releaseAgent(member: MemberOwnership): Promise<void> {
    if (member.release) return member.release;
    const agent = member.agent;
    const session = member.session;
    const release = Promise.resolve().then(async () => {
      if (agent) await agent.close();
      else await session?.close();
      // 失败时保留所有权，调用者仍能看见未完成的关闭，不能提早开放 Session 重入。
      member.unsubscribe?.();
      member.unsubscribe = null;
      member.agent = null;
      member.session = null;
    });
    member.release = release;
    try {
      await release;
    } finally {
      if (member.release === release) member.release = null;
    }
  }

  function discardPending(member: MemberOwnership) {
    const pending = member.pending;
    member.pending = null;
    pending?.signal?.removeEventListener("abort", pending.cancel);
  }

  async function history(id: string) {
    get(id);
    return readSessionHistory({
      sessionDirectory: options.root.sessionDirectory,
      sessionId: id,
      rootSessionId: options.root.sessionId,
    });
  }

  async function checkWorkspace(summary: MemberSummary, signal: AbortSignal) {
    signal.throwIfAborted();
    const actualRoot = await realpath(summary.workspaceRoot);
    if (
      !areSameWorkspace(actualRoot, summary.workspaceRoot) ||
      !(await stat(actualRoot)).isDirectory()
    )
      throw new Error("成员 Workspace 目录或实际路径已变化。");
    if (summary.worktreeId) {
      const worktree = await options.git.inspectWorktree(summary.worktreeId, signal);
      if (
        worktree.status !== "ready" ||
        worktree.rootSessionId !== options.root.sessionId ||
        !areSameWorkspace(worktree.path, summary.workspaceRoot)
      )
        throw new Error("原 worktree 不可继续，请核对目录、分支及 Git 状态。");
    } else if (!areSameWorkspace(summary.workspaceRoot, options.root.workspaceRoot)) {
      throw new Error("成员 Workspace 不属于根工作区或受管工作树。");
    }
    signal.throwIfAborted();
  }

  async function openMemberSession(member: MemberOwnership, signal: AbortSignal) {
    if (member.session) return;
    await history(member.summary.sessionId);
    signal.throwIfAborted();
    member.session = await openSession({
      workspaceRoot: member.summary.workspaceRoot,
      sessionDirectory: options.root.sessionDirectory,
      shell: options.root.shell,
      sessionId: member.summary.sessionId,
      memberWorkspaceBinding: {
        rootSessionId: options.root.sessionId,
        workspaceRoot: member.summary.workspaceRoot,
      },
    });
    signal.throwIfAborted();
  }

  function attach(member: MemberOwnership) {
    if (member.agent) return member.agent;
    if (!member.session) throw new Error("成员 Session 尚未就绪。");
    const agent = options.createMember(
      member.session,
      options.permissionMode(),
      member.summary.writable,
    );
    member.agent = agent;
    member.unsubscribe = agent.subscribe((event) => {
      if (event.type === "run_phase_changed" && !member.closeRequested) {
        member.summary = {
          ...member.summary,
          phase: event.phase,
          lastActivityAt: new Date().toISOString(),
        };
        notify();
      }
      if (
        (event.type === "model_retry" &&
          event.phase === "waiting" &&
          event.diagnostic.category === "output_limit") ||
        (event.type === "tool_execution_end" &&
          (event.cleanupUncertain || event.result.content.includes("workspace_blocked")))
      ) {
        member.summary = {
          ...member.summary,
          error:
            event.type === "model_retry"
              ? "输出超限，重试 " + event.retryCount + "；需要缩小单次输出并检查预算。"
              : event.result.content.slice(0, 800),
        };
        faultRevisions.set(
          member.summary.sessionId,
          (faultRevisions.get(member.summary.sessionId) ?? 0) + 1,
        );
        notify();
      }
      options.event(member.summary, event);
    });
    return agent;
  }

  function requestScheduling() {
    if (schedulingRequested) return;
    schedulingRequested = true;
    queueMicrotask(() => {
      schedulingRequested = false;
      if (closing || !schedulingEnabled) return;
      let activeCount = [...members.values()].filter((member) => member.execution !== null).length;
      const ready = [...members.values()]
        .filter(
          (member) =>
            member.pending !== null &&
            member.execution === null &&
            member.initialization === null &&
            member.settlement === null &&
            !member.closeRequested &&
            !member.summary.pausedBy,
        )
        .sort(
          (left, right) =>
            Number(right.pending?.input.kind === "task") -
            Number(left.pending?.input.kind === "task"),
        );
      for (const member of ready) {
        if (activeCount >= 9) break;
        const pending = member.pending;
        if (!pending) continue;
        member.pending = null;
        // 同一微任务内先登记所有权再进入异步准备，并发唤醒不能穿过九个位置。
        start(member, pending);
        activeCount += 1;
      }
    });
  }

  function start(member: MemberOwnership, pending: PendingStart) {
    const revision = member.revision;
    const completion = Promise.withResolvers<void>();
    const execution: MemberExecution = {
      controller: new AbortController(),
      completion: completion.promise,
    };
    member.execution = execution;
    const abortAgent = () => {
      const reason = execution.controller.signal.reason;
      member.agent?.abort(
        reason === "task_deadline" || reason === "shutdown" || reason === "user"
          ? reason
          : "parent",
      );
    };
    execution.controller.signal.addEventListener("abort", abortAgent, { once: true });
    const checkCurrent = () => {
      pending.signal?.throwIfAborted();
      execution.controller.signal.throwIfAborted();
      if (closing || member.closeRequested || member.revision !== revision)
        throw new Error("成员启动已取消。");
    };
    void (async () => {
      let finishedSummary = member.summary;
      try {
        checkCurrent();
        await save(member, { ...member.summary, status: "preparing" });
        await checkWorkspace(member.summary, execution.controller.signal);
        checkCurrent();
        await openMemberSession(member, execution.controller.signal);
        checkCurrent();
        const agent = attach(member);
        const permissionResult = agent.setPermissionMode(options.permissionMode());
        if (permissionResult.status !== "accepted")
          throw new Error("成员权限暂时无法同步，请停止后重试。");
        await save(member, {
          ...member.summary,
          status: "running",
          ...(pending.input.kind === "task" ? { task: pending.input.content } : {}),
          ...(pending.taskId ? { taskId: pending.taskId } : {}),
          result: "",
          error: "",
        });
        checkCurrent();
        finishedSummary = member.summary;
        if (pending.input.kind === "task") await options.started?.(member.summary);
        checkCurrent();
        finishedSummary = member.summary;
        // 创建动作的取消只约束排队与准备；已启动 Run 由成员和群组共同持有。
        pending.signal?.removeEventListener("abort", pending.cancel);
        const result = await agent.promptInternal(pending.input);
        const assistantMessage = agent.state.messageHistory.findLast(
          (message) => message.role === "assistant",
        );
        const resultText =
          assistantMessage?.role === "assistant"
            ? assistantMessage.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("")
            : "";
        const { phase: _phase, ...withoutPhase } = finishedSummary;
        finishedSummary = {
          ...withoutPhase,
          status:
            result.status === "completed"
              ? "idle"
              : result.status === "aborted"
                ? "aborted"
                : "failed",
          result: truncateResult(resultText),
          ...(result.status === "failed"
            ? { error: result.error }
            : result.status === "rejected"
              ? { error: result.reason }
              : {}),
        };
        if (member.revision === revision && !member.closeRequested)
          await save(member, finishedSummary);
        await options.finished(finishedSummary);
      } catch (error) {
        if (member.revision === revision && !member.closeRequested) {
          const { phase: _phase, ...withoutPhase } = member.summary;
          const failedSummary: MemberSummary = {
            ...withoutPhase,
            status: execution.controller.signal.aborted ? "aborted" : "failed",
            error: error instanceof Error ? error.message : "成员执行失败。",
          };
          try {
            await save(member, failedSummary);
            await options.finished(failedSummary);
          } catch {
            member.summary = failedSummary;
          }
        } else {
          await options
            .finished({ ...finishedSummary, status: "aborted", error: "成员启动已取消。" })
            .catch(() => undefined);
        }
      } finally {
        pending.signal?.removeEventListener("abort", pending.cancel);
        execution.controller.signal.removeEventListener("abort", abortAgent);
        if (member.execution === execution) member.execution = null;
        completion.resolve();
        notify();
        requestScheduling();
      }
    })();
  }

  function input(content: string): AgentInputDetails {
    validateText(content);
    return {
      messageId: randomUUID(),
      rootSessionId: options.root.sessionId,
      fromSessionId: options.root.sessionId,
      kind: "task",
      content,
    };
  }

  async function enqueue(
    member: MemberOwnership,
    details: AgentInputDetails,
    signal?: AbortSignal,
    taskId?: string,
  ) {
    signal?.throwIfAborted();
    if (member.pending && details.kind !== "task") return member.summary;
    discardPending(member);
    const pending: PendingStart = {
      input: details,
      ...(taskId ? { taskId } : {}),
      ...(signal ? { signal } : {}),
      cancel: () => {
        void stop(member.summary.sessionId).catch(() => undefined);
      },
    };
    member.pending = pending;
    signal?.addEventListener("abort", pending.cancel, { once: true });
    await save(member, {
      ...member.summary,
      status: "queued",
      ...(details.kind === "task" ? { task: details.content, result: "", error: "" } : {}),
      ...(taskId ? { taskId } : {}),
    });
    if (signal?.aborted) pending.cancel();
    requestScheduling();
    return member.summary;
  }

  function stop(id: string, release = false, source: "user" | "root" = "root") {
    const member = get(id);
    const revision = ++member.revision;
    member.closeRequested ||= release;
    discardPending(member);
    const pausedBy = member.summary.pausedBy === "user" ? "user" : source;
    const status = member.closeRequested
      ? member.summary.status === "closed"
        ? "closed"
        : "closing"
      : "paused";
    const previousSettlement = member.settlement;
    // 门闩与取消同步生效；旧清理中的 resume 只排队，后续 stop 会删除这次排队。
    const recording = save(member, { ...member.summary, status, pausedBy });
    member.initializationController?.abort(source === "user" ? "user" : "parent");
    member.execution?.controller.abort(source === "user" ? "user" : "parent");
    member.agent?.abort(source === "user" ? "user" : "parent");
    const settlement = (async () => {
      await previousSettlement?.catch(() => undefined);
      await member.initialization?.catch(() => undefined);
      await member.execution?.completion;
      await recording;
      if (member.closeRequested) await releaseAgent(member);
      if (member.revision === revision) {
        const { phase: _phase, ...withoutPhase } = member.summary;
        await save(member, {
          ...withoutPhase,
          status: member.closeRequested ? "closed" : "paused",
        });
      }
    })();
    member.settlement = settlement;
    return settlement
      .finally(() => {
        if (member.settlement === settlement) member.settlement = null;
        notify();
        requestScheduling();
      })
      .then(() => member.summary);
  }

  async function resume(
    id: string,
    task: string | undefined,
    taskId: string | undefined,
    signal: AbortSignal,
    source: "user" | "root" = "root",
  ) {
    assertOpen();
    const member = get(id);
    assertResumeAuthority(member, source);
    if (member.closeRequested) throw new Error("成员已关闭或正在关闭，请显式重新打开。");
    if (member.initialization && !member.initializationController?.signal.aborted)
      throw new Error("成员正在准备，请等待完成后再继续。");
    if (member.execution && !member.execution.controller.signal.aborted)
      throw new Error("成员正在执行，请等待或停止后再分派任务。");
    const details = input(task ?? member.summary.task);
    signal.throwIfAborted();
    ++member.revision;
    const { pausedBy: _pausedBy, phase: _phase, ...resumedSummary } = member.summary;
    member.summary = resumedSummary;
    return enqueue(member, details, signal, taskId);
  }

  return {
    list: () => [...members.values()].map((member) => ({ ...member.summary })),
    get: (id: string) => get(id).summary,
    busy,
    agent: (id: string) => get(id).agent,
    history,
    async spawn(details: SpawnMemberInput, signal: AbortSignal) {
      assertOpen();
      validateText(details.task);
      signal.throwIfAborted();
      if (details.ref) throw new Error("成员不隐式创建工作树；请先创建受管工作树，再显式绑定。");
      const memberId = randomUUID();
      const member = ownership({
        sessionId: memberId,
        name: details.name?.trim() || "成员",
        kind: "teammate",
        status: "queued",
        workspaceRoot: options.root.workspaceRoot,
        writable: details.writable ?? true,
        task: details.task,
        ...(details.teamId ? { teamId: details.teamId } : {}),
      });
      members.set(memberId, member);
      const revision = member.revision;
      const controller = new AbortController();
      member.initializationController = controller;
      const cancel = () => controller.abort();
      signal.addEventListener("abort", cancel, { once: true });
      const initialization = (async () => {
        // Session 元数据先存在，排队成员即使从未运行也有可保留、可重开的真实历史。
        if (details.worktreeId) {
          const worktree = await options.git.inspectWorktree(details.worktreeId, controller.signal);
          if (worktree.status !== "ready" || worktree.rootSessionId !== options.root.sessionId)
            throw new Error("目标工作树不属于当前根 Session，或资源尚未就绪。");
          member.summary = {
            ...member.summary,
            workspaceRoot: worktree.path,
            worktreeId: worktree.id,
          };
        }
        member.session = await createSession({
          sessionId: memberId,
          rootSessionId: options.root.sessionId,
          sessionKind: "teammate",
          sessionDirectory: options.root.sessionDirectory,
          workspaceRoot: member.summary.workspaceRoot,
          shell: options.root.shell,
        });
        const taskId = await options.assigned(member.summary);
        await save(member, { ...member.summary, ...(taskId ? { taskId } : {}) });
        controller.signal.throwIfAborted();
      })();
      member.initialization = initialization;
      try {
        await initialization;
      } catch (error) {
        if (member.revision === revision && !member.closeRequested)
          await save(member, {
            ...member.summary,
            status: controller.signal.aborted ? "paused" : "failed",
            ...(controller.signal.aborted ? { pausedBy: "root" } : {}),
            error: error instanceof Error ? error.message : "成员创建失败。",
          });
        throw error;
      } finally {
        signal.removeEventListener("abort", cancel);
        if (member.initialization === initialization) {
          member.initialization = null;
          member.initializationController = null;
        }
      }
      if (closing || member.closeRequested || member.revision !== revision) return member.summary;
      return enqueue(member, input(details.task), signal, member.summary.taskId);
    },
    resume,
    async wake(id: string, details: AgentInputDetails, signal?: AbortSignal) {
      assertOpen();
      const member = get(id);
      validateText(details.content);
      if (details.rootSessionId !== options.root.sessionId)
        throw new Error("成员输入不属于当前根 Session。");
      if (details.kind === "task" && details.fromSessionId !== options.root.sessionId)
        throw new Error("只有根 Agent 可以提供正式任务。");
      if (member.closeRequested) throw new Error("成员已关闭或正在关闭，不能接收新输入。");
      if (
        member.summary.pausedBy ||
        member.summary.status === "interrupted" ||
        member.summary.status === "failed" ||
        member.summary.status === "aborted" ||
        !schedulingEnabled
      )
        return member.summary;
      if (member.execution || member.initialization || member.settlement) {
        if (member.summary.status === "running" && !member.execution?.controller.signal.aborted)
          member.agent?.queueInternal(details);
        return member.summary;
      }
      return enqueue(member, details, signal);
    },
    stop,
    async reopen(id: string, signal: AbortSignal, source: "user" | "root" = "root") {
      assertOpen();
      const member = get(id);
      assertResumeAuthority(member, source);
      if (member.summary.status !== "closed" || busy(id))
        throw new Error("只有清理完成的关闭成员可以重新打开。");
      const previous = member.summary;
      const revision = ++member.revision;
      const controller = new AbortController();
      member.initializationController = controller;
      const cancel = () => controller.abort();
      signal.addEventListener("abort", cancel, { once: true });
      const initialization = (async () => {
        signal.throwIfAborted();
        await checkWorkspace(member.summary, controller.signal);
        await openMemberSession(member, controller.signal);
        controller.signal.throwIfAborted();
        if (member.revision !== revision || closing) throw new Error("成员重开已取消。");
        member.closeRequested = false;
        const { pausedBy: _pausedBy, ...reopenedSummary } = member.summary;
        await save(member, { ...reopenedSummary, status: "idle" });
      })();
      member.initialization = initialization;
      try {
        await initialization;
      } catch (error) {
        if (member.revision === revision) member.closeRequested = true;
        try {
          await releaseAgent(member);
        } catch (closeError) {
          member.summary = {
            ...member.summary,
            status: "closing",
            error: "成员重开失败，资源仍未完整释放。",
          };
          throw closeError;
        }
        if (member.revision === revision) await save(member, previous);
        throw error;
      } finally {
        signal.removeEventListener("abort", cancel);
        if (member.initialization === initialization) {
          member.initialization = null;
          member.initializationController = null;
        }
        notify();
        requestScheduling();
      }
      return member.summary;
    },
    async bindWorkspace(id: string, worktreeId: string | undefined, signal: AbortSignal) {
      assertOpen();
      const member = get(id);
      if (busy(id) || !["paused", "interrupted", "closed"].includes(member.summary.status))
        throw new Error("请先停止成员并等待清理完成，再切换工作区。");
      const previous = member.summary;
      const revision = ++member.revision;
      const controller = new AbortController();
      member.initializationController = controller;
      const cancel = () => controller.abort();
      signal.addEventListener("abort", cancel, { once: true });
      let bindingSaved = false;
      const initialization = (async () => {
        signal.throwIfAborted();
        await checkWorkspace(previous, controller.signal);
        const target = worktreeId
          ? await options.git.inspectWorktree(worktreeId, controller.signal)
          : null;
        if (
          target &&
          (target.status !== "ready" || target.rootSessionId !== options.root.sessionId)
        )
          throw new Error("目标工作树不属于当前根 Session，或资源尚未就绪。");
        const workspaceRoot = target?.path ?? options.root.workspaceRoot;
        const { worktreeId: _worktreeId, workspaceNotice: _notice, ...withoutWorktree } = previous;
        const nextSummary: MemberSummary = {
          ...withoutWorktree,
          workspaceRoot,
          ...(worktreeId ? { worktreeId } : {}),
        };
        await checkWorkspace(nextSummary, controller.signal);
        let workspaceNotice = "工作区已切换；未复制文件、依赖、凭据或后台服务。";
        if (previous.worktreeId || worktreeId) {
          const originalStatus = await options.git.query(
            {
              action: "status",
              ...(previous.worktreeId ? { worktreeId: previous.worktreeId } : {}),
            },
            controller.signal,
          );
          if (originalStatus.split(/\r?\n/u).some((line) => line && !line.startsWith("##")))
            workspaceNotice = "原工作区的未提交修改保留原地；未复制文件、依赖、凭据或后台服务。";
          if (worktreeId)
            await options.git.query({ action: "status", worktreeId }, controller.signal);
        }
        controller.signal.throwIfAborted();
        await releaseAgent(member);
        controller.signal.throwIfAborted();
        if (member.revision !== revision) throw new Error("成员工作区绑定已取消。");
        bindingSaved = true;
        await save(member, { ...nextSummary, workspaceNotice });
        await openMemberSession(member, controller.signal);
        if (previous.status === "closed") await releaseAgent(member);
      })();
      member.initialization = initialization;
      try {
        await initialization;
      } catch (error) {
        await releaseAgent(member);
        if (bindingSaved) {
          const {
            workspaceRoot: _workspaceRoot,
            worktreeId: _worktreeId,
            workspaceNotice: _notice,
            ...current
          } = member.summary;
          await save(member, {
            ...current,
            workspaceRoot: previous.workspaceRoot,
            ...(previous.worktreeId ? { worktreeId: previous.worktreeId } : {}),
            ...(previous.workspaceNotice ? { workspaceNotice: previous.workspaceNotice } : {}),
          });
        }
        throw error;
      } finally {
        signal.removeEventListener("abort", cancel);
        if (member.initialization === initialization) {
          member.initialization = null;
          member.initializationController = null;
        }
        notify();
        requestScheduling();
      }
      return member.summary;
    },
    setSchedulingEnabled(enabled: boolean) {
      schedulingEnabled = enabled && !closing;
      if (schedulingEnabled) requestScheduling();
    },
    abort(source: "user" | "parent" | "shutdown" | "task_deadline" = "parent") {
      schedulingEnabled = false;
      for (const member of members.values()) {
        member.initializationController?.abort(source);
        member.execution?.controller.abort(source);
        member.agent?.abort(source === "user" ? "user" : source);
        void stop(member.summary.sessionId, false, source === "user" ? "user" : "root").catch(
          () => undefined,
        );
      }
      notify();
    },
    close() {
      if (closeCompletion) return closeCompletion;
      closing = true;
      schedulingEnabled = false;
      closeCompletion = Promise.allSettled(
        [...members.values()].map(async (member) => {
          const previous = member.summary;
          member.initializationController?.abort("shutdown");
          member.execution?.controller.abort("shutdown");
          member.agent?.abort("shutdown");
          const stopped = stop(member.summary.sessionId);
          const revision = member.revision;
          try {
            await stopped;
          } finally {
            await releaseAgent(member);
          }
          const { pausedBy: _pausedBy, phase: _phase, ...withoutRuntime } = member.summary;
          // 应用退出只交还资源，不把可继续的成员变为用户显式关闭的成员。
          const status = member.closeRequested
            ? "closed"
            : previous.status === "paused" ||
                (member.revision !== revision && member.summary.pausedBy === "user")
              ? "paused"
              : previous.status === "idle"
                ? "idle"
                : "interrupted";
          await save(member, {
            ...withoutRuntime,
            status,
            ...(status === "paused"
              ? { pausedBy: member.summary.pausedBy ?? previous.pausedBy ?? "root" }
              : {}),
          });
        }),
      ).then((results) => {
        if (results.some((result) => result.status === "rejected"))
          throw new Error("部分成员退出未能完整收口；历史和工作目录保留。");
      });
      return closeCompletion;
    },
    reportWorkspaceBlock(sessionId: string, error: string) {
      const member = members.get(sessionId);
      if (!member || member.summary.error === error) return;
      member.summary = { ...member.summary, error };
      faultRevisions.set(sessionId, (faultRevisions.get(sessionId) ?? 0) + 1);
      notify();
    },
    clearWorkspaceBlock(blockId: string) {
      for (const member of members.values()) {
        if (member.summary.error?.includes(blockId))
          member.summary = { ...member.summary, error: "" };
      }
      notify();
    },
    async wait(ids: readonly string[], timeoutMs: number, signal: AbortSignal) {
      const selected = ids.map(get);
      const snapshot = () =>
        selected.map((member) => {
          if (member.summary.error)
            deliveredFaults.set(
              member.summary.sessionId,
              faultRevisions.get(member.summary.sessionId) ?? 0,
            );
          return { ...member.summary };
        });
      const settled = () =>
        selected.some(
          (member) =>
            !busy(member.summary.sessionId) ||
            (Boolean(member.summary.error) &&
              deliveredFaults.get(member.summary.sessionId) !==
                (faultRevisions.get(member.summary.sessionId) ?? 0)),
        );
      if (settled()) return snapshot();
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          clearTimeout(timer);
          waiters.delete(changed);
          signal.removeEventListener("abort", aborted);
        };
        const changed = () => {
          if (settled()) {
            finish();
            resolve();
          }
        };
        const aborted = () => {
          finish();
          reject(new Error("等待已取消。"));
        };
        const timer = setTimeout(() => {
          finish();
          resolve();
        }, timeoutMs);
        waiters.add(changed);
        signal.addEventListener("abort", aborted, { once: true });
        changed();
        if (signal.aborted) aborted();
      });
      return snapshot();
    },
  };
}

export function validateText(text: string) {
  if (!text.trim() || Buffer.byteLength(text) > 16 * 1024)
    throw new Error("任务或消息必须为非空文本，且不超过 16 KiB。");
}

function truncateResult(text: string) {
  if (Buffer.byteLength(text) <= 16 * 1024) return text;
  return `${Buffer.from(text)
    .subarray(0, 15 * 1024)
    .toString("utf8")}\n[摘要已截断；完整结果保存在成员 Session 历史中。]`;
}
