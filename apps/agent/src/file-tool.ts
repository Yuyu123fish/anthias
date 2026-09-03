import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { createTwoFilesPatch } from "diff";
import type { AssistantToolCallPart } from "./agent.js";
import { boundToolOutput, type ToolExecutionResult, type ToolWorkspace } from "./tools.js";

/** 枚举 Feature 002 中两个文件副作用 Tool。 */
export type FileToolName = "edit_file" | "write_file";

/** 保存一个已经展示、仍未写入磁盘的准确文件变更。 */
export type PreparedFileTool = Readonly<{
  toolName: FileToolName;
  target: string;
  preview: string;
  operation: "edit" | "create" | "overwrite";
  absolutePath: string;
  parentRealPath: string;
  newContent: string;
  expectedFingerprint: TargetFingerprint;
  fileMode: number | undefined;
  workspace: ToolWorkspace;
}>;

/** 表示文件预检成功，或无需确认即可返回模型的安全失败。 */
export type PreparedFileResult =
  | Readonly<{ ok: true; preparedTool: PreparedFileTool }>
  | Readonly<{ ok: false; result: ToolExecutionResult }>;

/** 描述确认预览绑定的已有文件内容或不存在状态。 */
type TargetFingerprint = Readonly<{ kind: "missing" }> | Readonly<{ kind: "file"; sha256: string }>;

/** 表示文件 Tool 已完成运行时校验后的固定输入。 */
type FileToolInput =
  | Readonly<{
      toolName: "edit_file";
      path: string;
      replacements: readonly Readonly<{ oldText: string; newText: string }>[];
    }>
  | Readonly<{ toolName: "write_file"; path: string; content: string }>;

/** 保存预检时解析出的真实目标、原始内容与文件模式。 */
type ResolvedFileTarget = Readonly<{
  absolutePath: string;
  relativePath: string;
  parentRealPath: string;
  exists: boolean;
  originalContent: string;
  fingerprint: TargetFingerprint;
  fileMode: number | undefined;
}>;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** 无副作用地校验 edit_file 或 write_file，并生成不可截断的确认预览。 */
export async function prepareFileTool(
  toolCall: AssistantToolCallPart,
  workspace: ToolWorkspace,
): Promise<PreparedFileResult> {
  const inputResult = parseFileToolInput(toolCall);
  if (!inputResult.ok) {
    return failedPreparation(inputResult.error);
  }

  try {
    const target = await resolveFileTarget(inputResult.input.path, workspace);
    if (inputResult.input.toolName === "edit_file" && !target.exists) {
      return failedPreparation("edit_file 目标文件不存在。");
    }
    const calculatedChange =
      inputResult.input.toolName === "edit_file"
        ? calculateExactEdit(target.originalContent, inputResult.input.replacements)
        : Object.freeze({
            ok: true as const,
            content: inputResult.input.content,
            operation: target.exists ? ("overwrite" as const) : ("create" as const),
          });
    if (!calculatedChange.ok) {
      return failedPreparation(calculatedChange.error);
    }
    if (calculatedChange.content === target.originalContent && target.exists) {
      return failedPreparation(`${inputResult.input.toolName} 没有产生内容变化。`);
    }

    const patch = createTwoFilesPatch(
      target.exists ? `a/${target.relativePath}` : "/dev/null",
      `b/${target.relativePath}`,
      target.originalContent,
      calculatedChange.content,
      target.exists ? "before" : "missing",
      "after",
      { context: 3 },
    );
    const previewResult = boundToolOutput([
      `operation: ${calculatedChange.operation}`,
      `path: ${target.relativePath}`,
      ...splitLines(patch),
    ]);
    if (previewResult.truncated) {
      return failedPreparation(
        `${inputResult.input.toolName} 确认预览超过 64 KiB 或 2,000 行，请缩小修改。`,
      );
    }
    return Object.freeze({
      ok: true,
      preparedTool: Object.freeze({
        toolName: inputResult.input.toolName,
        target: target.relativePath,
        preview: previewResult.content,
        operation: calculatedChange.operation,
        absolutePath: target.absolutePath,
        parentRealPath: target.parentRealPath,
        newContent: calculatedChange.content,
        expectedFingerprint: target.fingerprint,
        fileMode: target.fileMode,
        workspace,
      }),
    });
  } catch (error) {
    return failedPreparation(toSafeFileError(error));
  }
}

