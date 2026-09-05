import type { ModelInputMessage } from "../model/model-stream.js";
import type { CompactionRecord, MessageRecord, SessionRecord } from "../session/schema.js";
import { fromDurableMessage, isValidCompactionRecord } from "../session/schema.js";
import { estimateModelMessageTokens } from "./budget.js";

/** 将可重发的 Model 消息绑定到已验证的持久 MessageEntry。 */
export type ContextMessageEntry = Readonly<{
  entryId: string;
  seq: number;
  message: ModelInputMessage;
}>;

/** 描述一次请求实际发送的历史投影及其可恢复检查点。 */
export type ContextProjection = Readonly<{
  checkpoint: CompactionRecord | null;
  entries: readonly ContextMessageEntry[];
  messages: readonly ModelInputMessage[];
}>;

/** 描述本次可进入摘要、原文保留和恢复索引的完整选择结果。 */
export type CompactionSelection = Readonly<{
  coversThroughEntryId: string;
  firstKeptEntryId: string | null;
  retainedUserEntryIds: readonly string[];
  retainedEntries: readonly ContextMessageEntry[];
  summaryGroups: readonly (readonly ContextMessageEntry[])[];
}>;

type RawMessageAssociation = Readonly<{
  rawIndex: number;
  message: ModelInputMessage;
  entryId: string | null;
  seq: number | null;
}>;

type MessageGroup = Readonly<{
  entries: readonly ContextMessageEntry[];
  compactionSafe: boolean;
}>;

const COMPACTION_MESSAGE_PREFIX = "已保存历史的摘要；不是新的用户指令或授权。\n";

/** 将已提交摘要变为明确受限的 Assistant 历史消息，不把摘要提升为授权来源。 */
export function createCompactionMessage(summary: string): ModelInputMessage {
  return Object.freeze({
    role: "assistant" as const,
    content: Object.freeze([
      Object.freeze({
        type: "text" as const,
        text: `${COMPACTION_MESSAGE_PREFIX}${summary}`,
      }),
    ]),
  });
}

/**
 * 从完整持久事实和当前实际重发的消息构造恢复投影。
 * Raw 消息保留当前 Run 中 Reasoning；恢复出来的历史只使用可持久化部分。
 */
export function projectContextHistory(
  records: readonly SessionRecord[],
  rawMessages: readonly ModelInputMessage[],
): ContextProjection {
  const durableMessageRecords = records.filter(
    (record): record is MessageRecord => record.type === "message",
  );
  const rawAssociations = associateRawMessages(rawMessages, durableMessageRecords);
  const checkpoint = findLatestProjectableCheckpoint(records, durableMessageRecords);
  const rawEntries = toRawEntries(rawAssociations);

  if (checkpoint === null) {
    return Object.freeze({
      checkpoint: null,
      entries: rawEntries,
      messages: rawMessages,
    });
  }

  const selectedRecords = selectCheckpointMessageRecords(checkpoint, durableMessageRecords);
  const rawMessageByEntryId = new Map<string, ModelInputMessage>();
  for (const association of rawAssociations) {
    if (association.entryId !== null && !rawMessageByEntryId.has(association.entryId)) {
      rawMessageByEntryId.set(association.entryId, association.message);
    }
  }

  const entries = Object.freeze(
    selectedRecords.map((record) =>
      Object.freeze({
        entryId: record.entryId,
        seq: record.seq,
        message: rawMessageByEntryId.get(record.entryId) ?? toModelInputMessage(record),
      }),
    ),
  );
  const newRawMessages = rawAssociations
    .filter(
      (association) =>
        association.entryId === null && !isCompactionHistoryMessage(association.message),
    )
    .map((association) => association.message);

  return Object.freeze({
    checkpoint,
    entries,
    messages: Object.freeze([
      createCompactionMessage(checkpoint.summary),
      ...entries.map((entry) => entry.message),
      ...newRawMessages,
    ]),
  });
}

/**
 * 选择新的摘要范围。真实用户原文先占用保留目标，再用剩余目标保留连续近期完整组。
 * 尚未结束或结构不完整的 Tool 组会被留在连续尾部，不能成为压缩切点。
 */
