import type {
  Agent,
  CollaborationAction,
  CollaborationSnapshot,
  GitAction,
  MemberSummary,
} from "@anthias/agent";
import type { CommandResult } from "./command-result.js";
import { sanitizeTerminalText } from "./content-renderer.js";

const phaseNames: Record<string, string> = {
  requesting_model: "请求模型",
  retrying_model: "等待模型重试",
  compacting: "压缩上下文",
  reviewing_tool: "自动审核",
  awaiting_tool_approval: "等待批准",
  awaiting_workspace: "等待工作区资源",
  executing_tool: "执行工具",
};
const statusNames: Record<MemberSummary["status"], string> = {
  preparing: "准备中",
  queued: "等待执行位置",
  paused: "已暂停",
  closing: "关闭中",
  running: "运行中",
  idle: "空闲",
  completed: "完成",
  failed: "失败",
  aborted: "已停止",
  interrupted: "已中断",
  closed: "已关闭",
};
export function memberStatusName(status: MemberSummary["status"]): string {
  return statusNames[status];
}
export function formatCollaboration(
  snapshot: CollaborationSnapshot,
  fallbackRootSessionId?: string,
): string {
  const lines = [
    "主 Agent · 根 Session：" + (snapshot.rootSessionId ?? fallbackRootSessionId ?? "归属信息缺失"),
    ...(snapshot.notice ? [snapshot.notice] : []),
    ...(snapshot.workspaceBlocks ?? []).map(
      (block) =>
        "工作区阻塞 " +
        block.blockId +
        "\n  来源: " +
        block.sessionId +
        " / " +
        block.toolCallId +
        "\n  " +
        block.reason +
        "\n  /agent recover " +
        block.blockId +
        " 检查清理；外部清理后由用户使用同命令追加 confirm-cleanup 确认。",
    ),
    "协作群组 · " +
      (snapshot.members.length ? snapshot.members.length + " 名成员" : "尚未创建成员"),
    ...snapshot.members.map((member) =>
      [
        (member.name.trim() || member.sessionId) + " · " + memberStatusName(member.status),
        "  " + member.sessionId,
        "  Workspace: " + member.workspaceRoot,
        "  能力: " + (member.writable ? "可写" : "只读"),
        member.phase ? "  阶段: " + (phaseNames[member.phase] ?? member.phase) : "",
        member.pausedBy ? "  暂停来源: " + (member.pausedBy === "user" ? "用户" : "根 Agent") : "",
        member.lastActivityAt ? "  最近活动: " + member.lastActivityAt : "",
        member.workspaceNotice ? "  工作区说明: " + member.workspaceNotice : "",
        "  任务: " + (member.task.trim() || "任务信息缺失"),
        member.result?.trim() ? "  结果: " + member.result : "  尚无结果摘要。",
        member.error ? "  原因: " + member.error : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    ...snapshot.tasks.map(
      (task) =>
        "任务 " +
        task.id +
        " · " +
        task.status +
        "\n  " +
        task.description +
        "\n  负责人: " +
        task.memberSessionId +
        (task.result ? "\n  " + task.result : ""),
    ),
  ];
  if (!snapshot.members.length) lines.push("尚未创建成员。");
  lines.push("/agent result <id> 查看结果与历史；/agent stop <id> 停止成员。");
  return sanitizeTerminalText(lines.join("\n\n"));
}
export function collaborationStatus(snapshot: CollaborationSnapshot | undefined): string {
  if (!snapshot?.members.length) return "";
  const active = snapshot.members.filter(
    (member) => member.status === "running" || member.status === "preparing",
  ).length;
  const waiting = snapshot.members.filter(
    (member) =>
      member.status === "queued" ||
      member.phase === "awaiting_tool_approval" ||
      member.phase === "awaiting_workspace",
  ).length;
  return (
    " · 成员 " +
    active +
    " 运行 / " +
    snapshot.members.length +
    " 总计" +
    (waiting ? " · " + waiting + " 等待" : "") +
    " · /agents"
  );
}

/** 命令只构造 Agent 语义操作；权限、成员身份和目录归属由 Agent 复核。 */
export async function runCollaborationCommand(
  name: string,
  args: string,
  agent: Agent,
  notice: (text: string) => void,
): Promise<CommandResult> {
  const tokens = args.trim().split(/\s+/u).filter(Boolean);
  const operation = tokens[0];
  function after(count: number) {
    let rest = args.trim();
    for (let index = 0; index < count; index++) rest = rest.replace(/^\S+\s*/u, "");
    return rest;
  }
  async function dispatch(action: CollaborationAction): Promise<CommandResult> {
    const snapshot = agent.collaboration.snapshot();
    const owner =
      action.action === "result"
        ? {
            rootSessionId: snapshot.rootSessionId ?? agent.state.sessionId,
            memberId: action.memberId,
            member: snapshot.members.find((member) => member.sessionId === action.memberId),
            ...(action.artifactId ? { artifactId: action.artifactId } : {}),
          }
        : undefined;
    try {
      const result = await agent.collaboration.execute(action);
      notice(
        result.ok
          ? renderResult(result.value, owner)
          : sanitizeTerminalText(
              [owner ? resultOwnerTitle(owner) : "", result.error].filter(Boolean).join("\n\n"),
            ),
      );
      return { kind: result.ok ? "handled" : "rejected" };
    } catch (error) {
      notice(
        sanitizeTerminalText(
          [
            owner ? resultOwnerTitle(owner) : "",
            error instanceof Error ? error.message : "成员操作失败。",
          ]
            .filter(Boolean)
            .join("\n\n"),
        ),
      );
      return { kind: "rejected" };
    }
  }
  if (name === "agents" || (name === "agent" && operation === "tasks")) {
    if (name === "agents" && tokens.length) {
      notice("用法：/agents");
      return { kind: "rejected" };
    } else notice(formatCollaboration(agent.collaboration.snapshot(), agent.state.sessionId));
    return { kind: "handled" };
  }
  try {
    if (name === "agent" && operation === "recover") {
      if (
        !tokens[1] ||
        tokens.length > 3 ||
        (tokens[2] !== undefined && tokens[2] !== "confirm-cleanup")
      )
        throw new Error(
          "用法：/agent recover <blockId> [confirm-cleanup]；确认前必须在外部完成原命令资源清理。",
        );
      return dispatch({
        action: "workspace_recover",
        blockId: tokens[1],
        ...(tokens[2] === "confirm-cleanup" ? { confirmCleanup: true } : {}),
      });
    }
    if (name === "git") {
      let action: GitAction;
      if (
        !operation ||
        ["status", "diff", "log", "show", "branches", "worktrees"].includes(operation)
      ) {
        if (tokens.length > 2)
          throw new Error("查询最多接受一个 worktree ID；/git show 接受提交引用。");
        action = {
          action: (operation ?? "status") as GitAction["action"],
          ...(tokens[1]
            ? operation === "show"
              ? { ref: tokens[1] }
              : { worktreeId: tokens[1] }
            : {}),
        };
      } else if (operation === "create" && tokens.length <= 2)
        action = { action: "create", ...(tokens[1] ? { ref: tokens[1] } : {}) };
      else if (operation === "inspect" && tokens.length === 2)
        action = { action: "inspect", worktreeId: tokens[1] ?? "" };
      else if (
        operation === "remove" &&
        (tokens.length === 2 || (tokens.length === 3 && tokens[2] === "discard"))
      )
        action = {
          action: "remove",
          worktreeId: tokens[1] ?? "",
          ...(tokens[2] ? { discard: true } : {}),
        };
      else if (operation === "integrate" && tokens.length === 3)
        action = { action: "integrate", worktreeId: tokens[1] ?? "", commit: tokens[2] ?? "" };
      else if ((operation === "continue" || operation === "abort") && tokens.length === 1)
        action = { action: operation };
      else if (operation === "commit") {
        const input: unknown = JSON.parse(after(1));
        if (input === null || typeof input !== "object" || Array.isArray(input))
          throw new Error("提交需要 paths、message 和可选 worktreeId。");
        action = { ...input, action: "commit" } as GitAction;
      } else throw new Error("使用 /help 查看 Git 命令。");
      const result = await agent.git.execute(action);
      notice(result.ok ? renderResult(result.value) : result.error);
      return { kind: result.ok ? "handled" : "rejected" };
    }
    if (name === "agent" && operation === "spawn") {
      let writable = true;
      let worktreeId: string | undefined;
      let index = 1;
      while (tokens[index]?.startsWith("--")) {
        const flag = tokens[index++];
        if (flag === "--read-only") writable = false;
        else if (flag === "--write") writable = true;
        else if (flag === "--worktree" && tokens[index] && !tokens[index]?.startsWith("--"))
          worktreeId = tokens[index++];
        else throw new Error("成员选项只支持 --read-only 和 --worktree <id>。");
      }
      const task = after(index);
      if (!task) throw new Error("请给出成员任务。");
      return await dispatch({
        action: "spawn",
        task,
        writable,
        name: task.slice(0, 32),
        ...(worktreeId ? { worktreeId } : {}),
      });
    } else if (name === "agent" && operation === "result" && tokens[1] && tokens.length <= 3) {
      const offset = tokens[2] === undefined ? undefined : Number(tokens[2]);
      if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0))
        throw new Error("历史偏移必须是非负整数。");
      return await dispatch({
        action: "result",
        memberId: tokens[1],
        ...(offset === undefined ? {} : { offset }),
      });
    } else if (
      name === "agent" &&
      operation === "artifact" &&
      tokens[1] &&
      tokens[2] &&
      tokens.length <= 4
    ) {
      return await dispatch({
        action: "result",
        memberId: tokens[1],
        artifactId: tokens[2],
        ...(tokens[3] ? { cursor: tokens[3] } : {}),
      });
    } else if (
      name === "agent" &&
      (operation === "stop" || operation === "release") &&
      tokens[1] &&
      tokens.length === 2
    ) {
      return await dispatch({
        action: "stop",
        memberId: tokens[1],
        release: operation === "release",
      });
    } else if (name === "agent" && operation === "wait" && tokens[1] && tokens.length <= 10) {
      return await dispatch({ action: "wait", memberIds: tokens.slice(1) });
    } else if (name === "agent" && operation === "resume" && tokens[1]) {
      return await dispatch({
        action: "resume",
        memberId: tokens[1],
        ...(after(2) ? { task: after(2) } : {}),
      });
    } else if (name === "agent" && operation === "reopen" && tokens[1] && tokens.length === 2) {
      return await dispatch({ action: "reopen", memberId: tokens[1] });
    } else if (name === "agent" && operation === "assign" && tokens[1] && after(2)) {
      return await dispatch({ action: "task_assign", memberId: tokens[1], task: after(2) });
    } else if (
      name === "agent" &&
      operation === "update" &&
      tokens[1] &&
      (tokens[2] === "completed" || tokens[2] === "blocked") &&
      after(3)
    ) {
      return await dispatch({
        action: "task_update",
        taskId: tokens[1],
        status: tokens[2],
        result: after(3),
      });
    } else if (name === "agent" && operation === "message" && tokens[1] && after(2)) {
      return await dispatch({ action: "message", memberId: tokens[1], content: after(2) });
    } else if (name === "agent" && operation === "workspace" && tokens[1] && tokens.length <= 3) {
      return await dispatch({
        action: "workspace_bind",
        memberId: tokens[1],
        ...(tokens[2] && tokens[2] !== "root" ? { worktreeId: tokens[2] } : {}),
      });
    } else if (name === "agent" && operation === "group" && tokens.length === 2) {
      if (tokens[1] === "stop") return await dispatch({ action: "group_stop" });
      if (tokens[1] === "continue") return await dispatch({ action: "group_continue" });
      throw new Error("用法：/agent group stop|continue");
    } else if (name === "agent" && operation === "notes") {
      if (tokens.length === 1 || (tokens[1] === "read" && tokens.length === 2))
        return await dispatch({ action: "notes_read" });
      if (tokens[1] === "append" && after(2))
        return await dispatch({ action: "notes_append", content: after(2) });
      if (tokens[1] === "replace" && tokens[2])
        return await dispatch({
          action: "notes_replace",
          expectedVersion: tokens[2],
          content: after(3),
        });
      throw new Error("用法：/agent notes [read|append <正文>|replace <版本> <正文>]");
    } else throw new Error("使用 /help 查看成员与群组命令。");
  } catch (error) {
    notice(error instanceof Error ? error.message : "命令参数无效。");
    return { kind: "rejected" };
  }
}

