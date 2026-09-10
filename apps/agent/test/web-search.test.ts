import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentEvent, createAgentWithModelStream } from "../src/agent.js";
import type { AssistantToolCallPart, JsonValue } from "../src/message.js";
import type { ModelRequest, ModelStream } from "../src/model/model-stream.js";
import { createSession } from "../src/session/index.js";
import type { AgentToolExtension } from "../src/tool/managed-tool.js";
import { createToolRunnerFromTools } from "../src/tool/tool-runner.js";
import { createWebSearchTools } from "../src/tool/web-search.js";
import { promptToCompletion } from "./prompt-helper.js";

const syntheticKey = "synthetic-searchapi-key-49281";
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("web_search", () => {
  it("uses one fixed Google endpoint with a Bearer header and explicit pagination", async () => {
    const fixture = await httpFixture((_request, response) =>
      response.end(
        JSON.stringify({
          search_metadata: { status: "Success", html_url: `https://example.com/${syntheticKey}` },
          organic_results: [
            {
              title: "Node reference",
              link: "https://nodejs.org/api/",
              snippet: "Current public reference",
              source: "Node.js",
            },
          ],
          pagination: { current: 3, next: "https://www.google.com/search?start=30" },
        }),
      ),
    );
    const extension = createWebSearchTools({ apiKey: syntheticKey, fetch: fixture.fetch });
    expect(extension.tools("plan").map((tool) => tool.definition.name)).toEqual(["web_search"]);
    const plan = createToolRunnerFromTools(extension.tools("plan")).createPlan(
      searchCall({ query: "Node API", page: 3 }),
      "plan",
    );
    expect(plan?.scheduling).toBe("parallel");
    const result = await execute(extension, { query: "Node API", page: 3 });
    expect(result.status).toBe("completed");
    expect(JSON.parse(result.content)).toMatchObject({
      provider: "SearchAPI Google",
      page: 3,
      hasNextPage: true,
      contentKind: "untrusted_search_snippets",
      results: [
        {
          title: "Node reference",
          url: "https://nodejs.org/api/",
          snippet: "Current public reference",
          source: "Node.js",
        },
      ],
    });
    expect(result.content).toContain("尚未读取网页全文");
    expect(result.content).not.toContain(syntheticKey);
    expect(fixture.requests).toEqual([
      {
        url: "https://www.searchapi.io/api/v1/search?engine=google&q=Node+API&page=3",
        authorization: `Bearer ${syntheticKey}`,
        redirect: "error",
      },
    ]);
  });

  it("keeps no results normal and never follows pagination automatically", async () => {
    const fixture = await httpFixture((_request, response) =>
      response.end(JSON.stringify({ organic_results: [], pagination: { current: 1 } })),
    );
    const result = await execute(
      createWebSearchTools({ apiKey: syntheticKey, fetch: fixture.fetch }),
      { query: "no results" },
    );
    expect(result.status).toBe("completed");
    expect(JSON.parse(result.content)).toMatchObject({ page: 1, hasNextPage: false, results: [] });
    expect(fixture.requests).toHaveLength(1);
  });

  it("rejects unavailable configuration and invalid inputs before sending a request", async () => {
    let requests = 0;
    const fetch: typeof globalThis.fetch = async () => {
      requests += 1;
      throw new Error("unexpected request");
    };
    for (const apiKey of [undefined, "", "bad\nheader"]) {
      const result = await execute(createWebSearchTools({ apiKey, fetch }), {
        query: "public documentation",
      });
      expect(result.status).toBe("failed");
      expect(result.content).toContain("SEARCHAPI_API_KEY");
    }
    const extension = createWebSearchTools({ apiKey: syntheticKey, fetch });
    for (const input of [
      { query: " " },
      { query: "x".repeat(2001) },
      { query: "x", page: 0 },
      { query: "x", page: 1.5 },
      { query: "x", url: "https://untrusted.example" },
      { query: syntheticKey },
    ]) {
      expect((await execute(extension, input)).status).toBe("failed");
    }
    expect(requests).toBe(0);
  });

  it.each([
    [401, "凭据"],
    [403, "凭据"],
    [402, "配额"],
    [429, "限流"],
    [503, "暂时不可用"],
    [504, "超时"],
  ])("returns a safe failure for HTTP %s", async (status, expected) => {
    const fixture = await httpFixture((_request, response) =>
      response.writeHead(Number(status)).end(`provider internal error ${syntheticKey}`),
    );
    const result = await execute(
      createWebSearchTools({ apiKey: syntheticKey, fetch: fixture.fetch }),
      { query: "reference" },
    );
    expect(result.status).toBe("failed");
    expect(result.content).toContain(String(expected));
    expect(result.content).not.toContain(syntheticKey);
    expect(result.content).not.toContain("provider internal");
  });

  it("bounds response bytes and returned fields while removing credential echoes and unsafe URLs", async () => {
    let body = JSON.stringify({
      organic_results: Array.from({ length: 30 }, (_, index) => ({
        title: `result ${index} ${syntheticKey}`,
        link: `https://example.com/${index}`,
        snippet: "资料".repeat(3000),
      })),
    });
    const fixture = await httpFixture((_request, response) => response.end(body));
    const extension = createWebSearchTools({ apiKey: syntheticKey, fetch: fixture.fetch });
    const bounded = await execute(extension, { query: "reference" });
    expect(bounded.status).toBe("completed");
    expect(bounded.truncated).toBe(true);
    expect(Buffer.byteLength(bounded.content, "utf8")).toBeLessThanOrEqual(60 * 1024);
    expect(JSON.parse(bounded.content).results.length).toBeLessThanOrEqual(20);
    expect(bounded.content).not.toContain(syntheticKey);
    body = JSON.stringify({
      organic_results: [
        { title: "unsafe", link: "javascript:alert(1)" },
        { title: "key in URL", link: `https://example.com/?api_key=${syntheticKey}` },
      ],
    });
    expect(JSON.parse((await execute(extension, { query: "reference" })).content).results).toEqual(
      [],
    );
    body = JSON.stringify({ extra: "x".repeat(1024 * 1024 + 1) });
    expect((await execute(extension, { query: "reference" })).content).toContain("1 MiB");
    body = "invalid-json-with-provider-details";
    expect((await execute(extension, { query: "reference" })).content).toContain("格式无效");
  });

  it("cancels slow response bodies and distinguishes timeout from user cancellation", async () => {
    const started = Promise.withResolvers<void>();
    const fixture = await httpFixture((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"organic_results":[');
      started.resolve();
    });
    const controller = new AbortController();
    const pendingResult = execute(
      createWebSearchTools({ apiKey: syntheticKey, fetch: fixture.fetch }),
      { query: "slow query" },
      controller.signal,
    );
    await started.promise;
    controller.abort();
    expect((await pendingResult).content).toContain("已取消");
    const timedOut = await execute(
      createWebSearchTools({ apiKey: syntheticKey, fetch: fixture.fetch, timeoutMs: 40 }),
      { query: "slow query" },
    );
    expect(timedOut.content).toContain("超时");
    expect(fixture.requests).toHaveLength(2);
    const networkError = await execute(
      createWebSearchTools({
        apiKey: syntheticKey,
        fetch: async () => {
          throw new Error(syntheticKey);
        },
      }),
      { query: "reference" },
    );
    expect(networkError.content).toContain("网络请求失败");
    expect(networkError.content).not.toContain(syntheticKey);
  });

  it("records search progress and sourced facts through Agent without persisting credentials", async () => {
    const fixture = await httpFixture((_request, response) =>
      response.end(
        JSON.stringify({
          organic_results: [
            {
              title: `Reference ${syntheticKey}`,
              link: "https://example.com/reference",
              snippet: "Public summary",
            },
          ],
        }),
      ),
    );
    const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-search-loop-"));
    cleanups.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const session = await createSession({
      workspaceRoot,
      sessionDirectory: join(workspaceRoot, "sessions"),
      shell: { kind: "powershell", executable: "pwsh.exe", arguments: ["-Command"] },
    });
    const requests: ModelRequest[] = [];
    const modelStream: ModelStream = async function* (request) {
      requests.push(request);
      if (requests.length === 1) {
        yield searchCall({ query: "public reference" });
        yield { type: "finish", finishReason: "tool_calls" };
      } else {
        yield { type: "text_delta", delta: "检查完成。" };
        yield { type: "finish", finishReason: "stop" };
      }
    };
    const agent = createAgentWithModelStream({
      modelStream,
      session,
      permissionMode: "plan",
      managedTools: createWebSearchTools({ apiKey: syntheticKey, fetch: fixture.fetch }),
    });
    cleanups.push(() => agent.close());
    const events: AgentEvent[] = [];
    agent.subscribe((event) => events.push(event));
    expect(await promptToCompletion(agent, "查找公开参考资料")).toMatchObject({
      status: "completed",
    });
    expect(requests[0]?.tools.some((definition) => definition.name === "web_search")).toBe(true);
    expect(events.filter((event) => event.type === "tool_execution_start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool_execution_end")).toHaveLength(1);
    expect(JSON.stringify(requests[1]?.messages)).toContain("untrusted_search_snippets");
    expect(JSON.stringify(session.records)).toContain("https://example.com/reference");
    expect(JSON.stringify([requests, events, session.records])).not.toContain(syntheticKey);
  });
});

function searchCall(input: JsonValue): AssistantToolCallPart {
  return {
    type: "tool_call",
    toolCallId: "00000000-0000-4000-8000-000000000099",
    toolName: "web_search",
    input,
    invalid: false,
  };
}

async function execute(
  extension: AgentToolExtension,
  input: JsonValue,
  signal = new AbortController().signal,
) {
  const plan = createToolRunnerFromTools(extension.tools("plan")).createPlan(
    searchCall(input),
    "plan",
  );
  if (!plan) throw new Error("expected search plan");
  const preparation = await plan.prepare(signal);
  if (!preparation.ok) return preparation.result;
  expect(preparation.preparedExecution.approval).toBeNull();
  return preparation.preparedExecution.execute(signal, () => undefined);
}

async function httpFixture(reply: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(reply);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    const completion = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    server.closeAllConnections();
    await completion;
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected local fixture address");
  const requests: { url: string; authorization: string | null; redirect: string | undefined }[] =
    [];
  const request: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push({
      url: url.href,
      authorization: new Headers(init?.headers).get("Authorization"),
      redirect: init?.redirect,
    });
    return fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init);
  };
  return { fetch: request, requests };
}
