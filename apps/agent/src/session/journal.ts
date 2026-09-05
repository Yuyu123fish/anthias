import { randomUUID } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  isNonNegativeInteger,
  type LegacySessionHeader,
  type MessageRecord,
  migrateLegacySessionRecords,
  parseJsonObject,
  parseLegacySessionRecord,
  parseSessionHeader,
  parseSessionRecord,
  type RunFinishedRecord,
  type SessionHeader,
  type SessionRecord,
  type UnfinishedRun,
  validateSessionRecords,
} from "./schema.js";

/** 保存内存投影对应的文件大小与最后一个线性 seq。 */
export type SessionFileCheckpoint = Readonly<{
  fileSize: number;
  lastSequence: number;
}>;

/** 表示读取期间 Session 文件已变化，调用方不能继续使用旧投影。 */
export class SessionChangedError extends Error {}

/** 只读校验后的 JSONL 投影，记录偏移始终以 UTF-8 磁盘字节为单位。 */
export type VerifiedSessionJournal =
  | Readonly<{
      header: SessionHeader;
      records: readonly SessionRecord[];
      recordByteOffsets: readonly number[];
      fileSize: number;
    }>
  | Readonly<{
      header: LegacySessionHeader;
      records: readonly SessionRecord[];
      recordByteOffsets: readonly number[];
      fileSize: number;
    }>;

/** 不修复、不迁移也不刷新 use 记录地读取完整日志，供清理与索引重建使用。 */
export async function readSessionJournal(sessionFilePath: string): Promise<VerifiedSessionJournal> {
  const sessionBytes = await readFile(sessionFilePath);
  if (sessionBytes.at(-1) !== 0x0a) {
    throw new Error("Session 文件尾部不完整。");
  }
  return parseVerifiedSessionJournal(sessionBytes);
}

/** 仅在已经持有写锁的打开路径中修复可证明未完成的尾段后读取日志。 */
export async function readCompleteSessionJournal(
  sessionFilePath: string,
): Promise<VerifiedSessionJournal> {
  const sessionText = await readCompleteSessionText(sessionFilePath);
  return parseVerifiedSessionJournal(Buffer.from(sessionText, "utf8"));
}

function parseVerifiedSessionJournal(sessionBytes: Buffer): VerifiedSessionJournal {
  let sessionText: string;
  try {
    sessionText = new TextDecoder("utf-8", { fatal: true }).decode(sessionBytes);
  } catch {
    throw new Error("Session 文件不是合法 UTF-8。");
  }
  if (!sessionText.endsWith("\n")) {
    throw new Error("Session 文件尾部不完整。");
  }
  const lines = sessionText.slice(0, -1).split("\n");
  const header = parseSessionHeader(lines[0]);
  const recordByteOffsets: number[] = [];
  let byteOffset = Buffer.byteLength(`${lines[0]}\n`, "utf8");
  if (header.schemaVersion === 2) {
    const records = lines.slice(1).map((line, index) => {
      recordByteOffsets.push(byteOffset);
      byteOffset += Buffer.byteLength(`${line}\n`, "utf8");
      return parseSessionRecord(line, index + 1);
    });
    validateSessionRecords(records);
    return Object.freeze({
      header,
      records: Object.freeze(records),
      recordByteOffsets: Object.freeze(recordByteOffsets),
      fileSize: sessionBytes.byteLength,
    });
  }
  const records = lines.slice(1).map((line, index) => {
    recordByteOffsets.push(byteOffset);
    byteOffset += Buffer.byteLength(`${line}\n`, "utf8");
    return parseLegacySessionRecord(line, index + 1);
  });
  const migratedRecords = migrateLegacySessionRecords(records);
  return Object.freeze({
    header,
    records: migratedRecords,
    recordByteOffsets: Object.freeze(recordByteOffsets),
    fileSize: sessionBytes.byteLength,
  });
}

