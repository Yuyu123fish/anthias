import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentEvent, createAgentWithModelStream } from "../src/agent.js";
import { createRunDiagnostic } from "../src/model/model-diagnostics.js";
import { retryModelStream } from "../src/model/model-retry.js";
import {
  type ModelRequest,
  ModelRequestError,
  type ModelStream,
  type ModelStreamEvent,
  streamAssistantMessage,
} from "../src/model/model-stream.js";
import { readSessionHistory } from "../src/session/history.js";
import { createSession, openSession } from "../src/session/index.js";
import { isRunDiagnostic } from "../src/session/schema.js";

const request: ModelRequest = {
  systemPrompt: "local test",
  messages: [{ role: "user", content: "inspect" }],
  tools: [],
  purpose: "response",
};
const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("bounded ordinary model recovery", () => {
  it.each(["span", "delta"] as const)(
    "retains an empty reasoning %s only in the current model message",
    async (source) => {
      const events = await collect(
        streamAssistantMessage(
          async function* () {
            if (source === "span") yield { type: "reasoning_start" };
            yield { type: "reasoning_delta", delta: "" };
            if (source === "span") yield { type: "reasoning_end" };
            yield { type: "text_delta", delta: "answer" };
            yield { type: "finish", finishReason: "stop" };
          },
          request,
          new AbortController().signal,
        ),
      );
      expect(events.map((event) => event.type)).toEqual(["start", "update", "finish"]);
      expect(events.at(-1)).toMatchObject({
        message: { content: [{ type: "text", text: "answer" }], status: "completed" },
        modelInputMessage: {
          content: [
            { type: "reasoning", text: "" },
            { type: "text", text: "answer" },
          ],
        },
      });
    },
  );

  it("discards empty reasoning from a failed attempt before retrying", async () => {
    vi.useFakeTimers();
    let requestCount = 0;
    const rawModelStream: ModelStream = async function* () {
      requestCount += 1;
      if (requestCount === 1) {
        yield { type: "reasoning_start" };
        yield { type: "reasoning_delta", delta: "" };
        throw new ModelRequestError("service");
      }
      yield { type: "text_delta", delta: "answer" };
      yield { type: "finish", finishReason: "stop" };
    };
    const completion = collect(
      streamAssistantMessage(
        (modelRequest, abortSignal) =>
          retryModelStream({
            modelStream: rawModelStream,
            request: modelRequest,
            abortSignal,
            state: { retryCount: 0, deliveredContent: false },
          }),
        request,
        new AbortController().signal,
      ),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect((await completion).at(-1)).toMatchObject({
      message: { status: "completed", diagnostic: { retryCount: 1 } },
      modelInputMessage: { content: [{ type: "text", text: "answer" }] },
    });
    expect(requestCount).toBe(2);
  });

  it("retries two temporary failures and counts every real request once", async () => {
    vi.useFakeTimers();
    let requests = 0;
    const attemptUsage: unknown[] = [];
    const modelStream: ModelStream = async function* () {
      requests++;
      if (requests < 3) throw new ModelRequestError("service", { httpStatus: 503 });
      yield { type: "text_delta", delta: "完成" };
      yield { type: "finish", finishReason: "stop" };
    };
    const completion = collect(
      retryModelStream({
        modelStream,
        request,
        abortSignal: new AbortController().signal,
        state: { retryCount: 0, deliveredContent: false },
        onAttemptFinished: async (usage) => {
          attemptUsage.push(usage);
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(1500);
    const events = await completion;
    expect(requests).toBe(3);
    expect(attemptUsage).toEqual([undefined, undefined, undefined]);
    expect(
      events
        .filter((event) => event.type === "model_retry")
        .map((event) => [event.phase, event.retryCount, event.delayMs]),
    ).toEqual([
      ["waiting", 1, 500],
      ["requesting", 1, 0],
      ["waiting", 2, 1000],
      ["requesting", 2, 0],
    ]);
    expect(events.at(-1)).toMatchObject({ type: "finish", retryCount: 2 });
  });

  it("exhausts after at most two extra requests with a safe terminal reason", async () => {
    vi.useFakeTimers();
    let requests = 0;
    const completion = collect(
      retryModelStream({
        modelStream: async function* () {
          requests++;
          yield* [];
          throw new ModelRequestError("rate_limit", { httpStatus: 429 });
        },
        request,
        abortSignal: new AbortController().signal,
        state: { retryCount: 0, deliveredContent: false },
      }),
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await completion).toMatchObject({
      diagnostic: {
        category: "rate_limit",
        httpStatus: 429,
        retryCount: 2,
        retryStopReason: "exhausted",
      },
    });
    expect(requests).toBe(3);
  });

  it.each<ModelStreamEvent>([
    { type: "text_delta", delta: "partial" },
    { type: "reasoning_delta", delta: "partial" },
    { type: "tool_input_delta", toolCallId: "provider-call", delta: "{partial" },
    {
      type: "tool_call",
      toolCallId: randomUUID(),
      toolName: "write_file",
      input: {},
      invalid: false,
    },
  ])("never retries after receiving $type content", async (event) => {
    let requests = 0;
    const completion = collect(
      retryModelStream({
        modelStream: async function* () {
          requests++;
          yield event;
          throw new ModelRequestError("network");
        },
        request,
        abortSignal: new AbortController().signal,
        state: { retryCount: 0, deliveredContent: false },
      }),
    );
    await expect(completion).rejects.toMatchObject({
      diagnostic: { retryCount: 0, retryStopReason: "content_delivered" },
    });
    expect(requests).toBe(1);
  });

  it("allows stage-only preparation and cancels its wait without another request", async () => {
    const controller = new AbortController();
    let requests = 0;
    let recordedAttempts = 0;
    const events: ModelStreamEvent[] = [];
    for await (const event of retryModelStream({
      modelStream: async function* () {
        requests++;
        yield { type: "tool_input_start", toolCallId: "provider-call", toolName: "read_file" };
        throw new ModelRequestError("service");
      },
      request,
      abortSignal: controller.signal,
      state: { retryCount: 0, deliveredContent: false },
      onAttemptFinished: async () => {
        recordedAttempts++;
      },
    })) {
      events.push(event);
      if (event.type === "model_retry") controller.abort();
    }
    expect(events.at(-1)).toMatchObject({ type: "model_retry", phase: "waiting", retryCount: 1 });
    expect(requests).toBe(1);
    expect(recordedAttempts).toBe(1);
  });

  it.each([
    "authentication",
    "configuration",
    "invalid_request",
    "context_overflow",
    "unknown",
  ] as const)("does not retry %s", async (category) => {
    let requests = 0;
    await expect(
      collect(
        retryModelStream({
          modelStream: async function* () {
            requests++;
            yield* [];
            throw new ModelRequestError(category);
          },
          request,
          abortSignal: new AbortController().signal,
          state: { retryCount: 0, deliveredContent: false },
        }),
      ),
    ).rejects.toMatchObject({ diagnostic: { category, retryCount: 0, retryStopReason: null } });
    expect(requests).toBe(1);
  });

  it.each(["compaction", "approval"] as const)(
    "never adds retries to %s requests",
    async (purpose) => {
      let requests = 0;
      await expect(
        collect(
          retryModelStream({
            modelStream: async function* () {
              requests++;
              yield* [];
              throw new ModelRequestError("service");
            },
            request: { ...request, purpose },
            abortSignal: new AbortController().signal,
            state: { retryCount: 0, deliveredContent: false },
          }),
        ),
      ).rejects.toBeInstanceOf(ModelRequestError);
      expect(requests).toBe(1);
    },
  );

  it.each([
    { retryAfterMs: 31_000, remaining: 60_000, reason: "wait_too_long" },
    { retryAfterMs: 0, remaining: 499, reason: "deadline" },
  ])(
    "ends instead of exceeding retry wait or remaining task budget: $reason",
    async ({ retryAfterMs, remaining, reason }) => {
      let requests = 0;
      await expect(
        collect(
          retryModelStream({
            modelStream: async function* () {
              requests++;
              yield* [];
              throw new ModelRequestError("rate_limit", { retryAfterMs });
            },
            request,
            abortSignal: new AbortController().signal,
            state: { retryCount: 0, deliveredContent: false },
            remainingTaskTimeMs: () => remaining,
          }),
        ),
      ).rejects.toMatchObject({ diagnostic: { retryStopReason: reason, retryCount: 0 } });
      expect(requests).toBe(1);
    },
  );
});

describe("safe final model facts", () => {
  it.each([
    { finishReason: "length" as const, text: "partial", category: "output_limit" },
    { finishReason: "content_filter" as const, text: "", category: "content_filter" },
    { finishReason: "stop" as const, text: " ", category: "empty_response" },
  ])("records $category without fabricating usage", async ({ finishReason, text, category }) => {
    const events = await collect(
      streamAssistantMessage(
        async function* () {
          yield { type: "text_delta", delta: text };
          yield { type: "finish", finishReason };
        },
        request,
        new AbortController().signal,
      ),
    );
    expect(events.at(-1)).toMatchObject({
      type: "finish",
      message: {
        status: "failed",
        diagnostic: { category, providerFinishReason: finishReason, usage: null, retryCount: 0 },
      },
    });
  });

  it("keeps preparation and complete calls on one local identity without publishing fragments", async () => {
    const events = await collect(
      streamAssistantMessage(
        async function* () {
          yield { type: "tool_input_start", toolCallId: "provider-call", toolName: "read_file" };
          yield {
            type: "tool_input_delta",
            toolCallId: "provider-call",
            delta: "private-partial-fragment",
          };
          yield {
            type: "tool_call",
            toolCallId: "provider-call",
            toolName: "read_file",
            input: { path: "README.md" },
            invalid: false,
          };
          yield { type: "finish", finishReason: "tool_calls" };
        },
        request,
        new AbortController().signal,
      ),
    );
    const preparation = events.filter((event) => event.type === "tool_preparation");
    expect(preparation.map((event) => event.phase)).toEqual(["input", "ready"]);
    expect(preparation[0]?.toolCallId).toBe(preparation[1]?.toolCallId);
    expect(events.at(-1)).toMatchObject({
      type: "finish",
      message: { content: [{ toolCallId: preparation[0]?.toolCallId }] },
    });
    expect(JSON.stringify(events)).not.toContain("private-partial-fragment");
  });

  it("does not complete while a tool input remains incomplete", async () => {
    const events = await collect(
      streamAssistantMessage(
        async function* () {
          yield { type: "tool_input_start", toolCallId: "unfinished", toolName: "write_file" };
          yield { type: "tool_input_delta", toolCallId: "unfinished", delta: '{"path":' };
          yield { type: "text_delta", delta: "正在写入" };
          yield { type: "finish", finishReason: "stop" };
        },
        request,
        new AbortController().signal,
      ),
    );
    expect(events.at(-1)).toMatchObject({
      type: "finish",
      message: { status: "failed", diagnostic: { category: "unknown" } },
    });
    expect(
      events.some((event) => event.type === "tool_preparation" && event.phase === "ready"),
    ).toBe(false);
  });

  it("replaces stage-only preparation on retry and preserves internal abort identity", async () => {
    vi.useFakeTimers();
    let requests = 0;
    const rawStream: ModelStream = async function* () {
      requests++;
      if (requests === 1) {
        yield { type: "tool_input_start", toolCallId: "replaced", toolName: "read_file" };
        throw new ModelRequestError("service");
      }
      yield { type: "text_delta", delta: "无需工具。" };
      yield { type: "finish", finishReason: "stop" };
    };
    const modelStream: ModelStream = (request, abortSignal) =>
      retryModelStream({
        modelStream: rawStream,
        request,
        abortSignal,
        state: { retryCount: 0, deliveredContent: false },
      });
    const completion = collect(
      streamAssistantMessage(modelStream, request, new AbortController().signal),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect((await completion).at(-1)).toMatchObject({
      type: "finish",
      message: { status: "completed", diagnostic: { retryCount: 1 } },
    });
    const internallyAborted = await collect(
      streamAssistantMessage(
        async function* () {
          yield* [];
          throw new ModelRequestError("aborted", { abortSource: "internal" });
        },
        request,
        new AbortController().signal,
      ),
    );
    expect(internallyAborted.at(-1)).toMatchObject({
      type: "finish",
      message: { status: "aborted", diagnostic: { abortSource: "internal" } },
    });
  });

  it("does not send or count a retry cancelled by the requesting event subscriber", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let requests = 0;
    const rawStream: ModelStream = async function* () {
      requests++;
      yield* [];
      throw new ModelRequestError("service");
    };
    const modelStream: ModelStream = (request, abortSignal) =>
      retryModelStream({
        modelStream: rawStream,
        request,
        abortSignal,
        state: { retryCount: 0, deliveredContent: false },
      });
    const completion = (async () => {
      const events = [];
      for await (const event of streamAssistantMessage(modelStream, request, controller.signal)) {
        events.push(event);
        if (event.type === "model_retry" && event.phase === "requesting") controller.abort();
      }
      return events;
    })();
    await vi.advanceTimersByTimeAsync(500);
    expect((await completion).at(-1)).toMatchObject({
      type: "finish",
      message: { status: "aborted", diagnostic: { retryCount: 0 } },
    });
    expect(requests).toBe(1);
  });

  it("never publishes arbitrary exceptions or fake response secrets", async () => {
    const events = await collect(
      streamAssistantMessage(
        async function* () {
          yield* [];
          throw new Error("rawBody secret-value https://user:password@host/private");
        },
        request,
        new AbortController().signal,
      ),
    );
    expect(events.at(-1)).toMatchObject({
      type: "finish",
      message: { diagnostic: { category: "unknown", httpStatus: null } },
    });
    expect(JSON.stringify(events)).not.toMatch(/secret-value|password|rawBody/);
  });

  it("continues after a provider failure without replaying a completed write or approval", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-model-continue-"));
    temporaryDirectories.push(workspaceRoot);
    const sessionDirectory = join(workspaceRoot, "sessions");
    const shell = { kind: "powershell" as const, executable: "pwsh", arguments: [] };
    const session = await createSession({ workspaceRoot, sessionDirectory, shell });
    let requests = 0;
    const modelStream: ModelStream = async function* (request) {
      requests++;
      if (requests === 1) {
        yield {
          type: "tool_call",
          toolCallId: randomUUID(),
          toolName: "write_file",
          input: { path: "result.txt", content: "saved once" },
          invalid: false,
        };
        yield { type: "finish", finishReason: "tool_calls" };
      } else if (requests === 2) throw new ModelRequestError("authentication", { httpStatus: 401 });
      else {
        expect(
          request.messages.filter(
            (message) => message.role === "tool" && message.status === "completed",
          ),
        ).toHaveLength(1);
        yield { type: "text_delta", delta: "已沿现有结果继续。" };
        yield { type: "finish", finishReason: "stop" };
      }
    };
    const events: AgentEvent[] = [];
    const agent = createAgentWithModelStream({ modelStream, session });
    agent.subscribe((event) => {
      events.push(event);
      if (event.type === "tool_approval_requested")
        agent.respondToToolApproval(event.request.toolApprovalRequestId, "approve");
    });
    expect((await agent.prompt("保存结果并继续")).status).toBe("failed");
    expect(requests).toBe(2);
    expect(events.filter((event) => event.type === "tool_execution_start")).toHaveLength(1);
    expect(agent.state.lastRunDiagnostic).toMatchObject({
      category: "authentication",
      httpStatus: 401,
      retryCount: 0,
    });
    expect(events.findLast((event) => event.type === "run_end")).toMatchObject({
      diagnostic: agent.state.lastRunDiagnostic,
    });
    await agent.close();
    const history = await readSessionHistory({ sessionDirectory, sessionId: session.sessionId });
    expect(history.records.findLast((record) => record.type === "run_finished")).toMatchObject({
      diagnostic: { category: "authentication", httpStatus: 401 },
    });
    const reopened = await openSession({
      workspaceRoot,
      sessionDirectory,
      shell,
      sessionId: session.sessionId,
    });
    const continued = createAgentWithModelStream({ modelStream, session: reopened });
    continued.subscribe((event) => events.push(event));
    expect(requests).toBe(2);
    expect(continued.state.lastRunDiagnostic).toMatchObject({ category: "authentication" });
    expect((await continued.prompt("沿已经保存的结果继续")).status).toBe("completed");
    expect(requests).toBe(3);
    expect(events.filter((event) => event.type === "tool_execution_start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool_approval_requested")).toHaveLength(1);
    expect(await readFile(join(workspaceRoot, "result.txt"), "utf8")).toBe("saved once");
    await continued.close();
  });

  it("round-trips optional diagnostic facts while legacy messages remain unknown and read-only", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-model-facts-"));
    temporaryDirectories.push(workspaceRoot);
    const sessionDirectory = join(workspaceRoot, "sessions");
    const session = await createSession({
      workspaceRoot,
      sessionDirectory,
      shell: { kind: "powershell", executable: "pwsh", arguments: [] },
    });
    const leaseResult = await session.acquireRun(randomUUID());
    if (leaseResult.status !== "acquired") throw new Error("expected lease");
    const diagnostic = createRunDiagnostic("output_limit", {
      providerErrorCode: "missing_reasoning_content",
      providerErrorParam: "messages[].reasoning_content",
      requestSummary: {
        purpose: "response",
        maxOutputTokens: 64_000,
        messageCount: 2,
        toolDefinitionCount: 0,
        toolCallCount: 0,
        toolResultCount: 0,
        reasoningMessageCount: 0,
        unpairedToolCallCount: 0,
        unexpectedToolResultCount: 0,
      },
      retryCount: 1,
      providerFinishReason: "length",
      usage: {
        inputTokens: 12,
        outputTokens: 20,
        reasoningTokens: 15,
        cachedInputTokens: null,
        cacheWriteInputTokens: null,
      },
    });
    await leaseResult.lease.appendMessage({ role: "user", content: "inspect" });
    await leaseResult.lease.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "partial" }],
      status: "failed",
      diagnostic,
    });
    await leaseResult.lease.appendRunFinished({ status: "failed", diagnostic });
    await leaseResult.lease.release();
    const legacyLeaseResult = await session.acquireRun(randomUUID());
    if (legacyLeaseResult.status !== "acquired") throw new Error("expected lease");
    await legacyLeaseResult.lease.appendMessage({ role: "user", content: "legacy" });
    await legacyLeaseResult.lease.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "old" }],
      status: "completed",
    });
    await legacyLeaseResult.lease.appendRunFinished({ status: "completed" });
    await legacyLeaseResult.lease.release();
    await session.close();
    const history = await readSessionHistory({ sessionDirectory, sessionId: session.sessionId });
    expect(history.messages[1]).toMatchObject({ diagnostic });
    expect(history.records.find((record) => record.type === "run_finished")).toMatchObject({
      diagnostic,
    });
    expect(history.messages[3]).not.toHaveProperty("diagnostic");
    expect(isRunDiagnostic({ ...diagnostic, rawBody: "secret" })).toBe(false);
    expect(isRunDiagnostic({ ...diagnostic, providerErrorCode: "synthetic_secret" })).toBe(false);
    expect(
      isRunDiagnostic({ ...diagnostic, providerErrorParam: "messages[].synthetic_secret" }),
    ).toBe(false);
    expect(
      isRunDiagnostic({
        ...diagnostic,
        requestSummary: { ...diagnostic.requestSummary, content: "synthetic_secret" },
      }),
    ).toBe(false);
    const legacyDiagnostic = createRunDiagnostic("completed", {
      usage: {
        inputTokens: 12,
        outputTokens: 2,
        cachedInputTokens: null,
        cacheWriteInputTokens: null,
      },
    });
    expect(isRunDiagnostic(legacyDiagnostic)).toBe(true);
    expect(legacyDiagnostic.usage).not.toHaveProperty("reasoningTokens");
    expect(legacyDiagnostic).not.toHaveProperty("requestSummary");
    expect(isRunDiagnostic({ ...diagnostic, usage: { inputTokens: 12 } })).toBe(false);
  });
});

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const event of events) values.push(event);
  return values;
}
