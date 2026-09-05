import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { estimateTextTokens } from "../context/budget.js";
import type { ToolArtifactIncompleteReason, ToolArtifactReference } from "../message.js";

/** 单个 Tool 原文文件允许占用的最大字节数。 */
export const ARTIFACT_BYTE_LIMIT = 32 * 1024 * 1024;

/** 一个 Session 的所有产物共同允许占用的最大字节数。 */
export const SESSION_ARTIFACT_BYTE_LIMIT = 256 * 1024 * 1024;

/** 单次 read_artifact 返回给模型的最大 UTF-8 字节数。 */
export const ARTIFACT_READ_BYTE_LIMIT = 64 * 1024;

/** 单次 read_artifact 返回的最多完整行数。 */
export const ARTIFACT_READ_LINE_LIMIT = 200;

/** 一个产物读取请求的窄输入。 */
export type ArtifactReadRequest = Readonly<{
  artifactId: string;
  cursor?: string;
  lineCount?: number;
  search?: string;
}>;

/** 一个产物读取结果；nextCursor 只在仍有内容时返回。 */
export type ArtifactReadResult = Readonly<{
  status: "completed" | "failed";
  content: string;
  truncated: boolean;
  nextCursor: string | null;
}>;

/** 产物原文写入器的来源终态。 */
export type ArtifactSourceStatus = "completed" | "failed" | "aborted";

/** 一个 ToolCall 绑定的流式产物写入能力。 */
export type ArtifactWriter = Readonly<{
  artifactId: string;
  toolCallId: string;
  readonly byteLength: number;
  readonly pendingByteLength: number;
  readonly hasIncomplete: boolean;
  write(chunk: Uint8Array | string): Promise<void>;
  markIncomplete(reason: ToolArtifactIncompleteReason): void;
  finish(
    sourceStatus?: ArtifactSourceStatus,
    retain?: boolean,
  ): Promise<ToolArtifactReference | null>;
}>;

/** Agent 为当前 Session 持有的产物能力。 */
export type SessionArtifactStore = Readonly<{
  createWriter(toolCallId: string): ArtifactWriter;
  registerReference(reference: ToolArtifactReference): void;
  readArtifact(
    request: ArtifactReadRequest,
    resultTokenBudget?: number,
  ): Promise<ArtifactReadResult>;
  close(): Promise<void>;
}>;

type WriterState = {
  readonly artifactId: string;
  readonly toolCallId: string;
  readonly temporaryPath: string;
  readonly finalPath: string;
  fileHandle: FileHandle | null;
  queue: Promise<void>;
  finishPromise: Promise<ToolArtifactReference | null> | null;
  pendingByteLength: number;
  byteLength: number;
  incompleteReason: ToolArtifactIncompleteReason | null;
  finalized: boolean;
};

type ArtifactCursor = Readonly<{
  byteOffset: number;
  lineNumber: number;
}>;

const ARTIFACT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ARTIFACT_WRITE_QUEUE_BYTE_LIMIT = 256 * 1024;

