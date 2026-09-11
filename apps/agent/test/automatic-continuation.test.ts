import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentEvent, createAgentWithModelStream } from "../src/agent.js";
import {
  type ModelRequest,
  ModelRequestError,
  type ModelStream,
} from "../src/model/model-stream.js";
import { createSession } from "../src/session/index.js";
import { promptToCompletion } from "./prompt-helper.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(modelStream: ModelStream) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-auto-recovery-"));
  cleanups.push(() => rm(workspaceRoot, { recursive: true, force: true }));
  const session = await createSession({
    workspaceRoot,
    sessionDirectory: join(workspaceRoot, "sessions"),
    shell: { kind: "powershell", executable: "pwsh", arguments: [] },
  });
  const agent = createAgentWithModelStream({ session, modelStream });
  cleanups.push(() => agent.close());
  const events: AgentEvent[] = [];
  agent.subscribe((event) => {
    events.push(event);
    if (event.type === "tool_approval_requested")
      agent.respondToToolApproval(event.request.toolApprovalRequestId, "approve");
  });
  return { workspaceRoot, session, agent, events };
}

describe("automatic continuation in the same run", () => {
  it.each(["text", "reasoning", "arguments", "tool_call"] as const)(
    "seals failed %s and continues without executing unfinished calls or inventing user input",
    async (partialKind) => {
      let requests = 0;
      const unfinishedCallId = randomUUID();
      const signals: AbortSignal[] = [];
      const inputs: ModelRequest[] = [];
      const { agent, session, events } = await setup(async function* (request, signal) {
        signals.push(signal);
        requests += 1;
        if (requests === 1) {
          if (partialKind === "text") yield { type: "text_delta", delta: "partial answer" };
          if (partialKind === "reasoning")
            yield { type: "reasoning_delta", delta: "private unfinished thought" };
          if (partialKind === "arguments") {
            yield {
              type: "tool_input_start",
              toolCallId: unfinishedCallId,
              toolName: "write_file",
            };
            yield { type: "tool_input_delta", toolCallId: unfinishedCallId, delta: '{"path":' };
          }
          if (partialKind === "tool_call")
            yield {
              type: "tool_call",
              toolCallId: unfinishedCallId,
              toolName: "write_file",
              input: { path: "never.txt", content: "must not execute" },
              invalid: false,
            };
          throw new ModelRequestError("network");
        }
        inputs.push(request);
        yield { type: "text_delta", delta: "finished answer" };
        yield { type: "finish", finishReason: "stop" };
      });
      expect((await promptToCompletion(agent, "完成任务，不重复确认。")).status).toBe("completed");
      expect(requests).toBe(2);
      const continuedRequest = inputs[0];
      if (continuedRequest === undefined) throw new Error("missing continuation");
      expect(continuedRequest.systemPrompt).toContain("运行时恢复提示");
      expect(continuedRequest.systemPrompt).toContain("本提示不构成新用户授权");
      expect(continuedRequest.systemPrompt).toContain("已获授权的后续步骤不再询问是否继续");
      expect(
        session.records.filter(
          (record) => record.type === "message" && record.message.role === "user",
        ),
      ).toHaveLength(1);
      expect(JSON.stringify(continuedRequest.messages)).not.toContain("private unfinished thought");
      if (partialKind === "tool_call")
        expect(continuedRequest.messages).toContainEqual(
          expect.objectContaining({
            role: "tool",
            toolCallId: unfinishedCallId,
            status: "aborted",
          }),
        );

      expect(signals[0]).toBe(signals[1]);
      expect(events.filter((event) => event.type === "run_start")).toHaveLength(1);
      expect(events.filter((event) => event.type === "run_end")).toHaveLength(1);
      expect(events.filter((event) => event.type === "tool_execution_start")).toHaveLength(0);
      expect(
        session.records
          .filter((record) => record.type === "message" && record.message.role === "assistant")
          .map((record) =>
            record.type === "message" && record.message.role === "assistant"
              ? record.message.status
              : null,
          ),
      ).toEqual(["failed", "completed"]);
      expect(session.records.filter((record) => record.type === "request_usage")).toHaveLength(2);
      expect(agent.state.lastRunDiagnostic).toMatchObject({ category: "completed", retryCount: 1 });
    },
  );

  it("continues truncated output from durable results without repeating a completed write", async () => {
    let requests = 0;
    const { workspaceRoot, agent, events, session } = await setup(async function* (request) {
      requests += 1;
      if (requests === 1) {
        yield {
          type: "tool_call",
          toolCallId: randomUUID(),
          toolName: "write_file",
          input: { path: "result.txt", expectedVersion: "missing", content: "saved once" },
          invalid: false,
        };
        yield { type: "finish", finishReason: "tool_calls" };
      } else if (requests === 2) {
        yield { type: "text_delta", delta: "partial report" };
        yield { type: "finish", finishReason: "length" };
      } else {
        expect(request.systemPrompt).toContain("缩小单次输出");
        expect(
          request.messages.filter(
            (message) => message.role === "tool" && message.status === "completed",
          ),
        ).toHaveLength(1);
        yield { type: "text_delta", delta: "finished report" };
        yield { type: "finish", finishReason: "stop" };
      }
    });
    expect((await promptToCompletion(agent, "保存结果并完成报告。")).status).toBe("completed");
    expect(await readFile(join(workspaceRoot, "result.txt"), "utf8")).toBe("saved once");
    expect(events.filter((event) => event.type === "tool_execution_start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool_approval_requested")).toHaveLength(1);
    expect(session.records.filter((record) => record.type === "request_usage")).toHaveLength(3);
  });

  it.each(["retry-first", "continuation-first"] as const)(
    "shares exactly two recovery attempts across retries and continuations: %s",
    async (order) => {
      let requests = 0;
      const { agent, session } = await setup(async function* () {
        requests += 1;
        if (
          (order === "retry-first" && requests !== 1) ||
          (order === "continuation-first" && requests === 1)
        )
          yield { type: "text_delta", delta: "partial" };
        throw new ModelRequestError("service");
      });
      expect((await promptToCompletion(agent, "finish")).status).toBe("failed");
      expect(requests).toBe(3);
      expect(agent.state.lastRunDiagnostic).toMatchObject({
        category: "service",
        retryCount: 2,
        retryStopReason: "exhausted",
      });
      expect(session.records.filter((record) => record.type === "request_usage")).toHaveLength(3);
    },
  );

  it.each(["waiting", "requesting"] as const)(
    "cancels continuation at %s without counting or issuing the next request",
    async (phase) => {
      let requests = 0;
      const { agent, session } = await setup(async function* () {
        requests += 1;
        yield { type: "text_delta", delta: "partial" };
        yield { type: "finish", finishReason: "length" };
      });
      agent.subscribe((event) => {
        if (event.type === "model_retry" && event.phase === phase) agent.abort();
      });
      const result = await promptToCompletion(agent, "finish");
      expect(
        result.status,
        JSON.stringify({ result, diagnostic: agent.state.lastRunDiagnostic }),
      ).toBe("aborted");
      expect(requests).toBe(1);
      expect(agent.state.lastRunDiagnostic).toMatchObject({ retryCount: 0, abortSource: "user" });
      expect(session.records.filter((record) => record.type === "request_usage")).toHaveLength(1);
    },
  );

  it("honors long Retry-After after partial output", async () => {
    let requests = 0;
    const { agent } = await setup(async function* () {
      requests += 1;
      yield { type: "text_delta", delta: "partial" };
      throw new ModelRequestError("rate_limit", { retryAfterMs: 31_000 });
    });
    expect((await promptToCompletion(agent, "finish")).status).toBe("failed");
    expect(requests).toBe(1);
    expect(agent.state.lastRunDiagnostic).toMatchObject({ retryStopReason: "wait_too_long" });
  });

  it.each([
    "authentication",
    "configuration",
    "invalid_request",
    "unknown",
    "content_filter",
  ] as const)("does not recover %s after partial output", async (category) => {
    let requests = 0;
    const { agent } = await setup(async function* () {
      requests += 1;
      yield { type: "text_delta", delta: "partial" };
      throw new ModelRequestError(category);
    });
    expect((await promptToCompletion(agent, "finish")).status).toBe("failed");
    expect(requests).toBe(1);
    expect(agent.state.lastRunDiagnostic).toMatchObject({ category, retryCount: 0 });
  });
});