/** 复核确认所见目标后，以同目录临时文件和原子 rename 应用准确内容。 */
export async function executePreparedFileTool(
  preparedTool: PreparedFileTool,
  abortSignal: AbortSignal,
): Promise<ToolExecutionResult> {
  if (abortSignal.aborted) {
    return failedExecution("Run 已停止，文件未写入。");
  }
  const fingerprintMatches = await matchesPreparedTarget(preparedTool).catch(() => false);
  if (!fingerprintMatches) {
    return failedExecution("stale target：目标在确认后发生变化，文件未写入。");
  }
  if (abortSignal.aborted) {
    return failedExecution("Run 已停止，文件未写入。");
  }

  const temporaryFilePath = join(
    preparedTool.parentRealPath,
    `.anthias-${basename(preparedTool.absolutePath)}-${randomUUID()}.tmp`,
  );
  let temporaryFileCreated = false;
  try {
    const temporaryFile = await open(
      temporaryFilePath,
      "wx",
      preparedTool.fileMode === undefined ? 0o666 : preparedTool.fileMode,
    );
    temporaryFileCreated = true;
    try {
      await temporaryFile.writeFile(preparedTool.newContent, "utf8");
      await temporaryFile.sync();
    } finally {
      await temporaryFile.close();
    }
    if (abortSignal.aborted) {
      await unlink(temporaryFilePath).catch(() => undefined);
      temporaryFileCreated = false;
      return failedExecution("Run 已停止，文件未写入。");
    }
    if (!(await matchesPreparedTarget(preparedTool))) {
      await unlink(temporaryFilePath).catch(() => undefined);
      temporaryFileCreated = false;
      return failedExecution("stale target：目标在确认后发生变化，文件未写入。");
    }
    await rename(temporaryFilePath, preparedTool.absolutePath);
    temporaryFileCreated = false;
    return Object.freeze({
      status: "completed",
      content: `${preparedTool.operation} completed: ${preparedTool.target}`,
      truncated: false,
    });
  } catch (error) {
    if (temporaryFileCreated) {
      await unlink(temporaryFilePath).catch(() => undefined);
    }
    return failedExecution(toSafeFileError(error));
  }
}

/** 判断名称是否属于必须逐次确认的文件 Tool。 */
export function isFileToolName(toolName: string): toolName is FileToolName {
  return toolName === "edit_file" || toolName === "write_file";
}

