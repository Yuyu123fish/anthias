import type { AssistantToolCallPart } from "../../message.js";
import { hasOnlyKeys, isNonEmptyString, isRecord } from "../input-validation.js";
import { createFileToolCallPlan, createRejectedToolCallPlan } from "../tool-plan.js";
import type { BaseTool } from "../tool-runner.js";
import type { ToolWorkspace } from "../workspace-path.js";
import {
  failedFilePreparation,
  type PreparedFileResult,
  prepareFileChange,
} from "./file-change.js";
import { type ExpectedFileVersion, isFileContentVersion } from "./text-file.js";

export const writeFileTool: BaseTool = Object.freeze({
  definition: Object.freeze({
    name: "write_file",
    description:
      "创建或完整覆盖 UTF-8 文件。新建 expectedVersion 使用 missing；覆盖必须携带 read_file 实际返回的全文件版本。过期时重新读取并调整。",
    inputSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["path", "expectedVersion", "content"],
      properties: {
        path: { type: "string", minLength: 1 },
        expectedVersion: { type: "string", pattern: "^(missing|sha256:[a-f0-9]{64})$" },
        content: { type: "string" },
      },
    }),
  }),
  createPlan(toolCall, permissionMode, options) {
    const validationError = validateWriteFileToolCallInput(toolCall);
    if (validationError !== null) return createRejectedToolCallPlan(validationError);
    if (options.writable === false) return createRejectedToolCallPlan("当前成员只能读取工作区。");
    return createFileToolCallPlan(
      toolCall,
      permissionMode,
      options.workspace,
      prepareWriteFileTool,
    );
  },
});

/** 表示 write_file 已完成运行时校验后的固定输入。 */
type WriteFileToolInput = Readonly<{
  path: string;
  expectedVersion: ExpectedFileVersion;
  content: string;
}>;

/** 只检查 write_file 的运行时输入形状，不访问文件系统。 */
export function validateWriteFileToolCallInput(toolCall: AssistantToolCallPart): string | null {
  const inputResult = parseWriteFileToolInput(toolCall);
  return inputResult.ok ? null : inputResult.error;
}

/** 无副作用地校验 write_file 目标，并生成创建或覆盖确认预览。 */
export async function prepareWriteFileTool(
  toolCall: AssistantToolCallPart,
  workspace: ToolWorkspace,
): Promise<PreparedFileResult> {
  const inputResult = parseWriteFileToolInput(toolCall);
  if (!inputResult.ok) {
    return failedFilePreparation(inputResult.error);
  }
  return prepareFileChange(
    "write_file",
    inputResult.input.path,
    workspace,
    inputResult.input.expectedVersion,
    toolCall.toolCallId,
    ({ exists }) =>
      Object.freeze({
        ok: true,
        content: inputResult.input.content,
        operation: exists ? ("overwrite" as const) : ("create" as const),
      }),
  );
}

/** 解析 write_file 的精确输入，拒绝未知字段和错误类型。 */
function parseWriteFileToolInput(
  toolCall: AssistantToolCallPart,
): Readonly<{ ok: true; input: WriteFileToolInput }> | Readonly<{ ok: false; error: string }> {
  if (toolCall.invalid || toolCall.toolName !== "write_file" || !isRecord(toolCall.input)) {
    return Object.freeze({
      ok: false,
      error: `${toolCall.toolName} 输入无法解析或不符合 Schema。`,
    });
  }
  const input = toolCall.input;
  if (
    !hasOnlyKeys(input, ["path", "expectedVersion", "content"]) ||
    !isNonEmptyString(input.path) ||
    (input.expectedVersion !== "missing" && !isFileContentVersion(input.expectedVersion)) ||
    typeof input.content !== "string"
  ) {
    return Object.freeze({
      ok: false,
      error:
        "write_file 输入不符合 Schema；expectedVersion 必须使用 read_file 返回的 sha256 版本，新建使用 missing。",
    });
  }
  return Object.freeze({
    ok: true,
    input: Object.freeze({
      path: input.path,
      expectedVersion: input.expectedVersion,
      content: input.content,
    }),
  });
}
