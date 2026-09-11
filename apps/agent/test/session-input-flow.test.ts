import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { type Agent, type AgentEvent, createAgentWithModelStream } from "../src/agent.js";
import type { ModelRequest, ModelStream } from "../src/model/model-stream.js";
import { createSession, type Session } from "../src/session/index.js";
import { createSessionAgent, type SessionAgent } from "../src/session-agent.js";
import { createToolRunner, type ToolRunner } from "../src/tool/tool-runner.js";
import { promptToCompletion } from "./prompt-helper.js";

const agents: Array<Agent | SessionAgent> = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.allSettled(agents.splice(0).map((agent) => agent.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function setup(modelStream: ModelStream, configure?: (session: Session) => ToolRunner) {
  const directory = await mkdtemp(join(tmpdir(), "anthias-input-flow-"));
  directories.push(directory);
  const session = await createSession({
    workspaceRoot: directory,
    sessionDirectory: join(directory, "sessions"),
    shell: { kind: "powershell", executable: "pwsh", arguments: [] },
  });
  const agent = createAgentWithModelStream({
    session,
    modelStream,
    ...(configure ? { toolRunner: configure(session) } : {}),
    permissionMode: "agent",
  });
  agents.push(agent);
  const events: AgentEvent[] = [];
  agent.subscribe((event) => events.push(event));
  return { agent, session, directory, events };
}
function userTexts(request: ModelRequest) {
  return request.messages
    .filter((message) => message.role === "user" && !message.content.startsWith("[上下文来源："))
    .map((message) => message.content);
}

it("consumes one steer at each final response and starts FIFO follow-ups only after durable Run endings", async () => {
  const release = Promise.withResolvers<void>();
  const requests: ModelRequest[] = [];
  const { agent, session, events } = await setup(async function* (request) {
    requests.push(request);
    if (requests.length === 1) await release.promise;
    yield { type: "text_delta", delta: "done" };
    yield { type: "finish", finishReason: "stop" };
  });
  let handoffControl: ReturnType<typeof agent.compact> | undefined;
  agent.subscribe((event) => {
    if (event.type === "run_end" && !handoffControl) {
      expect(agent.state.running).toBe(true);
      handoffControl = agent.compact();
    }
  });
  const initial = promptToCompletion(agent, "initial");
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  const followOne = await agent.prompt("follow one", { mode: "followUp" });
  const steerOne = await agent.prompt("steer one");
  const steerTwo = await agent.prompt("steer two");
  const followTwo = await agent.prompt("follow two", { mode: "followUp" });
  expect(
    [followOne, steerOne, steerTwo, followTwo].every(
      (receipt) => receipt.status === "queued" && receipt.durable === false,
    ),
  ).toBe(true);
  expect(agent.state.messageHistory).toEqual([{ role: "user", content: "initial" }]);
  release.resolve();
  expect((await initial).status).toBe("completed");
  await vi.waitFor(() =>
    expect(events.filter((event) => event.type === "run_end")).toHaveLength(3),
  );
  expect(await handoffControl).toMatchObject({ ok: false });
  expect(requests.map(userTexts)).toEqual([
    ["initial"],
    ["initial", "steer one"],
    ["initial", "steer one", "steer two"],
    ["initial", "steer one", "steer two", "follow one"],
    ["initial", "steer one", "steer two", "follow one", "follow two"],
  ]);
  const consumed = events.filter((event) => event.type === "input_consumed");
  expect(consumed).toHaveLength(5);
  expect(new Set(consumed.map((event) => event.entryId)).size).toBe(5);
  expect(new Set(consumed.slice(0, 3).map((event) => event.runId)).size).toBe(1);
  const history = session.records.filter(
    (entry) => entry.type === "message" || entry.type === "run_finished",
  );
  expect(history.filter((entry) => entry.type === "run_finished")).toHaveLength(3);
  expect(agent.state.inputQueue).toEqual({ steer: [], followUp: [], paused: false });
});

it("waits for the entire parallel tool batch before inserting queued steering", async () => {
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const started = new Set<string>();
  const ids: string[] = [randomUUID(), randomUUID()];
  const requests: ModelRequest[] = [];
  const { agent, directory, events } = await setup(
    async function* (request) {
      requests.push(request);
      if (requests.length === 1) {
        for (const [index, id] of ids.entries())
          yield {
            type: "tool_call",
            toolCallId: id,
            toolName: "read_file",
            input: { path: `${index}.txt` },
            invalid: false,
          };
        yield { type: "finish", finishReason: "tool_calls" };
      } else {
        yield { type: "text_delta", delta: "done" };
        yield { type: "finish", finishReason: "stop" };
      }
    },
    (session) => {
      const runner = createToolRunner({
        workspace: {
          workspaceRoot: session.workspaceRoot,
          sessionDirectory: session.sessionDirectory,
        },
        shell: session.shell,
      });
      return {
        createPlan(call, mode) {
          const plan = runner.createPlan(call, mode);
          return {
            ...plan,
            async prepare(signal) {
              const prepared = await plan.prepare(signal);
              if (!prepared.ok) return prepared;
              return {
                ...prepared,
                preparedExecution: {
                  ...prepared.preparedExecution,
                  async execute(...args) {
                    started.add(call.toolCallId);
                    await gates[ids.indexOf(call.toolCallId)]?.promise;
                    return prepared.preparedExecution.execute(...args);
                  },
                },
              };
            },
          };
        },
      };
    },
  );
  await writeFile(join(directory, "0.txt"), "first");
  await writeFile(join(directory, "1.txt"), "second");
  const initial = promptToCompletion(agent, "read both");
  await vi.waitFor(() => expect(started.size).toBe(2));
  await agent.prompt("after the batch");
  gates[0]?.resolve();
  await vi.waitFor(() =>
    expect(events.filter((event) => event.type === "tool_execution_end")).toHaveLength(1),
  );
  expect(events.filter((event) => event.type === "input_consumed")).toHaveLength(1);
  expect(requests).toHaveLength(1);
  gates[1]?.resolve();
  expect((await initial).status).toBe("completed");
  expect(agent.state.messageHistory.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "tool",
    "tool",
    "user",
    "assistant",
  ]);
  expect(requests[1] ? userTexts(requests[1]) : []).toEqual(["read both", "after the batch"]);
});

it("retains queues after stop, requires explicit resume, and reports discarded inputs on Session switch", async () => {
  let requests = 0;
  const { agent, events } = await setup(async function* (_request, signal) {
    requests += 1;
    if (requests === 1) {
      yield { type: "text_delta", delta: "working" };
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return;
    }
    yield { type: "text_delta", delta: "done" };
    yield { type: "finish", finishReason: "stop" };
  });
  const initial = promptToCompletion(agent, "initial");
  await vi.waitFor(() => expect(requests).toBe(1));
  const queued = await agent.prompt("retained", { mode: "followUp" });
  agent.abort();
  expect((await initial).status).toBe("aborted");
  expect(await agent.prompt("also retained")).toMatchObject({ status: "queued" });
  expect(requests).toBe(1);
  expect(agent.state.inputQueue.paused).toBe(true);
  expect((await promptToCompletion(agent, "", { resume: true })).status).toBe("completed");
  await vi.waitFor(() =>
    expect(events.filter((event) => event.type === "run_end")).toHaveLength(3),
  );
  agent.abort();
  const discarded = await agent.prompt("never persisted");
  expect(discarded.status).toBe("queued");
  expect((await agent.sessions.create()).ok).toBe(true);
  expect(agent.state.messageHistory).toEqual([]);
  expect(events.filter((event) => event.type === "input_discarded")).toMatchObject([
    {
      inputId: discarded.status === "rejected" ? "" : discarded.inputId,
      reason: "session_changed",
    },
  ]);
  expect(
    events.some(
      (event) =>
        event.type === "input_consumed" &&
        queued.status !== "rejected" &&
        event.inputId === queued.inputId,
    ),
  ).toBe(true);
});

it("preserves failed queues until explicit resume and reports unsaved input during close", async () => {
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const { agent, events } = await setup(async function* () {
    calls += 1;
    yield { type: "text_delta", delta: "partial" };
    await release.promise;
    throw new Error("synthetic failure");
  });
  const initial = promptToCompletion(agent, "initial");
  await vi.waitFor(() => expect(calls).toBe(1));
  const receipt = await agent.prompt("queued after failure", { mode: "followUp" });
  release.resolve();
  expect((await initial).status).toBe("failed");
  expect(calls).toBe(1);
  expect(agent.state.inputQueue.paused).toBe(true);
  await agent.close();
  expect(events.at(-1)).toMatchObject({
    type: "input_discarded",
    inputId: receipt.status === "rejected" ? "" : receipt.inputId,
    reason: "closed",
  });
  expect(agent.state.messageHistory.filter((message) => message.role === "user")).toHaveLength(1);
});

it("keeps internal control actions out of pending queues and settles member continuation after older delivery input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anthias-internal-input-"));
  directories.push(directory);
  const session = await createSession({
    workspaceRoot: directory,
    sessionDirectory: join(directory, "sessions"),
    shell: { kind: "powershell", executable: "pwsh", arguments: [] },
  });
  let requests = 0;
  const agent = createSessionAgent({
    session,
    modelStream: async function* () {
      requests += 1;
      yield { type: "text_delta", delta: "done" };
      yield { type: "finish", finishReason: "stop" };
    },
  });
  agents.push(agent);
  const input = (content: string) => ({
    messageId: randomUUID(),
    rootSessionId: session.sessionId,
    fromSessionId: session.sessionId,
    kind: "message" as const,
    content,
  });
  agent.queueInternal(input("older delivery"));
  expect(await agent.runTool("read_file", { path: "unused" })).toEqual({
    status: "rejected",
    reason: "busy",
  });
  expect(requests).toBe(0);
  expect((await agent.promptInternal(input("explicit continuation"))).status).toBe("completed");
  expect(requests).toBe(2);
  expect(session.records.filter((entry) => entry.type === "agent_input")).toHaveLength(2);
  expect(
    agent.state.messageHistory
      .filter((message) => message.role === "user")
      .every((message) => message.source?.kind === "agent"),
  ).toBe(true);
});

