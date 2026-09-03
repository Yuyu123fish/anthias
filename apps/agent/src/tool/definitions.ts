import type { JSONSchema7 } from "ai";

/** 保存无需人工确认即可执行的固定 Tool 名称。 */
export const READ_ONLY_TOOL_NAMES = Object.freeze(["read_file", "glob", "grep"] as const);

/** 保存每次执行前都必须取得人工确认的固定 Tool 名称。 */
export const SIDE_EFFECT_TOOL_NAMES = Object.freeze([
  "edit_file",
  "write_file",
  "execute_command",
] as const);

/** 枚举 Feature 002 固定提供给模型的六个 Tool 名称。 */
export type FixedToolName =
  | (typeof READ_ONLY_TOOL_NAMES)[number]
  | (typeof SIDE_EFFECT_TOOL_NAMES)[number];

/** 保存按照模型展示顺序排列的全部固定 Tool 名称。 */
export const FIXED_TOOL_NAMES: readonly FixedToolName[] = Object.freeze([
  ...READ_ONLY_TOOL_NAMES,
  ...SIDE_EFFECT_TOOL_NAMES,
]);

/** 描述 Model Adapter 所需且不含 execute 回调的固定 Tool。 */
export type ModelToolDefinition = Readonly<{
  name: FixedToolName;
  description: string;
  inputSchema: JSONSchema7;
}>;

/** Feature 002 的固定 Tool Schema；实际输入仍由 Agent 自己再次校验。 */
export const FIXED_TOOL_DEFINITIONS: readonly ModelToolDefinition[] = Object.freeze([
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

/** 判断名称是否属于无需人工确认的三个只读 Tool。 */
export function isReadOnlyToolName(toolName: string): boolean {
  return toolName === "read_file" || toolName === "glob" || toolName === "grep";
}

/** 创建并冻结一个不含执行行为的 Model Tool 定义。 */
function defineTool(
  name: FixedToolName,
  description: string,
  inputSchema: JSONSchema7,
): ModelToolDefinition {
  return Object.freeze({ name, description, inputSchema: Object.freeze(inputSchema) });
}