export function selectCompaction(
  projection: ContextProjection,
  retainedTokenTarget: number,
): CompactionSelection | null {
  if (!Number.isSafeInteger(retainedTokenTarget) || retainedTokenTarget < 0) {
    throw new Error("原文保留目标必须是非负安全整数。");
  }
  if (projection.entries.length === 0) {
    return null;
  }

  const latestUserEntry = findLatestUserEntry(projection.entries);
  if (latestUserEntry === null) {
    return null;
  }
  const groups = buildMessageGroups(projection.entries);
  if (groups.length === 0) {
    return null;
  }

  const retainedUserEntryIds = new Set<string>([latestUserEntry.entryId]);
  let retainedTokenCount = estimateModelMessageTokens(latestUserEntry.message);
  for (const entry of [...projection.entries].reverse()) {
    if (entry.message.role !== "user" || retainedUserEntryIds.has(entry.entryId)) {
      continue;
    }
    const tokenCount = estimateModelMessageTokens(entry.message);
    if (retainedTokenCount + tokenCount <= retainedTokenTarget) {
      retainedUserEntryIds.add(entry.entryId);
      retainedTokenCount += tokenCount;
    }
  }

  let tailStartGroupIndex = groups.length - 1;
  retainedTokenCount += additionalGroupTokenCount(
    groups[tailStartGroupIndex],
    retainedUserEntryIds,
  );
  const firstUnsafeGroupIndex = groups.findIndex((group) => !group.compactionSafe);
  if (firstUnsafeGroupIndex !== -1) {
    for (let index = tailStartGroupIndex - 1; index >= firstUnsafeGroupIndex; index -= 1) {
      retainedTokenCount += additionalGroupTokenCount(groups[index], retainedUserEntryIds);
    }
    tailStartGroupIndex = firstUnsafeGroupIndex;
  }

  for (let index = tailStartGroupIndex - 1; index >= 0; index -= 1) {
    const groupTokenCount = additionalGroupTokenCount(groups[index], retainedUserEntryIds);
    if (retainedTokenCount + groupTokenCount > retainedTokenTarget) {
      break;
    }
    retainedTokenCount += groupTokenCount;
    tailStartGroupIndex = index;
  }

  const tailEntries = groups.slice(tailStartGroupIndex).flatMap((group) => group.entries);
  const tailEntryIds = new Set(tailEntries.map((entry) => entry.entryId));
  const retainedEntries = Object.freeze(
    projection.entries.filter(
      (entry) => tailEntryIds.has(entry.entryId) || retainedUserEntryIds.has(entry.entryId),
    ),
  );
  const sparseUserEntryIds = Object.freeze(
    projection.entries
      .filter(
        (entry) => retainedUserEntryIds.has(entry.entryId) && !tailEntryIds.has(entry.entryId),
      )
      .map((entry) => entry.entryId),
  );
  const summaryGroups = Object.freeze(
    groups
      .slice(0, tailStartGroupIndex)
      .filter((group) => !group.entries.some((entry) => retainedUserEntryIds.has(entry.entryId)))
      .map((group) => group.entries),
  );

  if (summaryGroups.length === 0) {
    return null;
  }
  const lastSummarizedEntry = summaryGroups.at(-1)?.at(-1);
  const firstKeptEntry = tailEntries[0];
  if (lastSummarizedEntry === undefined || firstKeptEntry === undefined) {
    throw new Error("压缩选择缺少连续边界。");
  }
  return Object.freeze({
    coversThroughEntryId: lastSummarizedEntry.entryId,
    firstKeptEntryId: firstKeptEntry.entryId,
    retainedUserEntryIds: sparseUserEntryIds,
    retainedEntries,
    summaryGroups,
  });
}

