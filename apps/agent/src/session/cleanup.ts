import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type LocatedGroupSession,
  type LocatedSessionGroup,
  locateSessionGroup,
} from "./groups.js";
import { readSessionJournal } from "./journal.js";
import {
  enumerateSessionStorage,
  getContainingSessionStorageDirectory,
  isSessionStorageRelativeDirectory,
  locateSessionStorage,
  MAXIMUM_MANAGED_SESSION_DIRECTORIES,
  removeSessionLocation,
} from "./locations.js";
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
  isUuid,
  type Schema2SessionHeader,
  type SessionHeader,
  type SessionRecord,
  validateSessionRecords,
} from "./schema.js";

const RETENTION_MILLISECONDS = 14 * 24 * 60 * 60 * 1_000;
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const MAX_CLEANUP_STATE_BYTES = 1024 * 1024;

type SinglePendingDeletion = Readonly<{
  kind?: "single";
  source: string;
  trash: string;
  sessionId: string;
}>;

type GroupPendingDeletion = Readonly<{
  kind: "group";
  rootSessionId: string;
  cursorAfter: string;
  trash: string;
  sessions: readonly Readonly<{ source: string; sessionId: string }>[];
}>;

type CleanupState = {
  cursor: string | null;
  pending: SinglePendingDeletion | GroupPendingDeletion | null;
};

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

  const statePath = join(root, ".maintenance", "cleanup-state.json");
  try {
    const state = await readCleanupState(root, statePath);
    if (state.pending !== null) {
      const pending = state.pending;
      if (stopped() || !(await finishPendingDeletion(root, state, statePath, stopped))) {
        return result("bounded");
      }
      deleted += await countMissingPendingSources(root, pending);
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
        state.cursor = relativeDirectory;
        await writeCleanupState(statePath, state);
        continue;
      }
      if (stopped() || inspected >= maximumCandidates) {
        await writeCleanupState(statePath, state);
        return result("bounded");
      }
      inspected += 1;
      try {
        const group = await locateSessionGroup(root, sessionId, storageScan);
        for (const session of group.sessions) processedSessionIds.add(session.sessionId);
        if (!group.complete) throw new Error("group ownership incomplete");
        if (group.sessions[0]?.header.schemaVersion === 2) {
          deleted += await cleanSchema2Session(root, group.sessions[0], state, statePath, {
            now,
            stopped,
            lockSystem,
          });
        } else {
          deleted += await cleanSchema3Group(root, group, relativeDirectory, state, statePath, {
            now,
            stopped,
            lockSystem,
          });
        }
      } catch (error) {
        skipReasons.add(safeCleanupSkipReason(error));
        skipped += 1;
        if (state.pending !== null) return result("bounded");
      }
      state.cursor = relativeDirectory;
      await writeCleanupState(statePath, state);
    }
    if (storageScan.diagnostics.length > 0) {
      skipped += storageScan.diagnostics.length;
      skipReasons.add("日志身份或归属无法核验");
    }

    const legacyNames = storageScan.entries
      .filter(({ location }) => location.source === "legacy")
      .map(({ location }) => `${location.sessionId}.jsonl`);
    const legacyResult = await cleanLegacySessions(root, state, statePath, legacyNames, {
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
    state.cursor = null;
    await writeCleanupState(statePath, state);
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
  state: CleanupState,
  statePath: string,
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

    await ensureSafeDirectory(root, ".maintenance/trash");
    const trash = `.maintenance/trash/${located.sessionId}-${randomUUID()}`;
    state.pending = {
      source: located.relativeStorageDirectory,
      trash,
      sessionId: located.sessionId,
    };
    await writeCleanupState(statePath, state);
    await rename(located.storageDirectory, join(root, trash));
    if (!(await finishPendingDeletion(root, state, statePath, options.stopped))) {
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
  state: CleanupState,
  statePath: string,
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

    await ensureSafeDirectory(root, ".maintenance/trash");
    const trash = `.maintenance/trash/${group.rootSessionId}-${randomUUID()}`;
    await mkdir(join(root, trash));
    state.pending = Object.freeze({
      kind: "group",
      rootSessionId: group.rootSessionId,
      cursorAfter,
      trash,
      sessions: Object.freeze(
        verifiedSessions.map((session) =>
          Object.freeze({
            source: session.located.relativeStorageDirectory,
            sessionId: session.header.sessionId,
          }),
        ),
      ),
    });
    // 清单保留全部身份供锁和缓存失效；物理移动去掉嵌套子路径，避免根已移动后再移动成员。
    await writeCleanupState(statePath, state);
    for (const session of pendingMoveRoots(state.pending)) {
      await rename(join(root, session.source), join(root, trash, session.sessionId));
    }
    if (!(await finishPendingDeletion(root, state, statePath, options.stopped))) {
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
  return pending.kind === "group"
    ? finishPendingGroupDeletion(root, state, statePath, pending, stopped)
    : finishPendingSingleDeletion(root, state, statePath, pending, stopped);
}

/** 清单保留全体身份；这里只选择互不包含的物理源，旧平铺记录保持逐目录处理。 */
function pendingMoveRoots(pending: GroupPendingDeletion) {
  return pending.sessions.filter(
    (session) =>
      !pending.sessions.some(
        (parent) => parent !== session && session.source.startsWith(parent.source + "/"),
      ),
  );
}

async function finishPendingGroupDeletion(
  root: string,
  state: CleanupState,
  statePath: string,
  pending: GroupPendingDeletion,
  stopped: () => boolean,
): Promise<boolean> {
  const trashPath = join(root, pending.trash);
  if (!(await pathExists(trashPath))) {
    const sourcePresence = await Promise.all(
      pending.sessions.map((session) => pathExists(join(root, session.source))),
    );
    if (sourcePresence.every(Boolean)) {
      state.pending = null;
      await writeCleanupState(statePath, state);
      return true;
    }
    if (sourcePresence.some(Boolean)) {
      return false;
    }
    for (const session of pending.sessions) {
      await removeSessionLocation(root, session.sessionId);
    }
    state.cursor = pending.cursorAfter;
    state.pending = null;
    await writeCleanupState(statePath, state);
    return true;
  }
  if (stopped() || !(await isSafeOwnedPath(root, trashPath, "directory"))) {
    return false;
  }

  const moves = pendingMoveRoots(pending);
  const expectedTrashEntries = new Set(moves.map((session) => session.sessionId));
  const sourcePresence = await Promise.all(
    moves.map((session) => pathExists(join(root, session.source))),
  );
  if (sourcePresence.some(Boolean)) {
    const trashEntries = await readdir(trashPath);
    if (trashEntries.some((entry) => !expectedTrashEntries.has(entry))) {
      return false;
    }
    // 跨进程重启后不继承旧删除授权；先恢复已移动成员，再由正常组检查重新决定。
    for (const [index, session] of moves.entries()) {
      const sourcePath = join(root, session.source);
      const destinationPath = join(trashPath, session.sessionId);
      const sourceExists = sourcePresence[index] === true;
      const destinationExists = await pathExists(destinationPath);
      if (sourceExists) {
        if (destinationExists) {
          return false;
        }
        continue;
      }
      if (!destinationExists || stopped() || !(await isSafeTree(root, destinationPath, stopped))) {
        return false;
      }
      if (!(await isSafeOwnedPath(root, resolve(sourcePath, ".."), "directory"))) return false;
      await rename(destinationPath, sourcePath);
    }
    if ((await readdir(trashPath)).length !== 0) {
      return false;
    }
    await rm(trashPath, { recursive: true });
    state.pending = null;
    await writeCleanupState(statePath, state);
    return true;
  }

  const trashEntries = await readdir(trashPath);
  if (
    trashEntries.some((entry) => !expectedTrashEntries.has(entry)) ||
    stopped() ||
    !(await isSafeTree(root, trashPath, stopped)) ||
    !(
      await Promise.all(
        trashEntries.map((entry) => isSafeSessionContents(root, join(trashPath, entry), stopped)),
      )
    ).every(Boolean)
  ) {
    return false;
  }
  // 所有源均已移走后，trash 少项可能是上次递归删除中断；仅允许既定移动根的剩余内容。
  await rm(trashPath, { recursive: true, force: true });
  for (const session of pending.sessions) {
    await removeSessionLocation(root, session.sessionId);
  }
  state.cursor = pending.cursorAfter;
  state.pending = null;
  await writeCleanupState(statePath, state);
  return true;
}

async function finishPendingSingleDeletion(
  root: string,
  state: CleanupState,
  statePath: string,
  pending: SinglePendingDeletion,
  stopped: () => boolean,
): Promise<boolean> {
  const trashPath = join(root, pending.trash);
  try {
    await lstat(trashPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return false;
    }
    if (!(await pathExists(join(root, pending.source)))) {
      await removeSessionLocation(root, pending.sessionId);
      state.cursor = pending.source.endsWith(".jsonl") ? `~${pending.source}` : pending.source;
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
    if ((await readdir(trashPath)).length !== 0) {
      return false;
    }
    await rm(trashPath, { recursive: true });
    state.pending = null;
    await writeCleanupState(statePath, state);
    return true;
  }
  await rm(trashPath, { recursive: true, force: true });
  await removeSessionLocation(root, pending.sessionId);
  state.cursor = pending.source.endsWith(".jsonl") ? `~${pending.source}` : pending.source;
  state.pending = null;
  await writeCleanupState(statePath, state);
  return true;
}

async function countMissingPendingSources(
  root: string,
  pending: SinglePendingDeletion | GroupPendingDeletion,
): Promise<number> {
  const sources =
    pending.kind === "group" ? pending.sessions.map((session) => session.source) : [pending.source];
  const presence = await Promise.all(sources.map((source) => pathExists(join(root, source))));
  return presence.filter((exists) => !exists).length;
}

async function readCleanupState(root: string, statePath: string): Promise<CleanupState> {
  try {
    if (!(await isSafeOwnedPath(root, statePath, "file"))) {
      return { cursor: null, pending: null };
    }
    if ((await lstat(statePath)).size > MAX_CLEANUP_STATE_BYTES) {
      throw new Error("maintenance state exceeds read budget");
    }
    const value: unknown = JSON.parse(await readFile(statePath, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("invalid maintenance state");
    }
    const candidate = value as Record<string, unknown>;
    if (candidate.cursor !== null && !isCleanupCursor(candidate.cursor)) {
      throw new Error("invalid cleanup cursor");
    }
    if (candidate.pending !== null) {
      if (
        typeof candidate.pending !== "object" ||
        candidate.pending === null ||
        Array.isArray(candidate.pending)
      ) {
        throw new Error("invalid pending deletion");
      }
      const pending = candidate.pending as Record<string, unknown>;
      if (pending.kind === "group") {
        validateGroupPendingDeletion(pending);
      } else {
        validateSinglePendingDeletion(pending);
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

function validateSinglePendingDeletion(pending: Record<string, unknown>): void {
  if (
    !(pending.kind === undefined || pending.kind === "single") ||
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

function validateGroupPendingDeletion(pending: Record<string, unknown>): void {
  if (
    !isUuid(pending.rootSessionId) ||
    !isSessionRelativeDirectory(pending.cursorAfter) ||
    typeof pending.trash !== "string" ||
    !pending.trash.startsWith(`.maintenance/trash/${pending.rootSessionId}-`) ||
    !isUuid(pending.trash.slice(`.maintenance/trash/${pending.rootSessionId}-`.length)) ||
    !Array.isArray(pending.sessions) ||
    pending.sessions.length === 0 ||
    pending.sessions.length > MAXIMUM_MANAGED_SESSION_DIRECTORIES
  ) {
    throw new Error("invalid group deletion identity");
  }
  const sessionIds = new Set<string>();
  for (const item of pending.sessions) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("invalid group deletion member");
    }
    const session = item as Record<string, unknown>;
    if (
      !isUuid(session.sessionId) ||
      !isSessionRelativeDirectory(session.source) ||
      !isSessionStorageRelativeDirectory(session.source, session.sessionId) ||
      sessionIds.has(session.sessionId)
    ) {
      throw new Error("invalid group deletion member");
    }
    sessionIds.add(session.sessionId);
  }
  const sessions = pending.sessions as Array<{ source: string; sessionId: string }>;
  const rootSession = sessions.find((session) => session.sessionId === pending.rootSessionId);
  if (
    rootSession === undefined ||
    getContainingSessionStorageDirectory(rootSession.source) !== null ||
    sessions.some((session) => {
      const containingDirectory = getContainingSessionStorageDirectory(session.source);
      return containingDirectory !== null && containingDirectory !== rootSession.source;
    })
  ) {
    throw new Error("invalid group deletion root");
  }
}

function isSessionRelativeDirectory(value: unknown): value is string {
  return (
    typeof value === "string" && !value.includes("\\") && isSessionStorageRelativeDirectory(value)
  );
}

async function writeCleanupState(path: string, state: CleanupState): Promise<void> {
  const serializedState = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(serializedState, "utf8") > MAX_CLEANUP_STATE_BYTES) {
    throw new Error("maintenance state exceeds write budget");
  }
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx");
  try {
    await handle.writeFile(serializedState, "utf8");
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
        if (!stats.isDirectory()) {
          return false;
        }
      } else if (!stats.isFile()) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** 目录位于历史根内并不等于内容归 Agent 所有；未知项目文件必须留给用户处理。 */
async function isSafeSessionContents(
  root: string,
  directory: string,
  stopped: () => boolean,
  allowMembers = true,
): Promise<boolean> {
  if (stopped() || !(await isSafeOwnedPath(root, directory, "directory"))) return false;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (stopped() || entry.isSymbolicLink()) return false;
    const child = join(directory, entry.name);
    if (entry.isFile()) {
      if (
        entry.name !== "session.jsonl" &&
        entry.name !== "session.index.json" &&
        !(
          entry.name.startsWith(".session.index.json.") &&
          entry.name.endsWith(".tmp") &&
          isUuid(entry.name.slice(".session.index.json.".length, -4))
        )
      )
        return false;
      if (!(await isSafeOwnedPath(root, child, "file"))) return false;
      continue;
    }
    if (!entry.isDirectory() || !(await isSafeOwnedPath(root, child, "directory"))) return false;
    if (entry.name === "members" && allowMembers) {
      for (const member of await readdir(child, { withFileTypes: true })) {
        if (
          !isUuid(member.name) ||
          !member.isDirectory() ||
          !(await isSafeSessionContents(root, join(child, member.name), stopped, false))
        )
          return false;
      }
    } else if (entry.name === "artifacts" || entry.name === "migration-backup") {
      for (const file of await readdir(child, { withFileTypes: true })) {
        if (
          stopped() ||
          !file.isFile() ||
          (entry.name === "migration-backup" && file.name !== "legacy-session.jsonl") ||
          !(await isSafeOwnedPath(root, join(child, file.name), "file"))
        )
          return false;
      }
    } else return false;
  }
  return true;
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
      if (!(await isSafeTree(root, child, stopped))) {
        return false;
      }
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
      await ensureSafeDirectory(root, ".maintenance/trash");
      const trash = `.maintenance/trash/${sessionId}-${randomUUID()}`;
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
      if (state.pending !== null) {
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
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
