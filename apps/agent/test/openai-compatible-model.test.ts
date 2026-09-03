import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentEvent, createAgentWithModelStream } from "../src/agent.js";
import { createOpenAICompatibleModelStream } from "../src/openai-compatible-model.js";
import { createSession, resolveSessionDirectory, resolveSessionShell } from "../src/session.js";
import { FIXED_TOOL_DEFINITIONS } from "../src/tools.js";

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
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
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
      tools: expect.arrayContaining([
        expect.objectContaining({ function: expect.objectContaining({ name: "read_file" }) }),
      ]),
    });
  });

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
      ).rejects.toBeDefined();
      expect(requestCount).toBe(1);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
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
        usage: { inputTokens: null, outputTokens: null, totalTokens: null },
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
        writeFinish(response, "tool_calls", { prompt_tokens: 6, completion_tokens: 3 });
      } else {
        writeChunk(response, "读取、修改和验证完成。");
        writeFinish(response, "stop", { prompt_tokens: 8, completion_tokens: 4 });
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
    } finally {
      await closeServer(server);
      servers.delete(server);
    }

    expect(server.listening).toBe(false);
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[1]).toMatchObject({
      messages: [
        { role: "system" },
        { role: "user", content: "把 target.txt 更新为 new 并验证" },
        {
          role: "assistant",
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
      metrics: {
        modelRequestCount: 2,
        producedToolCallCount: 3,
        processedToolCallCount: 3,
      },
    });
    const sessionRecords = (
      await readFile(join(sessionDirectory, `${session.sessionId}.jsonl`), "utf8")
    )
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(sessionRecords.at(-1)).toMatchObject({
      type: "run_finished",
      status: "completed",
      modelRequestCount: 2,
      toolCallCount: 3,
      processedToolCallCount: 3,
      modelUsage: { inputTokens: 14, outputTokens: 7, totalTokens: 21 },
    });
    expect(JSON.stringify(sessionRecords)).not.toContain("stage3-fake-process-key");
    await expect(access(join(sessionDirectory, `${session.sessionId}.lock`))).rejects.toThrow();
    expect((await readdir(workspaceRoot)).some((name) => name.startsWith(".anthias-"))).toBe(false);
  });
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

/** 写入一个包含 finish reason 与标准 token usage 的终止增量。 */
function writeFinish(
  response: ServerResponse,
  finishReason: "stop" | "tool_calls",
  usage: Readonly<{ prompt_tokens: number; completion_tokens: number }>,
): void {
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-finish",
      created: 0,
      model: "stage3-test-model",
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
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
