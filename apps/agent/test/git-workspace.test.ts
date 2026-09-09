import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonValue } from "../src/message.js";
import {
  createGitWorkspace,
  type GitWorkspace,
  type GitWorkspaceOptions,
} from "../src/tool/basetool/git/index.js";

const execFileAsync = promisify(execFile);
const fixtureRoots = new Set<string>();

afterEach(async () => {
  for (const root of fixtureRoots) {
    const pathFromTemp = relative(tmpdir(), root);
    if (
      pathFromTemp === "" ||
      isAbsolute(pathFromTemp) ||
      pathFromTemp === ".." ||
      pathFromTemp.startsWith(`..${sep}`)
    ) {
      throw new Error("测试清理目标不在系统临时目录内。");
    }
    await rm(root, { recursive: true, force: true });
  }
  fixtureRoots.clear();
});

describe("Git workspace", { timeout: 60_000 }, () => {
  it("creates isolated worktrees from a fixed commit without copying root changes", async () => {
    const fixture = await createRepositoryFixture();
    await writeFile(join(fixture.repositoryRoot, "a.txt"), "root dirty\n");

    const first = await fixture.workspace.createWorktree({ memberSessionId: "member-one" });
    const second = await fixture.workspace.createWorktree({ memberSessionId: "member-two" });

    expect(first.baseCommit).toBe(fixture.baseCommit);
    expect(first.path).not.toBe(second.path);
    expect(first.branch).toMatch(/^anthias\/root-session\//u);
    expect(first.notice).toContain("不会带入");
    expect(normalizeLines(await readFile(join(first.path, "a.txt"), "utf8"))).toBe("base\n");
    expect(normalizeLines(await readFile(join(second.path, "a.txt"), "utf8"))).toBe("base\n");
    expect(normalizeLines(await readFile(join(fixture.repositoryRoot, "a.txt"), "utf8"))).toBe(
      "root dirty\n",
    );
    expect(fixture.workspace.listWorktrees()).toHaveLength(2);

    const restored = createGitWorkspace(fixture.workspaceOptions);
    expect(restored.listWorktrees().map((worktree) => worktree.id)).toEqual(
      fixture.workspace.listWorktrees().map((worktree) => worktree.id),
    );
    expect((await restored.query({ action: "worktrees" })).replaceAll("\\", "/")).toContain(
      first.path.replaceAll("\\", "/"),
    );
  });

  it("commits only explicit paths and records integration only after its commit", async () => {
    const fixture = await createRepositoryFixture();
    const worktree = await fixture.workspace.createWorktree({ memberSessionId: "writer" });
    await writeFile(join(worktree.path, "a.txt"), "member result\n");
    await writeFile(join(worktree.path, "b.txt"), "left working\n");

    const result = await fixture.workspace.commit({
      worktreeId: worktree.id,
      paths: ["a.txt"],
      message: "member result",
    });
    expect(
      (await git(worktree.path, "show", "--format=", "--name-only", result.commit)).trim(),
    ).toBe("a.txt");
    expect(await git(worktree.path, "status", "--short")).toContain("b.txt");
    await git(worktree.path, "restore", "b.txt");

    const staged = await fixture.workspace.integrate({
      worktreeId: worktree.id,
      commit: result.commit,
    });
    expect(staged.status).toBe("staged");
    expect(fixture.workspace.listWorktrees()[0]?.integrated).toBe(false);
    expect(await git(fixture.repositoryRoot, "diff", "--cached", "--name-only")).toContain("a.txt");

    const committed = await fixture.workspace.resolveIntegration({ action: "continue" });
    expect(committed.status).toBe("committed");
    expect(fixture.workspace.listWorktrees()[0]).toMatchObject({
      integrated: true,
      integrationCommit: committed.integrationCommit,
    });
    expect(normalizeLines(await readFile(join(fixture.repositoryRoot, "a.txt"), "utf8"))).toBe(
      "member result\n",
    );

    const removed = await fixture.workspace.removeWorktree(worktree.id);
    expect(removed.status).toBe("removed");
    expect(
      await git(fixture.repositoryRoot, "show-ref", "--verify", `refs/heads/${worktree.branch}`),
    ).toContain(result.commit);
  });

  it("rejects existing staged data, traversal and paths through a junction", async () => {
    const fixture = await createRepositoryFixture();
    const worktree = await fixture.workspace.createWorktree({});
    await writeFile(join(worktree.path, "a.txt"), "selected\n");
    await writeFile(join(worktree.path, "b.txt"), "already staged\n");
    await git(worktree.path, "add", "b.txt");
    await expect(
      fixture.workspace.commit({ worktreeId: worktree.id, paths: ["a.txt"], message: "unsafe" }),
    ).rejects.toThrow("已经含有暂存内容");
    await git(worktree.path, "restore", "--staged", "b.txt");
    await expect(
      fixture.workspace.commit({
        worktreeId: worktree.id,
        paths: ["../outside"],
        message: "unsafe",
      }),
    ).rejects.toThrow("越界");
    await expect(
      fixture.workspace.commit({
        worktreeId: worktree.id,
        paths: [":(glob)**"],
        message: "pathspec injection",
      }),
    ).rejects.toThrow();
    expect(await git(worktree.path, "diff", "--cached", "--name-only")).toBe("");

    const outside = join(fixture.fixtureRoot, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "outside.txt"), "keep\n");
    await symlink(
      outside,
      join(worktree.path, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      fixture.workspace.commit({
        worktreeId: worktree.id,
        paths: ["linked/outside.txt"],
        message: "unsafe",
      }),
    ).rejects.toThrow("符号链接");
    expect(normalizeLines(await readFile(join(outside, "outside.txt"), "utf8"))).toBe("keep\n");
  });

  it("keeps conflicts diagnosable and continues only after explicit resolution", async () => {
    const fixture = await createRepositoryFixture();
    const worktree = await fixture.workspace.createWorktree({});
    await writeFile(join(worktree.path, "a.txt"), "member\n");
    const result = await fixture.workspace.commit({
      worktreeId: worktree.id,
      paths: ["a.txt"],
      message: "member conflict",
    });
    await writeFile(join(fixture.repositoryRoot, "a.txt"), "root\n");
    await git(fixture.repositoryRoot, "add", "a.txt");
    await git(fixture.repositoryRoot, "commit", "-m", "root conflict");

    const conflict = await fixture.workspace.integrate({
      worktreeId: worktree.id,
      commit: result.commit,
    });
    expect(conflict).toMatchObject({ status: "conflicted", conflicts: ["a.txt"] });
    await expect(fixture.workspace.resolveIntegration({ action: "continue" })).rejects.toThrow(
      "未解决的冲突",
    );

    await writeFile(join(fixture.repositoryRoot, "a.txt"), "resolved\n");
    await git(fixture.repositoryRoot, "add", "a.txt");
    const resolution = await fixture.workspace.resolveIntegration({ action: "continue" });
    expect(resolution.status).toBe("committed");
    expect(normalizeLines(await readFile(join(fixture.repositoryRoot, "a.txt"), "utf8"))).toBe(
      "resolved\n",
    );
  });

  it("aborts owned staged integration without changing the target HEAD", async () => {
    const fixture = await createRepositoryFixture();
    const worktree = await fixture.workspace.createWorktree({});
    await writeFile(join(worktree.path, "a.txt"), "member\n");
    const result = await fixture.workspace.commit({
      worktreeId: worktree.id,
      paths: ["a.txt"],
      message: "abort result",
    });
    const targetHead = await git(fixture.repositoryRoot, "rev-parse", "HEAD");
    expect(
      await fixture.workspace.integrate({ worktreeId: worktree.id, commit: result.commit }),
    ).toMatchObject({ status: "staged" });

    expect(await fixture.workspace.resolveIntegration({ action: "abort" })).toMatchObject({
      status: "aborted",
    });
    expect((await git(fixture.repositoryRoot, "rev-parse", "HEAD")).trim()).toBe(targetHead.trim());
    expect(await git(fixture.repositoryRoot, "status", "--porcelain")).toBe("");
    expect(normalizeLines(await readFile(join(fixture.repositoryRoot, "a.txt"), "utf8"))).toBe(
      "base\n",
    );
  });

  it("refuses both recovery actions when a restored staged tree has changed", async () => {
    const fixture = await createRepositoryFixture();
    const worktree = await fixture.workspace.createWorktree({});
    await writeFile(join(worktree.path, "a.txt"), "member result\n");
    const result = await fixture.workspace.commit({
      worktreeId: worktree.id,
      paths: ["a.txt"],
      message: "staged result",
    });
    await fixture.workspace.integrate({ worktreeId: worktree.id, commit: result.commit });

    const restored = createGitWorkspace(fixture.workspaceOptions);
    await writeFile(join(fixture.repositoryRoot, "a.txt"), "changed after staging\n");
    await git(fixture.repositoryRoot, "add", "a.txt");
    const recordCount = fixture.workspaceOptions.readRecords().length;

    await expect(restored.resolveIntegration({ action: "continue" })).rejects.toThrow(
      "暂存结果在审批后已经变化",
    );
    await expect(restored.resolveIntegration({ action: "abort" })).rejects.toThrow(
      "集成暂存结果已经变化",
    );
    expect(fixture.workspaceOptions.readRecords()).toHaveLength(recordCount);
    expect((await git(fixture.repositoryRoot, "rev-parse", "HEAD")).trim()).toBe(
      fixture.baseCommit,
    );
    expect(normalizeLines(await readFile(join(fixture.repositoryRoot, "a.txt"), "utf8"))).toBe(
      "changed after staging\n",
    );
  });

  it("restores committed integration when the worktree summary could not be persisted", async () => {
    const fixture = await createRepositoryFixture();
    const worktree = await fixture.workspace.createWorktree({});
    await writeFile(join(worktree.path, "a.txt"), "member result\n");
    const result = await fixture.workspace.commit({
      worktreeId: worktree.id,
      paths: ["a.txt"],
      message: "durable integration",
    });
    const interrupted = createGitWorkspace({
      ...fixture.workspaceOptions,
      appendRecord: async (record) => {
        if (record.kind === "worktree") throw new Error("worktree summary unavailable");
        await fixture.workspaceOptions.appendRecord(record);
      },
    });
    await interrupted.integrate({ worktreeId: worktree.id, commit: result.commit });

    await expect(interrupted.resolveIntegration({ action: "continue" })).rejects.toThrow(
      "worktree summary unavailable",
    );
    const integrationCommit = (await git(fixture.repositoryRoot, "rev-parse", "HEAD")).trim();
    expect(integrationCommit).not.toBe(fixture.baseCommit);
    expect(interrupted.listWorktrees()[0]?.integrated).toBe(false);

    const restored = createGitWorkspace(fixture.workspaceOptions);
    expect(restored.listWorktrees()[0]).toMatchObject({
      integrated: true,
      integrationCommit,
    });
    await expect(restored.resolveIntegration({ action: "continue" })).rejects.toThrow(
      "当前没有待处理的 Git 集成",
    );
    expect((await git(fixture.repositoryRoot, "rev-parse", "HEAD")).trim()).toBe(integrationCommit);
  });

  it("removes clean empty or explicitly discarded worktrees but keeps dirty worktrees", async () => {
    const fixture = await createRepositoryFixture();
    const empty = await fixture.workspace.createWorktree({});
    expect((await fixture.workspace.removeWorktree(empty.id)).status).toBe("removed");

    const discarded = await fixture.workspace.createWorktree({});
    await writeFile(join(discarded.path, "a.txt"), "discarded result\n");
    await fixture.workspace.commit({
      worktreeId: discarded.id,
      paths: ["a.txt"],
      message: "discard me",
    });
    await expect(fixture.workspace.removeWorktree(discarded.id)).rejects.toThrow(
      "需要明确 discard",
    );
    expect((await fixture.workspace.removeWorktree(discarded.id, undefined, true)).status).toBe(
      "removed",
    );

    const dirty = await fixture.workspace.createWorktree({});
    await writeFile(join(dirty.path, "untracked.txt"), "dirty\n");
    await expect(fixture.workspace.removeWorktree(dirty.id, undefined, true)).rejects.toThrow(
      "未提交或未跟踪",
    );
  });

  it("bounds query output and rejects a pre-cancelled operation", async () => {
    const fixture = await createRepositoryFixture();
    await writeFile(join(fixture.repositoryRoot, "a.txt"), "x".repeat(256 * 1024));
    const output = await fixture.workspace.query({ action: "diff" });
    expect(Buffer.byteLength(output, "utf8")).toBeLessThan(132 * 1024);
    expect(output).toContain("Git 输出已截断");
    await expect(
      fixture.workspace.query({ action: "status" }, AbortSignal.abort()),
    ).rejects.toThrow("已取消");
  });
});

type StoredRecord = { kind: string; key: string; payload: JsonValue };

async function createRepositoryFixture(): Promise<{
  fixtureRoot: string;
  repositoryRoot: string;
  baseCommit: string;
  workspace: GitWorkspace;
  workspaceOptions: GitWorkspaceOptions;
}> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "anthias-git-workspace-"));
  fixtureRoots.add(fixtureRoot);
  const repositoryRoot = join(fixtureRoot, "repository");
  await mkdir(repositoryRoot);
  await git(repositoryRoot, "init", "-b", "main");
  await git(repositoryRoot, "config", "user.name", "Anthias Test");
  await git(repositoryRoot, "config", "user.email", "anthias@example.test");
  await writeFile(join(repositoryRoot, "a.txt"), "base\n");
  await writeFile(join(repositoryRoot, "b.txt"), "base b\n");
  await git(repositoryRoot, "add", "a.txt", "b.txt");
  await git(repositoryRoot, "commit", "-m", "base");
  const baseCommit = (await git(repositoryRoot, "rev-parse", "HEAD")).trim();
  const records: StoredRecord[] = [];
  const workspaceOptions: GitWorkspaceOptions = {
    workspaceRoot: repositoryRoot,
    worktreeDirectory: join(fixtureRoot, "worktrees"),
    rootSessionId: "root-session",
    readRecords: () => records,
    appendRecord: async (record) => {
      records.push(record);
    },
  };
  return {
    fixtureRoot,
    repositoryRoot,
    baseCommit,
    workspace: createGitWorkspace(workspaceOptions),
    workspaceOptions,
  };
}

function normalizeLines(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

async function git(cwd: string, ...arguments_: string[]): Promise<string> {
  const result = await execFileAsync("git", arguments_, {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return result.stdout;
}
