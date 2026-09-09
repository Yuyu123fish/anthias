import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  ensureSafeDirectory,
  isSafeOwnedPath,
  isSafeSessionContents,
  openSessionCleanupState,
  type SessionCleanupState,
} from "./cleanup-state.js";
import {
  type LocatedGroupSession,
  type LocatedSessionGroup,
  locateSessionGroup,
} from "./groups.js";
import { readSessionJournal } from "./journal.js";
import { enumerateSessionStorage, locateSessionStorage } from "./locations.js";
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
import {
  type CoordinationRecord,
  deriveLastActivityAt,
  type Schema2SessionHeader,
  type SessionHeader,
  type SessionRecord,
  validateSessionRecords,
} from "./schema.js";

const RETENTION_MILLISECONDS = 14 * 24 * 60 * 60 * 1_000;
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;

type VerifiedManagedSession = Readonly<{
  located: LocatedGroupSession;
  header: SessionHeader;
  records: readonly SessionRecord[];
}>;

export type SessionCleanupResult = Readonly<{
  inspected: number;
  deleted: number;
  skipped: number;
  skipReasons: readonly string[];
  status: "completed" | "bounded" | "busy" | "unavailable";
}>;

/** 清理只消费已有使用事实，持有全局锁与组内 Session 锁，不创建或恢复对话。 */
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

  try {
    const state = await openSessionCleanupState(root);
    if (state.hasPendingDeletion) {
      if (stopped()) return result("bounded");
      const recovery = await state.resumePendingDeletion(stopped);
      if (!recovery.completed) return result("bounded");
      deleted += recovery.deleted;
    }

    if (stopped()) return result("bounded");
    const storageScan = await enumerateSessionStorage(root);
    if (!storageScan.complete) {
      skipReasons.add("位置扫描不完整，保留所有会话");
      return result("bounded");
    }
    const processedSessionIds = new Set<string>();
    const directories = storageScan.entries
      .filter(({ location }) => location.source === "directory")
      .sort((left, right) =>
        (left.location.relativeStorageDirectory ?? "").localeCompare(
          right.location.relativeStorageDirectory ?? "",
        ),
      );
    for (const { location } of directories) {
      const sessionId = location.sessionId;
      const relativeDirectory = location.relativeStorageDirectory?.replaceAll("\\", "/");
      if (
        relativeDirectory === undefined ||
        (state.cursor !== null && relativeDirectory <= state.cursor)
      )
        continue;
      if (processedSessionIds.has(sessionId)) {
        await state.advanceCursor(relativeDirectory);
        continue;
      }
      if (stopped() || inspected >= maximumCandidates) {
        await state.advanceCursor(state.cursor);
        return result("bounded");
      }
      inspected += 1;
      try {
        const group = await locateSessionGroup(root, sessionId, storageScan);
        for (const session of group.sessions) processedSessionIds.add(session.sessionId);
        if (!group.complete) throw new Error("group ownership incomplete");
        if (group.sessions[0]?.header.schemaVersion === 2) {
          deleted += await cleanSchema2Session(root, group.sessions[0], state, {
            now,
            stopped,
            lockSystem,
          });
        } else {
          deleted += await cleanSchema3Group(root, group, relativeDirectory, state, {
            now,
            stopped,
            lockSystem,
          });
        }
      } catch (error) {
        skipReasons.add(safeCleanupSkipReason(error));
        skipped += 1;
        if (state.hasPendingDeletion) return result("bounded");
      }
      await state.advanceCursor(relativeDirectory);
    }
    if (storageScan.diagnostics.length > 0) {
      skipped += storageScan.diagnostics.length;
      skipReasons.add("日志身份或归属无法核验");
    }

    const legacyNames = storageScan.entries
      .filter(({ location }) => location.source === "legacy")
      .map(({ location }) => `${location.sessionId}.jsonl`);
    const legacyResult = await cleanLegacySessions(root, state, legacyNames, {
      now,
      stopped,
      remainingCandidates: maximumCandidates - inspected,
      lockSystem,
    });
    inspected += legacyResult.inspected;
    deleted += legacyResult.deleted;
    skipped += legacyResult.skipped;
    for (const reason of legacyResult.skipReasons) {
      skipReasons.add(reason);
    }
    if (legacyResult.status === "bounded") {
      return result("bounded");
    }
    await state.advanceCursor(null);
    return result("completed");
  } catch {
    return result("unavailable");
  } finally {
    await releaseSessionLock(globalLock);
  }
}

