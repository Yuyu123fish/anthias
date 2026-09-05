import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpConnections, type McpConnections, type McpToolInfo } from "../src/mcp/index.js";
import { replyToMcpRequest } from "./fixtures/mcp-server.js";

const cleanups: (() => Promise<void>)[] = [];
const serverFixturePath = fileURLToPath(new URL("./fixtures/mcp-server.ts", import.meta.url));
const syntheticSecret = "synthetic-mcp-secret-72941";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function configuration(
  servers: Record<string, unknown>,
  options: { source?: string; requestTimeoutMs?: number } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "anthias-mcp-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "mcp.json");
  await writeFile(path, JSON.stringify({ mcpServers: servers }));
  const connections = await createMcpConnections({
    workspaceRoot: directory,
    environment: { MCP_TEST_TOKEN: syntheticSecret },
    configFiles: [{ path, source: options.source ?? "test" }],
    requestTimeoutMs: options.requestTimeoutMs ?? 3000,
  });
  cleanups.push(() => connections.close());
  return connections;
}

function stdioServer(mode: "modern" | "legacy") {
  return {
    transport: "stdio",
    command: process.execPath,
    args: [serverFixturePath, mode],
    env: { MCP_FIXTURE_TOKEN: "MCP_TEST_TOKEN" },
  };
}

function toolNamed(connections: McpConnections, originalName: string): McpToolInfo {
  const tool = connections.tools().find((candidate) => candidate.originalName === originalName);
  expect(tool).toBeDefined();
  if (!tool) throw new Error("Missing fixture tool");
  return tool;
}

async function httpFixture(options: { repeatedCursor?: boolean } = {}) {
  const requests: {
    method: string;
    authorization: string | undefined;
    protocol: string | undefined;
  }[] = [];
  const toolCalls: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const message: unknown = JSON.parse(body);
    const method =
      typeof message === "object" && message !== null && "method" in message
        ? String(message.method)
        : "";
    requests.push({
      method,
      authorization: request.headers.authorization,
      protocol:
        typeof request.headers["mcp-protocol-version"] === "string"
          ? request.headers["mcp-protocol-version"]
          : undefined,
    });
    const reply = await replyToMcpRequest(message, {
      mode: "modern",
      secret: syntheticSecret,
      ...options,
      onToolCall: (name) => toolCalls.push(name),
    });
    if (reply)
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(reply));
    else response.writeHead(202).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  return { url: `http://127.0.0.1:${address.port}/mcp`, requests, toolCalls };
}

