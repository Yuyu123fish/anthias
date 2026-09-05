import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { readSessionJournal } from "./journal.js";
import { locateSessionStorage, removeSessionLocation } from "./locations.js";
import {
  acquireSessionLock,
  DEFAULT_SESSION_LOCK_SYSTEM,
  getSessionLockDirectory,
  inspectSessionUsageMarkers,
  releaseSessionLock,
  SessionBusyError,
  type SessionLockSystem,
} from "./lock.js";
import { hasPendingSessionMigration } from "./migration.js";
import { deriveLastActivityAt, isUuid } from "./schema.js";

const RETENTION_MILLISECONDS = 14 * 24 * 60 * 60 * 1_000;
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const DATE_DIRECTORY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const SESSION_DIRECTORY_PATTERN = /^\d{8}T\d{9}Z-([0-9a-f-]{36})$/iu;

type CleanupState = {
  cursor: string | null;
  pending: Readonly<{ source: string; trash: string; sessionId: string }> | null;
};

export type SessionCleanupResult = Readonly<{
  inspected: number;
  deleted: number;
  skipped: number;
  skipReasons: readonly string[];
  status: "completed" | "bounded" | "busy" | "unavailable";
}>;

/** 清理只消费已有使用事实，持有全局锁与单 Session 锁，不创建或恢复对话。 */
export async function cleanupExpiredSessions({
  sessionDirectory,
  now = Date.now(),
  signal,
  maximumCandidates = 200,
  maximumDurationMilliseconds = 30_000,
  lockSystem = DEFAULT_SESSION_LOCK_SYSTEM,
}: Readonly<{
  sessionDirectory: string;
  now?: number;
  signal?: AbortSignal;
  maximumCandidates?: number;
  maximumDurationMilliseconds?: number;
  lockSystem?: SessionLockSystem;
}>): Promise<SessionCleanupResult> {
  let inspected = 0;
  let deleted = 0;
  let skipped = 0;
  const skipReasons = new Set<string>();
  const deadline = Date.now() + Math.max(1, maximumDurationMilliseconds);
  const stopped = () => signal?.aborted === true || Date.now() >= deadline;
  const result = (status: SessionCleanupResult["status"]) =>
    Object.freeze({
      inspected,
      deleted,
      skipped,
      skipReasons: Object.freeze([...skipReasons]),
      status,
    });
  if (!isAbsolute(sessionDirectory) || !Number.isFinite(now) || maximumCandidates < 1) {
    return result("unavailable");
  }
  let root: string;
  try {
    root = await realpath(sessionDirectory);
    await ensureSafeDirectory(root, ".maintenance");
  } catch {
    return result("unavailable");
  }

  let globalLock: Awaited<ReturnType<typeof acquireSessionLock>>;
  try {
    globalLock = await acquireSessionLock(join(root, ".maintenance", "cleanup.lock"), lockSystem);
  } catch {
    return result("busy");
  }

  const statePath = join(root, ".maintenance", "cleanup-state.json");
  try {
    const state = await readCleanupState(root, statePath);
    if (state.pending !== null) {
      const pendingSource = state.pending.source;
      if (stopped() || !(await finishPendingDeletion(root, state, statePath, stopped))) {
        return result("bounded");
      }
      if (!(await pathExists(join(root, pendingSource)))) deleted += 1;
    }
    const dateDirectories = (await readdir(root))
      .filter((name) => DATE_DIRECTORY_PATTERN.test(name))
      .sort();
    for (const dateDirectory of dateDirectories) {
      if (!(await isSafeOwnedPath(root, join(root, dateDirectory), "directory"))) {
        continue;
      }
      const sessionDirectories = (await readdir(join(root, dateDirectory))).sort();
      for (const sessionDirectoryName of sessionDirectories) {
        const matchedDirectory = SESSION_DIRECTORY_PATTERN.exec(sessionDirectoryName);
        const sessionId = matchedDirectory?.[1];
        if (sessionId === undefined || !isUuid(sessionId)) {
          continue;
        }
        const relativeDirectory = `${dateDirectory}/${sessionDirectoryName}`;
        if (state.cursor !== null && relativeDirectory <= state.cursor) {
          continue;
        }
        if (stopped() || inspected >= maximumCandidates) {
          await writeCleanupState(statePath, state);
          return result("bounded");
        }
        inspected += 1;
        const storageDirectory = join(root, dateDirectory, sessionDirectoryName);
        let sessionLock: Awaited<ReturnType<typeof acquireSessionLock>> | null = null;
        try {
          await ensureSafeDirectory(root, `.maintenance/sessions/${sessionId}`);
          sessionLock = await acquireSessionLock(
            getSessionLockDirectory(root, sessionId),
            lockSystem,
          );
          if (!(await isSafeOwnedPath(root, storageDirectory, "directory"))) {
            throw new Error("unsafe Session directory");
          }
          if (await hasPendingSessionMigration(storageDirectory))
            throw new Error("migration authority is pending");
          const location = await locateSessionStorage(root, sessionId);
          if (
            location.source !== "schema2" ||
            location.storageDirectory !== storageDirectory ||
            location.legacyFilePath !== undefined
          ) {
            throw new Error("migration authority is pending");
          }
          const sessionFilePath = join(storageDirectory, "session.jsonl");
          if (!(await isSafeOwnedPath(root, sessionFilePath, "file"))) {
            throw new Error("unsafe Session journal");
          }
          if ((await lstat(sessionFilePath)).size > MAX_JOURNAL_BYTES) {
            throw new Error("journal exceeds maintenance read budget");
          }
          const journal = await readSessionJournal(sessionFilePath);
          if (journal.header.schemaVersion !== 2 || journal.header.sessionId !== sessionId) {
            throw new Error("Session identity mismatch");
          }
          const creationTimestamp = new Date(journal.header.createdAt).toISOString();
          const expectedDirectoryName = `${creationTimestamp.replace(/[-:.]/gu, "")}-${sessionId}`;
          if (
            dateDirectory !== creationTimestamp.slice(0, 10) ||
            sessionDirectoryName !== expectedDirectoryName
          ) {
            throw new Error("Session creation path mismatch");
          }
          const lastActivityAt = Date.parse(deriveLastActivityAt(journal.header, journal.records));
          if (!Number.isFinite(lastActivityAt) || lastActivityAt > now) {
            throw new Error("Session timestamp is uncertain");
          }
          if (now - lastActivityAt < RETENTION_MILLISECONDS) throw new Error("Session is recent");
          const usage = await inspectSessionUsageMarkers(root, sessionId, lockSystem);
          if (usage.status === "in_use") throw new Error("Session has an active owner");
          if (usage.status === "unknown") throw new Error("Session owner is uncertain");
          if (stopped() || !(await isSafeTree(root, storageDirectory, stopped))) {
            throw new Error("Session tree cannot be safely deleted");
          }
          await ensureSafeDirectory(root, ".maintenance/trash");
          const trash = `.maintenance/trash/${sessionId}-${randomUUID()}`;
          state.pending = { source: relativeDirectory, trash, sessionId };
          // 先刷新删除意图再原子移入隔离目录，进程中断后仍能完成同一个删除。
          await writeCleanupState(statePath, state);
          await rename(storageDirectory, join(root, trash));
          if (!(await finishPendingDeletion(root, state, statePath, stopped))) {
            return result("bounded");
          }
          deleted += 1;
        } catch (error) {
          skipReasons.add(safeCleanupSkipReason(error));
          skipped += 1;
          if (state.pending !== null) {
            return result("bounded");
          }
        } finally {
          if (sessionLock !== null) {
            await releaseSessionLock(sessionLock);
          }
        }
        state.cursor = relativeDirectory;
        await writeCleanupState(statePath, state);
      }
    }
    const legacyResult = await cleanLegacySessions(root, state, statePath, {
      now,
      stopped,
      remainingCandidates: maximumCandidates - inspected,
      lockSystem,
    });
    inspected += legacyResult.inspected;
    deleted += legacyResult.deleted;
    skipped += legacyResult.skipped;
    for (const reason of legacyResult.skipReasons) skipReasons.add(reason);
    if (legacyResult.status === "bounded") return result("bounded");
    state.cursor = null;
    await writeCleanupState(statePath, state);
    return result("completed");
  } catch {
    return result("unavailable");
  } finally {
    await releaseSessionLock(globalLock);
  }
}

