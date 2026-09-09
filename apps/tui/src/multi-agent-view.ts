import type {
  Agent,
  CollaborationAction,
  CollaborationSnapshot,
  GitAction,
  MemberSummary,
} from "@anthias/agent";
import type { CommandResult } from "./command-result.js";
import { sanitizeTerminalText } from "./content-renderer.js";

const statusNames: Record<MemberSummary["status"], string> = {
  preparing: "准备中",
  running: "运行中",
  idle: "空闲",
  completed: "完成",
  failed: "失败",
  aborted: "已停止",
  interrupted: "已中断",
  closed: "已释放",
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
    snapshot.team
      ? "Team · " +
        snapshot.team.name +
        " · " +
        (snapshot.team.status === "active" ? "活动" : "已结束")
      : "当前没有 Team。",
    ...snapshot.members.map((member) =>
      [
        (member.name.trim() || member.sessionId) +
          " · " +
          member.kind +
          " · " +
          memberStatusName(member.status),
        "  " + member.sessionId,
        "  Workspace: " + member.workspaceRoot,
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
  return " · 成员 " + active + " 运行 / " + snapshot.members.length + " 总计 · /agents";
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
  if (name === "agents" || (name === "team" && (!operation || operation === "tasks"))) {
    if (name === "agents" && tokens.length) {
      notice("用法：/agents");
      return { kind: "rejected" };
    } else notice(formatCollaboration(agent.collaboration.snapshot(), agent.state.sessionId));
    return { kind: "handled" };
  }
  try {
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
    if ((name === "agent" && operation === "spawn") || (name === "team" && operation === "add")) {
      const writable = tokens[1] === "--write";
      const task = after(writable ? 2 : 1);
      if (!task) throw new Error("请给出成员任务。");
      return await dispatch({
        action: name === "agent" ? "spawn" : "team_add",
        task,
        writable,
        name: task.slice(0, 32),
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
    } else if (name === "agent" && operation === "wait" && tokens[1] && tokens.length <= 4) {
      return await dispatch({ action: "wait", memberIds: tokens.slice(1) });
    } else if (name === "agent" && operation === "resume" && tokens[1]) {
      return await dispatch({
        action: "resume",
        memberId: tokens[1],
        ...(after(2) ? { task: after(2) } : {}),
      });
    } else if (name === "team" && operation === "create" && after(1)) {
      return await dispatch({ action: "team_create", name: after(1) });
    } else if (name === "team" && operation === "close" && tokens.length === 1) {
      return await dispatch({ action: "team_close" });
    } else if (name === "team" && operation === "assign" && tokens[1] && after(2)) {
      return await dispatch({ action: "task_assign", memberId: tokens[1], task: after(2) });
    } else if (name === "team" && operation === "message" && tokens[1] && after(2)) {
      return await dispatch({ action: "message", memberId: tokens[1], content: after(2) });
    } else throw new Error("使用 /help 查看成员和 Team 命令。");
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
    "种类：" + (member?.kind ?? "身份信息缺失"),
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