describe("MCP connections", () => {
  it("discovers configuration without starting a process and rejects ambiguous names", async () => {
    const directory = await mkdtemp(join(tmpdir(), "anthias-mcp-config-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const files = await Promise.all(
      ["user", "project"].map(async (source) => {
        const path = join(directory, `${source}.json`);
        await writeFile(
          path,
          JSON.stringify({ mcpServers: { same: { command: "definitely-not-an-executable" } } }),
        );
        return { path, source };
      }),
    );
    const connections = await createMcpConnections({
      workspaceRoot: directory,
      configFiles: files,
    });
    cleanups.push(() => connections.close());
    expect(connections.list().map((server) => server.state)).toEqual([
      "disconnected",
      "disconnected",
    ]);
    expect(connections.tools()).toEqual([]);
    expect(await connections.connect("same")).toMatchObject({
      ok: false,
      error: expect.stringContaining("歧义"),
    });
    expect(connections.list().map((server) => server.id)).toEqual(["user:same", "project:same"]);
  });

  it.each(["modern", "legacy"] as const)(
    "negotiates %s stdio, validates tools, and terminates its process",
    async (mode) => {
      const connections = await configuration({ fixture: stdioServer(mode) });
      const connected = await connections.connect("fixture");
      expect(connected).toMatchObject({
        ok: true,
        value: {
          state: "connected",
          protocolVersion: mode === "modern" ? "2026-07-28" : "2025-11-25",
        },
      });
      const echo = toolNamed(connections, "echo");
      expect(echo.name).toMatch(/^mcp_[a-f0-9]{24}_echo$/);
      expect(connections.validateToolCall(echo.name, { text: 9 }, echo.generation)).toMatchObject({
        ok: false,
      });
      expect(connections.validateToolCall(echo.name, { text: "hello" }, echo.generation)).toEqual({
        ok: true,
        value: undefined,
      });
      expect(await connections.callTool(echo.name, { text: 9 }, echo.generation)).toMatchObject({
        ok: false,
        error: expect.stringContaining("Schema"),
      });
      expect(
        await connections.callTool(echo.name, { text: "hello" }, echo.generation),
      ).toMatchObject({ ok: true, value: { text: "hello [REDACTED]", isError: false } });
      expect(connections.tools().some((tool) => tool.originalName === "invalid_schema")).toBe(
        false,
      );
      const pidTool = toolNamed(connections, "pid");
      const pidResult = await connections.callTool(pidTool.name, {}, pidTool.generation);
      expect(pidResult.ok).toBe(true);
      if (!pidResult.ok) throw new Error(pidResult.error);
      const pid = Number(pidResult.value.text);
      expect(() => process.kill(pid, 0)).not.toThrow();
      const wait = toolNamed(connections, "wait");
      const cancellation = new AbortController();
      const pendingWait = connections.callTool(wait.name, {}, wait.generation, cancellation.signal);
      await new Promise((resolve) => setTimeout(resolve, 30));
      cancellation.abort();
      expect(await pendingWait).toMatchObject({
        ok: false,
        error: expect.stringContaining("取消"),
      });
      const notification = toolNamed(connections, "notify_change");
      await connections.callTool(notification.name, {}, notification.generation);
      expect(connections.tools()).toEqual([]);
      expect(connections.list()[0]?.error).toContain("目录已变化");
      await connections.disconnect("fixture");
      expect(() => process.kill(pid, 0)).toThrow();
      expect(
        await connections.callTool(echo.name, { text: "stale" }, echo.generation),
      ).toMatchObject({ ok: false });
    },
  );

  it("uses Streamable HTTP with referenced headers and reads resources and prompts on demand", async () => {
    const fixture = await httpFixture();
    const connections = await configuration({
      fixture: {
        transport: "streamable-http",
        url: fixture.url,
        headers: { Authorization: "MCP_TEST_TOKEN" },
      },
    });
    expect(fixture.requests).toEqual([]);
    expect(await connections.connect("fixture")).toMatchObject({
      ok: true,
      value: { protocolVersion: "2026-07-28" },
    });
    expect(fixture.requests.map((request) => request.method)).not.toContain("resources/read");
    expect(fixture.requests.every((request) => request.authorization === syntheticSecret)).toBe(
      true,
    );
    expect(fixture.requests.some((request) => request.protocol === "2026-07-28")).toBe(true);
    expect(await connections.readResource("fixture", "fixture://guide")).toMatchObject({
      ok: true,
      value: { text: expect.stringContaining("[REDACTED]") },
    });
    expect(await connections.readResource("fixture", "fixture://image")).toMatchObject({
      ok: true,
      value: { unsupportedContent: true },
    });
    expect(await connections.readResource("fixture", "fixture://not-listed")).toMatchObject({
      ok: false,
    });
    expect(await connections.getPrompt("fixture", "review")).toMatchObject({ ok: false });
    expect(await connections.getPrompt("fixture", "review", { target: "app.ts" })).toMatchObject({
      ok: true,
      value: { text: expect.stringContaining("Review app.ts") },
    });
    const inputRequired = toolNamed(connections, "input_required");
    expect(
      await connections.callTool(inputRequired.name, {}, inputRequired.generation),
    ).toMatchObject({ ok: false });
    expect(fixture.toolCalls.filter((name) => name === "input_required")).toHaveLength(1);
    const failure = toolNamed(connections, "failure");
    expect(
      JSON.stringify(await connections.callTool(failure.name, {}, failure.generation)),
    ).not.toContain(syntheticSecret);
    expect(JSON.stringify(await connections.inspect("fixture"))).not.toContain(syntheticSecret);
  });

  it("invalidates prior approval versions after reconnect and preserves bounded output", async () => {
    const fixture = await httpFixture();
    const connections = await configuration({ fixture: { url: fixture.url } });
    expect((await connections.connect("fixture")).ok).toBe(true);
    const echo = toolNamed(connections, "echo");
    await connections.disconnect("fixture");
    expect((await connections.connect("fixture")).ok).toBe(true);
    expect(toolNamed(connections, "echo").name).toBe(echo.name);
    expect(await connections.callTool(echo.name, { text: "old" }, echo.generation)).toMatchObject({
      ok: false,
    });
    expect(fixture.toolCalls).not.toContain("echo");
    const large = toolNamed(connections, "large");
    const output = await connections.callTool(large.name, {}, large.generation);
    expect(output).toMatchObject({ ok: true, value: { truncated: true, sourceTruncated: true } });
    if (!output.ok) throw new Error(output.error);
    expect(Buffer.byteLength(output.value.originalText ?? "", "utf8")).toBeLessThanOrEqual(
      256 * 1024,
    );
    expect(output.value.originalText).not.toContain("�");
    const wrongOutput = toolNamed(connections, "wrong_output");
    expect(await connections.callTool(wrongOutput.name, {}, wrongOutput.generation)).toMatchObject({
      ok: false,
      error: expect.stringContaining("输出 Schema"),
    });
  });

  it("cancels requests without replay and allows disconnect after timeout", async () => {
    const fixture = await httpFixture();
    const connections = await configuration(
      { fixture: { url: fixture.url } },
      { requestTimeoutMs: 500 },
    );
    expect((await connections.connect("fixture")).ok).toBe(true);
    const wait = toolNamed(connections, "wait");
    const cancellation = new AbortController();
    const pendingCall = connections.callTool(wait.name, {}, wait.generation, cancellation.signal);
    await new Promise((resolve) => setTimeout(resolve, 30));
    cancellation.abort();
    expect(await pendingCall).toMatchObject({ ok: false, error: expect.stringContaining("取消") });
    expect(await connections.callTool(wait.name, {}, wait.generation)).toMatchObject({
      ok: false,
      error: expect.stringContaining("超时"),
    });
    expect(fixture.toolCalls.filter((name) => name === "wait")).toHaveLength(2);
    expect(await connections.disconnect("fixture")).toMatchObject({
      ok: true,
      value: { state: "disconnected" },
    });
  });

  it("bounds pagination and rejects invalid or missing credential references safely", async () => {
    const fixture = await httpFixture({ repeatedCursor: true });
    const connections = await configuration({
      looping: { url: fixture.url },
      invalid: { url: fixture.url, headers: { Authorization: "literal-secret-value!" } },
      missing: { url: fixture.url, headers: { Authorization: "MISSING_TEST_REFERENCE" } },
    });
    expect(await connections.connect("looping")).toMatchObject({ ok: false });
    expect(fixture.requests.filter((request) => request.method === "tools/list")).toHaveLength(2);
    expect(await connections.connect("invalid")).toMatchObject({ ok: false });
    expect(await connections.connect("missing")).toMatchObject({ ok: false });
    expect(JSON.stringify(connections.list())).not.toContain("literal-secret-value");
  });
});
