import { randomUUID } from "node:crypto";
import { open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { VerifiedSessionJournal } from "./journal.js";
import {
  type CompactionRecord,
  hasExactKeys,
  isNonNegativeInteger,
  isUuid,
  isValidCompactionRecord,
  type SessionRecord,
} from "./schema.js";

const RESUME_INDEX_FILE_NAME = "session.index.json";

type IndexedEntryLocation = Readonly<{
  entryId: string;
  byteOffset: number;
}>;

/** 从完整 Session 事实派生的可重建恢复加速缓存。 */
export type SessionResumeIndex = Readonly<{
  schemaVersion: 1;
  sessionId: string;
  journalFileSize: number;
  lastEntryId: string | null;
  lastEntryByteOffset: number | null;
  lastSequence: number;
  latestCompaction: Readonly<{
    entryId: string;
    byteOffset: number;
    coversThroughEntryId: string;
    firstKeptEntryId: string | null;
    firstKeptByteOffset: number | null;
  }> | null;
  retainedUserEntries: readonly IndexedEntryLocation[];
}>;

/** 优先读取有效缓存；任何缺失、陈旧或损坏都从已校验 JSONL 重建。 */
export async function readOrRebuildResumeIndex(
  storageDirectory: string,
  journal: VerifiedSessionJournal,
): Promise<SessionResumeIndex> {
  if (journal.header.schemaVersion !== 2) {
    throw new Error("Schema 1 Session 必须先迁移后才能建立恢复索引。");
  }
  const indexPath = join(storageDirectory, RESUME_INDEX_FILE_NAME);
  const persistedIndex = await readResumeIndex(indexPath).catch(() => null);
  if (persistedIndex !== null && isResumeIndexCurrent(persistedIndex, journal)) {
    return persistedIndex;
  }
  const rebuiltIndex = buildResumeIndex(journal);
  await writeResumeIndex(storageDirectory, rebuiltIndex);
  return rebuiltIndex;
}

/** 日志先提交、索引后更新；调用者可以在索引写入失败后保留已提交的事实。 */
export async function writeResumeIndex(
  storageDirectory: string,
  resumeIndex: SessionResumeIndex,
): Promise<void> {
  const temporaryIndexPath = join(
    storageDirectory,
    `.${RESUME_INDEX_FILE_NAME}.${randomUUID()}.tmp`,
  );
  const indexPath = join(storageDirectory, RESUME_INDEX_FILE_NAME);
  const indexHandle = await open(temporaryIndexPath, "wx");
  try {
    await indexHandle.writeFile(`${JSON.stringify(resumeIndex)}\n`, "utf8");
    await indexHandle.sync();
  } finally {
    await indexHandle.close();
  }
  await rename(temporaryIndexPath, indexPath);
}

/** 基于 UTF-8 字节偏移构建索引，不使用 JavaScript 字符位置或行号。 */
export function buildResumeIndex(journal: VerifiedSessionJournal): SessionResumeIndex {
  if (journal.header.schemaVersion !== 2) {
    throw new Error("Schema 1 Session 没有 Schema 2 恢复索引。");
  }
  const entryLocations = new Map<string, IndexedEntryLocation>();
  const previousRecordsByEntryId = new Map<string, SessionRecord>();
  let latestCompaction: CompactionRecord | null = null;
  let latestCompactionByteOffset: number | null = null;
  for (const [recordIndex, record] of journal.records.entries()) {
    const byteOffset = journal.recordByteOffsets[recordIndex];
    if (byteOffset === undefined) {
      throw new Error("Session 恢复索引缺少记录偏移。");
    }
    if (record.type === "compaction" && isValidCompactionRecord(record, previousRecordsByEntryId)) {
      latestCompaction = record;
      latestCompactionByteOffset = byteOffset;
    }
    entryLocations.set(record.entryId, Object.freeze({ entryId: record.entryId, byteOffset }));
    previousRecordsByEntryId.set(record.entryId, record);
  }
  const retainedUserEntries =
    latestCompaction === null
      ? []
      : latestCompaction.retainedUserEntryIds.map((entryId) => {
          const location = entryLocations.get(entryId);
          if (location === undefined) {
            throw new Error("CompactionEntry 引用了没有字节偏移的用户记录。");
          }
          const record = journal.records.find((candidate) => candidate.entryId === entryId);
          if (record?.type !== "message" || record.message.type !== "user") {
            throw new Error("CompactionEntry 保留引用不是 UserMessage。");
          }
          return location;
        });
  let firstKeptByteOffset: number | null = null;
  if (latestCompaction !== null && latestCompaction.firstKeptEntryId !== null) {
    const firstKeptEntry = entryLocations.get(latestCompaction.firstKeptEntryId);
    if (firstKeptEntry === undefined) {
      throw new Error("CompactionEntry 保留起点缺少字节偏移。");
    }
    firstKeptByteOffset = firstKeptEntry.byteOffset;
  }
  const lastRecord = journal.records.at(-1);
  const lastEntryByteOffset =
    lastRecord === undefined ? null : (journal.recordByteOffsets.at(-1) ?? null);
  return Object.freeze({
    schemaVersion: 1,
    sessionId: journal.header.sessionId,
    journalFileSize: journal.fileSize,
    lastEntryId: lastRecord?.entryId ?? null,
    lastEntryByteOffset,
    lastSequence: lastRecord?.seq ?? 0,
    latestCompaction:
      latestCompaction === null || latestCompactionByteOffset === null
        ? null
        : Object.freeze({
            entryId: latestCompaction.entryId,
            byteOffset: latestCompactionByteOffset,
            coversThroughEntryId: latestCompaction.coversThroughEntryId,
            firstKeptEntryId: latestCompaction.firstKeptEntryId,
            firstKeptByteOffset,
          }),
    retainedUserEntries: Object.freeze(
      retainedUserEntries.map((entry) => Object.freeze({ ...entry })),
    ),
  });
}

async function readResumeIndex(indexPath: string): Promise<SessionResumeIndex> {
  const indexText = await readFile(indexPath, "utf8");
  if (!indexText.endsWith("\n")) {
    throw new Error("Session 恢复索引不完整。");
  }
  const value = JSON.parse(indexText.slice(0, -1)) as unknown;
  return parseResumeIndex(value);
}

function parseResumeIndex(value: unknown): SessionResumeIndex {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Session 恢复索引无效。");
  }
  const index = value as Record<string, unknown>;
  if (
    !hasExactKeys(index, [
      "schemaVersion",
      "sessionId",
      "journalFileSize",
      "lastEntryId",
      "lastEntryByteOffset",
      "lastSequence",
      "latestCompaction",
      "retainedUserEntries",
    ]) ||
    index.schemaVersion !== 1 ||
    !isUuid(index.sessionId) ||
    !isNonNegativeInteger(index.journalFileSize) ||
    !(index.lastEntryId === null || isUuid(index.lastEntryId)) ||
    !(index.lastEntryByteOffset === null || isNonNegativeInteger(index.lastEntryByteOffset)) ||
    !isNonNegativeInteger(index.lastSequence) ||
    !isLatestCompactionIndex(index.latestCompaction) ||
    !Array.isArray(index.retainedUserEntries) ||
    !index.retainedUserEntries.every(isIndexedEntryLocation)
  ) {
    throw new Error("Session 恢复索引无效。");
  }
  return Object.freeze({
    schemaVersion: 1,
    sessionId: index.sessionId,
    journalFileSize: index.journalFileSize,
    lastEntryId: index.lastEntryId,
    lastEntryByteOffset: index.lastEntryByteOffset,
    lastSequence: index.lastSequence,
    latestCompaction: index.latestCompaction,
    retainedUserEntries: Object.freeze(
      index.retainedUserEntries.map((entry) => Object.freeze({ ...entry })),
    ),
  }) as SessionResumeIndex;
}

