import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSession,
  openSession,
  readSessionHistory,
  type Session,
  type SessionShell,
} from "../src/session/index.js";

const fault = vi.hoisted(() => ({ point: "none", journalReads: 0, mainPath: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    async readFile(...parameters: Parameters<typeof original.readFile>) {
      if (String(parameters[0]).endsWith("session.jsonl")) fault.journalReads += 1;
      return original.readFile(...parameters);
    },
    async open(...parameters: Parameters<typeof original.open>) {
      const handle = await original.open(...parameters);
      const path = String(parameters[0]).replaceAll("\\", "/");
      if (
        fault.point === "opening_use_rewrite" &&
        path.includes("/usage/") &&
        path.endsWith(".json")
      ) {
        fault.point = "none";
        const content = await original.readFile(fault.mainPath, "utf8");
        await original.writeFile(
          fault.mainPath,
          content.replace("original request", "tampered request"),
        );
      }
      if (
        fault.point === "between_recovery_rewrite" &&
        String(parameters[0]) === fault.mainPath &&
        parameters[1] === "r+"
      ) {
        return new Proxy(handle, {
          get(target, property) {
            if (property === "close")
              return async () => {
                await target.close();
                fault.point = "none";
                const content = await original.readFile(fault.mainPath, "utf8");
                await original.writeFile(
                  fault.mainPath,
                  content.replace("original request", "tampered request"),
                );
              };
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      }
      if (!String(parameters[0]).endsWith("session.publish.tmp")) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === "sync" && fault.point === "candidate_rewrite")
            return async () => {
              await target.sync();
              const content = await original.readFile(parameters[0], "utf8");
              await original.writeFile(
                parameters[0],
                content.replace("original answer", "tampered answer"),
              );
            };
          if (property === "sync" && fault.point === "candidate_sync")
            return async () => {
              throw new Error("candidate sync failed");
            };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    async rename(...parameters: Parameters<typeof original.rename>) {
      if (String(parameters[0]).endsWith("session.publish.tmp")) {
        if (fault.point === "before_replace")
          throw new Error("replacement interrupted before publish");
        await original.rename(...parameters);
        if (fault.point === "after_replace")
          throw new Error("replacement interrupted after publish");
        return;
      }
      return original.rename(...parameters);
    },
  };
});

const roots = new Set<string>();
const sessions = new Set<Session>();
const shell: SessionShell = { kind: "powershell", executable: "pwsh", arguments: [] };
afterEach(async () => {
  fault.point = "none";
  fault.mainPath = "";
  await Promise.all([...sessions].map((session) => session.close()));
  sessions.clear();
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "anthias-session-publication-"));
  roots.add(root);
  const options = { workspaceRoot: root, sessionDirectory: join(root, "sessions"), shell };
  const session = await createSession(options);
  sessions.add(session);
  return { root, options, session, path: join(session.storageDirectory, "session.jsonl") };
}

async function completedHistory(session: Session) {
  const runId = randomUUID();
  const user = await session.appendMessage(runId, {
    role: "user",
    content: "keep the original request",
  });
  const assistant = await session.appendMessage(runId, {
    role: "assistant",
    content: [{ type: "text", text: "original answer" }],
    status: "completed",
  });
  await session.appendRunFinished(runId, { status: "completed" });
  const details = {
    summary: "first summary",
    coversThroughEntryId: user.entryId,
    firstKeptEntryId: assistant.entryId,
    retainedUserEntryIds: [user.entryId],
    usageBefore: { inputTokens: 20, outputTokens: 3, cachedInputTokens: null },
    inputTokenEstimateAfter: 8,
    modelId: "local",
    contextVersion: "v1",
  };
  return { user, assistant, details };
}

describe("Session publication and identity", () => {
  it.each(["candidate_sync", "before_replace", "after_replace", "candidate_rewrite"])(
    "recovers complete old or new navigation after %s failure",
    async (point) => {
      const { session, options, path } = await fixture();
      const { user, assistant, details } = await completedHistory(session);
      const first = await session.appendCompaction(null, details);
      const previousBytes = await readFile(path);
      fault.point = point;
      await expect(
        session.appendCompaction(null, { ...details, summary: "second summary" }),
      ).rejects.toThrow();
      await expect(
        session.appendMessage(randomUUID(), { role: "user", content: "must not continue" }),
      ).rejects.toThrow("已失效");
      expect(session.header.latestCompactionEntryId).toBe(first.entryId);
      fault.point = "none";
      if (point !== "after_replace") expect(await readFile(path)).toEqual(previousBytes);
      await session.close();
      const reopened = await openSession({ ...options, sessionId: session.sessionId });
      sessions.add(reopened);
      expect(reopened.getEntry(user.entryId)).toEqual(user);
      expect(reopened.getEntry(assistant.entryId)).toEqual(assistant);
      const compactions = reopened.records.filter((entry) => entry.type === "compaction");
      expect(compactions).toHaveLength(point === "after_replace" ? 2 : 1);
      expect(reopened.header.latestCompactionEntryId).toBe(compactions.at(-1)?.entryId);
      for (const [index, compaction] of compactions.entries()) {
        expect(compaction.previousCompactionEntryId).toBe(compactions[index - 1]?.entryId ?? null);
        expect(compaction.nextCompactionEntryId).toBe(compactions[index + 1]?.entryId ?? null);
      }
      await expect(
        readFile(join(reopened.storageDirectory, "session.publish.tmp")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("appends new entries without rereading journal bodies or generating a resume index", async () => {
    const { session } = await fixture();
    fault.journalReads = 0;
    const runId = randomUUID();
    for (let index = 0; index < 16; index += 1) {
      await session.appendMessage(runId, { role: "user", content: "same input" });
      await session.appendMessage(runId, {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        status: "completed",
      });
    }
    await session.appendRunFinished(runId, { status: "completed" });
    expect(fault.journalReads).toBe(0);
    expect(new Set(session.records.map((entry) => entry.entryId)).size).toBe(33);
    expect(session.header.latestCompactionEntryId).toBe(null);
    await expect(
      readFile(join(session.storageDirectory, "session.index.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["same_length_edit", "replacement"])(
    "invalidates its writer after an external %s",
    async (mode) => {
      const { session, path } = await fixture();
      await completedHistory(session);
      const original = await readFile(path, "utf8");
      if (mode === "same_length_edit")
        await writeFile(path, original.replace("original answer", "tampered answer"));
      else {
        const replacement = join(session.storageDirectory, "replacement.tmp");
        await writeFile(replacement, original);
        await rename(replacement, path);
      }
      const bytes = await readFile(path);
      await expect(
        session.appendMessage(randomUUID(), { role: "user", content: "rejected" }),
      ).rejects.toThrow("外部改写");
      expect(await readFile(path)).toEqual(bytes);
    },
  );

  it("rejects a same-length rewrite between verified opening and its opened-use append", async () => {
    const { session, options, path } = await fixture();
    await completedHistory(session);
    await session.close();
    const previousText = await readFile(path, "utf8");
    fault.mainPath = path;
    fault.point = "opening_use_rewrite";
    const opening = await openSession({ ...options, sessionId: session.sessionId }).then(
      (openedSession) => {
        sessions.add(openedSession);
        return { error: null };
      },
      (error: unknown) => ({ error }),
    );
    expect(opening.error).toMatchObject({ message: expect.stringContaining("外部改写") });
    expect(await readFile(path, "utf8")).toBe(
      previousText.replace("original request", "tampered request"),
    );
    const recovered = await openSession({ ...options, sessionId: session.sessionId });
    sessions.add(recovered);
    expect(
      (await readSessionHistory({ ...options, sessionId: session.sessionId })).messages[0],
    ).toMatchObject({ content: "keep the tampered request" });
  });

  it("carries the verified checkpoint between every recovery result and the interrupted terminal", async () => {
    const { session, options, path } = await fixture();
    const runId = randomUUID();
    const toolCallIds = [randomUUID(), randomUUID()];
    await session.appendMessage(runId, { role: "user", content: "keep the original request" });
    await session.appendMessage(runId, {
      role: "assistant",
      status: "completed",
      content: toolCallIds.map((toolCallId) => ({
        type: "tool_call",
        toolCallId,
        toolName: "read_file",
        input: {},
        invalid: false,
      })),
    });
    await session.close();
    fault.mainPath = path;
    fault.point = "between_recovery_rewrite";
    const opening = await openSession({ ...options, sessionId: session.sessionId }).then(
      (openedSession) => {
        sessions.add(openedSession);
        return { error: null };
      },
      (error: unknown) => ({ error }),
    );
    expect(opening.error).toMatchObject({ message: expect.stringContaining("外部改写") });
    const prefix = await readSessionHistory({ ...options, sessionId: session.sessionId });
    expect(
      prefix.records.filter((entry) => entry.type === "message" && entry.message.role === "tool"),
    ).toHaveLength(1);
    expect(
      prefix.records.some((entry) => entry.type === "run_finished" || entry.type === "session_use"),
    ).toBe(false);
    const recovered = await openSession({ ...options, sessionId: session.sessionId });
    sessions.add(recovered);
    const toolResults = recovered.records.filter(
      (entry) => entry.type === "message" && entry.message.role === "tool",
    );
    expect(
      toolResults.map((entry) =>
        entry.type === "message" && entry.message.role === "tool" ? entry.message.toolCallId : null,
      ),
    ).toEqual(toolCallIds);
    expect(recovered.records.filter((entry) => entry.type === "run_finished")).toMatchObject([
      { runId, status: "interrupted" },
    ]);
  });

  it("closes an accepted initial input as aborted before an Assistant exists", async () => {
    const { session, options } = await fixture();
    const runId = randomUUID();
    const initialInput = session.appendMessage(runId, {
      role: "user",
      content: "accepted before close",
    });
    const terminal = session.appendRunFinished(runId, { status: "aborted" });
    const closing = session.close();
    await initialInput;
    expect(await terminal).toMatchObject({ type: "run_finished", runId, status: "aborted" });
    await closing;
    const history = await readSessionHistory({ ...options, sessionId: session.sessionId });
    expect(history.messages).toEqual([{ role: "user", content: "accepted before close" }]);
    expect(history.records.at(-1)).toMatchObject({ type: "run_finished", status: "aborted" });
  });

  it("does not repair an incomplete active tail during read-only inspection", async () => {
    const { session, options, path } = await fixture();
    await completedHistory(session);
    await appendFile(path, '{"type":"message"');
    const bytes = await readFile(path);
    await expect(readSessionHistory({ ...options, sessionId: session.sessionId })).rejects.toThrow(
      "尾部不完整",
    );
    expect(await readFile(path)).toEqual(bytes);
  });
});
