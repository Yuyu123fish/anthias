import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { readModelConfig } from "./model-config.js";
import { createOpenAICompatibleModelStream } from "./openai-compatible-model.js";
import type { PermissionMode } from "./permission-mode.js";
import { type Agent, createAgentWithModelStream } from "./run.js";
import {
  createSession,
  InvalidSessionError,
  openSession,
  resolveSessionShell,
  SessionBusyError,
  SessionChangedError,
  SessionShellUnavailableError,
  SessionWorkspaceMismatchError,
} from "./session/index.js";

/** 重新导出交互 Adapter 需要呈现的公开 Message 类型。 */
export type {
  AssistantContentPart,
  AssistantMessage,
  AssistantTextPart,
  AssistantToolCallPart,
  Message,
  ToolResultMessage,
  UserMessage,
} from "./message.js";
/** 重新导出交互 Adapter 所需的公开 Agent 类型。 */
export type {
  ActiveRun,
  Agent,
  AgentEvent,
  AgentListener,
  AgentState,
  FinishedPromptResult,
  PermissionMode,
  PermissionModeChangeResult,
  PromptResult,
  RunPhase,
  ToolActivity,
  ToolApprovalRequest,
  ToolApprovalResponse,
} from "./run.js";

/** 表示生产 Agent 已成功装配或以安全文本启动失败。 */
export type AgentCreationFailureReason =
  | "model_configuration"
  | "workspace_unavailable"
  | "session_busy"
  | "session_changed"
  | "workspace_mismatch"
  | "invalid_session"
  | "shell_unavailable"
  | "storage_unavailable";

export type AgentCreationFailure = Readonly<{
  ok: false;
  reason: AgentCreationFailureReason;
  error: string;
}>;

export type AgentCreationResult = Readonly<{ ok: true; agent: Agent }> | AgentCreationFailure;

/** 配置生产 Agent 的环境、工作区以及可选 Session。 */
export type CreateAgentFromEnvironmentOptions = Readonly<{
  environment?: NodeJS.ProcessEnv;
  workspaceRoot: string;
  sessionDirectory: string;
  sessionId?: string;
  permissionMode?: PermissionMode | undefined;
}>;

/** 先校验模型配置，再创建或打开 Session 并装配生产 Agent。 */
export async function createAgentFromEnvironment({
  environment = process.env,
  workspaceRoot,
  sessionDirectory,
  sessionId,
  permissionMode,
}: CreateAgentFromEnvironmentOptions): Promise<AgentCreationResult> {
  const modelConfigResult = readModelConfig(environment);
  if (!modelConfigResult.ok) {
    return createAgentCreationFailure("model_configuration", modelConfigResult.error);
  }

  let normalizedWorkspaceRoot: string;
  try {
    normalizedWorkspaceRoot = await realpath(workspaceRoot);
    if (!(await stat(normalizedWorkspaceRoot)).isDirectory()) {
      throw new Error("workspace is not a directory");
    }
  } catch {
    return createAgentCreationFailure(
      "workspace_unavailable",
      "Workspace 必须是存在且可访问的目录。",
    );
  }
  if (!isAbsolute(sessionDirectory)) {
    return createAgentCreationFailure("storage_unavailable", "Session Directory 必须是绝对路径。");
  }
  const normalizedSessionDirectory = resolve(sessionDirectory);

  try {
    const shell = await resolveSessionShell(environment);
    const session =
      sessionId === undefined
        ? await createSession({
            workspaceRoot: normalizedWorkspaceRoot,
            sessionDirectory: normalizedSessionDirectory,
            shell,
          })
        : await openSession({
            sessionId,
            workspaceRoot: normalizedWorkspaceRoot,
            sessionDirectory: normalizedSessionDirectory,
            shell,
          });

    return Object.freeze({
      ok: true,
      agent: createAgentWithModelStream({
        modelStream: createOpenAICompatibleModelStream(modelConfigResult.config),
        session,
        permissionMode,
      }),
    });
  } catch (error) {
    if (error instanceof SessionBusyError) {
      return createAgentCreationFailure("session_busy", "Session 正被其他进程使用，请稍后重试。");
    }
    if (error instanceof SessionChangedError) {
      return createAgentCreationFailure(
        "session_changed",
        "Session 文件在启动期间发生变化，请重新打开 Session。",
      );
    }
    if (error instanceof SessionWorkspaceMismatchError) {
      return createAgentCreationFailure(
        "workspace_mismatch",
        `Session 属于工作区 ${renderSafePath(error.recordedWorkspaceRoot)}，当前工作区是 ${renderSafePath(error.requestedWorkspaceRoot)}。请回到原工作区或创建新 Session。`,
      );
    }
    if (error instanceof SessionShellUnavailableError) {
      return createAgentCreationFailure(
        "shell_unavailable",
        "Session Shell 不可用或与记录不一致，请检查本机 Shell。",
      );
    }
    if (isStorageUnavailableError(error)) {
      return createAgentCreationFailure(
        "storage_unavailable",
        "Session 存储不可用，请检查 Anthias data 目录权限与磁盘状态。",
      );
    }
    if (error instanceof InvalidSessionError || sessionId !== undefined) {
      return createAgentCreationFailure(
        "invalid_session",
        "Session ID 或 Session 文件无效，请检查后重试。",
      );
    }
    return createAgentCreationFailure(
      "storage_unavailable",
      "Session 存储不可用，请检查 Anthias data 目录权限与磁盘状态。",
    );
  }
}

/** 只依据稳定 errno 区分存储不可用，不把底层路径或异常文本带到界面。 */
function isStorageUnavailableError(error: unknown): boolean {
  const errorCode = (error as NodeJS.ErrnoException).code;
  return (
    errorCode === "EACCES" ||
    errorCode === "EPERM" ||
    errorCode === "EIO" ||
    errorCode === "ENOSPC" ||
    errorCode === "EROFS" ||
    errorCode === "EMFILE" ||
    errorCode === "ENFILE" ||
    errorCode === "ENOTDIR"
  );
}

/** 路径仍可辨认，但不能借控制字符改写终端输出。 */
function renderSafePath(path: string): string {
  return [...path]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? "�" : character;
    })
    .join("");
}

/** 统一冻结安全的生产启动失败，避免透传异常或敏感配置。 */
function createAgentCreationFailure(
  reason: AgentCreationFailureReason,
  error: string,
): AgentCreationFailure {
  return Object.freeze({ ok: false, reason, error });
}
