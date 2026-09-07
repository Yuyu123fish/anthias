import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import {
  MEMORY_ENTRY_BYTES,
  MEMORY_ENTRY_LIMIT,
  type MemoryEntry,
  parseMemoryEntry,
} from "./schema.js";

export type MemoryStoreSnapshot = Readonly<{
  automatic: boolean;
  entries: readonly MemoryEntry[];
  diagnostics: readonly string[];
}>;

/** 一个存储根使用一个写锁；条目替换成功即生效，索引和会话均不能回滚该事实。 */
export function createMemoryStore(directory: string) {
  const stateDirectory = join(directory, "state");
  const lockPath = join(stateDirectory, "write.lock");
  const recoveryPath = join(stateDirectory, "recovery.lock");
  const settingsPath = join(stateDirectory, "settings.json");

  async function read(signal?: AbortSignal): Promise<MemoryStoreSnapshot> {
    signal?.throwIfAborted();
    const diagnostics: string[] = [];
    const entries: MemoryEntry[] = [];
    let bytes = 0;
    async function readEntries(folder: string) {
      const names = await list(folder);
      for (const name of names.sort()) {
        signal?.throwIfAborted();
        if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
        if (entries.length + diagnostics.length >= MEMORY_ENTRY_LIMIT)
          throw new Error("记忆条目超过扫描上限。");
        const path = join(folder, name);
        try {
          const size = (await stat(path)).size;
          bytes += size;
          if (bytes > 8 * 1024 * 1024) throw new Error("记忆扫描内容超过上限。");
          if (size > MEMORY_ENTRY_BYTES) throw new Error("条目超过大小限制");
          const entry = parseMemoryEntry(JSON.parse(await readFile(path, "utf8")));
          if (name !== entry.id + ".json" || entryPath(entry) !== path)
            throw new Error("条目身份与目录不一致");
          entries.push(entry);
        } catch {
          diagnostics.push(
            "记忆 " + name.slice(0, -5) + " 损坏或不可读取，已隔离；无法确认其遗忘状态。",
          );
        }
      }
    }
    await readEntries(join(directory, "user"));
    for (const projectName of (await list(join(directory, "experience"))).sort()) {
      if (!/^project-[a-f0-9]{32}$/.test(projectName)) continue;
      await readEntries(join(directory, "experience", projectName));
    }
    let automatic = true;
    try {
      const metadata = await stat(settingsPath);
      if (metadata.size > 1024) throw new Error("设置大小异常");
      const settings: unknown = JSON.parse(await readFile(settingsPath, "utf8"));
      if (
        typeof settings !== "object" ||
        settings === null ||
        !("formatVersion" in settings) ||
        settings.formatVersion !== 1 ||
        !("automatic" in settings) ||
        typeof settings.automatic !== "boolean"
      )
        throw new Error("设置格式无效");
      automatic = settings.automatic;
    } catch (error) {
      if (!missing(error)) throw new Error("记忆设置不可读取，自动维护已暂停。");
    }
    return { automatic, entries: Object.freeze(entries), diagnostics: Object.freeze(diagnostics) };
  }
  function entryPath(entry: Pick<MemoryEntry, "kind" | "scope" | "id">) {
    return entry.kind === "user"
      ? join(directory, "user", entry.id + ".json")
      : join(directory, "experience", entry.scope, entry.id + ".json");
  }
  async function withWriteLock<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    signal?.throwIfAborted();
    await mkdir(stateDirectory, { recursive: true });
    const token = randomUUID();
    let acquired = false;
    const startedAt = Date.now();
    while (!acquired) {
      signal?.throwIfAborted();
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, token }), "utf8");
          await handle.sync();
        } catch (error) {
          await handle.close();
          await unlink(lockPath);
          throw error;
        } finally {
          await handle.close();
        }
        acquired = true;
      } catch (error) {
        if (!exists(error)) throw new Error("记忆写锁不可用。");
        try {
          const owner = JSON.parse(await readFile(lockPath, "utf8")) as {
            pid?: unknown;
            token?: unknown;
          };
          if (
            Number.isSafeInteger(owner.pid) &&
            Number(owner.pid) > 0 &&
            !processExists(Number(owner.pid))
          ) {
            // 回收者也必须互斥；否则后来的 unlink 可能删掉前一个回收者刚取得的活锁。
            const recoveryHandle = await open(recoveryPath, "wx", 0o600);
            try {
              const currentOwner = JSON.parse(await readFile(lockPath, "utf8")) as {
                pid?: unknown;
                token?: unknown;
              };
              if (
                currentOwner.token === owner.token &&
                currentOwner.pid === owner.pid &&
                !processExists(Number(currentOwner.pid))
              )
                await unlink(lockPath);
            } finally {
              await recoveryHandle.close();
              await unlink(recoveryPath);
            }
          }
        } catch {
          /* 正在写入锁的持有者不应被误判为死亡。 */
        }
        if (Date.now() - startedAt > 5000)
          throw new Error(
            "记忆写锁忙或恢复中断。请关闭其他 Anthias 进程后检查 memory/state/write.lock 和 recovery.lock；不要在其他进程写入时移除它们。",
          );
        await setTimeout(25, undefined, signal ? { signal } : undefined);
      }
    }
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      const owner = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown };
      if (owner.token === token) await unlink(lockPath);
    }
  }
  async function writeAtomic(path: string, value: unknown, signal?: AbortSignal) {
    const serialized = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(serialized) > MEMORY_ENTRY_BYTES)
      throw new Error("记忆记录超过大小限制。");
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = path + "." + randomUUID() + ".tmp";
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      signal?.throwIfAborted();
      await rename(temporaryPath, path);
    } finally {
      await unlink(temporaryPath).catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
    }
  }
  return {
    read,
    async update(
      operation: (snapshot: MemoryStoreSnapshot) => MemoryEntry,
      signal?: AbortSignal,
    ): Promise<MemoryEntry> {
      return withWriteLock(signal, async () => {
        const snapshot = await read(signal);
        if (snapshot.diagnostics.length) throw new Error("记忆存储存在损坏条目，维护已暂停。");
        const entry = parseMemoryEntry(operation(snapshot));
        const previous = snapshot.entries.find((item) => item.id === entry.id);
        if (!previous && snapshot.entries.length >= MEMORY_ENTRY_LIMIT)
          throw new Error("记忆条目达到存储上限。");
        if (previous && (previous.kind !== entry.kind || previous.scope !== entry.scope))
          throw new Error("更新不能改变记忆类别或项目范围。");
        await writeAtomic(entryPath(entry), entry, signal);
        return entry;
      });
    },
    async setAutomatic(automatic: boolean, signal?: AbortSignal) {
      if (typeof automatic !== "boolean") throw new Error("自动记忆开关无效。");
      return withWriteLock(signal, () =>
        writeAtomic(settingsPath, { formatVersion: 1, automatic }, signal),
      );
    },
  };
}
async function list(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if (missing(error)) return [];
    throw new Error("记忆目录不可读取。");
  }
}
function missing(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function exists(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}
