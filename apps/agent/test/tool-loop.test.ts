import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentEvent, createAgentWithModelStream } from "../src/agent.js";
import type { ModelRequest, ModelStream } from "../src/model/model-stream.js";
import { createSession, resolveSessionDirectory } from "../src/session/index.js";

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

describe("read-only Agent Tool Loop", () => {
  it("runs glob, grep, read_file, and a final model response in one Run", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-tool-loop-"));
    temporaryDirectories.add(workspaceRoot);
    await mkdir(join(workspaceRoot, "src"));
    await writeFile(
      join(workspaceRoot, "src", "example.ts"),
      "export const target = 42;\n",
      "utf8",
    );
    const sessionDirectory = resolveSessionDirectory(workspaceRoot, {});
    const session = await createSession({
      workspaceRoot,
      sessionDirectory,
      shell: { kind: "powershell", executable: "pwsh.exe", arguments: ["-Command"] },
    });
    const modelRequests: ModelRequest[] = [];
    const modelStream: ModelStream = async function* (modelRequest) {
      modelRequests.push(modelRequest);
      const requestNumber = modelRequests.length;
      if (requestNumber === 1) {
        yield toolCallEvent("00000000-0000-4000-8000-000000000011", "glob", {
          pattern: "**/*.ts",
        });
        yield finishEvent("tool_calls");
        return;
      }
      if (requestNumber === 2) {
        yield toolCallEvent("00000000-0000-4000-8000-000000000012", "grep", {
          pattern: "target",
          filePattern: "**/*.ts",
        });
        yield finishEvent("tool_calls");
        return;
      }
      if (requestNumber === 3) {
        yield toolCallEvent("00000000-0000-4000-8000-000000000013", "read_file", {
          path: "src/example.ts",
        });
        yield finishEvent("tool_calls");
        return;
      }
      yield { type: "text_delta", delta: "检查完成。" };
      yield finishEvent("stop");
    };
    const agent = createAgentWithModelStream({ modelStream, session });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => events.push(event));

    await expect(agent.prompt("检查 target")).resolves.toEqual({ status: "completed" });

    expect(modelRequests).toHaveLength(4);
    expect(modelRequests[0]?.tools.map((tool) => tool.name)).toEqual([
      "read_file",
      "glob",
      "grep",
      "read_artifact",
      "edit_file",
      "write_file",
      "execute_command",
    ]);
    expect(modelRequests[0]?.systemPrompt).toContain(workspaceRoot);
    expect(modelRequests[3]?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
      "tool",
    ]);
    expect(
      events
        .filter((event) => event.type === "tool_execution_start")
        .map((event) => event.activity),
    ).toEqual([
      {
        toolCallId: "00000000-0000-4000-8000-000000000011",
        toolName: "glob",
        summary: "pattern: **/*.ts; base: .",
      },
      {
        toolCallId: "00000000-0000-4000-8000-000000000012",
        toolName: "grep",
        summary: "pattern: target; base: .; files: **/*.ts",
      },
      {
        toolCallId: "00000000-0000-4000-8000-000000000013",
        toolName: "read_file",
        summary: "path: src/example.ts",
      },
    ]);
    expect(
      events.filter((event) => event.type === "run_phase_changed").map((event) => event.phase),
    ).toEqual([
      "executing_tool",
      "requesting_model",
      "executing_tool",
      "requesting_model",
      "executing_tool",
      "requesting_model",
    ]);
    expect(agent.state.messageHistory.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "检查完成。" }],
      status: "completed",
    });
    expect(agent.state.running).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "run_end",
      result: { status: "completed" },
    });

    const sessionText = await readFile(join(session.storageDirectory, "session.jsonl"), "utf8");
    const records = sessionText
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    expect(records).toHaveLength(14);
    expect(records.at(-1)).toMatchObject({
      type: "run_finished",
      status: "completed",
    });
  });

  it("rejects deterministic read-only input errors before execution start", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-invalid-read-tool-"));
    temporaryDirectories.add(workspaceRoot);
    const sessionDirectory = resolveSessionDirectory(workspaceRoot, {});
    const session = await createSession({
      workspaceRoot,
      sessionDirectory,
      shell: { kind: "powershell", executable: "pwsh.exe", arguments: ["-Command"] },
    });
    let modelRequestCount = 0;
    const modelStream: ModelStream = async function* () {
      modelRequestCount += 1;
      if (modelRequestCount === 1) {
        yield toolCallEvent("00000000-0000-4000-8000-000000000021", "read_file", {
          path: "../outside.txt",
        });
        yield toolCallEvent("00000000-0000-4000-8000-000000000022", "grep", {
          pattern: "[",
        });
        yield finishEvent("tool_calls");
        return;
      }
      yield { type: "text_delta", delta: "已拒绝。" };
      yield finishEvent("stop");
    };
    const agent = createAgentWithModelStream({ modelStream, session });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => events.push(event));

    await expect(agent.prompt("检查非法调用")).resolves.toEqual({ status: "completed" });

    expect(events.some((event) => event.type === "tool_execution_start")).toBe(false);
    expect(events.some((event) => event.type === "run_phase_changed")).toBe(false);
    expect(
      agent.state.messageHistory
        .filter((message) => message.role === "tool")
        .map((message) => message.status),
    ).toEqual(["failed", "failed"]);
  });
});

/** 创建一个确定性 ToolCall 模型事件。 */
function toolCallEvent(toolCallId: string, toolName: string, input: unknown) {
  return Object.freeze({
    type: "tool_call" as const,
    toolCallId,
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
