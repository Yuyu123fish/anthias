import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { hasExactKeys, isUtcTimestamp, isUuid, parseJsonObject } from "./schema.js";

/** 隔离锁实现中唯一需要替换的进程、身份与时钟系统边界。 */
export type SessionLockSystem = Readonly<{
  processId: number;
  createOwnerToken(): string;
  createTimestamp(): string;
  inspectProcess(processId: number): "alive" | "dead" | "unknown";
}>;

/** 保存一次原子写锁的释放凭据。 */
export type SessionLockOwnership = Readonly<{
  lockDirectory: string;
  ownerToken: string;
}>;

/** 保存打开 Session 期间独立使用标记的释放凭据。 */
export type SessionUsageMarkerOwnership = Readonly<{
  sessionDirectory: string;
  sessionId: string;
  markerFilePath: string;
  ownerToken: string;
}>;

/** 清理方据此区分可删除、正在使用和无法安全判断的 Session。 */
export type SessionUsageMarkerInspection = Readonly<{
  status: "unused" | "in_use" | "unknown";
  aliveOwnerTokens: readonly string[];
  deadOwnerTokens: readonly string[];
  unknownOwnerTokens: readonly string[];
}>;

/** 表示锁目录或使用标记中经过严格校验的所有者元数据。 */
type SessionLockOwner = Readonly<{
  pid: number;
  ownerToken: string;
  acquiredAt: string;
}>;

type ManagedLockDirectory = Readonly<{
  rootDirectory: string;
  parentSegments: readonly string[];
  lockDirectoryName: string;
}>;

type VerifiedLockDirectory = Readonly<{
  lockDirectory: string;
  parentDirectory: string;
}>;

type FileIdentity = Readonly<{
  device: number;
  inode: number;
}>;

/** 提供生产环境真实进程探测、UUID 与 UTC 时间。 */
export const DEFAULT_SESSION_LOCK_SYSTEM: SessionLockSystem = Object.freeze({
  processId: process.pid,
  createOwnerToken: randomUUID,
  createTimestamp: () => new Date().toISOString(),
  inspectProcess(processId) {
    try {
      process.kill(processId, 0);
      return "alive";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
    }
  },
});

/** 区分可安全展示的 Session 正忙与其他存储错误。 */
export class SessionBusyError extends Error {}

/** 以稳定 Session ID 在数据根外的生命周期维护区组织互斥与使用标记。 */
export function getSessionMaintenanceDirectory(
  sessionDirectory: string,
  sessionId: string,
): string {
  assertSessionId(sessionId);
  return join(sessionDirectory, ".maintenance", "sessions", sessionId);
}

/** 返回只保护实际 JSONL 写入、迁移与删除发布阶段的独占锁目录。 */
export function getSessionLockDirectory(sessionDirectory: string, sessionId: string): string {
  return join(getSessionMaintenanceDirectory(sessionDirectory, sessionId), "write.lock");
}

/** 返回一个 Session 的独立使用标记目录。 */
export function getSessionUsageDirectory(sessionDirectory: string, sessionId: string): string {
  return join(getSessionMaintenanceDirectory(sessionDirectory, sessionId), "usage");
}

