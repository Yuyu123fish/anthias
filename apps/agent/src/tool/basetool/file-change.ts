import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { createTwoFilesPatch } from "diff";
import {
  boundToolOutput,
  failedToolResult,
  type ToolExecutionResult,
  type ToolFailedResult,
} from "../tool-result.js";
import {
  arePathsEqual,
  isPathSameOrInside,
  type ToolWorkspace,
  validateWorkspaceRelativePath,
} from "../workspace-path.js";
import { decodeStrictUtf8, splitTextLines } from "./text-file.js";

/** 枚举两个需要人工确认的文件副作用 Tool。 */
type FileToolName = "edit_file" | "write_file";

/** 描述具体文件 Tool 根据同一目标快照计算出的内容变化。 */
type FileChangeCalculation =
  | Readonly<{ ok: true; content: string; operation: "edit" | "create" | "overwrite" }>
  | Readonly<{ ok: false; error: string }>;

type FileChangeCalculator = (
  target: Readonly<{ exists: boolean; originalContent: string }>,
) => FileChangeCalculation;

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
  parentIdentity: FileSystemIdentity;
  fileMode: number | undefined;
  scope: "workspace" | "external";
  workspace: ToolWorkspace;
}>;

/** 表示文件预检成功，或无需确认即可返回模型的安全失败。 */
export type PreparedFileResult =
  | Readonly<{ ok: true; preparedTool: PreparedFileTool }>
  | Readonly<{ ok: false; result: ToolFailedResult }>;

/** 描述确认预览绑定的已有文件内容或不存在状态。 */
type FileSystemIdentifier = number | bigint;

type TargetFingerprint =
  | Readonly<{ kind: "missing" }>
  | Readonly<{
      kind: "file";
      sha256: string;
      device: FileSystemIdentifier;
      inode: FileSystemIdentifier;
    }>;

/** 绑定确认时父目录的文件系统身份，防止同路径目录被替换。 */
type FileSystemIdentity = Readonly<{
  device: FileSystemIdentifier;
  inode: FileSystemIdentifier;
}>;

/** 保存预检时解析出的真实目标、原始内容与文件模式。 */
type ResolvedFileTarget = Readonly<{
  absolutePath: string;
  displayPath: string;
  parentRealPath: string;
  parentIdentity: FileSystemIdentity;
  exists: boolean;
  originalContent: string;
  fingerprint: TargetFingerprint;
  fileMode: number | undefined;
  scope: "workspace" | "external";
}>;

/** 基于具体 Tool 已校验的输入解析目标，并生成不可截断的确认预览。 */
export async function prepareFileChange(
  toolName: FileToolName,
  requestedPath: string,
  workspace: ToolWorkspace,
  calculateChange: FileChangeCalculator,
): Promise<PreparedFileResult> {
  try {
    const target = await resolveFileTarget(requestedPath, workspace);
    const calculatedChange = calculateChange(
      Object.freeze({ exists: target.exists, originalContent: target.originalContent }),
    );
    if (!calculatedChange.ok) {
      return failedFilePreparation(calculatedChange.error);
    }
    if (calculatedChange.content === target.originalContent && target.exists) {
      return failedFilePreparation(`${toolName} 没有产生内容变化。`);
    }

    const patch = createTwoFilesPatch(
      target.exists ? `a/${target.displayPath}` : "/dev/null",
      `b/${target.displayPath}`,
      target.originalContent,
      calculatedChange.content,
      target.exists ? "before" : "missing",
      "after",
      { context: 3 },
    );
    const previewResult = boundToolOutput([
      `operation: ${calculatedChange.operation}`,
      `path: ${target.displayPath}`,
      ...splitTextLines(patch),
    ]);
    if (previewResult.truncated) {
      return failedFilePreparation(`${toolName} 确认预览超过 64 KiB 或 2,000 行，请缩小修改。`);
    }
    return Object.freeze({
      ok: true,
      preparedTool: Object.freeze({
        toolName,
        target: target.displayPath,
        preview: previewResult.content,
        operation: calculatedChange.operation,
        absolutePath: target.absolutePath,
        parentRealPath: target.parentRealPath,
        parentIdentity: target.parentIdentity,
        newContent: calculatedChange.content,
        expectedFingerprint: target.fingerprint,
        fileMode: target.fileMode,
        scope: target.scope,
        workspace,
      }),
    });
  } catch (error) {
    return failedFilePreparation(toSafeFileError(error));
  }
}

