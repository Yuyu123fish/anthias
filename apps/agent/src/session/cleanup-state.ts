import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  getContainingSessionStorageDirectory,
  isSessionStorageRelativeDirectory,
  MAXIMUM_MANAGED_SESSION_DIRECTORIES,
  removeSessionLocation,
} from "./locations.js";
import { isUuid } from "./schema.js";

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

export type SessionCleanupState = Awaited<ReturnType<typeof openSessionCleanupState>>;

/** 调用方持有全局清理锁；本模块独占 cursor、pending 和 trash，不判断会话是否允许删除。 */
export async function openSessionCleanupState(root: string) {
  const statePath = join(root, ".maintenance", "cleanup-state.json");
  const state = await readCleanupState(root, statePath);
  return Object.freeze({
    get cursor() {
      return state.cursor;
    },
    get hasPendingDeletion() {
      return state.pending !== null;
    },
    async advanceCursor(cursor: string | null): Promise<void> {
      state.cursor = cursor;
      await writeCleanupState(statePath, state);
    },
    async resumePendingDeletion(stopped: () => boolean) {
      const pending = state.pending;
      const completed = await finishPendingDeletion(root, state, statePath, stopped);
      return Object.freeze({
        completed,
        deleted:
          completed && pending !== null ? await countMissingPendingSources(root, pending) : 0,
      });
    },
    /** 调用方须先持有 Session 锁并完成归属、活动状态和目录内容复核。 */
    async deleteSession(
      source: string,
      sessionId: string,
      stopped: () => boolean,
    ): Promise<boolean> {
      if (state.pending !== null) throw new Error("pending deletion incomplete");
      await ensureSafeDirectory(root, ".maintenance/trash");
      const trash = `.maintenance/trash/${sessionId}-${randomUUID()}`;
      state.pending = { source, trash, sessionId };
      // pending 刷盘后才可移动；中途退出由同一状态协议决定恢复或继续删除。
      await writeCleanupState(statePath, state);
      if (source.endsWith(".jsonl")) {
        await mkdir(join(root, trash));
        await rename(join(root, source), join(root, trash, "session.jsonl"));
      } else {
        await rename(join(root, source), join(root, trash));
      }
      return finishPendingDeletion(root, state, statePath, stopped);
    },
    /** 调用方须整组取锁后重新核验；清单记录全部身份，物理移动只处理不相互包含的根目录。 */
    async deleteGroup(
      rootSessionId: string,
      cursorAfter: string,
      sessions: readonly Readonly<{ source: string; sessionId: string }>[],
      stopped: () => boolean,
    ): Promise<boolean> {
      if (state.pending !== null) throw new Error("pending deletion incomplete");
      await ensureSafeDirectory(root, ".maintenance/trash");
      const trash = `.maintenance/trash/${rootSessionId}-${randomUUID()}`;
      await mkdir(join(root, trash));
      const pending: GroupPendingDeletion = Object.freeze({
        kind: "group",
        rootSessionId,
        cursorAfter,
        trash,
        sessions: Object.freeze(sessions.map((session) => Object.freeze({ ...session }))),
      });
      state.pending = pending;
      await writeCleanupState(statePath, state);
      for (const session of pendingMoveRoots(pending)) {
        await rename(join(root, session.source), join(root, trash, session.sessionId));
      }
      return finishPendingDeletion(root, state, statePath, stopped);
    },
  });
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

export async function ensureSafeDirectory(root: string, relativeDirectory: string): Promise<void> {
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

export async function isSafeOwnedPath(
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
export async function isSafeSessionContents(
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
        entry.name !== "session.publish.tmp" &&
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