async function cleanSchema2Session(
  root: string,
  located: LocatedGroupSession | undefined,
  state: SessionCleanupState,
  options: Readonly<{
    now: number;
    stopped: () => boolean;
    lockSystem: SessionLockSystem;
  }>,
): Promise<number> {
  if (located === undefined || located.header.schemaVersion !== 2) {
    throw new Error("Session identity mismatch");
  }
  let sessionLock: Awaited<ReturnType<typeof acquireSessionLock>> | null = null;
  try {
    await ensureSafeDirectory(root, `.maintenance/sessions/${located.sessionId}`);
    sessionLock = await acquireSessionLock(
      getSessionLockDirectory(root, located.sessionId),
      options.lockSystem,
    );
    const journal = await verifyManagedJournal(root, located);
    if (journal.header.schemaVersion !== 2) {
      throw new Error("Session identity mismatch");
    }
    assertCompletedRecords(journal.records, journal.header);
    assertExpiredGroup([{ header: journal.header, records: journal.records }], options.now);
    await assertUnused(root, located.sessionId, options.lockSystem);
    if (
      options.stopped() ||
      !(await isSafeSessionContents(root, located.storageDirectory, options.stopped))
    ) {
      throw new Error("Session tree cannot be safely deleted");
    }

    if (
      !(await state.deleteSession(
        located.relativeStorageDirectory,
        located.sessionId,
        options.stopped,
      ))
    ) {
      throw new Error("pending deletion incomplete");
    }
    return 1;
  } finally {
    if (sessionLock !== null) {
      await releaseSessionLock(sessionLock);
    }
  }
}

async function cleanSchema3Group(
  root: string,
  group: LocatedSessionGroup,
  cursorAfter: string,
  state: SessionCleanupState,
  options: Readonly<{
    now: number;
    stopped: () => boolean;
    lockSystem: SessionLockSystem;
  }>,
): Promise<number> {
  if (group.sessions.length === 0 || !group.complete) {
    throw new Error("group ownership incomplete");
  }
  const sortedSessions = [...group.sessions].sort((left, right) =>
    left.sessionId.localeCompare(right.sessionId),
  );
  const sessionLocks: Awaited<ReturnType<typeof acquireSessionLock>>[] = [];
  try {
    for (const located of sortedSessions) {
      await ensureSafeDirectory(root, `.maintenance/sessions/${located.sessionId}`);
      sessionLocks.push(
        await acquireSessionLock(
          getSessionLockDirectory(root, located.sessionId),
          options.lockSystem,
        ),
      );
    }

    const lockedGroup = await locateSessionGroup(root, group.rootSessionId);
    if (
      !lockedGroup.complete ||
      lockedGroup.sessions.length !== sortedSessions.length ||
      lockedGroup.sessions.some(
        (session) =>
          !sortedSessions.some(
            (candidate) =>
              candidate.sessionId === session.sessionId &&
              candidate.storageDirectory === session.storageDirectory,
          ),
      )
    ) {
      throw new Error("group ownership incomplete");
    }
    const verifiedSessions: VerifiedManagedSession[] = [];
    for (const located of sortedSessions) {
      const journal = await verifyManagedJournal(root, located);
      if (
        journal.header.schemaVersion !== 3 ||
        journal.header.rootSessionId !== group.rootSessionId
      ) {
        throw new Error("group ownership incomplete");
      }
      assertCompletedRecords(journal.records, journal.header);
      verifiedSessions.push(
        Object.freeze({
          located,
          header: journal.header,
          records: journal.records,
        }),
      );
    }

    const rootSession = verifiedSessions.find(
      (session) =>
        session.header.sessionId === group.rootSessionId &&
        session.header.sessionKind === "primary",
    );
    if (rootSession === undefined) {
      throw new Error("group ownership incomplete");
    }
    assertGroupCoordinationIsSafe(rootSession, verifiedSessions);
    assertExpiredGroup(verifiedSessions, options.now);
    for (const session of verifiedSessions) {
      await assertUnused(root, session.header.sessionId, options.lockSystem);
      if (
        options.stopped() ||
        !(await isSafeSessionContents(root, session.located.storageDirectory, options.stopped))
      ) {
        throw new Error("Session tree cannot be safely deleted");
      }
    }

    if (
      !(await state.deleteGroup(
        group.rootSessionId,
        cursorAfter,
        verifiedSessions.map((session) => ({
          source: session.located.relativeStorageDirectory,
          sessionId: session.header.sessionId,
        })),
        options.stopped,
      ))
    ) {
      throw new Error("pending deletion incomplete");
    }
    return verifiedSessions.length;
  } finally {
    for (const sessionLock of sessionLocks.reverse()) {
      await releaseSessionLock(sessionLock);
    }
  }
}

