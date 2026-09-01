import { describe, expect, it } from "vitest";
import { createAgentFromEnvironment } from "../src/index.js";

describe("createAgentFromEnvironment", () => {
  it("returns a safe error when model configuration is missing", () => {
    const creationResult = createAgentFromEnvironment({
      ANTHIAS_MODEL_API_KEY: "secret-value",
    });

    expect(creationResult).toEqual({
      ok: false,
      error: "缺少模型配置：ANTHIAS_MODEL_BASE_URL、ANTHIAS_MODEL_ID。请通过本地环境变量提供。",
    });
    expect(JSON.stringify(creationResult)).not.toContain("secret-value");
  });

  it("creates an idle Agent from valid environment configuration", () => {
    const creationResult = createAgentFromEnvironment({
      ANTHIAS_MODEL_BASE_URL: "https://example.com/v1/",
      ANTHIAS_MODEL_ID: "model-id",
      ANTHIAS_MODEL_API_KEY: "local-key",
    });

    expect(creationResult.ok).toBe(true);
    if (creationResult.ok) {
      expect(creationResult.agent.state).toEqual({
        messageHistory: [],
        activeAssistantMessage: null,
        running: false,
        lastError: null,
      });
    }
  });
});