type ResultOwner = {
  rootSessionId: string;
  memberId: string;
  member: MemberSummary | undefined;
  artifactId?: string;
};

function resultOwnerTitle(owner: ResultOwner): string {
  const member = owner.member;
  return [
    "根 Session：" + owner.rootSessionId,
    "成员 " + (member?.name.trim() || owner.memberId) + " [" + owner.memberId + "]",
    "角色：普通成员",
    "状态：" + (member ? memberStatusName(member.status) : "状态信息缺失"),
    "任务：" + (member?.task.trim() || "任务信息缺失"),
    ...(owner.artifactId ? ["产物：" + owner.artifactId] : []),
  ].join("\n");
}

function renderResult(text: string, owner?: ResultOwner): string {
  return sanitizeTerminalText(
    [owner ? resultOwnerTitle(owner) : "", renderPayload(text)].filter(Boolean).join("\n\n"),
  );
}

function renderPayload(text: string): string {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const result = value as Record<string, unknown>;
      if (typeof result.history === "string")
        return [
          "成员 " + String(result.memberSessionId) + " · " + String(result.status),
          typeof result.result === "string" && result.result.trim()
            ? result.result
            : "尚无结果摘要。",
          "历史\n" + result.history,
          result.nextOffset === null
            ? ""
            : "下一页：/agent result " +
              String(result.memberSessionId) +
              " " +
              String(result.nextOffset),
          Array.isArray(result.artifacts) && result.artifacts.length
            ? "产物引用\n" + JSON.stringify(result.artifacts, null, 2)
            : "",
        ]
          .filter(Boolean)
          .join("\n\n");
      if (typeof result.sessionId === "string")
        return [
          String(result.name),
          result.sessionId,
          String(result.status),
          "Workspace: " + String(result.workspaceRoot),
          typeof result.error === "string" ? result.error : "",
        ]
          .filter(Boolean)
          .join("\n");
    }
    return JSON.stringify(value, null, 2);
  } catch {
    return text;
  }
}
