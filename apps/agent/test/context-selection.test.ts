import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { estimateModelMessageTokens } from "../src/context/budget.js";
import {
  type ContextMessageEntry,
  type ContextProjection,
  createCompactionMessage,
  projectContextHistory,
  snapshotSources,
} from "../src/context/projection.js";
import { selectCompaction } from "../src/context/selection.js";
import type { ModelInputMessage } from "../src/model/model-stream.js";
import {
  type AgentInputRecord,
  type CompactionRecord,
  type ContextSourceRecord,
  fromDurableMessage,
  isValidCompactionRecord,
  type MessageRecord,
  toDurableMessage,
} from "../src/session/schema.js";

function contextEntry(
  entryId: string,
  seq: number,
  message: ModelInputMessage,
): ContextMessageEntry {
  return Object.freeze({ entryId, seq, recordType: "message", message: { ...message, entryId } });
}

function projection(entries: readonly ContextMessageEntry[]): ContextProjection {
  const records = entries.map((entry) => ({
    ...messageRecord(
      entry.seq,
      null,
      randomUUID(),
      toDurableMessage(
        entry.message.role === "assistant"
          ? {
              role: "assistant",
              status: "completed",
              content: entry.message.content.filter((part) => part.type !== "reasoning"),
            }
          : entry.message,
      ),
    ),
    entryId: entry.entryId,
  }));
  return projectContextHistory(
    records,
    entries.map((entry) => ({ ...entry.message, entryId: entry.entryId })),
  );
}

function messageRecord(
  seq: number,
  parentEntryId: string | null,
  runId: string,
  message: MessageRecord["message"],
): MessageRecord {
  return Object.freeze({
    type: "message",
    entryId: randomUUID(),
    seq,
    timestamp: `2026-09-05T00:00:${String(seq).padStart(2, "0")}.000Z`,
    parentEntryId,
    runId,
    message,
  });
}

function compactionRecord(
  seq: number,
  parentEntryId: string,
  details: Pick<
    CompactionRecord,
    "summary" | "coversThroughEntryId" | "firstKeptEntryId" | "retainedUserEntryIds"
  >,
): CompactionRecord {
  return Object.freeze({
    type: "compaction",
    entryId: randomUUID(),
    seq,
    timestamp: `2026-09-05T00:00:${String(seq).padStart(2, "0")}.000Z`,
    parentEntryId,
    ...details,
    usageBefore: {
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
    },
    inputTokenEstimateAfter: 1,
    modelId: "test-model",
    contextVersion: "context-v1",
  });
}

function userMessage(content: string): ModelInputMessage {
  return Object.freeze({ role: "user", content });
}

function assistantText(text: string): ModelInputMessage {
  return Object.freeze({
    role: "assistant",
    content: Object.freeze([Object.freeze({ type: "text" as const, text })]),
  });
}

