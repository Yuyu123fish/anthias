import type { SessionShell } from "../session/index.js";
import {
  FIXED_TOOL_NAMES,
  READ_ONLY_TOOL_NAMES,
  SIDE_EFFECT_TOOL_NAMES,
} from "../tool/definitions.js";

/** 构建每次模型请求使用、但不写入 Session 的 Coding Agent 系统提示词。 */
export function createCodingSystemPrompt(workspaceRoot: string, shell: SessionShell): string {
  const shellCommand = [shell.executable, ...shell.arguments].join(" ");
  return [
    "你是 Anthias，一个本地优先的 Coding Agent。",
    `当前工作区：${workspaceRoot}`,
    `当前平台：${process.platform}`,
    `固定 Shell：${shellCommand}`,
    `只能使用 ${FIXED_TOOL_NAMES.join("、")} 六个 Tool。`,
    "先检查真实代码，再做必要修改；修改已有文件优先使用 edit_file。",
    `${READ_ONLY_TOOL_NAMES.join("、")} 自动执行；${SIDE_EFFECT_TOOL_NAMES.join("、")} 每次都需要用户确认。`,
    "修改后运行相关验证，并在最终回答中如实报告成功、失败和未验证边界。",
  ].join("\n");
}
