import { type Agent, createAgentWithModelStream } from "./agent.js";
import { readModelConfig } from "./model-config.js";
import { createOpenAICompatibleModelStream } from "./openai-compatible-model.js";

export type {
  Agent,
  AgentEvent,
  AgentListener,
  AgentState,
  AssistantMessage,
  FinishedPromptResult,
  Message,
  PromptResult,
  UserMessage,
} from "./agent.js";

export type AgentCreationResult =
  | Readonly<{ ok: true; agent: Agent }>
  | Readonly<{ ok: false; error: string }>;

/** 从本地环境创建生产 Agent；配置无效时返回可直接展示的安全错误。 */
export function createAgentFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): AgentCreationResult {
  const modelConfigResult = readModelConfig(environment);
  if (!modelConfigResult.ok) {
    return modelConfigResult;
  }

  return Object.freeze({
    ok: true,
    agent: createAgentWithModelStream({
      modelStream: createOpenAICompatibleModelStream(modelConfigResult.config),
    }),
  });
}
