import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { arePathsEqual, isPathSameOrInside } from "./workspace-path.js";

type WriteRequest =
  | Readonly<{
      kind: "file";
      workspaceRoot: string;
      filePath: string;
      fileIdentity?: string;
    }>
  | Readonly<{ kind: "exclusive"; workspaceRoots: readonly string[] }>;

type PendingWrite = Readonly<{
  request: WriteRequest;
  grant(): void;
  cancel(): void;
}>;

export type WorkspaceAccess = Readonly<{
  acquireFileWrite(
    workspaceRoot: string,
    filePath: string,
    signal?: AbortSignal,
  ): Promise<() => void>;
  acquireExclusiveWrite(
    workspaceRoots: readonly string[],
    signal?: AbortSignal,
  ): Promise<() => void>;
}>;

/** 等待可取消；调用方必须在批准后取锁，并在 finally 中释放。只协调本进程受管写入。 */
export function createWorkspaceAccess(): WorkspaceAccess {
  const activeWrites = new Set<WriteRequest>();
  const pendingWrites: PendingWrite[] = [];

  const dispatch = () => {
    for (let index = 0; index < pendingWrites.length; ) {
      const pendingWrite = pendingWrites[index];
      if (pendingWrite === undefined) break;
      // 已排队的命令阻止后来的同区文件写入抢占，其他工作区与无关文件仍能推进。
      const blocked =
        [...activeWrites].some((active) => writesConflict(active, pendingWrite.request)) ||
        pendingWrites
          .slice(0, index)
          .some((previous) => writesConflict(previous.request, pendingWrite.request));
      if (blocked) {
        index += 1;
        continue;
      }
      pendingWrites.splice(index, 1);
      activeWrites.add(pendingWrite.request);
      pendingWrite.grant();
    }
  };

  const acquire = (request: WriteRequest, signal?: AbortSignal): Promise<() => void> => {
    if (signal?.aborted) return Promise.reject(new Error("工作区写入等待已停止。"));
    return new Promise((resolveLease, rejectLease) => {
      const pendingWrite: PendingWrite = {
        request,
        grant() {
          signal?.removeEventListener("abort", pendingWrite.cancel);
          let released = false;
          resolveLease(() => {
            if (released) return;
            released = true;
            activeWrites.delete(request);
            dispatch();
          });
        },
        cancel() {
          const index = pendingWrites.indexOf(pendingWrite);
          if (index < 0) return;
          pendingWrites.splice(index, 1);
          signal?.removeEventListener("abort", pendingWrite.cancel);
          rejectLease(new Error("工作区写入等待已停止。"));
          dispatch();
        },
      };
      pendingWrites.push(pendingWrite);
      signal?.addEventListener("abort", pendingWrite.cancel, { once: true });
      if (signal?.aborted) pendingWrite.cancel();
      else dispatch();
    });
  };

  return Object.freeze({
    async acquireFileWrite(workspaceRoot, filePath, signal) {
      const [actualWorkspaceRoot, actualFilePath] = await Promise.all([
        resolveActualPath(workspaceRoot),
        resolveActualPath(filePath),
      ]);
      let fileIdentity: string | undefined;
      try {
        const fileStats = await stat(actualFilePath, { bigint: true });
        if (fileStats.ino !== 0n) fileIdentity = `${fileStats.dev}:${fileStats.ino}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return acquire(
        {
          kind: "file",
          workspaceRoot: actualWorkspaceRoot,
          filePath: actualFilePath,
          ...(fileIdentity === undefined ? {} : { fileIdentity }),
        },
        signal,
      );
    },
    async acquireExclusiveWrite(workspaceRoots, signal) {
      return acquire(
        {
          kind: "exclusive",
          workspaceRoots: await Promise.all(workspaceRoots.map(resolveActualPath)),
        },
        signal,
      );
    },
  });
}

/** 根、成员及受管 Git 默认共用；独立测试可以显式注入隔离实例。 */
export const sharedWorkspaceAccess = createWorkspaceAccess();

function writesConflict(left: WriteRequest, right: WriteRequest): boolean {
  if (left.kind === "file" && right.kind === "file") {
    return (
      arePathsEqual(left.filePath, right.filePath) ||
      (left.fileIdentity !== undefined && left.fileIdentity === right.fileIdentity)
    );
  }
  if (left.kind === "exclusive" && right.kind === "exclusive") {
    return left.workspaceRoots.some((leftRoot) =>
      right.workspaceRoots.some((rightRoot) => pathsOverlap(leftRoot, rightRoot)),
    );
  }
  const exclusiveWrite = left.kind === "exclusive" ? left : right;
  const fileWrite = left.kind === "file" ? left : right;
  if (exclusiveWrite.kind !== "exclusive" || fileWrite.kind !== "file") return false;
  return exclusiveWrite.workspaceRoots.some(
    (workspaceRoot) =>
      pathsOverlap(workspaceRoot, fileWrite.workspaceRoot) ||
      isPathSameOrInside(workspaceRoot, fileWrite.filePath),
  );
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathSameOrInside(left, right) || isPathSameOrInside(right, left);
}

async function resolveActualPath(path: string): Promise<string> {
  let existingPath = resolve(path);
  const missingNames: string[] = [];
  for (;;) {
    try {
      return join(await realpath(existingPath), ...missingNames.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parentPath = dirname(existingPath);
      if (parentPath === existingPath) throw error;
      missingNames.push(basename(existingPath));
      existingPath = parentPath;
    }
  }
}