/** 创建一个只写入当前 Session 独占目录的产物存储。 */
export function createSessionArtifactStore(
  options: Readonly<{
    sessionId: string;
    storageDirectory: string;
  }>,
): SessionArtifactStore {
  const artifactsDirectory = resolve(join(options.storageDirectory, "artifacts"));
  const references = new Map<string, ToolArtifactReference>();
  const activeWriters = new Set<WriterState>();
  let usedBytes = 0;
  let pendingBytes = 0;
  let directoryPromise: Promise<void> | null = null;
  let directoryRealPathPromise: Promise<string> | null = null;
  let usagePromise: Promise<void> | null = null;
  let closed = false;

  function ensureArtifactsDirectory(): Promise<void> {
    directoryPromise ??= mkdir(artifactsDirectory, { recursive: true }).then(() => undefined);
    return directoryPromise;
  }

  function ensureArtifactDirectoryRealPath(): Promise<string> {
    directoryRealPathPromise ??= ensureArtifactsDirectory().then(async () => {
      const directoryStats = await lstat(artifactsDirectory);
      if (directoryStats.isSymbolicLink()) {
        throw new Error("产物目录不能是符号链接。");
      }
      return realpath(artifactsDirectory);
    });
    return directoryRealPathPromise;
  }

  function scanExistingUsage(): Promise<void> {
    const previousUsagePromise = usagePromise;
    const usageScanPromise = (previousUsagePromise ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => ensureArtifactDirectoryRealPath())
      .then(async () => {
        const activeTemporaryPaths = new Set(
          [...activeWriters].map((writer) => writer.temporaryPath),
        );
        const entries = await readdir(artifactsDirectory, { withFileTypes: true });
        let scannedBytes = 0;
        for (const entry of entries) {
          if (!entry.name.endsWith(".txt") && !entry.name.endsWith(".part")) {
            continue;
          }
          if (entry.isSymbolicLink() || !entry.isFile()) {
            continue;
          }
          const entryPath = join(artifactsDirectory, entry.name);
          if (activeTemporaryPaths.has(entryPath)) {
            continue;
          }
          try {
            const fileStats = await lstat(entryPath);
            if (!fileStats.isSymbolicLink()) {
              scannedBytes += fileStats.size;
            }
          } catch {
            // 启动期间消失的临时文件不应阻塞当前 Session。
          }
        }
        usedBytes = scannedBytes;
      });
    usagePromise = usageScanPromise;
    return usageScanPromise;
  }

  function ensureExistingUsage(): Promise<void> {
    usagePromise ??= scanExistingUsage();
    return usagePromise;
  }

  function createWriter(toolCallId: string): ArtifactWriter {
    if (closed) {
      throw new Error("Session 产物存储已关闭。");
    }
    if (!isArtifactId(toolCallId)) {
      throw new Error("ToolCall ID 无效。");
    }
    const artifactId = randomUUID();
    const state: WriterState = {
      artifactId,
      toolCallId,
      temporaryPath: join(artifactsDirectory, artifactId + ".part"),
      finalPath: join(artifactsDirectory, artifactId + ".txt"),
      fileHandle: null,
      queue: Promise.resolve(),
      finishPromise: null,
      pendingByteLength: 0,
      byteLength: 0,
      incompleteReason: null,
      finalized: false,
    };
    const startsNewBatch = activeWriters.size === 0;
    activeWriters.add(state);
    if (startsNewBatch) {
      void scanExistingUsage().catch(() => undefined);
    }
    return Object.freeze({
      artifactId,
      toolCallId,
      get byteLength() {
        return state.byteLength;
      },
      get pendingByteLength() {
        return state.pendingByteLength;
      },
      get hasIncomplete() {
        return state.incompleteReason !== null;
      },
      write(chunk: Uint8Array | string): Promise<void> {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
        if (
          state.finalized ||
          closed ||
          bytes.length === 0 ||
          state.incompleteReason !== null ||
          state.pendingByteLength >= ARTIFACT_WRITE_QUEUE_BYTE_LIMIT
        ) {
          if (
            bytes.length > 0 &&
            state.incompleteReason === null &&
            state.pendingByteLength >= ARTIFACT_WRITE_QUEUE_BYTE_LIMIT
          ) {
            state.incompleteReason = "write_failed";
          }
          return Promise.resolve();
        }
        const artifactRemaining = ARTIFACT_BYTE_LIMIT - state.byteLength - state.pendingByteLength;
        const sessionRemaining = SESSION_ARTIFACT_BYTE_LIMIT - usedBytes - pendingBytes;
        const acceptedByteLength = Math.min(bytes.length, artifactRemaining, sessionRemaining);
        if (acceptedByteLength <= 0) {
          state.incompleteReason = artifactRemaining <= 0 ? "artifact_limit" : "session_limit";
          return Promise.resolve();
        }
        if (acceptedByteLength < bytes.length) {
          state.incompleteReason =
            artifactRemaining <= sessionRemaining ? "artifact_limit" : "session_limit";
        }
        const acceptedBytes = bytes.subarray(0, acceptedByteLength);
        state.pendingByteLength += acceptedByteLength;
        pendingBytes += acceptedByteLength;
        const writePromise = state.queue.then(() => writeChunk(state, acceptedBytes));
        const settledWritePromise = writePromise.catch(() => {
          state.incompleteReason ??= "write_failed";
        });
        state.queue = settledWritePromise.finally(() => {
          state.pendingByteLength -= acceptedByteLength;
          pendingBytes -= acceptedByteLength;
        });
        return settledWritePromise;
      },
      markIncomplete(reason: ToolArtifactIncompleteReason): void {
        if (!state.finalized) {
          state.incompleteReason ??= reason;
        }
      },
      finish(
        sourceStatus: ArtifactSourceStatus = "completed",
        retain = true,
      ): Promise<ToolArtifactReference | null> {
        return finishWriter(state, sourceStatus, retain);
      },
    });
  }

  async function writeChunk(state: WriterState, bytes: Buffer): Promise<void> {
    if (state.finalized || bytes.length === 0) {
      return;
    }
    try {
      await ensureExistingUsage();
      const pendingOtherByteLength = state.pendingByteLength - bytes.length;
      const artifactRemaining = ARTIFACT_BYTE_LIMIT - state.byteLength - pendingOtherByteLength;
      const sessionRemaining =
        SESSION_ARTIFACT_BYTE_LIMIT - usedBytes - (pendingBytes - bytes.length);
      const acceptedByteLength = Math.min(bytes.length, artifactRemaining, sessionRemaining);
      if (acceptedByteLength <= 0) {
        state.incompleteReason ??= artifactRemaining <= 0 ? "artifact_limit" : "session_limit";
        return;
      }
      if (acceptedByteLength < bytes.length) {
        state.incompleteReason ??=
          artifactRemaining <= sessionRemaining ? "artifact_limit" : "session_limit";
      }

      usedBytes += acceptedByteLength;
      let writtenByteLength = 0;
      const fileHandle = await ensureFileHandle(state);
      writtenByteLength = await writeAll(fileHandle, bytes.subarray(0, acceptedByteLength));
      state.byteLength += writtenByteLength;
      if (writtenByteLength < acceptedByteLength && state.incompleteReason === null) {
        state.incompleteReason = "write_failed";
      }
      usedBytes -= acceptedByteLength - writtenByteLength;
    } catch {
      state.incompleteReason ??= "write_failed";
    }
  }

  async function ensureFileHandle(state: WriterState): Promise<FileHandle> {
    if (state.fileHandle !== null) {
      return state.fileHandle;
    }
    await ensureArtifactDirectoryRealPath();
    state.fileHandle = await open(state.temporaryPath, "wx");
    return state.fileHandle;
  }

  async function finishWriter(
    state: WriterState,
    sourceStatus: ArtifactSourceStatus,
    retain: boolean,
  ): Promise<ToolArtifactReference | null> {
    if (state.finishPromise !== null) {
      return state.finishPromise;
    }
    state.finishPromise = (async () => {
      await state.queue;
      if (state.finalized) {
        return null;
      }
      state.finalized = true;
      activeWriters.delete(state);

      const sourceReason =
        sourceStatus === "completed"
          ? null
          : sourceStatus === "aborted"
            ? "aborted"
            : "source_failed";
      await closeFileHandle(state);
      const incompleteReason = state.incompleteReason ?? sourceReason;

      if (!retain) {
        await removeTemporaryFile(state.temporaryPath);
        usedBytes -= state.byteLength;
        return null;
      }
      if (state.byteLength === 0) {
        try {
          await ensureArtifactDirectoryRealPath();
          const emptyFileHandle = await open(state.temporaryPath, "wx");
          await emptyFileHandle.close();
        } catch {
          state.incompleteReason ??= "write_failed";
          await removeTemporaryFile(state.temporaryPath);
          return null;
        }
      }
      try {
        await rename(state.temporaryPath, state.finalPath);
      } catch {
        state.incompleteReason ??= "write_failed";
        await removeTemporaryFile(state.temporaryPath);
        usedBytes -= state.byteLength;
        return null;
      }
      if (incompleteReason === null) {
        return Object.freeze({
          artifactId: state.artifactId,
          toolCallId: state.toolCallId,
          byteLength: state.byteLength,
          complete: true,
        });
      }
      return Object.freeze({
        artifactId: state.artifactId,
        toolCallId: state.toolCallId,
        byteLength: state.byteLength,
        complete: false,
        incompleteReason,
      });
    })();
    return state.finishPromise;
  }

  function registerReference(reference: ToolArtifactReference): void {
    validateArtifactReference(reference);
    const artifactPath = resolve(join(artifactsDirectory, reference.artifactId + ".txt"));
    if (!isPathInside(artifactsDirectory, artifactPath)) {
      throw new Error("产物路径越界。");
    }
    references.set(reference.artifactId, reference);
  }

  async function readArtifact(
    request: ArtifactReadRequest,
    resultTokenBudget?: number,
  ): Promise<ArtifactReadResult> {
    if (closed) {
      return failedArtifactRead("Session 产物存储已关闭。");
    }
    if (!isArtifactId(request.artifactId)) {
      return failedArtifactRead("artifactId 无效。");
    }
    const reference = references.get(request.artifactId);
    if (reference === undefined) {
      return failedArtifactRead("产物不属于当前 Session 或尚未被消息引用。");
    }
    const artifactPath = resolve(join(artifactsDirectory, reference.artifactId + ".txt"));
    if (!isPathInside(artifactsDirectory, artifactPath)) {
      return failedArtifactRead("产物路径越界。");
    }
    try {
      const directoryRealPath = await ensureArtifactDirectoryRealPath();
      const artifactStats = await lstat(artifactPath);
      if (artifactStats.isSymbolicLink()) {
        return failedArtifactRead("产物文件不能是符号链接。");
      }
      const artifactRealPath = await realpath(artifactPath);
      if (!isPathInside(directoryRealPath, artifactRealPath)) {
        return failedArtifactRead("产物路径越界。");
      }
      if (!artifactStats.isFile() || artifactStats.size !== reference.byteLength) {
        return failedArtifactRead("产物文件缺失或完整性不匹配。");
      }
      const bytes = await readFile(artifactPath);
      return readArtifactBytes(bytes, reference, request, resultTokenBudget);
    } catch {
      return failedArtifactRead("产物文件缺失或不可读取。");
    }
  }

  async function close(): Promise<void> {
    if (closed) {
      return;
    }
    closed = true;
    await Promise.all([...activeWriters].map((writer) => finishWriter(writer, "aborted", true)));
  }

  return Object.freeze({
    createWriter,
    registerReference,
    readArtifact,
    close,
  });

  async function closeFileHandle(state: WriterState): Promise<void> {
    if (state.fileHandle === null) {
      return;
    }
    try {
      await state.fileHandle.close();
    } catch {
      state.incompleteReason ??= "write_failed";
    } finally {
      state.fileHandle = null;
    }
  }
}

