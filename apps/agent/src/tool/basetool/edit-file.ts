import type { AssistantToolCallPart } from "../../message.js";
import { hasOnlyKeys, isNonEmptyString, isRecord } from "../input-validation.js";
import type { ToolWorkspace } from "../workspace-path.js";
import {
  failedFilePreparation,
  type PreparedFileResult,
  prepareFileChange,
} from "./file-change.js";

/** 表示 edit_file 已完成运行时校验后的固定输入。 */
type EditFileToolInput = Readonly<{
  path: string;
  replacements: readonly Readonly<{ oldText: string; newText: string }>[];
}>;

/** 只检查 edit_file 的运行时输入形状，不访问文件系统。 */
export function validateEditFileToolCallInput(toolCall: AssistantToolCallPart): string | null {
  const inputResult = parseEditFileToolInput(toolCall);
  return inputResult.ok ? null : inputResult.error;
}

/** 无副作用地校验 edit_file 目标，并生成绑定当前文件快照的确认预览。 */
export async function prepareEditFileTool(
  toolCall: AssistantToolCallPart,
  workspace: ToolWorkspace,
): Promise<PreparedFileResult> {
  const inputResult = parseEditFileToolInput(toolCall);
  if (!inputResult.ok) {
    return failedFilePreparation(inputResult.error);
  }
  return prepareFileChange(
    "edit_file",
    inputResult.input.path,
    workspace,
    ({ exists, originalContent }) =>
      exists
        ? calculateExactEdit(originalContent, inputResult.input.replacements)
        : Object.freeze({ ok: false, error: "edit_file 目标文件不存在。" }),
  );
}

/** 解析 edit_file 的精确输入，拒绝未知字段和错误类型。 */
function parseEditFileToolInput(
  toolCall: AssistantToolCallPart,
): Readonly<{ ok: true; input: EditFileToolInput }> | Readonly<{ ok: false; error: string }> {
  if (toolCall.invalid || toolCall.toolName !== "edit_file" || !isRecord(toolCall.input)) {
    return Object.freeze({
      ok: false,
      error: `${toolCall.toolName} 输入无法解析或不符合 Schema。`,
    });
  }
  const input = toolCall.input;
  if (
    !hasOnlyKeys(input, ["path", "replacements"]) ||
    !isNonEmptyString(input.path) ||
    !Array.isArray(input.replacements) ||
    input.replacements.length === 0
  ) {
    return Object.freeze({ ok: false, error: "edit_file 输入不符合 Schema。" });
  }
  const replacements: Readonly<{ oldText: string; newText: string }>[] = [];
  for (const replacement of input.replacements) {
    if (
      !isRecord(replacement) ||
      !hasOnlyKeys(replacement, ["oldText", "newText"]) ||
      !isNonEmptyString(replacement.oldText) ||
      typeof replacement.newText !== "string"
    ) {
      return Object.freeze({ ok: false, error: "edit_file replacements 不符合 Schema。" });
    }
    replacements.push(
      Object.freeze({ oldText: replacement.oldText, newText: replacement.newText }),
    );
  }
  return Object.freeze({
    ok: true,
    input: Object.freeze({
      path: input.path,
      replacements: Object.freeze(replacements),
    }),
  });
}

/** 在同一原始快照中验证唯一且不重叠的精确替换。 */
function calculateExactEdit(
  originalContent: string,
  replacements: readonly Readonly<{ oldText: string; newText: string }>[],
):
  | Readonly<{ ok: true; content: string; operation: "edit" }>
  | Readonly<{ ok: false; error: string }> {
  const indexedReplacements: Array<
    Readonly<{ start: number; end: number; oldText: string; newText: string }>
  > = [];
  for (const replacement of replacements) {
    const firstMatchIndex = originalContent.indexOf(replacement.oldText);
    if (
      firstMatchIndex < 0 ||
      originalContent.indexOf(replacement.oldText, firstMatchIndex + 1) >= 0
    ) {
      return Object.freeze({
        ok: false,
        error: "edit_file 的每个 oldText 必须在同一原始文件中恰好匹配一次。",
      });
    }
    indexedReplacements.push(
      Object.freeze({
        start: firstMatchIndex,
        end: firstMatchIndex + replacement.oldText.length,
        oldText: replacement.oldText,
        newText: replacement.newText,
      }),
    );
  }
  indexedReplacements.sort((left, right) => left.start - right.start);
  for (let index = 1; index < indexedReplacements.length; index += 1) {
    const previousReplacement = indexedReplacements[index - 1];
    const currentReplacement = indexedReplacements[index];
    if (
      previousReplacement === undefined ||
      currentReplacement === undefined ||
      currentReplacement.start < previousReplacement.end
    ) {
      return Object.freeze({ ok: false, error: "edit_file replacements 不能重叠。" });
    }
  }

  let editedContent = originalContent;
  for (const replacement of [...indexedReplacements].reverse()) {
    editedContent =
      editedContent.slice(0, replacement.start) +
      replacement.newText +
      editedContent.slice(replacement.end);
  }
  return Object.freeze({ ok: true, content: editedContent, operation: "edit" });
}