describe("Context selection", () => {
  it("keeps newer real user entries before older users while retaining a recent tail", () => {
    const oldestUser = contextEntry(randomUUID(), 1, userMessage("最早的用户要求".repeat(8)));
    const oldestAssistant = contextEntry(randomUUID(), 2, assistantText("旧说明".repeat(8)));
    const newerUser = contextEntry(randomUUID(), 3, userMessage("较新的用户纠正".repeat(8)));
    const newerAssistant = contextEntry(randomUUID(), 4, assistantText("较新的说明".repeat(8)));
    const latestUser = contextEntry(randomUUID(), 5, userMessage("最新用户请求".repeat(8)));
    const latestAssistant = contextEntry(randomUUID(), 6, assistantText("近期回答".repeat(8)));
    const retainedTarget =
      estimateModelMessageTokens(newerUser.message) +
      estimateModelMessageTokens(latestUser.message);

    const selection = selectCompaction(
      projection([
        oldestUser,
        oldestAssistant,
        newerUser,
        newerAssistant,
        latestUser,
        latestAssistant,
      ]),
      retainedTarget,
    );

    if (selection === null) {
      throw new Error("expected a compaction selection");
    }
    expect(selection.retainedUserEntryIds).toEqual([newerUser.entryId, latestUser.entryId]);
    expect(selection.retainedEntries.map((entry) => entry.entryId)).toEqual([
      newerUser.entryId,
      latestUser.entryId,
      latestAssistant.entryId,
    ]);
    expect(selection.summaryGroups.flatMap((group) => group.map((entry) => entry.entryId))).toEqual(
      [oldestUser.entryId, oldestAssistant.entryId, newerAssistant.entryId],
    );
  });

  it("moves a completed ToolCall and all of its results as one long-Run group", () => {
    const runId = randomUUID();
    const toolCallId = randomUUID();
    const user = contextEntry(randomUUID(), 1, userMessage("检查文件"));
    const toolCall = contextEntry(
      randomUUID(),
      2,
      Object.freeze({
        role: "assistant" as const,
        content: Object.freeze([
          Object.freeze({
            type: "tool_call" as const,
            toolCallId,
            toolName: "read_file",
            input: Object.freeze({ path: "a.txt" }),
            invalid: false,
          }),
        ]),
      }),
    );
    const toolResult = contextEntry(
      randomUUID(),
      3,
      Object.freeze({
        role: "tool" as const,
        toolCallId,
        toolName: "read_file",
        status: "completed" as const,
        content: "文件内容",
        truncated: false,
      }),
    );
    const finalAssistant = contextEntry(randomUUID(), 4, assistantText(`已完成 ${runId}`));

    const selection = selectCompaction(projection([user, toolCall, toolResult, finalAssistant]), 0);

    if (selection === null) {
      throw new Error("expected a compaction selection");
    }
    expect(selection.retainedUserEntryIds).toEqual([user.entryId]);
    expect(selection.summaryGroups).toHaveLength(1);
    expect(selection.summaryGroups[0]?.map((entry) => entry.entryId)).toEqual([
      toolCall.entryId,
      toolResult.entryId,
    ]);
  });

  it("rebuilds incrementally from one checkpoint without duplicating an old summary", () => {
    const runId = randomUUID();
    const firstUser = messageRecord(1, null, runId, {
      type: "user",
      content: [{ type: "text", text: "初始任务" }],
    });
    const firstAssistant = messageRecord(2, firstUser.entryId, runId, {
      type: "assistant",
      content: [{ type: "text", text: "初始回答" }],
      status: "completed",
    });
    const checkpoint = compactionRecord(3, firstAssistant.entryId, {
      summary: "第一次已保存摘要",
      coversThroughEntryId: firstUser.entryId,
      firstKeptEntryId: firstAssistant.entryId,
      retainedUserEntryIds: [firstUser.entryId],
    });
    const secondUser = messageRecord(4, checkpoint.entryId, randomUUID(), {
      type: "user",
      content: [{ type: "text", text: "后续纠正" }],
    });
    const secondAssistant = messageRecord(5, secondUser.entryId, secondUser.runId, {
      type: "assistant",
      content: [{ type: "text", text: "后续回答" }],
      status: "completed",
    });
    const firstAssistantWithReasoning: ModelInputMessage = Object.freeze({
      entryId: firstAssistant.entryId,
      role: "assistant" as const,
      content: Object.freeze([
        Object.freeze({ type: "reasoning" as const, text: "当前 Run 的推理" }),
        Object.freeze({ type: "text" as const, text: "初始回答" }),
      ]),
    });
    const secondAssistantWithReasoning: ModelInputMessage = Object.freeze({
      entryId: secondAssistant.entryId,
      role: "assistant" as const,
      content: Object.freeze([
        Object.freeze({ type: "reasoning" as const, text: "后续推理" }),
        Object.freeze({ type: "text" as const, text: "后续回答" }),
      ]),
    });
    const rawMessages = Object.freeze([
      createCompactionMessage("旧摘要"),
      { ...userMessage("初始任务"), entryId: firstUser.entryId },
      firstAssistantWithReasoning,
      { ...userMessage("后续纠正"), entryId: secondUser.entryId },
      secondAssistantWithReasoning,
      userMessage("刚追加但尚未映射的输入"),
    ]);

    const result = projectContextHistory(
      [firstUser, firstAssistant, checkpoint, secondUser, secondAssistant],
      rawMessages,
    );

    expect(result.checkpoint?.entryId).toBe(checkpoint.entryId);
    expect(result.entries.map((entry) => entry.entryId)).toEqual([
      firstUser.entryId,
      firstAssistant.entryId,
      secondUser.entryId,
      secondAssistant.entryId,
    ]);
    expect(result.messages).toHaveLength(6);
    expect(result.messages[0]).toEqual(createCompactionMessage(checkpoint.summary));
    expect(result.messages[2]).toBe(firstAssistantWithReasoning);
    expect(result.messages[4]).toBe(secondAssistantWithReasoning);
    expect(result.messages[5]).toEqual(userMessage("刚追加但尚未映射的输入"));
  });

  it("distinguishes identical user messages by durable identity instead of text", () => {
    const first = messageRecord(1, null, randomUUID(), {
      type: "user",
      content: [{ type: "text", text: "继续" }],
    });
    const second = messageRecord(2, first.entryId, first.runId, {
      type: "user",
      content: [{ type: "text", text: "继续" }],
    });
    const result = projectContextHistory(
      [first, second],
      [{ ...userMessage("继续"), entryId: second.entryId }, userMessage("继续")],
    );
    expect(result.entries.map((entry) => entry.entryId)).toEqual([second.entryId]);
    expect(result.messages).toHaveLength(2);
  });

  it("falls back to the previous checkpoint when the newest tail starts inside a Tool group", () => {
    const runId = randomUUID();
    const toolCallId = randomUUID();
    const user = messageRecord(1, null, runId, {
      type: "user",
      content: [{ type: "text", text: "读取文件" }],
    });
    const assistantToolCall = messageRecord(2, user.entryId, runId, {
      type: "assistant",
      content: [
        {
          type: "tool_call",
          toolCallId,
          toolName: "read_file",
          input: { path: "a.txt" },
          invalid: false,
        },
      ],
      status: "completed",
    });
    const toolResult = messageRecord(3, assistantToolCall.entryId, runId, {
      type: "tool_result",
      toolCallId,
      toolName: "read_file",
      status: "completed",
      content: "内容",
      truncated: false,
    });
    const finalAssistant = messageRecord(4, toolResult.entryId, runId, {
      type: "assistant",
      content: [{ type: "text", text: "完成" }],
      status: "completed",
    });
    const firstCheckpoint = compactionRecord(5, finalAssistant.entryId, {
      summary: "完整工具组摘要",
      coversThroughEntryId: user.entryId,
      firstKeptEntryId: assistantToolCall.entryId,
      retainedUserEntryIds: [user.entryId],
    });
    const secondCheckpoint = compactionRecord(6, firstCheckpoint.entryId, {
      summary: "错误切点摘要",
      coversThroughEntryId: assistantToolCall.entryId,
      firstKeptEntryId: toolResult.entryId,
      retainedUserEntryIds: [user.entryId],
    });

    const result = projectContextHistory(
      [user, assistantToolCall, toolResult, finalAssistant, firstCheckpoint, secondCheckpoint],
      [
        userMessage("读取文件"),
        Object.freeze({
          role: "assistant" as const,
          content: Object.freeze([
            Object.freeze({
              type: "tool_call" as const,
              toolCallId,
              toolName: "read_file",
              input: Object.freeze({ path: "a.txt" }),
              invalid: false,
            }),
          ]),
        }),
        Object.freeze({
          role: "tool" as const,
          toolCallId,
          toolName: "read_file",
          status: "completed" as const,
          content: "内容",
          truncated: false,
        }),
        assistantText("完成"),
      ],
    );

    expect(result.checkpoint?.entryId).toBe(firstCheckpoint.entryId);
  });

  it("shares complete Tool groups across member input placement, source revocation and compaction", () => {
    const runId = randomUUID();
    const user = messageRecord(1, null, runId, {
      type: "user",
      content: [{ type: "text", text: "读取两个文件" }],
    });
    const callIds = [randomUUID(), randomUUID()];
    const assistant = messageRecord(2, user.entryId, runId, {
      type: "assistant",
      status: "completed",
      content: callIds.map((toolCallId) => ({
        type: "tool_call",
        toolCallId,
        toolName: "read_file",
        input: { path: "file.txt" },
        invalid: false,
      })),
    });
    const source: ContextSourceRecord = {
      type: "context_source",
      entryId: randomUUID(),
      seq: 3,
      timestamp: "2026-09-09T00:00:00.000Z",
      parentEntryId: assistant.entryId,
      sourceId: "skill:test",
      kind: "skill",
      label: "test",
      content: "外部来源原文",
      fingerprint: "v1",
      projection: { version: 1, afterEntryId: assistant.entryId },
    };
    const memberInput: AgentInputRecord = {
      type: "agent_input",
      entryId: randomUUID(),
      seq: 4,
      timestamp: source.timestamp,
      parentEntryId: source.entryId,
      runId,
      messageId: randomUUID(),
      rootSessionId: randomUUID(),
      fromSessionId: randomUUID(),
      kind: "result",
      content: "成员事实",
    };
    const firstResult = messageRecord(5, memberInput.entryId, runId, {
      type: "tool_result",
      toolCallId: callIds[0] ?? "",
      toolName: "read_file",
      status: "completed",
      content: "first",
      truncated: false,
    });
    const revoked: ContextSourceRecord = {
      ...source,
      entryId: randomUUID(),
      seq: 6,
      parentEntryId: firstResult.entryId,
      content: null,
      fingerprint: "v2",
    };
    const secondResult = messageRecord(7, revoked.entryId, runId, {
      type: "tool_result",
      toolCallId: callIds[1] ?? "",
      toolName: "read_file",
      status: "completed",
      content: "second",
      truncated: false,
    });
    const finished = messageRecord(8, secondResult.entryId, runId, {
      type: "assistant",
      content: [{ type: "text", text: "完成" }],
      status: "completed",
    });
    const records = [
      user,
      assistant,
      source,
      memberInput,
      firstResult,
      revoked,
      secondResult,
      finished,
    ];
    const rawMessages = [user, assistant, firstResult, secondResult, finished].map((record) => ({
      ...fromDurableMessage(record.message),
      entryId: record.entryId,
    }));
    const projected = projectContextHistory(records, rawMessages);
    expect(projected.entries.map((entry) => entry.seq)).toEqual([1, 2, 4, 5, 7, 8]);
    expect(projected.messages.map((message) => message.entryId)).toEqual([
      user.entryId,
      assistant.entryId,
      firstResult.entryId,
      secondResult.entryId,
      memberInput.entryId,
      source.entryId,
      revoked.entryId,
      finished.entryId,
    ]);
    expect(
      projected.messages.find((message) => message.entryId === memberInput.entryId),
    ).toMatchObject({
      role: "user",
      content: expect.stringContaining("不是用户授权"),
    });
    const selected = selectCompaction(projected, 0);
    if (!selected) throw new Error("expected compaction selection");
    expect(selected.summaryGroups.map((group) => group.map((entry) => entry.entryId))).toEqual([
      [user.entryId],
      [assistant.entryId, firstResult.entryId, secondResult.entryId],
    ]);
    expect(selected.retainedEntries.map((entry) => entry.entryId)).toEqual([
      memberInput.entryId,
      finished.entryId,
    ]);
    const checkpoint = {
      ...compactionRecord(9, finished.entryId, {
        summary: "完整工具历史",
        coversThroughEntryId: selected.coversThroughEntryId,
        firstKeptEntryId: selected.firstKeptEntryId,
        retainedUserEntryIds: selected.retainedUserEntryIds,
      }),
      projection: snapshotSources(
        records,
        selected.retainedEntries.map((entry) => entry.entryId),
      ),
    };
    expect(
      isValidCompactionRecord(
        checkpoint,
        new Map(records.map((record) => [record.entryId, record])),
      ),
    ).toBe(true);
    const restored = projectContextHistory([...records, checkpoint], []);
    expect(restored.checkpoint?.entryId).toBe(checkpoint.entryId);
    expect(restored.messages.map((message) => message.entryId)).toEqual([
      undefined,
      memberInput.entryId,
      finished.entryId,
    ]);

    const withoutFinal = projectContextHistory(
      records.filter((record) => record.entryId !== finished.entryId),
      rawMessages.filter((message) => message.entryId !== finished.entryId),
    );
    const retainedTail = selectCompaction(withoutFinal, 0);
    expect(retainedTail?.firstKeptEntryId).toBe(assistant.entryId);
    expect(retainedTail?.retainedEntries.map((entry) => entry.seq)).toEqual([2, 4, 5, 7]);

    const incompleteRecords = records.filter((record) => record.entryId !== secondResult.entryId);
    const incomplete = projectContextHistory(
      incompleteRecords,
      rawMessages.filter((message) => message.entryId !== secondResult.entryId),
    );
    expect(
      incomplete.messages.some(
        (message) => message.entryId === source.entryId || message.entryId === revoked.entryId,
      ),
    ).toBe(false);
    expect(incomplete.messages.at(-1)?.entryId).toBe(memberInput.entryId);
    expect(
      selectCompaction(incomplete, 0)
        ?.summaryGroups.flat()
        .some((entry) => entry.entryId === assistant.entryId),
    ).toBe(false);
  });
});