async function writeAll(fileHandle: FileHandle, bytes: Buffer): Promise<number> {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await fileHandle.write(bytes, offset, bytes.length - offset);
    if (result.bytesWritten <= 0) {
      break;
    }
    offset += result.bytesWritten;
  }
  return offset;
}

function validateArtifactReference(reference: ToolArtifactReference): void {
  if (
    typeof reference !== "object" ||
    reference === null ||
    typeof reference.artifactId !== "string" ||
    typeof reference.toolCallId !== "string" ||
    !isArtifactId(reference.artifactId) ||
    !isArtifactId(reference.toolCallId) ||
    !Number.isSafeInteger(reference.byteLength) ||
    reference.byteLength < 0 ||
    typeof reference.complete !== "boolean"
  ) {
    throw new Error("产物引用字段无效。");
  }
  if (reference.complete) {
    if (!hasExactKeys(reference, ["artifactId", "toolCallId", "byteLength", "complete"])) {
      throw new Error("产物引用字段无效。");
    }
    if (Object.hasOwn(reference, "incompleteReason")) {
      throw new Error("完整产物不能带不完整原因。");
    }
    return;
  }
  if (
    !hasExactKeys(reference, [
      "artifactId",
      "toolCallId",
      "byteLength",
      "complete",
      "incompleteReason",
    ]) ||
    !isArtifactIncompleteReason(reference.incompleteReason)
  ) {
    throw new Error("不完整产物必须带原因。");
  }
}