async function verifyManagedJournal(root: string, located: LocatedGroupSession) {
  if (!(await isSafeOwnedPath(root, located.storageDirectory, "directory"))) {
    throw new Error("unsafe Session directory");
  }
  if (await hasPendingSessionMigration(located.storageDirectory)) {
    throw new Error("migration authority is pending");
  }
  const location = await locateSessionStorage(root, located.sessionId, { updateCache: false });
  if (
    location.source !== "directory" ||
    location.storageDirectory !== located.storageDirectory ||
    location.legacyFilePath !== undefined
  ) {
    throw new Error("migration authority is pending");
  }
  if (!(await isSafeOwnedPath(root, located.sessionFilePath, "file"))) {
    throw new Error("unsafe Session journal");
  }
  if ((await lstat(located.sessionFilePath)).size > MAX_JOURNAL_BYTES) {
    throw new Error("journal exceeds maintenance read budget");
  }
  const journal = await readSessionJournal(located.sessionFilePath);
  if (
    journal.header.schemaVersion === 1 ||
    journal.header.sessionId !== located.sessionId ||
    JSON.stringify(journal.header) !== JSON.stringify(located.header)
  ) {
    throw new Error("Session identity mismatch");
  }
  return journal;
}

function assertCompletedRecords(
  records: readonly SessionRecord[],
  header: SessionHeader | Schema2SessionHeader,
): void {
  if (validateSessionRecords(records, header) !== null) {
    throw new Error("Session has unfinished Run");
  }
}

function assertExpiredGroup(
  sessions: readonly Readonly<{
    header: SessionHeader | Schema2SessionHeader;
    records: readonly SessionRecord[];
  }>[],
  now: number,
): void {
  const lastActivityAt = Math.max(
    ...sessions.map((session) => Date.parse(deriveLastActivityAt(session.header, session.records))),
  );
  if (!Number.isFinite(lastActivityAt) || lastActivityAt > now) {
    throw new Error("Session timestamp is uncertain");
  }
  if (now - lastActivityAt < RETENTION_MILLISECONDS) {
    throw new Error("Session is recent");
  }
}

async function assertUnused(
  root: string,
  sessionId: string,
  lockSystem: SessionLockSystem,
): Promise<void> {
  const usage = await inspectSessionUsageMarkers(root, sessionId, lockSystem);
  if (usage.status === "in_use") {
    throw new Error("Session has an active owner");
  }
  if (usage.status === "unknown") {
    throw new Error("Session owner is uncertain");
  }
}

