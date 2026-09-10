import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompletedMessage as Message } from "../src/message.js";
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
    expect(migratedJournal.header.schemaVersion).toBe(4);
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

  it("publishes two linked compactions and ignores an obsolete corrupted resume index", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-compaction-chain-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    const session = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const runId = randomUUID();
    const user = await session.appendMessage(runId, USER_MESSAGE);
    const assistant = await session.appendMessage(runId, ASSISTANT_MESSAGE);
    const details = {
      summary: "中文摘要",
      coversThroughEntryId: user.entryId,
      firstKeptEntryId: assistant.entryId,
      retainedUserEntryIds: [user.entryId],
      usageBefore: { inputTokens: 12, outputTokens: 4, cachedInputTokens: null },
      inputTokenEstimateAfter: 7,
      modelId: "deterministic-test",
      contextVersion: "context-1",
    };
    const first = await session.appendCompaction(runId, details);
    const second = await session.appendCompaction(runId, { ...details, summary: "第二摘要" });
    expect(session.header.latestCompactionEntryId).toBe(second.entryId);
    expect(session.getEntry(first.entryId)).toMatchObject({
      previousCompactionEntryId: null,
      nextCompactionEntryId: second.entryId,
    });
    expect(second).toMatchObject({
      previousCompactionEntryId: first.entryId,
      nextCompactionEntryId: null,
    });
    await session.appendRunFinished(runId, { status: "completed" });
    expect(session.header.latestCompactionEntryId).toBe(second.entryId);
    const indexPath = join(session.storageDirectory, "session.index.json");
    await expect(readFile(indexPath)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(indexPath, "{broken}\n");
    await session.close();
    const reopened = await openSession({
      sessionId: session.sessionId,
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    expect(reopened.header.latestCompactionEntryId).toBe(second.entryId);
    expect(reopened.getEntry(first.entryId)).toMatchObject({
      nextCompactionEntryId: second.entryId,
    });
    expect(await readFile(indexPath, "utf8")).toBe("{broken}\n");
    expect(
      (await readSessionHistory({ sessionDirectory, sessionId: session.sessionId })).messages,
    ).toEqual([USER_MESSAGE, ASSISTANT_MESSAGE]);
    await reopened.close();
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
    const acquiredRunId = runId;
    await session.appendMessage(acquiredRunId, { role: "user", content: "写入文件后回答" });
    const authorizationEntryId = session.records.at(-1)?.entryId;
    if (authorizationEntryId === undefined) {
      throw new Error("expected a persisted authorization source");
    }
    await session.appendMessage(acquiredRunId, {
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
    await session.appendApprovalDecision(acquiredRunId, {
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
    await session.appendToolExecutionStarted(acquiredRunId, {
      toolCallId,
      toolName: "write_file",
      toolApprovalRequestId,
    });
    await session.appendMessage(acquiredRunId, {
      role: "tool",
      toolCallId,
      toolName: "write_file",
      status: "completed",
      content: "已写入",
      truncated: false,
    });
    await session.appendMessage(acquiredRunId, ASSISTANT_MESSAGE);
    await session.appendRunFinished(acquiredRunId, { status: "completed" });

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
    const acquiredRunId = randomUUID();
    const toolCallId = randomUUID();
    await session.appendMessage(acquiredRunId, { role: "user", content: "读取后回答" });
    await session.appendMessage(acquiredRunId, {
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
      session.appendApprovalDecision(acquiredRunId, {
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
    await session.close();
  });

  it("rejects a side-effect start whose approval request ID does not match its bound approval", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-approval-mismatch-");
    const session = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory: join(fixtureRoot, "sessions"),
      shell: TEST_SHELL,
    });
    const acquiredRunId = randomUUID();
    const toolCallId = randomUUID();
    const toolApprovalRequestId = randomUUID();
    await session.appendMessage(acquiredRunId, { role: "user", content: "写入文件" });
    const authorizationEntryId = session.records.at(-1)?.entryId;
    if (authorizationEntryId === undefined) {
      throw new Error("expected a persisted authorization source");
    }
    await session.appendMessage(acquiredRunId, {
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
    await session.appendApprovalDecision(acquiredRunId, {
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
      session.appendToolExecutionStarted(acquiredRunId, {
        toolCallId,
        toolName: "write_file",
        toolApprovalRequestId: randomUUID(),
      }),
    ).rejects.toThrow("缺少匹配的允许审批");
    await session.close();
  });
  it("repairs stale navigation only on execution open without changing committed messages", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-navigation-repair-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    const session = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const runId = randomUUID();
    const user = await session.appendMessage(runId, USER_MESSAGE);
    const assistant = await session.appendMessage(runId, ASSISTANT_MESSAGE);
    await session.appendRunFinished(runId, { status: "completed" });
    const details = {
      summary: "摘要",
      coversThroughEntryId: user.entryId,
      firstKeptEntryId: assistant.entryId,
      retainedUserEntryIds: [user.entryId],
      usageBefore: { inputTokens: 9, outputTokens: 4, cachedInputTokens: null },
      inputTokenEstimateAfter: 6,
      modelId: "local",
      contextVersion: "v1",
    };
    const first = await session.appendCompaction(null, details);
    const second = await session.appendCompaction(null, details);
    await session.close();
    const path = join(session.storageDirectory, "session.jsonl");
    const records = (await readFile(path, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    records[0].latestCompactionEntryId = first.entryId;
    records.find((entry) => entry.entryId === first.entryId).nextCompactionEntryId = null;
    await writeFile(path, records.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const corrupted = await readFile(path);
    await expect(
      readSessionHistory({ sessionDirectory, sessionId: session.sessionId }),
    ).rejects.toThrow("压缩导航不一致");
    expect(await readFile(path)).toEqual(corrupted);
    const reopened = await openSession({
      sessionId: session.sessionId,
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    expect(reopened.header.latestCompactionEntryId).toBe(second.entryId);
    expect(reopened.getEntry(first.entryId)).toMatchObject({
      nextCompactionEntryId: second.entryId,
    });
    expect(reopened.getEntry(user.entryId)).toEqual(user);
    expect(reopened.getEntry(assistant.entryId)).toEqual(assistant);
    await expect(
      reopened.appendCompaction(null, { ...details, coversThroughEntryId: randomUUID() }),
    ).rejects.toThrow("引用无效");
    await reopened.close();
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
    const acquiredRunId = randomUUID();
    await member.appendAgentInput(acquiredRunId, {
      messageId: randomUUID(),
      rootSessionId,
      fromSessionId: rootSessionId,
      kind: "task",
      content: "source task",
    });
    await member.appendMessage(acquiredRunId, ASSISTANT_MESSAGE);
    await member.appendRunFinished(acquiredRunId, { status: "completed" });
    await member.close();
    await root.close();
    await rm(workspaceRoot, { recursive: true });

    const history = await readSessionHistory({
      sessionDirectory,
      sessionId: member.sessionId,
      rootSessionId,
    });
    expect(history.header).toMatchObject({
      schemaVersion: 4,
      latestCompactionEntryId: null,
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

  it("reads Schema 2 without mutation and upgrades it on execution open", async () => {
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
    ).toBe(4);
    await session.appendCoordination(null, {
      kind: "team",
      key: randomUUID(),
      payload: { status: "closed" },
    });
    const upgraded = await readSessionJournal(join(storageDirectory, "session.jsonl"));
    expect(upgraded.header).toEqual({
      ...header,
      schemaVersion: 4,
      latestCompactionEntryId: null,
      rootSessionId: sessionId,
      sessionKind: "primary",
    });
    expect(session.storageDirectory).toBe(storageDirectory);
    expect(upgraded.records.at(-1)).toMatchObject({ type: "coordination", kind: "team" });
    await session.close();
  });
  it("reads and upgrades an old member input inside a pending Tool batch without reordering facts", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-old-input-order-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    const sessionId = randomUUID();
    const runId = randomUUID();
    const toolCallId = randomUUID();
    const header = {
      type: "session_header" as const,
      schemaVersion: 3 as const,
      sessionId,
      rootSessionId: sessionId,
      sessionKind: "primary" as const,
      createdAt: new Date().toISOString(),
      workspaceRoot: fixtureRoot,
      shell: TEST_SHELL,
    };
    const facts = [
      {
        type: "message",
        message: { type: "user", content: [{ type: "text", text: "read then answer" }] },
      },
      {
        type: "message",
        message: {
          type: "assistant",
          content: [
            {
              type: "tool_call",
              toolCallId,
              toolName: "read_file",
              input: { path: "file.txt" },
              invalid: false,
            },
          ],
          status: "completed",
        },
      },
      {
        type: "agent_input",
        messageId: randomUUID(),
        rootSessionId: sessionId,
        fromSessionId: randomUUID(),
        kind: "message",
        content: "legacy delivery",
      },
      {
        type: "message",
        message: {
          type: "tool_result",
          toolCallId,
          toolName: "read_file",
          status: "completed",
          content: "file",
          truncated: false,
        },
      },
      {
        type: "message",
        message: {
          type: "assistant",
          content: [{ type: "text", text: "done" }],
          status: "completed",
        },
      },
      { type: "run_finished", status: "completed" },
    ];
    let parentEntryId: string | null = null;
    const records = facts.map((fact, index) => {
      const record = {
        ...fact,
        runId,
        entryId: randomUUID(),
        parentEntryId,
        seq: index + 1,
        timestamp: header.createdAt,
      };
      parentEntryId = record.entryId;
      return record;
    });
    const storageDirectory = join(sessionDirectory, getSessionStorageRelativeDirectory(header));
    await mkdir(storageDirectory, { recursive: true });
    const path = join(storageDirectory, "session.jsonl");
    await writeFile(
      path,
      `${[header, ...records].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    const original = await readFile(path);
    const history = await readSessionHistory({ sessionDirectory, sessionId });
    expect(history.records.map((entry) => entry.entryId)).toEqual(
      records.map((entry) => entry.entryId),
    );
    expect(await readFile(path)).toEqual(original);
    const session = await openSession({
      sessionDirectory,
      sessionId,
      workspaceRoot: fixtureRoot,
      shell: TEST_SHELL,
    });
    expect(session.header.schemaVersion).toBe(4);
    expect(
      session.records.slice(0, records.length).map((entry) => [entry.entryId, entry.parentEntryId]),
    ).toEqual(records.map((entry) => [entry.entryId, entry.parentEntryId]));
    const newRunId = randomUUID();
    const newToolCallId = randomUUID();
    await session.appendMessage(newRunId, USER_MESSAGE);
    await session.appendMessage(newRunId, {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          toolCallId: newToolCallId,
          toolName: "read_file",
          input: {},
          invalid: false,
        },
      ],
      status: "completed",
    });
    await expect(
      session.appendAgentInput(newRunId, {
        messageId: randomUUID(),
        rootSessionId: sessionId,
        fromSessionId: randomUUID(),
        kind: "message",
        content: "must wait",
      }),
    ).rejects.toThrow("不能越过未决 ToolCall");
    await session.close();
  });

  it("retains its usage marker across idle periods and closes idempotently", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-use-marker-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    const session = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const system = {
      processId: process.pid,
      createOwnerToken: randomUUID,
      createTimestamp: () => new Date().toISOString(),
      inspectProcess: () => "alive" as const,
    };
    expect(
      (await inspectSessionUsageMarkers(sessionDirectory, session.sessionId, system)).status,
    ).toBe("in_use");
    await expect(
      openSession({
        sessionId: session.sessionId,
        workspaceRoot: fixtureRoot,
        sessionDirectory,
        shell: TEST_SHELL,
      }),
    ).rejects.toThrow("正在被其他进程使用");
    expect(
      (await inspectSessionUsageMarkers(sessionDirectory, session.sessionId, system)).status,
    ).toBe("in_use");
    await Promise.all([session.close(), session.close()]);
    expect(
      (await inspectSessionUsageMarkers(sessionDirectory, session.sessionId, system)).status,
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