function readArtifactBytes(
  bytes: Buffer,
  reference: ToolArtifactReference,
  request: ArtifactReadRequest,
  resultTokenBudget?: number,
): ArtifactReadResult {
  const cursorResult = decodeCursor(request.cursor, bytes);
  if (!cursorResult.ok) {
    return failedArtifactRead(cursorResult.error);
  }
  const lineCount = request.lineCount ?? ARTIFACT_READ_LINE_LIMIT;
  if (!Number.isSafeInteger(lineCount) || lineCount < 1 || lineCount > ARTIFACT_READ_LINE_LIMIT) {
    return failedArtifactRead("lineCount 超出范围。");
  }
  if (request.search !== undefined && request.search.length === 0) {
    return failedArtifactRead("search 不能为空。");
  }
  if (
    resultTokenBudget !== undefined &&
    (!Number.isSafeInteger(resultTokenBudget) || resultTokenBudget < 1)
  ) {
    return failedArtifactRead("结果预算无效。");
  }

  const initialHeaderLines = [
    "artifactId: " + reference.artifactId,
    "byteLength: " + reference.byteLength,
    "complete: " + reference.complete,
  ];
  if (!reference.complete) {
    initialHeaderLines.push("incompleteReason: " + (reference.incompleteReason ?? "unknown"));
  }
  if (request.search !== undefined) {
    initialHeaderLines.push("search: " + request.search);
  }
  initialHeaderLines.push("---");

  const tokenBudget = resultTokenBudget ?? null;
  const outputLines: string[] = [];
  let outputByteLength = Buffer.byteLength(initialHeaderLines.join("\n") + "\n", "utf8");
  let outputTokenLength = estimateTextTokens(initialHeaderLines.join("\n") + "\n");
  const trailingMetadataReserveBytes = 512;
  const trailingMetadataReserveTokens = tokenBudget === null ? 0 : 64;
  let currentOffset = cursorResult.cursor.byteOffset;
  let currentLineNumber = cursorResult.cursor.lineNumber;
  let returnedLineCount = 0;
  let nextCursor: ArtifactCursor | null = null;

  while (currentOffset < bytes.length && returnedLineCount < lineCount) {
    const newlineOffset = bytes.indexOf(0x0a, currentOffset);
    const lineEndOffset = newlineOffset < 0 ? bytes.length : newlineOffset;
    const displayEndOffset =
      lineEndOffset > currentOffset && bytes[lineEndOffset - 1] === 0x0d
        ? lineEndOffset - 1
        : lineEndOffset;
    const lineText = bytes.subarray(currentOffset, displayEndOffset).toString("utf8");
    const isMatch = request.search === undefined || lineText.includes(request.search);
    const lineAfterOffset = newlineOffset < 0 ? bytes.length : newlineOffset + 1;
    if (!isMatch) {
      currentOffset = lineAfterOffset;
      currentLineNumber += 1;
      continue;
    }

    const linePrefix = currentLineNumber.toString() + "| ";
    const availableByteLength = Math.max(
      0,
      ARTIFACT_READ_BYTE_LIMIT -
        trailingMetadataReserveBytes -
        outputByteLength -
        Buffer.byteLength(linePrefix, "utf8"),
    );
    const availableTokenLength =
      tokenBudget === null
        ? null
        : Math.max(
            0,
            tokenBudget -
              trailingMetadataReserveTokens -
              outputTokenLength -
              estimateTextTokens(linePrefix + "\n"),
          );
    const segment =
      availableTokenLength === null
        ? safeUtf8Segment(bytes, currentOffset, displayEndOffset, availableByteLength)
        : safeUtf8SegmentWithinTokenBudget(
            lineText,
            currentOffset,
            availableByteLength,
            linePrefix,
            availableTokenLength,
          );
    if (segment.endOffset === currentOffset && lineText.length > 0) {
      nextCursor = { byteOffset: currentOffset, lineNumber: currentLineNumber };
      break;
    }
    const renderedLine = linePrefix + segment.text;
    const renderedByteLength = Buffer.byteLength(renderedLine + "\n", "utf8");
    const renderedTokenLength = estimateTextTokens(renderedLine + "\n");
    const exceedsByteBudget =
      outputByteLength + renderedByteLength + trailingMetadataReserveBytes >
      ARTIFACT_READ_BYTE_LIMIT;
    const exceedsTokenBudget =
      tokenBudget !== null &&
      outputTokenLength + renderedTokenLength + trailingMetadataReserveTokens > tokenBudget;
    if (exceedsByteBudget || exceedsTokenBudget) {
      nextCursor = { byteOffset: currentOffset, lineNumber: currentLineNumber };
      break;
    }
    outputLines.push(renderedLine);
    outputByteLength += renderedByteLength;
    outputTokenLength += renderedTokenLength;
    returnedLineCount += 1;
    if (segment.endOffset < displayEndOffset) {
      nextCursor = { byteOffset: segment.endOffset, lineNumber: currentLineNumber };
      break;
    }
    currentOffset = lineAfterOffset;
    currentLineNumber += 1;
  }

  if (nextCursor === null && currentOffset < bytes.length) {
    nextCursor = { byteOffset: currentOffset, lineNumber: currentLineNumber };
  }
  const trailingMetadataLines = [
    "linesReturned: " + returnedLineCount,
    "nextCursor: " + (nextCursor === null ? "none" : encodeCursor(nextCursor)),
    "---",
  ];
  const content = initialHeaderLines.concat(outputLines, trailingMetadataLines).join("\n");
  return Object.freeze({
    status: "completed",
    content,
    truncated: nextCursor !== null,
    nextCursor: nextCursor === null ? null : encodeCursor(nextCursor),
  });
}

