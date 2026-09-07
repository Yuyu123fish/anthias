import { glob, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentWithModelStream } from "../src/agent.js";
import type { ModelStream, ModelStreamEvent } from "../src/model/model-stream.js";
import {
  createSession,
  resolveSessionDirectory,
  resolveSessionShell,
} from "../src/session/index.js";

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

describe("Agent Loop safety limits", () => {
  it("continues beyond the former run and shared request limits until normal completion", async () => {
    let modelRequestCount = 0;
    const { agent, sessionDirectory } = await createSafetyTestAgent(async function* () {
      modelRequestCount += 1;
      if (modelRequestCount <= 64) {
        yield toolCallEvent(modelRequestCount, "unknown_tool", {});
        yield finishEvent("tool_calls");
      } else {
        yield { type: "text_delta", delta: "完成" };
        yield finishEvent("stop");
      }
    });

    await expect(agent.prompt("loop")).resolves.toEqual({
      status: "completed",
    });

    expect(modelRequestCount).toBe(65);
    expect(agent.state.messageHistory.filter((message) => message.role === "tool")).toHaveLength(
      64,
    );
    expect(await finalSessionRecord(sessionDirectory)).toMatchObject({
      type: "run_finished",
      status: "completed",
    });
    await agent.close();
  }, 60_000);

  it("retains the task deadline after request counts are removed", async () => {
    let requests = 0;
    const startedAt = Date.now();
    const { agent } = await createSafetyTestAgent(async function* () {
      requests++;
      vi.spyOn(Date, "now").mockReturnValue(startedAt + 31 * 60_000);
      yield toolCallEvent(requests, "unknown_tool", {});
      yield finishEvent("tool_calls");
    });
    expect((await agent.prompt("deadline")).status).toBe("aborted");
    expect(requests).toBe(1);
    expect(JSON.stringify(agent.collaboration.snapshot())).toContain("运行时限");
    await agent.close();
  });

  it("rejects an oversized ToolCall batch before executing any call", async () => {
    let modelRequestCount = 0;
    const { agent, sessionDirectory } = await createSafetyTestAgent(async function* () {
      modelRequestCount += 1;
      for (let index = 1; index <= 33; index += 1) {
        yield toolCallEvent(index, "unknown_tool", {});
      }
      yield finishEvent("tool_calls");
    });

    await expect(agent.prompt("many tools")).resolves.toEqual({
      status: "failed",
      error: "单次模型响应包含过多 ToolCall，Run 已停止。",
    });

    expect(modelRequestCount).toBe(1);
    const toolResults = agent.state.messageHistory.filter((message) => message.role === "tool");
    expect(toolResults).toHaveLength(33);
    expect(
      toolResults.every(
        (message) =>
          message.status === "failed" &&
          message.content === "单次模型响应包含过多 ToolCall，调用未执行。",
      ),
    ).toBe(true);
    expect(await finalSessionRecord(sessionDirectory)).toMatchObject({
      type: "run_finished",
      status: "failed",
    });
  });
});

/** 创建一个临时 Session 与使用给定模型流的 Agent。 */
async function createSafetyTestAgent(modelStream: ModelStream) {
  const { workspaceRoot, sessionDirectory, shell } = await createTestSession();
  const session = await createSession({ workspaceRoot, sessionDirectory, shell });
  return Object.freeze({
    agent: createAgentWithModelStream({ modelStream, session }),
    sessionDirectory,
  });
}

/** 创建只位于系统临时目录的 Session 路径与固定 Shell。 */
async function createTestSession() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-agent-safety-"));
  temporaryDirectories.add(workspaceRoot);
  const sessionDirectory = resolveSessionDirectory(workspaceRoot, {});
  const shell = await resolveSessionShell(process.env);
  return Object.freeze({
    workspaceRoot,
    sessionDirectory,
    shell,
  });
}

/** 读取指定 Session 目录中唯一 JSONL 文件的最终记录。 */
async function finalSessionRecord(sessionDirectory: string) {
  const sessionFiles: string[] = [];
  for await (const sessionFileName of glob("*/*/session.jsonl", { cwd: sessionDirectory })) {
    sessionFiles.push(sessionFileName);
  }
  const [sessionFileName] = sessionFiles;
  if (sessionFileName === undefined) {
    throw new Error("expected Session JSONL");
  }
  const lines = (await readFile(join(sessionDirectory, sessionFileName), "utf8"))
    .trimEnd()
    .split("\n");
  return JSON.parse(lines.at(-1) ?? "null") as Record<string, unknown>;
}

/** 创建一个稳定 UUID 的确定性 ToolCall 事件。 */
function toolCallEvent(index: number, toolName: string, input: unknown): ModelStreamEvent {
  return Object.freeze({
    type: "tool_call",
    toolCallId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    toolName,
    input,
    invalid: false,
  });
}

/** 创建一个确定性的 finish 事件。 */
function finishEvent(finishReason: "stop" | "tool_calls"): ModelStreamEvent {
  return Object.freeze({
    type: "finish",
    finishReason,
  });
}
