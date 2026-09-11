import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Session } from "../session/index.js";

/** 受管笔记独立于代码工作区；所有读改写经过同一个队列，版本来自实际文件字节。 */
export function createSharedNotes(rootSession: Session) {
  const notesPath = join(rootSession.storageDirectory, "shared-notes.md");
  let pendingOperation: Promise<unknown> = Promise.resolve();
  function serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const completion = pendingOperation.then(operation);
    pendingOperation = completion.catch(() => undefined);
    return completion;
  }
  async function read() {
    const metadata = await lstat(notesPath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (metadata && (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 256 * 1024))
      throw new Error("受管共享笔记必须是至多 256 KiB 的普通文件。");
    const bytes = await readFile(notesPath).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return Buffer.alloc(0);
      throw error;
    });
    return {
      content: bytes.toString("utf8"),
      version: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
    };
  }
  async function write(content: string) {
    if (Buffer.byteLength(content) > 256 * 1024)
      throw new Error("共享笔记最多 256 KiB，请由根 Agent 整理后继续。");
    const temporaryPath = notesPath + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temporaryPath, content, { flag: "wx", encoding: "utf8" });
      await rename(temporaryPath, notesPath);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
    return { content, version: "sha256:" + createHash("sha256").update(content).digest("hex") };
  }
  return {
    read: () => serialize(read),
    append(authorSessionId: string, content: string, signal: AbortSignal) {
      return serialize(async () => {
        signal.throwIfAborted();
        const previous = await read();
        const revisionId = randomUUID();
        const entry =
          "\n\n<!-- 作者 " +
          authorSessionId +
          " | 修订 " +
          revisionId +
          " | " +
          new Date().toISOString() +
          " -->\n" +
          content;
        signal.throwIfAborted();
        return write(previous.content + entry);
      });
    },
    replace(
      authorSessionId: string,
      content: string,
      expectedVersion: string,
      signal: AbortSignal,
    ) {
      return serialize(async () => {
        if (authorSessionId !== rootSession.sessionId)
          throw new Error("只有根 Agent 可以重整共享笔记。");
        signal.throwIfAborted();
        const previous = await read();
        if (previous.version !== expectedVersion)
          throw new Error("共享笔记版本已变化，请重新读取后整理。");
        signal.throwIfAborted();
        return write(
          "<!-- 作者 " +
            authorSessionId +
            " | 修订 " +
            randomUUID() +
            " | " +
            new Date().toISOString() +
            " -->\n" +
            content,
        );
      });
    },
    settle: () => pendingOperation,
  };
}