it("keeps durable delivery arriving at run_end idle until explicit continuation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anthias-durable-handoff-"));
  directories.push(directory);
  const session = await createSession({
    workspaceRoot: directory,
    sessionDirectory: join(directory, "sessions"),
    shell: { kind: "powershell", executable: "pwsh", arguments: [] },
  });
  let requests = 0;
  const agent = createSessionAgent({
    session,
    modelStream: async function* () {
      requests += 1;
      yield { type: "text_delta", delta: "done" };
      yield { type: "finish", finishReason: "stop" };
    },
  });
  agents.push(agent);
  const input = (content: string) => ({
    messageId: randomUUID(),
    rootSessionId: session.sessionId,
    fromSessionId: session.sessionId,
    kind: "message" as const,
    content,
  });
  const lateInput = input("late durable input");
  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "run_end" && requests === 1) agent.queueInternal(lateInput);
  });
  expect((await agent.promptInternal(input("initial task"))).status).toBe("completed");
  expect(requests).toBe(1);
  expect(agent.state.running).toBe(false);
  expect(agent.state.inputQueue.steer).toMatchObject([{ inputId: lateInput.messageId }]);
  unsubscribe();
  expect((await promptToCompletion(agent, "", { resume: true })).status).toBe("completed");
  expect(requests).toBe(2);
});

