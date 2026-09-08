import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Agent, createAgentWithModelStream } from "../src/agent.js";
import { createContextBudget, estimateModelRequestTokens } from "../src/context/budget.js";
import { createContextVersion, createUsageAnchor, measureRequest } from "../src/context/request.js";
import {
  type ModelRequest,
  ModelRequestError,
  type ModelStream,
} from "../src/model/model-stream.js";
import { createCodingSystemPrompt } from "../src/prompts/coding-system-prompt.js";
import { createSession, openSession, type Session } from "../src/session/index.js";
import { getToolDefinitions } from "../src/tool/definitions.js";

const shell = {
  kind: "powershell" as const,
  executable: "pwsh",
  arguments: ["-NoProfile", "-Command"],
};
const cleanup: Array<() => Promise<void>> = [];
const summary = [
  "## 任务目标\n继续验证。",
  "## 用户约束与偏好\n保留用户原始偏好。",
  "## 关键决定\n沿用当前决定。",
  "## 完成与验证\n旧内容已经阅读；未执行命令。",
  "## 当前进度与下一步\n回答最新请求。",
  "## 文件/错误/产物\n没有产物或错误。",
].join("\n\n");
const usage = {
  inputTokens: 100,
  outputTokens: 20,
  cachedInputTokens: 50,
  cacheWriteInputTokens: null,
};
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

async function seed(): Promise<Session> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-context-"));
  cleanup.push(() => rm(workspaceRoot, { recursive: true, force: true }));
  const session = await createSession({
    workspaceRoot,
    sessionDirectory: join(workspaceRoot, "sessions"),
    shell,
  });
  cleanup.push(() => session.close());
  const acquired = await session.acquireRun(randomUUID());
  if (acquired.status !== "acquired") throw new Error("lease");
  await acquired.lease.appendMessage({
    role: "user",
    content: "Historical source " + "x".repeat(24_000),
  });
  await acquired.lease.appendMessage({
    role: "assistant",
    status: "completed",
    content: [{ type: "text", text: "旧内容已读。" }],
  });
  await acquired.lease.appendRunFinished({ status: "completed" });
  await acquired.lease.release();
  return session;
}
function initialRequest(): ModelRequest {
  return {
    systemPrompt: createCodingSystemPrompt(),
    messages: [
      { role: "user", content: "Historical source " + "x".repeat(24_000) },
      { role: "assistant", content: [{ type: "text", text: "旧内容已读。" }] },
      { role: "user", content: "请继续，保留我的表达。" },
    ],
    tools: getToolDefinitions("agent"),
  };
}
function budgetFor(extra = 0) {
  return createContextBudget(
    {
      contextWindow: 20_000 + 512 + estimateModelRequestTokens(initialRequest()) + extra,
    },
    { responseOutputTokens: 512, summaryOutputTokens: 512, retainedTokens: 128 },
  );
}
function create(session: Session, modelStream: ModelStream, extra = 0): Agent {
  const agent = createAgentWithModelStream({
    session,
    modelStream,
    modelContext: { modelId: "test", budget: budgetFor(extra) },
  });
  cleanup.push(() => agent.close());
  return agent;
}