/** 复核确认所见目标后，以同目录临时文件和原子 rename 应用准确内容。 */
export async function executePreparedFileTool(
  preparedTool: PreparedFileTool,
  abortSignal: AbortSignal,
): Promise<ToolExecutionResult> {
  if (abortSignal.aborted) {
    return failedToolResult("Run 已停止，文件未写入。");
  }
  const fingerprintMatches = await matchesPreparedTarget(preparedTool).catch(() => false);
  if (!fingerprintMatches) {
    return failedToolResult("stale target：目标在确认后发生变化，文件未写入。");
  }
  if (abortSignal.aborted) {
    return failedToolResult("Run 已停止，文件未写入。");
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
      return failedToolResult("Run 已停止，文件未写入。");
    }
    if (!(await matchesPreparedTarget(preparedTool))) {
      await unlink(temporaryFilePath).catch(() => undefined);
      temporaryFileCreated = false;
      return failedToolResult("stale target：目标在确认后发生变化，文件未写入。");
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
    return failedToolResult(toSafeFileError(error));
  }
}

/** 解析已有或待创建文件，并把一个精确目标绑定到 workspace 或 external 范围。 */
async function resolveFileTarget(
  requestedPath: string,
  workspace: ToolWorkspace,
): Promise<ResolvedFileTarget> {
  const absoluteRequest = isAbsolute(requestedPath) || win32.isAbsolute(requestedPath);
  if (!absoluteRequest) {
    validateWorkspaceRelativePath(requestedPath, "文件 Tool path");
  }
  const lexicalTargetPath = resolve(
    absoluteRequest ? requestedPath : resolve(workspace.workspaceRoot, requestedPath),
  );
  const scope = isPathSameOrInside(workspace.workspaceRoot, lexicalTargetPath)
    ? "workspace"
    : "external";
  if (absoluteRequest && scope === "external") {
    validateExternalAbsoluteFilePath(requestedPath);
  }
  const lexicalParentPath = dirname(lexicalTargetPath);
  const parentRealPath = await realpath(lexicalParentPath);
  const parentStats = await lstat(parentRealPath);
  if (!parentStats.isDirectory()) {
    throw new Error("文件 Tool 的父路径不是目录。");
  }
  if (scope === "external" && !arePathsEqual(lexicalParentPath, parentRealPath)) {
    throw new Error("外部文件路径不能经过 Symbolic Link 或 Reparse Point。");
  }
  assertAllowedPath(parentRealPath, workspace, scope);
  const targetPath = join(parentRealPath, basename(lexicalTargetPath));
  const displayPath =
    scope === "workspace"
      ? normalizeRelativePath(relative(workspace.workspaceRoot, targetPath))
      : targetPath;
  const parentIdentity = fileSystemIdentity(parentStats);
  let targetStats: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    targetStats = await lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  if (targetStats === null) {
    assertAllowedPath(targetPath, workspace, scope);
    return Object.freeze({
      absolutePath: targetPath,
      displayPath,
      parentRealPath,
      parentIdentity,
      exists: false,
      originalContent: "",
      fingerprint: Object.freeze({ kind: "missing" }),
      fileMode: undefined,
      scope,
    });
  }

  if (targetStats.isSymbolicLink()) {
    throw new Error("文件 Tool 目标不能是 Symbolic Link 或 Reparse Point。");
  }
  const targetRealPath = await realpath(targetPath);
  if (scope === "external" && !arePathsEqual(targetPath, targetRealPath)) {
    throw new Error("外部文件路径不能经过 Symbolic Link 或 Reparse Point。");
  }
  assertAllowedPath(targetRealPath, workspace, scope);
  const actualStats = await stat(targetRealPath);
  if (!actualStats.isFile()) {
    throw new Error("文件 Tool 目标不是普通文件。");
  }
  const originalBytes = await readFile(targetRealPath);
  return Object.freeze({
    absolutePath: targetRealPath,
    displayPath:
      scope === "workspace"
        ? normalizeRelativePath(relative(workspace.workspaceRoot, targetRealPath))
        : targetRealPath,
    parentRealPath: dirname(targetRealPath),
    parentIdentity,
    exists: true,
    originalContent: decodeStrictUtf8(originalBytes),
    fingerprint: fingerprintBytes(originalBytes, actualStats),
    fileMode: actualStats.mode & 0o777,
    scope,
  });
}

