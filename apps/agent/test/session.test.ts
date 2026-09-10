import { randomUUID } from "node:crypto";
import {
  access,
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CompletedMessage as Message } from "../src/message.js";
import {
  createSession as createSessionRuntime,
  openSession as openSessionRuntime,
  readSessionHistory,
  resolveSessionShell,
  type Session,
  type SessionShell,
} from "../src/session/index.js";
import { getSessionLockDirectory, getSessionUsageDirectory } from "../src/session/lock.js";

const temporaryDirectories = new Set<string>();
const activeSessions = new Set<Session>();
const TEST_SHELL: SessionShell = Object.freeze({
  kind: "powershell",
  executable: "pwsh",
  arguments: Object.freeze(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]),
});

afterEach(async () => {
  await Promise.all([...activeSessions].map((session) => session.close()));
  activeSessions.clear();
  await Promise.all(
    [...temporaryDirectories].map((temporaryDirectory) =>
      rm(temporaryDirectory, { recursive: true, force: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe("Session", () => {
  it("resolves Windows pwsh to an available absolute executable", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-shell-");
    const shellExecutable = join(fixtureRoot, "pwsh.exe");
    await writeFile(shellExecutable, "test executable", "utf8");
    await chmod(shellExecutable, 0o755);

    await expect(resolveSessionShell({ Path: fixtureRoot }, "win32")).resolves.toEqual({
      kind: "powershell",
      executable: await realpath(shellExecutable),
      arguments: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
    });
    await expect(
      resolveSessionShell({ Path: join(fixtureRoot, "missing") }, "win32"),
    ).rejects.toThrow("没有可用的 pwsh");
  });

  it("creates one newline-terminated Schema 4 primary header in its UTC storage directory", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-create-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    await mkdtemp(join(fixtureRoot, "workspace-seed-"));
    const existingWorkspaceRoot = await realpath(fixtureRoot);

    const session = await createSession({
      workspaceRoot: existingWorkspaceRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });

    expect(session.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(session.workspaceRoot).toBe(existingWorkspaceRoot);
    expect(
      session.records.filter((entry) => entry.type === "message").map((entry) => entry.message),
    ).toEqual([]);

    const sessionText = await readFile(join(session.storageDirectory, "session.jsonl"), "utf8");
    expect(sessionText.endsWith("\n")).toBe(true);
    expect(sessionText.split("\n")).toHaveLength(2);

    const sessionHeader = JSON.parse(sessionText.trimEnd()) as Record<string, unknown>;
    expect(sessionHeader).toEqual({
      type: "session_header",
      schemaVersion: 4,
      latestCompactionEntryId: null,
      sessionId: session.sessionId,
      rootSessionId: session.sessionId,
      sessionKind: "primary",
      createdAt: expect.any(String),
      workspaceRoot: existingWorkspaceRoot,
      shell: TEST_SHELL,
    });
    expect(new Date(String(sessionHeader.createdAt)).toISOString()).toBe(sessionHeader.createdAt);
    const createdAt = String(sessionHeader.createdAt);
    expect(session.sessionDirectory).toBe(await realpath(sessionDirectory));
    expect(session.storageDirectory).toBe(
      join(
        session.sessionDirectory,
        createdAt.slice(0, 10),
        `${createdAt.replace(/[-:.]/g, "")}-${session.sessionId}`,
      ),
    );
    await expect(
      access(join(session.storageDirectory, "session.index.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates preallocated member ownership", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-member-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    const rootSession = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const rootSessionId = rootSession.sessionId;
    const memberSessionId = randomUUID();
    const member = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
      sessionId: memberSessionId,
      rootSessionId,
      sessionKind: "subagent",
    });

    expect(member).toMatchObject({
      sessionId: memberSessionId,
      rootSessionId,
      sessionKind: "subagent",
    });
    const header = parseRecord(
      (await readFile(join(member.storageDirectory, "session.jsonl"), "utf8")).trimEnd(),
    );
    expect(header).toMatchObject({
      schemaVersion: 4,
      latestCompactionEntryId: null,
      sessionId: memberSessionId,
      rootSessionId,
      sessionKind: "subagent",
    });
    await expect(
      createSessionRuntime({
        workspaceRoot: fixtureRoot,
        sessionDirectory,
        shell: TEST_SHELL,
        sessionId: randomUUID(),
        rootSessionId,
        sessionKind: "primary",
      }),
    ).rejects.toThrow("成员身份无效");
  });

  it("serializes completed entries and retains sourced input identity without another message history", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-input-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    const root = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const member = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
      rootSessionId: root.sessionId,
      sessionKind: "subagent",
    });
    const runId = randomUUID();
    const first = root.appendMessage(runId, { role: "user", content: "same" });
    const second = root.appendMessage(runId, { role: "user", content: "same" });
    const [firstEntry, secondEntry] = await Promise.all([first, second]);
    expect(firstEntry.entryId).not.toBe(secondEntry.entryId);
    expect(secondEntry.parentEntryId).toBe(firstEntry.entryId);
    expect(root.getEntry(secondEntry.entryId)).toBe(secondEntry);
    expect("messageHistory" in root).toBe(false);
    const details = {
      messageId: randomUUID(),
      rootSessionId: root.sessionId,
      fromSessionId: root.sessionId,
      kind: "task" as const,
      content: "inspect",
    };
    const memberRunId = randomUUID();
    const inputEntry = await member.appendAgentInput(memberRunId, details);
    expect(await member.appendAgentInput(memberRunId, details)).toBe(inputEntry);
    expect(member.records.filter((entry) => entry.type === "agent_input")).toHaveLength(1);
    await expect(
      member.appendAgentInput(memberRunId, { ...details, content: "changed" }),
    ).rejects.toThrow("已绑定其他内容");
  });

  it("holds the exclusive lock while idle and after a Run, while read-only history remains available", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-exclusive-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    const session = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const options = {
      sessionId: session.sessionId,
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    };
    await expect(openSession(options)).rejects.toThrow("正在被其他进程使用");
    const runId = randomUUID();
    await session.appendMessage(runId, { role: "user", content: "hello" });
    await session.appendMessage(runId, {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      status: "completed",
    });
    await session.appendRunFinished(runId, { status: "completed" });
    await expect(openSession(options)).rejects.toThrow("正在被其他进程使用");
    const bytes = await readFile(join(session.storageDirectory, "session.jsonl"));
    expect((await readSessionHistory(options)).messages).toHaveLength(2);
    expect(await readFile(join(session.storageDirectory, "session.jsonl"))).toEqual(bytes);
    await session.close();
    await (await openSession(options)).close();
  });

  it("drains accepted appends before close releases ownership and rejects new writes", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-close-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    const session = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const key = randomUUID();
    const accepted = session.appendCoordination(null, {
      kind: "team",
      key,
      payload: { status: "closed" },
    });
    const closing = session.close();
    await expect(
      session.appendCoordination(null, { kind: "team", key, payload: {} }),
    ).rejects.toThrow("Session 已关闭");
    const entry = await accepted;
    await closing;
    expect(session.records.at(-1)).toBe(entry);
    expect(
      (await readSessionHistory({ sessionDirectory, sessionId: session.sessionId })).records.at(-1),
    ).toEqual(entry);
    await expect(
      access(getSessionUsageDirectory(sessionDirectory, session.sessionId)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(getSessionLockDirectory(sessionDirectory, session.sessionId)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(session.close()).toBe(closing);
  });

  it("appends one completed text run and reopens its message projection", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-reopen-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    const existingWorkspaceRoot = await realpath(fixtureRoot);
    const session = await createSession({
      workspaceRoot: existingWorkspaceRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const runId = randomUUID();
    const userMessage: Message = Object.freeze({ role: "user", content: "hello" });
    const assistantMessage: Message = Object.freeze({
      role: "assistant",
      content: Object.freeze([{ type: "text" as const, text: "world" }]),
      status: "completed",
    });

    const runLeaseId = runId;
    await session.appendMessage(runLeaseId, userMessage);
    await session.appendMessage(runLeaseId, assistantMessage);
    await session.appendRunFinished(runLeaseId, { status: "completed" });
    await session.close();

    const sessionFilePath = join(session.storageDirectory, "session.jsonl");
    const completedSessionText = await readFile(sessionFilePath, "utf8");
    expect(completedSessionText.endsWith("\n")).toBe(true);
    const completedRecords = completedSessionText.trimEnd().split("\n").slice(1).map(parseRecord);
    expect(completedRecords.map((record) => record.seq)).toEqual([1, 2, 3]);
    expectValidRecordChain(completedRecords);
    expect(completedRecords[0]).toMatchObject({
      type: "message",
      runId,
      message: { role: "user", content: "hello" },
    });
    expect(completedRecords[1]).toMatchObject({
      type: "message",
      runId,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "world" }],
        status: "completed",
      },
    });
    expect(completedRecords[2]).toMatchObject({
      type: "run_finished",
      runId,
      status: "completed",
    });

    const reopenedSession = await openSession({
      sessionId: session.sessionId,
      workspaceRoot: existingWorkspaceRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    expect(
      reopenedSession.records
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.message),
    ).toEqual([userMessage, assistantMessage]);
    expect(reopenedSession.storageDirectory).toBe(session.storageDirectory);
    expectOnlySessionUseAppended(
      Buffer.from(completedSessionText, "utf8"),
      await readFile(sessionFilePath),
    );

    const continuedRunLeaseId = randomUUID();
    await reopenedSession.appendMessage(continuedRunLeaseId, {
      role: "user",
      content: "continue",
    });
    await reopenedSession.close();
    const continuedSessionText = await readFile(sessionFilePath, "utf8");
    const continuedRecords = continuedSessionText.trimEnd().split("\n").slice(1).map(parseRecord);
    expect(continuedRecords.at(-1)?.seq).toBe(5);
    expectValidRecordChain(continuedRecords);
  });

  it("rejects reopening when a later Run reuses a historical runId", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-reused-run-id-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    const session = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const reusedRunId = randomUUID();
    const runLeaseId = reusedRunId;
    await session.appendMessage(runLeaseId, { role: "user", content: "first" });
    await session.appendMessage(runLeaseId, {
      role: "assistant",
      content: [{ type: "text", text: "first answer" }],
      status: "completed",
    });
    await session.appendRunFinished(runLeaseId, { status: "completed" });
    await session.close();
    const reusedRunRecords = withParentEntryIds(
      [
        {
          ...createRecordIdentity(4, reusedRunId),
          type: "message",
          message: { role: "user", content: "second" },
        },
        {
          ...createRecordIdentity(5, reusedRunId),
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "second answer" }],
            status: "completed",
          },
        },
        { ...createRecordIdentity(6, reusedRunId), type: "run_finished", status: "completed" },
      ],
      session.records.at(-1)?.entryId ?? null,
    );
    await appendFile(
      join(session.storageDirectory, "session.jsonl"),
      `${reusedRunRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );

    await expect(
      openSession({
        sessionId: session.sessionId,
        workspaceRoot: fixtureRoot,
        sessionDirectory,
        shell: TEST_SHELL,
      }),
    ).rejects.toThrow("runId 重复");
  });

  it("rejects a completed Run whose last Assistant still contains ToolCall", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-incomplete-completed-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    const session = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const runId = randomUUID();
    const toolCallId = randomUUID();
    const runLeaseId = runId;
    await session.appendMessage(runLeaseId, { role: "user", content: "read then answer" });
    await session.close();
    const sessionFilePath = join(session.storageDirectory, "session.jsonl");
    const records = [
      {
        ...createRecordIdentity(2, runId),
        type: "message",
        message: {
          role: "assistant",
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
        ...createRecordIdentity(3, runId),
        type: "message",
        message: {
          role: "tool",
          toolCallId,
          toolName: "read_file",
          status: "completed",
          content: "contents",
          truncated: false,
        },
      },
      {
        ...createRecordIdentity(4, runId),
        type: "run_finished",
        status: "completed",
      },
    ];
    await appendFile(
      sessionFilePath,
      `${withParentEntryIds(records, session.records.at(-1)?.entryId ?? null)
        .map((record) => JSON.stringify(record))
        .join("\n")}\n`,
      "utf8",
    );

    await expect(
      openSession({
        sessionId: session.sessionId,
        workspaceRoot: fixtureRoot,
        sessionDirectory,
        shell: TEST_SHELL,
      }),
    ).rejects.toThrow("最终 AssistantMessage");
  });

  it("rejects an invalid session ID before file access", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-invalid-id-");

    await expect(
      openSession({
        sessionId: "../outside",
        workspaceRoot: fixtureRoot,
        sessionDirectory: join(fixtureRoot, "sessions"),
        shell: TEST_SHELL,
      }),
    ).rejects.toThrow("Session ID 无效");
  });

  it("rejects reopening a session from another workspace", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-workspace-");
    const otherWorkspaceRoot = await createTemporaryDirectory("anthias-session-other-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    const session = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });

    await session.close();
    await expect(
      openSession({
        sessionId: session.sessionId,
        workspaceRoot: otherWorkspaceRoot,
        sessionDirectory,
        shell: TEST_SHELL,
      }),
    ).rejects.toThrow("workspace root 不匹配");
  });

  it("rejects a complete file with a broken record sequence", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-sequence-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    const session = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const runLeaseId = randomUUID();
    await session.appendMessage(runLeaseId, { role: "user", content: "hello" });
    await session.close();
    const sessionFilePath = join(session.storageDirectory, "session.jsonl");
    const validSessionText = await readFile(sessionFilePath, "utf8");
    await writeFile(sessionFilePath, validSessionText.replace('"seq":1', '"seq":2'), "utf8");

    await expect(
      openSession({
        sessionId: session.sessionId,
        workspaceRoot: fixtureRoot,
        sessionDirectory,
        shell: TEST_SHELL,
      }),
    ).rejects.toThrow("Session record identity 无效");
  });

  it("rejects a complete whitespace-only tail record", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-whitespace-tail-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    const session = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const sessionFilePath = join(session.storageDirectory, "session.jsonl");
    const validSessionText = await readFile(sessionFilePath, "utf8");
    await writeFile(sessionFilePath, `${validSessionText} \n`, "utf8");

    await expect(
      openSession({
        sessionId: session.sessionId,
        workspaceRoot: fixtureRoot,
        sessionDirectory,
        shell: TEST_SHELL,
      }),
    ).rejects.toThrow();
  });

  it.each([
    {
      name: "an extra Header field",
      mutate(lines: Record<string, unknown>[]) {
        lines[0] = { ...lines[0], unexpected: true };
      },
    },
    {
      name: "a duplicate entry ID",
      mutate(lines: Record<string, unknown>[]) {
        lines[2] = { ...lines[2], entryId: lines[1]?.entryId };
      },
    },
    {
      name: "interleaved Runs",
      mutate(lines: Record<string, unknown>[]) {
        const messageRecord = lines[2];
        lines[2] = {
          ...messageRecord,
          runId: randomUUID(),
          message: { type: "user", content: [{ type: "text", text: "interleaved" }] },
        };
      },
    },
    {
      name: "a ToolResult referencing an unknown ToolCall",
      mutate(lines: Record<string, unknown>[]) {
        const runId = String(lines[1]?.runId);
        const actualToolCallId = randomUUID();
        lines[2] = {
          ...lines[2],
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_call",
                toolCallId: actualToolCallId,
                toolName: "read_file",
                input: { path: "file.txt" },
                invalid: false,
              },
            ],
            status: "completed",
          },
        };
        lines.splice(3, 0, {
          ...createRecordIdentity(3, runId),
          parentEntryId: lines[2]?.entryId,
          type: "message",
          message: {
            role: "tool",
            toolCallId: randomUUID(),
            toolName: "read_file",
            status: "completed",
            content: "result",
            truncated: false,
          },
        });
        lines[4] = { ...lines[4], seq: 4, parentEntryId: lines[3]?.entryId };
      },
    },
  ])("rejects a complete Session containing $name", async ({ mutate }) => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-semantic-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    const session = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const runId = randomUUID();
    const runLeaseId = runId;
    await session.appendMessage(runLeaseId, { role: "user", content: "question" });
    await session.appendMessage(runLeaseId, {
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      status: "completed",
    });
    await session.appendRunFinished(runLeaseId, { status: "completed" });
    await session.close();
    const sessionFilePath = join(session.storageDirectory, "session.jsonl");
    const sessionLines = (await readFile(sessionFilePath, "utf8"))
      .slice(0, -1)
      .split("\n")
      .map(parseRecord);
    mutate(sessionLines);
    await writeFile(
      sessionFilePath,
      `${sessionLines.map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );

    await expect(
      openSession({
        sessionId: session.sessionId,
        workspaceRoot: fixtureRoot,
        sessionDirectory,
        shell: TEST_SHELL,
      }),
    ).rejects.toThrow();
    await expect(
      access(getSessionLockDirectory(sessionDirectory, session.sessionId)),
    ).rejects.toThrow();
  });

  it("truncates only an incomplete final JSON fragment and preserves every prior byte", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-tail-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    const session = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const sessionFilePath = join(session.storageDirectory, "session.jsonl");
    const completePrefix = await readFile(sessionFilePath);
    await appendFile(sessionFilePath, Buffer.from('{"type":"message","entryId":"'));

    await session.close();
    await openSession({
      sessionId: session.sessionId,
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });

    expectOnlySessionUseAppended(completePrefix, await readFile(sessionFilePath));
  });

  it.each([
    { name: "invalid UTF-8", tail: Buffer.from([0xc3, 0x28]) },
    {
      name: "a complete JSON value without a final newline",
      tail: Buffer.from(JSON.stringify({ complete: true }), "utf8"),
    },
  ])("rejects $name at the file tail", async ({ tail }) => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-hard-tail-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    const session = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const sessionFilePath = join(session.storageDirectory, "session.jsonl");
    await appendFile(sessionFilePath, tail);

    await expect(
      openSession({
        sessionId: session.sessionId,
        workspaceRoot: fixtureRoot,
        sessionDirectory,
        shell: TEST_SHELL,
      }),
    ).rejects.toThrow();
  });

  it.each([
    { phase: "requesting_model", started: false, withToolCall: false, resultStatus: undefined },
    {
      phase: "awaiting_tool_approval",
      started: false,
      withToolCall: true,
      resultStatus: "aborted",
    },
    { phase: "executing_tool", started: true, withToolCall: true, resultStatus: "unknown" },
  ])(
    "recovers an interrupted Run from $phase without replaying work",
    async ({ started, withToolCall, resultStatus }) => {
      const fixtureRoot = await createTemporaryDirectory("anthias-session-recovery-");
      const sessionDirectory = join(fixtureRoot, "sessions");
      const session = await createSession({
        workspaceRoot: fixtureRoot,
        sessionDirectory,
        shell: TEST_SHELL,
      });
      const runId = randomUUID();
      const toolCallId = randomUUID();
      const runLeaseId = runId;
      await session.appendMessage(runLeaseId, { role: "user", content: "recover me" });
      await session.close();
      const sessionFilePath = join(session.storageDirectory, "session.jsonl");
      const existingRecords = (await readFile(sessionFilePath, "utf8")).slice(0, -1).split("\n");
      let nextSequence = 2;
      if (withToolCall) {
        existingRecords.push(
          JSON.stringify({
            ...createRecordIdentity(nextSequence, runId),
            type: "message",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_call",
                  toolCallId,
                  toolName: "write_file",
                  input: { path: "file.txt", content: "new" },
                  invalid: false,
                },
              ],
              status: "completed",
            },
          }),
        );
        nextSequence += 1;
      }
      if (started) {
        existingRecords.push(
          JSON.stringify({
            ...createRecordIdentity(nextSequence, runId),
            type: "tool_execution_started",
            toolCallId,
            toolName: "write_file",
            toolApprovalRequestId: randomUUID(),
          }),
        );
      }
      const [sessionHeader, ...interruptedRecords] = existingRecords.map(parseRecord);
      await writeFile(
        sessionFilePath,
        `${[sessionHeader, ...withParentEntryIds(interruptedRecords)]
          .map((record) => JSON.stringify(record))
          .join("\n")}\n`,
        "utf8",
      );

      const reopenedSession = await openSession({
        sessionId: session.sessionId,
        workspaceRoot: fixtureRoot,
        sessionDirectory,
        shell: TEST_SHELL,
      });
      const recoveredRecords = (await readFile(sessionFilePath, "utf8"))
        .slice(0, -1)
        .split("\n")
        .slice(1)
        .map(parseRecord);

      const recoveredToolResults = recoveredRecords.filter(
        (record) =>
          record.type === "message" &&
          (record.message as Record<string, unknown> | undefined)?.role === "tool",
      );
      expect(recoveredToolResults).toHaveLength(resultStatus === undefined ? 0 : 1);
      if (resultStatus !== undefined) {
        expect(recoveredToolResults[0]).toMatchObject({
          runId,
          message: { toolCallId, toolName: "write_file", status: resultStatus },
        });
      }
      expect(recoveredRecords.filter((record) => record.type === "run_finished")).toEqual([
        expect.objectContaining({ runId, status: "interrupted" }),
      ]);
      expect(recoveredRecords.at(-1)).toMatchObject({ type: "session_use", activity: "opened" });
      expectValidRecordChain(recoveredRecords);

      const bytesAfterFirstRecovery = await readFile(sessionFilePath);
      await reopenedSession.close();
      await openSession({
        sessionId: session.sessionId,
        workspaceRoot: fixtureRoot,
        sessionDirectory,
        shell: TEST_SHELL,
      });
      expectOnlySessionUseAppended(bytesAfterFirstRecovery, await readFile(sessionFilePath));
    },
  );

  it("rejects a live startup lock and reclaims only a definitely dead owner", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-startup-lock-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    const session = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    await session.close();
    const lockDirectory = getSessionLockDirectory(sessionDirectory, session.sessionId);
    await writeLockOwner(lockDirectory, process.pid, randomUUID());

    await expect(
      openSession({
        sessionId: session.sessionId,
        workspaceRoot: fixtureRoot,
        sessionDirectory,
        shell: TEST_SHELL,
        lockSystem: createLockSystem("alive"),
      }),
    ).rejects.toThrow("正在被其他进程使用");
    await expect(access(lockDirectory)).resolves.toBeUndefined();

    const reopenedSession = await openSession({
      sessionId: session.sessionId,
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
      lockSystem: createLockSystem("dead"),
    });
    expect(reopenedSession.sessionId).toBe(session.sessionId);
    await expect(access(lockDirectory)).resolves.toBeUndefined();
    await reopenedSession.close();
  });

  it("does not remove a Session lock whose owner token changed", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-token-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    const session = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const lockDirectory = getSessionLockDirectory(sessionDirectory, session.sessionId);
    await writeFile(
      join(lockDirectory, "owner.json"),
      `${JSON.stringify({
        pid: process.pid,
        ownerToken: randomUUID(),
        acquiredAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    await expect(session.close()).rejects.toThrow("owner token");
    activeSessions.delete(session);
    await expect(access(lockDirectory)).resolves.toBeUndefined();
  });

  it("rejects an externally changed file and releases ownership when closed", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-checkpoint-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    const session = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const sessionFilePath = join(session.storageDirectory, "session.jsonl");
    await appendFile(sessionFilePath, " ");

    await expect(
      session.appendMessage(randomUUID(), { role: "user", content: "no write" }),
    ).rejects.toThrow("外部改写");
    await session.close();
    await expect(
      access(getSessionLockDirectory(sessionDirectory, session.sessionId)),
    ).rejects.toThrow();
  });
});

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.add(temporaryDirectory);
  return temporaryDirectory;
}

async function createSession(
  options: Parameters<typeof createSessionRuntime>[0],
): Promise<Session> {
  const session = await createSessionRuntime(options);
  activeSessions.add(session);
  return session;
}

async function openSession(options: Parameters<typeof openSessionRuntime>[0]): Promise<Session> {
  const session = await openSessionRuntime(options);
  activeSessions.add(session);
  return session;
}

function expectOnlySessionUseAppended(previousBytes: Buffer, currentBytes: Buffer): void {
  expect(currentBytes.subarray(0, previousBytes.byteLength)).toEqual(previousBytes);
  const appendedText = currentBytes.subarray(previousBytes.byteLength).toString("utf8");
  expect(appendedText.endsWith("\n")).toBe(true);
  expect(appendedText.trimEnd().split("\n").map(parseRecord)).toEqual([
    expect.objectContaining({ type: "session_use", activity: "opened" }),
  ]);
  const currentRecords = currentBytes
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .slice(1)
    .map(parseRecord);
  expectValidRecordChain(currentRecords);
}

function expectValidRecordChain(records: readonly Record<string, unknown>[]): void {
  expect(records.every(hasValidEntryIdentity)).toBe(true);
  expect(records.map((record) => record.seq)).toEqual(
    records.map((_record, recordIndex) => recordIndex + 1),
  );
  for (const [recordIndex, record] of records.entries()) {
    expect(record.parentEntryId).toBe(records[recordIndex - 1]?.entryId ?? null);
  }
}

function withParentEntryIds(
  records: readonly Record<string, unknown>[],
  firstParentEntryId: string | null = null,
): Record<string, unknown>[] {
  return records.map((record, recordIndex) => ({
    ...record,
    parentEntryId: recordIndex === 0 ? firstParentEntryId : records[recordIndex - 1]?.entryId,
  }));
}

function parseRecord(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

function hasValidEntryIdentity(record: Record<string, unknown>): boolean {
  return (
    typeof record.entryId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.entryId) &&
    typeof record.timestamp === "string" &&
    new Date(record.timestamp).toISOString() === record.timestamp
  );
}

function createRecordIdentity(sequence: number, runId: string): Record<string, unknown> {
  return {
    entryId: randomUUID(),
    seq: sequence,
    timestamp: new Date().toISOString(),
    runId,
  };
}

function createLockSystem(processStatus: "alive" | "dead") {
  return {
    processId: process.pid,
    createOwnerToken: randomUUID,
    createTimestamp: () => new Date().toISOString(),
    inspectProcess: () => processStatus,
  } as const;
}

async function writeLockOwner(
  lockDirectory: string,
  processId: number,
  ownerToken: string,
): Promise<void> {
  await mkdir(lockDirectory);
  await writeFile(
    join(lockDirectory, "owner.json"),
    `${JSON.stringify({
      pid: processId,
      ownerToken,
      acquiredAt: new Date().toISOString(),
    })}\n`,
    "utf8",
  );
}
