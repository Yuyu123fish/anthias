import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentEvent, createAgentWithModelStream } from "../src/agent.js";
import type { ModelRequest, ModelStream } from "../src/model/model-stream.js";
import {
  createSession,
  resolveSessionDirectory,
  resolveSessionShell,
} from "../src/session/index.js";

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

describe("complete Coding Agent Tool Loop", { timeout: 20_000 }, () => {
  it("reads, edits, validates, summarizes, and accepts a later prompt in one Session", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-complete-loop-"));
    temporaryDirectories.add(workspaceRoot);
    await mkdir(join(workspaceRoot, "src"));
    const targetFilePath = join(workspaceRoot, "src", "value.txt");
    await writeFile(targetFilePath, "old\n", "utf8");
    const sessionDirectory = resolveSessionDirectory(workspaceRoot, {});
    const shell = await resolveSessionShell(process.env);
    const session = await createSession({ workspaceRoot, sessionDirectory, shell });
    const validationCommand =
      shell.kind === "powershell"
        ? "if ((Get-Content -Raw 'src/value.txt').Trim() -ne 'new') { exit 1 }; Write-Output 'verified'"
        : "test \"$(cat src/value.txt)\" = new && printf 'verified\\n'";
    const modelRequests: ModelRequest[] = [];
    const modelStream: ModelStream = async function* (modelRequest) {
      modelRequests.push(modelRequest);
      switch (modelRequests.length) {
        case 1:
          yield toolCallEvent(1, "glob", { pattern: "src/*.txt" });
          yield toolCallEvent(2, "read_file", { path: "src/value.txt" });
          yield finishEvent("tool_calls");
          return;
        case 2:
          yield toolCallEvent(3, "edit_file", {
            path: "src/value.txt",
            replacements: [{ oldText: "old", newText: "new" }],
          });
          yield finishEvent("tool_calls");
          return;
        case 3:
          yield toolCallEvent(4, "execute_command", {
            command: validationCommand,
            timeoutMs: 10_000,
          });
          yield finishEvent("tool_calls");
          return;
        default:
          yield { type: "text_delta", delta: "修改与验证均已完成。" } as const;
          yield finishEvent("stop");
      }
    };
    const agent = createAgentWithModelStream({ modelStream, session });
    const events: AgentEvent[] = [];
    const approvedToolNames: string[] = [];
    agent.subscribe((event) => {
      events.push(event);
      if (event.type === "tool_approval_requested") {
        approvedToolNames.push(event.request.toolName);
        agent.respondToToolApproval(event.request.toolApprovalRequestId, "approve");
      }
    });

    await expect(agent.prompt("把 old 改成 new 并验证")).resolves.toEqual({ status: "completed" });

    expect(await readFile(targetFilePath, "utf8")).toBe("new\n");
    expect(approvedToolNames).toEqual(["edit_file", "execute_command"]);
    expect(
      events
        .filter((event) => event.type === "tool_execution_start")
        .map((event) => event.activity.toolName),
    ).toEqual(["glob", "read_file", "edit_file", "execute_command"]);
    expect(modelRequests).toHaveLength(4);
    expect(modelRequests[3]?.messages.filter((message) => message.role === "tool")).toHaveLength(4);
    expect(agent.state.messageHistory.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "修改与验证均已完成。" }],
      status: "completed",
    });
    expect(agent.state.running).toBe(false);

    await expect(agent.prompt("继续")).resolves.toEqual({ status: "completed" });
    expect(agent.state.running).toBe(false);
    await agent.close();
  });
});

/** 创建一个稳定 UUID 的确定性 ToolCall 事件。 */
function toolCallEvent(index: number, toolName: string, input: unknown) {
  return Object.freeze({
    type: "tool_call" as const,
    toolCallId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    toolName,
    input,
    invalid: false,
  });
}

/** 创建一个确定性的 finish 事件。 */
function finishEvent(finishReason: "stop" | "tool_calls") {
  return Object.freeze({
    type: "finish" as const,
    finishReason,
  });
}
