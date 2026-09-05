import type { JSONSchema7 } from "ai";
import type { PermissionMode } from "../permission/permission-mode.js";

/** 保存无需人工确认即可执行的固定 Tool 名称。 */
export const READ_ONLY_TOOL_NAMES = Object.freeze([
  "read_file",
  "glob",
  "grep",
  "read_artifact",
] as const);

/** 枚举无需人工确认的固定只读 Tool 名称。 */
export type ReadOnlyToolName = (typeof READ_ONLY_TOOL_NAMES)[number];

/** 保存每次执行前都必须取得人工确认的固定 Tool 名称。 */
export const SIDE_EFFECT_TOOL_NAMES = Object.freeze([
  "edit_file",
  "write_file",
  "execute_command",
] as const);

/** 枚举每次执行前都必须取得人工确认的 Tool 名称。 */
export type SideEffectToolName = (typeof SIDE_EFFECT_TOOL_NAMES)[number];

/** 枚举 Agent 固定提供给模型的只读与副作用 Tool 名称。 */
export type FixedToolName = ReadOnlyToolName | SideEffectToolName;

/** 描述 Model Adapter 所需且不含 execute 回调的固定 Tool。 */
export type ModelToolDefinition = Readonly<{
  name: FixedToolName;
  description: string;
  inputSchema: JSONSchema7;
}>;

/** 固定 Tool Schema；实际输入仍由 Agent 自己再次校验。 */
const ALL_TOOL_DEFINITIONS: readonly ModelToolDefinition[] = Object.freeze([
  defineTool("read_file", "读取工作区内 UTF-8 文本文件的指定行范围。", {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", minLength: 1 },
      startLine: { type: "integer", minimum: 1 },
      lineCount: { type: "integer", minimum: 1, maximum: 2000 },
    },
  }),
  defineTool("glob", "按 Glob 模式发现工作区内的文件。", {
    type: "object",
    additionalProperties: false,
    required: ["pattern"],
    properties: {
      pattern: { type: "string", minLength: 1 },
      path: { type: "string", minLength: 1 },
    },
  }),
  defineTool("grep", "按正则搜索工作区内 UTF-8 文本文件。", {
    type: "object",
    additionalProperties: false,
    required: ["pattern"],
    properties: {
      pattern: { type: "string" },
      path: { type: "string", minLength: 1 },
      filePattern: { type: "string", minLength: 1 },
      contextLines: { type: "integer", minimum: 0, maximum: 10 },
    },
  }),
  defineTool("read_artifact", "读取当前 Session 已引用的 Tool 原文产物。", {
    type: "object",
    additionalProperties: false,
    required: ["artifactId"],
    properties: {
      artifactId: { type: "string", minLength: 1 },
      cursor: { type: "string", minLength: 1 },
      lineCount: { type: "integer", minimum: 1, maximum: 200 },
      search: { type: "string", minLength: 1 },
    },
  }),
  defineTool("edit_file", "对已有 UTF-8 文本文件执行一组精确替换。", {
    type: "object",
    additionalProperties: false,
    required: ["path", "replacements"],
    properties: {
      path: { type: "string", minLength: 1 },
      replacements: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["oldText", "newText"],
          properties: {
            oldText: { type: "string", minLength: 1 },
            newText: { type: "string" },
          },
        },
      },
    },
  }),
  defineTool("write_file", "创建 UTF-8 文本文件或完整覆盖已有文件。", {
    type: "object",
    additionalProperties: false,
    required: ["path", "content"],
    properties: {
      path: { type: "string", minLength: 1 },
      content: { type: "string" },
    },
  }),
  defineTool("execute_command", "在 Session 固定 Shell 中执行一次性非交互命令。", {
    type: "object",
    additionalProperties: false,
    required: ["command"],
    properties: {
      command: { type: "string", minLength: 1 },
      cwd: { type: "string", minLength: 1 },
      timeoutMs: { type: "integer", minimum: 1000, maximum: 1800000 },
    },
  }),
]);

/** Agent 模式向模型暴露的七个固定 Tool Schema。 */
export const FIXED_TOOL_DEFINITIONS: readonly ModelToolDefinition[] = ALL_TOOL_DEFINITIONS;

/** Plan 模式只向模型暴露工作区和当前 Session 产物只读 Tool。 */
export const READ_ONLY_TOOL_DEFINITIONS: readonly ModelToolDefinition[] = Object.freeze(
  ALL_TOOL_DEFINITIONS.filter((definition) => isReadOnlyToolName(definition.name)),
);

/** 按 Run 的权限快照返回不可变 Tool definitions。 */
export function getToolDefinitions(permissionMode: PermissionMode): readonly ModelToolDefinition[] {
  return permissionMode === "plan" ? READ_ONLY_TOOL_DEFINITIONS : FIXED_TOOL_DEFINITIONS;
}

/** 判断名称是否属于无需人工确认的只读 Tool。 */
export function isReadOnlyToolName(toolName: string): toolName is ReadOnlyToolName {
  return (
    toolName === "read_file" ||
    toolName === "glob" ||
    toolName === "grep" ||
    toolName === "read_artifact"
  );
}

/** 判断名称是否属于三个有副作用的固定 Tool。 */
export function isSideEffectToolName(toolName: string): toolName is SideEffectToolName {
  return toolName === "edit_file" || toolName === "write_file" || toolName === "execute_command";
}

/** 创建并冻结一个不含执行行为的 Model Tool 定义。 */
function defineTool(
  name: FixedToolName,
  description: string,
  inputSchema: JSONSchema7,
): ModelToolDefinition {
  return Object.freeze({ name, description, inputSchema: Object.freeze(inputSchema) });
}
