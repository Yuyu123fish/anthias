import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isRecord } from "./input-validation.js";
import { arePathsEqual, isPathSameOrInside } from "./workspace-path.js";

type WriteRequest =
  | Readonly<{ kind: "file"; workspaceRoot: string; filePath: string; fileIdentity?: string }>
  | Readonly<{ kind: "exclusive"; workspaceRoots: readonly string[] }>;
type PendingWrite = Readonly<{
  request: WriteRequest;
  grant(): void;
  reject(error: Error): void;
}>;

/** 阻塞只保存已经发生的清理不明事实，不代表完整命令日志。 */
export type WorkspaceBlock = Readonly<{
  blockId: string;
  workspaceRoots: readonly string[];
  sessionId: string;
  toolCallId: string;
  reason: string;
  createdAt: string;
  persisted: boolean;
}>;
export type WorkspaceRecoveryResult = Readonly<{
  status: "recovered" | "blocked" | "not_found";
  message: string;
}>;
export type ExclusiveWriteLease = (() => void) & Readonly<{ workspaceRoots: readonly string[] }>;

export type WorkspaceAccess = Readonly<{
  ready(): Promise<void>;
  acquireFileWrite(
    workspaceRoot: string,
    filePath: string,
    signal?: AbortSignal,
  ): Promise<() => void>;
  acquireExclusiveWrite(
    workspaceRoots: readonly string[],
    signal?: AbortSignal,
  ): Promise<ExclusiveWriteLease>;
  block(
    details: Omit<WorkspaceBlock, "blockId" | "createdAt" | "persisted">,
    checkCleanup?: (signal: AbortSignal) => Promise<boolean>,
  ): Promise<WorkspaceBlock>;
  snapshot(): readonly WorkspaceBlock[];
  recover(
    blockId: string,
    signal: AbortSignal,
    confirmedByUser?: boolean,
  ): Promise<WorkspaceRecoveryResult>;
  subscribe(listener: () => void): () => void;
}>;

