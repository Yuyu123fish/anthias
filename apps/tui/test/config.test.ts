import { describe, expect, it } from "vitest";
import { readModelConfig } from "../src/config.js";

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
      }),
    ).toEqual({
      ok: true,
      config: {
        baseURL: "https://example.com/v1",
        modelId: "model-id",
        apiKey: "local-key",
      },
    });
  });
});