/** 创建 Agent 自有目录的本地忽略规则，并拒绝覆盖不一致的已有文件。 */
export async function ensureSessionGitignore(sessionDirectory: string): Promise<void> {
  const gitignorePath = join(sessionDirectory, ".gitignore");
  let gitignoreHandle: Awaited<ReturnType<typeof open>>;
  try {
    gitignoreHandle = await open(gitignorePath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const existingContent = await readFile(gitignorePath, "utf8");
    if (existingContent !== "*" && existingContent !== "*\n") {
      throw new Error("Session 目录 .gitignore 内容不符合 Anthias 约定。");
    }
    return;
  }
  try {
    await gitignoreHandle.writeFile("*\n", "utf8");
    await gitignoreHandle.sync();
  } finally {
    await gitignoreHandle.close();
  }
}

/** 读取当前文件大小与最后 seq，作为下一次 Run 的并发检查点。 */
export async function readSessionCheckpoint(
  sessionFilePath: string,
): Promise<SessionFileCheckpoint> {
  const fileStatsBeforeRead = await stat(sessionFilePath);
  const sessionBytes = await readFile(sessionFilePath);
  const fileStatsAfterRead = await stat(sessionFilePath);
  if (
    fileStatsBeforeRead.size !== fileStatsAfterRead.size ||
    sessionBytes.byteLength !== fileStatsAfterRead.size
  ) {
    throw new SessionChangedError("Session checkpoint 读取期间发生变化。");
  }
  if (sessionBytes.at(-1) !== 0x0a) {
    throw new Error("Session checkpoint 尾部不完整。");
  }
  let sessionText: string;
  try {
    sessionText = new TextDecoder("utf-8", { fatal: true }).decode(sessionBytes);
  } catch {
    throw new Error("Session checkpoint 不是合法 UTF-8。");
  }
  const lines = sessionText.slice(0, -1).split("\n");
  let lastSequence = 0;
  if (lines.length > 1) {
    const lastRecord = parseJsonObject(lines.at(-1));
    if (!isNonNegativeInteger(lastRecord.seq) || lastRecord.seq === 0) {
      throw new Error("Session checkpoint 的最后 seq 无效。");
    }
    lastSequence = lastRecord.seq;
  }
  return Object.freeze({ fileSize: fileStatsAfterRead.size, lastSequence });
}

/** 判断磁盘 checkpoint 是否仍与 Session 内存投影完全一致。 */
export function areSameCheckpoint(
  expectedCheckpoint: SessionFileCheckpoint,
  actualCheckpoint: SessionFileCheckpoint,
): boolean {
  return (
    expectedCheckpoint.fileSize === actualCheckpoint.fileSize &&
    expectedCheckpoint.lastSequence === actualCheckpoint.lastSequence
  );
}

/** 严格解码 Session，并只精确截断无换行的未完成 JSON 尾段。 */
export async function readCompleteSessionText(sessionFilePath: string): Promise<string> {
  const sessionBytes = await readFile(sessionFilePath);
  if (sessionBytes.at(-1) === 0x0a) {
    return decodeUtf8Strict(sessionBytes, "Session 文件不是合法 UTF-8。");
  }

  const finalNewlineByteIndex = sessionBytes.lastIndexOf(0x0a);
  if (finalNewlineByteIndex < 0) {
    throw new Error("Session Header 不完整。");
  }
  const completePrefix = sessionBytes.subarray(0, finalNewlineByteIndex + 1);
  const completePrefixText = decodeUtf8Strict(completePrefix, "Session 文件不是合法 UTF-8。");
  const incompleteTail = sessionBytes.subarray(finalNewlineByteIndex + 1);
  const validTailByteLength = findValidUtf8PrefixBeforeIncompleteTail(incompleteTail);
  if (validTailByteLength === null) {
    throw new Error("Session 文件不是合法 UTF-8。");
  }
  const validTailText = decodeUtf8Strict(
    incompleteTail.subarray(0, validTailByteLength),
    "Session 文件不是合法 UTF-8。",
  );
  if (validTailText.trim().length === 0 || classifyJsonText(validTailText) !== "incomplete") {
    throw new Error("Session 文件包含完整或无效的未换行尾段。");
  }

  const sessionFileHandle = await open(sessionFilePath, "r+");
  try {
    await sessionFileHandle.truncate(finalNewlineByteIndex + 1);
    await sessionFileHandle.sync();
  } finally {
    await sessionFileHandle.close();
  }
  return completePrefixText;
}

function decodeUtf8Strict(bytes: Buffer, errorMessage: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(errorMessage);
  }
}

