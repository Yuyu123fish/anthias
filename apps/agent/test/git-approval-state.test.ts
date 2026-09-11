import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonValue } from "../src/message.js";
import { createGitWorkspace } from "../src/tool/basetool/git/index.js";
import { createGitTools } from "../src/tool/basetool/git/tool.js";
import { createWorkspaceAccess } from "../src/tool/workspace-access.js";

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

describe("Git approval state", { timeout: 60_000 }, () => {
  it("rechecks an approved commit after a queued file writer finishes", async () => {
    const fixture = await createFixture();
    const path = join(fixture.repositoryRoot, "base.txt");
    await writeFile(path, "approved change\n");
    const resourceStates: string[] = [];
    const tool = createGitTools({
      git: fixture.workspace,
      primary: true,
      assertIdle: () => {},
      resourceState: (_id, state) => resourceStates.push(state),
    }).tools("agent")[0];
    if (tool === undefined) throw new Error("missing Git tool");
    const prepared = await tool
      .createPlan(
        {
          type: "tool_call",
          toolCallId: "queued-commit",
          toolName: "git",
          input: { action: "commit", paths: ["base.txt"], message: "approved" },
          invalid: false,
        },
        "agent",
      )
      .prepare();
    if (!prepared.ok) throw new Error(prepared.result.content);
    const releaseWriter = await fixture.workspaceAccess.acquireFileWrite(
      fixture.repositoryRoot,
      path,
    );
    const resultPromise = prepared.preparedExecution.execute(
      new AbortController().signal,
      () => {},
    );
    await writeFile(path, "changed by the preceding writer\n");
    expect(resourceStates).toEqual(["waiting"]);
    releaseWriter();
    expect(await resultPromise).toMatchObject({
      status: "failed",
      content: expect.stringContaining("Git 状态已经变化"),
    });
    expect(resourceStates).toEqual(["waiting", "acquired", "released"]);
    expect((await git(fixture.repositoryRoot, "log", "-1", "--format=%s")).trim()).toBe("base");
    expect((await git(fixture.repositoryRoot, "diff", "--cached", "--name-only")).trim()).toBe("");
  });

  it("cancels a queued Git mutation without holding or changing the workspace", async () => {
    const fixture = await createFixture();
    const path = join(fixture.repositoryRoot, "base.txt");
    await writeFile(path, "uncommitted\n");
    const releaseWriter = await fixture.workspaceAccess.acquireFileWrite(
      fixture.repositoryRoot,
      path,
    );
    const controller = new AbortController();
    const resultPromise = fixture.workspace.commit(
      { paths: ["base.txt"], message: "never" },
      controller.signal,
    );
    controller.abort();
    await expect(resultPromise).rejects.toThrow();
    releaseWriter();
    expect((await git(fixture.repositoryRoot, "log", "-1", "--format=%s")).trim()).toBe("base");
    expect((await git(fixture.repositoryRoot, "diff", "--cached", "--name-only")).trim()).toBe("");
  });

  it("changes when an untracked file keeps its status but changes content", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.repositoryRoot, "untracked.txt"), "first-value\n");
    const beforeStatus = await fixture.workspace.query({ action: "status" });
    const before = await fixture.workspace.captureApprovalState({});

    await writeFile(join(fixture.repositoryRoot, "untracked.txt"), "other-value\n");
    const afterStatus = await fixture.workspace.query({ action: "status" });
    const after = await fixture.workspace.captureApprovalState({});

    expect(afterStatus).toBe(beforeStatus);
    expect(after).not.toBe(before);
  });

  it("changes when only content beyond truncated diff output changes", async () => {
    const fixture = await createFixture("A".repeat(200 * 1024));
    await writeFile(join(fixture.repositoryRoot, "a-large.txt"), `${"B".repeat(200 * 1024)}\n`);
    await writeFile(join(fixture.repositoryRoot, "z-tail.txt"), "first-value\n");
    const beforeDiff = await fixture.workspace.query({ action: "diff" });
    const before = await fixture.workspace.captureApprovalState({});

    await writeFile(join(fixture.repositoryRoot, "z-tail.txt"), "other-value\n");
    const afterDiff = await fixture.workspace.query({ action: "diff" });
    const after = await fixture.workspace.captureApprovalState({});

    expect(beforeDiff).toContain("Git 输出已截断");
    expect(afterDiff).toBe(beforeDiff);
    expect(after).not.toBe(before);
  });
});

async function createFixture(largeContent?: string) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "anthias-git-approval-"));
  fixtureRoots.add(fixtureRoot);
  const repositoryRoot = join(fixtureRoot, "repository");
  await mkdir(repositoryRoot);
  await git(repositoryRoot, "init", "-b", "main");
  await git(repositoryRoot, "config", "user.name", "Anthias Test");
  await git(repositoryRoot, "config", "user.email", "anthias@example.test");
  await writeFile(join(repositoryRoot, "base.txt"), "base\n");
  if (largeContent !== undefined) {
    await writeFile(join(repositoryRoot, "a-large.txt"), `${largeContent}\n`);
    await writeFile(join(repositoryRoot, "z-tail.txt"), "base-tail\n");
  }
  await git(repositoryRoot, "add", ".");
  await git(repositoryRoot, "commit", "-m", "base");
  const records: { kind: string; key: string; payload: JsonValue }[] = [];
  const workspaceAccess = createWorkspaceAccess();
  const workspace = createGitWorkspace({
    workspaceAccess,
    workspaceRoot: repositoryRoot,
    worktreeDirectory: join(fixtureRoot, "worktrees"),
    rootSessionId: "root-session",
    readRecords: () => records,
    appendRecord: async (record) => {
      records.push(record);
    },
  });
  return { repositoryRoot, workspace, workspaceAccess };
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