it("reports synchronous reentrant reception as queued after the first accepted input", async () => {
  const { agent } = await setup(async function* () {
    yield { type: "text_delta", delta: "done" };
    yield { type: "finish", finishReason: "stop" };
  });
  let nested: ReturnType<typeof agent.prompt> | undefined;
  agent.subscribe((event) => {
    if (event.type === "input_queued" && event.input.content === "first")
      nested = agent.prompt("second");
  });
  expect(await agent.prompt("first")).toMatchObject({ status: "accepted" });
  expect(await nested).toMatchObject({ status: "queued" });
  await vi.waitFor(() => expect(agent.state.running).toBe(false));
  expect(agent.state.messageHistory.filter((message) => message.role === "user")).toHaveLength(2);
});

it.each(["aborted", "failed"] as const)(
  "honors explicit continuation received while the %s Run is still sealing",
  async (terminalStatus) => {
    const directory = await mkdtemp(join(tmpdir(), "anthias-resume-handoff-"));
    directories.push(directory);
    const session = await createSession({
      workspaceRoot: directory,
      sessionDirectory: join(directory, "sessions"),
      shell: { kind: "powershell", executable: "pwsh", arguments: [] },
    });
    const failResponse = Promise.withResolvers<void>();
    const sealing = Promise.withResolvers<void>();
    const releaseSeal = Promise.withResolvers<void>();
    const delayed: Session = {
      ...session,
      get records() {
        return session.records;
      },
      get header() {
        return session.header;
      },
      async appendRunFinished(runId, details) {
        if (details.status === terminalStatus) {
          sealing.resolve();
          await releaseSeal.promise;
        }
        return session.appendRunFinished(runId, details);
      },
    };
    let requests = 0;
    const agent = createSessionAgent({
      session: delayed,
      modelStream: async function* (_request, signal) {
        requests += 1;
        if (requests === 1) {
          yield { type: "text_delta", delta: "working" };
          if (terminalStatus === "failed") {
            await failResponse.promise;
            throw new Error("synthetic terminal model failure");
          }
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          return;
        }
        yield { type: "text_delta", delta: "done" };
        yield { type: "finish", finishReason: "stop" };
      },
    });
    agents.push(agent);
    const initial = promptToCompletion(agent, "initial");
    await vi.waitFor(() => expect(requests).toBe(1));
    await agent.prompt("continue queued");
    if (terminalStatus === "aborted") agent.abort();
    else failResponse.resolve();
    await sealing.promise;
    const continued = promptToCompletion(agent, "", { resume: true });
    releaseSeal.resolve();
    expect((await initial).status).toBe(terminalStatus);
    expect((await continued).status).toBe("completed");
    expect(requests).toBe(2);
    expect(agent.state.inputQueue).toEqual({ steer: [], followUp: [], paused: false });
  },
);

