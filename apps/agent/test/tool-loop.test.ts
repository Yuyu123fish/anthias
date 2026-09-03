import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelRequest, ModelStream } from "../src/model-stream.js";
import { type AgentEvent, createAgentWithModelStream } from "../src/run.js";
import { createSession, resolveSessionDirectory } from "../src/session.js";

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
        .map((event) => event.toolName),
    ).toEqual(["glob", "grep", "read_file"]);
    expect(agent.state.messageHistory.at(-1)).toMatchObject({
      role: "assistant",
      content: "检查完成。",
      status: "completed",
    });
    expect(agent.state.running).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "run_end",
      metrics: {
        modelRequestCount: 4,
        producedToolCallCount: 3,
        processedToolCallCount: 3,
      },
    });

    const sessionText = await readFile(
      join(sessionDirectory, `${agent.state.sessionId}.jsonl`),
      "utf8",
    );
    const records = sessionText
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    expect(records).toHaveLength(10);
    expect(records.at(-1)).toMatchObject({
      type: "run_finished",
      status: "completed",
      modelRequestCount: 4,
      toolCallCount: 3,
      processedToolCallCount: 3,
      modelUsage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
    });
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

/** 创建一个带确定 token 计量的 finish 事件。 */
function finishEvent(finishReason: "stop" | "tool_calls") {
  return Object.freeze({
    type: "finish" as const,
    finishReason,
    usage: Object.freeze({ inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
  });
}