/** 原子取得 Session 写锁；活着或不确定的所有者一律安全拒绝。 */
export async function acquireSessionLock(
  requestedLockDirectory: string,
  lockSystem: SessionLockSystem,
): Promise<SessionLockOwnership> {
  const verifiedLockDirectory = await ensureManagedLockParentDirectory(requestedLockDirectory);
  const reclaimGuardName = `${basename(verifiedLockDirectory.lockDirectory)}.reclaim`;
  if (
    (await resolveExistingDirectChildDirectory(
      verifiedLockDirectory.parentDirectory,
      reclaimGuardName,
    )) !== null
  ) {
    throw new SessionBusyError("Session 正在被其他进程使用。");
  }

  try {
    await mkdir(verifiedLockDirectory.lockDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const existingLockDirectory = await resolveExistingDirectChildDirectory(
      verifiedLockDirectory.parentDirectory,
      basename(verifiedLockDirectory.lockDirectory),
    );
    if (existingLockDirectory === null) {
      return acquireSessionLock(requestedLockDirectory, lockSystem);
    }
    const existingOwner = await readSessionLockOwner(existingLockDirectory).catch(() => null);
    if (existingOwner === null || lockSystem.inspectProcess(existingOwner.pid) !== "dead") {
      throw new SessionBusyError("Session 正在被其他进程使用。");
    }
    await reclaimDeadSessionLock(
      existingLockDirectory,
      verifiedLockDirectory.parentDirectory,
      existingOwner,
      lockSystem,
    );
    return acquireSessionLock(requestedLockDirectory, lockSystem);
  }

  const lockDirectory = await resolveExistingDirectChildDirectory(
    verifiedLockDirectory.parentDirectory,
    basename(verifiedLockDirectory.lockDirectory),
  );
  if (lockDirectory === null) {
    throw new Error("Session 写锁创建后不可读取。");
  }
  const owner = createSessionLockOwner(lockSystem);
  try {
    await writeSessionLockOwner(lockDirectory, owner);
  } catch (error) {
    await unlink(join(lockDirectory, "owner.json")).catch(() => undefined);
    await rmdir(lockDirectory).catch(() => undefined);
    throw error;
  }
  return Object.freeze({ lockDirectory, ownerToken: owner.ownerToken });
}

/** 为一个已打开 Session 写入独立所有者标记；它不替代 Run 写锁。 */
export async function acquireSessionUsageMarker(
  sessionDirectory: string,
  sessionId: string,
  lockSystem: SessionLockSystem,
): Promise<SessionUsageMarkerOwnership> {
  const maintenanceDirectory = await ensureSessionMaintenanceDirectory(sessionDirectory, sessionId);
  const usageDirectory = await ensureDirectChildDirectory(maintenanceDirectory, "usage");
  const owner = createSessionLockOwner(lockSystem);
  const markerFileName = `${owner.ownerToken}.json`;
  const markerFilePath = join(usageDirectory, markerFileName);
  const markerHandle = await open(markerFilePath, "wx");
  let markerIdentity: FileIdentity | null = null;
  let markerHandleClosed = false;
  try {
    markerIdentity = toFileIdentity(await markerHandle.stat());
    await markerHandle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await markerHandle.sync();
    await markerHandle.close();
    markerHandleClosed = true;
    const canonicalMarkerFilePath = await resolveExistingDirectChild(
      usageDirectory,
      markerFileName,
    );
    if (canonicalMarkerFilePath === null) {
      throw new Error("Session usage marker 创建后不可读取。");
    }
    return Object.freeze({
      sessionDirectory: await realpath(sessionDirectory),
      sessionId,
      markerFilePath: canonicalMarkerFilePath,
      ownerToken: owner.ownerToken,
    });
  } catch (error) {
    if (!markerHandleClosed) {
      await markerHandle.close().catch(() => undefined);
    }
    if (markerIdentity !== null) {
      await removeCreatedUsageMarker(usageDirectory, markerFileName, markerIdentity);
    }
    throw error;
  }
}

/** 仅删除本次 wx 创建且文件身份仍一致的 marker，不能回收其他 opener 的文件。 */
async function removeCreatedUsageMarker(
  usageDirectory: string,
  markerFileName: string,
  expectedIdentity: FileIdentity,
): Promise<void> {
  const markerFilePath = await resolveExistingDirectChild(usageDirectory, markerFileName).catch(
    () => null,
  );
  if (markerFilePath === null) {
    return;
  }
  const markerStats = await lstat(markerFilePath).catch(() => null);
  if (
    markerStats === null ||
    markerStats.isSymbolicLink() ||
    !markerStats.isFile() ||
    !hasSameFileIdentity(markerStats, expectedIdentity)
  ) {
    return;
  }
  await unlink(markerFilePath).catch(() => undefined);
  await rmdir(usageDirectory).catch(() => undefined);
}

/** 只释放当前 Session 实例取得的使用标记，重复关闭时由调用者吸收。 */
export async function releaseSessionUsageMarker(
  ownership: SessionUsageMarkerOwnership,
): Promise<void> {
  const maintenanceDirectory = await resolveExistingSessionMaintenanceDirectory(
    ownership.sessionDirectory,
    ownership.sessionId,
  );
  if (maintenanceDirectory === null) {
    return;
  }
  const usageDirectory = await resolveExistingDirectChildDirectory(maintenanceDirectory, "usage");
  if (usageDirectory === null) {
    return;
  }
  const markerFileName = `${ownership.ownerToken}.json`;
  const markerFilePath = await resolveExistingDirectChild(usageDirectory, markerFileName);
  if (markerFilePath === null) {
    return;
  }
  if (!areSamePath(markerFilePath, ownership.markerFilePath)) {
    throw new Error("Session usage marker 路径不匹配。");
  }
  const currentOwner = await readSessionLockOwnerFile(markerFilePath).catch(() => null);
  if (currentOwner === null) {
    return;
  }
  if (currentOwner.ownerToken !== ownership.ownerToken) {
    throw new Error("Session usage marker owner token 不匹配。");
  }
  await unlink(markerFilePath);
  await rmdir(usageDirectory).catch(() => undefined);
}

/** 检查所有使用标记；未知形状或进程状态必须保护 Session 不被清理。 */
export async function inspectSessionUsageMarkers(
  sessionDirectory: string,
  sessionId: string,
  lockSystem: SessionLockSystem,
): Promise<SessionUsageMarkerInspection> {
  const maintenanceDirectory = await resolveExistingSessionMaintenanceDirectory(
    sessionDirectory,
    sessionId,
  );
  if (maintenanceDirectory === null) {
    return emptyUsageMarkerInspection();
  }
  const usageDirectory = await resolveExistingDirectChildDirectory(maintenanceDirectory, "usage");
  if (usageDirectory === null) {
    return emptyUsageMarkerInspection();
  }
  const entries = await readdir(usageDirectory, { withFileTypes: true });
  return inspectUsageMarkerEntries(usageDirectory, entries, lockSystem);
}

/** 仅在再次确认同一所有者已经死亡后回收残留使用标记。 */
export async function reclaimDeadSessionUsageMarkers(
  sessionDirectory: string,
  sessionId: string,
  lockSystem: SessionLockSystem,
): Promise<void> {
  const maintenanceDirectory = await resolveExistingSessionMaintenanceDirectory(
    sessionDirectory,
    sessionId,
  );
  if (maintenanceDirectory === null) {
    return;
  }
  const usageDirectory = await resolveExistingDirectChildDirectory(maintenanceDirectory, "usage");
  if (usageDirectory === null) {
    return;
  }
  const inspection = await inspectSessionUsageMarkers(sessionDirectory, sessionId, lockSystem);
  for (const ownerToken of inspection.deadOwnerTokens) {
    const markerFilePath = await resolveExistingDirectChild(usageDirectory, `${ownerToken}.json`);
    if (markerFilePath === null) {
      continue;
    }
    const owner = await readSessionLockOwnerFile(markerFilePath).catch(() => null);
    if (
      owner === null ||
      owner.ownerToken !== ownerToken ||
      lockSystem.inspectProcess(owner.pid) !== "dead"
    ) {
      continue;
    }
    await unlink(markerFilePath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    });
  }
  await rmdir(usageDirectory).catch(() => undefined);
}

