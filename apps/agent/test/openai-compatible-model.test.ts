import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentEvent, createAgentWithModelStream } from "../src/agent.js";
import { readModelConfig } from "../src/model/model-config.js";
import { ModelRequestError } from "../src/model/model-stream.js";
import { createOpenAICompatibleModelStream } from "../src/model/openai-compatible-model.js";
import {
  createSession,
  resolveSessionDirectory,
  resolveSessionShell,
} from "../src/session/index.js";
import { FIXED_TOOL_DEFINITIONS } from "../src/tool/definitions.js";

const servers = new Set<ReturnType<typeof createServer>>();
const temporaryDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all([...servers].map((server) => closeServer(server)));
  servers.clear();
  vi.unstubAllEnvs();
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

describe("createOpenAICompatibleModelStream", () => {
  it("normalizes OpenAI-compatible reasoning chunks", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "keep-alive",
      });
      writeReasoningChunk(response, "inspect ");
      writeReasoningChunk(response, "the workspace");
      writeChunk(response, "done");
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-reasoning",
          created: 0,
          model: "test-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
      );
      response.write("data: [DONE]\n\n");
      response.end();
    });
    const address = server.address() as AddressInfo;
    const modelStream = createOpenAICompatibleModelStream({
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      modelId: "test-model",
      apiKey: "test-key",
    });

    await expect(
      collect(
        modelStream(
          {
            systemPrompt: "system rules",
            messages: [{ role: "user", content: "inspect" }],
            tools: FIXED_TOOL_DEFINITIONS,
          },
          new AbortController().signal,
        ),
      ),
    ).resolves.toEqual([
      { type: "reasoning_start" },
      { type: "reasoning_delta", delta: "inspect " },
      { type: "reasoning_delta", delta: "the workspace" },
      { type: "reasoning_end" },
      { type: "text_delta", delta: "done" },
      { type: "finish", finishReason: "stop", usage: UNKNOWN_USAGE },
    ]);
  });

  it("streams text through one local OpenAI-compatible request", async () => {
    let requestCount = 0;
    let requestBody: unknown;
    const server = await startServer(async (request, response) => {
      requestCount += 1;
      requestBody = JSON.parse(await readBody(request));
      expect(request.headers.authorization).toBe("Bearer test-key");
      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "keep-alive",
      });
      writeChunk(response, "hello");
      writeChunk(response, " world");
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-test",
          created: 0,
          model: "test-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        })}\n\n`,
      );
      response.write("data: [DONE]\n\n");
      response.end();
    });
    const address = server.address() as AddressInfo;
    const modelStream = createOpenAICompatibleModelStream({
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      modelId: "test-model",
      apiKey: "test-key",
    });

    const modelEvents = await collect(
      modelStream(
        {
          systemPrompt: "system rules",
          messages: [{ role: "user", content: "hello" }],
          tools: FIXED_TOOL_DEFINITIONS,
          maxOutputTokens: 123,
        },
        new AbortController().signal,
      ),
    );

    expect(modelEvents).toEqual([
      { type: "text_delta", delta: "hello" },
      { type: "text_delta", delta: " world" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { ...UNKNOWN_USAGE, inputTokens: 3, outputTokens: 2 },
      },
    ]);
    expect(requestCount).toBe(1);
    expect(requestBody).toMatchObject({
      model: "test-model",
      messages: [
        { role: "system", content: "system rules" },
        { role: "user", content: "hello" },
      ],
      stream: true,
      max_tokens: 123,
      stream_options: { include_usage: true },
      tools: expect.arrayContaining([
        expect.objectContaining({ function: expect.objectContaining({ name: "read_file" }) }),
      ]),
    });
  });

  it("sends independent configured reasoning efforts and bounded budgets by request purpose", async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const server = await startServer(async (request, response) => {
      requestBodies.push(JSON.parse(await readBody(request)) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "text/event-stream" });
      writeChunk(response, "done");
      response.write(
        `data: ${JSON.stringify({ id: "purpose", created: 0, model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
    const address = server.address() as AddressInfo;
    const configResult = readModelConfig({
      ANTHIAS_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      ANTHIAS_MODEL_ID: "test-model",
      ANTHIAS_MODEL_API_KEY: "test-key",
      ANTHIAS_MODEL_CONTEXT_WINDOW: "128000",
      ANTHIAS_RESPONSE_REASONING_EFFORT: "high",
      ANTHIAS_APPROVAL_REASONING_EFFORT: "low",
    });
    if (!configResult.ok) throw new Error("expected valid configuration");
    const configuredStream = createOpenAICompatibleModelStream(configResult.config);
    const request = {
      systemPrompt: "rules",
      messages: [{ role: "user" as const, content: "inspect" }],
      tools: [],
    };
    for (const purpose of ["response", "approval", "compaction"] as const) {
      await collect(configuredStream({ ...request, purpose }, new AbortController().signal));
    }
    const unconfiguredStream = createOpenAICompatibleModelStream({
      baseURL: configResult.config.baseURL,
      modelId: "test-model",
      apiKey: "test-key",
      capabilities: { contextWindow: 128_000, maxOutputTokens: 4_000 },
    });
    for (const purpose of ["response", "approval"] as const) {
      await collect(unconfiguredStream({ ...request, purpose }, new AbortController().signal));
    }
    expect(
      requestBodies.map((body) => ({
        max_tokens: body.max_tokens,
        reasoning_effort: body.reasoning_effort,
      })),
    ).toEqual([
      { max_tokens: 64_000, reasoning_effort: "high" },
      { max_tokens: 2_000, reasoning_effort: "low" },
      { max_tokens: 8_000, reasoning_effort: undefined },
      { max_tokens: 4_000, reasoning_effort: undefined },
      { max_tokens: 2_000, reasoning_effort: undefined },
    ]);
    expect(requestBodies.slice(2).every((body) => !Object.hasOwn(body, "reasoning_effort"))).toBe(
      true,
    );
  });

  it.each([
    {
      code: "tool_result_mismatch",
      param: "messages[4].tool_call_id",
      expectedCode: "tool_result_mismatch",
      expectedParam: "messages[].tool_call_id",
    },
    {
      code: "missing_reasoning_content",
      param: "messages.2.reasoning_content",
      expectedCode: "missing_reasoning_content",
      expectedParam: "messages[].reasoning_content",
    },
    {
      code: "synthetic_secret_looks_like_code",
      param: "messages[2].synthetic_secret",
      expectedCode: null,
      expectedParam: null,
    },
    {
      code: "unknown_provider_error",
      param: "messages[2].tool_calls[0].function.arguments.synthetic_secret",
      expectedCode: null,
      expectedParam: null,
    },
  ])(
    "retains only approved HTTP error facts: $code",
    async ({ code, param, expectedCode, expectedParam }) => {
      const server = await startServer((_request, response) => {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { code, param, message: "synthetic_secret_provider_body" } }),
        );
      });
      const address = server.address() as AddressInfo;
      const modelStream = createOpenAICompatibleModelStream({
        baseURL: `http://127.0.0.1:${address.port}/v1`,
        modelId: "test-model",
        apiKey: "test-key",
      });
      const outcome = await collect(
        modelStream(
          {
            systemPrompt: "synthetic_secret_system",
            tools: FIXED_TOOL_DEFINITIONS,
            messages: [
              { role: "user", content: "synthetic_secret_user" },
              {
                role: "assistant",
                content: [
                  { type: "reasoning", text: "synthetic_secret_reasoning" },
                  {
                    type: "tool_call",
                    toolCallId: "synthetic_secret_paired",
                    toolName: "read_file",
                    input: { path: "synthetic_secret_path" },
                    invalid: false,
                  },
                ],
              },
              {
                role: "tool",
                toolCallId: "synthetic_secret_paired",
                toolName: "read_file",
                status: "completed",
                content: "synthetic_secret_result",
                truncated: false,
              },
              {
                role: "assistant",
                content: [
                  {
                    type: "tool_call",
                    toolCallId: "synthetic_secret_unpaired",
                    toolName: "read_file",
                    input: {},
                    invalid: false,
                  },
                ],
              },
              {
                role: "tool",
                toolCallId: "synthetic_secret_unpaired",
                toolName: "read_file",
                status: "completed",
                content: "synthetic_secret_late_result",
                truncated: false,
              },
            ],
          },
          new AbortController().signal,
        ),
      ).catch((error: unknown) => error);
      expect(outcome).toMatchObject({
        diagnostic: {
          category: "invalid_request",
          httpStatus: 400,
          providerErrorCode: expectedCode,
          providerErrorParam: expectedParam,
          requestSummary: {
            purpose: "response",
            maxOutputTokens: 64_000,
            messageCount: 6,
            toolDefinitionCount: FIXED_TOOL_DEFINITIONS.length,
            toolCallCount: 2,
            toolResultCount: 2,
            reasoningMessageCount: 1,
            unpairedToolCallCount: 0,
            unexpectedToolResultCount: 0,
          },
        },
      });
      expect(JSON.stringify(outcome)).not.toContain("synthetic_secret");
    },
  );

  it("does not retry a failed provider request", async () => {
    let requestCount = 0;
    const server = await startServer((_request, response) => {
      requestCount += 1;
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "temporary failure" } }));
    });
    const address = server.address() as AddressInfo;
    const modelStream = createOpenAICompatibleModelStream({
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      modelId: "test-model",
      apiKey: "test-key",
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(
        collect(
          modelStream(
            {
              systemPrompt: "system rules",
              messages: [{ role: "user", content: "fail once" }],
              tools: FIXED_TOOL_DEFINITIONS,
            },
            new AbortController().signal,
          ),
        ),
      ).rejects.toMatchObject({
        reason: "model_error",
        diagnostic: { category: "service", httpStatus: 500 },
      });
      expect(requestCount).toBe(1);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it.each([
    [400, "invalid_request"],
    [401, "authentication"],
    [404, "configuration"],
    [429, "rate_limit"],
    [503, "service"],
  ] as const)(
    "normalizes HTTP %s without retaining raw provider details",
    async (httpStatus, category) => {
      const server = await startServer((_request, response) => {
        response.writeHead(httpStatus, { "content-type": "application/json", "retry-after": "31" });
        response.end(
          JSON.stringify({
            error: { message: "fake-secret raw response https://user:password@example.invalid" },
          }),
        );
      });
      const address = server.address() as AddressInfo;
      const modelStream = createOpenAICompatibleModelStream({
        baseURL: `http://127.0.0.1:${address.port}/v1`,
        modelId: "test-model",
        apiKey: "test-key",
      });
      const error = await collect(
        modelStream(
          { systemPrompt: "test", messages: [{ role: "user", content: "inspect" }], tools: [] },
          new AbortController().signal,
        ),
      ).catch((error: unknown) => error);
      expect(error).toMatchObject({ diagnostic: { category, httpStatus } });
      if (category === "rate_limit" || category === "service")
        expect(error).toMatchObject({ retryAfterMs: 31_000 });
      expect(JSON.stringify(error)).not.toMatch(/fake-secret|password|raw response/);
    },
  );

  it("classifies a refused loopback connection as a temporary network failure", async () => {
    const server = await startServer((_request, response) => {
      response.end();
    });
    const address = server.address() as AddressInfo;
    await closeServer(server);
    servers.delete(server);
    const modelStream = createOpenAICompatibleModelStream({
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      modelId: "test-model",
      apiKey: "test-key",
    });
    await expect(
      collect(
        modelStream(
          { systemPrompt: "test", messages: [{ role: "user", content: "inspect" }], tools: [] },
          new AbortController().signal,
        ),
      ),
    ).rejects.toMatchObject({ diagnostic: { category: "network", httpStatus: null } });
  });

  it("preserves valid and invalid tool calls as Agent events without executing them", async () => {
    let requestCount = 0;
    const server = await startServer((_request, response) => {
      requestCount += 1;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "keep-alive",
      });
      writeToolCalls(response, [
        {
          toolCallId: "00000000-0000-4000-8000-000000000010",
          toolName: "read_file",
          input: '{"path":"README.md"}',
        },
        {
          toolCallId: "00000000-0000-4000-8000-000000000011",
          toolName: "unknown_tool",
          input: '{"value":1}',
        },
      ]);
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-tools",
          created: 0,
          model: "test-model",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        })}\n\n`,
      );
      response.write("data: [DONE]\n\n");
      response.end();
    });
    const address = server.address() as AddressInfo;
    const modelStream = createOpenAICompatibleModelStream({
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      modelId: "test-model",
      apiKey: "test-key",
    });

    const modelEvents = await collect(
      modelStream(
        {
          systemPrompt: "system rules",
          messages: [{ role: "user", content: "inspect" }],
          tools: FIXED_TOOL_DEFINITIONS,
        },
        new AbortController().signal,
      ),
    );

    expect(modelEvents).toEqual([
      {
        type: "tool_input_start",
        toolCallId: "00000000-0000-4000-8000-000000000010",
        toolName: "read_file",
      },
      {
        type: "tool_input_delta",
        toolCallId: "00000000-0000-4000-8000-000000000010",
        delta: '{"path":"README.md"}',
      },
      {
        type: "tool_input_start",
        toolCallId: "00000000-0000-4000-8000-000000000011",
        toolName: "unknown_tool",
      },
      {
        type: "tool_input_delta",
        toolCallId: "00000000-0000-4000-8000-000000000011",
        delta: '{"value":1}',
      },
      {
        type: "tool_call",
        toolCallId: "00000000-0000-4000-8000-000000000010",
        toolName: "read_file",
        input: { path: "README.md" },
        invalid: false,
      },
      {
        type: "tool_call",
        toolCallId: "00000000-0000-4000-8000-000000000011",
        toolName: "unknown_tool",
        input: { value: 1 },
        invalid: true,
      },
      {
        type: "finish",
        finishReason: "tool_calls",
        usage: UNKNOWN_USAGE,
      },
    ]);
    expect(requestCount).toBe(1);
  });

  it("forwards cancellation to the single in-flight HTTP request", async () => {
    let requestCount = 0;
    let connectionClosed = false;
    const server = await startServer((_request, response) => {
      requestCount += 1;
      response.once("close", () => {
        connectionClosed = true;
      });
      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "keep-alive",
      });
      writeChunk(response, "partial");
    });
    const address = server.address() as AddressInfo;
    const modelStream = createOpenAICompatibleModelStream({
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      modelId: "test-model",
      apiKey: "test-key",
    });
    const abortController = new AbortController();
    const modelIterator = modelStream(
      {
        systemPrompt: "system rules",
        messages: [{ role: "user", content: "cancel" }],
        tools: FIXED_TOOL_DEFINITIONS,
      },
      abortController.signal,
    )[Symbol.asyncIterator]();

    await expect(modelIterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "text_delta", delta: "partial" },
    });
    abortController.abort();
    await modelIterator.next().catch(() => undefined);

    await vi.waitFor(() => expect(connectionClosed).toBe(true));
    expect(requestCount).toBe(1);
  });

  it("drives a complete read-edit-command loop through the production adapter", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-production-loop-"));
    temporaryDirectories.add(workspaceRoot);
    await writeFile(join(workspaceRoot, "target.txt"), "old\n", "utf8");
    vi.stubEnv("ANTHIAS_MODEL_API_KEY", "stage3-fake-process-key");
    const shell = await resolveSessionShell(process.env);
    const command =
      shell.kind === "powershell"
        ? "$present=[bool]$env:ANTHIAS_MODEL_API_KEY; Write-Output \"key=$present\"; if ((Get-Content -Raw -LiteralPath 'target.txt') -notmatch '^new') { exit 7 }; Write-Output 'verified'"
        : `present=\${ANTHIAS_MODEL_API_KEY:+true}; printf 'key=%s\\n' "\${present:-false}"; grep '^new' target.txt >/dev/null && printf 'verified\\n'`;
    const requestBodies: Record<string, unknown>[] = [];
    const server = await startServer(async (request, response) => {
      expect(request.headers.authorization).toBe("Bearer stage3-provider-key");
      requestBodies.push(JSON.parse(await readBody(request)) as Record<string, unknown>);
      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "keep-alive",
      });
      if (requestBodies.length === 1) {
        writeReasoningChunk(response, "same-run-reasoning-marker");
        writeToolCalls(response, [
          {
            toolCallId: "00000000-0000-4000-8000-000000000101",
            toolName: "read_file",
            input: '{"path":"target.txt"}',
          },
          {
            toolCallId: "00000000-0000-4000-8000-000000000102",
            toolName: "edit_file",
            input: '{"path":"target.txt","replacements":[{"oldText":"old","newText":"new"}]}',
          },
          {
            toolCallId: "00000000-0000-4000-8000-000000000103",
            toolName: "execute_command",
            input: JSON.stringify({ command, timeoutMs: 10_000 }),
          },
        ]);
        writeFinish(response, "tool_calls");
      } else {
        writeChunk(response, "读取、修改和验证完成。");
        writeFinish(response, "stop");
      }
      response.write("data: [DONE]\n\n");
      response.end();
    });
    const address = server.address() as AddressInfo;
    const sessionDirectory = resolveSessionDirectory(workspaceRoot, {});
    const session = await createSession({ workspaceRoot, sessionDirectory, shell });
    const agent = createAgentWithModelStream({
      session,
      modelStream: createOpenAICompatibleModelStream({
        baseURL: `http://127.0.0.1:${address.port}/v1`,
        modelId: "stage3-test-model",
        apiKey: "stage3-provider-key",
      }),
    });
    const events: AgentEvent[] = [];
    const approvalTargets: string[] = [];
    agent.subscribe((event) => {
      events.push(event);
      if (event.type === "tool_approval_requested") {
        approvalTargets.push(event.request.target);
        agent.respondToToolApproval(event.request.toolApprovalRequestId, "approve");
      }
    });

    try {
      await expect(agent.prompt("把 target.txt 更新为 new 并验证")).resolves.toEqual({
        status: "completed",
      });
      await expect(agent.prompt("说明已经完成的验证")).resolves.toEqual({ status: "completed" });
    } finally {
      await agent.close();
      await closeServer(server);
      servers.delete(server);
    }

    expect(server.listening).toBe(false);
    expect(requestBodies).toHaveLength(3);
    expect(JSON.stringify(requestBodies[2])).not.toContain("same-run-reasoning-marker");
    expect(JSON.stringify(agent.state)).not.toContain("same-run-reasoning-marker");
    expect(requestBodies[1]).toMatchObject({
      messages: [
        { role: "system" },
        { role: "user", content: expect.stringContaining("类别：environment") },
        { role: "user", content: expect.stringContaining("类别：skill_directory") },
        { role: "user", content: expect.stringContaining("类别：memory_index") },
        { role: "user", content: "把 target.txt 更新为 new 并验证" },
        {
          role: "assistant",
          reasoning_content: "same-run-reasoning-marker",
          tool_calls: [
            { id: "00000000-0000-4000-8000-000000000101" },
            { id: "00000000-0000-4000-8000-000000000102" },
            { id: "00000000-0000-4000-8000-000000000103" },
          ],
        },
        { role: "tool", tool_call_id: "00000000-0000-4000-8000-000000000101" },
        { role: "tool", tool_call_id: "00000000-0000-4000-8000-000000000102" },
        { role: "tool", tool_call_id: "00000000-0000-4000-8000-000000000103" },
      ],
    });
    expect(approvalTargets).toEqual(["target.txt", "."]);
    expect(await readFile(join(workspaceRoot, "target.txt"), "utf8")).toBe("new\n");
    expect(
      agent.state.messageHistory
        .filter((message) => message.role === "tool")
        .map((message) => [message.toolName, message.status]),
    ).toEqual([
      ["read_file", "completed"],
      ["edit_file", "completed"],
      ["execute_command", "completed"],
    ]);
    expect(JSON.stringify({ events, state: agent.state, requestBodies })).not.toContain(
      "stage3-fake-process-key",
    );
    expect(JSON.stringify(agent.state)).toMatch(/key=(False|false)/u);
    expect(events.at(-1)).toMatchObject({
      type: "run_end",
      result: { status: "completed" },
    });
    const sessionRecords = (await readFile(join(session.storageDirectory, "session.jsonl"), "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(sessionRecords.at(-1)).toMatchObject({
      type: "run_finished",
      status: "completed",
    });
    expect(JSON.stringify(sessionRecords)).not.toContain("stage3-fake-process-key");
    await expect(
      access(join(sessionDirectory, ".maintenance", "sessions", session.sessionId, "write.lock")),
    ).rejects.toThrow();
    expect((await readdir(workspaceRoot)).some((name) => name.startsWith(".anthias-"))).toBe(false);
  });

  it.each([
    {
      name: "reasoning as part of total output",
      providerUsage: {
        prompt_tokens: 12,
        completion_tokens: 20,
        completion_tokens_details: { reasoning_tokens: 15 },
      },
      expectedUsage: {
        inputTokens: 12,
        outputTokens: 20,
        reasoningTokens: 15,
        cachedInputTokens: null,
        cacheWriteInputTokens: null,
      },
    },
    {
      name: "known zero reasoning",
      providerUsage: { completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 0 } },
      expectedUsage: {
        inputTokens: null,
        outputTokens: 2,
        reasoningTokens: 0,
        cachedInputTokens: null,
        cacheWriteInputTokens: null,
      },
    },
    {
      name: "standard cached input as part of total input",
      providerUsage: {
        prompt_tokens: 12,
        completion_tokens: 4,
        prompt_tokens_details: { cached_tokens: 10 },
      },
      expectedUsage: {
        inputTokens: 12,
        outputTokens: 4,
        cachedInputTokens: 10,
        cacheWriteInputTokens: null,
      },
    },
    {
      name: "compatible cache counters without synthesizing missing output",
      providerUsage: {
        prompt_tokens: 10,
        prompt_cache_hit_tokens: 7,
        cache_creation_input_tokens: 2,
      },
      expectedUsage: {
        inputTokens: 10,
        outputTokens: null,
        cachedInputTokens: 7,
        cacheWriteInputTokens: 2,
      },
    },
    {
      name: "a known zero output with unknown input and cache",
      providerUsage: { completion_tokens: 0 },
      expectedUsage: {
        inputTokens: null,
        outputTokens: 0,
        cachedInputTokens: null,
        cacheWriteInputTokens: null,
      },
    },
    {
      name: "explicit zero counters",
      providerUsage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        prompt_tokens_details: { cached_tokens: 0 },
      },
      expectedUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: null,
      },
    },
  ])("normalizes $name from raw step usage", async ({ providerUsage, expectedUsage }) => {
    let requestBody: unknown;
    const server = await startServer(async (request, response) => {
      requestBody = JSON.parse(await readBody(request));
      response.writeHead(200, { "content-type": "text/event-stream" });
      writeChunk(response, "done");
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-usage",
          created: 0,
          model: "test-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: providerUsage,
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
    const address = server.address() as AddressInfo;
    const modelStream = createOpenAICompatibleModelStream({
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      modelId: "test-model",
      apiKey: "test-key",
    });
    const modelEvents = await collect(
      modelStream(
        {
          systemPrompt: "rules",
          messages: [{ role: "user", content: "count" }],
          tools: [],
        },
        new AbortController().signal,
      ),
    );
    expect(modelEvents.at(-1)).toEqual({
      type: "finish",
      finishReason: "stop",
      usage: { reasoningTokens: null, ...expectedUsage },
    });
    expect(requestBody).toMatchObject({
      max_tokens: 64_000,
      stream_options: { include_usage: true },
    });
  });

  it.each([
    { code: "context_length_exceeded", message: "sensitive provider detail" },
    {
      code: "invalid_request_error",
      message: "This model's maximum context length was exceeded: sensitive detail",
    },
  ])(
    "classifies a context overflow without exposing Provider text: $code",
    async (providerError) => {
      const server = await startServer((_request, response) => {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: providerError }));
      });
      const address = server.address() as AddressInfo;
      const modelStream = createOpenAICompatibleModelStream({
        baseURL: `http://127.0.0.1:${address.port}/v1`,
        modelId: "test-model",
        apiKey: "test-key",
      });
      const outcome = await collect(
        modelStream(
          {
            systemPrompt: "rules",
            messages: [{ role: "user", content: "overflow" }],
            tools: [],
          },
          new AbortController().signal,
        ),
      ).catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(ModelRequestError);
      expect(outcome).toMatchObject({
        reason: "context_overflow",
        diagnostic: { category: "context_overflow", httpStatus: 400 },
      });
      expect(String(outcome)).not.toContain("sensitive");
    },
  );
});

