import { createHash, randomUUID } from "node:crypto";
import { getEventListeners } from "node:events";
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantToolCallPart } from "../src/message.js";
import { prepareEditFileTool } from "../src/tool/basetool/edit-file.js";
import {
  executePreparedCommand,
  prepareCommandTool,
} from "../src/tool/basetool/execute-command.js";
import {
  executePreparedFileTool,
  type PreparedFileTool,
} from "../src/tool/basetool/file-change.js";
import { executeReadFileTool } from "../src/tool/basetool/read-file.js";
import { prepareWriteFileTool } from "../src/tool/basetool/write-file.js";
import { finalizeToolResult } from "../src/tool/tool-result.js";
import { createWorkspaceAccess, type WorkspaceAccess } from "../src/tool/workspace-access.js";
import type { ToolWorkspace } from "../src/tool/workspace-path.js";

const fixtureRoots: string[] = [];
afterEach(async () => {
  for (const path of fixtureRoots.splice(0)) await rm(path, { recursive: true, force: true });
});
const version = (content: string | Uint8Array) =>
  "sha256:" + createHash("sha256").update(content).digest("hex");
const call = (toolName: string, input: AssistantToolCallPart["input"]): AssistantToolCallPart => ({
  type: "tool_call",
  toolName,
  toolCallId: randomUUID(),
  input,
  invalid: false,
});
const signal = () => new AbortController().signal;

async function fixture(): Promise<ToolWorkspace> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-workspace-write-"));
  fixtureRoots.push(workspaceRoot);
  return {
    workspaceRoot,
    sessionDirectory: join(workspaceRoot, ".sessions"),
    workspaceAccess: createWorkspaceAccess(),
  };
}
async function preparedWrite(
  workspace: ToolWorkspace,
  path: string,
  content: string,
  expectedVersion: string,
): Promise<PreparedFileTool> {
  const result = await prepareWriteFileTool(
    call("write_file", { path, content, expectedVersion }),
    workspace,
  );
  if (!result.ok) throw new Error(result.result.content);
  return result.preparedTool;
}

