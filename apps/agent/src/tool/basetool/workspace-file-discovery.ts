import { glob as nodeGlob, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  isPathSameOrInside,
  normalizeWorkspaceRelativePath,
  type ResolvedWorkspacePath,
  resolveExistingAbsoluteWorkspacePath,
  resolveExistingWorkspacePath,
  type ToolWorkspace,
  validateWorkspaceRelativePath,
} from "../workspace-path.js";

/** 保存稳定文件集合以及是否因候选上限未穷尽。 */
type DiscoveredWorkspaceFiles = Readonly<{
  paths: readonly ResolvedWorkspacePath[];
  truncated: boolean;
}>;

const FILE_DISCOVERY_LIMIT = 10000;

/** 发现并真实路径校验文件，保证稳定排序且隔离 Session 目录。 */
export async function discoverWorkspaceFiles(
  pattern: string,
  basePath: string,
  workspace: ToolWorkspace,
  abortSignal: AbortSignal,
): Promise<DiscoveredWorkspaceFiles> {
  validateWorkspaceRelativePath(pattern, "Glob pattern");
  const base = await resolveExistingWorkspacePath(basePath, workspace);
  const baseStats = await stat(base.absolutePath);
  if (!baseStats.isDirectory()) {
    throw new Error(`搜索基准不是目录：${base.relativePath}`);
  }
  const files: ResolvedWorkspacePath[] = [];
  let truncated = false;
  const sessionExcludePatterns = createSessionGlobExclusions(
    base.absolutePath,
    workspace.sessionDirectory,
  );
  for await (const candidate of nodeGlob(pattern, {
    cwd: base.absolutePath,
    exclude: sessionExcludePatterns,
  })) {
    if (abortSignal.aborted) {
      throw new Error("Tool 执行已停止。");
    }
    const candidatePath = resolve(base.absolutePath, candidate);
    let resolvedCandidate: ResolvedWorkspacePath;
    try {
      resolvedCandidate = await resolveExistingAbsoluteWorkspacePath(candidatePath, workspace);
      if (!(await stat(resolvedCandidate.absolutePath)).isFile()) {
        continue;
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("Session 保留目录")) {
        continue;
      }
      throw error;
    }
    files.push(resolvedCandidate);
    if (files.length >= FILE_DISCOVERY_LIMIT) {
      truncated = true;
      break;
    }
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
  return Object.freeze({ paths: Object.freeze(files), truncated });
}

/** 在 Node Glob 进入目录前排除 Session 路径，避免先遍历再过滤。 */
function createSessionGlobExclusions(
  basePath: string,
  sessionDirectory: string,
): readonly string[] {
  if (!isPathSameOrInside(basePath, sessionDirectory)) {
    return Object.freeze([]);
  }
  const sessionRelativePath = normalizeWorkspaceRelativePath(relative(basePath, sessionDirectory));
  return Object.freeze([sessionRelativePath, `${sessionRelativePath}/**`]);
}