async function finishPendingDeletion(
  root: string,
  state: CleanupState,
  statePath: string,
  stopped: () => boolean,
): Promise<boolean> {
  const pending = state.pending;
  if (pending === null) {
    return true;
  }
  const trashPath = join(root, pending.trash);
  try {
    await lstat(trashPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return false;
    }
    if (!(await pathExists(join(root, pending.source)))) {
      await removeSessionLocation(root, pending.sessionId);
      state.cursor = pending.source.endsWith(".jsonl") ? "~" + pending.source : pending.source;
    }
    // 意图已刷新但 rename 尚未发生时，保留旧 cursor，让原目录下次重新核验。
    state.pending = null;
    await writeCleanupState(statePath, state);
    return true;
  }
  if (stopped() || !(await isSafeTree(root, trashPath, stopped))) {
    return false;
  }
  if (await pathExists(join(root, pending.source))) {
    if ((await readdir(trashPath)).length !== 0) return false;
    await rm(trashPath, { recursive: true });
    state.pending = null;
    await writeCleanupState(statePath, state);
    return true;
  }
  await rm(trashPath, { recursive: true, force: true });
  await removeSessionLocation(root, pending.sessionId);
  state.cursor = pending.source.endsWith(".jsonl") ? "~" + pending.source : pending.source;
  state.pending = null;
  await writeCleanupState(statePath, state);
  return true;
}

