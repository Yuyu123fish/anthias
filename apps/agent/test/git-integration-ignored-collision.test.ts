import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonValue } from "../src/message.js";
import { createGitWorkspace } from "../src/tool/basetool/git/index.js";

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

describe("Git integration ignored path safety", { timeout: 60_000 }, () => {
  it("fingerprints and refuses an ignored root file that integration would overwrite", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "anthias-git-ignored-collision-"));
    fixtureRoots.add(fixtureRoot);
    const repositoryRoot = join(fixtureRoot, "repository");
    await mkdir(repositoryRoot);
    await git(repositoryRoot, "init", "-b", "main");
    await git(repositoryRoot, "config", "user.name", "Anthias Test");
    await git(repositoryRoot, "config", "user.email", "anthias@example.test");
    await writeFile(join(repositoryRoot, "base.txt"), "base\n");
    await git(repositoryRoot, "add", "base.txt");
    await git(repositoryRoot, "commit", "-m", "base");

    const records: { kind: string; key: string; payload: JsonValue }[] = [];
    const workspace = createGitWorkspace({
      workspaceRoot: repositoryRoot,
      worktreeDirectory: join(fixtureRoot, "worktrees"),
      rootSessionId: "root-session",
      readRecords: () => records,
      appendRecord: async (record) => {
        records.push(record);
      },
    });
    const worktree = await workspace.createWorktree({});

    await writeFile(join(repositoryRoot, ".gitignore"), "config.txt\n");
    await git(repositoryRoot, "add", ".gitignore");
    await git(repositoryRoot, "commit", "-m", "ignore local config");
    await writeFile(join(repositoryRoot, "config.txt"), "personal-one\n");

    await writeFile(join(worktree.path, "config.txt"), "member result\n");
    const result = await workspace.commit({
      worktreeId: worktree.id,
      paths: ["config.txt"],
      message: "add shared config",
    });
    const before = await workspace.captureApprovalState({
      worktreeId: worktree.id,
      ref: result.commit,
      includeRoot: true,
    });
    await writeFile(join(repositoryRoot, "config.txt"), "personal-two\n");
    const after = await workspace.captureApprovalState({
      worktreeId: worktree.id,
      ref: result.commit,
      includeRoot: true,
    });

    expect(after).not.toBe(before);
    await expect(
      workspace.integrate({ worktreeId: worktree.id, commit: result.commit }),
    ).rejects.toThrow("未跟踪或 ignored");
    expect(await readFile(join(repositoryRoot, "config.txt"), "utf8")).toBe("personal-two\n");
    expect(await git(repositoryRoot, "diff", "--cached", "--name-only")).toBe("");
  });
});

async function git(cwd: string, ...arguments_: string[]): Promise<string> {
  const result = await execFileAsync("git", arguments_, {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return result.stdout;
}
