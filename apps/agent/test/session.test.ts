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
import type { Message } from "../src/agent.js";
import {
  createSession,
  openSession,
  resolveSessionShell,
  type Session,
  type SessionRunLease,
  type SessionShell,
} from "../src/session.js";

const temporaryDirectories = new Set<string>();
const TEST_SHELL: SessionShell = Object.freeze({
  kind: "powershell",
  executable: "pwsh",
  arguments: Object.freeze(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]),
});

afterEach(async () => {
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

  it("creates one newline-terminated Schema 1 header", async () => {
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
    expect(session.messageHistory).toEqual([]);

    const sessionText = await readFile(
      join(sessionDirectory, `${session.sessionId}.jsonl`),
      "utf8",
    );
    expect(sessionText.endsWith("\n")).toBe(true);
    expect(sessionText.split("\n")).toHaveLength(2);

    const sessionHeader = JSON.parse(sessionText.trimEnd()) as Record<string, unknown>;
    expect(sessionHeader).toEqual({
      type: "session_header",
      schemaVersion: 1,
      sessionId: session.sessionId,
      createdAt: expect.any(String),
      workspaceRoot: existingWorkspaceRoot,
      shell: TEST_SHELL,
    });
    expect(new Date(String(sessionHeader.createdAt)).toISOString()).toBe(sessionHeader.createdAt);
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
      content: "world",
      status: "completed",
    });

    const runLease = await acquireSessionRun(session, runId);
    await runLease.appendMessage(userMessage);
    await runLease.appendMessage(assistantMessage);
    await runLease.appendRunFinished({
      status: "completed",
      modelRequestCount: 1,
      toolCallCount: 0,
      activeDurationMilliseconds: 25,
    });
    await runLease.release();

    const sessionFilePath = join(sessionDirectory, `${session.sessionId}.jsonl`);
    const completedSessionText = await readFile(sessionFilePath, "utf8");
    expect(completedSessionText.endsWith("\n")).toBe(true);
    const completedRecords = completedSessionText.trimEnd().split("\n").slice(1).map(parseRecord);
    expect(completedRecords.map((record) => record.seq)).toEqual([1, 2, 3]);
    expect(completedRecords.every(hasValidEntryIdentity)).toBe(true);
    expect(completedRecords[0]).toMatchObject({
      type: "message",
      runId,
      message: { type: "user", content: [{ type: "text", text: "hello" }] },
    });
    expect(completedRecords[1]).toMatchObject({
      type: "message",
      runId,
      message: {
        type: "assistant",
        content: [{ type: "text", text: "world" }],
        status: "completed",
      },
    });
    expect(completedRecords[2]).toMatchObject({
      type: "run_finished",
      runId,
      status: "completed",
      metricsStatus: "complete",
      modelRequestCount: 1,
      toolCallCount: 0,
      activeDurationMilliseconds: 25,
    });

    const reopenedSession = await openSession({
      sessionId: session.sessionId,
      workspaceRoot: existingWorkspaceRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    expect(reopenedSession.messageHistory).toEqual([userMessage, assistantMessage]);

    const continuedRunLease = await acquireSessionRun(reopenedSession, randomUUID());
    await continuedRunLease.appendMessage({
      role: "user",
      content: "continue",
    });
    await continuedRunLease.release();
    const continuedSessionText = await readFile(sessionFilePath, "utf8");
    const continuedRecords = continuedSessionText.trimEnd().split("\n").slice(1).map(parseRecord);
    expect(continuedRecords.at(-1)?.seq).toBe(4);
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
    for (const [question, answer] of [
      ["first", "first answer"],
      ["second", "second answer"],
    ] as const) {
      const runLease = await acquireSessionRun(session, reusedRunId);
      await runLease.appendMessage({ role: "user", content: question });
      await runLease.appendMessage({ role: "assistant", content: answer, status: "completed" });
      await runLease.appendRunFinished({
        status: "completed",
        modelRequestCount: 1,
        toolCallCount: 0,
        activeDurationMilliseconds: 1,
      });
      await runLease.release();
    }

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
    const runLease = await acquireSessionRun(session, runId);
    await runLease.appendMessage({ role: "user", content: "read then answer" });
    await runLease.release();
    const sessionFilePath = join(sessionDirectory, `${session.sessionId}.jsonl`);
    const records = [
      {
        ...createRecordIdentity(2, runId),
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
        ...createRecordIdentity(3, runId),
        type: "message",
        message: {
          type: "tool_result",
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
        metricsStatus: "complete",
        modelRequestCount: 1,
        toolCallCount: 1,
        activeDurationMilliseconds: 1,
      },
    ];
    await appendFile(
      sessionFilePath,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
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
    const runLease = await acquireSessionRun(session, randomUUID());
    await runLease.appendMessage({ role: "user", content: "hello" });
    await runLease.release();
    const sessionFilePath = join(sessionDirectory, `${session.sessionId}.jsonl`);
    const validSessionText = await readFile(sessionFilePath, "utf8");
    await writeFile(sessionFilePath, validSessionText.replace('"seq":1', '"seq":2'), "utf8");

    await expect(
      openSession({
        sessionId: session.sessionId,
        workspaceRoot: fixtureRoot,
        sessionDirectory,
        shell: TEST_SHELL,
      }),
    ).rejects.toThrow("seq 不连续");
  });

  it("rejects a complete whitespace-only tail record", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-whitespace-tail-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    const session = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const sessionFilePath = join(sessionDirectory, `${session.sessionId}.jsonl`);
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
      name: "a fractional normal metric",
      mutate(lines: Record<string, unknown>[]) {
        lines[3] = { ...lines[3], activeDurationMilliseconds: 0.5 };
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
            type: "assistant",
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
          type: "message",
          message: {
            type: "tool_result",
            toolCallId: randomUUID(),
            toolName: "read_file",
            status: "completed",
            content: "result",
            truncated: false,
          },
        });
        lines[4] = { ...lines[4], seq: 4, toolCallCount: 1 };
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
    const runLease = await acquireSessionRun(session, runId);
    await runLease.appendMessage({ role: "user", content: "question" });
    await runLease.appendMessage({
      role: "assistant",
      content: "answer",
      status: "completed",
    });
    await runLease.appendRunFinished({
      status: "completed",
      modelRequestCount: 1,
      toolCallCount: 0,
      activeDurationMilliseconds: 1,
    });
    await runLease.release();
    const sessionFilePath = join(sessionDirectory, `${session.sessionId}.jsonl`);
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
    await expect(access(join(sessionDirectory, `${session.sessionId}.lock`))).rejects.toThrow();
  });

  it("truncates only an incomplete final JSON fragment and preserves every prior byte", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-tail-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    const session = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const sessionFilePath = join(sessionDirectory, `${session.sessionId}.jsonl`);
    const completePrefix = await readFile(sessionFilePath);
    await appendFile(sessionFilePath, Buffer.from('{"type":"message","entryId":"'));

    await openSession({
      sessionId: session.sessionId,
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });

    expect(await readFile(sessionFilePath)).toEqual(completePrefix);
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
    const sessionFilePath = join(sessionDirectory, `${session.sessionId}.jsonl`);
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
      const runLease = await acquireSessionRun(session, runId);
      await runLease.appendMessage({ role: "user", content: "recover me" });
      await runLease.release();
      const sessionFilePath = join(sessionDirectory, `${session.sessionId}.jsonl`);
      const existingRecords = (await readFile(sessionFilePath, "utf8")).slice(0, -1).split("\n");
      let nextSequence = 2;
      if (withToolCall) {
        existingRecords.push(
          JSON.stringify({
            ...createRecordIdentity(nextSequence, runId),
            type: "message",
            message: {
              type: "assistant",
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
      await writeFile(sessionFilePath, `${existingRecords.join("\n")}\n`, "utf8");

      await openSession({
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
          (record.message as Record<string, unknown> | undefined)?.type === "tool_result",
      );
      expect(recoveredToolResults).toHaveLength(resultStatus === undefined ? 0 : 1);
      if (resultStatus !== undefined) {
        expect(recoveredToolResults[0]).toMatchObject({
          runId,
          message: { toolCallId, toolName: "write_file", status: resultStatus },
        });
      }
      expect(recoveredRecords.at(-1)).toMatchObject({
        type: "run_finished",
        runId,
        status: "interrupted",
        metricsStatus: "incomplete",
        modelRequestCount: null,
        toolCallCount: withToolCall ? 1 : 0,
        activeDurationMilliseconds: null,
      });

      const bytesAfterFirstRecovery = await readFile(sessionFilePath);
      await openSession({
        sessionId: session.sessionId,
        workspaceRoot: fixtureRoot,
        sessionDirectory,
        shell: TEST_SHELL,
      });
      expect(await readFile(sessionFilePath)).toEqual(bytesAfterFirstRecovery);
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
    const lockDirectory = join(sessionDirectory, `${session.sessionId}.lock`);
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
    await expect(access(lockDirectory)).rejects.toThrow();
  });

  it("does not remove a Run lock whose owner token changed", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-token-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    const session = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const acquisition = await session.acquireRun(randomUUID());
    expect(acquisition.status).toBe("acquired");
    if (acquisition.status !== "acquired") {
      throw new Error("expected Session Run lease");
    }
    const lockDirectory = join(sessionDirectory, `${session.sessionId}.lock`);
    await writeFile(
      join(lockDirectory, "owner.json"),
      `${JSON.stringify({
        pid: process.pid,
        ownerToken: randomUUID(),
        acquiredAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    await expect(acquisition.lease.release()).rejects.toThrow("owner token");
    await expect(access(lockDirectory)).resolves.toBeUndefined();
  });

  it("rejects an externally changed checkpoint and releases the acquired lock", async () => {
    const fixtureRoot = await createTemporaryDirectory("anthias-session-checkpoint-");
    const sessionDirectory = join(fixtureRoot, "sessions");
    const session = await createSession({
      workspaceRoot: fixtureRoot,
      sessionDirectory,
      shell: TEST_SHELL,
    });
    const sessionFilePath = join(sessionDirectory, `${session.sessionId}.jsonl`);
    await appendFile(sessionFilePath, " ");

    await expect(session.acquireRun(randomUUID())).resolves.toEqual({
      status: "rejected",
      reason: "session_changed",
    });
    await expect(access(join(sessionDirectory, `${session.sessionId}.lock`))).rejects.toThrow();
  });
});

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.add(temporaryDirectory);
  return temporaryDirectory;
}

async function acquireSessionRun(session: Session, runId: string): Promise<SessionRunLease> {
  const acquisition = await session.acquireRun(runId);
  if (acquisition.status !== "acquired") {
    throw new Error(`expected acquired Session Run, received ${acquisition.reason}`);
  }
  return acquisition.lease;
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