describe("Context integration", () => {
  it("checks the calibrated window again after tool results inside the same run", async () => {
    const session = await seed();
    await writeFile(join(session.workspaceRoot, "note.txt"), "工具内容".repeat(200), "utf8");
    const purposes: string[] = [];
    const requestBudget = budgetFor(3000);
    let responseCount = 0;
    const agent = create(
      session,
      async function* (request) {
        purposes.push(request.purpose ?? "");
        if (request.purpose === "compaction") {
          yield { type: "text_delta", delta: summary };
          yield { type: "finish", finishReason: "stop", usage };
        } else if (responseCount++ === 0) {
          yield {
            type: "tool_call",
            toolCallId: randomUUID(),
            toolName: "read_file",
            input: { path: "note.txt" },
            invalid: false,
          };
          yield {
            type: "finish",
            finishReason: "tool_calls",
            usage: {
              ...usage,
              inputTokens: requestBudget.contextWindow - 20000 - 512 - 100,
            },
          };
        } else {
          expect(request.messages.some((message) => message.role === "tool")).toBe(true);
          yield { type: "text_delta", delta: "继续完成。" };
          yield { type: "finish", finishReason: "stop", usage };
        }
      },
      3000,
    );
    expect(await agent.prompt("请继续，保留我的表达。")).toEqual({ status: "completed" });
    expect(purposes).toEqual(["response", "compaction", "response"]);
    expect(
      session.records.find((record) => record.type === "compaction")?.usageBefore.inputTokens,
    ).toBe(requestBudget.contextWindow - 20000 - 512 - 100);
    expect(agent.state.messageHistory.filter((message) => message.role === "tool")).toHaveLength(1);
  });

  it("compacts when the initial context exceeds its budget, commits before continuing and restores a separate projection", async () => {
    const session = await seed();
    const requests: ModelRequest[] = [];
    const agent = create(session, async function* (request) {
      requests.push(request);
      if (request.purpose === "response") {
        expect(session.records.some((record) => record.type === "compaction")).toBe(true);
        expect(request.maxOutputTokens).toBe(512);
      } else {
        expect(request.tools).toEqual([]);
      }
      yield {
        type: "text_delta",
        delta: request.purpose === "compaction" ? summary : "继续完成。",
      };
      yield { type: "finish", finishReason: "stop", usage };
    });
    const events: string[] = [];
    agent.subscribe((event) => events.push(event.type));
    expect(await agent.prompt("请继续，保留我的表达。")).toEqual({ status: "completed" });
    expect(requests.map((request) => request.purpose)).toEqual(["compaction", "response"]);
    expect(requests[1]?.messages.at(-1)).toEqual({
      entryId: session.records.findLast(
        (record) => record.type === "message" && record.message.type === "user",
      )?.entryId,
      role: "user",
      content: "请继续，保留我的表达。",
    });
    expect(JSON.stringify(requests[1]?.messages)).not.toContain("x".repeat(100));
    expect(agent.state.messageHistory).toHaveLength(4);
    expect(events.indexOf("compaction_end")).toBeGreaterThan(events.indexOf("compaction_start"));
    expect(agent.state.contextUsage.requests.response.inputTokens).toBe(100);
    const journal = session.records.filter((record) => record.type === "request_usage");
    expect(journal).toHaveLength(2);
    await agent.close();
    const reopened = await openSession({
      workspaceRoot: session.workspaceRoot,
      sessionDirectory: session.sessionDirectory,
      sessionId: session.sessionId,
      shell,
    });
    cleanup.push(() => reopened.close());
    let restoredRequest: ModelRequest | undefined;
    const resumed = create(reopened, async function* (request) {
      restoredRequest = request;
      yield { type: "text_delta", delta: "第二次完成。" };
      yield { type: "finish", finishReason: "stop", usage };
    });
    expect(await resumed.prompt("继续第二次")).toEqual({ status: "completed" });
    expect(restoredRequest?.purpose).toBe("response");
    expect(JSON.stringify(restoredRequest?.messages).split("已保存历史的摘要")).toHaveLength(2);
    expect(resumed.state.messageHistory).toHaveLength(6);
    expect(resumed.state.contextUsage.requests.compaction.requests).toBe(1);
  });

  it("keeps the original history when summary validation fails", async () => {
    const session = await seed();
    let calls = 0;
    const agent = create(session, async function* () {
      calls += 1;
      yield { type: "text_delta", delta: "没有约定结构" };
      yield { type: "finish", finishReason: "stop", usage };
    });
    expect((await agent.prompt("请继续，保留我的表达。")).status).toBe("failed");
    expect(calls).toBe(1);
    expect(session.records.some((record) => record.type === "compaction")).toBe(false);
    expect(JSON.stringify(agent.state.messageHistory)).toContain("x".repeat(100));
  });

  it("does not commit or continue when a summary request is cancelled", async () => {
    const session = await seed();
    const started = Promise.withResolvers<void>();
    let calls = 0;
    const agent = create(session, async function* (_request, signal) {
      calls += 1;
      started.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      yield { type: "text_delta", delta: summary };
      yield { type: "finish", finishReason: "stop", usage };
    });
    const result = agent.prompt("请继续，保留我的表达。");
    await started.promise;
    agent.abort();
    expect(await result).toEqual({ status: "aborted" });
    expect(calls).toBe(1);
    expect(session.records.some((record) => record.type === "compaction")).toBe(false);
  });

  it("allows only one provider overflow recovery for the same message prefix", async () => {
    const session = await seed();
    const purposes: string[] = [];
    const agent = create(
      session,
      async function* (request) {
        purposes.push(request.purpose ?? "");
        if (request.purpose === "response") throw new ModelRequestError("context_overflow");
        yield { type: "text_delta", delta: summary };
        yield { type: "finish", finishReason: "stop", usage };
      },
      5_000,
    );
    expect((await agent.prompt("请继续，保留我的表达。")).status).toBe("failed");
    expect(purposes).toEqual(["response", "compaction", "response"]);
    expect(session.records.filter((record) => record.type === "compaction")).toHaveLength(1);
    expect(agent.state.contextUsage.requests.response.inputTokens).toBeNull();
  });

  it("shares retry attempts across the existing single overflow compaction recovery", async () => {
    const session = await seed();
    const purposes: string[] = [];
    let responses = 0;
    const agent = create(
      session,
      async function* (request) {
        purposes.push(request.purpose ?? "");
        if (request.purpose === "compaction") {
          yield { type: "text_delta", delta: summary };
          yield { type: "finish", finishReason: "stop", usage };
          return;
        }
        responses++;
        if (responses === 2) throw new ModelRequestError("context_overflow");
        throw new ModelRequestError("service", { httpStatus: 503 });
      },
      5000,
    );
    expect((await agent.prompt("请继续，保留我的表达。")).status).toBe("failed");
    expect(purposes).toEqual(["response", "response", "compaction", "response", "response"]);
    expect(session.records.filter((record) => record.type === "compaction")).toHaveLength(1);
    expect(agent.state.contextUsage.requests.response.requests).toBe(4);
    expect(agent.state.lastRunDiagnostic).toMatchObject({
      category: "service",
      retryCount: 2,
      retryStopReason: "exhausted",
    });
  });

  it("rejects an oversized latest user message before a model call", async () => {
    const session = await seed();
    let calls = 0;
    const agent = create(session, async function* () {
      calls += 1;
      yield { type: "finish", finishReason: "stop" };
    });
    expect((await agent.prompt("中".repeat(100_000))).status).toBe("failed");
    expect(calls).toBe(0);
    expect(session.records.some((record) => record.type === "compaction")).toBe(false);
  });

  it("invalidates an input anchor when transient reasoning is removed or the prefix changes", () => {
    const budget = createContextBudget({ contextWindow: 128_000 });
    const request: ModelRequest = {
      systemPrompt: "stable",
      tools: [],
      messages: [
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "transient" },
            { type: "text", text: "answer" },
          ],
        },
      ],
    };
    const version = createContextVersion("test", budget, request, null);
    const anchor = createUsageAnchor(request, version, usage);
    expect(measureRequest(request, version, anchor).inputTokens).toBe(100);
    const stripped: ModelRequest = {
      ...request,
      messages: [{ role: "assistant", content: [{ type: "text", text: "answer" }] }],
    };
    expect(measureRequest(stripped, version, anchor).source).toBe("estimated");
    expect(measureRequest(request, version + "changed", anchor).source).toBe("estimated");
    const extended = {
      ...request,
      messages: [...request.messages, { role: "user" as const, content: "new" }],
    };
    expect(measureRequest(extended, version, anchor).inputTokens).toBeGreaterThan(100);
  });
});
