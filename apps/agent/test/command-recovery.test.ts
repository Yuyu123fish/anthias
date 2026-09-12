import { ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import {
  executePreparedCommand,
  prepareCommandTool,
} from "../src/tool/basetool/execute-command.js";
import { executePreparedFileTool } from "../src/tool/basetool/file-change.js";
import { prepareWriteFileTool } from "../src/tool/basetool/write-file.js";
import { createWorkspaceAccess } from "../src/tool/workspace-access.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));
const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it.each([false, true])(
  "reports a blocked workspace after uncertain cleanup even if cwd is replaced: %s",
  async (replaceCwd) => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-command-recovery-"));
    directories.push(workspaceRoot);
    const workspace = {
      workspaceRoot,
      sessionDirectory: join(workspaceRoot, ".sessions"),
      sessionId: "owner-session",
      workspaceAccess: createWorkspaceAccess(),
    };
    await mkdir(join(workspaceRoot, "nested", "cwd"), { recursive: true });
    const prepared = await prepareCommandTool(
      {
        type: "tool_call",
        toolName: "execute_command",
        toolCallId: "browser-call",
        input: { command: "browser", cwd: "nested/cwd", timeoutMs: 1000 },
        invalid: false,
      },
      workspace,
      { kind: "powershell", executable: "powershell.exe", arguments: ["-Command"] },
    );
    const file = await prepareWriteFileTool(
      {
        type: "tool_call",
        toolName: "write_file",
        toolCallId: "next-write",
        input: { path: "next.txt", expectedVersion: "missing", content: "must not run" },
        invalid: false,
      },
      workspace,
    );
    if (!prepared.ok || !file.ok) throw new Error("fixture preparation failed");
    const child = new ChildProcess();
    vi.spyOn(child, "kill").mockReturnValue(true);
    Object.defineProperties(child, {
      stdout: { value: new PassThrough() },
      stderr: { value: new PassThrough() },
    });
    vi.mocked(spawn).mockReturnValue(child);
    const controller = new AbortController();
    const command = executePreparedCommand(prepared.preparedTool, controller.signal, () => {});
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    if (replaceCwd) {
      await rm(join(workspaceRoot, "nested"), { recursive: true });
      await writeFile(join(workspaceRoot, "nested"), "replaced directory");
    }
    const queuedWriter = executePreparedFileTool(file.preparedTool, new AbortController().signal);
    controller.abort();
    const result = await command;
    expect(result.cleanupUncertain).toBe(true);
    expect(result.processStarted).toBe(true);
    expect(result.content).toContain("workspace_blocked");
    expect(await queuedWriter).toMatchObject({
      status: "failed",
      content: expect.stringContaining("workspace_blocked"),
    });
    const writerController = new AbortController();
    try {
      const writing = executePreparedFileTool(file.preparedTool, writerController.signal);
      const outcome = await Promise.race([
        writing,
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("still waiting for workspace"), 150),
        ),
      ]);
      expect(outcome).toMatchObject({
        status: "failed",
        content: expect.stringContaining("workspace_blocked"),
      });
      await expect(readFile(join(workspaceRoot, "next.txt"))).rejects.toThrow();
    } finally {
      writerController.abort();
    }
  },
  6000,
);

it("persists only blocks and requires cleanup evidence or direct user confirmation to recover", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-block-recovery-"));
  directories.push(workspaceRoot);
  const directory = join(workspaceRoot, "blocks");
  const access = createWorkspaceAccess({ directory });
  let cleanupConfirmed = false;
  const block = await access.block(
    {
      workspaceRoots: [workspaceRoot],
      sessionId: "owner",
      toolCallId: "command",
      reason: "cleanup uncertain",
    },
    async () => cleanupConfirmed,
  );
  expect(block.persisted).toBe(true);
  expect((await access.recover(block.blockId, new AbortController().signal)).status).toBe(
    "blocked",
  );
  const restored = createWorkspaceAccess({ directory });
  await restored.ready();
  await expect(restored.acquireExclusiveWrite([workspaceRoot])).rejects.toThrow(block.blockId);
  expect((await restored.recover(block.blockId, new AbortController().signal)).status).toBe(
    "blocked",
  );
  cleanupConfirmed = true;
  expect((await access.recover(block.blockId, new AbortController().signal)).status).toBe(
    "recovered",
  );
  const secondBlock = await access.block({
    workspaceRoots: [workspaceRoot],
    sessionId: "owner",
    toolCallId: "second-command",
    reason: "second uncertainty",
  });
  expect((await access.recover(block.blockId, new AbortController().signal, true)).status).toBe(
    "not_found",
  );
  await expect(access.acquireExclusiveWrite([workspaceRoot])).rejects.toThrow(secondBlock.blockId);
  expect(
    (await access.recover(secondBlock.blockId, new AbortController().signal, true)).status,
  ).toBe("recovered");
  const release = await access.acquireExclusiveWrite([workspaceRoot]);
  release();
  const afterRecovery = createWorkspaceAccess({ directory });
  await afterRecovery.ready();
  expect(afterRecovery.snapshot()).toHaveLength(0);
});

it("bounds command lock waiting without starting a process", async () => {
  vi.mocked(spawn).mockClear();
  const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-wait-budget-"));
  directories.push(workspaceRoot);
  const workspaceAccess = createWorkspaceAccess();
  const release = await workspaceAccess.acquireExclusiveWrite([workspaceRoot]);
  const prepared = await prepareCommandTool(
    {
      type: "tool_call",
      toolName: "execute_command",
      toolCallId: "waiting",
      input: { command: "never", timeoutMs: 1000 },
      invalid: false,
    },
    { workspaceRoot, workspaceAccess, sessionDirectory: join(workspaceRoot, ".sessions") },
    { kind: "powershell", executable: "pwsh", arguments: [] },
  );
  if (!prepared.ok) throw new Error("preparation failed");
  try {
    const result = await executePreparedCommand(
      prepared.preparedTool,
      new AbortController().signal,
      () => {},
    );
    expect(result.content).toContain("workspace_timeout");
    expect(result.content).toContain("processStarted: false");
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    release();
  }
});

