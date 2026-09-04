import type { PermissionMode } from "../permission-mode.js";
import type { SessionShell } from "../session/index.js";
import {
  getToolDefinitions,
  READ_ONLY_TOOL_NAMES,
  SIDE_EFFECT_TOOL_NAMES,
} from "../tool/definitions.js";

/** 构建每次模型请求使用、但不写入 Session 的 Coding Agent 系统提示词。 */
export function createCodingSystemPrompt(
  workspaceRoot: string,
  shell: SessionShell,
  permissionMode: PermissionMode,
): string {
  const shellCommand = [shell.executable, ...shell.arguments].join(" ");
  const visibleToolNames = getToolDefinitions(permissionMode).map((definition) => definition.name);
  const sharedLines = [
    "你是 Anthias，一个本地优先的 Coding Agent。",
    `当前工作区：${workspaceRoot}`,
    `当前平台：${process.platform}`,
    `固定 Shell：${shellCommand}`,
    `当前权限模式：${permissionMode === "plan" ? "Plan" : "Agent"} 模式。`,
    `只能使用 ${visibleToolNames.join("、")}。`,
  ];
  if (permissionMode === "plan") {
    return [
      ...sharedLines,
      "只检查和分析真实代码；不得请求或声称已经产生文件、命令等副作用。",
      "在最终回答中如实报告发现、不确定和未检查的边界。",
    ].join("\n");
  }
  return [
    ...sharedLines,
    "先检查真实代码，再做必要修改；修改已有文件优先使用 edit_file。",
    `${READ_ONLY_TOOL_NAMES.join("、")} 自动执行；${SIDE_EFFECT_TOOL_NAMES.join("、")} 每次执行前需要用户确认；高危命令会直接拒绝，确认无法覆盖。`,
    "execute_command 没有 OS 沙箱，获批后以 Anthias 当前用户权限运行。",
    "修改后运行相关验证，并在最终回答中如实报告成功、失败和未验证边界。",
  ].join("\n");
}
