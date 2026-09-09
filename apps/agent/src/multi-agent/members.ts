import { randomUUID } from "node:crypto";
import {
  type AgentInputDetails,
  createSession,
  openSession,
  type Session,
} from "../session/index.js";
import { readSessionHistory } from "../session/query.js";
import type { AgentEvent, PermissionMode, PromptResult, SessionAgent } from "../session-agent.js";
import type { GitWorkspace } from "../tool/basetool/git/index.js";
import { isRecord } from "../tool/input-validation.js";

export type MemberSummary = Readonly<{
  sessionId: string;
  name: string;
  kind: "subagent" | "teammate";
  status:
    | "preparing"
    | "running"
    | "idle"
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
  result?: string;
  error?: string;
}>;

export type SpawnMemberInput = Readonly<{
  name?: string;
  task: string;
  writable?: boolean;
  ref?: string;
  teamId?: string;
}>;

type MemberOwnership = {
  summary: MemberSummary;
  agent: SessionAgent | null;
  controller: AbortController;
  completion: Promise<void> | null;
  unsubscribe: (() => void) | null;
};

export type MemberFactory = (session: Session, permissionMode: PermissionMode) => SessionAgent;

/** 根会话持有全部成员资源；恢复只恢复摘要，显式继续才创建执行者。 */
export function createMembers(options: {
  root: Session;
  git: GitWorkspace;
  createMember: MemberFactory;
  permissionMode(): PermissionMode;
  changed(): void;
  event(member: MemberSummary, event: AgentEvent): void;
  assigned(member: MemberSummary): Promise<string | undefined>;
  finished(member: MemberSummary): Promise<void>;
}) {
  const members = new Map<string, MemberOwnership>();
  const waiters = new Set<() => void>();
  let closing = false;
  for (const record of options.root.records) {
    if (record.type !== "coordination" || record.kind !== "member" || !isRecord(record.payload))
      continue;
    const value = record.payload;
    if (
      typeof value.sessionId !== "string" ||
      typeof value.name !== "string" ||
      (value.kind !== "subagent" && value.kind !== "teammate") ||
      typeof value.workspaceRoot !== "string" ||
      typeof value.task !== "string" ||
      typeof value.writable !== "boolean"
    )
      continue;
    if (
      ![
        "preparing",
        "running",
        "idle",
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
      kind: value.kind,
      status:
        value.status === "running" || value.status === "preparing" || value.status === "idle"
          ? "interrupted"
          : (value.status as MemberSummary["status"]),
      workspaceRoot: value.workspaceRoot,
      task: value.task,
      writable: value.writable,
      ...(typeof value.taskId === "string" ? { taskId: value.taskId } : {}),
      ...(typeof value.teamId === "string" ? { teamId: value.teamId } : {}),
      ...(typeof value.worktreeId === "string" ? { worktreeId: value.worktreeId } : {}),
      ...(typeof value.result === "string" ? { result: value.result } : {}),
      ...(typeof value.error === "string" ? { error: value.error } : {}),
    };
    members.set(summary.sessionId, {
      summary,
      agent: null,
      controller: new AbortController(),
      completion: null,
      unsubscribe: null,
    });
  }
  function notify() {
    if (members.size > 0) options.changed();
    for (const waiter of [...waiters]) waiter();
  }
  async function save(member: MemberOwnership, summary: MemberSummary) {
    await options.root.appendCoordination({
      kind: "member",
      key: summary.sessionId,
      payload: summary,
    });
    member.summary = summary;
    notify();
  }
  function get(id: string) {
    const member = members.get(id);
    if (!member) throw new Error("成员不属于当前根 Session。");
    return member;
  }
  function activeCount() {
    return [...members.values()].filter(
      (member) =>
        member.summary.status === "preparing" ||
        member.summary.status === "running" ||
        member.agent !== null,
    ).length;
  }
  async function releaseAgent(member: MemberOwnership) {
    const agent = member.agent;
    member.agent = null;
    try {
      await agent?.close();
    } finally {
      member.unsubscribe?.();
      member.unsubscribe = null;
    }
  }
  function attach(member: MemberOwnership, session: Session) {
    const mode = member.summary.writable ? options.permissionMode() : "plan";
    member.agent = options.createMember(session, mode);
    member.unsubscribe = member.agent.subscribe((event) => options.event(member.summary, event));
    member.controller.signal.addEventListener(
      "abort",
      () =>
        member.agent?.abort(
          member.controller.signal.reason === "task_deadline"
            ? "task_deadline"
            : member.controller.signal.reason === "shutdown"
              ? "shutdown"
              : "parent",
        ),
      { once: true },
    );
  }
  function start(member: MemberOwnership, input: AgentInputDetails) {
    const agent = member.agent;
    const completion = (async () => {
      let result: PromptResult;
      try {
        member.controller.signal.throwIfAborted();
        if (!agent) throw new Error("成员执行者尚未就绪。");
        result = await agent.promptInternal(input);
      } catch (error) {
        result = member.controller.signal.aborted
          ? { status: "aborted" }
          : { status: "failed", error: error instanceof Error ? error.message : "成员执行失败。" };
      }
      const assistantMessage = agent?.state.messageHistory.findLast(
        (message) => message.role === "assistant",
      );
      const fullResult =
        assistantMessage?.role === "assistant"
          ? assistantMessage.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("")
          : "";
      const resultText = truncateResult(fullResult);
      const status: MemberSummary["status"] =
        result.status === "completed"
          ? member.summary.kind === "teammate"
            ? "idle"
            : "completed"
          : result.status === "aborted"
            ? "aborted"
            : "failed";
      try {
        await save(member, {
          ...member.summary,
          status,
          result: resultText,
          ...(result.status === "failed"
            ? { error: result.error }
            : result.status === "rejected"
              ? { error: result.reason }
              : {}),
        });
        await options.finished(member.summary);
      } catch (error) {
        member.summary = {
          ...member.summary,
          status: "failed",
          error: error instanceof Error ? error.message : "成员结果保存失败。",
        };
        notify();
      } finally {
        if (member.summary.kind === "subagent" || closing) await releaseAgent(member);
      }
    })();
    member.completion = completion;
    void completion
      .finally(() => {
        if (member.completion === completion) member.completion = null;
        notify();
      })
      .catch(() => undefined);
  }
  function input(content: string, kind: AgentInputDetails["kind"] = "task"): AgentInputDetails {
    validateText(content);
    return {
      messageId: randomUUID(),
      rootSessionId: options.root.sessionId,
      fromSessionId: options.root.sessionId,
      kind,
      content,
    };
  }
  async function history(id: string) {
    get(id);
    return readSessionHistory({
      sessionDirectory: options.root.sessionDirectory,
      sessionId: id,
      rootSessionId: options.root.sessionId,
    });
  }
  return {
    list: () => [...members.values()].map((member) => ({ ...member.summary })),
    get: (id: string) => get(id).summary,
    busy: () =>
      [...members.values()].some(
        (member) =>
          member.completion !== null ||
          member.summary.status === "preparing" ||
          member.summary.status === "running",
      ),
    agent: (id: string) => get(id).agent,
    history,
    async spawn(details: SpawnMemberInput, signal: AbortSignal) {
      if (closing) throw new Error("协作运行时已关闭。");
      validateText(details.task);
      if (activeCount() >= 3) throw new Error("最多保留三个成员执行者，请释放空闲成员后重试。");
      if (details.writable && options.permissionMode() === "plan")
        throw new Error("Plan 模式不能创建可写成员。");
      const memberId = randomUUID();
      const member: MemberOwnership = {
        summary: {
          sessionId: memberId,
          name: details.name?.trim() || "成员",
          // 没有 Team 时是 subagent，否则是 teammate
          kind: details.teamId ? "teammate" : "subagent",
          status: "preparing",
          workspaceRoot: options.root.workspaceRoot,
          writable: details.writable ?? false,
          task: details.task,
          ...(details.teamId ? { teamId: details.teamId } : {}),
        },
        agent: null,
        controller: new AbortController(),
        completion: null,
        unsubscribe: null,
      };
      // 先占名额再 await，两个并发委派不能同时越过上限。
      members.set(memberId, member);
      const cancel = () => member.controller.abort();
      signal.addEventListener("abort", cancel, { once: true });
      const preparation = (async () => {
        try {
          signal.throwIfAborted();
          await save(member, member.summary);
          if (member.summary.writable) {
            // 创建可写成员时，创建 worktree
            const worktree = await options.git.createWorktree(
              { memberSessionId: memberId, ...(details.ref ? { ref: details.ref } : {}) },
              member.controller.signal,
            );
            await save(member, {
              ...member.summary,
              workspaceRoot: worktree.path,
              worktreeId: worktree.id,
            });
          }
          member.controller.signal.throwIfAborted();
          const session = await createSession({
            sessionId: memberId,
            rootSessionId: options.root.sessionId,
            sessionKind: member.summary.kind,
            sessionDirectory: options.root.sessionDirectory,
            workspaceRoot: member.summary.workspaceRoot,
            shell: options.root.shell,
          });
          try {
            member.controller.signal.throwIfAborted();
            attach(member, session);
            const taskId = await options.assigned(member.summary);
            await save(member, {
              ...member.summary,
              status: "running",
              ...(taskId ? { taskId } : {}),
            });
          } catch (error) {
            await session.close();
            throw error;
          }
        } catch (error) {
          await releaseAgent(member);
          await save(member, {
            ...member.summary,
            status: member.controller.signal.aborted ? "aborted" : "failed",
            error: error instanceof Error ? error.message : "成员创建失败。",
          });
          throw error;
        } finally {
          signal.removeEventListener("abort", cancel);
        }
      })();
      member.completion = preparation;
      try {
        await preparation;
      } finally {
        if (member.completion === preparation) member.completion = null;
      }
      start(member, input(details.task));
      return member.summary;
    },
    async resume(
      id: string,
      task: string | undefined,
      taskId: string | undefined,
      signal: AbortSignal,
    ) {
      if (closing) throw new Error("协作运行时已关闭。");
      const member = get(id);
      if (member.completion !== null) throw new Error("成员正在执行，请等待或停止后再分派任务。");
      validateText(task ?? member.summary.task);
      if (member.summary.writable && options.permissionMode() === "plan")
        throw new Error("Plan 模式不能继续可写成员。");
      if (!member.agent && activeCount() >= 3) throw new Error("成员名额已满。");
      const previous = member.summary;
      member.summary = { ...previous, status: "preparing" };
      member.controller = new AbortController();
      const cancel = () => member.controller.abort();
      signal.addEventListener("abort", cancel, { once: true });
      // 恢复的异步准备也属于成员所有权，关闭必须等待它完成，不能漏掉稍后打开的 Session。
      const preparation = (async () => {
        try {
          signal.throwIfAborted();
          if (member.summary.worktreeId) {
            const worktree = await options.git.inspectWorktree(
              member.summary.worktreeId,
              member.controller.signal,
            );
            if (worktree.status !== "ready" || worktree.path !== member.summary.workspaceRoot)
              throw new Error("原 worktree 不可继续，请核对目录、分支及 Git 状态。");
          }
          member.controller.signal.throwIfAborted();
          if (!member.agent) {
            const saved = await history(id);
            if (saved.header.workspaceRoot !== member.summary.workspaceRoot)
              throw new Error("成员历史的 Workspace 已变化。");
            const session = await openSession({
              workspaceRoot: member.summary.workspaceRoot,
              sessionDirectory: options.root.sessionDirectory,
              shell: options.root.shell,
              sessionId: id,
            });
            try {
              member.controller.signal.throwIfAborted();
              attach(member, session);
            } catch (error) {
              await session.close();
              throw error;
            }
          }
          const memberAgent = member.agent;
          if (!memberAgent) throw new Error("成员执行者尚未就绪。");
          const permissionResult = memberAgent.setPermissionMode(
            member.summary.writable ? options.permissionMode() : "plan",
          );
          if (permissionResult.status !== "accepted")
            throw new Error("成员权限暂时无法同步，请停止后重试。");
          await save(member, {
            ...member.summary,
            status: "running",
            task: task ?? previous.task,
            ...(taskId ? { taskId } : {}),
            result: "",
            error: "",
          });
          member.controller.signal.throwIfAborted();
        } catch (error) {
          await releaseAgent(member);
          await save(member, {
            ...previous,
            status: member.controller.signal.aborted ? "aborted" : "interrupted",
            error: error instanceof Error ? error.message : "成员恢复失败。",
          });
          throw error;
        } finally {
          signal.removeEventListener("abort", cancel);
        }
      })();
      member.completion = preparation;
      try {
        await preparation;
      } finally {
        if (member.completion === preparation) member.completion = null;
      }
      start(member, input(task ?? previous.task));
      return member.summary;
    },
    async stop(id: string, release = false) {
      const member = get(id);
      member.controller.abort();
      member.agent?.abort();
      await member.completion?.catch(() => undefined);
      if (release) {
        await releaseAgent(member);
        await save(member, { ...member.summary, status: "closed" });
      }
      return member.summary;
    },
    abort(source: "parent" | "shutdown" | "task_deadline" = "parent") {
      for (const member of members.values()) {
        member.controller.abort(source);
        member.agent?.abort(source);
      }
      notify();
    },
    async close() {
      closing = true;
      for (const member of members.values()) {
        member.controller.abort("shutdown");
        member.agent?.abort("shutdown");
      }
      const results = await Promise.allSettled(
        [...members.values()].map(async (member) => {
          try {
            await member.completion?.catch(() => undefined);
          } finally {
            await releaseAgent(member);
          }
        }),
      );
      notify();
      if (results.some((result) => result.status === "rejected"))
        throw new Error("部分成员退出未能完整收口；历史和工作目录保留。");
    },
    async wait(ids: readonly string[], timeoutMs: number, signal: AbortSignal) {
      const selected = ids.map(get);
      const snapshot = () => selected.map((member) => ({ ...member.summary }));
      if (
        selected.some(
          (member) =>
            member.completion === null &&
            member.summary.status !== "running" &&
            member.summary.status !== "preparing",
        )
      )
        return snapshot();
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          clearTimeout(timer);
          waiters.delete(changed);
          signal.removeEventListener("abort", aborted);
        };
        const changed = () => {
          if (
            selected.some(
              (member) => member.completion === null && member.summary.status !== "preparing",
            )
          ) {
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
  let summary = Buffer.from(text)
    .subarray(0, 15 * 1024)
    .toString("utf8");
  summary += "\n[摘要已截断；完整结果保存在成员 Session 历史中。]";
  return summary;
}