async function readCleanupState(root: string, statePath: string): Promise<CleanupState> {
  try {
    if (!(await isSafeOwnedPath(root, statePath, "file"))) {
      return { cursor: null, pending: null };
    }
    const value: unknown = JSON.parse(await readFile(statePath, "utf8"));
    if (typeof value !== "object" || value === null) {
      throw new Error("invalid maintenance state");
    }
    const candidate = value as Record<string, unknown>;
    if (candidate.cursor !== null && !isCleanupCursor(candidate.cursor)) {
      throw new Error("invalid cleanup cursor");
    }
    if (candidate.pending !== null) {
      if (typeof candidate.pending !== "object" || candidate.pending === null) {
        throw new Error("invalid pending deletion");
      }
      const pending = candidate.pending as Record<string, unknown>;
      if (
        !isUuid(pending.sessionId) ||
        !isCleanupSource(pending.source) ||
        typeof pending.trash !== "string" ||
        !pending.trash.startsWith(`.maintenance/trash/${pending.sessionId}-`) ||
        !isUuid(pending.trash.slice(`.maintenance/trash/${pending.sessionId}-`.length)) ||
        !(
          pending.source.endsWith(`-${pending.sessionId}`) ||
          pending.source === `${pending.sessionId}.jsonl`
        )
      ) {
        throw new Error("invalid pending deletion identity");
      }
    }
    return candidate as CleanupState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { cursor: null, pending: null };
    }
    throw error;
  }
}

function isSessionRelativeDirectory(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const segments = value.split("/");
  return (
    segments.length === 2 &&
    DATE_DIRECTORY_PATTERN.test(segments[0] ?? "") &&
    SESSION_DIRECTORY_PATTERN.test(segments[1] ?? "")
  );
}

async function writeCleanupState(path: string, state: CleanupState): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
}

