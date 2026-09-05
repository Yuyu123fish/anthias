import { describe, expect, it } from "vitest";
import type { ContextBudget } from "../src/context/budget.js";
import { generateCompactionSummary } from "../src/context/compaction.js";
import type { ContextMessageEntry } from "../src/context/selection.js";
import type {
  ModelRequest,
  ModelStream,
  ModelStreamEvent,
  ModelUsage,
} from "../src/model/model-stream.js";
import {
  COMPACTION_SECTION_TITLES,
  validateCompactionSummary,
} from "../src/prompts/compaction-prompt.js";

function createBudget(
  contextWindow = 2_000,
  safetyTokens = 100,
  summaryOutputTokens = 400,
): ContextBudget {
  return Object.freeze({
    contextWindow,
    safetyTokens,
    responseOutputTokens: 1_000,
    summaryOutputTokens,
    retainedTokens: 500,
  });
}

function createEntry(entryId: string, seq: number, content: string): ContextMessageEntry {
  return Object.freeze({
    entryId,
    seq,
    message: Object.freeze({ role: "user" as const, content }),
  });
}

function createValidSummary(suffix = "已确认"): string {
  return COMPACTION_SECTION_TITLES.map(
    (title) =>
      "## " +
      title +
      "\n事实：来源已确认。" +
      suffix +
      "\n计划：继续依据后续完整来源推进。" +
      "\n不确定：等待后续事实或纠正。",
  ).join("\n");
}

function createUsage(inputTokens = 10): ModelUsage {
  return Object.freeze({
    inputTokens,
    outputTokens: 20,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
  });
}

function createFinishEvent(
  finishReason: "stop" | "length" = "stop",
  usage?: ModelUsage,
): ModelStreamEvent {
  return Object.freeze({
    type: "finish",
    finishReason,
    ...(usage === undefined ? {} : { usage }),
  }) as ModelStreamEvent;
}

function createStream(events: readonly ModelStreamEvent[]): ModelStream {
  return async function* () {
    yield* events;
  };
}

function getRequestContent(request: ModelRequest | undefined): string {
  const firstMessage = request?.messages[0];
  if (firstMessage?.role !== "user") {
    throw new Error("expected a compaction user message");
  }
  return firstMessage.content;
}

