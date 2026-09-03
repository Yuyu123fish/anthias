import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

/** 提供固定 Tool 执行时唯一可见的工作区与保留目录。 */
export type ToolWorkspace = Readonly<{
  workspaceRoot: string;
  sessionDirectory: string;
}>;

/** 保存一个经过真实路径校验的工作区文件或目录。 */
export type ResolvedWorkspacePath = Readonly<{
  absolutePath: string;
  relativePath: string;
}>;

/** 解析一个工作区相对路径并执行真实路径与保留目录校验。 */
export async function resolveExistingWorkspacePath(
  requestedPath: string,
  workspace: ToolWorkspace,
  allowSessionDirectory = false,
): Promise<ResolvedWorkspacePath> {
  validateWorkspaceRelativePath(requestedPath, "Tool path");
  return resolveExistingAbsoluteWorkspacePath(
    resolve(workspace.workspaceRoot, requestedPath),
    workspace,
    allowSessionDirectory,
  );
}

/** 校验一个已组合的绝对路径仍位于工作区且未进入 Session 保留目录。 */
export async function resolveExistingAbsoluteWorkspacePath(
  candidatePath: string,
  workspace: ToolWorkspace,
  allowSessionDirectory = false,
): Promise<ResolvedWorkspacePath> {
  const actualPath = await realpath(candidatePath);
  if (!isPathSameOrInside(workspace.workspaceRoot, actualPath)) {
    throw new Error("Tool path 越出工作区。");
  }
  if (!allowSessionDirectory && isPathSameOrInside(workspace.sessionDirectory, actualPath)) {
    throw new Error("Tool path 命中 Session 保留目录。");
  }
  return Object.freeze({
    absolutePath: actualPath,
    relativePath: normalizeWorkspaceRelativePath(relative(workspace.workspaceRoot, actualPath)),
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
  const relativePath = relative(parentPath, targetPath);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== "..");
}

/** 把平台分隔符统一为模型可复用的正斜杠相对路径。 */
export function normalizeWorkspaceRelativePath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}
