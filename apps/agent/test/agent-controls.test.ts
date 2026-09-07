import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Agent, createAgentWithModelStream } from "../src/agent.js";
import type { McpConnections, McpContent } from "../src/mcp/index.js";
import type { ModelRequest, ModelStream } from "../src/model/model-stream.js";
import { COMPACTION_SECTION_TITLES } from "../src/prompts/compaction-prompt.js";
import { createSession, type Session } from "../src/session/index.js";
import { createSkillLibrary } from "../src/skill/index.js";

const roots: string[] = [];
const agents: Agent[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "anthias-controls-"));
  roots.push(root);
  const session = await createSession({
    workspaceRoot: root,
    sessionDirectory: join(root, "data"),
    shell: { kind: "powershell", executable: "pwsh", arguments: ["-NoProfile", "-Command"] },
  });
  return { root, session };
}
const reply: ModelStream = async function* () {
  yield { type: "text_delta", delta: "完成" };
  yield { type: "finish", finishReason: "stop" };
};
function own(agent: Agent) {
  agents.push(agent);
  return agent;
}
const success = <T>(value: T) => ({ ok: true as const, value });

describe("Agent capability controls", () => {
  it("keeps one subscribed Agent across session switches and preserves the old session on failure", async () => {
    const { session } = await setup();
    const agent = own(createAgentWithModelStream({ session, modelStream: reply }));
    await agent.prompt("保留这条原始输入");
    const events: string[] = [];
    agent.subscribe((event) => events.push(event.type));
    expect((await agent.sessions.open("invalid-id")).ok).toBe(false);
    expect(agent.state.sessionId).toBe(session.sessionId);
    expect((await agent.sessions.create()).ok).toBe(true);
    expect(agent.state.messageHistory).toEqual([]);
    expect(agent.state.sessionId).not.toBe(session.sessionId);
    const list = await agent.sessions.list();
    expect(list.ok && list.value.some((item) => item.id === session.sessionId)).toBe(true);
    expect((await agent.sessions.open(session.sessionId)).ok).toBe(true);
    expect(agent.state.messageHistory[0]).toEqual({ role: "user", content: "保留这条原始输入" });
    expect(events.filter((type) => type === "session_changed")).toHaveLength(2);
  });

  it("rejects mutations during a Run and closes after cancellation", async () => {
    const { session } = await setup();
    const entered = Promise.withResolvers<void>();
    const agent = own(
      createAgentWithModelStream({
        session,
        modelStream: async function* (_request, signal) {
          entered.resolve();
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        },
      }),
    );
    const prompt = agent.prompt("等一下");
    await entered.promise;
    expect((await agent.sessions.create()).ok).toBe(false);
    expect((await agent.compact()).ok).toBe(false);
    expect((await agent.skills.activate(null)).ok).toBe(false);
    const completion = agent.close();
    expect(agent.close()).toBe(completion);
    await completion;
    expect((await prompt).status).toBe("aborted");
    expect(await agent.prompt("太晚了")).toEqual({ status: "rejected", reason: "closed" });
  });

  it("loads Skill instructions on demand as durable external facts and restores their saved version", async () => {
    const { session, root } = await setup();
    const directory = join(root, "skills", "sample");
    await mkdir(directory, { recursive: true });
    const file = join(directory, "SKILL.md");
    await writeFile(file, "---\nname: sample\ndescription: 测试指令\n---\nSAVED_SKILL_BODY");
    await writeFile(join(directory, "reference.md"), "SAVED_REFERENCE_BODY");
    const skills = await createSkillLibrary({
      workspaceRoot: root,
      directories: [{ path: join(root, "skills"), source: "test" }],
    });
    const requests: ModelRequest[] = [];
    const agent = own(
      createAgentWithModelStream({
        session,
        skills,
        modelStream: async function* (request) {
          requests.push(request);
          if (requests.length <= 2) {
            yield {
              type: "tool_call",
              toolCallId: randomUUID(),
              toolName: requests.length === 1 ? "load_skill" : "read_skill",
              input:
                requests.length === 1 ? { id: "sample" } : { id: "sample", path: "reference.md" },
              invalid: false,
            };
            yield { type: "finish", finishReason: "tool_calls" };
          } else if (
            request.messages.at(-1)?.role === "user" &&
            request.messages.at(-1)?.content === "继续"
          ) {
            yield {
              type: "tool_call",
              toolCallId: randomUUID(),
              toolName: "load_skill",
              input: { id: "sample" },
              invalid: false,
            };
            yield { type: "finish", finishReason: "tool_calls" };
          } else yield* reply(request, new AbortController().signal);
        },
      }),
    );
    expect((await agent.prompt("读这份说明")).status).toBe("completed");
    expect(requests[0]?.systemPrompt).not.toContain("SAVED_SKILL_BODY");
    expect(JSON.stringify(requests[1]?.messages)).toContain("SAVED_SKILL_BODY");
    expect(JSON.stringify(requests[2]?.messages)).toContain("SAVED_REFERENCE_BODY");
    expect(
      session.records.filter(
        (record) =>
          record.type === "context_source" &&
          (record.kind === "skill" || record.kind === "skill_reference"),
      ),
    ).toHaveLength(2);
    expect(session.messageHistory.filter((message) => message.role === "user")).toHaveLength(1);
    expect((await agent.skills.activate("sample")).ok).toBe(true);
    expect(
      session.records.filter(
        (record) =>
          record.type === "context_source" &&
          (record.kind === "skill" || record.kind === "skill_reference"),
      ),
    ).toHaveLength(2);
    await agent.sessions.create();
    expect(agent.skills.list()[0]?.active).toBe(false);
    await writeFile(file, "---\nname: sample\ndescription: 测试指令\n---\nCHANGED_BODY");
    await agent.sessions.open(session.sessionId);
    expect(agent.skills.list()[0]?.error).toContain("变化");
    await agent.prompt("继续");
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("SAVED_SKILL_BODY");
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain("CHANGED_BODY");
    expect(agent.skills.list()[0]?.error).toContain("变化");
    expect((await agent.skills.activate(null)).ok).toBe(true);
    await agent.prompt("清除后");
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("该来源已撤销");
    expect(agent.skills.list()[0]?.active).toBe(false);
  });

  it("compacts without a fabricated user message or an extra normal response", async () => {
    const { session } = await setup();
    let responses = 0;
    const agent = own(
      createAgentWithModelStream({
        session,
        modelStream: async function* (request) {
          if (request.purpose === "compaction")
            yield {
              type: "text_delta",
              delta: COMPACTION_SECTION_TITLES.map((title) => `## ${title}\n已记录。`).join("\n"),
            };
          else {
            responses++;
            yield { type: "text_delta", delta: "历史内容。".repeat(3000) };
          }
          yield { type: "finish", finishReason: "stop" };
        },
      }),
    );
    await agent.prompt("第一轮");
    await agent.prompt("第二轮");
    const count = agent.state.messageHistory.length;
    const result = await agent.compact();
    expect(result).toEqual({ ok: true, value: undefined });
    expect(agent.state.messageHistory).toHaveLength(count);
    expect(responses).toBe(2);
    expect(session.records.filter((record) => record.type === "compaction")).toHaveLength(1);
    expect(agent.state.operation).toBeNull();
  });

  it("persists MCP authorization and execution start before invoking the connection", async () => {
    const { session } = await setup();
    let called = 0;
    const mcp = fakeMcp(session, () => {
      called++;
    });
    let requestCount = 0;
    const agent = own(
      createAgentWithModelStream({
        session,
        mcp,
        modelStream: async function* () {
          if (requestCount++ === 0) {
            yield {
              type: "tool_call",
              toolCallId: randomUUID(),
              toolName: "mcp_test",
              input: { message: "x" },
              invalid: false,
            };
            yield { type: "finish", finishReason: "tool_calls" };
          } else {
            yield { type: "text_delta", delta: "完成" };
            yield { type: "finish", finishReason: "stop" };
          }
        },
      }),
    );
    agent.subscribe((event) => {
      if (event.type === "tool_approval_requested") {
        expect(called).toBe(0);
        agent.respondToToolApproval(event.request.toolApprovalRequestId, "approve");
      }
    });
    expect((await agent.prompt("调用这个 MCP 工具")).status).toBe("completed");
    expect(called).toBe(1);
    const toolMessage = session.messageHistory.find((message) => message.role === "tool");
    expect(toolMessage?.role === "tool" && toolMessage.artifact?.complete).toBe(true);
  });
});

