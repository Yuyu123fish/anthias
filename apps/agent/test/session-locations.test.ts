import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionArtifactStore } from "../src/session/artifacts.js";
import { locateSessionGroup } from "../src/session/groups.js";
import { openSession } from "../src/session/index.js";
import {
  createSessionStorageDirectory,
  enumerateSessionStorage,
  getSessionStorageRelativeDirectory,
  locateSessionStorage,
} from "../src/session/locations.js";
import { listSessions, readSessionHistory } from "../src/session/query.js";
import type { SessionHeader } from "../src/session/schema.js";

const roots: string[] = [];
const shell = { kind: "posix" as const, executable: "/bin/sh", arguments: ["-lc"] };
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "anthias-locations-"));
  roots.push(root);
  return root;
}
function header(workspaceRoot: string, overrides: Partial<SessionHeader> = {}): SessionHeader {
  const sessionId = randomUUID();
  return {
    type: "session_header",
    schemaVersion: 3,
    sessionId,
    rootSessionId: sessionId,
    sessionKind: "primary",
    createdAt: "2026-09-08T23:59:59.000Z",
    workspaceRoot,
    shell,
    ...overrides,
  };
}
async function publish(root: string, sessionHeader: SessionHeader, flat = false) {
  const directory = flat
    ? join(root, getSessionStorageRelativeDirectory(sessionHeader))
    : (await createSessionStorageDirectory(root, sessionHeader)).storageDirectory;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "session.jsonl"), JSON.stringify(sessionHeader) + "\n");
  return directory;
}