/**
 * 只容忍 EOF 截断了 UTF-8 多字节码点；任何中间非法字节都不能被恢复路径忽略。
 */
function findValidUtf8PrefixBeforeIncompleteTail(bytes: Buffer): number | null {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const leadingByte = bytes[offset];
    if (leadingByte === undefined) {
      return null;
    }
    if (leadingByte <= 0x7f) {
      offset += 1;
      continue;
    }
    const expectedByteLength = getUtf8SequenceLength(leadingByte);
    if (expectedByteLength === null) {
      return null;
    }
    if (offset + expectedByteLength > bytes.byteLength) {
      for (let index = offset + 1; index < bytes.byteLength; index += 1) {
        const continuationByte = bytes[index];
        if (continuationByte === undefined || (continuationByte & 0xc0) !== 0x80) {
          return null;
        }
      }
      return offset;
    }
    const secondByte = bytes[offset + 1];
    if (secondByte === undefined || (secondByte & 0xc0) !== 0x80) {
      return null;
    }
    if (
      (leadingByte === 0xe0 && secondByte < 0xa0) ||
      (leadingByte === 0xed && secondByte > 0x9f) ||
      (leadingByte === 0xf0 && secondByte < 0x90) ||
      (leadingByte === 0xf4 && secondByte > 0x8f)
    ) {
      return null;
    }
    for (let index = offset + 2; index < offset + expectedByteLength; index += 1) {
      const continuationByte = bytes[index];
      if (continuationByte === undefined || (continuationByte & 0xc0) !== 0x80) {
        return null;
      }
    }
    offset += expectedByteLength;
  }
  return offset;
}

function getUtf8SequenceLength(leadingByte: number): 2 | 3 | 4 | null {
  if (leadingByte >= 0xc2 && leadingByte <= 0xdf) {
    return 2;
  }
  if (leadingByte >= 0xe0 && leadingByte <= 0xef) {
    return 3;
  }
  if (leadingByte >= 0xf0 && leadingByte <= 0xf4) {
    return 4;
  }
  return null;
}
/**
 * 供迁移发布恢复确认：备份仅比当前旧来源多出可证明未提交的 EOF JSON 尾段时才可视为同一事实源。
 */
