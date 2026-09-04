import { randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { hasExactKeys, isUtcTimestamp, isUuid, parseJsonObject } from "./schema.js";

/** 隔离锁实现中唯一需要替换的进程、身份与时钟系统边界。 */
export type SessionLockSystem = Readonly<{
  processId: number;
  createOwnerToken(): string;
  createTimestamp(): string;
  inspectProcess(processId: number): "alive" | "dead" | "unknown";
}>;

/** 保存一次原子目录锁的释放凭据。 */
export type SessionLockOwnership = Readonly<{
  lockDirectory: string;
  ownerToken: string;
}>;

/** 表示锁目录中经过严格校验的所有者元数据。 */
type SessionLockOwner = Readonly<{
  pid: number;
  ownerToken: string;
  acquiredAt: string;
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

/** 原子取得 Session 锁；活着或不确定的所有者一律安全拒绝。 */
export async function acquireSessionLock(
  lockDirectory: string,
  lockSystem: SessionLockSystem,
): Promise<SessionLockOwnership> {
  const reclaimGuardDirectory = `${lockDirectory}.reclaim`;
  if (await pathExists(reclaimGuardDirectory)) {
    throw new SessionBusyError("Session 正在被其他进程使用。");
  }

  try {
    await mkdir(lockDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const existingOwner = await readSessionLockOwner(lockDirectory).catch(() => null);
    if (existingOwner === null || lockSystem.inspectProcess(existingOwner.pid) !== "dead") {
      throw new SessionBusyError("Session 正在被其他进程使用。");
    }
    await reclaimDeadSessionLock(lockDirectory, reclaimGuardDirectory, existingOwner, lockSystem);
    return acquireSessionLock(lockDirectory, lockSystem);
  }

  const ownerToken = lockSystem.createOwnerToken();
  if (!isUuid(ownerToken) || !isUtcTimestamp(lockSystem.createTimestamp())) {
    await rmdir(lockDirectory).catch(() => undefined);
    throw new Error("Session 锁系统生成了无效身份。");
  }
  const owner: SessionLockOwner = Object.freeze({
    pid: lockSystem.processId,
    ownerToken,
    acquiredAt: lockSystem.createTimestamp(),
  });
  try {
    await writeSessionLockOwner(lockDirectory, owner);
  } catch (error) {
    await unlink(join(lockDirectory, "owner.json")).catch(() => undefined);
    await rmdir(lockDirectory).catch(() => undefined);
    throw error;
  }
  return Object.freeze({ lockDirectory, ownerToken });
}

/** 在回收门内再次确认死锁身份，再删除已认领的残留目录。 */
async function reclaimDeadSessionLock(
  lockDirectory: string,
  reclaimGuardDirectory: string,
  expectedOwner: SessionLockOwner,
  lockSystem: SessionLockSystem,
): Promise<void> {
  try {
    await mkdir(reclaimGuardDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new SessionBusyError("Session 正在被其他进程使用。");
    }
    throw error;
  }

  const reclaimedDirectory = `${lockDirectory}.dead-${lockSystem.createOwnerToken()}`;
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
    const reclaimedOwner = await readSessionLockOwner(reclaimedDirectory).catch(() => null);
    if (reclaimedOwner?.ownerToken !== expectedOwner.ownerToken) {
      await rename(reclaimedDirectory, lockDirectory).catch(() => undefined);
      throw new SessionBusyError("Session 正在被其他进程使用。");
    }
    await unlink(join(reclaimedDirectory, "owner.json"));
    await rmdir(reclaimedDirectory);
  } finally {
    await rmdir(reclaimGuardDirectory).catch(() => undefined);
  }
}

/** 只有 owner token 仍匹配时才移除本次持有的锁目录。 */
export async function releaseSessionLock(ownership: SessionLockOwnership): Promise<void> {
  const currentOwner = await readSessionLockOwner(ownership.lockDirectory).catch(() => null);
  if (currentOwner?.ownerToken !== ownership.ownerToken) {
    throw new Error("Session lock owner token 不匹配。");
  }
  await unlink(join(ownership.lockDirectory, "owner.json"));
  await rmdir(ownership.lockDirectory);
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

/** 严格读取锁元数据，任何未知形状都保持为不可回收状态。 */
async function readSessionLockOwner(lockDirectory: string): Promise<SessionLockOwner> {
  const ownerBytes = await readFile(join(lockDirectory, "owner.json"));
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

/** 仅用于锁竞争前判断回收门是否存在。 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