function isResumeIndexCurrent(index: SessionResumeIndex, journal: VerifiedSessionJournal): boolean {
  if (journal.header.schemaVersion !== 2 || index.sessionId !== journal.header.sessionId) {
    return false;
  }
  try {
    const rebuiltIndex = buildResumeIndex(journal);
    return JSON.stringify(index) === JSON.stringify(rebuiltIndex);
  } catch {
    return false;
  }
}

function isLatestCompactionIndex(value: unknown): value is SessionResumeIndex["latestCompaction"] {
  if (value === null) {
    return true;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    hasExactKeys(entry, [
      "entryId",
      "byteOffset",
      "coversThroughEntryId",
      "firstKeptEntryId",
      "firstKeptByteOffset",
    ]) &&
    isUuid(entry.entryId) &&
    isNonNegativeInteger(entry.byteOffset) &&
    isUuid(entry.coversThroughEntryId) &&
    ((entry.firstKeptEntryId === null && entry.firstKeptByteOffset === null) ||
      (isUuid(entry.firstKeptEntryId) && isNonNegativeInteger(entry.firstKeptByteOffset)))
  );
}

function isIndexedEntryLocation(value: unknown): value is IndexedEntryLocation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    hasExactKeys(entry, ["entryId", "byteOffset"]) &&
    isUuid(entry.entryId) &&
    isNonNegativeInteger(entry.byteOffset)
  );
}