function assertGroupCoordinationIsSafe(
  rootSession: VerifiedManagedSession,
  sessions: readonly VerifiedManagedSession[],
): void {
  const latestRecords = new Map<string, CoordinationRecord>();
  for (const record of rootSession.records) {
    if (record.type === "coordination") {
      latestRecords.set(`${record.kind}\0${record.key}`, record);
    }
  }

  const memberSessions = new Map(
    sessions
      .filter((session) => session.header.sessionKind !== "primary")
      .map((session) => [session.header.sessionId, session] as const),
  );
  const memberRecords = [...latestRecords.values()].filter((record) => record.kind === "member");
  if (memberRecords.length !== memberSessions.size) {
    throw new Error("group ownership incomplete");
  }
  for (const record of memberRecords) {
    const payload = asJsonObject(record.payload);
    const memberSession = memberSessions.get(record.key);
    if (
      memberSession === undefined ||
      payload?.sessionId !== record.key ||
      payload.kind !== memberSession.header.sessionKind ||
      payload.workspaceRoot !== memberSession.header.workspaceRoot
    ) {
      throw new Error("group ownership incomplete");
    }
    if (
      payload.status !== "completed" &&
      payload.status !== "failed" &&
      payload.status !== "aborted" &&
      payload.status !== "interrupted" &&
      payload.status !== "closed"
    ) {
      throw new Error("group has active member");
    }
    if (payload.writable === true) {
      if (typeof payload.worktreeId !== "string") {
        throw new Error("group ownership incomplete");
      }
      const worktreeRecord = latestRecords.get(`worktree\0${payload.worktreeId}`);
      if (worktreeRecord === undefined) {
        throw new Error("group ownership incomplete");
      }
    }
  }

  for (const record of latestRecords.values()) {
    const payload = asJsonObject(record.payload);
    if (payload === null) {
      throw new Error("group ownership incomplete");
    }
    if (record.kind === "team" && payload.status !== "closed") {
      throw new Error("group has active member");
    }
    if (record.kind === "task" && payload.status !== "completed") {
      throw new Error("group has unfinished task");
    }
    if (record.kind === "delivery" && payload.status !== "delivered") {
      throw new Error("group has unfinished task");
    }
    if (record.kind === "worktree") {
      if (
        payload.id !== record.key ||
        payload.rootSessionId !== rootSession.header.sessionId ||
        payload.status !== "removed"
      ) {
        throw new Error("group has unreclaimed worktree");
      }
    }
    if (record.kind === "git_operation" && !isCompletedGitOperation(payload)) {
      throw new Error("group has uncertain git operation");
    }
  }
}

function asJsonObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isCompletedGitOperation(payload: Record<string, unknown>): boolean {
  if (payload.operationType === "commit") {
    return payload.phase === "committed" || payload.phase === "failed";
  }
  if (payload.operationType === "remove_worktree") {
    return payload.phase === "removed" || payload.phase === "failed";
  }
  if (payload.operationType === "integration") {
    return (
      payload.phase === "committed" || payload.phase === "aborted" || payload.phase === "failed"
    );
  }
  return false;
}

