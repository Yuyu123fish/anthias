import { describe, expect, it } from "vitest";
import {
  createContextBudget,
  estimateModelMessageTokens,
  estimateModelRequestTokens,
  estimateTextTokens,
} from "../src/context/budget.js";
import type { ModelInputMessage } from "../src/model/model-stream.js";
import { FIXED_TOOL_DEFINITIONS } from "../src/tool/definitions.js";

describe("context budget", () => {
  it("retains the fixed safety margin and default response, summary, and source budgets", () => {
    expect(createContextBudget({ contextWindow: 128_000 })).toEqual({
      contextWindow: 128_000,
      safetyTokens: 20_000,
      responseOutputTokens: 64_000,
      summaryOutputTokens: 8_000,
      retainedTokens: 32_000,
    });
  });

  it("bounds default outputs by capability while rejecting an explicit excess", () => {
    expect(createContextBudget({ contextWindow: 128_000, maxOutputTokens: 4_000 })).toMatchObject({
      responseOutputTokens: 4_000,
      summaryOutputTokens: 4_000,
    });
    expect(() =>
      createContextBudget(
        { contextWindow: 128_000, maxOutputTokens: 4_000 },
        { summaryOutputTokens: 4_001 },
      ),
    ).toThrow("超过");
  });

  it("keeps an explicit response budget while leaving compaction unchanged", () => {
    expect(
      createContextBudget({ contextWindow: 128_000 }, { responseOutputTokens: 16_000 }),
    ).toMatchObject({
      responseOutputTokens: 16_000,
      summaryOutputTokens: 8_000,
    });
  });

  it("preserves working small-window defaults and rejects an explicit over-allocation", () => {
    expect(createContextBudget({ contextWindow: 64_000 })).toMatchObject({
      responseOutputTokens: 16_000,
      summaryOutputTokens: 8_000,
    });
    expect(() =>
      createContextBudget({ contextWindow: 64_000 }, { responseOutputTokens: 64_000 }),
    ).toThrow("无法同时容纳");
  });

  it("rejects a window with no input space at the exact safety and output boundary", () => {
    expect(() => createContextBudget({ contextWindow: 36_000 })).toThrow("无法同时容纳");
    expect(createContextBudget({ contextWindow: 36_001 }).contextWindow).toBe(36_001);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid capacity %s",
    (contextWindow) => expect(() => createContextBudget({ contextWindow })).toThrow("正整数"),
  );

  it("estimates Chinese characters and ASCII runs without counting UTF-8 bytes", () => {
    expect(estimateTextTokens("中文")).toBe(2);
    expect(estimateTextTokens("abcdef")).toBe(2);
    expect(estimateTextTokens("ab中cd")).toBe(3);
  });

  it("includes tools and transient reasoning in complete request estimates", () => {
    const message: ModelInputMessage = { role: "user", content: "检查工作区" };
    const request = { systemPrompt: "固定指令", messages: [message], tools: [] };
    const baseTokens = estimateModelRequestTokens(request);
    expect(baseTokens).toBeGreaterThan(
      estimateTextTokens(request.systemPrompt) + estimateTextTokens(message.content),
    );
    expect(
      estimateModelRequestTokens({ ...request, tools: FIXED_TOOL_DEFINITIONS }),
    ).toBeGreaterThan(baseTokens);
    expect(
      estimateModelMessageTokens({
        role: "assistant",
        content: [{ type: "reasoning", text: "思考".repeat(100) }],
      }),
    ).toBeGreaterThan(200);
  });

  it("does not estimate local artifact metadata that the adapter never sends", () => {
    const toolMessage: ModelInputMessage = {
      role: "tool",
      toolCallId: "00000000-0000-4000-8000-000000000001",
      toolName: "execute_command",
      content: "完成",
      status: "completed",
      truncated: true,
    };
    expect(
      estimateModelMessageTokens({
        ...toolMessage,
        artifact: {
          artifactId: "00000000-0000-4000-8000-000000000002",
          toolCallId: toolMessage.toolCallId,
          byteLength: 1_000_000,
          complete: true,
        },
      }),
    ).toBe(estimateModelMessageTokens(toolMessage));
  });
});