export function hasRecoverableIncompleteSessionTail(sessionBytes: Buffer): boolean {
  if (sessionBytes.at(-1) === 0x0a) {
    return false;
  }
  const finalNewlineByteIndex = sessionBytes.lastIndexOf(0x0a);
  if (finalNewlineByteIndex < 0) {
    return false;
  }
  try {
    decodeUtf8Strict(
      sessionBytes.subarray(0, finalNewlineByteIndex + 1),
      "Session 文件不是合法 UTF-8。",
    );
    const incompleteTail = sessionBytes.subarray(finalNewlineByteIndex + 1);
    const validTailByteLength = findValidUtf8PrefixBeforeIncompleteTail(incompleteTail);
    if (validTailByteLength === null) {
      return false;
    }
    const validTailText = decodeUtf8Strict(
      incompleteTail.subarray(0, validTailByteLength),
      "Session 文件不是合法 UTF-8。",
    );
    return validTailText.trim().length > 0 && classifyJsonText(validTailText) === "incomplete";
  } catch {
    return false;
  }
}
/** 按调用顺序补齐未决 ToolResult，再写入唯一 interrupted 终态。 */
export async function appendRecoveryRecords(
  sessionFilePath: string,
  records: SessionRecord[],
  unfinishedRun: UnfinishedRun,
): Promise<void> {
  let nextSequence = (records.at(-1)?.seq ?? 0) + 1;
  let parentEntryId = records.at(-1)?.entryId ?? null;
  for (const toolCall of unfinishedRun.toolCalls) {
    if (toolCall.resolved) {
      continue;
    }
    const status = toolCall.started ? "unknown" : "aborted";
    const recoveryRecord: MessageRecord = Object.freeze({
      type: "message",
      entryId: randomUUID(),
      seq: nextSequence,
      timestamp: new Date().toISOString(),
      parentEntryId,
      runId: unfinishedRun.runId,
      message: Object.freeze({
        type: "tool_result",
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        status,
        content:
          status === "unknown"
            ? "Tool 已开始，但 Session 恢复时无法确认执行结果。"
            : "Tool 尚未开始，已在 Session 恢复时终止。",
        truncated: false,
      }),
    });
    await appendJsonLine(sessionFilePath, recoveryRecord);
    records.push(recoveryRecord);
    parentEntryId = recoveryRecord.entryId;
    nextSequence += 1;
  }

  const runFinishedRecord: RunFinishedRecord = Object.freeze({
    type: "run_finished",
    entryId: randomUUID(),
    seq: nextSequence,
    timestamp: new Date().toISOString(),
    parentEntryId,
    runId: unfinishedRun.runId,
    status: "interrupted",
  });
  await appendJsonLine(sessionFilePath, runFinishedRecord);
  records.push(runFinishedRecord);
}
/** 区分完整、语法未完成与已经无效的单个 JSON 值。 */
function classifyJsonText(text: string): "complete" | "incomplete" | "invalid" {
  let cursor = 0;

  /** 跳过 JSON 允许的四种空白字符。 */
  function skipWhitespace(): void {
    while (cursor < text.length) {
      const character = text[cursor];
      if (character !== " " && character !== "\t" && character !== "\n" && character !== "\r") {
        return;
      }
      cursor += 1;
    }
  }

  /** 解析当前位置的一个 JSON 值前缀。 */
  function parseValue(): "complete" | "incomplete" | "invalid" {
    skipWhitespace();
    const character = text[cursor];
    if (character === undefined) {
      return "incomplete";
    }
    if (character === '"') {
      return parseString();
    }
    if (character === "{") {
      return parseObject();
    }
    if (character === "[") {
      return parseArray();
    }
    if (character === "t") {
      return parseLiteral("true");
    }
    if (character === "f") {
      return parseLiteral("false");
    }
    if (character === "n") {
      return parseLiteral("null");
    }
    if (character === "-" || /[0-9]/u.test(character)) {
      return parseNumber();
    }
    return "invalid";
  }

  /** 解析一个带转义检查的 JSON 字符串。 */
  function parseString(): "complete" | "incomplete" | "invalid" {
    cursor += 1;
    while (cursor < text.length) {
      const character = text[cursor] ?? "";
      cursor += 1;
      if (character === '"') {
        return "complete";
      }
      if (character.charCodeAt(0) < 0x20) {
        return "invalid";
      }
      if (character !== "\\") {
        continue;
      }
      const escapedCharacter = text[cursor];
      if (escapedCharacter === undefined) {
        return "incomplete";
      }
      cursor += 1;
      if ('"\\/bfnrt'.includes(escapedCharacter)) {
        continue;
      }
      if (escapedCharacter !== "u") {
        return "invalid";
      }
      for (let index = 0; index < 4; index += 1) {
        const hexadecimalCharacter = text[cursor];
        if (hexadecimalCharacter === undefined) {
          return "incomplete";
        }
        if (!/[0-9a-f]/iu.test(hexadecimalCharacter)) {
          return "invalid";
        }
        cursor += 1;
      }
    }
    return "incomplete";
  }

  /** 解析一个固定 JSON 字面量。 */
  function parseLiteral(literal: "true" | "false" | "null"): "complete" | "incomplete" | "invalid" {
    for (const expectedCharacter of literal) {
      const character = text[cursor];
      if (character === undefined) {
        return "incomplete";
      }
      if (character !== expectedCharacter) {
        return "invalid";
      }
      cursor += 1;
    }
    return "complete";
  }

  /** 解析符合 JSON 数字语法的一个前缀。 */
  function parseNumber(): "complete" | "incomplete" | "invalid" {
    if (text[cursor] === "-") {
      cursor += 1;
      if (cursor === text.length) {
        return "incomplete";
      }
    }
    if (text[cursor] === "0") {
      cursor += 1;
      if (/[0-9]/u.test(text[cursor] ?? "")) {
        return "invalid";
      }
    } else if (/[1-9]/u.test(text[cursor] ?? "")) {
      while (/[0-9]/u.test(text[cursor] ?? "")) {
        cursor += 1;
      }
    } else {
      return "invalid";
    }
    if (text[cursor] === ".") {
      cursor += 1;
      if (cursor === text.length) {
        return "incomplete";
      }
      if (!/[0-9]/u.test(text[cursor] ?? "")) {
        return "invalid";
      }
      while (/[0-9]/u.test(text[cursor] ?? "")) {
        cursor += 1;
      }
    }
    if (text[cursor] === "e" || text[cursor] === "E") {
      cursor += 1;
      if (text[cursor] === "+" || text[cursor] === "-") {
        cursor += 1;
      }
      if (cursor === text.length) {
        return "incomplete";
      }
      if (!/[0-9]/u.test(text[cursor] ?? "")) {
        return "invalid";
      }
      while (/[0-9]/u.test(text[cursor] ?? "")) {
        cursor += 1;
      }
    }
    return "complete";
  }

  /** 解析一个 JSON 数组及其分隔符。 */
  function parseArray(): "complete" | "incomplete" | "invalid" {
    cursor += 1;
    skipWhitespace();
    if (cursor === text.length) {
      return "incomplete";
    }
    if (text[cursor] === "]") {
      cursor += 1;
      return "complete";
    }
    while (true) {
      const itemStatus = parseValue();
      if (itemStatus !== "complete") {
        return itemStatus;
      }
      skipWhitespace();
      const character = text[cursor];
      if (character === undefined) {
        return "incomplete";
      }
      cursor += 1;
      if (character === "]") {
        return "complete";
      }
      if (character !== ",") {
        return "invalid";
      }
      skipWhitespace();
      if (cursor === text.length) {
        return "incomplete";
      }
    }
  }

  /** 解析一个 JSON 对象及其键值分隔符。 */
  function parseObject(): "complete" | "incomplete" | "invalid" {
    cursor += 1;
    skipWhitespace();
    if (cursor === text.length) {
      return "incomplete";
    }
    if (text[cursor] === "}") {
      cursor += 1;
      return "complete";
    }
    while (true) {
      if (text[cursor] !== '"') {
        return "invalid";
      }
      const keyStatus = parseString();
      if (keyStatus !== "complete") {
        return keyStatus;
      }
      skipWhitespace();
      if (text[cursor] === undefined) {
        return "incomplete";
      }
      if (text[cursor] !== ":") {
        return "invalid";
      }
      cursor += 1;
      const valueStatus = parseValue();
      if (valueStatus !== "complete") {
        return valueStatus;
      }
      skipWhitespace();
      const character = text[cursor];
      if (character === undefined) {
        return "incomplete";
      }
      cursor += 1;
      if (character === "}") {
        return "complete";
      }
      if (character !== ",") {
        return "invalid";
      }
      skipWhitespace();
      if (cursor === text.length) {
        return "incomplete";
      }
    }
  }

  const valueStatus = parseValue();
  if (valueStatus !== "complete") {
    return valueStatus;
  }
  skipWhitespace();
  return cursor === text.length ? "complete" : "invalid";
}

/** 以独占创建方式写入并刷新一个新 Session Header。 */
export async function writeNewSessionHeader(
  sessionFilePath: string,
  sessionHeader: SessionHeader,
): Promise<void> {
  const sessionFileHandle = await open(sessionFilePath, "wx");
  try {
    await sessionFileHandle.writeFile(`${JSON.stringify(sessionHeader)}\n`, "utf8");
    await sessionFileHandle.sync();
  } finally {
    await sessionFileHandle.close();
  }
}

/** 追加、刷新并关闭单条换行终止的 JSONL 记录。 */
export async function appendJsonLine(
  sessionFilePath: string,
  record: SessionRecord,
): Promise<void> {
  const sessionFileHandle = await open(sessionFilePath, "a");
  try {
    await sessionFileHandle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await sessionFileHandle.sync();
  } finally {
    await sessionFileHandle.close();
  }
}