describe("workspace file versions and write coordination", () => {
  it("returns the full raw byte version for every page including a BOM and CRLF", async () => {
    const workspace = await fixture();
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("one\r\ntwo\r\nthree\r\n"),
    ]);
    await writeFile(join(workspace.workspaceRoot, "text.txt"), bytes);
    const result = await executeReadFileTool(
      call("read_file", { path: "text.txt", startLine: 2, lineCount: 1 }),
      workspace,
      signal(),
    );
    expect(result.content).toContain("version: " + version(bytes));
    expect(result.content).toContain("2| two");
    expect(result.filePage?.totalLines).toBe(3);
    expect((await finalizeToolResult("read", result, undefined, 140)).content).toContain(
      "version: " + version(bytes),
    );
  });

  it("rejects missing versions and never replaces a model version with a new preparation snapshot", async () => {
    const workspace = await fixture();
    await writeFile(join(workspace.workspaceRoot, "text.txt"), "newer");
    for (const toolName of ["write_file", "edit_file"]) {
      const input =
        toolName === "write_file"
          ? { path: "text.txt", content: "replacement" }
          : { path: "text.txt", replacements: [{ oldText: "newer", newText: "replacement" }] };
      const prepare = toolName === "write_file" ? prepareWriteFileTool : prepareEditFileTool;
      expect(await prepare(call(toolName, input), workspace)).toMatchObject({
        ok: false,
        result: { content: expect.stringContaining("expectedVersion") },
      });
      expect(
        await prepare(call(toolName, { ...input, expectedVersion: version("older") }), workspace),
      ).toMatchObject({
        ok: false,
        result: { content: expect.stringContaining("stale version") },
      });
    }
    expect(await readFile(join(workspace.workspaceRoot, "text.txt"), "utf8")).toBe("newer");
  });

  it("distinguishes an empty file from missing and accepts content restored to identical bytes", async () => {
    const workspace = await fixture();
    const path = join(workspace.workspaceRoot, "empty.txt");
    await writeFile(path, "");
    expect(
      await prepareWriteFileTool(
        call("write_file", { path: "empty.txt", content: "new", expectedVersion: "missing" }),
        workspace,
      ),
    ).toMatchObject({ ok: false });
    const prepared = await preparedWrite(workspace, "empty.txt", "new", version(""));
    await writeFile(path, "temporary change");
    await writeFile(path, "");
    expect((await executePreparedFileTool(prepared, signal())).status).toBe("completed");
    expect((await preparedWrite(workspace, "new.txt", "", "missing")).expectedVersion).toBe(
      "missing",
    );
  });

  it.each(["existing", "missing"])(
    "allows only one writer from the same %s version",
    async (kind) => {
      const workspace = await fixture();
      if (kind === "existing") await writeFile(join(workspace.workspaceRoot, "text.txt"), "before");
      const expectedVersion = kind === "existing" ? version("before") : "missing";
      const first = await preparedWrite(workspace, "text.txt", "first", expectedVersion);
      const second = await preparedWrite({ ...workspace }, "text.txt", "second", expectedVersion);
      const results = await Promise.all([
        executePreparedFileTool(first, signal()),
        executePreparedFileTool(second, signal()),
      ]);
      expect(results.filter((result) => result.status === "completed")).toHaveLength(1);
      expect(results.filter((result) => result.content.includes("stale target"))).toHaveLength(1);
      expect(["first", "second"]).toContain(
        await readFile(join(workspace.workspaceRoot, "text.txt"), "utf8"),
      );
    },
  );

  it("coordinates the same actual path through directory aliases and Windows casing", async () => {
    const workspace = await fixture();
    const directory = join(workspace.workspaceRoot, "actual");
    await mkdir(directory);
    await symlink(directory, join(workspace.workspaceRoot, "alias"), "junction");
    await writeFile(join(directory, "text.txt"), "before");
    const paths = [
      "actual/text.txt",
      process.platform === "win32" ? "ALIAS/TEXT.TXT" : "alias/text.txt",
    ];
    const prepared = await Promise.all(
      paths.map((path, index) => preparedWrite(workspace, path, String(index), version("before"))),
    );
    const results = await Promise.all(
      prepared.map((request) => executePreparedFileTool(request, signal())),
    );
    expect(results.filter((result) => result.status === "completed")).toHaveLength(1);
  });

  it("uses inode identity for hard links across workspace aliases", async () => {
    const workspace = await fixture();
    const firstPath = join(workspace.workspaceRoot, "first.txt");
    const aliasPath = join(workspace.workspaceRoot, "second.txt");
    await writeFile(firstPath, "before");
    await link(firstPath, aliasPath);
    const coordinator = workspace.workspaceAccess;
    if (coordinator === undefined) throw new Error("missing coordinator");
    const releaseFirst = await coordinator.acquireFileWrite(workspace.workspaceRoot, firstPath);
    const waitingController = new AbortController();
    let aliasAcquired = false;
    const aliasRequest = coordinator
      .acquireFileWrite(workspace.workspaceRoot, aliasPath, waitingController.signal)
      .then((release) => {
        aliasAcquired = true;
        release();
      });
    try {
      await vi.waitFor(() =>
        expect(getEventListeners(waitingController.signal, "abort")).toHaveLength(1),
      );
      expect(aliasAcquired).toBe(false);
      waitingController.abort();
      await expect(aliasRequest).rejects.toThrow("已停止");
      expect(getEventListeners(waitingController.signal, "abort")).toHaveLength(0);
    } finally {
      waitingController.abort();
      releaseFirst();
    }
  });

  it("rechecks file and parent identities after waiting and releases on failure", async () => {
    const workspace = await fixture();
    const directory = join(workspace.workspaceRoot, "directory");
    await mkdir(directory);
    await writeFile(join(directory, "text.txt"), "before");
    const prepared = await preparedWrite(
      workspace,
      "directory/text.txt",
      "agent",
      version("before"),
    );
    const release = await workspace.workspaceAccess?.acquireExclusiveWrite([
      workspace.workspaceRoot,
    ]);
    const resultPromise = executePreparedFileTool(prepared, signal());
    await rename(directory, join(workspace.workspaceRoot, "old-directory"));
    await mkdir(directory);
    await writeFile(join(directory, "text.txt"), "before");
    release?.();
    expect(await resultPromise).toMatchObject({
      status: "failed",
      content: expect.stringContaining("stale target"),
    });
    expect(await readFile(join(directory, "text.txt"), "utf8")).toBe("before");
    expect(
      (
        await executePreparedFileTool(
          await preparedWrite(workspace, "after.txt", "released", "missing"),
          signal(),
        )
      ).status,
    ).toBe("completed");
  });

  it("cancels a queued writer without waiting for the active workspace owner", async () => {
    const workspace = await fixture();
    const prepared = await preparedWrite(workspace, "cancelled.txt", "never", "missing");
    const release = await workspace.workspaceAccess?.acquireExclusiveWrite([
      workspace.workspaceRoot,
    ]);
    const abortController = new AbortController();
    const resultPromise = executePreparedFileTool(prepared, abortController.signal);
    await vi.waitFor(() =>
      expect(getEventListeners(abortController.signal, "abort")).toHaveLength(1),
    );
    abortController.abort();
    expect(await resultPromise).toMatchObject({
      status: "failed",
      content: expect.stringContaining("已停止"),
    });
    await expect(readFile(join(workspace.workspaceRoot, "cancelled.txt"))).rejects.toThrow();
    release?.();
  });

  it("checks permission after acquiring and immediately before replacement", async () => {
    const baseWorkspace = await fixture();
    let permissionChecks = 0;
    const workspace = {
      ...baseWorkspace,
      assertWriteAllowed: () => {
        if (++permissionChecks === 2) throw new Error("write permission revoked");
      },
    };
    const prepared = await preparedWrite(workspace, "blocked.txt", "never", "missing");
    expect(await executePreparedFileTool(prepared, signal())).toMatchObject({
      status: "failed",
      content: "write permission revoked",
    });
    expect(permissionChecks).toBe(2);
    expect(await readdir(workspace.workspaceRoot)).toEqual([]);
  });

  it("allows independent files to hold write access together", async () => {
    const workspace = await fixture();
    const coordinator = workspace.workspaceAccess;
    if (coordinator === undefined) throw new Error("missing coordinator");
    const releaseWriters = Promise.withResolvers<void>();
    let activeWriters = 0;
    const observedAccess: WorkspaceAccess = {
      ...coordinator,
      async acquireFileWrite(...args) {
        const release = await coordinator.acquireFileWrite(...args);
        activeWriters++;
        await releaseWriters.promise;
        return () => {
          activeWriters--;
          release();
        };
      },
    };
    const observedWorkspace = { ...workspace, workspaceAccess: observedAccess };
    const prepared = await Promise.all(
      ["first.txt", "second.txt"].map((path) =>
        preparedWrite(observedWorkspace, path, "created", "missing"),
      ),
    );
    const resultPromise = Promise.all(
      prepared.map((request) => executePreparedFileTool(request, signal())),
    );
    try {
      await vi.waitFor(() => expect(activeWriters).toBe(2));
    } finally {
      releaseWriters.resolve();
    }
    expect((await resultPromise).map((result) => result.status)).toEqual([
      "completed",
      "completed",
    ]);
  });

  it("lets a queued command block later file writers without blocking another workspace", async () => {
    const workspace = await fixture();
    const coordinator = workspace.workspaceAccess;
    if (coordinator === undefined) throw new Error("missing coordinator");
    const releaseFirst = await coordinator.acquireFileWrite(
      workspace.workspaceRoot,
      join(workspace.workspaceRoot, "first.txt"),
    );
    const commandController = new AbortController();
    const fileController = new AbortController();
    const commandLease = coordinator.acquireExclusiveWrite(
      [workspace.workspaceRoot],
      commandController.signal,
    );
    await vi.waitFor(() =>
      expect(getEventListeners(commandController.signal, "abort")).toHaveLength(1),
    );
    const nextFileLease = coordinator.acquireFileWrite(
      workspace.workspaceRoot,
      join(workspace.workspaceRoot, "second.txt"),
      fileController.signal,
    );
    await vi.waitFor(() =>
      expect(getEventListeners(fileController.signal, "abort")).toHaveLength(1),
    );
    const otherWorkspace = await fixture();
    const releaseOther = await coordinator.acquireExclusiveWrite([otherWorkspace.workspaceRoot]);
    releaseOther();
    releaseFirst();
    const releaseCommand = await commandLease;
    expect(getEventListeners(fileController.signal, "abort")).toHaveLength(1);
    releaseCommand();
    const releaseFile = await nextFileLease;
    releaseFile();
    expect(getEventListeners(fileController.signal, "abort")).toHaveLength(0);
  });

  it("keeps command execution exclusive until cancellation cleanup while another workspace proceeds", async () => {
    const workspace = await fixture();
    if (workspace.workspaceAccess === undefined) throw new Error("missing coordinator");
    const otherWorkspace = { ...(await fixture()), workspaceAccess: workspace.workspaceAccess };
    const commandStarted = Promise.withResolvers<void>();
    const commandController = new AbortController();
    const command = await prepareCommandTool(
      call("execute_command", {
        command: "process.stdout.write('started'); setInterval(() => {}, 1000)",
        timeoutMs: 10_000,
      }),
      workspace,
      { kind: "posix", executable: process.execPath, arguments: ["-e"] },
    );
    if (!command.ok) throw new Error(command.result.content);
    const commandResult = executePreparedCommand(
      command.preparedTool,
      commandController.signal,
      () => commandStarted.resolve(),
    );
    await commandStarted.promise;
    const states: string[] = [];
    const prepared = await preparedWrite(
      { ...workspace, resourceState: (_id, state) => states.push(state) },
      "after-command.txt",
      "after",
      "missing",
    );
    const fileResult = executePreparedFileTool(prepared, signal());
    try {
      expect(
        (
          await executePreparedFileTool(
            await preparedWrite(otherWorkspace, "independent.txt", "parallel", "missing"),
            signal(),
          )
        ).status,
      ).toBe("completed");
      expect(states).toEqual(["waiting"]);
      expect(
        (
          await executeReadFileTool(
            call("read_file", { path: "independent.txt" }),
            otherWorkspace,
            signal(),
          )
        ).status,
      ).toBe("completed");
    } finally {
      commandController.abort();
    }
    expect((await commandResult).cleanupUncertain).toBe(false);
    expect((await fileResult).status).toBe("completed");
    expect(states).toEqual(["waiting", "acquired", "released"]);
  });
});