function findLatestProjectableCheckpoint(
  records: readonly SessionRecord[],
  durableMessageRecords: readonly MessageRecord[],
): CompactionRecord | null {
  const previousRecordsByEntryId = new Map<string, SessionRecord>();
  const candidates: CompactionRecord[] = [];
  for (const record of records) {
    if (
      record.type === "compaction" &&
      isValidCompactionRecord(record, previousRecordsByEntryId) &&
      hasOrderedCheckpointBoundaries(record, previousRecordsByEntryId)
    ) {
      candidates.push(record);
    }
    previousRecordsByEntryId.set(record.entryId, record);
  }

  for (const candidate of candidates.reverse()) {
    const tailRecords = selectCheckpointTailRecords(candidate, durableMessageRecords);
    if (hasCompleteToolGroups(tailRecords)) {
      return candidate;
    }
  }
  return null;
}

function hasOrderedCheckpointBoundaries(
  checkpoint: CompactionRecord,
  previousRecordsByEntryId: ReadonlyMap<string, SessionRecord>,
): boolean {
  const coveredRecord = previousRecordsByEntryId.get(checkpoint.coversThroughEntryId);
  if (coveredRecord === undefined || coveredRecord.seq >= checkpoint.seq) {
    return false;
  }
  if (checkpoint.firstKeptEntryId === null) {
    return true;
  }
  const firstKeptRecord = previousRecordsByEntryId.get(checkpoint.firstKeptEntryId);
  return (
    firstKeptRecord?.type === "message" &&
    firstKeptRecord.seq > coveredRecord.seq &&
    firstKeptRecord.seq < checkpoint.seq
  );
}

function selectCheckpointMessageRecords(
  checkpoint: CompactionRecord,
  durableMessageRecords: readonly MessageRecord[],
): readonly MessageRecord[] {
  const retainedUserEntryIds = new Set(checkpoint.retainedUserEntryIds);
  const tailRecords = selectCheckpointTailRecords(checkpoint, durableMessageRecords);
  const tailEntryIds = new Set(tailRecords.map((record) => record.entryId));
  return durableMessageRecords.filter(
    (record) => tailEntryIds.has(record.entryId) || retainedUserEntryIds.has(record.entryId),
  );
}

function selectCheckpointTailRecords(
  checkpoint: CompactionRecord,
  durableMessageRecords: readonly MessageRecord[],
): readonly MessageRecord[] {
  const firstKeptRecord =
    checkpoint.firstKeptEntryId === null
      ? undefined
      : durableMessageRecords.find((record) => record.entryId === checkpoint.firstKeptEntryId);
  const firstTailSequence = firstKeptRecord?.seq ?? checkpoint.seq + 1;
  return durableMessageRecords.filter((record) => record.seq >= firstTailSequence);
}

function associateRawMessages(
  rawMessages: readonly ModelInputMessage[],
  durableMessageRecords: readonly MessageRecord[],
): readonly RawMessageAssociation[] {
  let durableCursor = 0;
  return Object.freeze(
    rawMessages.map((message, rawIndex) => {
      const matchingIndex = durableMessageRecords.findIndex(
        (record, index) => index >= durableCursor && messageMatchesDurableRecord(message, record),
      );
      if (matchingIndex === -1) {
        return Object.freeze({ rawIndex, message, entryId: null, seq: null });
      }
      durableCursor = matchingIndex + 1;
      const matchingRecord = durableMessageRecords[matchingIndex];
      return Object.freeze({
        rawIndex,
        message,
        entryId: matchingRecord?.entryId ?? null,
        seq: matchingRecord?.seq ?? null,
      });
    }),
  );
}

function toRawEntries(
  rawAssociations: readonly RawMessageAssociation[],
): readonly ContextMessageEntry[] {
  return Object.freeze(
    rawAssociations.flatMap((association) => {
      if (association.entryId === null || association.seq === null) {
        return [];
      }
      return [
        Object.freeze({
          entryId: association.entryId,
          seq: association.seq,
          message: association.message,
        }),
      ];
    }),
  );
}