it("keeps protection when saving or removing a block fails", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-block-storage-"));
  directories.push(workspaceRoot);
  const directory = join(workspaceRoot, "records");
  const access = createWorkspaceAccess({ directory });
  await access.ready();
  await writeFile(directory, "cannot create a directory here");
  const block = await access.block({
    workspaceRoots: [workspaceRoot],
    sessionId: "owner",
    toolCallId: "uncertain",
    reason: "cleanup uncertain",
  });
  expect(block.persisted).toBe(false);
  expect(block.reason).toContain("跨重启状态不可保证");
  await expect(access.acquireExclusiveWrite([workspaceRoot])).rejects.toThrow(block.blockId);
  await expect(access.recover(block.blockId, new AbortController().signal, true)).rejects.toThrow();
  expect(access.snapshot()).toHaveLength(1);
  await rm(directory);
  expect((await access.recover(block.blockId, new AbortController().signal, true)).status).toBe(
    "recovered",
  );
});

it.skipIf(process.platform !== "win32")(
  "recovers when real output handles close after an unsuccessful cancellation",
  async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-late-cleanup-"));
    directories.push(workspaceRoot);
    const workspaceAccess = createWorkspaceAccess();
    const preparation = await prepareCommandTool(
      {
        type: "tool_call",
        toolName: "execute_command",
        toolCallId: "late-cleanup",
        input: { command: "setTimeout(() => {}, 6000)", timeoutMs: 15000 },
        invalid: false,
      },
      { workspaceRoot, workspaceAccess, sessionDirectory: join(workspaceRoot, ".sessions") },
      { kind: "powershell", executable: process.execPath, arguments: ["-e"] },
    );
    if (!preparation.ok) throw new Error("preparation failed");
    const actualChildProcess =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    let observedProcess: ChildProcess | undefined;
    vi.mocked(spawn).mockImplementation((...argumentsList) => {
      if (argumentsList[0] === process.execPath) {
        observedProcess = actualChildProcess.spawn(...argumentsList);
        vi.spyOn(observedProcess, "kill").mockReturnValue(false);
        return observedProcess;
      }
      const failedTermination = new ChildProcess();
      queueMicrotask(() => failedTermination.emit("close", 1));
      return failedTermination;
    });
    const controller = new AbortController();
    const completion = executePreparedCommand(
      preparation.preparedTool,
      controller.signal,
      () => {},
    );
    await vi.waitFor(() => expect(observedProcess).toBeDefined());
    controller.abort();
    expect((await completion).cleanupUncertain).toBe(true);
    const block = workspaceAccess.snapshot()[0];
    if (!block) throw new Error("expected a block");
    expect(
      (await workspaceAccess.recover(block.blockId, new AbortController().signal)).status,
    ).toBe("blocked");
    // Node 自己从真实管道 EOF 推进 close；手动 emit(close) 会掩盖内部监听被删的缺陷。
    await vi.waitFor(
      () => {
        expect(observedProcess?.stdout?.readableEnded).toBe(true);
        expect(observedProcess?.stderr?.readableEnded).toBe(true);
      },
      { timeout: 8000, interval: 25 },
    );
    expect(
      (await workspaceAccess.recover(block.blockId, new AbortController().signal)).status,
    ).toBe("recovered");
    const release = await workspaceAccess.acquireExclusiveWrite([workspaceRoot]);
    release();
  },
  15000,
);

it("reports output held after exit without terminating an expired process identity", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-output-pending-"));
  directories.push(workspaceRoot);
  const workspaceAccess = createWorkspaceAccess();
  const preparation = await prepareCommandTool(
    {
      type: "tool_call",
      toolName: "execute_command",
      toolCallId: "exited-command",
      input: { command: "one-shot command", timeoutMs: 30000 },
      invalid: false,
    },
    { workspaceRoot, workspaceAccess, sessionDirectory: join(workspaceRoot, ".sessions") },
    { kind: "powershell", executable: "pwsh", arguments: ["-Command"] },
  );
  if (!preparation.ok) throw new Error("preparation failed");
  const commandProcess = new ChildProcess();
  const killProcess = vi.spyOn(commandProcess, "kill").mockReturnValue(true);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.defineProperties(commandProcess, { stdout: { value: stdout }, stderr: { value: stderr } });
  vi.mocked(spawn).mockClear().mockReturnValue(commandProcess);
  const completion = executePreparedCommand(
    preparation.preparedTool,
    new AbortController().signal,
    () => {},
  );
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
  stdout.write("client finished\n");
  commandProcess.emit("exit", 0);
  try {
    const result = await completion;
    expect(result.status).toBe("failed");
    expect(result.content).toContain("termination: output_pending");
    expect(result.content).toContain("client finished");
    expect(result.cleanupUncertain).toBe(true);
    expect(killProcess).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    const block = workspaceAccess.snapshot()[0];
    if (!block) throw new Error("expected output ownership to remain blocked");
    await expect(workspaceAccess.acquireExclusiveWrite([workspaceRoot])).rejects.toThrow(
      block.blockId,
    );
  } finally {
    stdout.end();
    stderr.end();
  }
}, 6000);
