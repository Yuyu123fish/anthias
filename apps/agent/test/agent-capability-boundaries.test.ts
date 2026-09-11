import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Agent, type AgentEvent, createAgentWithModelStream } from "../src/agent.js";
import type { McpConnections } from "../src/mcp/index.js";
import type { ModelStream } from "../src/model/model-stream.js";
import { COMPACTION_SECTION_TITLES } from "../src/prompts/compaction-prompt.js";
import { createSession, type Session } from "../src/session/index.js";
import { createSkillLibrary } from "../src/skill/index.js";
import { promptToCompletion } from "./prompt-helper.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setupSession() {
  const root = await mkdtemp(join(tmpdir(), "anthias-capability-boundaries-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const session = await createSession({
    workspaceRoot: root,
    sessionDirectory: join(root, "data"),
    shell: { kind: "powershell", executable: "pwsh", arguments: ["-NoProfile", "-Command"] },
  });
  cleanups.push(() => session.close());
  return { root, session };
}

function own(agent: Agent): Agent {
  cleanups.push(() => agent.close());
  return agent;
}

async function seedHistory(agent: Agent) {
  expect((await promptToCompletion(agent, "第一轮原始输入")).status).toBe("completed");
  expect((await promptToCompletion(agent, "第二轮原始输入")).status).toBe("completed");
}