/** 复核目标存在状态、真实路径、内容指纹及父目录边界均未变化。 */
async function matchesPreparedTarget(preparedTool: PreparedFileTool): Promise<boolean> {
  const currentParentRealPath = await realpath(dirname(preparedTool.absolutePath));
  if (!arePathsEqual(currentParentRealPath, preparedTool.parentRealPath)) {
    return false;
  }
  const currentParentStats = await lstat(currentParentRealPath);
  if (
    !currentParentStats.isDirectory() ||
    !sameFileSystemIdentity(currentParentStats, preparedTool.parentIdentity)
  ) {
    return false;
  }
  assertAllowedPath(currentParentRealPath, preparedTool.workspace, preparedTool.scope);
  if (preparedTool.expectedFingerprint.kind === "missing") {
    try {
      await lstat(preparedTool.absolutePath);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
  const currentLexicalStats = await lstat(preparedTool.absolutePath);
  if (currentLexicalStats.isSymbolicLink()) {
    return false;
  }
  const currentRealPath = await realpath(preparedTool.absolutePath);
  if (!arePathsEqual(currentRealPath, preparedTool.absolutePath)) {
    return false;
  }
  assertAllowedPath(currentRealPath, preparedTool.workspace, preparedTool.scope);
  const currentStats = await stat(currentRealPath);
  if (
    !currentStats.isFile() ||
    currentStats.dev !== preparedTool.expectedFingerprint.device ||
    currentStats.ino !== preparedTool.expectedFingerprint.inode
  ) {
    return false;
  }
  const currentBytes = await readFile(currentRealPath);
  return (
    fingerprintBytes(currentBytes, currentStats).sha256 === preparedTool.expectedFingerprint.sha256
  );
}

/** 校验真实目标仍符合确认时的 workspace 或 external 范围。 */
function assertAllowedPath(
  targetPath: string,
  workspace: ToolWorkspace,
  scope: "workspace" | "external",
): void {
  if (isPathSameOrInside(workspace.sessionDirectory, targetPath)) {
    throw new Error("文件 Tool path 命中 Session 保留目录。");
  }
  if (scope === "workspace") {
    if (!isPathSameOrInside(workspace.workspaceRoot, targetPath)) {
      throw new Error("文件 Tool path 越出工作区。");
    }
    return;
  }
  if (isProtectedSystemPath(targetPath)) {
    throw new Error("外部文件 path 命中系统保护目录。");
  }
  if (arePathsEqual(parse(targetPath).root, targetPath)) {
    throw new Error("外部文件 path 不能是卷根目录。");
  }
}

/** 在文件系统访问前拒绝不能表达为单个本地文件的绝对路径。 */
function validateExternalAbsoluteFilePath(requestedPath: string): void {
  const slashNormalizedPath = requestedPath.replaceAll("/", "\\");
  if (
    slashNormalizedPath.startsWith("\\\\") ||
    slashNormalizedPath.startsWith("\\?\\") ||
    slashNormalizedPath.startsWith("\\.\\")
  ) {
    throw new Error("外部文件 path 不接受 UNC 或设备命名空间。");
  }
  if (/[*?[\]{}]/u.test(requestedPath)) {
    throw new Error("外部文件 path 必须是精确文件，不能包含 Glob。");
  }
  if (win32.isAbsolute(requestedPath) && slashNormalizedPath.slice(2).includes(":")) {
    throw new Error("外部文件 path 不接受 Alternate Data Stream。");
  }
  const normalizedPath = resolve(requestedPath);
  const parsedPath = parse(normalizedPath);
  const fileName = basename(normalizedPath);
  if (
    arePathsEqual(parsedPath.root, normalizedPath) ||
    fileName.length === 0 ||
    fileName === "." ||
    fileName === ".."
  ) {
    throw new Error("外部文件 path 必须指向一个文件名，不能是卷根目录。");
  }
}

/** 用当前主机的真实系统目录建立不可批准的保守边界。 */
function isProtectedSystemPath(targetPath: string): boolean {
  const protectedRoots =
    process.platform === "win32"
      ? [
          process.env.SystemRoot,
          process.env.WINDIR,
          process.env.ProgramFiles,
          process.env["ProgramFiles(x86)"],
          process.env.ProgramData,
        ]
      : ["/bin", "/boot", "/dev", "/etc", "/proc", "/sbin", "/sys", "/usr", "/var"];
  return protectedRoots.some(
    (protectedRoot) => protectedRoot !== undefined && isPathSameOrInside(protectedRoot, targetPath),
  );
}

/** 将平台路径分隔符统一为模型与 Session 可稳定使用的斜杠。 */
function normalizeRelativePath(filePath: string): string {
  return filePath.split(sep).join("/");
}

/** 为已有文件内容创建确认后复核使用的 SHA-256 指纹。 */
function fingerprintBytes(
  bytes: Uint8Array,
  stats: Awaited<ReturnType<typeof stat>>,
): Extract<TargetFingerprint, { kind: "file" }> {
  return Object.freeze({
    kind: "file",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    device: stats.dev,
    inode: stats.ino,
  });
}

function fileSystemIdentity(stats: Awaited<ReturnType<typeof lstat>>): FileSystemIdentity {
  return Object.freeze({ device: stats.dev, inode: stats.ino });
}

function sameFileSystemIdentity(
  stats: Awaited<ReturnType<typeof lstat>>,
  identity: FileSystemIdentity,
): boolean {
  return stats.dev === identity.device && stats.ino === identity.inode;
}

/** 创建一个无需确认即可返回模型的文件预检失败。 */
export function failedFilePreparation(error: string): PreparedFileResult {
  return Object.freeze({
    ok: false,
    result: failedToolResult(error),
  });
}

/** 收敛文件系统错误，避免绝对路径或堆栈进入模型与 TUI。 */
function toSafeFileError(error: unknown): string {
  const errorCode = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof errorCode === "string") {
    return `文件 Tool 操作失败：${errorCode}`;
  }
  return error instanceof Error ? error.message : "文件 Tool 操作失败。";
}
