import type { RunDiagnostic } from "@anthias/agent";
import { describe, expect, it } from "vitest";
import { formatModelRecovery, formatRunDiagnostic } from "../src/diagnostic-view.js";

const usage = {
  inputTokens: 500,
  outputTokens: 200,
  cachedInputTokens: 0,
  cacheWriteInputTokens: null,
};
const diagnostic: RunDiagnostic = {
  category: "invalid_request",
  summary: "模型请求参数无效。",
  providerFinishReason: null,
  usage,
  retryCount: 0,
  abortSource: null,
  httpStatus: 400,
  retryStopReason: null,
};

describe("safe run diagnostic display", () => {
  it("shows safe provider fields, request structure and reasoning usage while preserving unknown history", () => {
    const current = formatRunDiagnostic({
      ...diagnostic,
      providerErrorCode: "missing_reasoning_content",
      providerErrorParam: "messages[].reasoning_content",
      usage: { ...usage, reasoningTokens: 150 },
      requestSummary: {
        purpose: "response",
        maxOutputTokens: 16000,
        messageCount: 4,
        toolDefinitionCount: 6,
        toolCallCount: 1,
        toolResultCount: 0,
        reasoningMessageCount: 0,
        unpairedToolCallCount: 1,
        unexpectedToolResultCount: 0,
      },
    });
    expect(current).toContain("missing_reasoning_content");
    expect(current).toContain("messages[].reasoning_content");
    expect(current).toContain("思考 150 tokens");
    expect(current).toContain("消息 4（含 system）");
    expect(current).toContain("未配对调用 1");
    expect(current).toContain("携带 Reasoning 的消息：0");
    const historical = formatRunDiagnostic(diagnostic);
    expect(historical).toContain("Provider 错误码：未知 · 参数：未知");
    expect(historical).toContain("思考 未知 tokens");
    expect(historical).toContain("请求结构：未知");
  });
});

it("distinguishes bounded approval recovery from same-run continuation without asking to continue", () => {
  const event = {
    type: "model_retry" as const,
    runId: "run",
    phase: "waiting" as const,
    retryCount: 1 as const,
    delayMs: 500,
    diagnostic,
  };
  expect(formatModelRecovery({ ...event, recoveryKind: "approval" }).status).toBe(
    "等待审核恢复 1/1",
  );
  const recovery = formatModelRecovery({ ...event, recoveryKind: "continuation" });
  expect(recovery.status).toBe("等待任务续跑 1/2");
  expect(recovery.detail).toContain("实际工具结果");
  expect(recovery.detail).not.toContain("/continue");
});

it("preserves the approval failure source alongside provider diagnostics", () => {
  const error = "自动审核技术故障：模型配置不可用。";
  expect(formatRunDiagnostic(diagnostic, error)).toContain(error);
  expect(formatRunDiagnostic(undefined, error)).toContain(error);
});
