import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAICompatibleModelStream } from "../src/openai-compatible-model.js";
import { FIXED_TOOL_DEFINITIONS } from "../src/tools.js";

const servers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  await Promise.all([...servers].map((server) => closeServer(server)));
  servers.clear();
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
});

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

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const bodyChunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => bodyChunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(bodyChunks).toString("utf8")));
    request.on("error", reject);
  });
}

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

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}
