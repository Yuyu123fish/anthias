import type { PermissionMode, WorkspaceCommand, WorkspacePermissionSnapshot } from "@anthias/agent";

export type PermissionGrantChoice = Readonly<{
  remember: boolean;
  includeMembers: boolean;
  commands?: readonly WorkspaceCommand[];
}>;

export function permissionModeLabel(mode: PermissionMode): string {
  return { agent: "Agent", plan: "Plan", auto_allow: "AutoAllow", full_access: "FullAccess" }[mode];
}

export function permissionModeNotice(
  mode: PermissionMode,
  snapshot: WorkspacePermissionSnapshot,
): string | null {
  if (mode === "full_access")
    return "FullAccess 跳过人工与自动审核，允许系统用户权限内的工作区外文件访问。当前没有 OS 沙箱，访问能力不等于任务授权。\n撤销工作区授权不会退出 FullAccess；请在空闲时使用 /mode agent、/mode plan 或 /mode auto_allow 切换。";
  return mode === "auto_allow" && snapshot.grant === null
    ? "auto_allow 已启用自动审核，当前没有工作区授权。自动审核不等于工作区授权。\n使用 /permissions grant --remember 查看并授予范围。"
    : null;
}

export function formatPermissions(
  snapshot: WorkspacePermissionSnapshot,
  mode: PermissionMode,
  choice?: PermissionGrantChoice,
): string {
  const grant = snapshot.grant;
  const commands =
    choice?.commands ??
    (choice ? snapshot.availableCommands : grant?.commands) ??
    snapshot.availableCommands;
  const remember = choice?.remember ?? grant?.remember ?? false;
  const includeMembers = choice?.includeMembers ?? grant?.includeMembers ?? false;
  return [
    `工作区：${snapshot.workspaceRoot}`,
    `权限模式：${permissionModeLabel(mode)}`,
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
    "命令按下面列明的匹配方式和工作目录授权；其他命令仍需审核：",
    ...commands.map(
      (command) =>
        `  ${command.command}\n    匹配：${command.allowArguments ? "前缀，允许后续任意字面参数或脚本" : "完整命令"}\n    cwd: ${command.cwd === "." ? snapshot.workspaceRoot : command.cwd}`,
    ),
    commands.some((command) => command.allowArguments)
      ? "前缀授权允许该入口执行后续字面参数或脚本，不限于测试；每段组合命令仍须匹配，不支持动态展开。"
      : "",
    "仅 auto_allow 模式采用此授权；FullAccess 由 /mode 显式选择，不依赖此授权。",
    mode === "full_access"
      ? "撤销工作区授权不会退出 FullAccess；需在空闲时使用 /mode 切换为 agent、plan 或 auto_allow。"
      : "切换至 auto_allow 不会自动授予工作区权限。",
    "本地命令与项目代码以当前系统用户运行。\n可能访问工作区之外；cwd 与 worktree 不限制其运行时副作用。\n当前没有 OS 沙箱。",
    "此范围不包含外部路径写入、破坏性清理、Git 提交或远端发布。",
    snapshot.error ?? "",
    choice
      ? "完整浏览后输入 grant 授予，或 cancel 取消。授权后可随时 /permissions revoke 撤销。"
      : "/permissions grant [--remember] [--members] 查看并授予；/permissions command 添加命令；/permissions revoke 撤销。",
  ]
    .filter(Boolean)
    .join("\n");
}