describe("Session storage ownership", () => {
  it.each(["subagent", "teammate"] as const)(
    "keeps a next-day %s under its root with an independent journal and artifact store",
    async (sessionKind) => {
      const root = await fixture();
      const primary = header(root);
      const primaryDirectory = await publish(root, primary);
      const member = header(root, {
        rootSessionId: primary.sessionId,
        sessionKind,
        createdAt: "2026-09-09T00:00:01.000Z",
      });
      const memberDirectory = await publish(root, member);
      expect(memberDirectory).toBe(join(primaryDirectory, "members", member.sessionId));
      expect(
        (
          await readSessionHistory({
            sessionDirectory: root,
            sessionId: member.sessionId,
            rootSessionId: primary.sessionId,
          })
        ).header.createdAt,
      ).toBe(member.createdAt);
      const primaryStore = createSessionArtifactStore({
        sessionId: primary.sessionId,
        storageDirectory: primaryDirectory,
      });
      const memberStore = createSessionArtifactStore({
        sessionId: member.sessionId,
        storageDirectory: memberDirectory,
      });
      try {
        const artifact = await memberStore.save(randomUUID(), "member output");
        if (artifact === null) throw new Error("expected saved artifact");
        await expect(
          memberStore.readArtifact({ artifactId: artifact.artifactId }),
        ).resolves.toMatchObject({ status: "failed" });
        memberStore.registerReference(artifact);
        await expect(
          memberStore.readArtifact({ artifactId: artifact.artifactId }),
        ).resolves.toMatchObject({
          status: "completed",
          content: expect.stringContaining("member output"),
        });
        primaryStore.registerReference(artifact);
        await expect(
          primaryStore.readArtifact({ artifactId: artifact.artifactId }),
        ).resolves.toMatchObject({ status: "failed" });
        expect(
          await readFile(join(memberDirectory, "artifacts", artifact.artifactId + ".txt"), "utf8"),
        ).toBe("member output");
      } finally {
        await memberStore.close();
        await primaryStore.close();
      }
      expect(await listSessions(root, root)).toEqual([
        { id: primary.sessionId, createdAt: primary.createdAt },
      ]);
    },
  );

  it.each([1, 2] as const)(
    "keeps Schema %s bytes unchanged during reads and nests new members after explicit collaboration",
    async (schemaVersion) => {
      const root = await fixture();
      const primary = header(root);
      const legacyHeader = {
        type: primary.type,
        schemaVersion,
        sessionId: primary.sessionId,
        createdAt: primary.createdAt,
        workspaceRoot: root,
        shell,
      };
      const directory = join(root, getSessionStorageRelativeDirectory(primary));
      if (schemaVersion === 2) await mkdir(directory, { recursive: true });
      const path =
        schemaVersion === 1
          ? join(root, primary.sessionId + ".jsonl")
          : join(directory, "session.jsonl");
      const bytes = JSON.stringify(legacyHeader) + "\n";
      await writeFile(path, bytes);
      await readSessionHistory({ sessionDirectory: root, sessionId: primary.sessionId });
      expect(await readFile(path, "utf8")).toBe(bytes);
      const opened = await openSession({
        sessionDirectory: root,
        sessionId: primary.sessionId,
        workspaceRoot: root,
        shell,
      });
      const member = header(root, { rootSessionId: primary.sessionId, sessionKind: "subagent" });
      try {
        await opened.appendCoordination({
          kind: "member",
          key: member.sessionId,
          payload: { sessionId: member.sessionId, kind: "subagent", status: "preparing" },
        });
        const memberDirectory = await publish(root, member);
        expect(memberDirectory).toBe(join(opened.storageDirectory, "members", member.sessionId));
        expect(
          (await readSessionHistory({ sessionDirectory: root, sessionId: primary.sessionId }))
            .header.schemaVersion,
        ).toBe(3);
      } finally {
        await opened.close();
      }
    },
  );

  it("resumes a flat member in place and finds both layouts without a location cache", async () => {
    const root = await fixture();
    const primary = header(root);
    const primaryDirectory = await publish(root, primary);
    const oldMember = header(root, { rootSessionId: primary.sessionId, sessionKind: "subagent" });
    const oldDirectory = await publish(root, oldMember, true);
    const newMember = header(root, { rootSessionId: primary.sessionId, sessionKind: "teammate" });
    const newDirectory = await publish(root, newMember);
    await writeFile(join(root, "session-locations.json"), "{damaged cache");
    expect((await locateSessionStorage(root, newMember.sessionId)).storageDirectory).toBe(
      newDirectory,
    );
    const reopened = await openSession({
      sessionDirectory: root,
      sessionId: oldMember.sessionId,
      workspaceRoot: root,
      shell,
    });
    try {
      expect(reopened.storageDirectory).toBe(oldDirectory);
    } finally {
      await reopened.close();
    }
    const group = await locateSessionGroup(root, primary.sessionId);
    expect(group.complete).toBe(true);
    expect(new Set(group.sessions.map((session) => session.sessionId))).toEqual(
      new Set([primary.sessionId, oldMember.sessionId, newMember.sessionId]),
    );
    expect(newDirectory).toBe(join(primaryDirectory, "members", newMember.sessionId));
  });

  it("rejects duplicate flat and nested identities even when the cache points at one", async () => {
    const root = await fixture();
    const primary = header(root);
    await publish(root, primary);
    const member = header(root, { rootSessionId: primary.sessionId, sessionKind: "subagent" });
    await publish(root, member);
    await locateSessionStorage(root, member.sessionId);
    await publish(root, member, true);
    await expect(locateSessionStorage(root, member.sessionId)).rejects.toThrow("多个");
    expect((await locateSessionGroup(root, primary.sessionId)).complete).toBe(false);
  });

  it("keeps the root readable while a damaged member is diagnosed and protects the group", async () => {
    const root = await fixture();
    const primary = header(root);
    await publish(root, primary);
    const member = header(root, { rootSessionId: primary.sessionId, sessionKind: "subagent" });
    const memberDirectory = await publish(root, member);
    await writeFile(join(memberDirectory, "session.jsonl"), "broken\n");
    expect(
      (await readSessionHistory({ sessionDirectory: root, sessionId: primary.sessionId })).header
        .sessionId,
    ).toBe(primary.sessionId);
    await expect(
      readSessionHistory({ sessionDirectory: root, sessionId: member.sessionId }),
    ).rejects.toThrow("损坏");
    expect((await locateSessionGroup(root, primary.sessionId)).complete).toBe(false);
    expect((await enumerateSessionStorage(root)).diagnostics).toContainEqual(
      expect.objectContaining({ sessionId: member.sessionId }),
    );
  });

  it("rejects a member placed beneath a different root and a missing root at creation", async () => {
    const root = await fixture();
    const primary = header(root);
    const otherRoot = header(root);
    const firstDirectory = await publish(root, primary);
    const secondDirectory = await publish(root, otherRoot);
    const member = header(root, { rootSessionId: primary.sessionId, sessionKind: "subagent" });
    const memberDirectory = await publish(root, member);
    await mkdir(join(secondDirectory, "members"));
    await rename(memberDirectory, join(secondDirectory, "members", member.sessionId));
    await expect(locateSessionStorage(root, member.sessionId)).rejects.toThrow("归属");
    await expect(
      publish(root, header(root, { rootSessionId: randomUUID(), sessionKind: "subagent" })),
    ).rejects.toThrow();
    expect((await stat(firstDirectory)).isDirectory()).toBe(true);
  });

  it("reports a bounded scan instead of treating an incomplete inventory as an empty group", async () => {
    const root = await fixture();
    const primary = header(root);
    await publish(root, primary);
    await publish(
      root,
      header(root, { rootSessionId: primary.sessionId, sessionKind: "subagent" }),
    );
    const scan = await enumerateSessionStorage(root, { maximumCandidates: 1 });
    expect(scan.complete).toBe(false);
    expect(scan.diagnostics.length).toBeGreaterThan(0);
    expect((await locateSessionGroup(root, primary.sessionId, scan)).complete).toBe(false);
  });

  it("refuses a members junction and preserves its outside contents", async () => {
    const root = await fixture();
    const outside = await fixture();
    const primary = header(root);
    const directory = await publish(root, primary);
    await writeFile(join(outside, "keep.txt"), "keep");
    await symlink(
      outside,
      join(directory, "members"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      publish(root, header(root, { rootSessionId: primary.sessionId, sessionKind: "subagent" })),
    ).rejects.toThrow();
    expect((await enumerateSessionStorage(root)).complete).toBe(false);
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep");
  });
});
