import { type Agent, createAgentWithModelStream } from "./agent.js";
import { readModelConfig } from "./model-config.js";
import { createOpenAICompatibleModelStream } from "./openai-compatible-model.js";
import {
  createSession,
  openSession,
  resolveSessionDirectory,
  resolveSessionShell,
} from "./session.js";

/** 重新导出交互 Adapter 所需的公开 Agent 类型。 */
export type {
  ActiveRun,
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

/** 表示生产 Agent 已成功装配或以安全文本启动失败。 */
export type AgentCreationResult =
  | Readonly<{ ok: true; agent: Agent }>
  | Readonly<{ ok: false; error: string }>;

/** 配置生产 Agent 的环境、工作区以及可选 Session。 */
export type CreateAgentFromEnvironmentOptions = Readonly<{
  environment?: NodeJS.ProcessEnv;
  workspaceRoot?: string;
  sessionId?: string;
}>;

const SAFE_SESSION_STARTUP_ERROR =
  "Session 启动失败，请检查 Session ID、工作区与本地 Session 文件。";

/** 先校验模型配置，再创建或打开 Session 并装配生产 Agent。 */
export async function createAgentFromEnvironment({
  environment = process.env,
  workspaceRoot = process.cwd(),
  sessionId,
}: CreateAgentFromEnvironmentOptions = {}): Promise<AgentCreationResult> {
  const modelConfigResult = readModelConfig(environment);
  if (!modelConfigResult.ok) {
    return modelConfigResult;
  }

  try {
    const sessionDirectory = resolveSessionDirectory(environment);
    const shell = await resolveSessionShell(environment);
    const session =
      sessionId === undefined
        ? await createSession({ workspaceRoot, sessionDirectory, shell })
        : await openSession({ sessionId, workspaceRoot, sessionDirectory, shell });

    return Object.freeze({
      ok: true,
      agent: createAgentWithModelStream({
        modelStream: createOpenAICompatibleModelStream(modelConfigResult.config),
        session,
      }),
    });
  } catch {
    return Object.freeze({ ok: false, error: SAFE_SESSION_STARTUP_ERROR });
  }
}
