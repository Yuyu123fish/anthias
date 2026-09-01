import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAICompatibleModelStream } from "../src/openai-compatible-model.js";

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

    const textChunks: string[] = [];
    for await (const chunk of modelStream(
      [{ role: "user", content: "hello" }],
      new AbortController().signal,
    )) {
      textChunks.push(chunk);
    }

    expect(textChunks).toEqual(["hello", " world"]);
    expect(requestCount).toBe(1);
    expect(requestBody).toMatchObject({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
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
          modelStream([{ role: "user", content: "fail once" }], new AbortController().signal),
        ),
      ).rejects.toBeDefined();
      expect(requestCount).toBe(1);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
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

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const textChunks: string[] = [];
  for await (const chunk of stream) {
    textChunks.push(chunk);
  }
  return textChunks;
}