/** 解析两个文件 Tool 的精确输入，拒绝未知字段和错误类型。 */
function parseFileToolInput(
  toolCall: AssistantToolCallPart,
): Readonly<{ ok: true; input: FileToolInput }> | Readonly<{ ok: false; error: string }> {
  if (toolCall.invalid || !isFileToolName(toolCall.toolName) || !isRecord(toolCall.input)) {
    return Object.freeze({
      ok: false,
      error: `${toolCall.toolName} 输入无法解析或不符合 Schema。`,
    });
  }
  const input = toolCall.input;
  if (toolCall.toolName === "edit_file") {
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
        toolName: "edit_file",
        path: input.path,
        replacements: Object.freeze(replacements),
      }),
    });
  }
  if (
    !hasOnlyKeys(input, ["path", "content"]) ||
    !isNonEmptyString(input.path) ||
    typeof input.content !== "string"
  ) {
    return Object.freeze({ ok: false, error: "write_file 输入不符合 Schema。" });
  }
  return Object.freeze({
    ok: true,
    input: Object.freeze({ toolName: "write_file", path: input.path, content: input.content }),
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

/** 解析已有或待创建文件，校验真实父目录仍位于工作区且未命中 Session。 */
async function resolveFileTarget(
  requestedPath: string,
  workspace: ToolWorkspace,
): Promise<ResolvedFileTarget> {
  validateRelativePath(requestedPath);
  const lexicalTargetPath = resolve(workspace.workspaceRoot, requestedPath);
  const lexicalParentPath = dirname(lexicalTargetPath);
  const parentRealPath = await realpath(lexicalParentPath);
  const parentStats = await stat(parentRealPath);
  if (!parentStats.isDirectory()) {
    throw new Error("文件 Tool 的父路径不是目录。");
  }
  assertAllowedPath(parentRealPath, workspace);
  const targetPath = join(parentRealPath, basename(lexicalTargetPath));
  let targetStats: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    targetStats = await lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  if (targetStats === null) {
    assertAllowedPath(targetPath, workspace);
    return Object.freeze({
      absolutePath: targetPath,
      relativePath: normalizeRelativePath(relative(workspace.workspaceRoot, targetPath)),
      parentRealPath,
      exists: false,
      originalContent: "",
      fingerprint: Object.freeze({ kind: "missing" }),
      fileMode: undefined,
    });
  }

  const targetRealPath = await realpath(targetPath);
  assertAllowedPath(targetRealPath, workspace);
  const actualStats = await stat(targetRealPath);
  if (!actualStats.isFile()) {
    throw new Error("文件 Tool 目标不是普通文件。");
  }
  const originalBytes = await readFile(targetRealPath);
  return Object.freeze({
    absolutePath: targetRealPath,
    relativePath: normalizeRelativePath(relative(workspace.workspaceRoot, targetRealPath)),
    parentRealPath: dirname(targetRealPath),
    exists: true,
    originalContent: decodeStrictUtf8(originalBytes),
    fingerprint: fingerprintBytes(originalBytes),
    fileMode: actualStats.mode & 0o777,
  });
}

/** 复核目标存在状态、真实路径、内容指纹及父目录边界均未变化。 */
async function matchesPreparedTarget(preparedTool: PreparedFileTool): Promise<boolean> {
  const currentParentRealPath = await realpath(dirname(preparedTool.absolutePath));
  if (currentParentRealPath !== preparedTool.parentRealPath) {
    return false;
  }
  assertAllowedPath(currentParentRealPath, preparedTool.workspace);
  if (preparedTool.expectedFingerprint.kind === "missing") {
    try {
      await lstat(preparedTool.absolutePath);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
  const currentRealPath = await realpath(preparedTool.absolutePath);
  if (currentRealPath !== preparedTool.absolutePath) {
    return false;
  }
  assertAllowedPath(currentRealPath, preparedTool.workspace);
  const currentStats = await stat(currentRealPath);
  if (!currentStats.isFile()) {
    return false;
  }
  const currentBytes = await readFile(currentRealPath);
  return fingerprintBytes(currentBytes).sha256 === preparedTool.expectedFingerprint.sha256;
}

/** 拒绝绝对路径和任何显式父目录逃逸片段。 */
function validateRelativePath(requestedPath: string): void {
  if (
    requestedPath.length === 0 ||
    isAbsolute(requestedPath) ||
    win32.isAbsolute(requestedPath) ||
    requestedPath.replaceAll("\\", "/").split("/").includes("..")
  ) {
    throw new Error("文件 Tool path 必须是工作区相对路径。");
  }
}

/** 校验真实路径仍在工作区内且没有进入 Agent 自有 Session 目录。 */
function assertAllowedPath(targetPath: string, workspace: ToolWorkspace): void {
  if (!isSameOrInside(workspace.workspaceRoot, targetPath)) {
    throw new Error("文件 Tool path 越出工作区。");
  }
  if (isSameOrInside(workspace.sessionDirectory, targetPath)) {
    throw new Error("文件 Tool path 命中 Session 保留目录。");
  }
}

/** 使用平台路径语义判断目标是否等于或位于父目录内。 */
function isSameOrInside(parentPath: string, targetPath: string): boolean {
  const relativePath = relative(parentPath, targetPath);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== "..");
}

/** 将平台路径分隔符统一为模型与 Session 可稳定使用的斜杠。 */
function normalizeRelativePath(filePath: string): string {
  return filePath.split(sep).join("/");
}

/** 为已有文件内容创建确认后复核使用的 SHA-256 指纹。 */
function fingerprintBytes(bytes: Uint8Array): Extract<TargetFingerprint, { kind: "file" }> {
  return Object.freeze({ kind: "file", sha256: createHash("sha256").update(bytes).digest("hex") });
}

/** 以 fatal UTF-8 解码文本，并拒绝包含 NUL 的二进制内容。 */
function decodeStrictUtf8(bytes: Uint8Array): string {
  if (bytes.includes(0)) {
    throw new Error("文件包含二进制内容。");
  }
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw new Error("文件不是有效的 UTF-8 文本。");
  }
}

/** 按跨平台换行拆分预览文本，不虚构额外尾行。 */
function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

/** 创建一个无需确认即可返回模型的文件预检失败。 */
function failedPreparation(error: string): PreparedFileResult {
  return Object.freeze({
    ok: false,
    result: Object.freeze({ status: "failed", content: error, truncated: false }),
  });
}

/** 创建一个由 Agent 继续映射取消状态的文件执行失败。 */
function failedExecution(error: string): ToolExecutionResult {
  return Object.freeze({ status: "failed", content: error, truncated: false });
}

/** 收敛文件系统错误，避免绝对路径或堆栈进入模型与 TUI。 */
function toSafeFileError(error: unknown): string {
  const errorCode = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof errorCode === "string") {
    return `文件 Tool 操作失败：${errorCode}`;
  }
  return error instanceof Error ? error.message : "文件 Tool 操作失败。";
}

/** 判断未知值是否为普通 JSON 对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 判断对象键集合是否没有 Schema 之外的字段。 */
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

/** 判断未知值是否为非空字符串。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
