import { estimateModelMessageTokens } from "./budget.js";
import type { ContextMessageEntry, ContextMessageGroup, ContextProjection } from "./projection.js";

export type CompactionSelection = Readonly<{
  coversThroughEntryId: string;
  firstKeptEntryId: string | null;
  retainedUserEntryIds: readonly string[];
  retainedEntries: readonly ContextMessageEntry[];
  summaryGroups: readonly (readonly ContextMessageEntry[])[];
}>;

/**
 * 用户及内部输入先占保留目标，再保留连续近期完整组；user role 不参与授权判断。
 * 未结束或结构不完整的 Tool 组留在连续尾部，不能成为压缩切点。
 */
export function selectCompaction(
  projection: ContextProjection,
  retainedTokenTarget: number,
): CompactionSelection | null {
  if (!Number.isSafeInteger(retainedTokenTarget) || retainedTokenTarget < 0)
    throw new Error("原文保留目标必须是非负安全整数。");
  const latestUserEntry = projection.entries.findLast((entry) => entry.message.role === "user");
  const groups = projection.groups;
  if (!latestUserEntry || !groups.length) return null;

  const retainedUserEntryIds = new Set<string>([latestUserEntry.entryId]);
  let retainedTokenCount = estimateModelMessageTokens(latestUserEntry.message);
  for (const entry of [...projection.entries].reverse()) {
    if (entry.message.role !== "user" || retainedUserEntryIds.has(entry.entryId)) continue;
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
    for (let index = tailStartGroupIndex - 1; index >= firstUnsafeGroupIndex; index -= 1)
      retainedTokenCount += additionalGroupTokenCount(groups[index], retainedUserEntryIds);
    tailStartGroupIndex = firstUnsafeGroupIndex;
  }
  for (let index = tailStartGroupIndex - 1; index >= 0; index -= 1) {
    const groupTokenCount = additionalGroupTokenCount(groups[index], retainedUserEntryIds);
    if (retainedTokenCount + groupTokenCount > retainedTokenTarget) break;
    retainedTokenCount += groupTokenCount;
    tailStartGroupIndex = index;
  }

  // 模型把内部输入放在完整 Tool 组后；持久切点仍不能落进该组原始的序号区间。
  let firstTailSequence = Math.min(
    ...groups
      .slice(tailStartGroupIndex)
      .flatMap((group) => group.entries.map((entry) => entry.seq)),
  );
  for (let index = tailStartGroupIndex - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group?.entries.some((entry) => entry.seq >= firstTailSequence)) {
      tailStartGroupIndex = index;
      firstTailSequence = Math.min(firstTailSequence, ...group.entries.map((entry) => entry.seq));
    }
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
  if (!summaryGroups.length) return null;
  const summarizedEntries = summaryGroups.flat();
  const lastSummarizedEntry = summarizedEntries.reduce((latest, entry) =>
    entry.seq > latest.seq ? entry : latest,
  );
  const firstKeptEntry = tailEntries.reduce((first, entry) =>
    entry.seq < first.seq ? entry : first,
  );
  return Object.freeze({
    coversThroughEntryId: lastSummarizedEntry.entryId,
    firstKeptEntryId: firstKeptEntry.entryId,
    retainedUserEntryIds: sparseUserEntryIds,
    retainedEntries,
    summaryGroups,
  });
}

function additionalGroupTokenCount(
  group: ContextMessageGroup | undefined,
  retainedUserEntryIds: ReadonlySet<string>,
): number {
  if (!group) throw new Error("压缩选择缺少消息组。");
  return group.entries.reduce(
    (tokenCount, entry) =>
      tokenCount +
      (retainedUserEntryIds.has(entry.entryId) ? 0 : estimateModelMessageTokens(entry.message)),
    0,
  );
}