/** 协调当前进程写入；阻塞持久化失败时仍保留内存保护，不据此放开写入。 */
export function createWorkspaceAccess(options: { directory?: string } = {}): WorkspaceAccess {
  const activeWrites = new Set<WriteRequest>();
  const pendingWrites: PendingWrite[] = [];
  const blocks = new Map<string, WorkspaceBlock>();
  const cleanupChecks = new Map<string, (signal: AbortSignal) => Promise<boolean>>();
  const pendingSaves = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  const recovering = new Map<string, Promise<WorkspaceRecoveryResult>>();
  let loadFailure: string | null = null;
  const notify = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* 呈现失败不能解除工作区保护。 */
      }
    }
  };
  const ready = (async () => {
    if (!options.directory) return;
    try {
      let files: string[];
      try {
        files = await readdir(options.directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const file of files.filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))) {
        const record: unknown = JSON.parse(await readFile(join(options.directory, file), "utf8"));
        if (!isWorkspaceBlock(record) || file !== record.blockId + ".json")
          throw new Error("invalid workspace block");
        blocks.set(record.blockId, Object.freeze({ ...record, persisted: true }));
      }
      notify();
    } catch {
      loadFailure = "工作区阻塞记录不可读取，请检查受管数据目录；写入未开放。";
      notify();
    }
  })();
  const blockedFor = (request: WriteRequest) =>
    [...blocks.values()].find((block) =>
      writesConflict(request, { kind: "exclusive", workspaceRoots: block.workspaceRoots }),
    );
  const blockedError = (block: WorkspaceBlock) =>
    new Error(
      `workspace_blocked: ${block.blockId}; owner: ${block.sessionId}; toolCallId: ${block.toolCallId}; ${block.reason}`,
    );
  const dispatch = () => {
    for (let index = 0; index < pendingWrites.length; ) {
      const pendingWrite = pendingWrites[index];
      if (!pendingWrite) break;
      const block = blockedFor(pendingWrite.request);
      if (block) {
        pendingWrites.splice(index, 1);
        pendingWrite.reject(blockedError(block));
        continue;
      }
      // 已排队命令保留顺序；不相关工作区不受它阻挡。
      if (
        [...activeWrites].some((active) => writesConflict(active, pendingWrite.request)) ||
        pendingWrites
          .slice(0, index)
          .some((previous) => writesConflict(previous.request, pendingWrite.request))
      ) {
        index++;
        continue;
      }
      pendingWrites.splice(index, 1);
      activeWrites.add(pendingWrite.request);
      pendingWrite.grant();
    }
  };
  const acquire = async (request: WriteRequest, signal?: AbortSignal): Promise<() => void> => {
    await ready;
    if (loadFailure) throw new Error(loadFailure);
    if (signal?.aborted) throw new Error("工作区写入等待已停止。");
    const block = blockedFor(request);
    if (block) throw blockedError(block);
    return new Promise((resolveLease, rejectLease) => {
      const cancel = () => {
        const index = pendingWrites.indexOf(pendingWrite);
        if (index < 0) return;
        pendingWrites.splice(index, 1);
        pendingWrite.reject(new Error("工作区写入等待已停止。"));
        dispatch();
      };
      const pendingWrite: PendingWrite = {
        request,
        grant() {
          signal?.removeEventListener("abort", cancel);
          let released = false;
          resolveLease(() => {
            if (released) return;
            released = true;
            activeWrites.delete(request);
            dispatch();
          });
        },
        reject(error) {
          signal?.removeEventListener("abort", cancel);
          rejectLease(error);
        },
      };
      pendingWrites.push(pendingWrite);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      else dispatch();
    });
  };
  return Object.freeze({
    ready: () => ready,
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
      const actualWorkspaceRoots = Object.freeze(
        await Promise.all(workspaceRoots.map(resolveActualPath)),
      );
      const release = await acquire(
        { kind: "exclusive", workspaceRoots: actualWorkspaceRoots },
        signal,
      );
      return Object.freeze(Object.assign(release, { workspaceRoots: actualWorkspaceRoots }));
    },
    snapshot: () => Object.freeze([...blocks.values()]),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async block(details, checkCleanup) {
      await ready;
      const block: WorkspaceBlock = Object.freeze({
        ...details,
        // 使用取锁时冻结的资源键；命令可能已经破坏路径，不能在移交保护时再次访问文件系统。
        workspaceRoots: Object.freeze(details.workspaceRoots.map((root) => resolve(root))),
        blockId: randomUUID(),
        createdAt: new Date().toISOString(),
        persisted: false,
      });
      blocks.set(block.blockId, block);
      if (checkCleanup) cleanupChecks.set(block.blockId, checkCleanup);
      // 先拒绝排队，再持久化；磁盘缓慢不能使其他 Agent 继续无声等待。
      dispatch();
      notify();
      const saving = (async () => {
        if (!options.directory) return;
        const temporaryPath = join(options.directory, block.blockId + ".tmp");
        try {
          await mkdir(options.directory, { recursive: true });
          await writeFile(temporaryPath, JSON.stringify({ ...block, persisted: true }) + "\n", {
            flag: "wx",
            mode: 0o600,
          });
          await rename(temporaryPath, join(options.directory, block.blockId + ".json"));
          blocks.set(block.blockId, Object.freeze({ ...block, persisted: true }));
        } catch {
          blocks.set(
            block.blockId,
            Object.freeze({
              ...block,
              reason: block.reason + "；阻塞记录未能保存，跨重启状态不可保证。",
            }),
          );
        } finally {
          await unlink(temporaryPath).catch(() => undefined);
        }
      })();
      pendingSaves.set(block.blockId, saving);
      await saving;
      pendingSaves.delete(block.blockId);
      notify();
      return blocks.get(block.blockId) ?? block;
    },
    recover(blockId, signal, confirmedByUser = false) {
      const existingRecovery = recovering.get(blockId);
      if (existingRecovery) return existingRecovery;
      const recovery = (async (): Promise<WorkspaceRecoveryResult> => {
        await ready;
        await pendingSaves.get(blockId);
        const block = blocks.get(blockId);
        if (!block) return { status: "not_found", message: "阻塞已解除或标识已过期。" };
        signal.throwIfAborted();
        let cleanupConfirmed = confirmedByUser;
        if (!cleanupConfirmed) {
          const checkCleanup = cleanupChecks.get(blockId);
          if (checkCleanup) {
            let timeout: NodeJS.Timeout | undefined;
            const cancelled = Promise.withResolvers<boolean>();
            const onAbort = () => cancelled.resolve(false);
            signal.addEventListener("abort", onAbort, { once: true });
            try {
              cleanupConfirmed = await Promise.race([
                checkCleanup(AbortSignal.any([signal, AbortSignal.timeout(2000)])).catch(
                  () => false,
                ),
                new Promise<boolean>((resolveTimeout) => {
                  timeout = setTimeout(() => resolveTimeout(false), 2000);
                }),
                cancelled.promise,
              ]);
            } finally {
              clearTimeout(timeout);
              signal.removeEventListener("abort", onAbort);
            }
          }
        }
        signal.throwIfAborted();
        if (!cleanupConfirmed)
          return {
            status: "blocked",
            message:
              (cleanupChecks.has(blockId)
                ? "本次有界清理尚未确认完成。根可稍后重试 agent_recover_workspace，不要重试普通命令；持续失败再由用户外部清理。"
                : "当前进程没有原资源句柄，需要用户核验并清理外部资源。") +
              "外部清理后，请用户直接输入 /agent recover " +
              blockId +
              " confirm-cleanup；普通对话中的‘已清理’不能代替该确认。",
          };
        if (blocks.get(blockId) !== block)
          return { status: "blocked", message: "阻塞记录已变化，请重新检查。" };
        if (options.directory) {
          // 先持久保存解除依据，再删除阻塞；写盘失败时保持保护。
          await mkdir(options.directory, { recursive: true });
          await writeFile(
            join(options.directory, blockId + ".resolved"),
            JSON.stringify({
              ...block,
              resolvedAt: new Date().toISOString(),
              confirmedBy: confirmedByUser ? "user" : "runtime",
            }) + "\n",
            { mode: 0o600 },
          );
          signal.throwIfAborted();
          await unlink(join(options.directory, blockId + ".json")).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          });
        }
        blocks.delete(blockId);
        cleanupChecks.delete(blockId);
        dispatch();
        notify();
        return {
          status: "recovered",
          message: confirmedByUser
            ? "已按用户外部清理确认解除阻塞，未重放工具。"
            : "已确认清理并解除阻塞，未重放工具。",
        };
      })().finally(() => recovering.delete(blockId));
      recovering.set(blockId, recovery);
      return recovery;
    },
  });
}

/** 同一数据目录的根与成员复用协调器，测试可创建独立实例。 */
const workspaceAccessByDirectory = new Map<string, WorkspaceAccess>();
export function getWorkspaceAccess(directory: string): WorkspaceAccess {
  const key = process.platform === "win32" ? resolve(directory).toLowerCase() : resolve(directory);
  const existing = workspaceAccessByDirectory.get(key);
  if (existing) return existing;
  const access = createWorkspaceAccess({ directory: key });
  workspaceAccessByDirectory.set(key, access);
  return access;
}
export const sharedWorkspaceAccess = createWorkspaceAccess();

function isWorkspaceBlock(value: unknown): value is WorkspaceBlock {
  return (
    isRecord(value) &&
    typeof value.blockId === "string" &&
    /^[a-f0-9-]{36}$/.test(value.blockId) &&
    Array.isArray(value.workspaceRoots) &&
    value.workspaceRoots.length > 0 &&
    value.workspaceRoots.every((root) => typeof root === "string" && isAbsolute(root)) &&
    typeof value.sessionId === "string" &&
    typeof value.toolCallId === "string" &&
    typeof value.reason === "string" &&
    typeof value.createdAt === "string"
  );
}

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
