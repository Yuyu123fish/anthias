import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentWithModelStream } from "../src/agent.js";
import type { AssistantToolCallPart } from "../src/message.js";
import type { ModelStream, ModelStreamEvent } from "../src/model/model-stream.js";
import {
  createSession,
  resolveSessionDirectory,
  resolveSessionShell,
} from "../src/session/index.js";
import { prepareWriteFileTool } from "../src/tool/basetool/write-file.js";
import { promptToCompletion } from "./prompt-helper.js";

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

describe("external single-file approval", () => {
  it("writes exactly one approved external absolute file", async () => {
    const fixture = await createFixture();
    const externalPath = join(fixture.externalDirectory, "created.txt");
    let modelRequestCount = 0;
    const modelStream: ModelStream = async function* () {
      modelRequestCount += 1;
      if (modelRequestCount === 1) {
        yield toolCallEvent(1, "write_file", { path: externalPath, content: "approved\n" });
        yield finishEvent("tool_calls");
        return;
      }
      yield { type: "text_delta", delta: "写入完成。" };
      yield finishEvent("stop");
    };
    const agent = createAgentWithModelStream({ modelStream, session: fixture.session });
    const promptResultPromise = promptToCompletion(agent, "写入外部文件");
    await vi.waitFor(() => expect(agent.state.pendingToolApproval).not.toBeNull());
    const approval = agent.state.pendingToolApproval;
    if (approval === null) {
      throw new Error("expected external file approval");
    }

    expect(approval.target).toBe(externalPath);
    expect(approval.riskSummary).toContain("工作区外");
    expect(approval.executionBoundary).toContain("一个精确文件");
    await expect(access(externalPath)).rejects.toThrow();
    agent.respondToToolApproval(approval.toolApprovalRequestId, "approve");

    await expect(promptResultPromise).resolves.toEqual({ status: "completed" });
    await expect(readFile(externalPath, "utf8")).resolves.toBe("approved\n");
  });

  it("fails stale external content after approval without overwriting it", async () => {
    const fixture = await createFixture();
    const externalPath = join(fixture.externalDirectory, "existing.txt");
    await writeFile(externalPath, "before\n", "utf8");
    let modelRequestCount = 0;
    const modelStream: ModelStream = async function* () {
      modelRequestCount += 1;
      if (modelRequestCount === 1) {
        yield toolCallEvent(2, "edit_file", {
          path: externalPath,
          replacements: [{ oldText: "before", newText: "agent" }],
        });
        yield finishEvent("tool_calls");
        return;
      }
      yield { type: "text_delta", delta: "已看到 stale target。" };
      yield finishEvent("stop");
    };
    const agent = createAgentWithModelStream({ modelStream, session: fixture.session });
    const approvalReady = Promise.withResolvers<void>();
    agent.subscribe((event) => {
      if (event.type === "tool_approval_requested") approvalReady.resolve();
    });
    const promptResultPromise = promptToCompletion(agent, "修改外部文件");
    await approvalReady.promise;
    const approval = agent.state.pendingToolApproval;
    if (approval === null) {
      throw new Error("expected external edit approval");
    }

    await writeFile(externalPath, "external\n", "utf8");
    agent.respondToToolApproval(approval.toolApprovalRequestId, "approve");

    await expect(promptResultPromise).resolves.toEqual({ status: "completed" });
    await expect(readFile(externalPath, "utf8")).resolves.toBe("external\n");
    expect(
      agent.state.messageHistory.filter((message) => message.role === "tool").at(-1),
    ).toMatchObject({
      status: "failed",
      content: expect.stringContaining("stale target"),
    });
  });

  it("rejects path classes that cannot become an exact external-file capability", async () => {
    const fixture = await createFixture();
    const volumeRoot = parse(fixture.workspaceRoot).root;
    const platformSpecificPaths =
      process.platform === "win32"
        ? [
            "\\\\server\\share\\blocked.txt",
            "\\\\?\\C:\\blocked.txt",
            join(fixture.externalDirectory, "blocked.txt:stream"),
            process.env.SystemRoot
              ? join(process.env.SystemRoot, "anthias-blocked.txt")
              : volumeRoot,
          ]
        : ["/etc/anthias-blocked.txt", "/dev/anthias-blocked"];
    const rejectedPaths = [volumeRoot, fixture.externalDirectory, ...platformSpecificPaths];

    for (const [index, rejectedPath] of rejectedPaths.entries()) {
      const result = await prepareWriteFileTool(
        fileToolCall(index + 10, "write_file", { path: rejectedPath, content: "blocked" }),
        {
          workspaceRoot: fixture.workspaceRoot,
          sessionDirectory: fixture.sessionDirectory,
        },
      );
      expect(result.ok, rejectedPath).toBe(false);
    }
  });

  it("accepts an absolute workspace filename containing literal brackets", async () => {
    const fixture = await createFixture();
    const workspacePath = join(fixture.workspaceRoot, "report[1].txt");

    const result = await prepareWriteFileTool(
      fileToolCall(30, "write_file", { path: workspacePath, content: "workspace" }),
      {
        workspaceRoot: fixture.workspaceRoot,
        sessionDirectory: fixture.sessionDirectory,
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preparedTool).toMatchObject({
        scope: "workspace",
        target: "report[1].txt",
      });
    }
  });
});

async function createFixture() {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "anthias-external-file-"));
  temporaryDirectories.add(fixtureRoot);
  const workspaceRoot = join(fixtureRoot, "workspace");
  const externalDirectory = join(fixtureRoot, "external");
  await mkdir(workspaceRoot);
  await mkdir(externalDirectory);
  const sessionDirectory = resolveSessionDirectory(workspaceRoot, {});
  const shell = await resolveSessionShell(process.env);
  const session = await createSession({ workspaceRoot, sessionDirectory, shell });
  return Object.freeze({ workspaceRoot, externalDirectory, sessionDirectory, session });
}

function fileToolCall(
  index: number,
  toolName: "edit_file" | "write_file",
  input: AssistantToolCallPart["input"],
): AssistantToolCallPart {
  return Object.freeze({
    type: "tool_call",
    toolCallId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    toolName,
    input,
    invalid: false,
  });
}

function toolCallEvent(index: number, toolName: string, input: unknown): ModelStreamEvent {
  return Object.freeze({
    type: "tool_call",
    toolCallId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    toolName,
    input,
    invalid: false,
  });
}

function finishEvent(finishReason: "stop" | "tool_calls"): ModelStreamEvent {
  return Object.freeze({ type: "finish", finishReason });
}