function safeUtf8SegmentWithinTokenBudget(
  lineText: string,
  startOffset: number,
  maximumByteLength: number,
  linePrefix: string,
  maximumTokenLength: number,
): Readonly<{ text: string; endOffset: number }> {
  let segmentText = "";
  let segmentByteLength = 0;
  let endOffset = startOffset;
  for (const character of lineText) {
    const characterByteLength = Buffer.byteLength(character, "utf8");
    if (segmentByteLength + characterByteLength > maximumByteLength) {
      break;
    }
    const candidateText = segmentText + character;
    if (estimateTextTokens(linePrefix + candidateText + "\n") > maximumTokenLength) {
      break;
    }
    segmentText = candidateText;
    segmentByteLength += characterByteLength;
    endOffset += characterByteLength;
  }
  return Object.freeze({ text: segmentText, endOffset });
}
function safeUtf8Segment(
  bytes: Buffer,
  startOffset: number,
  endOffset: number,
  maximumByteLength: number,
): Readonly<{ text: string; endOffset: number }> {
  const requestedEndOffset = Math.min(endOffset, startOffset + Math.max(1, maximumByteLength));
  let safeEndOffset = requestedEndOffset;
  while (
    safeEndOffset > startOffset &&
    safeEndOffset < endOffset &&
    (bytes[safeEndOffset] ?? 0) >= 0x80 &&
    (bytes[safeEndOffset] ?? 0) <= 0xbf
  ) {
    safeEndOffset -= 1;
  }
  if (safeEndOffset === startOffset && requestedEndOffset > startOffset) {
    safeEndOffset = Math.min(endOffset, startOffset + 4);
    while (
      safeEndOffset < endOffset &&
      (bytes[safeEndOffset] ?? 0) >= 0x80 &&
      (bytes[safeEndOffset] ?? 0) <= 0xbf
    ) {
      safeEndOffset -= 1;
    }
  }
  return Object.freeze({
    text: bytes.subarray(startOffset, safeEndOffset).toString("utf8"),
    endOffset: safeEndOffset,
  });
}