function fakeMcp(session: Session, called: () => void): McpConnections {
  const tool = {
    name: "mcp_test",
    originalName: "test",
    serverId: "test:server",
    description: "测试",
    generation: 1,
    inputSchema: { type: "object" },
  };
  const info = {
    id: "test:server",
    name: "server",
    source: "test",
    transport: "stdio" as const,
    state: "connected" as const,
    generation: 1,
    error: null,
    protocolVersion: "2026-07-28",
  };
  const content: McpContent = {
    text: "result",
    originalText: "result",
    isError: false,
    truncated: false,
    unsupportedContent: false,
    sourceTruncated: false,
  };
  return {
    list: () => [info],
    tools: () => [tool],
    validateToolCall: () => success(undefined),
    connect: async () => success(info),
    disconnect: async () => success(info),
    inspect: async () =>
      success({ ...info, tools: [tool], resources: [], prompts: [], diagnostics: [] }),
    callTool: async () => {
      expect(session.records.at(-1)?.type).toBe("tool_execution_started");
      expect(
        session.records.some(
          (record) =>
            record.type === "approval_decision" &&
            record.decision === "allowed" &&
            record.decisionSource === "user",
        ),
      ).toBe(true);
      called();
      return success(content);
    },
    readResource: async () => success(content),
    getPrompt: async () => success(content),
    close: async () => undefined,
  };
}