async function ensureSafeDirectory(root: string, relativeDirectory: string): Promise<void> {
  let current = root;
  for (const segment of relativeDirectory.split("/")) {
    if (segment === "" || segment === "." || segment === ".." || segment.includes("\\")) {
      throw new Error("invalid maintenance directory");
    }
    current = join(current, segment);
    try {
      await mkdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    if (!(await isSafeOwnedPath(root, current, "directory"))) {
      throw new Error("unsafe maintenance directory");
    }
  }
}

async function isSafeOwnedPath(
  root: string,
  path: string,
  kind: "directory" | "file",
): Promise<boolean> {
  const relativePath = relative(root, resolve(path));
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return false;
  }
  let current = root;
  try {
    const segments = relativePath.split(sep);
    for (let index = 0; index < segments.length; index += 1) {
      current = join(current, segments[index] ?? "");
      const stats = await lstat(current);
      if (stats.isSymbolicLink() || (await realpath(current)) !== resolve(current)) {
        return false;
      }
      if (index < segments.length - 1 || kind === "directory") {
        if (!stats.isDirectory()) return false;
      } else if (!stats.isFile()) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function isSafeTree(
  root: string,
  directory: string,
  stopped: () => boolean,
): Promise<boolean> {
  if (stopped() || !(await isSafeOwnedPath(root, directory, "directory"))) {
    return false;
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (stopped() || entry.isSymbolicLink()) {
      return false;
    }
    const child = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!(await isSafeTree(root, child, stopped))) return false;
    } else if (!entry.isFile() || !(await isSafeOwnedPath(root, child, "file"))) {
      return false;
    }
  }
  return true;
}

async function cleanLegacySessions(
  root: string,
  state: CleanupState,
  statePath: string,
  options: Readonly<{
    now: number;
    stopped: () => boolean;
    remainingCandidates: number;
    lockSystem: SessionLockSystem;
  }>,
): Promise<SessionCleanupResult> {
  let inspected = 0;
  let deleted = 0;
  let skipped = 0;
  const skipReasons = new Set<string>();
  for (const name of (await readdir(root)).sort()) {
    if (!name.endsWith(".jsonl") || !isUuid(name.slice(0, -6))) continue;
    const cursor = "~" + name;
    if (state.cursor !== null && cursor <= state.cursor) continue;
    if (options.stopped() || inspected >= options.remainingCandidates) {
      return { inspected, deleted, skipped, skipReasons: [...skipReasons], status: "bounded" };
    }
    inspected += 1;
    const sessionId = name.slice(0, -6);
    let sessionLock: Awaited<ReturnType<typeof acquireSessionLock>> | null = null;
    let legacyLock: Awaited<ReturnType<typeof acquireSessionLock>> | null = null;
    try {
      await ensureSafeDirectory(root, ".maintenance/sessions/" + sessionId);
      sessionLock = await acquireSessionLock(
        getSessionLockDirectory(root, sessionId),
        options.lockSystem,
      );
      legacyLock = await acquireSessionLock(join(root, sessionId + ".lock"), options.lockSystem);
      const path = join(root, name);
      if (
        !(await isSafeOwnedPath(root, path, "file")) ||
        (await lstat(path)).size > MAX_JOURNAL_BYTES
      ) {
        throw new Error("legacy Session path is unsafe");
      }
      const location = await locateSessionStorage(root, sessionId);
      if (location.source !== "schema1") throw new Error("legacy Session has another authority");
      const journal = await readSessionJournal(path);
      if (journal.header.schemaVersion !== 1 || journal.header.sessionId !== sessionId) {
        throw new Error("legacy Session identity mismatch");
      }
      const lastActivityAt = Date.parse(deriveLastActivityAt(journal.header, journal.records));
      const usage = await inspectSessionUsageMarkers(root, sessionId, options.lockSystem);
      if (
        usage.status !== "unused" ||
        !Number.isFinite(lastActivityAt) ||
        lastActivityAt > options.now ||
        options.now - lastActivityAt < RETENTION_MILLISECONDS ||
        options.stopped()
      )
        throw new Error("legacy Session cannot be deleted");
      await ensureSafeDirectory(root, ".maintenance/trash");
      const trash = ".maintenance/trash/" + sessionId + "-" + randomUUID();
      state.pending = { source: name, trash, sessionId };
      await writeCleanupState(statePath, state);
      await mkdir(join(root, trash));
      await rename(path, join(root, trash, "session.jsonl"));
      if (!(await finishPendingDeletion(root, state, statePath, options.stopped))) {
        return { inspected, deleted, skipped, skipReasons: [...skipReasons], status: "bounded" };
      }
      deleted += 1;
    } catch (error) {
      skipReasons.add(safeCleanupSkipReason(error));
      skipped += 1;
      if (state.pending !== null)
        return { inspected, deleted, skipped, skipReasons: [...skipReasons], status: "bounded" };
    } finally {
      if (legacyLock !== null) await releaseSessionLock(legacyLock);
      if (sessionLock !== null) await releaseSessionLock(sessionLock);
    }
    state.cursor = cursor;
    await writeCleanupState(statePath, state);
  }
  return { inspected, deleted, skipped, skipReasons: [...skipReasons], status: "completed" };
}

function isCleanupSource(value: unknown): value is string {
  return (
    isSessionRelativeDirectory(value) ||
    (typeof value === "string" && value.endsWith(".jsonl") && isUuid(value.slice(0, -6)))
  );
}

function isCleanupCursor(value: unknown): value is string {
  return (
    isSessionRelativeDirectory(value) ||
    (typeof value === "string" && value.startsWith("~") && isCleanupSource(value.slice(1)))
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** 只发布本模块固定的失败分类，磁盘异常中的路径与任意正文不能进入事件。 */
function safeCleanupSkipReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message === "Session timestamp is uncertain") return "时间无效或位于未来";
  if (message === "Session is recent") return "近期使用";
  if (message === "Session has an active owner") return "仍有使用者";
  if (message === "Session owner is uncertain") return "进程状态不明";
  if (
    message === "migration authority is pending" ||
    message === "legacy Session has another authority"
  )
    return "迁移尚未完成或来源冲突";
  if (message.includes("unsafe") || message === "Session tree cannot be safely deleted")
    return "目录归属或链接无法安全核验";
  if (message === "journal exceeds maintenance read budget") return "日志超过本轮维护读取预算";
  if (message === "legacy Session cannot be deleted") return "旧对话仍在使用或未过期";
  if (message.includes("identity mismatch") || message.includes("creation path mismatch"))
    return "日志身份与目录不一致";
  if (error instanceof SessionBusyError) return "正在写入或锁状态不明";
  return "日志或存储状态无法核验";
}
