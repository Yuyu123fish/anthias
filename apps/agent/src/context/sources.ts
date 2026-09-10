import type { Memory } from "../memory/index.js";
import { type MemoryEntry, memoryHash } from "../memory/schema.js";
import { resolveMemoryProject } from "../memory/selection.js";
import type { ModelInputMessage } from "../model/model-stream.js";
import type { Session } from "../session/index.js";
import type { ContextSourceDetails, SessionRecord } from "../session/schema.js";
import { readProjectRules } from "./project-rules.js";

export type ContextSources = ReturnType<typeof createContextSources>;
export const MEMORY_REVOKED_ERROR =
  "当前生成采用的记忆已撤销，已停止继续生成和尚未执行的工具；请继续任务以重建上下文。";
const INITIAL_MEMORY_BYTES = 8 * 1024;

/** 来源采用以 Session 追加成功为准；记忆库更新与本会话采用是两个独立提交。 */
export function createContextSources(options: {
  session: Session;
  memory?: Memory;
  appendSource: (details: ContextSourceDetails) => Promise<void>;
  environment: () => string;
  skillDirectory: () => string;
}) {
  const active = new Map<string, ContextSourceDetails>();
  for (const record of options.session.records) {
    if (record.type !== "context_source") continue;
    if (record.content === null) active.delete(record.sourceId);
    else active.set(record.sourceId, record);
  }
  let forgotten: readonly MemoryEntry[] = [];
  let executionMemoryVersions = new Set<string>();
  let prepared = false;

  async function save(source: ContextSourceDetails, force = false) {
    const previous =
      active.get(source.sourceId) ??
      options.session.records.findLast(
        (record): record is Extract<SessionRecord, { type: "context_source" }> =>
          record.type === "context_source" && record.sourceId === source.sourceId,
      );
    if (
      previous?.fingerprint === source.fingerprint &&
      previous.content === source.content &&
      previous.label === source.label
    )
      return;
    if (
      !force &&
      !previous &&
      source.content === null &&
      !options.session.records.some(
        (record) => record.type === "context_source" && record.sourceId === source.sourceId,
      )
    )
      return;
    const bytes =
      [...active.values()]
        .filter((item) => item.sourceId !== source.sourceId)
        .reduce((total, item) => total + Buffer.byteLength(item.content ?? ""), 0) +
      Buffer.byteLength(source.content ?? "");
    if (bytes > 128 * 1024) throw new Error("活跃来源超过 128 KiB，请减少已加载内容。");
    const lastAssistant = options.session.records.findLast(
      (record) =>
        record.type === "message" &&
        record.message.role === "assistant" &&
        record.message.content.some((part) => part.type === "tool_call"),
    );
    const details: ContextSourceDetails = {
      ...source,
      projection: {
        version: 1,
        ...source.projection,
        ...(lastAssistant ? { afterEntryId: lastAssistant.entryId } : {}),
      },
    };
    await options.appendSource(details);
    if (details.content === null) active.delete(details.sourceId);
    else active.set(details.sourceId, details);
  }
  function sourceExists(sourceId: string) {
    return options.session.records.some(
      (record) => record.type === "context_source" && record.sourceId === sourceId,
    );
  }
  function initialPlacement(order: 2 | 3 | 4 | 5 | 6, initial: boolean) {
    return initial ? { version: 1 as const, initialOrder: order } : { version: 1 as const };
  }
  function memorySource(
    entry: MemoryEntry,
    initial = false,
    referenceOnly = false,
  ): ContextSourceDetails {
    const sourceId = "memory:" + entry.id;
    const content = JSON.stringify({
      content: entry.content,
      status: entry.status,
      scope: entry.scope,
      conditions: entry.conditions,
      confirmedAt: entry.confirmedAt,
      userConfirmed: entry.userConfirmed ?? entry.source.kind === "user",
      expiresAt: entry.expiresAt,
      evidence: { kind: entry.source.kind, note: entry.source.note },
      ...(referenceOnly
        ? { referenceOnly: true, rule: "仅供核对，不得当作确定事实默认采用。" }
        : {}),
    });
    return {
      sourceId,
      kind: entry.kind === "user" ? "user_memory" : "experience_memory",
      label: (entry.kind === "user" ? "用户记忆 " : "经验记忆 ") + entry.id + " @" + entry.revision,
      content,
      fingerprint: memoryHash(content + ":" + entry.revision),
      projection: {
        ...initialPlacement(entry.kind === "user" ? 2 : 6, initial),
        memoryIds: [entry.id],
      },
    };
  }
  async function adoptMemory(entry: MemoryEntry, initial = false, referenceOnly = false) {
    await save(memorySource(entry, initial, referenceOnly));
  }
  async function prepare(signal: AbortSignal) {
    signal.throwIfAborted();
    const initial = !sourceExists("environment");
    const project = options.memory
      ? await options.memory.project(signal)
      : await resolveMemoryProject(options.session.workspaceRoot, signal);
    const environment = options.environment();
    await save({
      sourceId: "environment",
      kind: "environment",
      label: "任务环境",
      content: environment,
      fingerprint: memoryHash(environment),
      projection: initialPlacement(3, initial),
    });
    const rules = await readProjectRules(project, signal);
    await save({ ...rules, projection: initialPlacement(4, initial) });
    const directory = options.skillDirectory();
    await save({
      sourceId: "skill-directory",
      kind: "skill_directory",
      label: "可用 Skill 目录",
      content: directory,
      fingerprint: memoryHash(directory),
      projection: initialPlacement(5, initial),
    });
    if (options.memory) {
      const snapshot = await options.memory.query({ status: "all" }, signal);
      if (snapshot.diagnostics.length)
        throw new Error("记忆状态不可确认，已暂停使用旧来源。请检查 /memory。");
      forgotten = snapshot.entries.filter((entry) => entry.status === "forgotten");
      for (const entry of forgotten) {
        await save(
          {
            sourceId: "memory-revocation:" + entry.id,
            kind: entry.kind === "user" ? "user_memory" : "experience_memory",
            label: "记忆撤销 " + entry.id,
            content: null,
            fingerprint: memoryHash("forgotten:" + entry.revision + ":" + entry.stopSending),
            projection: { version: 1, memoryIds: [entry.id] },
          },
          true,
        );
      }
      const usable = snapshot.entries.filter((entry) => entry.status === "active");
      const byId = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
      for (const source of [...active.values()]) {
        if (
          !source.sourceId.startsWith("memory:") ||
          (source.kind !== "user_memory" && source.kind !== "experience_memory")
        )
          continue;
        const id = source.projection?.memoryIds?.[0];
        const entry = id ? byId.get(id) : undefined;
        const referenceOnly =
          source.content !== null &&
          (() => {
            try {
              return JSON.parse(source.content).referenceOnly === true;
            } catch {
              return false;
            }
          })();
        if (entry && entry.status !== "forgotten" && entry.status !== "active" && referenceOnly) {
          await adoptMemory(entry, false, true);
        } else if (entry?.status !== "active") {
          await save({
            ...source,
            content: null,
            fingerprint: memoryHash(
              (entry?.status ?? "unavailable") + ":" + (entry?.revision ?? 0),
            ),
            projection: { version: 1, ...(id ? { memoryIds: [id] } : {}) },
          });
        } else await adoptMemory(entry);
      }
      let userBytes = 0;
      const selectedUserIds = new Set<string>();
      for (const entry of usable.filter(
        (entry) => entry.kind === "user" && entry.scope === "global",
      )) {
        const bytes = Buffer.byteLength(JSON.stringify(memorySource(entry))) + 256;
        if (userBytes + bytes > INITIAL_MEMORY_BYTES) continue;
        userBytes += bytes;
        selectedUserIds.add(entry.id);
        await adoptMemory(entry, initial);
      }
      const indexed = usable.filter((entry) => !selectedUserIds.has(entry.id));
      let indexBytes = 512;
      const index: Array<{ id: string; revision: number; kind: string; preview: string }> = [];
      for (const entry of indexed) {
        const item = {
          id: entry.id,
          revision: entry.revision,
          kind: entry.kind,
          preview: (entry.content ?? "").slice(0, 100),
        };
        const size = Buffer.byteLength(JSON.stringify(item));
        if (indexBytes + size > INITIAL_MEMORY_BYTES) continue;
        indexBytes += size;
        index.push(item);
      }
      const indexContent = JSON.stringify({
        entries: index,
        omitted: indexed.length - index.length,
        instruction: "按任务需要使用 memory read 读取正文；无关经验不必读取。",
        diagnostics: snapshot.diagnostics,
      });
      await save({
        sourceId: "memory-index",
        kind: "memory_index",
        label: "适用记忆索引",
        content: indexContent,
        fingerprint: memoryHash(indexContent),
        projection: { ...initialPlacement(6, initial), memoryIds: index.map((entry) => entry.id) },
      });
      if (initial) {
        const user = options.session.records.findLast(
          (record) => record.type === "message" && record.message.role === "user",
        );
        const text =
          user?.type === "message" && user.message.role === "user" ? user.message.content : "";
        const words = text.match(/[a-zA-Z0-9_./-]{3,}|[\u4e00-\u9fff]{2,}/gu) ?? [];
        let selectedBytes = 0;
        let selectedCount = 0;
        for (const entry of indexed) {
          if (entry.kind !== "experience" || !words.some((word) => entry.content?.includes(word)))
            continue;
          const bytes = Buffer.byteLength(JSON.stringify(memorySource(entry))) + 256;
          if (selectedCount >= 2 || selectedBytes + bytes > INITIAL_MEMORY_BYTES) continue;
          selectedCount++;
          selectedBytes += bytes;
          await adoptMemory(entry, true);
        }
      }
    }
    prepared = true;
    signal.throwIfAborted();
  }

  function safeRecords(): readonly SessionRecord[] {
    if (!forgotten.length) return options.session.records;
    const forgottenIds = new Set(forgotten.map((entry) => entry.id));
    const noSend = forgotten.filter((entry) => entry.stopSending);
    const suppressedRecordIds = new Set(
      noSend.flatMap((entry) => [...entry.suppressedSources, ...entry.source.entryIds]),
    );
    const forbiddenText: string[] = [];
    let firstAffectedSequence = Number.MAX_SAFE_INTEGER;
    const blockedSourceIds = new Set<string>();
    for (const record of options.session.records) {
      if (
        record.type !== "context_source" ||
        !record.projection?.memoryIds?.some((id) => forgottenIds.has(id))
      )
        continue;
      if (record.content === null) continue;
      blockedSourceIds.add(record.entryId);
      firstAffectedSequence = Math.min(firstAffectedSequence, record.seq);
      if (
        record.content &&
        record.projection.memoryIds.some((id) => noSend.some((entry) => entry.id === id))
      ) {
        try {
          const content: unknown = JSON.parse(record.content);
          if (
            typeof content === "object" &&
            content !== null &&
            "content" in content &&
            typeof content.content === "string"
          )
            forbiddenText.push(content.content);
        } catch {
          /* 非记忆正文来源通过身份整体排除。 */
        }
      }
    }
    const lastAffectedSequence = Math.max(
      0,
      ...options.session.records
        .filter(
          (record) =>
            record.type === "context_source" &&
            record.sourceId.startsWith("memory-revocation:") &&
            record.projection?.memoryIds?.some((id) => noSend.some((entry) => entry.id === id)),
        )
        .map((record) => record.seq),
    );
    const originSequence = Math.min(
      firstAffectedSequence,
      ...options.session.records
        .filter((record) => suppressedRecordIds.has(record.entryId))
        .map((record) => record.seq),
    );
    const blockedCalls = new Set<string>();
    for (const record of options.session.records) {
      if (record.type !== "message") continue;
      const body = JSON.stringify(record.message);
      const blocked =
        suppressedRecordIds.has(record.entryId) ||
        (noSend.length > 0 &&
          ((record.message.role !== "user" &&
            record.seq >= originSequence &&
            record.seq <= lastAffectedSequence) ||
            forbiddenText.some((text) => body.includes(JSON.stringify(text).slice(1, -1)))));
      if (!blocked) continue;
      suppressedRecordIds.add(record.entryId);
      if (record.message.role === "assistant")
        for (const part of record.message.content)
          if (part.type === "tool_call") blockedCalls.add(part.toolCallId);
    }
    // 任一结果需要排除时，整个调用组一起排除，不能产生悬空 ToolResult。
    for (const record of options.session.records) {
      if (record.type !== "message" || record.message.role !== "assistant") continue;
      const calls = record.message.content.filter((part) => part.type === "tool_call");
      const callIds = new Set(calls.map((call) => call.toolCallId));
      const results = options.session.records.filter(
        (result) =>
          result.type === "message" &&
          result.message.role === "tool" &&
          callIds.has(result.message.toolCallId),
      );
      if (
        suppressedRecordIds.has(record.entryId) ||
        results.some((result) => suppressedRecordIds.has(result.entryId))
      ) {
        suppressedRecordIds.add(record.entryId);
        for (const call of calls) blockedCalls.add(call.toolCallId);
      }
    }
    return options.session.records.filter((record) => {
      if (blockedSourceIds.has(record.entryId) || suppressedRecordIds.has(record.entryId))
        return false;
      if (
        record.type === "message" &&
        record.message.role === "tool" &&
        blockedCalls.has(record.message.toolCallId)
      )
        return false;
      if (record.type === "compaction") {
        if (!record.projection && firstAffectedSequence < record.seq) return false;
        if (
          record.projection?.sourceVersions.some((source) => blockedSourceIds.has(source.entryId))
        )
          return false;
        if (noSend.length && record.seq >= originSequence && record.seq <= lastAffectedSequence)
          return false;
      }
      return true;
    });
  }
  function filterMessages(messages: readonly ModelInputMessage[]): readonly ModelInputMessage[] {
    const validIds = new Set(safeRecords().map((record) => record.entryId));
    return messages.filter((message) => !message.entryId || validIds.has(message.entryId));
  }
  function markRequest() {
    executionMemoryVersions = new Set(
      [...active.values()].flatMap((source) => source.projection?.memoryIds ?? []),
    );
  }
  async function checkExecution(signal: AbortSignal) {
    if (!prepared || !options.memory || !executionMemoryVersions.size) return;
    const snapshot = await options.memory.query({ status: "all" }, signal);
    if (
      snapshot.diagnostics.length ||
      snapshot.entries.some(
        (entry) => entry.status === "forgotten" && executionMemoryVersions.has(entry.id),
      )
    )
      throw new Error(MEMORY_REVOKED_ERROR);
  }
  return {
    active: active as ReadonlyMap<string, ContextSourceDetails>,
    save,
    prepare,
    adoptMemory,
    safeRecords,
    filterMessages,
    markRequest,
    checkExecution,
  };
}
