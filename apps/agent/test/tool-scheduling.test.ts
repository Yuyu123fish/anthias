import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentEvent, createAgentWithModelStream } from "../src/agent.js";
import type { AssistantToolCallPart } from "../src/message.js";
import type { ModelRequest, ModelStream, ModelStreamEvent } from "../src/model-stream.js";
import {
  createSession,
  resolveSessionDirectory,
  resolveSessionShell,
} from "../src/session/index.js";
import type { ToolRunner } from "../src/tool/tool-runner.js";

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

describe("Tool batch scheduling", () => {
  it("runs four read-only calls concurrently and commits reverse completions in source order", async () => {
    const controlledRunner = createControlledReadOnlyRunner(6, 2);
    const modelRequests: ModelRequest[] = [];
    const modelStream = createBatchModelStream(modelRequests, [
      "read_file",
      "glob",
      "grep",
      "read_file",
      "glob",
      "grep",
    ]);
    const fixture = await createTestAgent(modelStream, controlledRunner.toolRunner);
    const events: AgentEvent[] = [];
    fixture.agent.subscribe((event) => events.push(event));
    const promptResultPromise = fixture.agent.prompt("并发读取");
    let concurrencyFailure: unknown;

    try {
      await vi.waitFor(() => expect(controlledRunner.startedIndices).toHaveLength(4), {
        timeout: 1_000,
      });
      controlledRunner.releases[3]?.resolve();
      await vi.waitFor(() => expect(controlledRunner.startedIndices).toContain(4));
      controlledRunner.releases[4]?.resolve();
      await vi.waitFor(() => expect(controlledRunner.startedIndices).toContain(5));
      controlledRunner.releases[5]?.resolve();
      controlledRunner.releases[2]?.resolve();
      controlledRunner.releases[1]?.resolve();
      controlledRunner.releases[0]?.resolve();
    } catch (error) {
      concurrencyFailure = error;
    } finally {
      for (const release of controlledRunner.releases) {
        release.resolve();
      }
    }

    await expect(promptResultPromise).resolves.toEqual({ status: "completed" });
    if (concurrencyFailure !== undefined) {
      throw concurrencyFailure;
    }

    expect(controlledRunner.maximumActiveCount).toBe(4);
    expect(controlledRunner.startedIndices).toEqual([0, 1, 2, 3, 4, 5]);
    expect(controlledRunner.completedIndices).toEqual([3, 4, 5, 2, 1, 0]);
    expect(
      events
        .filter((event) => event.type === "tool_execution_start")
        .map((event) => event.activity.toolCallId),
    ).toEqual(toolCallIds(6));
    expect(
      events
        .filter((event) => event.type === "tool_execution_end")
        .map((event) => event.toolCallId),
    ).toEqual([3, 4, 5, 2, 1, 0].map((index) => toolCallId(index + 1)));
    expect(
      events.filter((event) => event.type === "run_phase_changed").map((event) => event.phase),
    ).toEqual(["executing_tool", "requesting_model"]);

    const sourceOrderedResults = fixture.agent.state.messageHistory.filter(
      (message) => message.role === "tool",
    );
    expect(sourceOrderedResults.map((message) => message.toolCallId)).toEqual(toolCallIds(6));
    expect(sourceOrderedResults[2]).toMatchObject({ status: "failed" });
    expect(
      modelRequests[1]?.messages
        .filter((message) => message.role === "tool")
        .map((message) => message.toolCallId),
    ).toEqual(toolCallIds(6));

    const sessionRecords = (await readFile(fixture.sessionFilePath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(
      sessionRecords
        .filter(
          (record) =>
            record.type === "message" &&
            (record.message as Record<string, unknown> | undefined)?.type === "tool_result",
        )
        .map(
          (record) => (record.message as Record<string, unknown> | undefined)?.toolCallId as string,
        ),
    ).toEqual(toolCallIds(6));
  });

  it("keeps an entire mixed batch serial with one approval at a time", async () => {
    let activeCount = 0;
    let maximumActiveCount = 0;
    const executionOrder: string[] = [];
    const toolRunner: ToolRunner = Object.freeze({
      createPlan(toolCall) {
        const sideEffect = toolCall.toolName === "write_file";
        return Object.freeze({
          scheduling: sideEffect ? "source_order_serial" : "parallel_read_only",
          abortedPreparationContent: "aborted",
          prepare: () =>
            Promise.resolve(
              Object.freeze({
                ok: true,
                preparedExecution: Object.freeze({
                  approval: sideEffect
                    ? Object.freeze({
                        toolName: "write_file" as const,
                        target: "file.txt",
                        preview: "preview",
                        ruleId: "file.workspace_exact_review",
                        riskSummary: "write",
                        executionBoundary: "one file",
                        deniedContent: "denied",
                      })
                    : null,
                  activitySummary: `target: ${toolCall.toolName}`,
                  executionUnavailableContent: "aborted",
                  async execute() {
                    activeCount += 1;
                    maximumActiveCount = Math.max(maximumActiveCount, activeCount);
                    executionOrder.push(toolCall.toolCallId);
                    await new Promise<void>((resolve) => setTimeout(resolve, 10));
                    activeCount -= 1;
                    return Object.freeze({
                      status: "completed" as const,
                      content: toolCall.toolCallId,
                      truncated: false,
                      cleanupUncertain: false,
                    });
                  },
                }),
              }),
            ),
        });
      },
    });
    const modelRequests: ModelRequest[] = [];
    const modelStream = createBatchModelStream(modelRequests, [
      "read_file",
      "write_file",
      "read_file",
    ]);
    const fixture = await createTestAgent(modelStream, toolRunner);
    let maximumPendingApprovals = 0;
    fixture.agent.subscribe((event) => {
      if (event.type === "tool_approval_requested") {
        maximumPendingApprovals = Math.max(
          maximumPendingApprovals,
          fixture.agent.state.pendingToolApproval === null ? 0 : 1,
        );
        fixture.agent.respondToToolApproval(event.request.toolApprovalRequestId, "approve");
      }
    });

    await expect(fixture.agent.prompt("混合调用")).resolves.toEqual({ status: "completed" });

    expect(maximumActiveCount).toBe(1);
    expect(maximumPendingApprovals).toBe(1);
    expect(executionOrder).toEqual(toolCallIds(3));
  });

  it("aborts running readers and returns queued calls without starting them", async () => {
    const controlledRunner = createControlledReadOnlyRunner(6);
    const modelRequests: ModelRequest[] = [];
    const modelStream = createBatchModelStream(modelRequests, [
      "read_file",
      "glob",
      "grep",
      "read_file",
      "glob",
      "grep",
    ]);
    const fixture = await createTestAgent(modelStream, controlledRunner.toolRunner);
    const events: AgentEvent[] = [];
    fixture.agent.subscribe((event) => events.push(event));
    const promptResultPromise = fixture.agent.prompt("停止并发读取");

    await vi.waitFor(() => expect(controlledRunner.startedIndices).toHaveLength(4));
    fixture.agent.abort();

    await expect(promptResultPromise).resolves.toEqual({ status: "aborted" });
    expect(controlledRunner.startedIndices).toEqual([0, 1, 2, 3]);
    expect(controlledRunner.activeCount).toBe(0);
    expect(fixture.agent.state.messageHistory.filter((message) => message.role === "tool")).toEqual(
      toolCallIds(6).map((toolCallId) =>
        expect.objectContaining({ toolCallId, status: "aborted" }),
      ),
    );
    expect(events.filter((event) => event.type === "run_end")).toHaveLength(1);
    expect(fixture.agent.state.running).toBe(false);
    expect(modelRequests).toHaveLength(1);
  });

  it("stops waiting for preparation on abort", async () => {
    const preparationEntered = Promise.withResolvers<void>();
    const toolRunner: ToolRunner = Object.freeze({
      createPlan() {
        return Object.freeze({
          scheduling: "parallel_read_only",
          abortedPreparationContent: "preparation aborted",
          prepare: () => {
            preparationEntered.resolve();
            return new Promise<never>(() => undefined);
          },
        });
      },
    });
    const fixture = await createTestAgent(createBatchModelStream([], ["read_file"]), toolRunner);
    const promptResultPromise = fixture.agent.prompt("停止预检");
    await preparationEntered.promise;

    fixture.agent.abort();

    await expect(promptResultPromise).resolves.toEqual({ status: "aborted" });
    expect(fixture.agent.state.messageHistory.filter((message) => message.role === "tool")).toEqual(
      [expect.objectContaining({ status: "aborted", content: "preparation aborted" })],
    );
  });

  it("preserves a completed execution result when abort arrives after the effect", async () => {
    let abortAgent: (() => void) | undefined;
    const toolRunner: ToolRunner = Object.freeze({
      createPlan() {
        return Object.freeze({
          scheduling: "parallel_read_only",
          abortedPreparationContent: "preparation aborted",
          prepare: () =>
            Promise.resolve(
              Object.freeze({
                ok: true as const,
                preparedExecution: Object.freeze({
                  approval: null,
                  activitySummary: "path: file.txt",
                  executionUnavailableContent: "execution aborted",
                  async execute() {
                    abortAgent?.();
                    return Object.freeze({
                      status: "completed" as const,
                      content: "effect completed",
                      truncated: false,
                      cleanupUncertain: false,
                    });
                  },
                }),
              }),
            ),
        });
      },
    });
    const fixture = await createTestAgent(createBatchModelStream([], ["read_file"]), toolRunner);
    abortAgent = () => fixture.agent.abort();

    await expect(fixture.agent.prompt("完成后停止")).resolves.toEqual({ status: "aborted" });
    expect(fixture.agent.state.messageHistory.filter((message) => message.role === "tool")).toEqual(
      [expect.objectContaining({ status: "completed", content: "effect completed" })],
    );
  });
});

function createControlledReadOnlyRunner(callCount: number, failedIndex?: number) {
  const releases = Array.from({ length: callCount }, () => Promise.withResolvers<void>());
  const startedIndices: number[] = [];
  const completedIndices: number[] = [];
  let activeCount = 0;
  let maximumActiveCount = 0;
  const toolRunner: ToolRunner = Object.freeze({
    createPlan(toolCall) {
      const index = Number.parseInt(toolCall.toolCallId.slice(-12), 16) - 1;
      return Object.freeze({
        scheduling: "parallel_read_only",
        abortedPreparationContent: "preparation aborted",
        prepare: () =>
          Promise.resolve(
            Object.freeze({
              ok: true,
              preparedExecution: Object.freeze({
                approval: null,
                activitySummary: `path: file-${index}.txt`,
                executionUnavailableContent: "execution aborted",
                async execute(abortSignal: AbortSignal) {
                  startedIndices.push(index);
                  activeCount += 1;
                  maximumActiveCount = Math.max(maximumActiveCount, activeCount);
                  await waitForReleaseOrAbort(releases[index]?.promise, abortSignal);
                  activeCount -= 1;
                  completedIndices.push(index);
                  if (abortSignal.aborted) {
                    return Object.freeze({
                      status: "failed" as const,
                      content: "execution aborted",
                      truncated: false,
                      cleanupUncertain: false,
                    });
                  }
                  if (index === failedIndex) {
                    return Object.freeze({
                      status: "failed" as const,
                      content: `result-${index}`,
                      truncated: false,
                      cleanupUncertain: false,
                    });
                  }
                  return Object.freeze({
                    status: "completed" as const,
                    content: `result-${index}`,
                    truncated: false,
                    cleanupUncertain: false,
                  });
                },
              }),
            }),
          ),
      });
    },
  });
  return {
    toolRunner,
    releases,
    startedIndices,
    completedIndices,
    get activeCount() {
      return activeCount;
    },
    get maximumActiveCount() {
      return maximumActiveCount;
    },
  };
}

async function waitForReleaseOrAbort(
  releasePromise: Promise<void> | undefined,
  abortSignal: AbortSignal,
): Promise<void> {
  if (releasePromise === undefined || abortSignal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const finish = () => {
      abortSignal.removeEventListener("abort", finish);
      resolve();
    };
    abortSignal.addEventListener("abort", finish, { once: true });
    void releasePromise.then(finish);
  });
}

function createBatchModelStream(
  modelRequests: ModelRequest[],
  toolNames: readonly string[],
): ModelStream {
  return async function* (modelRequest) {
    modelRequests.push(modelRequest);
    if (modelRequests.length === 1) {
      for (const [index, toolName] of toolNames.entries()) {
        yield toolCallEvent(index + 1, toolName, { path: "file.txt" });
      }
      yield finishEvent("tool_calls");
      return;
    }
    yield { type: "text_delta", delta: "done" };
    yield finishEvent("stop");
  };
}

async function createTestAgent(modelStream: ModelStream, toolRunner: ToolRunner) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-tool-scheduling-"));
  temporaryDirectories.add(workspaceRoot);
  const sessionDirectory = resolveSessionDirectory(workspaceRoot, {});
  const shell = await resolveSessionShell(process.env);
  const session = await createSession({ workspaceRoot, sessionDirectory, shell });
  return Object.freeze({
    agent: createAgentWithModelStream({ modelStream, session, toolRunner }),
    sessionFilePath: join(session.storageDirectory, "session.jsonl"),
  });
}

function toolCallEvent(
  index: number,
  toolName: string,
  input: AssistantToolCallPart["input"],
): ModelStreamEvent {
  return Object.freeze({
    type: "tool_call",
    toolCallId: toolCallId(index),
    toolName,
    input,
    invalid: false,
  });
}

function toolCallIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => toolCallId(index + 1));
}

function toolCallId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function finishEvent(finishReason: "stop" | "tool_calls"): ModelStreamEvent {
  return Object.freeze({ type: "finish", finishReason });
}