/** 在回收门内再次确认死锁身份，再删除已认领的残留目录。 */
async function reclaimDeadSessionLock(
  lockDirectory: string,
  parentDirectory: string,
  expectedOwner: SessionLockOwner,
  lockSystem: SessionLockSystem,
): Promise<void> {
  const reclaimGuardName = `${basename(lockDirectory)}.reclaim`;
  let reclaimGuardDirectory: string;
  try {
    reclaimGuardDirectory = await createDirectChildDirectory(parentDirectory, reclaimGuardName);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new SessionBusyError("Session 正在被其他进程使用。");
    }
    throw error;
  }

  const reclaimedDirectoryName = `${basename(lockDirectory)}.dead-${lockSystem.createOwnerToken()}`;
  const reclaimedDirectory = join(parentDirectory, reclaimedDirectoryName);
  try {
    const currentOwner = await readSessionLockOwner(lockDirectory).catch(() => null);
    if (
      currentOwner === null ||
      currentOwner.ownerToken !== expectedOwner.ownerToken ||
      lockSystem.inspectProcess(currentOwner.pid) !== "dead"
    ) {
      throw new SessionBusyError("Session 正在被其他进程使用。");
    }
    await rename(lockDirectory, reclaimedDirectory);
    const verifiedReclaimedDirectory = await resolveExistingDirectChildDirectory(
      parentDirectory,
      reclaimedDirectoryName,
    );
    if (verifiedReclaimedDirectory === null) {
      throw new Error("Session 死锁回收目录不可读取。");
    }
    const reclaimedOwner = await readSessionLockOwner(verifiedReclaimedDirectory).catch(() => null);
    if (reclaimedOwner?.ownerToken !== expectedOwner.ownerToken) {
      await rename(verifiedReclaimedDirectory, lockDirectory).catch(() => undefined);
      throw new SessionBusyError("Session 正在被其他进程使用。");
    }
    await unlink(join(verifiedReclaimedDirectory, "owner.json"));
    await rmdir(verifiedReclaimedDirectory);
  } finally {
    await rmdir(reclaimGuardDirectory).catch(() => undefined);
  }
}

