import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { type Agent, createAgentWithModelStream } from "../src/agent.js";
import { createMemory } from "../src/memory/index.js";
import type { ModelRequest, ModelStream, ModelStreamEvent } from "../src/model/model-stream.js";
import { COMPACTION_SECTION_TITLES } from "../src/prompts/compaction-prompt.js";
import { createSession } from "../src/session/index.js";
import { promptToCompletion } from "./prompt-helper.js";

const agents: Agent[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup(
  modelStream: ModelStream,
  readOnly = false,
  failMemoryAdoption = false,
  workspaceSubdirectory = "",
) {
  const root = await mkdtemp(join(tmpdir(), "anthias-memory-context-"));
  roots.push(root);
  const projectRoot = join(root, "project");
  const workspaceRoot = join(projectRoot, workspaceSubdirectory);
  await mkdir(workspaceRoot, { recursive: true });
  if (workspaceSubdirectory)
    await promisify(execFile)("git", ["init", projectRoot], { windowsHide: true, timeout: 10_000 });
  const session = await createSession({
    workspaceRoot,
    sessionDirectory: join(root, "sessions"),
    shell: { kind: "powershell", executable: "pwsh", arguments: ["-NoProfile", "-Command"] },
  });
  const memoryDirectory = join(root, "memory");
  const memory = createMemory({ directory: memoryDirectory, workspaceRoot });
  const runtimeSession: typeof session = failMemoryAdoption
    ? {
        ...session,
        get records() {
          return session.records;
        },
        get header() {
          return session.header;
        },
        async appendContextSource(runId, details) {
          if (details.sourceId.startsWith("memory:")) throw new Error("synthetic adoption failure");
          return session.appendContextSource(runId, details);
        },
      }
    : session;
  const agent = createAgentWithModelStream({
    session: runtimeSession,
    memoryDirectory,
    modelStream,
    ...(readOnly ? { writable: false } : {}),
  });
  agents.push(agent);
  return { root, workspaceRoot, session, memory, agent };
}
function call(
  toolName: string,
  input: Record<string, unknown>,
  toolCallId = randomUUID(),
): ModelStreamEvent {
  return { type: "tool_call", toolName, toolCallId, input, invalid: false };
}
const finish = { type: "finish", finishReason: "stop" } as const;
const toolFinish = { type: "finish", finishReason: "tool_calls" } as const;
const writer = {
  explicit: true,
  source: { kind: "user" as const, sessionId: randomUUID(), entryIds: [], note: "用户明确保存。" },
};
const summary = COMPACTION_SECTION_TITLES.map((title) => "## " + title + "\n继续完成。").join("\n");

describe("Memory and source orchestration", { timeout: 15_000 }, () => {
  it("keeps initial source order and uses current project rules without mutating history", async () => {
    const requests: ModelRequest[] = [];
    const { agent, memory, workspaceRoot, session } = await setup(async function* (request) {
      requests.push(request);
      yield { type: "text_delta", delta: "完成" };
      yield finish;
    });
    await memory.execute(
      { action: "save", kind: "user", scope: "global", content: "USER_PREFERENCE" },
      writer,
    );
    await memory.execute(
      { action: "save", kind: "experience", content: "build 使用 pnpm build" },
      writer,
    );
    await writeFile(join(workspaceRoot, "AGENTS.md"), "PROJECT_RULE_V1");
    expect((await promptToCompletion(agent, "build")).status).toBe("completed");
    const first = requests[0];
    if (!first) throw new Error("request");
    const records = new Map(session.records.map((record) => [record.entryId, record]));
    const kinds = first.messages.flatMap((message) => {
      const record = message.entryId ? records.get(message.entryId) : undefined;
      return record?.type === "context_source" ? [record.kind] : [];
    });
    expect(kinds).toEqual([
      "user_memory",
      "environment",
      "project_rules",
      "skill_directory",
      "memory_index",
      "experience_memory",
    ]);
    expect(first.systemPrompt).not.toContain("PROJECT_RULE_V1");
    expect(first.tools.map((tool) => tool.name)).toEqual(
      [...first.tools.map((tool) => tool.name)].sort(),
    );
    await writeFile(join(workspaceRoot, "AGENTS.md"), "PROJECT_RULE_V2");
    expect((await promptToCompletion(agent, "继续")).status).toBe("completed");
    expect(requests[1]?.systemPrompt).toBe(first.systemPrompt);
    const unchangedMessages = first.messages.filter((message) => {
      const record = message.entryId ? records.get(message.entryId) : undefined;
      return record?.type !== "context_source" || record.kind !== "project_rules";
    });
    const unchangedEntryIds = new Set(unchangedMessages.map((message) => message.entryId));
    expect(
      requests[1]?.messages.filter((message) => unchangedEntryIds.has(message.entryId)),
    ).toEqual(unchangedMessages);
    expect(JSON.stringify(first.messages)).toContain("PROJECT_RULE_V1");
    expect(JSON.stringify(requests[1]?.messages)).not.toContain("PROJECT_RULE_V1");
    expect(JSON.stringify(session.records)).toContain("PROJECT_RULE_V1");
    expect(JSON.stringify(requests[1]?.messages)).toContain("PROJECT_RULE_V2");
    expect(
      session.records.filter(
        (record) => record.type === "context_source" && record.kind === "project_rules",
      ),
    ).toHaveLength(2);
    expect((await promptToCompletion(agent, "再继续")).status).toBe("completed");
    expect(
      session.records.filter(
        (record) => record.type === "context_source" && record.kind === "project_rules",
      ),
    ).toHaveLength(2);
  });

  it("records explicit preferences with read-only workspace capability and inserts one body after the complete tool group", async () => {
    const requests: ModelRequest[] = [];
    const { agent, memory, workspaceRoot, session } = await setup(async function* (request) {
      requests.push(request);
      if (requests.length === 1) {
        yield call("memory", {
          action: "save",
          kind: "user",
          scope: "global",
          content: "回答先给结论",
          basis: "user",
          quote: "以后回答先给结论",
        });
        yield call("read_file", { path: "note.txt" });
        yield toolFinish;
      } else {
        yield { type: "text_delta", delta: "已记住" };
        yield finish;
      }
    }, true);
    await writeFile(join(workspaceRoot, "note.txt"), "文档内容");
    expect((await promptToCompletion(agent, "不要修改代码，记住以后回答先给结论")).status).toBe(
      "completed",
    );
    expect((await memory.query()).entries[0]).toMatchObject({
      content: "回答先给结论",
      status: "active",
      source: { kind: "user" },
    });
    const messages = requests[1]?.messages ?? [];
    const toolStart = messages.findIndex((message) => message.role === "assistant");
    expect(messages.slice(toolStart, toolStart + 4).map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "tool",
      "user",
    ]);
    const sources = session.records.filter(
      (record) => record.type === "context_source" && record.sourceId.startsWith("memory:"),
    );
    expect(sources).toHaveLength(1);
    expect(messages.filter((message) => message.entryId === sources[0]?.entryId)).toHaveLength(1);
    expect(
      messages
        .filter((message) => message.role === "tool")
        .map((message) => message.content)
        .join(""),
    ).not.toContain("回答先给结论");
  });

  it.each(["root", "subdirectory"])(
    "binds verified experience to tool evidence and detects file changes from a %s workspace",
    async (pathStyle) => {
      const evidenceId = randomUUID();
      let count = 0;
      const { agent, memory, workspaceRoot } = await setup(
        async function* () {
          if (++count === 1)
            yield call(
              "read_file",
              {
                path: "package.json",
              },
              evidenceId,
            );
          else if (count === 2)
            yield call("memory", {
              action: "save",
              kind: "experience",
              content: "测试命令使用 pnpm test",
              basis: "verified",
              toolCallId: evidenceId,
              quote: "pnpm test",
            });
          else {
            yield { type: "text_delta", delta: "完成" };
            yield finish;
            return;
          }
          yield toolFinish;
        },
        false,
        false,
        pathStyle === "subdirectory" ? join("packages", "app") : "",
      );
      await writeFile(join(workspaceRoot, "package.json"), '{"scripts":{"test":"pnpm test"}}');
      expect((await promptToCompletion(agent, "检查并记录测试配置")).status).toBe("completed");
      const entry = (await memory.query()).entries[0];
      expect(entry).toMatchObject({
        status: "active",
        source: { kind: "verified" },
        conditions: {
          files: [
            {
              path:
                pathStyle === "subdirectory"
                  ? join("packages", "app", "package.json")
                  : "package.json",
            },
          ],
        },
      });
      await writeFile(join(workspaceRoot, "package.json"), "{}");
      expect((await memory.query({ status: "all" })).entries[0]?.status).toBe("review");
    },
  );

  it("rejects invented evidence, leaves inferred preferences as candidates and honors the automatic switch", async () => {
    let count = 0;
    const { agent, memory } = await setup(async function* () {
      count++;
      if (count === 1)
        yield call("memory", {
          action: "save",
          kind: "experience",
          content: "未经验证的事实",
          basis: "verified",
          toolCallId: randomUUID(),
          quote: "成功",
        });
      else if (count === 2 || count === 4)
        yield call("memory", {
          action: "save",
          kind: "user",
          content: count === 2 ? "可能喜欢表格" : "另一个推断",
          basis: "inferred",
        });
      else {
        yield { type: "text_delta", delta: "完成" };
        yield finish;
        return;
      }
      yield toolFinish;
    });
    expect((await promptToCompletion(agent, "整理一下")).status).toBe("completed");
    expect((await memory.query({ status: "all" })).entries.map((entry) => entry.status)).toEqual([
      "candidate",
    ]);
    expect((await agent.memory.execute({ action: "settings", automatic: false })).ok).toBe(true);
    expect((await promptToCompletion(agent, "继续")).status).toBe("completed");
    expect((await memory.query({ status: "all" })).entries).toHaveLength(1);
    expect(
      agent.state.messageHistory.filter(
        (message) => message.role === "tool" && message.status === "failed",
      ),
    ).toHaveLength(2);
  });

  it("rebuilds after no-send forgetting while preserving the raw history and refusing old evidence", async () => {
    const privatePreference = 'OLD_PRIVATE_PREFERENCE "quoted" \\path\n下一行';
    const requests: ModelRequest[] = [];
    const { agent, memory, session, root } = await setup(async function* (request) {
      requests.push(request);
      yield {
        type: "text_delta",
        delta: request.purpose === "compaction" ? summary : privatePreference + "说明".repeat(1500),
      };
      yield finish;
    });
    const saved = (
      await memory.execute(
        { action: "save", kind: "user", scope: "global", content: privatePreference },
        writer,
      )
    ).entries[0];
    if (!saved) throw new Error("memory");
    await promptToCompletion(agent, "任务一");
    await promptToCompletion(agent, "补充原文：" + privatePreference);
    expect((await agent.compact()).ok).toBe(true);
    const checkpoint = session.records.findLast((record) => record.type === "compaction");
    expect(
      checkpoint?.type === "compaction" && checkpoint.projection?.sourceVersions.length,
    ).toBeGreaterThan(0);
    await memory.execute(
      { action: "forget", id: saved.id, revision: saved.revision, stopSending: true },
      writer,
    );
    await promptToCompletion(agent, "继续任务");
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain("OLD_PRIVATE_PREFERENCE");
    expect(JSON.stringify(session.records)).toContain("OLD_PRIVATE_PREFERENCE");
    await expect(
      memory.execute(
        { action: "save", kind: "user", scope: "global", content: privatePreference },
        { ...writer, explicit: false, candidate: true },
      ),
    ).rejects.toThrow("遗忘");
    const requestCount = requests.length;
    await writeFile(join(root, "memory", "user", saved.id + ".json"), "{broken tombstone");
    expect((await promptToCompletion(agent, "再次继续")).status).toBe("failed");
    expect(requests).toHaveLength(requestCount);
  });

  it("reports a committed memory when session adoption fails and seals the affected run", async () => {
    let requests = 0;
    const { agent, memory, session } = await setup(
      async function* () {
        requests++;
        yield call("memory", {
          action: "save",
          kind: "user",
          scope: "global",
          content: "回答先给结论",
          basis: "user",
          quote: "以后回答先给结论",
        });
        yield toolFinish;
      },
      false,
      true,
    );
    const result = await promptToCompletion(agent, "以后回答先给结论");
    expect(result.status === "failed" && result.error).toContain("记忆已保存");
    expect((await memory.query()).entries[0]?.content).toBe("回答先给结论");
    expect(
      session.records.some(
        (record) => record.type === "context_source" && record.sourceId.startsWith("memory:"),
      ),
    ).toBe(false);
    expect((await promptToCompletion(agent, "不重复写入")).status).toBe("failed");
    expect(requests).toBe(1);
  });

  it("binds natural-language maintenance to the requested action and target", async () => {
    let memoryId = "";
    let count = 0;
    const { agent, memory } = await setup(async function* () {
      count++;
      if (count === 1)
        yield call("memory", { action: "settings", automatic: false, quote: "请记住我偏好中文" });
      else if (count === 2)
        yield call("memory", { action: "forget", id: memoryId, revision: 1, quote: "偏好中文" });
      else if (count === 4)
        yield call("memory", {
          action: "save",
          kind: "user",
          content: "违规推断",
          basis: "inferred",
          quote: "修改记忆",
        });
      else if (count === 6)
        yield call("memory", {
          action: "forget",
          id: memoryId,
          revision: 1,
          quote: "忘记保留的偏好",
        });
      else {
        yield { type: "text_delta", delta: "完成" };
        yield finish;
        return;
      }
      yield toolFinish;
    });
    memoryId =
      (await memory.execute({ action: "save", kind: "user", content: "保留的偏好" }, writer))
        .entries[0]?.id ?? "";
    await promptToCompletion(agent, "请记住我偏好中文");
    expect((await memory.query()).automatic).toBe(true);
    expect((await memory.query()).entries[0]?.status).toBe("active");
    await promptToCompletion(agent, "不要修改记忆");
    expect((await memory.query({ status: "all" })).entries).toHaveLength(1);
    await promptToCompletion(agent, "忘记保留的偏好");
    expect((await memory.query({ status: "all" })).entries[0]?.status).toBe("forgotten");
  });

  it("blocks an unreadable required rules file and recovers after the file is repaired", async () => {
    let requests = 0;
    const { agent, workspaceRoot } = await setup(async function* () {
      requests++;
      yield { type: "text_delta", delta: "完成" };
      yield finish;
    });
    await mkdir(join(workspaceRoot, "AGENTS.md"));
    const result = await promptToCompletion(agent, "开始");
    expect(result.status).toBe("failed");
    expect(requests).toBe(0);
    await rm(join(workspaceRoot, "AGENTS.md"), { recursive: true });
    await writeFile(join(workspaceRoot, "AGENTS.md"), "修复后的规则");
    expect((await promptToCompletion(agent, "继续")).status).toBe("completed");
    expect(requests).toBe(1);
  });

  it("accepts member submissions only as root-owned candidates", async () => {
    let requests = 0;
    const { agent, memory } = await setup(async function* () {
      if (++requests === 1) {
        yield call("memory", {
          action: "save",
          kind: "experience",
          content: "成员发现的候选",
          basis: "inferred",
        });
        yield toolFinish;
      } else {
        yield { type: "text_delta", delta: "完成" };
        yield finish;
      }
    });
    const spawned = await agent.collaboration.execute({
      action: "spawn",
      task: "整理可复用经验",
      writable: false,
    });
    if (!spawned.ok) throw new Error(spawned.error);
    const member = JSON.parse(spawned.value) as { sessionId: string };
    await agent.collaboration.execute({
      action: "wait",
      memberIds: [member.sessionId],
      timeoutMs: 5000,
    });
    expect((await memory.query({ status: "all" })).entries[0]).toMatchObject({
      status: "candidate",
      source: { sessionId: member.sessionId },
    });
  });

  it("stops a generated tool when another root forgets a memory used by the pending request", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { agent, memory } = await setup(async function* () {
      entered.resolve();
      await release.promise;
      yield call("read_file", { path: "missing.txt" });
      yield toolFinish;
    });
    const saved = (
      await memory.execute(
        { action: "save", kind: "user", scope: "global", content: "本轮将被撤销" },
        writer,
      )
    ).entries[0];
    if (!saved) throw new Error("memory");
    const completion = promptToCompletion(agent, "开始");
    await entered.promise;
    await memory.execute({ action: "forget", id: saved.id, revision: saved.revision }, writer);
    release.resolve();
    const result = await completion;
    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.error).toContain("记忆已撤销");
    expect(
      agent.state.messageHistory.some(
        (message) => message.role === "tool" && message.status === "completed",
      ),
    ).toBe(false);
  });
});