async function waitForAbort(signal: AbortSignal) {
  if (signal.aborted) return;
  await new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

const summary = COMPACTION_SECTION_TITLES.map((title) => `## ${title}\n已保留必要信息。`).join(
  "\n",
);
const historyContent = "需要保留的历史正文。".repeat(1500);
const success = <T>(value: T) => ({ ok: true as const, value });

describe("Agent capability failure boundaries", () => {
  it("cancels manual compaction and waits for its iterator before closing", async () => {
    for (const stop of ["abort", "close"] as const) {
      const { session } = await setupSession();
      const enteredCompaction = Promise.withResolvers<void>();
      let normalResponses = 0;
      let iteratorClosed = false;
      const modelStream: ModelStream = async function* (request, signal) {
        if (request.purpose === "compaction") {
          enteredCompaction.resolve();
          try {
            await waitForAbort(signal);
          } finally {
            iteratorClosed = true;
          }
          return;
        }
        normalResponses += 1;
        yield { type: "text_delta", delta: historyContent };
        yield { type: "finish", finishReason: "stop" };
      };
      const agent = own(createAgentWithModelStream({ session, modelStream }));
      await seedHistory(agent);
      const messageHistory = agent.state.messageHistory;
      const operations: string[] = [];
      agent.subscribe((event) => {
        if (event.type === "operation_changed") operations.push(event.operation ?? "idle");
      });
      const pendingCompaction = agent.compact();
      await enteredCompaction.promise;
      expect(agent.state.operation).toBe("compacting");
      if (stop === "abort") agent.abort();
      const closing = stop === "close" ? agent.close() : undefined;
      expect(await pendingCompaction).toMatchObject({
        ok: false,
        error: expect.stringContaining("取消"),
      });
      if (closing) await closing;
      expect(iteratorClosed).toBe(true);
      expect(agent.state.operation).toBeNull();
      expect(agent.state.messageHistory).toEqual(messageHistory);
      expect(normalResponses).toBe(2);
      expect(session.records.some((record) => record.type === "compaction")).toBe(false);
      expect(operations).toEqual(["compacting", "idle"]);
      await agent.close();
      expect(await promptToCompletion(agent, "关闭后不可运行")).toEqual({
        status: "rejected",
        reason: "closed",
      });
    }
  });

  it("registers an operation before a synchronous subscriber closes the Agent", async () => {
    const { session } = await setupSession();
    const order: string[] = [];
    let compactionRequests = 0;
    const agent = own(
      createAgentWithModelStream({
        session,
        modelStream: async function* (request) {
          if (request.purpose === "compaction") compactionRequests += 1;
          yield {
            type: "text_delta",
            delta: request.purpose === "compaction" ? summary : historyContent,
          };
          yield { type: "finish", finishReason: "stop" };
        },
      }),
    );
    await seedHistory(agent);
    const messageHistory = agent.state.messageHistory;
    let closing: Promise<void> | undefined;
    agent.subscribe((event) => {
      if (event.type !== "operation_changed") return;
      order.push(event.operation ?? "idle");
      if (event.operation === "compacting")
        closing = agent.close().then(() => {
          order.push("closed");
        });
    });
    expect(await agent.compact()).toMatchObject({ ok: false });
    expect(closing).toBeDefined();
    await closing;
    expect(order).toEqual(["compacting", "idle", "closed"]);
    expect(compactionRequests).toBe(0);
    expect(agent.state.messageHistory).toEqual(messageHistory);
    expect(agent.state.operation).toBeNull();
  });

  it("seals the session when persisting a manual compaction fails", async () => {
    const { session } = await setupSession();
    let compactionWrites = 0;
    let modelRequests = 0;
    const failingSession: Session = {
      ...session,
      get records() {
        return session.records;
      },
      async appendCompaction() {
        compactionWrites += 1;
        throw new Error("synthetic compaction write failure");
      },
    };
    const agent = own(
      createAgentWithModelStream({
        session: failingSession,
        modelStream: async function* (request) {
          modelRequests += 1;
          yield {
            type: "text_delta",
            delta: request.purpose === "compaction" ? summary : historyContent,
          };
          yield { type: "finish", finishReason: "stop" };
        },
      }),
    );
    await seedHistory(agent);
    const messageHistory = agent.state.messageHistory;
    expect(await agent.compact()).toMatchObject({ ok: false });
    expect(compactionWrites).toBe(1);
    expect(agent.state.operation).toBeNull();
    expect(agent.state.messageHistory).toEqual(messageHistory);
    expect((await promptToCompletion(agent, "写入失败后不要继续")).status).toBe("failed");
    expect(modelRequests).toBe(3);
    expect(agent.state.messageHistory).toEqual(messageHistory);
    expect(session.records.some((record) => record.type === "compaction")).toBe(false);
  });

  it("seals a Run after load_skill cannot persist its context source through the Session writer", async () => {
    const { root, session } = await setupSession();
    const directory = join(root, "skills", "sample");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "SKILL.md"),
      "---\nname: sample\ndescription: 本地失败边界测试\n---\nEXTERNAL_SKILL_INSTRUCTIONS",
    );
    const skills = await createSkillLibrary({
      workspaceRoot: root,
      directories: [{ path: join(root, "skills"), source: "test" }],
    });
    let sourceWrites = 0;
    let modelRequests = 0;
    const failingSession: Session = {
      ...session,
      get records() {
        return session.records;
      },
      async appendContextSource(runId, details) {
        if (details.kind !== "skill") return session.appendContextSource(runId, details);
        sourceWrites += 1;
        throw new Error("synthetic context source write failure");
      },
    };
    const events: AgentEvent[] = [];
    const agent = own(
      createAgentWithModelStream({
        session: failingSession,
        skills,
        modelStream: async function* () {
          modelRequests += 1;
          yield {
            type: "tool_call",
            toolCallId: randomUUID(),
            toolName: "load_skill",
            input: { id: "sample" },
            invalid: false,
          };
          yield { type: "finish", finishReason: "tool_calls" };
        },
      }),
    );
    agent.subscribe((event) => events.push(event));
    expect((await promptToCompletion(agent, "读取外部指令")).status).toBe("failed");
    expect(sourceWrites).toBe(1);
    expect(agent.state.running).toBe(false);
    expect(agent.state.activeRun).toBeNull();
    expect(events.filter((event) => event.type === "session_unavailable")).toHaveLength(1);
    expect(
      session.records.some((record) => record.type === "context_source" && record.kind === "skill"),
    ).toBe(false);
    const messageHistory = agent.state.messageHistory;
    const toolEvents = events.filter((event) => event.type === "tool_execution_start").length;
    expect((await promptToCompletion(agent, "不要再调用模型或工具")).status).toBe("failed");
    expect(modelRequests).toBe(1);
    expect(sourceWrites).toBe(1);
    expect(events.filter((event) => event.type === "tool_execution_start")).toHaveLength(
      toolEvents,
    );
    expect(agent.state.messageHistory).toEqual(messageHistory);
  });

  it("denies a forced MCP tool for a read-only agent without invoking it or asking for approval", async () => {
    const { session } = await setupSession();
    let called = 0;
    let approvals = 0;
    let modelRequests = 0;
    const tool = {
      name: "mcp_forced",
      originalName: "external-write",
      serverId: "test:server",
      description: "外部写入",
      generation: 1,
      inputSchema: { type: "object" },
    };
    const server = {
      id: "test:server",
      name: "server",
      source: "test",
      transport: "stdio" as const,
      state: "connected" as const,
      generation: 1,
      error: null,
      protocolVersion: "2026-07-28",
    };
    const content = {
      text: "must not execute",
      isError: false,
      truncated: false,
      sourceTruncated: false,
      unsupportedContent: false,
    };
    const mcp: McpConnections = {
      list: () => [server],
      tools: () => [tool],
      validateToolCall: () => success(undefined),
      connect: async () => success(server),
      disconnect: async () => success(server),
      inspect: async () =>
        success({ ...server, tools: [tool], resources: [], prompts: [], diagnostics: [] }),
      callTool: async () => {
        called += 1;
        return success(content);
      },
      readResource: async () => success(content),
      getPrompt: async () => success(content),
      close: async () => undefined,
    };
    const agent = own(
      createAgentWithModelStream({
        session,
        mcp,
        permissionMode: "full_access",
        writable: false,
        modelStream: async function* (request) {
          modelRequests += 1;
          expect(request.tools.some((definition) => definition.name === tool.name)).toBe(false);
          if (modelRequests === 1) {
            yield {
              type: "tool_call",
              toolCallId: randomUUID(),
              toolName: tool.name,
              input: {},
              invalid: false,
            };
            yield { type: "finish", finishReason: "tool_calls" };
          } else {
            yield { type: "text_delta", delta: "继续只读规划。" };
            yield { type: "finish", finishReason: "stop" };
          }
        },
      }),
    );
    agent.subscribe((event) => {
      if (event.type === "tool_approval_requested") {
        approvals += 1;
        agent.respondToToolApproval(event.request.toolApprovalRequestId, "deny");
      }
    });
    expect((await promptToCompletion(agent, "只进行规划")).status).toBe("completed");
    expect(called).toBe(0);
    expect(approvals).toBe(0);
    expect(modelRequests).toBe(2);
    expect(
      session.records
        .flatMap((entry) => (entry.type === "message" ? [entry.message] : []))
        .find((message) => message.role === "tool"),
    ).toMatchObject({
      status: "denied",
      toolName: tool.name,
    });
    expect(session.records.some((record) => record.type === "tool_execution_started")).toBe(false);
  });
});
