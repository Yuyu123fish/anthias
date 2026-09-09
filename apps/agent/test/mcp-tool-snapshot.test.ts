import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ContextSources } from "../src/context/sources.js";
import { createExternalCapabilities } from "../src/external-capabilities.js";
import type { McpConnections, McpToolInfo } from "../src/mcp/index.js";
import type { AssistantToolCallPart } from "../src/message.js";
import type { ModelRequest } from "../src/model/model-stream.js";
import { createToolRunnerFromTools } from "../src/tool/tool-runner.js";

function fixture(toolCount = 1) {
  let generation = 1;
  let tools: McpToolInfo[] = Array.from({ length: toolCount }, (_, index) => ({
    name: "mcp_" + String(index).padStart(3, "0"),
    serverId: "fixture",
    originalName: "tool_" + index,
    description: "test",
    inputSchema: { type: "object" },
    generation,
  }));
  let calls = 0;
  const validGeneration = (version: number) =>
    version === generation
      ? ({ ok: true, value: undefined } as const)
      : ({ ok: false, error: "MCP 工具或连接版本已失效。" } as const);
  const unavailable = async () => ({ ok: false, error: "unused" }) as const;
  const mcp: McpConnections = {
    list: () => [
      {
        id: "fixture",
        name: "fixture",
        source: "test",
        transport: "stdio",
        state: "connected",
        generation,
        error: null,
        protocolVersion: null,
      },
    ],
    tools: () => tools,
    connect: unavailable,
    disconnect: unavailable,
    inspect: unavailable,
    validateToolCall: (_name, _input, version) => validGeneration(version),
    callTool: async (_name, _input, version) => {
      const valid = validGeneration(version);
      if (!valid.ok) return valid;
      calls++;
      return {
        ok: true,
        value: {
          text: "executed",
          isError: false,
          truncated: false,
          sourceTruncated: false,
          unsupportedContent: false,
        },
      };
    },
    readResource: unavailable,
    getPrompt: unavailable,
    close: async () => undefined,
  };
  const sources: ContextSources = {
    active: new Map(),
    save: async () => undefined,
    prepare: async () => undefined,
    adoptMemory: async () => undefined,
    safeRecords: () => [],
    filterMessages: (messages) => messages,
    markRequest: () => undefined,
    checkExecution: async () => undefined,
  };
  return {
    external: createExternalCapabilities({ sources, mcp, skills: undefined }),
    calls: () => calls,
    reconnect() {
      generation++;
      for (const tool of tools) tool.generation = generation;
    },
    onlyTool(name: string) {
      tools = tools.filter((tool) => tool.name === name);
    },
  };
}

const request: ModelRequest = { messages: [], tools: [], systemPrompt: "" };
function toolCall(name: string): AssistantToolCallPart {
  return { type: "tool_call", toolCallId: randomUUID(), toolName: name, input: {}, invalid: false };
}

describe("MCP request snapshot", () => {
  it("keeps one request executable after another projection and rejects a later connection generation", async () => {
    const { external, reconnect, calls } = fixture();
    const first = external.prepareRequest(request, "agent");
    const other = external.prepareRequest(request, "plan");
    expect(other.request.tools.some((tool) => tool.name === "mcp_000")).toBe(false);
    expect(external.rejectUnavailableTool(toolCall("mcp_000"), "agent")).toBeNull();
    const planned = createToolRunnerFromTools(first.tools).createPlan(toolCall("mcp_000"), "agent");
    const preparation = await planned?.prepare();
    if (!preparation?.ok) throw new Error("expected first snapshot to remain available");
    expect(preparation.preparedExecution.approval?.executionBoundary).toContain("版本 1");
    expect(
      await preparation.preparedExecution.execute(new AbortController().signal, () => undefined),
    ).toMatchObject({ status: "completed" });
    expect(calls()).toBe(1);

    reconnect();
    const reconnected = external.prepareRequest(request, "agent");
    expect(reconnected.mcpSnapshot.tools[0]?.generation).toBe(2);
    expect(first.mcpSnapshot.tools[0]?.generation).toBe(1);
    expect(
      await preparation.preparedExecution.execute(new AbortController().signal, () => undefined),
    ).toMatchObject({ status: "failed", content: expect.stringContaining("失效") });
    expect(
      await createToolRunnerFromTools(first.tools)
        .createPlan(toolCall("mcp_000"), "agent")
        ?.prepare(),
    ).toMatchObject({ ok: false, result: { content: expect.stringContaining("失效") } });
    expect(
      await createToolRunnerFromTools(reconnected.tools)
        .createPlan(toolCall("mcp_000"), "plan")
        ?.prepare(),
    ).toMatchObject({ ok: false, result: { status: "denied" } });
    expect(calls()).toBe(1);
  });

  it("keeps a budget omission attached to its request after the same tool becomes visible elsewhere", async () => {
    const { external, onlyTool } = fixture(65);
    const crowded = external.prepareRequest(request, "agent");
    expect(crowded.mcpSnapshot.omittedToolCount).toBe(2);
    expect(crowded.request.tools).toHaveLength(64);
    expect(crowded.request.tools.some((tool) => tool.name === "mcp_064")).toBe(false);

    onlyTool("mcp_064");
    const later = external.prepareRequest(request, "agent");
    expect(later.request.tools.some((tool) => tool.name === "mcp_064")).toBe(true);
    expect(
      await external
        .rejectUnavailableTool(toolCall("mcp_064"), "agent", crowded.mcpSnapshot)
        ?.prepare(),
    ).toMatchObject({ ok: false, result: { content: expect.stringContaining("预算") } });
    expect(
      await createToolRunnerFromTools(later.tools)
        .createPlan(toolCall("mcp_064"), "agent")
        ?.prepare(),
    ).toMatchObject({ ok: true });
  });
});
