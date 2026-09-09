import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupExpiredSessions } from "../src/session/cleanup.js";
import { openSession } from "../src/session/index.js";
import { readSessionJournal } from "../src/session/journal.js";
import {
  acquireSessionLock,
  acquireSessionUsageMarker,
  DEFAULT_SESSION_LOCK_SYSTEM,
  getSessionLockDirectory,
  releaseSessionLock,
  releaseSessionUsageMarker,
} from "../src/session/lock.js";

const roots = new Set<string>();
const NOW = Date.parse("2026-08-15T00:00:00.000Z");
afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("Session cleanup", () => {
  it("cleans an expired Schema 1 journal without migrating it or refreshing use time", async () => {
    const root = await fixtureRoot();
    const session = await fixtureSession(root);
    const header = JSON.parse(
      await readFile(join(session.directory, "session.jsonl"), "utf8"),
    ) as Record<string, unknown>;
    header.schemaVersion = 1;
    const legacyPath = join(root, session.id + ".jsonl");
    await writeFile(legacyPath, JSON.stringify(header) + "\n");
    await rm(session.directory, { recursive: true });
    expect(await cleanupExpiredSessions({ sessionDirectory: root, now: NOW })).toMatchObject({
      deleted: 1,
      inspected: 1,
    });
    await expect(stat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses durable activity at the fourteen day boundary and removes owned artifacts together", async () => {
    const root = await fixtureRoot();
    const expired = await fixtureSession(root, "2026-08-01T00:00:00.000Z");
    const recent = await fixtureSession(root, "2026-08-01T00:00:00.001Z");
    const future = await fixtureSession(root, "2026-08-16T00:00:00.000Z");
    const recentlyOpened = await fixtureSession(root);
    await appendFile(
      join(recentlyOpened.directory, "session.jsonl"),
      JSON.stringify({
        type: "session_use",
        entryId: randomUUID(),
        parentEntryId: null,
        seq: 1,
        timestamp: "2026-08-14T00:00:00.000Z",
        activity: "opened",
      }) + "\n",
    );
    await mkdir(join(expired.directory, "artifacts"));
    await writeFile(join(expired.directory, "artifacts", "output.txt"), "old output");
    const result = await cleanupExpiredSessions({ sessionDirectory: root, now: NOW });
    expect(result).toMatchObject({ deleted: 1, inspected: 4, status: "completed" });
    await expect(stat(expired.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(recent.directory)).isDirectory()).toBe(true);
    expect((await stat(future.directory)).isDirectory()).toBe(true);
  });

  it("protects every opener and unknown process while preserving a busy writer", async () => {
    const root = await fixtureRoot();
    const opened = await fixtureSession(root);
    const unknown = await fixtureSession(root);
    const busy = await fixtureSession(root);
    const firstMarker = await acquireSessionUsageMarker(
      root,
      opened.id,
      DEFAULT_SESSION_LOCK_SYSTEM,
    );
    const secondMarker = await acquireSessionUsageMarker(
      root,
      opened.id,
      DEFAULT_SESSION_LOCK_SYSTEM,
    );
    await releaseSessionUsageMarker(firstMarker);
    const unknownSystem = { ...DEFAULT_SESSION_LOCK_SYSTEM, processId: 987654 };
    await acquireSessionUsageMarker(root, unknown.id, unknownSystem);
    const busyLock = await acquireSessionLock(
      getSessionLockDirectory(root, busy.id),
      DEFAULT_SESSION_LOCK_SYSTEM,
    );
    const cleanupSystem = {
      ...DEFAULT_SESSION_LOCK_SYSTEM,
      inspectProcess: (pid: number) =>
        pid === 987654 ? ("unknown" as const) : DEFAULT_SESSION_LOCK_SYSTEM.inspectProcess(pid),
    };
    try {
      expect(
        await cleanupExpiredSessions({
          sessionDirectory: root,
          now: NOW,
          lockSystem: cleanupSystem,
        }),
      ).toMatchObject({ deleted: 0 });
      expect((await stat(opened.directory)).isDirectory()).toBe(true);
      expect((await stat(unknown.directory)).isDirectory()).toBe(true);
      expect((await stat(busy.directory)).isDirectory()).toBe(true);
    } finally {
      await releaseSessionUsageMarker(secondMarker);
      await releaseSessionLock(busyLock);
    }
  });

  it("continues from a bounded scan cursor and completes an interrupted deletion", async () => {
    const root = await fixtureRoot();
    await fixtureSession(root);
    await fixtureSession(root);
    expect(
      await cleanupExpiredSessions({ sessionDirectory: root, now: NOW, maximumCandidates: 1 }),
    ).toMatchObject({ deleted: 1, status: "bounded" });
    expect(
      await cleanupExpiredSessions({ sessionDirectory: root, now: NOW, maximumCandidates: 1 }),
    ).toMatchObject({ deleted: 1, status: "completed" });
    const interrupted = await fixtureSession(root);
    const trash = `.maintenance/trash/${interrupted.id}-${randomUUID()}`;
    await mkdir(join(root, ".maintenance", "trash"), { recursive: true });
    await writeFile(
      join(root, ".maintenance", "cleanup-state.json"),
      JSON.stringify({
        cursor: null,
        pending: { source: interrupted.relativeDirectory, trash, sessionId: interrupted.id },
      }),
    );
    await rename(interrupted.directory, join(root, trash));
    await rm(join(root, trash, "session.jsonl"));
    expect(await cleanupExpiredSessions({ sessionDirectory: root, now: NOW })).toMatchObject({
      deleted: 1,
    });
    await expect(stat(join(root, trash))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not follow junctions or delete unknown directory contents", async () => {
    const root = await fixtureRoot();
    const outside = await fixtureRoot();
    await writeFile(join(outside, "keep.txt"), "keep");
    const linked = await fixtureSession(root);
    await symlink(
      outside,
      join(linked.directory, "artifacts"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const invalid = await fixtureSession(root);
    await writeFile(join(invalid.directory, "session.jsonl"), "invalid\n");
    expect(await cleanupExpiredSessions({ sessionDirectory: root, now: NOW })).toMatchObject({
      deleted: 0,
    });
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep");
    expect((await stat(invalid.directory)).isDirectory()).toBe(true);
  });

  it("preserves conflicting directories for the same Session identity", async () => {
    const root = await fixtureRoot();
    const first = await fixtureSession(root);
    const second = await fixtureSession(root, "2026-07-02T00:00:00.000Z", first.id);
    const result = await cleanupExpiredSessions({ sessionDirectory: root, now: NOW });
    expect(result).toMatchObject({ deleted: 0, skipped: 2 });
    expect((await stat(first.directory)).isDirectory()).toBe(true);
    expect((await stat(second.directory)).isDirectory()).toBe(true);
  });
  it("deletes an expired root and member as one group after every resource is terminal", async () => {
    const root = await fixtureRoot();
    const rootSessionId = randomUUID();
    const memberSessionId = randomUUID();
    const worktreeId = randomUUID();
    const rootSession = await fixtureSchema3Session(root, {
      id: rootSessionId,
      rootSessionId,
      sessionKind: "primary",
      coordination: [
        {
          kind: "member",
          key: memberSessionId,
          payload: {
            sessionId: memberSessionId,
            kind: "subagent",
            status: "closed",
            workspaceRoot: root,
            writable: true,
            worktreeId,
          },
        },
        { kind: "team", key: randomUUID(), payload: { status: "closed" } },
        { kind: "task", key: randomUUID(), payload: { status: "completed", result: "" } },
        { kind: "delivery", key: randomUUID(), payload: { status: "delivered" } },
        {
          kind: "worktree",
          key: worktreeId,
          payload: { id: worktreeId, rootSessionId, status: "removed" },
        },
        {
          kind: "git_operation",
          key: randomUUID(),
          payload: { operationType: "integration", phase: "committed" },
        },
      ],
    });
    const memberSession = await fixtureSchema3Session(root, {
      id: memberSessionId,
      rootSessionId,
      sessionKind: "subagent",
    });

    expect(await cleanupExpiredSessions({ sessionDirectory: root, now: NOW })).toMatchObject({
      deleted: 2,
      status: "completed",
    });
    await expect(stat(rootSession.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(memberSession.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["member", "task", "worktree", "git_operation"] as const)(
    "protects the entire group when latest %s state is unfinished or uncertain",
    async (unsafeKind) => {
      const root = await fixtureRoot();
      const rootSessionId = randomUUID();
      const memberSessionId = randomUUID();
      const worktreeId = randomUUID();
      const coordination: Array<{
        kind: "member" | "task" | "worktree" | "git_operation";
        key: string;
        payload: Record<string, unknown>;
      }> = [
        {
          kind: "member",
          key: memberSessionId,
          payload: {
            sessionId: memberSessionId,
            kind: "subagent",
            status: unsafeKind === "member" ? "running" : "closed",
            workspaceRoot: root,
            writable: false,
          },
        },
      ];
      if (unsafeKind === "task") {
        coordination.push({ kind: "task", key: randomUUID(), payload: { status: "pending" } });
      }
      if (unsafeKind === "worktree") {
        coordination.push({
          kind: "worktree",
          key: worktreeId,
          payload: { id: worktreeId, rootSessionId, status: "ready" },
        });
      }
      if (unsafeKind === "git_operation") {
        coordination.push({
          kind: "git_operation",
          key: randomUUID(),
          payload: { operationType: "commit", phase: "intent" },
        });
      }
      const rootSession = await fixtureSchema3Session(root, {
        id: rootSessionId,
        rootSessionId,
        sessionKind: "primary",
        coordination,
      });
      const memberSession = await fixtureSchema3Session(root, {
        id: memberSessionId,
        rootSessionId,
        sessionKind: "subagent",
      });

      expect(await cleanupExpiredSessions({ sessionDirectory: root, now: NOW })).toMatchObject({
        deleted: 0,
      });
      expect((await stat(rootSession.directory)).isDirectory()).toBe(true);
      expect((await stat(memberSession.directory)).isDirectory()).toBe(true);
    },
  );
  it("restores a half-moved five-Session group before preserving a reopened source", async () => {
    const root = await fixtureRoot();
    const rootSessionId = randomUUID();
    const memberSessionIds = Array.from({ length: 4 }, () => randomUUID());
    const rootSession = await fixtureSchema3Session(root, {
      id: rootSessionId,
      rootSessionId,
      sessionKind: "primary",
      coordination: memberSessionIds.map((memberSessionId) => ({
        kind: "member",
        key: memberSessionId,
        payload: {
          sessionId: memberSessionId,
          kind: "subagent",
          status: "closed",
          workspaceRoot: root,
          writable: false,
        },
      })),
    });
    const memberSessions = await Promise.all(
      memberSessionIds.map((memberSessionId) =>
        fixtureSchema3Session(root, {
          id: memberSessionId,
          rootSessionId,
          sessionKind: "subagent",
        }),
      ),
    );
    const trash = `.maintenance/trash/${rootSessionId}-${randomUUID()}`;
    await mkdir(join(root, trash), { recursive: true });
    await writeFile(
      join(root, ".maintenance", "cleanup-state.json"),
      JSON.stringify({
        cursor: null,
        pending: {
          kind: "group",
          rootSessionId,
          cursorAfter: rootSession.relativeDirectory,
          trash,
          sessions: [
            { source: rootSession.relativeDirectory, sessionId: rootSessionId },
            ...memberSessions.map((memberSession) => ({
              source: memberSession.relativeDirectory,
              sessionId: memberSession.id,
            })),
          ],
        },
      }),
    );
    const movedMember = memberSessions[0];
    if (movedMember === undefined) throw new Error("missing member fixture");
    await rename(movedMember.directory, join(root, trash, movedMember.id));

    const reopenedRoot = await openSession({
      sessionId: rootSessionId,
      workspaceRoot: root,
      sessionDirectory: root,
      shell: { kind: "posix", executable: "/bin/sh", arguments: ["-lc"] },
    });
    try {
      expect(await cleanupExpiredSessions({ sessionDirectory: root, now: NOW })).toMatchObject({
        deleted: 0,
        status: "completed",
      });
      expect((await stat(rootSession.directory)).isDirectory()).toBe(true);
      for (const memberSession of memberSessions) {
        expect((await stat(memberSession.directory)).isDirectory()).toBe(true);
      }
      expect(
        (await readSessionJournal(join(rootSession.directory, "session.jsonl"))).records.at(-1),
      ).toMatchObject({ type: "session_use", activity: "opened" });
    } finally {
      await reopenedRoot.close();
    }
  });
  it("deletes mixed flat and nested histories together while leaving project output alone", async () => {
    const root = await fixtureRoot();
    const group = await fixtureMixedGroup(root);
    const workspace = await fixtureRoot();
    await writeFile(join(workspace, "result.txt"), "project output");
    for (const session of group.sessions) {
      await mkdir(join(session.directory, "artifacts"));
      await writeFile(join(session.directory, "artifacts", "result.txt"), session.id);
    }
    expect(await cleanupExpiredSessions({ sessionDirectory: root, now: NOW })).toMatchObject({
      deleted: 3,
      status: "completed",
    });
    for (const session of group.sessions)
      await expect(stat(session.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(workspace, "result.txt"), "utf8")).toBe("project output");
  });

  it.each(["root", "flat"] as const)(
    "restores a mixed group after the %s physical source moved and another source was reopened",
    async (movedSource) => {
      const root = await fixtureRoot();
      const group = await fixtureMixedGroup(root);
      const moved = movedSource === "root" ? group.primary : group.flat;
      const active = movedSource === "root" ? group.flat : group.nested;
      const trash = await fixturePendingGroup(root, group);
      await rename(moved.directory, join(root, trash, moved.id));
      const usageMarker = await acquireSessionUsageMarker(
        root,
        active.id,
        DEFAULT_SESSION_LOCK_SYSTEM,
      );
      try {
        expect(await cleanupExpiredSessions({ sessionDirectory: root, now: NOW })).toMatchObject({
          deleted: 0,
          status: "completed",
        });
        for (const session of group.sessions)
          expect((await stat(session.directory)).isDirectory()).toBe(true);
        await expect(stat(join(root, trash))).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await releaseSessionUsageMarker(usageMarker);
      }
    },
  );

  it.each([false, true])(
    "finishes a fully moved mixed group after partial deletion %s",
    async (partiallyDeleted) => {
      const root = await fixtureRoot();
      const group = await fixtureMixedGroup(root);
      const trash = await fixturePendingGroup(root, group);
      await rename(group.primary.directory, join(root, trash, group.primary.id));
      await rename(group.flat.directory, join(root, trash, group.flat.id));
      if (partiallyDeleted) await rm(join(root, trash, group.flat.id), { recursive: true });
      expect(await cleanupExpiredSessions({ sessionDirectory: root, now: NOW })).toMatchObject({
        deleted: 3,
        status: "completed",
      });
      await expect(stat(join(root, trash))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["missing", "damaged", "foreign"] as const)(
    "preserves a mixed group with a %s nested member",
    async (failure) => {
      const root = await fixtureRoot();
      const group = await fixtureMixedGroup(root);
      const journalPath = join(group.nested.directory, "session.jsonl");
      if (failure === "missing") {
        await rm(group.nested.directory, { recursive: true });
      } else if (failure === "damaged") {
        await writeFile(journalPath, "broken\n");
      } else {
        const header = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;
        header.rootSessionId = randomUUID();
        await writeFile(journalPath, JSON.stringify(header) + "\n");
      }
      const result = await cleanupExpiredSessions({ sessionDirectory: root, now: NOW });
      expect(result.deleted).toBe(0);
      expect(result.skipReasons.length).toBeGreaterThan(0);
      expect((await stat(group.primary.directory)).isDirectory()).toBe(true);
      expect((await stat(group.flat.directory)).isDirectory()).toBe(true);
    },
  );

  it.each(["root", "member"] as const)(
    "preserves unowned files inside the %s Session directory",
    async (owner) => {
      const root = await fixtureRoot();
      const group = await fixtureMixedGroup(root);
      const directory = owner === "root" ? group.primary.directory : group.nested.directory;
      await mkdir(join(directory, "unexpected"));
      const path = join(directory, "unexpected", "keep.txt");
      await writeFile(path, "user data");
      expect((await cleanupExpiredSessions({ sessionDirectory: root, now: NOW })).deleted).toBe(0);
      expect(await readFile(path, "utf8")).toBe("user data");
      for (const session of group.sessions)
        expect((await stat(session.directory)).isDirectory()).toBe(true);
    },
  );

  it("preserves unexpected contents after all physical sources have moved", async () => {
    const root = await fixtureRoot();
    const group = await fixtureMixedGroup(root);
    const trash = await fixturePendingGroup(root, group);
    await rename(group.primary.directory, join(root, trash, group.primary.id));
    await rename(group.flat.directory, join(root, trash, group.flat.id));
    const path = join(root, trash, group.primary.id, "keep.txt");
    await writeFile(path, "user data");
    expect(await cleanupExpiredSessions({ sessionDirectory: root, now: NOW })).toMatchObject({
      deleted: 0,
      status: "bounded",
    });
    expect(await readFile(path, "utf8")).toBe("user data");
  });

  it("cleans an unrelated healthy root while preserving a known damaged member group", async () => {
    const root = await fixtureRoot();
    const damaged = await fixtureMixedGroup(root);
    const healthyId = randomUUID();
    const healthy = await fixtureSchema3Session(root, {
      id: healthyId,
      rootSessionId: healthyId,
      sessionKind: "primary",
    });
    await writeFile(join(damaged.nested.directory, "session.jsonl"), "broken\n");
    expect(await cleanupExpiredSessions({ sessionDirectory: root, now: NOW })).toMatchObject({
      deleted: 1,
    });
    await expect(stat(healthy.directory)).rejects.toMatchObject({ code: "ENOENT" });
    for (const session of damaged.sessions)
      expect((await stat(session.directory)).isDirectory()).toBe(true);
  });

  it("does not scan when another cleanup owns the global lock or cancellation has arrived", async () => {
    const root = await fixtureRoot();
    const session = await fixtureSession(root);
    const globalLock = await acquireSessionLock(
      join(root, ".maintenance", "cleanup.lock"),
      DEFAULT_SESSION_LOCK_SYSTEM,
    );
    try {
      expect(await cleanupExpiredSessions({ sessionDirectory: root, now: NOW })).toMatchObject({
        inspected: 0,
        status: "busy",
      });
    } finally {
      await releaseSessionLock(globalLock);
    }
    expect(
      await cleanupExpiredSessions({
        sessionDirectory: root,
        now: NOW,
        signal: AbortSignal.abort(),
      }),
    ).toMatchObject({ inspected: 0, status: "bounded" });
    expect((await stat(session.directory)).isDirectory()).toBe(true);
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "anthias-cleanup-"));
  roots.add(root);
  return root;
}

async function fixtureMixedGroup(root: string) {
  const primaryId = randomUUID();
  const flatId = randomUUID();
  const nestedId = randomUUID();
  const primary = await fixtureSchema3Session(root, {
    id: primaryId,
    rootSessionId: primaryId,
    sessionKind: "primary",
    coordination: [flatId, nestedId].map((id) => ({
      kind: "member" as const,
      key: id,
      payload: {
        sessionId: id,
        kind: "subagent",
        status: "closed",
        workspaceRoot: root,
        writable: false,
      },
    })),
  });
  const flat = await fixtureSchema3Session(root, {
    id: flatId,
    rootSessionId: primaryId,
    sessionKind: "subagent",
  });
  const nestedFlat = await fixtureSchema3Session(root, {
    id: nestedId,
    rootSessionId: primaryId,
    sessionKind: "subagent",
  });
  const nested = {
    ...nestedFlat,
    directory: join(primary.directory, "members", nestedId),
    relativeDirectory: primary.relativeDirectory + "/members/" + nestedId,
  };
  await mkdir(join(primary.directory, "members"));
  await rename(nestedFlat.directory, nested.directory);
  return { primary, flat, nested, sessions: [primary, flat, nested] };
}
async function fixturePendingGroup(
  root: string,
  group: Awaited<ReturnType<typeof fixtureMixedGroup>>,
) {
  const trash = `.maintenance/trash/${group.primary.id}-${randomUUID()}`;
  await mkdir(join(root, trash), { recursive: true });
  await writeFile(
    join(root, ".maintenance", "cleanup-state.json"),
    JSON.stringify({
      cursor: null,
      pending: {
        kind: "group",
        rootSessionId: group.primary.id,
        cursorAfter: group.primary.relativeDirectory,
        trash,
        sessions: group.sessions.map((session) => ({
          source: session.relativeDirectory,
          sessionId: session.id,
        })),
      },
    }),
  );
  return trash;
}

async function fixtureSchema3Session(
  root: string,
  options: Readonly<{
    id: string;
    rootSessionId: string;
    sessionKind: "primary" | "subagent" | "teammate";
    coordination?: readonly Readonly<{
      kind: "member" | "team" | "task" | "delivery" | "worktree" | "git_operation";
      key: string;
      payload: Record<string, unknown>;
    }>[];
  }>,
) {
  const createdAt = "2026-07-01T00:00:00.000Z";
  const relativeDirectory = `${createdAt.slice(0, 10)}/${createdAt.replace(/[-:.]/gu, "")}-${options.id}`;
  const directory = join(root, relativeDirectory);
  await mkdir(directory, { recursive: true });
  let parentEntryId: string | null = null;
  const records = (options.coordination ?? []).map((coordination, index) => {
    const record = {
      type: "coordination",
      entryId: randomUUID(),
      seq: index + 1,
      timestamp: createdAt,
      parentEntryId,
      ...coordination,
    };
    parentEntryId = record.entryId;
    return record;
  });
  await writeFile(
    join(directory, "session.jsonl"),
    `${[
      {
        type: "session_header",
        schemaVersion: 3,
        sessionId: options.id,
        rootSessionId: options.rootSessionId,
        sessionKind: options.sessionKind,
        createdAt,
        workspaceRoot: root,
        shell: { kind: "posix", executable: "/bin/sh", arguments: ["-lc"] },
      },
      ...records,
    ]
      .map((record) => JSON.stringify(record))
      .join("\n")}\n`,
  );
  return { id: options.id, directory, relativeDirectory };
}
async function fixtureSession(
  root: string,
  createdAt = "2026-07-01T00:00:00.000Z",
  id = randomUUID(),
) {
  const relativeDirectory = `${createdAt.slice(0, 10)}/${createdAt.replace(/[-:.]/gu, "")}-${id}`;
  const directory = join(root, relativeDirectory);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "session.jsonl"),
    `${JSON.stringify({
      type: "session_header",
      schemaVersion: 2,
      sessionId: id,
      createdAt,
      workspaceRoot: root,
      shell: { kind: "posix", executable: "/bin/sh", arguments: ["-lc"] },
    })}\n`,
  );
  return { id, directory, relativeDirectory };
}
