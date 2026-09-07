import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { type MemoryEntry, type MemoryQuery, type MemoryStatus, memoryHash } from "./schema.js";

const executeFile = promisify(execFile);
export type MemoryProject = Readonly<{ id: string; root: string; branch: string | null }>;

/** common Git 目录让同仓库工作树共享身份，未提交仓库也能正常识别。 */
export async function resolveMemoryProject(
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<MemoryProject> {
  const workspace = await realpath(workspaceRoot);
  let root = workspace;
  let identity = workspace;
  let branch: string | null = null;
  try {
    const result = await executeFile("git", ["rev-parse", "--show-toplevel", "--git-common-dir"], {
      cwd: workspace,
      windowsHide: true,
      timeout: 3000,
      maxBuffer: 8192,
      ...(signal ? { signal } : {}),
    });
    const [gitRoot, commonDirectory] = result.stdout.trim().split(/\r?\n/);
    if (gitRoot && commonDirectory) {
      root = await realpath(resolve(workspace, gitRoot));
      identity = await realpath(resolve(workspace, commonDirectory));
      try {
        branch =
          (
            await executeFile("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
              cwd: workspace,
              windowsHide: true,
              timeout: 3000,
              maxBuffer: 8192,
              ...(signal ? { signal } : {}),
            })
          ).stdout.trim() || null;
      } catch {
        /* detached HEAD 保持无分支条件，仓库身份仍然有效。 */
      }
    }
  } catch {
    signal?.throwIfAborted();
  }
  const normalizedIdentity = process.platform === "win32" ? identity.toLowerCase() : identity;
  return { id: "project-" + memoryHash(normalizedIdentity).slice(0, 32), root, branch };
}
export async function memoryFileFingerprint(project: MemoryProject, path: string): Promise<string> {
  if (isAbsolute(path) || path.length > 1024) throw new Error("经验条件只能引用项目内相对路径。");
  const resolvedPath = await realpath(resolve(project.root, path));
  const relativePath = relative(project.root, resolvedPath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(".." + sep) ||
    isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).some((part) => part === ".git" || part === ".env")
  )
    throw new Error("经验条件路径不在允许范围内。");
  const metadata = await stat(resolvedPath);
  if (!metadata.isFile() || metadata.size > 256 * 1024)
    throw new Error("经验条件文件不可读取或超过 256 KiB。");
  return memoryHash(await readFile(resolvedPath, "utf8"));
}
export async function memoryStatus(
  entry: MemoryEntry,
  project: MemoryProject,
  now: number,
): Promise<MemoryStatus> {
  if (entry.status === "forgotten" || entry.status === "candidate" || entry.status === "review")
    return entry.status;
  if (entry.expiresAt !== null && Date.parse(entry.expiresAt) <= now) return "expired";
  if (entry.reviewAt !== null && Date.parse(entry.reviewAt) <= now) return "review";
  if (entry.conditions.branch !== null && entry.conditions.branch !== project.branch)
    return "review";
  for (const file of entry.conditions.files) {
    try {
      if ((await memoryFileFingerprint(project, file.path)) !== file.fingerprint) return "review";
    } catch {
      return "review";
    }
  }
  return entry.status;
}
export async function selectMemories(
  entries: readonly MemoryEntry[],
  project: MemoryProject,
  query: MemoryQuery,
  now: number,
): Promise<readonly MemoryEntry[]> {
  const selected: MemoryEntry[] = [];
  for (const entry of entries) {
    if (query.scope !== "all" && entry.scope !== "global" && entry.scope !== project.id) continue;
    if (query.id && query.id !== entry.id) continue;
    if (query.kind && query.kind !== entry.kind) continue;
    const status =
      entry.scope === "global" || entry.scope === project.id
        ? await memoryStatus(entry, project, now)
        : entry.status;
    if (query.status && query.status !== "all" && query.status !== status) continue;
    const terms = (query.text ?? "").toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (
      terms.length &&
      !terms.some((term) => (entry.content ?? "").toLocaleLowerCase().includes(term))
    )
      continue;
    selected.push(Object.freeze({ ...entry, status }));
  }
  return Object.freeze(selected.sort((left, right) => left.id.localeCompare(right.id)));
}
