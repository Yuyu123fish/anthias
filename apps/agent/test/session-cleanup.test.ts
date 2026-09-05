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