async function cleanLegacySessions(
  root: string,
  state: SessionCleanupState,
  legacyNames: readonly string[],
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
  for (const name of [...legacyNames].sort()) {
    const cursor = `~${name}`;
    if (state.cursor !== null && cursor <= state.cursor) {
      continue;
    }
    if (options.stopped() || inspected >= options.remainingCandidates) {
      return { inspected, deleted, skipped, skipReasons: [...skipReasons], status: "bounded" };
    }
    inspected += 1;
    const sessionId = name.slice(0, -6);
    let sessionLock: Awaited<ReturnType<typeof acquireSessionLock>> | null = null;
    let legacyLock: Awaited<ReturnType<typeof acquireSessionLock>> | null = null;
    try {
      await ensureSafeDirectory(root, `.maintenance/sessions/${sessionId}`);
      sessionLock = await acquireSessionLock(
        getSessionLockDirectory(root, sessionId),
        options.lockSystem,
      );
      legacyLock = await acquireSessionLock(join(root, `${sessionId}.lock`), options.lockSystem);
      const path = join(root, name);
      if (
        !(await isSafeOwnedPath(root, path, "file")) ||
        (await lstat(path)).size > MAX_JOURNAL_BYTES
      ) {
        throw new Error("legacy Session path is unsafe");
      }
      const location = await locateSessionStorage(root, sessionId, { updateCache: false });
      if (location.source !== "legacy") {
        throw new Error("legacy Session has another authority");
      }
      const journal = await readSessionJournal(path);
      if (journal.header.schemaVersion !== 1 || journal.header.sessionId !== sessionId) {
        throw new Error("legacy Session identity mismatch");
      }
      if (validateSessionRecords(journal.records, journal.header) !== null) {
        throw new Error("Session has unfinished Run");
      }
      const lastActivityAt = Date.parse(deriveLastActivityAt(journal.header, journal.records));
      const usage = await inspectSessionUsageMarkers(root, sessionId, options.lockSystem);
      if (
        usage.status !== "unused" ||
        !Number.isFinite(lastActivityAt) ||
        lastActivityAt > options.now ||
        options.now - lastActivityAt < RETENTION_MILLISECONDS ||
        options.stopped()
      ) {
        throw new Error("legacy Session cannot be deleted");
      }
      if (!(await state.deleteSession(name, sessionId, options.stopped))) {
        return { inspected, deleted, skipped, skipReasons: [...skipReasons], status: "bounded" };
      }
      deleted += 1;
    } catch (error) {
      skipReasons.add(safeCleanupSkipReason(error));
      skipped += 1;
      if (state.hasPendingDeletion) {
        return { inspected, deleted, skipped, skipReasons: [...skipReasons], status: "bounded" };
      }
    } finally {
      if (legacyLock !== null) {
        await releaseSessionLock(legacyLock);
      }
      if (sessionLock !== null) {
        await releaseSessionLock(sessionLock);
      }
    }
    await state.advanceCursor(cursor);
  }
  return { inspected, deleted, skipped, skipReasons: [...skipReasons], status: "completed" };
}

/** 只发布本模块固定的失败分类，磁盘异常中的路径与任意正文不能进入事件。 */
function safeCleanupSkipReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message === "Session timestamp is uncertain") return "时间无效或位于未来";
  if (message === "Session is recent") return "近期使用";
  if (message === "Session has an active owner") return "仍有使用者";
  if (message === "Session owner is uncertain") return "进程状态不明";
  if (message === "Session has unfinished Run") return "Run 尚未终结";
  if (message === "group ownership incomplete") return "组归属或记录不完整";
  if (message === "group has active member") return "成员或 Team 尚未结束";
  if (message === "group has unfinished task") return "任务或交付尚未完成";
  if (message === "group has unreclaimed worktree") return "worktree 尚未安全回收";
  if (message === "group has uncertain git operation") return "Git 操作状态未决";
  if (
    message === "migration authority is pending" ||
    message === "legacy Session has another authority"
  ) {
    return "迁移尚未完成或来源冲突";
  }
  if (message.includes("unsafe") || message === "Session tree cannot be safely deleted") {
    return "目录归属或链接无法安全核验";
  }
  if (message === "journal exceeds maintenance read budget") {
    return "日志超过本轮维护读取预算";
  }
  if (message === "legacy Session cannot be deleted") {
    return "旧对话仍在使用或未过期";
  }
  if (message.includes("identity mismatch") || message.includes("creation path mismatch")) {
    return "日志身份与目录不一致";
  }
  if (error instanceof SessionBusyError) {
    return "正在写入或锁状态不明";
  }
  return "日志或存储状态无法核验";
}