/** 文件身份正常也不能替代写锁身份；外部改写所有者后停止后续追加。 */
export async function assertSessionLockOwnership(ownership: SessionLockOwnership): Promise<void> {
  const directory = await resolveExistingManagedLockDirectory(ownership.lockDirectory);
  const owner = await readSessionLockOwner(directory.lockDirectory);
  if (owner.ownerToken !== ownership.ownerToken)
    throw new SessionBusyError("Session lock owner token 不匹配。");
}

/** 只有 owner token 仍匹配时才移除本次持有的锁目录。 */
export async function releaseSessionLock(ownership: SessionLockOwnership): Promise<void> {
  const verifiedLockDirectory = await resolveExistingManagedLockDirectory(ownership.lockDirectory);
  const currentOwner = await readSessionLockOwner(verifiedLockDirectory.lockDirectory).catch(
    () => null,
  );
  if (currentOwner?.ownerToken !== ownership.ownerToken) {
    throw new Error("Session lock owner token 不匹配。");
  }
  await unlink(join(verifiedLockDirectory.lockDirectory, "owner.json"));
  await rmdir(verifiedLockDirectory.lockDirectory);
}

/** 在写入文件前集中校验测试替身和生产身份系统返回的值。 */
function createSessionLockOwner(lockSystem: SessionLockSystem): SessionLockOwner {
  const ownerToken = lockSystem.createOwnerToken();
  const acquiredAt = lockSystem.createTimestamp();
  if (
    !isUuid(ownerToken) ||
    !isUtcTimestamp(acquiredAt) ||
    !Number.isSafeInteger(lockSystem.processId)
  ) {
    throw new Error("Session 锁系统生成了无效身份。");
  }
  return Object.freeze({ pid: lockSystem.processId, ownerToken, acquiredAt });
}

function toFileIdentity(stats: Readonly<{ dev: number; ino: number }>): FileIdentity {
  return Object.freeze({ device: stats.dev, inode: stats.ino });
}

function hasSameFileIdentity(
  stats: Readonly<{ dev: number; ino: number }>,
  expectedIdentity: FileIdentity,
): boolean {
  return stats.dev === expectedIdentity.device && stats.ino === expectedIdentity.inode;
}

/** 以独占文件写入并刷新一次锁所有者元数据。 */
async function writeSessionLockOwner(
  lockDirectory: string,
  owner: SessionLockOwner,
): Promise<void> {
  const ownerFileHandle = await open(join(lockDirectory, "owner.json"), "wx");
  try {
    await ownerFileHandle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await ownerFileHandle.sync();
  } finally {
    await ownerFileHandle.close();
  }
}

/** 严格读取锁或使用标记元数据，任何未知形状都保持为不可回收状态。 */
async function readSessionLockOwner(lockDirectory: string): Promise<SessionLockOwner> {
  return readSessionLockOwnerFile(join(lockDirectory, "owner.json"));
}

async function readSessionLockOwnerFile(ownerFilePath: string): Promise<SessionLockOwner> {
  const ownerBytes = await readFile(ownerFilePath);
  let ownerText: string;
  try {
    ownerText = new TextDecoder("utf-8", { fatal: true }).decode(ownerBytes);
  } catch {
    throw new Error("Session lock owner 不是合法 UTF-8。");
  }
  if (!ownerText.endsWith("\n")) {
    throw new Error("Session lock owner 不完整。");
  }
  const owner = parseJsonObject(ownerText.slice(0, -1));
  if (
    !hasExactKeys(owner, ["pid", "ownerToken", "acquiredAt"]) ||
    !Number.isSafeInteger(owner.pid) ||
    (owner.pid as number) <= 0 ||
    !isUuid(owner.ownerToken) ||
    !isUtcTimestamp(owner.acquiredAt)
  ) {
    throw new Error("Session lock owner 无效。");
  }
  return owner as SessionLockOwner;
}

