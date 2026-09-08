import type { WorkspacePermissionSnapshot } from "@anthias/agent";

export type PermissionGrantChoice = Readonly<{ remember: boolean; includeMembers: boolean }>;

export function formatPermissions(
  snapshot: WorkspacePermissionSnapshot,
  choice?: PermissionGrantChoice,
): string {
  const grant = snapshot.grant;
  const commands =
    choice === undefined
      ? (grant?.commands ?? snapshot.availableCommands)
      : snapshot.availableCommands;
  const remember = choice?.remember ?? grant?.remember ?? false;
  const includeMembers = choice?.includeMembers ?? grant?.includeMembers ?? false;
  return [
    `工作区：${snapshot.workspaceRoot}`,
    choice
      ? "即将授予以下范围；当前尚未新增授权。"
      : grant === null
        ? snapshot.revoked
          ? "当前授权已撤销。"
          : "当前没有工作区授权。"
        : "来源：工作区授权",
    choice || grant
      ? `有效范围：${remember ? "记住，可在同一规范工作区重新启动时复用" : "仅本次会话"}`
      : "",
    choice || grant
      ? `文件：${choice || grant?.files ? "当前工作区内的普通创建与编辑" : "未授权"}`
      : "",
    `成员：${includeMembers ? (remember ? "包括今后从本工作区发起的任务所创建并登记的成员 worktree" : "仅包括当前任务创建并登记的成员 worktree") : "不包括成员 worktree"}`,
    "命令只匹配下面的完整入口、参数和工作目录；其他命令仍需审核：",
    ...commands.map(
      (command) =>
        `  ${command.command}\n    cwd: ${command.cwd === "." ? snapshot.workspaceRoot : command.cwd}`,
    ),
    "仅 auto_allow 模式采用此授权；/mode 切换模式本身不授予权限。",
    "本地命令与项目代码以当前系统用户运行。\n可能访问工作区之外；cwd 与 worktree 不限制其运行时副作用。\n当前没有 OS 沙箱。",
    "此范围不包含外部路径写入、破坏性清理、Git 提交或远端发布。",
    snapshot.error ?? "",
    choice
      ? "完整浏览后输入 grant 授予，或 cancel 取消。授权后可随时 /permissions revoke 撤销。"
      : "/permissions grant [--remember] [--members] 查看并授予；/permissions revoke 撤销。",
  ]
    .filter(Boolean)
    .join("\n");
}