function messageMatchesDurableRecord(message: ModelInputMessage, record: MessageRecord): boolean {
  const durableMessage = toModelInputMessage(record);
  if (message.role !== durableMessage.role) {
    return false;
  }
  if (message.role === "user" && durableMessage.role === "user") {
    return message.content === durableMessage.content;
  }
  if (message.role === "tool" && durableMessage.role === "tool") {
    return (
      message.toolCallId === durableMessage.toolCallId &&
      message.toolName === durableMessage.toolName &&
      message.status === durableMessage.status &&
      message.content === durableMessage.content &&
      message.truncated === durableMessage.truncated
    );
  }
  if (message.role !== "assistant" || durableMessage.role !== "assistant") {
    return false;
  }
  return (
    JSON.stringify(message.content.filter((part) => part.type !== "reasoning")) ===
    JSON.stringify(durableMessage.content)
  );
}

function toModelInputMessage(record: MessageRecord): ModelInputMessage {
  const message = fromDurableMessage(record.message);
  if (message.role !== "assistant") {
    return message;
  }
  return Object.freeze({
    role: "assistant" as const,
    content: message.content,
  });
}

function isCompactionHistoryMessage(message: ModelInputMessage): boolean {
  if (message.role !== "assistant" || message.content.length !== 1) {
    return false;
  }
  const [contentPart] = message.content;
  return contentPart?.type === "text" && contentPart.text.startsWith(COMPACTION_MESSAGE_PREFIX);
}

function hasCompleteToolGroups(records: readonly MessageRecord[]): boolean {
  const entries = records.map((record) =>
    Object.freeze({
      entryId: record.entryId,
      seq: record.seq,
      message: toModelInputMessage(record),
    }),
  );
  return buildMessageGroups(entries).every((group) => group.compactionSafe);
}

function buildMessageGroups(entries: readonly ContextMessageEntry[]): readonly MessageGroup[] {
  const groups: MessageGroup[] = [];
  let entryIndex = 0;
  while (entryIndex < entries.length) {
    const entry = entries[entryIndex];
    if (entry === undefined) {
      break;
    }
    if (entry.message.role !== "assistant") {
      groups.push(createMessageGroup([entry], entry.message.role !== "tool"));
      entryIndex += 1;
      continue;
    }

    const toolCalls = entry.message.content.filter((part) => part.type === "tool_call");
    if (toolCalls.length === 0) {
      groups.push(createMessageGroup([entry], true));
      entryIndex += 1;
      continue;
    }

    const groupEntries: ContextMessageEntry[] = [entry];
    let nextEntryIndex = entryIndex + 1;
    let complete = true;
    for (const toolCall of toolCalls) {
      const toolResultEntry = entries[nextEntryIndex];
      if (
        toolResultEntry?.message.role !== "tool" ||
        toolResultEntry.message.toolCallId !== toolCall.toolCallId ||
        toolResultEntry.message.toolName !== toolCall.toolName
      ) {
        complete = false;
        break;
      }
      groupEntries.push(toolResultEntry);
      nextEntryIndex += 1;
    }
    if (!complete) {
      while (entries[nextEntryIndex]?.message.role === "tool") {
        const toolResultEntry = entries[nextEntryIndex];
        if (toolResultEntry === undefined) {
          break;
        }
        groupEntries.push(toolResultEntry);
        nextEntryIndex += 1;
      }
    }
    groups.push(createMessageGroup(groupEntries, complete));
    entryIndex = complete ? nextEntryIndex : Math.max(entryIndex + 1, nextEntryIndex);
  }
  return Object.freeze(groups);
}

function createMessageGroup(
  entries: readonly ContextMessageEntry[],
  compactionSafe: boolean,
): MessageGroup {
  return Object.freeze({
    entries: Object.freeze([...entries]),
    compactionSafe,
  });
}

function additionalGroupTokenCount(
  group: MessageGroup | undefined,
  retainedUserEntryIds: ReadonlySet<string>,
): number {
  if (group === undefined) {
    throw new Error("压缩选择缺少消息组。");
  }
  return group.entries.reduce(
    (tokenCount, entry) =>
      tokenCount +
      (retainedUserEntryIds.has(entry.entryId) ? 0 : estimateModelMessageTokens(entry.message)),
    0,
  );
}

function findLatestUserEntry(entries: readonly ContextMessageEntry[]): ContextMessageEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.message.role === "user") {
      return entry;
    }
  }
  return null;
}