function encodeCursor(cursor: ArtifactCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(
  encodedCursor: string | undefined,
  bytes: Uint8Array,
): Readonly<{ ok: true; cursor: ArtifactCursor }> | Readonly<{ ok: false; error: string }> {
  if (encodedCursor === undefined) {
    return Object.freeze({ ok: true, cursor: { byteOffset: 0, lineNumber: 1 } });
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encodedCursor, "base64url").toString("utf8"));
    const cursorObject =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    if (cursorObject === null) {
      return Object.freeze({ ok: false, error: "cursor 无效或超出产物范围。" });
    }
    const byteOffset = cursorObject.byteOffset;
    const lineNumber = cursorObject.lineNumber;
    if (
      typeof byteOffset !== "number" ||
      typeof lineNumber !== "number" ||
      !Number.isSafeInteger(byteOffset) ||
      !Number.isSafeInteger(lineNumber) ||
      byteOffset < 0 ||
      byteOffset > bytes.length ||
      lineNumber < 1
    ) {
      return Object.freeze({ ok: false, error: "cursor 无效或超出产物范围。" });
    }
    if (
      byteOffset > 0 &&
      byteOffset < bytes.length &&
      isUtf8ContinuationByte(bytes[byteOffset] ?? 0)
    ) {
      return Object.freeze({ ok: false, error: "cursor 无效或不是 UTF-8 安全位置。" });
    }
    return Object.freeze({
      ok: true,
      cursor: Object.freeze({
        byteOffset,
        lineNumber,
      }),
    });
  } catch {
    return Object.freeze({ ok: false, error: "cursor 无效或不是 UTF-8 安全位置。" });
  }
}

function failedArtifactRead(content: string): ArtifactReadResult {
  return Object.freeze({ status: "failed", content, truncated: false, nextCursor: null });
}

function removeTemporaryFile(path: string): Promise<void> {
  return rm(path, { force: true }).then(
    () => undefined,
    () => undefined,
  );
}

function isArtifactId(value: string): boolean {
  return ARTIFACT_ID_PATTERN.test(value);
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const pathRelation = relative(rootPath, candidatePath);
  return (
    pathRelation.length === 0 ||
    (pathRelation !== ".." &&
      !pathRelation.startsWith(".." + requirePathSeparator()) &&
      !pathRelation.startsWith(requirePathSeparator()))
  );
}

function requirePathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

function isUtf8ContinuationByte(byte: number): boolean {
  return byte >= 0x80 && byte <= 0xbf;
}

function isArtifactIncompleteReason(value: unknown): value is ToolArtifactIncompleteReason {
  return (
    value === "artifact_limit" ||
    value === "session_limit" ||
    value === "write_failed" ||
    value === "source_failed" ||
    value === "aborted" ||
    value === "unknown"
  );
}

function hasExactKeys(value: object, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  return JSON.stringify(actualKeys) === JSON.stringify([...expectedKeys].sort());
}
