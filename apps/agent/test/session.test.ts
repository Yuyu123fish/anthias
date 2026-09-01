import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "../src/agent.js";
import { createSession, openSession, type SessionShell } from "../src/session.js";

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

    await session.appendMessage(runId, userMessage);
    await session.appendMessage(runId, assistantMessage);
    await session.appendRunFinished(runId, {
      status: "completed",
      modelRequestCount: 1,
      toolCallCount: 0,
      activeDurationMilliseconds: 25,
    });

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

    await reopenedSession.appendMessage(randomUUID(), {
      role: "user",
      content: "continue",
    });
    const continuedSessionText = await readFile(sessionFilePath, "utf8");
    const continuedRecords = continuedSessionText.trimEnd().split("\n").slice(1).map(parseRecord);
    expect(continuedRecords.at(-1)?.seq).toBe(4);
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
    await session.appendMessage(randomUUID(), { role: "user", content: "hello" });
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
});

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.add(temporaryDirectory);
  return temporaryDirectory;
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