async function inspectUsageMarkerEntries(
  usageDirectory: string,
  entries: readonly Dirent[],
  lockSystem: SessionLockSystem,
): Promise<SessionUsageMarkerInspection> {
  const aliveOwnerTokens: string[] = [];
  const deadOwnerTokens: string[] = [];
  const unknownOwnerTokens: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      unknownOwnerTokens.push(entry.name);
      continue;
    }
    const markerFilePath = await resolveExistingDirectChild(usageDirectory, entry.name).catch(
      () => null,
    );
    const owner =
      markerFilePath === null
        ? null
        : await readSessionLockOwnerFile(markerFilePath).catch(() => null);
    if (owner === null || entry.name !== `${owner.ownerToken}.json`) {
      unknownOwnerTokens.push(entry.name);
      continue;
    }
    const processStatus = lockSystem.inspectProcess(owner.pid);
    if (processStatus === "alive") {
      aliveOwnerTokens.push(owner.ownerToken);
    } else if (processStatus === "dead") {
      deadOwnerTokens.push(owner.ownerToken);
    } else {
      unknownOwnerTokens.push(owner.ownerToken);
    }
  }
  const status =
    unknownOwnerTokens.length > 0 ? "unknown" : aliveOwnerTokens.length > 0 ? "in_use" : "unused";
  return Object.freeze({
    status,
    aliveOwnerTokens: Object.freeze(aliveOwnerTokens),
    deadOwnerTokens: Object.freeze(deadOwnerTokens),
    unknownOwnerTokens: Object.freeze(unknownOwnerTokens),
  });
}

async function ensureManagedLockParentDirectory(
  requestedLockDirectory: string,
): Promise<VerifiedLockDirectory> {
  const layout = parseManagedLockDirectory(requestedLockDirectory);
  const rootDirectory = await realpath(layout.rootDirectory);
  let parentDirectory = rootDirectory;
  for (const segment of layout.parentSegments) {
    parentDirectory = await ensureDirectChildDirectory(parentDirectory, segment);
  }
  return Object.freeze({
    lockDirectory: join(parentDirectory, layout.lockDirectoryName),
    parentDirectory,
  });
}

async function resolveExistingManagedLockDirectory(
  requestedLockDirectory: string,
): Promise<VerifiedLockDirectory> {
  const layout = parseManagedLockDirectory(requestedLockDirectory);
  const rootDirectory = await realpath(layout.rootDirectory);
  let parentDirectory = rootDirectory;
  for (const segment of layout.parentSegments) {
    const childDirectory = await resolveExistingDirectChildDirectory(parentDirectory, segment);
    if (childDirectory === null) {
      throw new Error("Session 维护目录不存在。");
    }
    parentDirectory = childDirectory;
  }
  const lockDirectory = await resolveExistingDirectChildDirectory(
    parentDirectory,
    layout.lockDirectoryName,
  );
  if (lockDirectory === null) {
    throw new Error("Session 写锁不存在。");
  }
  return Object.freeze({ lockDirectory, parentDirectory });
}

function parseManagedLockDirectory(requestedLockDirectory: string): ManagedLockDirectory {
  const lockDirectoryName = basename(requestedLockDirectory);
  const immediateParentDirectory = dirname(requestedLockDirectory);
  if (
    lockDirectoryName === "cleanup.lock" &&
    basename(immediateParentDirectory) === ".maintenance"
  ) {
    return Object.freeze({
      rootDirectory: dirname(immediateParentDirectory),
      parentSegments: Object.freeze([".maintenance"]),
      lockDirectoryName,
    });
  }
  if (
    lockDirectoryName === "write.lock" &&
    isUuid(basename(immediateParentDirectory)) &&
    basename(dirname(immediateParentDirectory)) === "sessions" &&
    basename(dirname(dirname(immediateParentDirectory))) === ".maintenance"
  ) {
    return Object.freeze({
      rootDirectory: dirname(dirname(dirname(immediateParentDirectory))),
      parentSegments: Object.freeze([
        ".maintenance",
        "sessions",
        basename(immediateParentDirectory),
      ]),
      lockDirectoryName,
    });
  }
  const legacyMatch = /^([0-9a-f-]{36})\.lock$/iu.exec(lockDirectoryName);
  if (legacyMatch !== null && isUuid(legacyMatch[1] ?? "")) {
    return Object.freeze({
      rootDirectory: immediateParentDirectory,
      parentSegments: Object.freeze([]),
      lockDirectoryName,
    });
  }
  throw new Error("Session 锁路径不属于受管维护布局。");
}