/** 启动只监听 loopback 随机端口的测试服务。 */
async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<ReturnType<typeof createServer>> {
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

/** 等待测试 HTTP 服务关闭及其连接完成收口。 */
function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** 读取一条测试 HTTP 请求的完整 UTF-8 body。 */
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const bodyChunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => bodyChunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(bodyChunks).toString("utf8")));
    request.on("error", reject);
  });
}

/** 写入一个 OpenAI-compatible 文本增量。 */
function writeChunk(response: ServerResponse, content: string): void {
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      created: 0,
      model: "test-model",
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })}\n\n`,
  );
}

function writeReasoningChunk(response: ServerResponse, content: string): void {
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-reasoning",
      created: 0,
      model: "test-model",
      choices: [{ index: 0, delta: { reasoning_content: content }, finish_reason: null }],
    })}\n\n`,
  );
}

/** 写入一个包含 finish reason 的终止增量。 */
function writeFinish(response: ServerResponse, finishReason: "stop" | "tool_calls"): void {
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-finish",
      created: 0,
      model: "stage3-test-model",
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    })}\n\n`,
  );
}

/** 写入一组 OpenAI-compatible ToolCall 增量。 */
function writeToolCalls(
  response: ServerResponse,
  toolCalls: readonly Readonly<{
    toolCallId: string;
    toolName: string;
    input: string;
  }>[],
): void {
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-tools",
      created: 0,
      model: "test-model",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: toolCalls.map((toolCall, index) => ({
              index,
              id: toolCall.toolCallId,
              type: "function",
              function: { name: toolCall.toolName, arguments: toolCall.input },
            })),
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
}

/** 收集有限测试流中的全部事件。 */
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

const UNKNOWN_USAGE = Object.freeze({
  reasoningTokens: null,
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  cacheWriteInputTokens: null,
});
