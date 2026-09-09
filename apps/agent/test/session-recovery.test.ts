import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../src/message.js";
import { createSession, openSession, type SessionShell } from "../src/session/index.js";
import { readSessionJournal } from "../src/session/journal.js";
import { getSessionStorageRelativeDirectory } from "../src/session/locations.js";
import { acquireSessionUsageMarker, inspectSessionUsageMarkers } from "../src/session/lock.js";
import { readSessionHistory } from "../src/session/query.js";

const usageMarkerSyncFault = vi.hoisted(() => ({ enabled: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    async open(...parameters: Parameters<typeof original.open>) {
      const fileHandle = await original.open(...parameters);
      const normalizedPath = String(parameters[0]).replaceAll("\\", "/");
      if (
        !usageMarkerSyncFault.enabled ||
        !/\/usage\/[0-9a-f-]{36}\.json$/iu.test(normalizedPath)
      ) {
        return fileHandle;
      }
      return new Proxy(fileHandle, {
        get(target, property) {
          if (property === "sync") {
            return async () => {
              throw new Error("forced usage marker sync failure");
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

const temporaryDirectories = new Set<string>();
const TEST_SHELL: SessionShell = Object.freeze({
  kind: "powershell",
  executable: "pwsh",
  arguments: Object.freeze(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]),
});

const USER_MESSAGE: Message = Object.freeze({ role: "user", content: "中文问题" });
const ASSISTANT_MESSAGE: Message = Object.freeze({
  role: "assistant",
  content: Object.freeze([{ type: "text" as const, text: "中文回答" }]),
  status: "completed",
});

afterEach(async () => {
  usageMarkerSyncFault.enabled = false;
  await Promise.all(
    [...temporaryDirectories].map((temporaryDirectory) =>
      rm(temporaryDirectory, { recursive: true, force: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe("Session recovery storage", () => {
  it("migrates an explicitly opened Schema 1 journal with a backup and a linear parent chain", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-migration-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    await mkdir(sessionDirectory);
    const sessionId = randomUUID();
    const runId = randomUUID();
    const createdAt = "2026-02-03T04:05:06.789Z";
    const legacyBytes = await writeLegacyCompletedRun({
      sessionDirectory,
      sessionId,
      runId,
      workspaceRoot: fixtureRoot,
      createdAt,
    });

    const reopenedSession = await openSession({
      sessionId,
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });

    const expectedRelativeStorageDirectory = getSessionStorageRelativeDirectory({
      type: "session_header",
      schemaVersion: 2,
      sessionId,
      createdAt,
      workspaceRoot: fixtureRoot,
      shell: TEST_SHELL,
    });
    expect(reopenedSession.storageDirectory).toBe(
      join(sessionDirectory, expectedRelativeStorageDirectory),
    );
    await expect(readFile(join(sessionDirectory, `${sessionId}.jsonl`))).rejects.toThrow();
    expect(
      await readFile(
        join(reopenedSession.storageDirectory, "migration-backup", "legacy-session.jsonl"),
      ),
    ).toEqual(legacyBytes);

    const migratedJournal = await readSessionJournal(
      join(reopenedSession.storageDirectory, "session.jsonl"),
    );
    expect(migratedJournal.header.schemaVersion).toBe(2);
    expect(migratedJournal.records.map((record) => record.seq)).toEqual([1, 2, 3, 4]);
    expect(migratedJournal.records.map((record) => record.parentEntryId)).toEqual([
      null,
      migratedJournal.records[0]?.entryId,
      migratedJournal.records[1]?.entryId,
      migratedJournal.records[2]?.entryId,
    ]);
    expect(migratedJournal.records.slice(0, 3).map((record) => record.entryId)).toEqual(
      legacyRecordIds(legacyBytes),
    );
    expect(migratedJournal.records.at(-1)).toMatchObject({
      type: "session_use",
      activity: "opened",
    });
    await expect(
      readFile(join(reopenedSession.storageDirectory, "migration-state.json")),
    ).rejects.toThrow();
    await reopenedSession.close();
  });

  it("finishes a published migration interruption only when its backup confirms the old source", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-migration-published-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    await mkdir(sessionDirectory);
    const sessionId = randomUUID();
    const runId = randomUUID();
    const createdAt = "2026-03-04T05:06:07.890Z";
    const legacyBytes = await writeLegacyCompletedRun({
      sessionDirectory,
      sessionId,
      runId,
      workspaceRoot: fixtureRoot,
      createdAt,
    });
    const header = {
      type: "session_header" as const,
      schemaVersion: 2 as const,
      sessionId,
      createdAt,
      workspaceRoot: fixtureRoot,
      shell: TEST_SHELL,
    };
    const relativeStorageDirectory = getSessionStorageRelativeDirectory(header);
    const storageDirectory = join(sessionDirectory, relativeStorageDirectory);
    await mkdir(storageDirectory, { recursive: true });
    const migratedRecords = legacyRecordsFromBytes(legacyBytes).map((record, index) => ({
      ...record,
      parentEntryId: index === 0 ? null : legacyRecordsFromBytes(legacyBytes)[index - 1]?.entryId,
    }));
    await writeFile(
      join(storageDirectory, "session.jsonl"),
      `${JSON.stringify(header)}\n${migratedRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
    await mkdir(join(storageDirectory, "migration-backup"));
    await writeFile(
      join(storageDirectory, "migration-backup", "legacy-session.jsonl"),
      legacyBytes,
    );
    await writeFile(
      join(storageDirectory, "migration-state.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        sessionId,
        legacyFileName: `${sessionId}.jsonl`,
        state: "published",
      })}\n`,
      "utf8",
    );

    const reopenedSession = await openSession({
      sessionId,
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });

    await expect(readFile(join(sessionDirectory, `${sessionId}.jsonl`))).rejects.toThrow();
    await expect(readFile(join(storageDirectory, "migration-state.json"))).rejects.toThrow();
    expect(reopenedSession.records.at(-1)).toMatchObject({
      type: "session_use",
      activity: "opened",
    });
    await reopenedSession.close();
  });

  it("refuses a published migration whose backup conflicts with its remaining Schema 1 source", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-migration-conflict-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    await mkdir(sessionDirectory);
    const sessionId = randomUUID();
    const runId = randomUUID();
    const createdAt = "2026-04-05T06:07:08.901Z";
    const legacyBytes = await writeLegacyCompletedRun({
      sessionDirectory,
      sessionId,
      runId,
      workspaceRoot: fixtureRoot,
      createdAt,
    });
    const header = {
      type: "session_header" as const,
      schemaVersion: 2 as const,
      sessionId,
      createdAt,
      workspaceRoot: fixtureRoot,
      shell: TEST_SHELL,
    };
    const storageDirectory = join(sessionDirectory, getSessionStorageRelativeDirectory(header));
    await mkdir(storageDirectory, { recursive: true });
    const legacyRecords = legacyRecordsFromBytes(legacyBytes);
    const migratedRecords = legacyRecords.map((record, index) => ({
      ...record,
      parentEntryId: index === 0 ? null : legacyRecords[index - 1]?.entryId,
    }));
    await writeFile(
      join(storageDirectory, "session.jsonl"),
      `${JSON.stringify(header)}\n${migratedRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
    await mkdir(join(storageDirectory, "migration-backup"));
    const conflictingBackup = Buffer.from(legacyBytes);
    conflictingBackup[0] = 0x5b;
    await writeFile(
      join(storageDirectory, "migration-backup", "legacy-session.jsonl"),
      conflictingBackup,
    );
    await writeFile(
      join(storageDirectory, "migration-state.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        sessionId,
        legacyFileName: `${sessionId}.jsonl`,
        state: "published",
      })}\n`,
      "utf8",
    );

    await expect(
      openSession({
        sessionId,
        workspaceRoot: fixtureRoot,
        sessionDirectory,
        shell: TEST_SHELL,
      }),
    ).rejects.toThrow("多个无法确认权威来源");
    expect(await readFile(join(sessionDirectory, `${sessionId}.jsonl`))).toEqual(legacyBytes);
    await expect(
      readFile(join(storageDirectory, "migration-state.json"), "utf8"),
    ).resolves.toContain('"state":"published"');
  });
  it("recovers only an EOF JSON tail split inside a Chinese UTF-8 code point", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-utf8-tail-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    const session = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const sessionFilePath = join(session.storageDirectory, "session.jsonl");
    const completePrefix = await readFile(sessionFilePath);
    const incompleteTail = Buffer.concat([
      Buffer.from('{"type":"message","content":"中', "utf8"),
      Buffer.from([0xe6, 0x96]),
    ]);
    await appendFile(sessionFilePath, incompleteTail);
    await expect(readSessionJournal(sessionFilePath)).rejects.toThrow("尾部不完整");
    await session.close();

    const reopenedSession = await openSession({
      sessionId: session.sessionId,
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const recoveredBytes = await readFile(sessionFilePath);
    expect(recoveredBytes.subarray(0, completePrefix.byteLength)).toEqual(completePrefix);
    const recoveredJournal = await readSessionJournal(sessionFilePath);
    expect(recoveredJournal.records).toHaveLength(1);
    expect(recoveredJournal.records[0]).toMatchObject({ type: "session_use", activity: "opened" });
    await reopenedSession.close();
  });

  it("rebuilds a corrupted UTF-8 byte-offset index and supports fact appends inside one Run lease", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-resume-index-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    const session = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const runId = randomUUID();
    const acquisition = await session.acquireRun(runId);
    if (acquisition.status !== "acquired") {
      throw new Error(`expected Session Run lease, received ${acquisition.reason}`);
    }
    await acquisition.lease.appendMessage(USER_MESSAGE);
    await acquisition.lease.appendRequestUsage({
      purpose: "response",
      requestEntryId: session.records.at(-1)?.entryId ?? null,
      contextVersion: "context-v1",
      usage: {
        inputTokens: 12,
        outputTokens: 7,
        cachedInputTokens: null,
        cacheWriteInputTokens: 3,
        reasoningTokens: 2,
      },
    });
    await acquisition.lease.appendMessage(ASSISTANT_MESSAGE);
    const userEntryId = session.records.find(
      (record) => record.type === "message" && record.message.type === "user",
    )?.entryId;
    const assistantEntryId = session.records.find(
      (record) => record.type === "message" && record.message.type === "assistant",
    )?.entryId;
    if (userEntryId === undefined || assistantEntryId === undefined) {
      throw new Error("expected persisted user and assistant entries");
    }
    await acquisition.lease.appendCompaction({
      summary: "保留中文用户请求",
      coversThroughEntryId: userEntryId,
      firstKeptEntryId: assistantEntryId,
      retainedUserEntryIds: [userEntryId],
      usageBefore: { inputTokens: 12, outputTokens: 7, cachedInputTokens: null },
      inputTokenEstimateAfter: 8,
      modelId: "deterministic-test-model",
      contextVersion: "context-v2",
    });
    await acquisition.lease.appendRunFinished({ status: "completed" });
    await acquisition.lease.release();

    const journalBytes = await readFile(join(session.storageDirectory, "session.jsonl"));
    const resumeIndex = JSON.parse(
      await readFile(join(session.storageDirectory, "session.index.json"), "utf8"),
    ) as {
      latestCompaction: {
        entryId: string;
        byteOffset: number;
        firstKeptEntryId: string | null;
        firstKeptByteOffset: number | null;
      } | null;
      retainedUserEntries: Array<{ entryId: string; byteOffset: number }>;
    };
    const compactionRecord = session.records.find((record) => record.type === "compaction");
    const requestUsageRecord = session.records.find((record) => record.type === "request_usage");
    expect(compactionRecord).toMatchObject({ type: "compaction", runId });
    expect(requestUsageRecord).toMatchObject({
      type: "request_usage",
      runId,
      usage: { cacheWriteInputTokens: 3, reasoningTokens: 2 },
    });
    expect(resumeIndex.latestCompaction).toMatchObject({
      entryId: compactionRecord?.entryId,
      byteOffset: expect.any(Number),
      firstKeptEntryId: assistantEntryId,
      firstKeptByteOffset: expect.any(Number),
    });
    expect(
      journalBytes
        .subarray(resumeIndex.latestCompaction?.byteOffset)
        .toString("utf8")
        .startsWith(JSON.stringify(compactionRecord)),
    ).toBe(true);
    const firstKeptByteOffset = resumeIndex.latestCompaction?.firstKeptByteOffset;
    if (firstKeptByteOffset === null || firstKeptByteOffset === undefined) {
      throw new Error("expected a first-kept byte offset");
    }
    expect(
      journalBytes
        .subarray(firstKeptByteOffset)
        .toString("utf8")
        .includes('"content":[{"type":"text","text":"中文回答"}]'),
    ).toBe(true);
    expect(resumeIndex.retainedUserEntries).toHaveLength(1);
    expect(
      journalBytes
        .subarray(resumeIndex.retainedUserEntries[0]?.byteOffset)
        .toString("utf8")
        .includes('"content":[{"type":"text","text":"中文问题"}]'),
    ).toBe(true);

    await writeFile(join(session.storageDirectory, "session.index.json"), "{broken}\n", "utf8");
    await session.close();
    const reopenedSession = await openSession({
      sessionId: session.sessionId,
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const rebuiltIndex = JSON.parse(
      await readFile(join(reopenedSession.storageDirectory, "session.index.json"), "utf8"),
    ) as { journalFileSize: number };
    expect(rebuiltIndex.journalFileSize).toBe(
      await readFile(join(reopenedSession.storageDirectory, "session.jsonl")).then(
        (journal) => journal.byteLength,
      ),
    );
    await reopenedSession.close();
  });

  it("recovers a side-effect start only after its bound allowed approval", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-approval-run-id-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    const session = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const runId = randomUUID();
    const toolCallId = randomUUID();
    const toolApprovalRequestId = randomUUID();
    const actionFingerprint = "a".repeat(64);
    const acquisition = await session.acquireRun(runId);
    if (acquisition.status !== "acquired") {
      throw new Error(`expected Session Run lease, received ${acquisition.reason}`);
    }
    await acquisition.lease.appendMessage({ role: "user", content: "写入文件后回答" });
    const authorizationEntryId = session.records.at(-1)?.entryId;
    if (authorizationEntryId === undefined) {
      throw new Error("expected a persisted authorization source");
    }
    await acquisition.lease.appendMessage({
      role: "assistant",
      content: [
        {
          type: "tool_call",
          toolCallId,
          toolName: "write_file",
          input: { path: "a.txt", content: "内容" },
          invalid: false,
        },
      ],
      status: "completed",
    });
    await acquisition.lease.appendApprovalDecision({
      toolCallId,
      toolName: "write_file",
      permissionMode: "auto_allow",
      decisionSource: "auto_review",
      decision: "allowed",
      reason: "用户已明确授权写入。",
      authorizationEntryIds: [authorizationEntryId],
      actionFingerprint,
      toolApprovalRequestId,
    });
    await acquisition.lease.appendToolExecutionStarted({
      toolCallId,
      toolName: "write_file",
      toolApprovalRequestId,
    });
    await acquisition.lease.appendMessage({
      role: "tool",
      toolCallId,
      toolName: "write_file",
      status: "completed",
      content: "已写入",
      truncated: false,
    });
    await acquisition.lease.appendMessage(ASSISTANT_MESSAGE);
    await acquisition.lease.appendRunFinished({ status: "completed" });
    await acquisition.lease.release();

    expect(session.records.find((record) => record.type === "approval_decision")).toMatchObject({
      type: "approval_decision",
      runId,
      toolCallId,
      permissionMode: "auto_allow",
      actionFingerprint,
      toolApprovalRequestId,
    });
    await session.close();
    const reopenedSession = await openSession({
      sessionId: session.sessionId,
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    expect(reopenedSession.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_execution_started",
          toolCallId,
          toolApprovalRequestId,
        }),
      ]),
    );
    await reopenedSession.close();
  });

  it("rejects an approval that cites an Assistant message as its authorization", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-false-authorization-");
    const session = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory: join(fixtureRoot, "sessions"),
      shell: TEST_SHELL,
    });
    const acquisition = await session.acquireRun(randomUUID());
    if (acquisition.status !== "acquired") {
      throw new Error(`expected Session Run lease, received ${acquisition.reason}`);
    }
    const toolCallId = randomUUID();
    await acquisition.lease.appendMessage({ role: "user", content: "读取后回答" });
    await acquisition.lease.appendMessage({
      role: "assistant",
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
    const assistantEntryId = session.records.at(-1)?.entryId;
    if (assistantEntryId === undefined) {
      throw new Error("expected a persisted Assistant entry");
    }
    await expect(
      acquisition.lease.appendApprovalDecision({
        toolCallId,
        toolName: "read_file",
        permissionMode: "auto_allow",
        decisionSource: "auto_review",
        decision: "allowed",
        reason: "不可信来源。",
        authorizationEntryIds: [assistantEntryId],
        actionFingerprint: "b".repeat(64),
        toolApprovalRequestId: randomUUID(),
      }),
    ).rejects.toThrow("授权引用无效");
    await acquisition.lease.release();
    await session.close();
  });

  it("rejects a side-effect start whose approval request ID does not match its bound approval", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-approval-mismatch-");
    const session = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory: join(fixtureRoot, "sessions"),
      shell: TEST_SHELL,
    });
    const acquisition = await session.acquireRun(randomUUID());
    if (acquisition.status !== "acquired") {
      throw new Error(`expected Session Run lease, received ${acquisition.reason}`);
    }
    const toolCallId = randomUUID();
    const toolApprovalRequestId = randomUUID();
    await acquisition.lease.appendMessage({ role: "user", content: "写入文件" });
    const authorizationEntryId = session.records.at(-1)?.entryId;
    if (authorizationEntryId === undefined) {
      throw new Error("expected a persisted authorization source");
    }
    await acquisition.lease.appendMessage({
      role: "assistant",
      content: [
        {
          type: "tool_call",
          toolCallId,
          toolName: "write_file",
          input: { path: "a.txt", content: "内容" },
          invalid: false,
        },
      ],
      status: "completed",
    });
    await acquisition.lease.appendApprovalDecision({
      toolCallId,
      toolName: "write_file",
      permissionMode: "auto_allow",
      decisionSource: "auto_review",
      decision: "allowed",
      reason: "用户已授权。",
      authorizationEntryIds: [authorizationEntryId],
      actionFingerprint: "c".repeat(64),
      toolApprovalRequestId,
    });
    await expect(
      acquisition.lease.appendToolExecutionStarted({
        toolCallId,
        toolName: "write_file",
        toolApprovalRequestId: randomUUID(),
      }),
    ).rejects.toThrow("缺少匹配的允许审批");
    await acquisition.lease.release();
    await session.close();
  });
  it("falls back to the previous valid CompactionEntry while rejecting invalid new appends", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-compaction-fallback-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    const session = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const acquisition = await session.acquireRun(randomUUID());
    if (acquisition.status !== "acquired") {
      throw new Error(`expected Session Run lease, received ${acquisition.reason}`);
    }
    await acquisition.lease.appendMessage(USER_MESSAGE);
    await acquisition.lease.appendMessage(ASSISTANT_MESSAGE);
    await acquisition.lease.appendRunFinished({ status: "completed" });
    await acquisition.lease.release();

    const userEntryId = session.records.find(
      (record) => record.type === "message" && record.message.type === "user",
    )?.entryId;
    const assistantEntryId = session.records.find(
      (record) => record.type === "message" && record.message.type === "assistant",
    )?.entryId;
    if (userEntryId === undefined || assistantEntryId === undefined) {
      throw new Error("expected persisted message entries");
    }
    const compactionDetails = {
      summary: "有效压缩",
      coversThroughEntryId: userEntryId,
      firstKeptEntryId: assistantEntryId,
      retainedUserEntryIds: [userEntryId],
      usageBefore: { inputTokens: 9, outputTokens: 4, cachedInputTokens: null },
      inputTokenEstimateAfter: 6,
      modelId: "deterministic-test-model",
      contextVersion: "context-v1",
    };
    await expect(
      session.appendCompaction({ ...compactionDetails, coversThroughEntryId: randomUUID() }),
    ).rejects.toThrow("CompactionEntry 引用无效。");
    await session.appendCompaction(compactionDetails);
    const validCompaction = session.records.at(-1);
    if (validCompaction?.type !== "compaction") {
      throw new Error("expected a valid CompactionEntry");
    }

    const invalidCompaction = {
      ...validCompaction,
      entryId: randomUUID(),
      seq: validCompaction.seq + 1,
      timestamp: new Date().toISOString(),
      parentEntryId: validCompaction.entryId,
      coversThroughEntryId: randomUUID(),
    };
    const sessionFilePath = join(session.storageDirectory, "session.jsonl");
    await appendFile(sessionFilePath, `${JSON.stringify(invalidCompaction)}\n`, "utf8");
    await expect(readSessionJournal(sessionFilePath)).resolves.toMatchObject({
      records: expect.arrayContaining([
        expect.objectContaining({ entryId: invalidCompaction.entryId }),
      ]),
    });
    await session.close();

    const reopenedSession = await openSession({
      sessionId: session.sessionId,
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const resumeIndex = JSON.parse(
      await readFile(join(reopenedSession.storageDirectory, "session.index.json"), "utf8"),
    ) as { latestCompaction: { entryId: string } | null };
    expect(resumeIndex.latestCompaction).toMatchObject({ entryId: validCompaction.entryId });
    expect(
      reopenedSession.records.some((record) => record.entryId === invalidCompaction.entryId),
    ).toBe(true);
    await reopenedSession.close();
  });

  it("removes its own usage marker when marker persistence fails", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-marker-failure-");
    const sessionId = randomUUID();
    const lockSystem = Object.freeze({
      processId: process.pid,
      createOwnerToken: randomUUID,
      createTimestamp: () => new Date().toISOString(),
      inspectProcess: () => "alive" as const,
    });

    usageMarkerSyncFault.enabled = true;
    try {
      await expect(acquireSessionUsageMarker(fixtureRoot, sessionId, lockSystem)).rejects.toThrow(
        "forced usage marker sync failure",
      );
    } finally {
      usageMarkerSyncFault.enabled = false;
    }
    await expect(
      inspectSessionUsageMarkers(fixtureRoot, sessionId, lockSystem),
    ).resolves.toMatchObject({
      status: "unused",
      unknownOwnerTokens: [],
    });
  });

  it("reads member history after its workspace is missing without projecting AgentInput", async () => {
    const storageRoot = await createTemporaryDirectory("anthias-session-history-store-");
    const workspaceRoot = await createTemporaryDirectory("anthias-session-history-worktree-");
    const sessionDirectory = join(storageRoot, "sessions");
    const root = await createSession({
      workspaceRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const rootSessionId = root.sessionId;
    const member = await createSession({
      workspaceRoot,
      sessionDirectory,
      shell: TEST_SHELL,
      rootSessionId,
      sessionKind: "subagent",
    });
    const acquisition = await member.acquireRun(randomUUID());
    expect(acquisition.status).toBe("acquired");
    if (acquisition.status !== "acquired") throw new Error("expected member Run lease");
    await acquisition.lease.appendAgentInput({
      messageId: randomUUID(),
      rootSessionId,
      fromSessionId: rootSessionId,
      kind: "task",
      content: "source task",
    });
    await acquisition.lease.appendMessage(ASSISTANT_MESSAGE);
    await acquisition.lease.appendRunFinished({ status: "completed" });
    await acquisition.lease.release();
    await member.close();
    await root.close();
    await rm(workspaceRoot, { recursive: true });

    const history = await readSessionHistory({
      sessionDirectory,
      sessionId: member.sessionId,
      rootSessionId,
    });
    expect(history.header).toMatchObject({
      schemaVersion: 3,
      rootSessionId,
      sessionKind: "subagent",
    });
    expect(history.records.some((record) => record.type === "agent_input")).toBe(true);
    expect(history.messages).toEqual([ASSISTANT_MESSAGE]);
    await expect(
      readSessionHistory({
        sessionDirectory,
        sessionId: member.sessionId,
        rootSessionId: randomUUID(),
      }),
    ).rejects.toThrow("不属于请求的根 Session");
  });

  it("reads Schema 2 without migration and upgrades it only for coordination", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-schema2-upgrade-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    await mkdir(sessionDirectory);
    const sessionId = randomUUID();
    const createdAt = "2026-04-05T06:07:08.901Z";
    const header = {
      type: "session_header" as const,
      schemaVersion: 2 as const,
      sessionId,
      createdAt,
      workspaceRoot: fixtureRoot,
      shell: TEST_SHELL,
    };
    const relativeDirectory = getSessionStorageRelativeDirectory(header);
    const storageDirectory = join(sessionDirectory, relativeDirectory);
    await mkdir(storageDirectory, { recursive: true });
    await writeFile(join(storageDirectory, "session.jsonl"), `${JSON.stringify(header)}\n`);

    expect((await readSessionHistory({ sessionDirectory, sessionId })).header.schemaVersion).toBe(
      2,
    );
    expect(
      (await readSessionJournal(join(storageDirectory, "session.jsonl"))).header.schemaVersion,
    ).toBe(2);

    const session = await openSession({
      sessionId,
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    expect(
      (await readSessionJournal(join(storageDirectory, "session.jsonl"))).header.schemaVersion,
    ).toBe(2);
    await session.appendCoordination({
      kind: "team",
      key: randomUUID(),
      payload: { status: "closed" },
    });
    const upgraded = await readSessionJournal(join(storageDirectory, "session.jsonl"));
    expect(upgraded.header).toEqual({
      ...header,
      schemaVersion: 3,
      rootSessionId: sessionId,
      sessionKind: "primary",
    });
    expect(session.storageDirectory).toBe(storageDirectory);
    expect(upgraded.records.at(-1)).toMatchObject({ type: "coordination", kind: "team" });
    await session.close();
  });
  it("accepts another opener's use record, retains independent markers, and closes idempotently", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-use-marker-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    const firstSession = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    expect(
      (
        await inspectSessionUsageMarkers(sessionDirectory, firstSession.sessionId, {
          processId: process.pid,
          createOwnerToken: randomUUID,
          createTimestamp: () => new Date().toISOString(),
          inspectProcess: () => "alive",
        })
      ).status,
    ).toBe("in_use");

    const secondSession = await openSession({
      sessionId: firstSession.sessionId,
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const acquisition = await firstSession.acquireRun(randomUUID());
    expect(acquisition.status).toBe("acquired");
    if (acquisition.status !== "acquired") {
      throw new Error(`expected Session Run lease, received ${acquisition.reason}`);
    }
    await acquisition.lease.appendMessage(USER_MESSAGE);
    await acquisition.lease.appendMessage(ASSISTANT_MESSAGE);
    await acquisition.lease.appendRunFinished({ status: "completed" });
    await acquisition.lease.release();

    await Promise.all([firstSession.close(), firstSession.close()]);
    expect(
      (
        await inspectSessionUsageMarkers(sessionDirectory, firstSession.sessionId, {
          processId: process.pid,
          createOwnerToken: randomUUID,
          createTimestamp: () => new Date().toISOString(),
          inspectProcess: () => "alive",
        })
      ).status,
    ).toBe("in_use");
    await Promise.all([secondSession.close(), secondSession.close()]);
    expect(
      (
        await inspectSessionUsageMarkers(sessionDirectory, firstSession.sessionId, {
          processId: process.pid,
          createOwnerToken: randomUUID,
          createTimestamp: () => new Date().toISOString(),
          inspectProcess: () => "alive",
        })
      ).status,
    ).toBe("unused");
  });
});

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.add(temporaryDirectory);
  return temporaryDirectory;
}

async function writeLegacyCompletedRun({
  sessionDirectory,
  sessionId,
  runId,
  workspaceRoot,
  createdAt,
}: Readonly<{
  sessionDirectory: string;
  sessionId: string;
  runId: string;
  workspaceRoot: string;
  createdAt: string;
}>): Promise<Buffer> {
  const records = [
    {
      type: "message",
      entryId: randomUUID(),
      seq: 1,
      timestamp: createdAt,
      runId,
      message: { type: "user", content: [{ type: "text", text: "旧中文问题" }] },
    },
    {
      type: "message",
      entryId: randomUUID(),
      seq: 2,
      timestamp: "2026-02-03T04:05:07.000Z",
      runId,
      message: {
        type: "assistant",
        content: [{ type: "text", text: "旧中文回答" }],
        status: "completed",
      },
    },
    {
      type: "run_finished",
      entryId: randomUUID(),
      seq: 3,
      timestamp: "2026-02-03T04:05:08.000Z",
      runId,
      status: "completed",
    },
  ];
  const legacyText = `${JSON.stringify({
    type: "session_header",
    schemaVersion: 1,
    sessionId,
    createdAt,
    workspaceRoot,
    shell: TEST_SHELL,
  })}\n${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  const legacyBytes = Buffer.from(legacyText, "utf8");
  await writeFile(join(sessionDirectory, `${sessionId}.jsonl`), legacyBytes);
  return legacyBytes;
}

function legacyRecordsFromBytes(legacyBytes: Buffer): Array<Record<string, unknown>> {
  return legacyBytes
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .slice(1)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function legacyRecordIds(legacyBytes: Buffer): string[] {
  return legacyRecordsFromBytes(legacyBytes).map((record) => String(record.entryId));
}
