import { describe, expect, it } from "vitest";
import { readModelConfig } from "../src/model/model-config.js";

describe("readModelConfig", () => {
  it("reports missing variable names without exposing values", () => {
    const configResult = readModelConfig({
      ANTHIAS_MODEL_API_KEY: "secret-value",
    });

    expect(configResult).toEqual({
      ok: false,
      error: "缺少模型配置：ANTHIAS_MODEL_BASE_URL、ANTHIAS_MODEL_ID。请通过本地环境变量提供。",
    });
    expect(JSON.stringify(configResult)).not.toContain("secret-value");
  });

  it.each(["not-a-url", "file:///tmp/model", "ftp://example.com/model"])(
    "rejects a locally invalid base URL: %s",
    (baseURL) => {
      const configResult = readModelConfig({
        ANTHIAS_MODEL_BASE_URL: baseURL,
        ANTHIAS_MODEL_ID: "model-id",
        ANTHIAS_MODEL_API_KEY: "secret-value",
      });

      expect(configResult).toEqual({
        ok: false,
        error: "模型配置格式错误：ANTHIAS_MODEL_BASE_URL 必须是有效的 http 或 https URL。",
      });
      expect(JSON.stringify(configResult)).not.toContain("secret-value");
    },
  );

  it("returns the validated model configuration", () => {
    expect(
      readModelConfig({
        ANTHIAS_MODEL_BASE_URL: "https://example.com/v1/",
        ANTHIAS_MODEL_ID: "model-id",
        ANTHIAS_MODEL_API_KEY: "local-key",
        ANTHIAS_MODEL_CONTEXT_WINDOW: "128000",
      }),
    ).toEqual({
      ok: true,
      config: {
        baseURL: "https://example.com/v1",
        modelId: "model-id",
        apiKey: "local-key",
        capabilities: { contextWindow: 128_000 },
        contextBudget: {
          contextWindow: 128_000,
          safetyTokens: 20_000,
          responseOutputTokens: 64_000,
          summaryOutputTokens: 8_000,
          retainedTokens: 32_000,
        },
      },
    });
  });

  it("uses verified capabilities for the known model without model-specific provider behavior", () => {
    const result = readModelConfig({
      ...VALID_ENVIRONMENT,
      ANTHIAS_MODEL_ID: "deepseek-v4-flash",
    });
    expect(result).toMatchObject({
      ok: true,
      config: {
        capabilities: { contextWindow: 1_048_576, maxOutputTokens: 384_000 },
        contextBudget: { safetyTokens: 20_000, responseOutputTokens: 64_000 },
      },
    });
  });

  it("validates independent optional reasoning efforts without echoing invalid values", () => {
    const environment = { ...VALID_ENVIRONMENT, ANTHIAS_MODEL_CONTEXT_WINDOW: "128000" };
    expect(
      readModelConfig({
        ...environment,
        ANTHIAS_RESPONSE_REASONING_EFFORT: " high ",
        ANTHIAS_APPROVAL_REASONING_EFFORT: "low",
      }),
    ).toMatchObject({
      ok: true,
      config: { responseReasoningEffort: "high", approvalReasoningEffort: "low" },
    });
    const defaultResult = readModelConfig(environment);
    if (!defaultResult.ok) throw new Error("expected valid configuration");
    expect(defaultResult.config).not.toHaveProperty("responseReasoningEffort");
    expect(defaultResult.config).not.toHaveProperty("approvalReasoningEffort");
    for (const name of ["ANTHIAS_RESPONSE_REASONING_EFFORT", "ANTHIAS_APPROVAL_REASONING_EFFORT"]) {
      const result = readModelConfig({ ...environment, [name]: "synthetic-secret-effort" });
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining(name) });
      expect(JSON.stringify(result)).not.toContain("synthetic-secret-effort");
    }
  });

  it("requires an explicit context window for an unknown production model", () => {
    const result = readModelConfig(VALID_ENVIRONMENT);
    expect(result).toEqual({
      ok: false,
      error: "未知模型需要配置 ANTHIAS_MODEL_CONTEXT_WINDOW。",
    });
    expect(JSON.stringify(result)).not.toContain("local-key");
  });

  it("keeps explicit capability and application strategy overrides distinct", () => {
    expect(
      readModelConfig({
        ...VALID_ENVIRONMENT,
        ANTHIAS_MODEL_CONTEXT_WINDOW: "128000",
        ANTHIAS_MODEL_MAX_OUTPUT_TOKENS: "4000",
        ANTHIAS_COMPACTION_MAX_TOKENS: "2000",
        ANTHIAS_CONTEXT_KEEP_TOKENS: "12000",
      }),
    ).toMatchObject({
      ok: true,
      config: {
        capabilities: { contextWindow: 128_000, maxOutputTokens: 4_000 },
        contextBudget: {
          responseOutputTokens: 4_000,
          summaryOutputTokens: 2_000,
          retainedTokens: 12_000,
        },
      },
    });
  });

  it.each([
    ["ANTHIAS_MODEL_CONTEXT_WINDOW", "0"],
    ["ANTHIAS_MODEL_MAX_OUTPUT_TOKENS", "-1"],
    ["ANTHIAS_RESPONSE_MAX_TOKENS", "1.5"],
    ["ANTHIAS_COMPACTION_MAX_TOKENS", "NaN"],
    ["ANTHIAS_CONTEXT_KEEP_TOKENS", "9007199254740992"],
  ] as const)("rejects invalid %s before startup", (name, value) => {
    const result = readModelConfig({
      ...VALID_ENVIRONMENT,
      ANTHIAS_MODEL_CONTEXT_WINDOW: "128000",
      [name]: value,
    });
    expect(result).toEqual({
      ok: false,
      error: `模型配置格式错误：${name} 必须是正整数 token 数。`,
    });
  });

  it("rejects explicit output strategy above declared model capability", () => {
    expect(
      readModelConfig({
        ...VALID_ENVIRONMENT,
        ANTHIAS_MODEL_CONTEXT_WINDOW: "128000",
        ANTHIAS_MODEL_MAX_OUTPUT_TOKENS: "4000",
        ANTHIAS_RESPONSE_MAX_TOKENS: "5000",
      }),
    ).toEqual({
      ok: false,
      error: "显式模型输出预算超过已声明的模型输出能力。",
    });
  });
});

const VALID_ENVIRONMENT = {
  ANTHIAS_MODEL_BASE_URL: "https://example.com/v1",
  ANTHIAS_MODEL_ID: "custom-model",
  ANTHIAS_MODEL_API_KEY: "local-key",
} as const;