describe("generateCompactionSummary", () => {
  it("batches complete groups, carries the prior summary, strips reasoning, and records usage", async () => {
    const modelRequests: ModelRequest[] = [];
    const usages: Array<ModelUsage | undefined> = [];
    let responseNumber = 0;
    const modelStream: ModelStream = async function* (request) {
      modelRequests.push(request);
      responseNumber += 1;
      yield Object.freeze({
        type: "text_delta" as const,
        delta: createValidSummary("round-" + responseNumber),
      });
      yield createFinishEvent("stop", createUsage(responseNumber));
    };
    const reasoningEntry = Object.freeze({
      entryId: "reasoning-entry",
      seq: 4,
      message: Object.freeze({
        role: "assistant" as const,
        content: Object.freeze([
          Object.freeze({ type: "reasoning" as const, text: "private reasoning must not be sent" }),
          Object.freeze({ type: "text" as const, text: "visible assistant fact" }),
        ]),
      }),
    }) as unknown as ContextMessageEntry;
    const groups = Object.freeze([
      Object.freeze([createEntry("entry-1", 1, "first source " + "a".repeat(2_200))]),
      Object.freeze([createEntry("entry-2", 2, "second source " + "b".repeat(2_200))]),
      Object.freeze([reasoningEntry]),
    ]);

    const summary = await generateCompactionSummary({
      groups,
      previousSummary: createValidSummary("previous"),
      modelStream,
      budget: createBudget(),
      abortSignal: new AbortController().signal,
      onUsage: async (usage) => {
        usages.push(usage);
      },
    });

    expect(summary).toBe(createValidSummary("round-3"));
    expect(modelRequests).toHaveLength(3);
    expect(modelRequests.every((request) => request.tools.length === 0)).toBe(true);
    expect(
      modelRequests.every(
        (request) =>
          (request as ModelRequest & { purpose?: string }).purpose === "compaction" &&
          (request as ModelRequest & { maxOutputTokens?: number }).maxOutputTokens === 400,
      ),
    ).toBe(true);
    expect(getRequestContent(modelRequests[0])).toContain("entry-1");
    expect(getRequestContent(modelRequests[0])).not.toContain("entry-2");
    expect(getRequestContent(modelRequests[1])).toContain("entry-2");
    expect(getRequestContent(modelRequests[1])).toContain(createValidSummary("round-1"));
    expect(getRequestContent(modelRequests[1])).not.toContain("entry-1");
    expect(getRequestContent(modelRequests[2])).toContain("reasoning-entry");
    expect(getRequestContent(modelRequests[2])).toContain("visible assistant fact");
    expect(getRequestContent(modelRequests[2])).not.toContain("private reasoning must not be sent");
    expect(usages).toEqual([createUsage(1), createUsage(2), createUsage(3)]);
    expect(validateCompactionSummary(summary)).toBe(true);
  });

  it.each([
    { finishReason: "length" as const, responseText: createValidSummary("length") },
    { finishReason: "stop" as const, responseText: "not a six section summary" },
  ])(
    "rejects a response without an acceptable summary terminal",
    async ({ finishReason, responseText }) => {
      const usages: Array<ModelUsage | undefined> = [];
      const result = generateCompactionSummary({
        groups: Object.freeze([Object.freeze([createEntry("entry-1", 1, "source")])]),
        previousSummary: null,
        modelStream: createStream([
          Object.freeze({ type: "text_delta" as const, delta: responseText }),
          createFinishEvent(finishReason, createUsage()),
        ]),
        budget: createBudget(),
        abortSignal: new AbortController().signal,
        onUsage: async (usage) => {
          usages.push(usage);
        },
      });

      await expect(result).rejects.toMatchObject({
        name: "CompactionError",
        reason: "invalid_summary",
      });
      expect(usages).toEqual([createUsage()]);
    },
  );

  it("rejects ToolCall output and still accounts for the completed request", async () => {
    const usages: Array<ModelUsage | undefined> = [];
    const result = generateCompactionSummary({
      groups: Object.freeze([Object.freeze([createEntry("entry-1", 1, "source")])]),
      previousSummary: null,
      modelStream: createStream([
        Object.freeze({ type: "text_delta" as const, delta: createValidSummary() }),
        Object.freeze({
          type: "tool_call" as const,
          toolCallId: "tool-call",
          toolName: "read_file",
          input: {},
          invalid: false,
        }),
        createFinishEvent("stop", createUsage()),
      ]),
      budget: createBudget(),
      abortSignal: new AbortController().signal,
      onUsage: async (usage) => {
        usages.push(usage);
      },
    });

    await expect(result).rejects.toMatchObject({
      reason: "invalid_summary",
    });
    expect(usages).toEqual([createUsage()]);
  });

  it("fails before calling the model when one complete group cannot fit", async () => {
    let modelCallCount = 0;
    const usages: Array<ModelUsage | undefined> = [];
    await expect(
      generateCompactionSummary({
        groups: Object.freeze([Object.freeze([createEntry("huge-entry", 1, "x".repeat(20_000))])]),
        previousSummary: null,
        modelStream: async function* () {
          modelCallCount += 1;
          yield createFinishEvent();
        },
        budget: createBudget(500, 100, 200),
        abortSignal: new AbortController().signal,
        onUsage: async (usage) => {
          usages.push(usage);
        },
      }),
    ).rejects.toMatchObject({
      reason: "input_too_large",
    });
    expect(modelCallCount).toBe(0);
    expect(usages).toEqual([]);
  });

  it("cancels an active request, records unknown usage once, and stops", async () => {
    const abortController = new AbortController();
    const started = Promise.withResolvers<void>();
    const usages: Array<ModelUsage | undefined> = [];
    const modelStream: ModelStream = async function* (_request, abortSignal) {
      started.resolve();
      await new Promise<void>((resolve) => {
        abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
    };

    const result = generateCompactionSummary({
      groups: Object.freeze([Object.freeze([createEntry("entry-1", 1, "source")])]),
      previousSummary: null,
      modelStream,
      budget: createBudget(),
      abortSignal: abortController.signal,
      onUsage: async (usage) => {
        usages.push(usage);
      },
    });
    await started.promise;
    abortController.abort();

    await expect(result).rejects.toMatchObject({
      reason: "cancelled",
    });
    expect(usages).toEqual([undefined]);
  });

  it("stops after eight advancing summary stages", async () => {
    const modelRequests: ModelRequest[] = [];
    const usages: Array<ModelUsage | undefined> = [];
    const groups = Object.freeze(
      Array.from({ length: 9 }, (_, index) =>
        Object.freeze([createEntry("entry-" + index, index, "source-" + "x".repeat(2_200))]),
      ),
    );
    const result = generateCompactionSummary({
      groups,
      previousSummary: null,
      modelStream: async function* (request) {
        modelRequests.push(request);
        yield Object.freeze({
          type: "text_delta" as const,
          delta: createValidSummary("stage"),
        });
        yield createFinishEvent("stop", createUsage());
      },
      budget: createBudget(),
      abortSignal: new AbortController().signal,
      onUsage: async (usage) => {
        usages.push(usage);
      },
    });

    await expect(result).rejects.toMatchObject({
      reason: "no_progress",
    });
    expect(modelRequests).toHaveLength(8);
    expect(usages).toHaveLength(8);
  });
});