async function ensureSessionMaintenanceDirectory(
  sessionDirectory: string,
  sessionId: string,
): Promise<string> {
  assertSessionId(sessionId);
  const rootDirectory = await realpath(sessionDirectory);
  let maintenanceDirectory = await ensureDirectChildDirectory(rootDirectory, ".maintenance");
  maintenanceDirectory = await ensureDirectChildDirectory(maintenanceDirectory, "sessions");
  return ensureDirectChildDirectory(maintenanceDirectory, sessionId);
}

async function resolveExistingSessionMaintenanceDirectory(
  sessionDirectory: string,
  sessionId: string,
): Promise<string | null> {
  assertSessionId(sessionId);
  const rootDirectory = await realpath(sessionDirectory);
  const maintenanceDirectory = await resolveExistingDirectChildDirectory(
    rootDirectory,
    ".maintenance",
  );
  if (maintenanceDirectory === null) {
    return null;
  }
  const sessionsDirectory = await resolveExistingDirectChildDirectory(
    maintenanceDirectory,
    "sessions",
  );
  if (sessionsDirectory === null) {
    return null;
  }
  return resolveExistingDirectChildDirectory(sessionsDirectory, sessionId);
}

async function ensureDirectChildDirectory(
  parentDirectory: string,
  childName: string,
): Promise<string> {
  const childDirectory = join(parentDirectory, childName);
  try {
    await mkdir(childDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  return requireExistingDirectChildDirectory(parentDirectory, childName);
}

async function createDirectChildDirectory(
  parentDirectory: string,
  childName: string,
): Promise<string> {
  const childDirectory = join(parentDirectory, childName);
  await mkdir(childDirectory);
  return requireExistingDirectChildDirectory(parentDirectory, childName);
}

async function requireExistingDirectChildDirectory(
  parentDirectory: string,
  childName: string,
): Promise<string> {
  const childDirectory = await resolveExistingDirectChild(parentDirectory, childName);
  if (childDirectory === null) {
    throw new Error("Session 维护目录不存在。");
  }
  if (!(await lstat(childDirectory)).isDirectory()) {
    throw new Error("Session 维护路径不是目录。");
  }
  return childDirectory;
}
async function resolveExistingDirectChildDirectory(
  parentDirectory: string,
  childName: string,
): Promise<string | null> {
  const childPath = await resolveExistingDirectChild(parentDirectory, childName);
  if (childPath === null) {
    return null;
  }
  if (!(await lstat(childPath)).isDirectory()) {
    throw new Error("Session 维护路径不是目录。");
  }
  return childPath;
}

async function resolveExistingDirectChild(
  parentDirectory: string,
  childName: string,
): Promise<string | null> {
  const childPath = join(parentDirectory, childName);
  try {
    const canonicalChildPath = await realpath(childPath);
    assertDirectChild(parentDirectory, canonicalChildPath, childName);
    return canonicalChildPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function assertDirectChild(parentDirectory: string, childPath: string, childName: string): void {
  const relativePath = relative(resolve(parentDirectory), resolve(childPath));
  if (!arePathSegmentsEqual(relativePath, childName)) {
    throw new Error("Session 维护路径超出受管数据根。");
  }
}

function areSamePath(firstPath: string, secondPath: string): boolean {
  return normalizePath(resolve(firstPath)) === normalizePath(resolve(secondPath));
}

function arePathSegmentsEqual(firstPath: string, secondPath: string): boolean {
  return normalizePath(firstPath) === normalizePath(secondPath);
}

function normalizePath(path: string): string {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}

function assertSessionId(sessionId: string): void {
  if (!isUuid(sessionId)) {
    throw new Error("Session ID 无效。");
  }
}

function emptyUsageMarkerInspection(): SessionUsageMarkerInspection {
  return Object.freeze({
    status: "unused",
    aliveOwnerTokens: Object.freeze([]),
    deadOwnerTokens: Object.freeze([]),
    unknownOwnerTokens: Object.freeze([]),
  });
}
