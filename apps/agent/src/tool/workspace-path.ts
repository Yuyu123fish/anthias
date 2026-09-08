import { realpathSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

/** 提供固定 Tool 执行时唯一可见的工作区与保留目录。 */
export type ToolWorkspace = Readonly<{
  workspaceRoot: string;
  sessionDirectory: string;
  protectedPaths?: readonly string[];
  allowExternalPaths?: boolean;
}>;

/** 保存一个经过真实路径校验的工作区文件或目录。 */
export type ResolvedWorkspacePath = Readonly<{
  absolutePath: string;
  relativePath: string;
}>;

/** 按当前调用的访问范围解析路径；完整访问仍保留应用数据保护。 */
export async function resolveExistingWorkspacePath(
  requestedPath: string,
  workspace: ToolWorkspace,
): Promise<ResolvedWorkspacePath> {
  if (workspace.allowExternalPaths === true) {
    if (requestedPath.length === 0) throw new Error("Tool path 不能为空。");
  } else {
    validateWorkspaceRelativePath(requestedPath, "Tool path");
  }
  return resolveExistingAbsoluteWorkspacePath(
    resolve(workspace.workspaceRoot, requestedPath),
    workspace,
  );
}

/** 真实路径复核不得因开放外部访问而跳过应用配置、授权与 Session 保护。 */
export async function resolveExistingAbsoluteWorkspacePath(
  candidatePath: string,
  workspace: ToolWorkspace,
): Promise<ResolvedWorkspacePath> {
  const actualPath = await realpath(candidatePath);
  if (
    workspace.allowExternalPaths !== true &&
    !isPathSameOrInside(workspace.workspaceRoot, actualPath)
  ) {
    throw new Error("Tool path 越出工作区。");
  }
  if (isReservedToolPath(actualPath, workspace)) {
    throw new Error("Tool path 命中 Session 保留目录。");
  }
  return Object.freeze({
    absolutePath: actualPath,
    relativePath: normalizeWorkspaceRelativePath(relative(workspace.workspaceRoot, actualPath)),
  });
}

/** 应用配置与授权记录不可由固定 Tool 读取或写入；真实路径和文件身份同时防止别名绕过。 */
export function isReservedToolPath(targetPath: string, workspace: ToolWorkspace): boolean {
  return [workspace.sessionDirectory, ...(workspace.protectedPaths ?? [])].some((directory) => {
    if (isPathSameOrInside(directory, targetPath)) return true;
    try {
      if (isPathSameOrInside(realpathSync(directory), targetPath)) return true;
      const protectedStat = statSync(directory);
      const targetStat = statSync(targetPath);
      return (
        protectedStat.isFile() &&
        protectedStat.ino !== 0 &&
        protectedStat.ino === targetStat.ino &&
        protectedStat.dev === targetStat.dev
      );
    } catch {
      return false;
    }
  });
}

/** 拒绝绝对路径、父目录逃逸和会改变搜索基准的 Glob 片段。 */
export function validateWorkspaceRelativePath(requestedPath: string, label: string): void {
  if (
    requestedPath.length === 0 ||
    isAbsolute(requestedPath) ||
    win32.isAbsolute(requestedPath) ||
    requestedPath.replaceAll("\\", "/").split("/").includes("..")
  ) {
    throw new Error(`${label} 必须是工作区相对路径。`);
  }
}

/** 使用平台路径语义判断目标是否等于或位于父目录内。 */
export function isPathSameOrInside(parentPath: string, targetPath: string): boolean {
  const normalizedParentPath = normalizePathForComparison(parentPath);
  const normalizedTargetPath = normalizePathForComparison(targetPath);
  const relativePath = relative(normalizedParentPath, normalizedTargetPath);
  return (
    relativePath === "" ||
    (!isAbsolute(relativePath) &&
      !win32.isAbsolute(relativePath) &&
      !relativePath.startsWith(`..${sep}`) &&
      relativePath !== "..")
  );
}

/** 按当前平台的大小写语义判断两个绝对路径是否表示同一位置。 */
export function arePathsEqual(leftPath: string, rightPath: string): boolean {
  return normalizePathForComparison(leftPath) === normalizePathForComparison(rightPath);
}

/** 把平台分隔符统一为模型可复用的正斜杠相对路径。 */
export function normalizeWorkspaceRelativePath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

function normalizePathForComparison(filePath: string): string {
  const normalizedPath = resolve(filePath);
  return process.platform === "win32" ? normalizedPath.toLocaleLowerCase("en-US") : normalizedPath;
}
