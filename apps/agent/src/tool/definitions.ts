import type { JSONSchema7 } from "ai";
import type { PermissionMode } from "../permission/permission-mode.js";
import { editFileTool } from "./basetool/edit-file.js";
import { executeCommandTool } from "./basetool/execute-command.js";
import { globTool } from "./basetool/glob.js";
import { grepTool } from "./basetool/grep.js";
import { readArtifactTool } from "./basetool/read-artifact.js";
import { readFileTool } from "./basetool/read-file.js";
import { writeFileTool } from "./basetool/write-file.js";

/** 保存无需人工确认即可执行的固定 Tool 名称。 */
export const READ_ONLY_TOOL_NAMES = Object.freeze([
  "read_file",
  "glob",
  "grep",
  "read_artifact",
] as const);

/** 枚举无需人工确认的固定只读 Tool 名称。 */
export type ReadOnlyToolName = (typeof READ_ONLY_TOOL_NAMES)[number];

/** 保存执行前由当前权限模式与策略判定的固定 Tool 名称。 */
export const SIDE_EFFECT_TOOL_NAMES = Object.freeze([
  "edit_file",
  "write_file",
  "execute_command",
] as const);

/** 枚举执行前由当前权限模式与策略判定的 Tool 名称。 */
export type SideEffectToolName = (typeof SIDE_EFFECT_TOOL_NAMES)[number];

/** 枚举 Agent 固定提供给模型的只读与副作用 Tool 名称。 */
export type FixedToolName = ReadOnlyToolName | SideEffectToolName;

/** 描述 Model Adapter 所需且不含 execute 回调的固定 Tool。 */
export type ModelToolDefinition = Readonly<{
  name: string;
  description: string;
  inputSchema: JSONSchema7;
}>;

/** 基础工具的唯一装配名单；模型定义与执行绑定均从这里投影。 */
export const BASE_TOOLS = Object.freeze([
  readFileTool,
  globTool,
  grepTool,
  readArtifactTool,
  editFileTool,
  writeFileTool,
  executeCommandTool,
]);

/** Agent 模式向模型暴露的七个固定 Tool Schema。 */
export const FIXED_TOOL_DEFINITIONS: readonly ModelToolDefinition[] = Object.freeze(
  BASE_TOOLS.map((tool) => tool.definition),
);

/** Plan 模式只向模型暴露工作区和当前 Session 产物只读 Tool。 */
export const READ_ONLY_TOOL_DEFINITIONS: readonly ModelToolDefinition[] = Object.freeze(
  FIXED_TOOL_DEFINITIONS.filter((definition) => isReadOnlyToolName(definition.name)),
);

/** 按 Run 的权限快照返回不可变 Tool definitions。 */
export function getToolDefinitions(permissionMode: PermissionMode): readonly ModelToolDefinition[] {
  return permissionMode === "plan" ? READ_ONLY_TOOL_DEFINITIONS : FIXED_TOOL_DEFINITIONS;
}

/** 判断名称是否属于无需人工确认的只读 Tool。 */
export function isReadOnlyToolName(toolName: string): toolName is ReadOnlyToolName {
  return READ_ONLY_TOOL_NAMES.some((name) => name === toolName);
}

/** 判断名称是否属于三个有副作用的固定 Tool。 */
export function isSideEffectToolName(toolName: string): toolName is SideEffectToolName {
  return SIDE_EFFECT_TOOL_NAMES.some((name) => name === toolName);
}