it("lets the last stop cancel continuation while the aborted Run is sealing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anthias-last-stop-"));
  directories.push(directory);
  const session = await createSession({
    workspaceRoot: directory,
    sessionDirectory: join(directory, "sessions"),
    shell: { kind: "powershell", executable: "pwsh", arguments: [] },
  });
  const sealing = Promise.withResolvers<void>();
  const releaseSeal = Promise.withResolvers<void>();
  const delayedSession: Session = {
    ...session,
    get records() {
      return session.records;
    },
    get header() {
      return session.header;
    },
    async appendRunFinished(runId, details) {
      if (details.status === "aborted") {
        sealing.resolve();
        await releaseSeal.promise;
      }
      return session.appendRunFinished(runId, details);
    },
  };
  let requestCount = 0;
  const agent = createSessionAgent({
    session: delayedSession,
    modelStream: async function* (_request, signal) {
      requestCount += 1;
      if (requestCount === 1) {
        yield { type: "text_delta", delta: "working" };
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return;
      }
      yield { type: "text_delta", delta: "done" };
      yield { type: "finish", finishReason: "stop" };
    },
  });
  agents.push(agent);
  const initialResult = promptToCompletion(agent, "initial");
  await vi.waitFor(() => expect(requestCount).toBe(1));
  await agent.prompt("queued continuation");
  agent.abort();
  await sealing.promise;
  await agent.prompt("", { resume: true });
  agent.abort();
  releaseSeal.resolve();
  expect((await initialResult).status).toBe("aborted");
  await vi.waitFor(() => expect(agent.state.running).toBe(false));
  expect(agent.state.inputQueue.paused).toBe(true);
  expect(agent.state.inputQueue.steer.map((input) => input.content)).toEqual([
    "queued continuation",
  ]);
  expect(requestCount).toBe(1);
  expect((await promptToCompletion(agent, "", { resume: true })).status).toBe("completed");
  expect(requestCount).toBe(2);
});
