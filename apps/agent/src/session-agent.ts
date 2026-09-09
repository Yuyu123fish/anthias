import { createHash, randomUUID } from "node:crypto";
import type { AgentOperation } from "./agent-controls.js";
import {
  type AgentLoopEvent,
  type AgentLoopResult,
  type AgentLoopToolApproval,
  runAgentLoop,
} from "./agent-loop.js";
import { type ContextBudget, createContextBudget } from "./context/budget.js";
import { type ContextUsage, createContextController } from "./context/index.js";
import { agentInputMessage } from "./context/projection.js";
import { createContextSources } from "./context/sources.js";
import { createExternalCapabilities } from "./external-capabilities.js";
import type { McpConnections } from "./mcp/index.js";
import type { Memory } from "./memory/index.js";
import type {
  AssistantMessage,
  AssistantToolCallPart,
  JsonValue,
  Message,
  RunDiagnostic,
  UserMessage,
} from "./message.js";
import { createRunDiagnostic } from "./model/model-diagnostics.js";
import {
  type ModelRequest,
  ModelRequestError,
  type ModelStream,
  type ModelUsage,
} from "./model/model-stream.js";
import type { CollaborationSnapshot } from "./multi-agent/index.js";
import { reviewToolApproval } from "./permission/auto-review.js";
import { DEFAULT_PERMISSION_MODE, type PermissionMode } from "./permission/permission-mode.js";
import type { WorkspacePermissions } from "./permission/workspace-permissions.js";
import {
  createCodingEnvironmentPrompt,
  createCodingSystemPrompt,
} from "./prompts/coding-system-prompt.js";
import { createSessionArtifactStore } from "./session/artifacts.js";
import type { SessionCleanupResult } from "./session/cleanup.js";
import type { AgentInputDetails, Session, SessionRunLease } from "./session/index.js";
import { isSideEffectToolName, type SessionRecord } from "./session/schema.js";
import type { SkillLibrary } from "./skill/index.js";
import type { AgentToolExtension } from "./tool/managed-tool.js";
import { createMemoryTools, type MaintainMemory } from "./tool/memory-tools.js";
import {
  type AgentTool,
  type CreateToolRunnerOptions,
  createBaseTools,
  createToolRunnerFromTools,
  rejectUnavailableBaseTool,
  type ToolApprovalPlan,
  type ToolRunner,
} from "./tool/tool-runner.js";

export type { PermissionMode } from "./permission/permission-mode.js";
export type RunPhase =
  | "requesting_model"
  | "retrying_model"
  | "compacting"
  | "reviewing_tool"
  | "awaiting_tool_approval"
  | "executing_tool";
export type ActiveRun = Readonly<{
  runId: string;
  phase: RunPhase;
}>;
export type ToolActivity = Readonly<{
  toolCallId: string;
  toolName: string;
  summary: string;
}>;
export type ToolApprovalRequest = Readonly<{
  toolApprovalRequestId: string;
  toolCallId: string;
  toolName: string;
  memberSessionId?: string;
  memberName?: string;
  workspaceRoot?: string;
  target: string;
  preview: string;
  permissionMode: PermissionMode;
  riskSummary: string;
  executionBoundary: string;
}>;
export type ToolApprovalResponse =
  | Readonly<{ status: "accepted" }>
  | Readonly<{ status: "rejected"; reason: "not_pending" | "request_mismatch" }>;
export type PermissionModeChangeResult =
  | Readonly<{ status: "accepted"; permissionMode: PermissionMode }>
  | Readonly<{ status: "rejected"; reason: "busy" | "closed" }>;
export type AgentState = Readonly<{
  sessionId: string;
  workspaceRoot: string;
  permissionMode: PermissionMode;
  contextUsage: ContextUsage;
  operation: AgentOperation;
  messageHistory: readonly Message[];
  activeAssistantMessage: AssistantMessage | null;
  activeRun: ActiveRun | null;
  pendingToolApproval: ToolApprovalRequest | null;
  running: boolean;
  lastError: string | null;
  lastRunDiagnostic?: RunDiagnostic | null;
  collaboration?: CollaborationSnapshot;
}>;
export type FinishedPromptResult =
  | Readonly<{ status: "completed" }>
  | Readonly<{ status: "aborted" }>
  | Readonly<{ status: "failed"; error: string }>;
export type PromptResult =
  | Readonly<{
      status: "rejected";
      reason: "empty" | "busy" | "session_busy" | "session_changed" | "closed";
    }>
  | FinishedPromptResult;

/** 枚举 Agent 按实际发生顺序同步发布的瞬时事件。 */
export type AgentEvent = Readonly<{ memberSessionId?: string; memberName?: string }> &
  (
    | Readonly<{ type: "collaboration_changed"; snapshot: CollaborationSnapshot }>
    | Readonly<{ type: "operation_changed"; operation: AgentOperation }>
    | Readonly<{ type: "session_changed"; sessionId: string }>
    | Readonly<{
        type: "tool_preparation";
        runId: string;
        toolCallId: string;
        toolName: string;
        phase: "input" | "ready";
      }>
    | Readonly<{
        type: "model_retry";
        runId: string;
        phase: "waiting" | "requesting";
        retryCount: 1 | 2;
        recoveryKind?: "continuation" | "approval";
        delayMs: number;
        diagnostic: RunDiagnostic;
      }>
    | Readonly<{ type: "permissions_changed" }>
    | Readonly<{ type: "memory_changed" }>
    | Readonly<{ type: "skills_changed" }>
    | Readonly<{ type: "mcp_changed" }>
    | Readonly<{ type: "tool_auto_review_start"; toolCallId: string; toolName: string }>
    | Readonly<{
        type: "tool_authorization";
        toolCallId: string;
        toolName: string;
        source: "user" | "auto_review" | "policy" | "workspace";
        decision: "allowed" | "denied" | "needs_user";
        reason: string;
      }>
    | Readonly<{ type: "context_usage"; usage: ContextUsage }>
    | Readonly<{ type: "compaction_start"; runId: string }>
    | Readonly<{
        type: "compaction_end";
        runId: string;
        inputTokensBefore: number;
        inputTokensAfter: number;
      }>
    | Readonly<{ type: "compaction_failed"; runId: string; error: string }>
    | Readonly<{ type: "session_cleanup"; result: SessionCleanupResult }>
    | Readonly<{ type: "run_start"; runId: string }>
    | Readonly<{ type: "run_phase_changed"; runId: string; phase: RunPhase }>
    | Readonly<{ type: "reasoning_start"; runId: string }>
    | Readonly<{ type: "reasoning_update"; runId: string; delta: string }>
    | Readonly<{ type: "reasoning_end"; runId: string }>
    | Readonly<{ type: "permission_mode_changed"; permissionMode: PermissionMode }>
    | Readonly<{ type: "message_start"; message: Message }>
    | Readonly<{ type: "message_update"; message: AssistantMessage; delta: string }>
    | Readonly<{ type: "message_end"; message: Message }>
    | Readonly<{ type: "tool_execution_start"; activity: ToolActivity }>
    | Readonly<{
        type: "tool_execution_update";
        toolCallId: string;
        toolName: string;
        stream: "stdout" | "stderr";
        delta: string;
      }>
    | Readonly<{
        type: "tool_execution_end";
        toolCallId: string;
        toolName: string;
        result: Extract<Message, { role: "tool" }>;
        cleanupUncertain: boolean;
      }>
    | Readonly<{ type: "tool_approval_requested"; request: ToolApprovalRequest }>
    | Readonly<{
        type: "tool_approval_resolved";
        request: ToolApprovalRequest;
        decision: "approve" | "deny" | "aborted";
      }>
    | Readonly<{
        type: "run_end";
        runId: string;
        result: FinishedPromptResult;
        diagnostic?: RunDiagnostic;
      }>
  );
export type AgentListener = (event: AgentEvent) => void;
export type SessionAgent = Readonly<{
  readonly state: AgentState;
  prompt(promptText: string): Promise<PromptResult>;
  promptInternal(input: AgentInputDetails): Promise<PromptResult>;
  runTool(toolName: string, input: JsonValue): Promise<PromptResult>;
  setPermissionMode(permissionMode: PermissionMode): PermissionModeChangeResult;
  respondToToolApproval(
    toolApprovalRequestId: string,
    decision: "approve" | "deny",
  ): ToolApprovalResponse;
  abort(source?: NonNullable<RunDiagnostic["abortSource"]>): void;
  close(): Promise<void>;
  compact(signal: AbortSignal): Promise<void>;
  external: ReturnType<typeof createExternalCapabilities>;
  subscribe(listener: AgentListener): () => void;
}>;
export type CreateAgentWithModelStreamOptions = SessionAgentOptions &
  Readonly<{
    memoryDirectory?: string;
    worktreeDirectory?: string;
    permissionDirectory?: string;
  }>;

/** 已装配能力属于单 Agent；存储目录和共享资源的创建留在 Runtime。 */
export type SessionAgentOptions = Readonly<{
  modelStream: ModelStream;
  memory?: Memory;
  maintainMemory?: MaintainMemory;
  managedTools?: AgentToolExtension;
  protectedPaths?: readonly string[];
  workspacePermissions?: WorkspacePermissions;
  permissionMember?: boolean;
  remainingTaskTimeMs?: () => number;
  beforeRequest?: (lease: SessionRunLease, signal: AbortSignal) => Promise<void>;
  authorizationRecords?: () => readonly SessionRecord[];
  modelContext?: Readonly<{ modelId: string; budget: ContextBudget }>;
  session: Session;
  skills?: SkillLibrary;
  mcp?: McpConnections;
  permissionMode?: PermissionMode | undefined;
  toolRunner?: ToolRunner | undefined;
  startCleanup?:
    | ((report: (result: SessionCleanupResult) => void) => () => Promise<void>)
    | undefined;
}>;

/** 集中持有一个活动 Run 的取消、Session lease、Loop 投影与唯一终态。 */
type ActiveRunOwnership = {
  runId: string;
  phase: RunPhase;
  sessionLease: SessionRunLease;
  abortController: AbortController;
  permissionMode: PermissionMode;
  visibleReasoningActive: boolean;
  diagnostic?: RunDiagnostic;
  abortSource?: NonNullable<RunDiagnostic["abortSource"]>;
  sessionWriteFailed: boolean;
  memoryCommittedBeforeFailure?: boolean;
  toolAuthorizations: Map<string, string>;
  toolAuthorizationRevisions: Map<string, string>;
  deniedToolActionFingerprints: Set<string>;
  terminalResultPromise: Promise<FinishedPromptResult> | null;
  requestToolRunners: WeakMap<ModelRequest, ToolRunner>;
};

/** 持有当前确认 Promise 的唯一解决入口和对应请求。 */
type PendingToolApproval = Readonly<{
  runId: string;
  request: ToolApprovalRequest;
  resolve(decision: "approve" | "deny" | "aborted"): void;
}>;

/** 单 Agent 的可变事实；对外 AgentState 只从这里及资源快照投影。 */
type SessionAgentExecutionState = {
  messageHistory: Message[];
  messageEntryIds: WeakMap<Message, string>;
  permissionMode: PermissionMode;
  activeAssistantMessage: AssistantMessage | null;
  lastError: string | null;
  lastRunDiagnostic: RunDiagnostic | null;
  activeRun: ActiveRunOwnership | null;
  sessionUnavailableResult: FinishedPromptResult | null;
  sessionLeaseAcquisitionPending: boolean;
  sessionChanged: boolean;
  pendingToolApproval: PendingToolApproval | null;
  ownedPromptResultPromise: Promise<PromptResult> | null;
  closeRequested: boolean;
  closeCompletionPromise: Promise<void> | null;
};

const SAFE_MODEL_ERROR = "模型请求失败，请检查模型配置或稍后重试。";
const SAFE_SESSION_ERROR = "Session 写入失败，请检查本地存储后重试。";
const SAFE_SESSION_RELEASE_ERROR = "Session 资源释放失败，已停止继续写入；请重新打开 Session。";
const SESSION_FAILED_RESULT = Object.freeze({
  status: "failed",
  error: SAFE_SESSION_ERROR,
} as const);
const SESSION_RELEASE_FAILED_RESULT = Object.freeze({
  status: "failed",
  error: SAFE_SESSION_RELEASE_ERROR,
} as const);
const MODEL_FAILED_RESULT = Object.freeze({ status: "failed", error: SAFE_MODEL_ERROR } as const);
const EMPTY_PROMPT_RESULT = Object.freeze({ status: "rejected", reason: "empty" } as const);
const BUSY_PROMPT_RESULT = Object.freeze({ status: "rejected", reason: "busy" } as const);
const SESSION_BUSY_PROMPT_RESULT = Object.freeze({
  status: "rejected",
  reason: "session_busy",
} as const);
const SESSION_CHANGED_PROMPT_RESULT = Object.freeze({
  status: "rejected",
  reason: "session_changed",
} as const);
const CLOSED_PROMPT_RESULT = Object.freeze({ status: "rejected", reason: "closed" } as const);
const ABORTED_PROMPT_RESULT = Object.freeze({ status: "aborted" } as const);
export function createSessionAgent({
  modelStream,
  modelContext,
  session,
  permissionMode: initialPermissionMode = DEFAULT_PERMISSION_MODE,
  toolRunner: providedToolRunner,
  startCleanup,
  skills,
  mcp,
  managedTools,
  beforeRequest,
  authorizationRecords,
  workspacePermissions,
  permissionMember = false,
  protectedPaths = [],
  remainingTaskTimeMs,
  memory,
  maintainMemory,
}: SessionAgentOptions): SessionAgent {
  const lastRunRecord = session.records.findLast((record) => record.type === "run_finished");
  const state: SessionAgentExecutionState = {
    messageHistory: [...session.messageHistory],
    messageEntryIds: new WeakMap(),
    permissionMode: initialPermissionMode,
    activeAssistantMessage: null,
    lastError: null,
    lastRunDiagnostic:
      lastRunRecord?.type === "run_finished" ? (lastRunRecord.diagnostic ?? null) : null,
    activeRun: null,
    pendingToolApproval: null,
    sessionUnavailableResult: null,
    sessionLeaseAcquisitionPending: false,
    sessionChanged: false,
    ownedPromptResultPromise: null,
    closeRequested: false,
    closeCompletionPromise: null,
  };

  const initialMessageRecords = session.records.filter((record) => record.type === "message");
  state.messageHistory.forEach((message, index) => {
    const record = initialMessageRecords[index];
    if (record) state.messageEntryIds.set(message, record.entryId);
  });
  const contextBudget = modelContext?.budget ?? createContextBudget({ contextWindow: 128_000 });
  const artifactStore = createSessionArtifactStore({
    sessionId: session.sessionId,
    storageDirectory: session.storageDirectory,
  });
  for (const message of state.messageHistory) {
    if (message.role === "tool" && message.artifact !== undefined)
      artifactStore.registerReference(message.artifact);
  }
  const sources = createContextSources({
    session,
    ...(memory ? { memory } : {}),
    environment: () =>
      createCodingEnvironmentPrompt(session.workspaceRoot, session.shell, state.permissionMode),
    skillDirectory: () => external.directory(),
    appendSource: async (details) => {
      try {
        await (state.activeRun
          ? state.activeRun.sessionLease.appendContextSource(details)
          : session.appendContextSource(details));
      } catch {
        if (state.activeRun) {
          state.activeRun.sessionWriteFailed = true;
          state.activeRun.abortController.abort();
        }
        state.sessionUnavailableResult = SESSION_FAILED_RESULT;
        throw new Error(SAFE_SESSION_ERROR);
      }
    },
  });
  const external = createExternalCapabilities({ sources, skills, mcp });
  const contextController = createContextController({
    session,
    modelStream,
    sources,
    modelId: modelContext?.modelId ?? "deterministic-local",
    budget: contextBudget,
  });
  const baseToolOptions: CreateToolRunnerOptions = {
    workspace: Object.freeze({
      workspaceRoot: session.workspaceRoot,
      sessionDirectory: session.sessionDirectory,
      protectedPaths: [
        ...protectedPaths,
        ...(workspacePermissions ? [workspacePermissions.directory] : []),
      ],
    }),
    shell: session.shell,
    artifactStore,
  };
  const memoryTools = memory
    ? createMemoryTools({
        memory,
        session,
        sources,
        ...(maintainMemory ? { maintain: maintainMemory } : {}),
        changed: () => publishEvent({ type: "memory_changed" }),
        onAdoptionFailure: () => {
          if (state.activeRun) state.activeRun.memoryCommittedBeforeFailure = true;
        },
      })
    : undefined;
  // 自持 Session、上下文投影及产物；权限仓库与 MCP 连接由外层共享，关闭只释放本 Agent 的订阅。
  const runtime = Object.freeze({
    state,
    session,
    modelStream,
    context: Object.freeze({ budget: contextBudget, sources, controller: contextController }),
    tools: Object.freeze({
      baseOptions: baseToolOptions,
      providedRunner: providedToolRunner,
      managed: managedTools,
      memory: memoryTools,
      external,
    }),
    permissions: Object.freeze({ workspace: workspacePermissions, member: permissionMember }),
    artifactStore,
    eventListeners: new Set<AgentListener>(),
    beforeRequest,
    authorizationRecords,
    remainingTaskTimeMs,
  });

  /** 模型定义和执行计划由同一请求工具集合投影，MCP 连接代次绑定在各自计划中。 */
  function prepareRequest(request: ModelRequest, permissionMode: PermissionMode) {
    const baseTools = createBaseTools(runtime.tools.baseOptions, permissionMode).map(
      (tool): AgentTool => ({
        definition: tool.definition,
        createPlan: (call, mode) =>
          runtime.tools.providedRunner?.createPlan(call, mode) ?? tool.createPlan(call, mode),
      }),
    );
    const localTools = [
      ...baseTools,
      ...(runtime.tools.managed?.tools(permissionMode) ?? []),
      ...(runtime.tools.memory?.tools(permissionMode) ?? []),
    ];
    const prepared = runtime.tools.external.prepareRequest(
      {
        ...request,
        tools: localTools.map((tool) => tool.definition),
      },
      permissionMode,
    );
    const toolRunner = createToolRunnerFromTools([...localTools, ...prepared.tools]);
    return {
      request: prepared.request,
      toolRunner: {
        createPlan: (call, mode) =>
          rejectUnavailableBaseTool(call, mode, runtime.tools.baseOptions) ??
          runtime.tools.managed?.rejectUnavailableTool?.(call, mode) ??
          runtime.tools.memory?.rejectUnavailableTool?.(call, mode) ??
          runtime.tools.external.rejectUnavailableTool(call, mode, prepared.mcpSnapshot) ??
          toolRunner.createPlan(call, mode),
      } satisfies ToolRunner,
    };
  }

  /** 生成只读状态投影；完成消息与活动 partial 的生命周期由各自形成边界持有。 */
  function createStateSnapshot(): AgentState {
    return Object.freeze({
      operation: null,
      sessionId: runtime.session.sessionId,
      workspaceRoot: runtime.session.workspaceRoot,
      permissionMode: state.permissionMode,
      contextUsage: runtime.context.controller.snapshot(),
      messageHistory: Object.freeze([...state.messageHistory]),
      activeAssistantMessage: state.activeAssistantMessage,
      activeRun: state.activeRun
        ? Object.freeze({
            runId: state.activeRun.runId,
            phase: state.activeRun.phase,
          })
        : null,
      pendingToolApproval: state.pendingToolApproval?.request ?? null,
      running: state.activeRun !== null,
      lastError: state.lastError,
      lastRunDiagnostic: state.lastRunDiagnostic,
    });
  }

  /** 按注册顺序同步发布事件，并隔离订阅者异常。 */
  function publishEvent(event: AgentEvent): void {
    const eventSnapshot = Object.freeze(event);
    for (const listener of [...runtime.eventListeners]) {
      try {
        void listener(eventSnapshot);
      } catch {
        // 订阅者没有第二条错误通道；呈现异常不能破坏 Run 的唯一终结路径。
      }
    }
  }

  /** 同步更新唯一 Run phase，并只为真实变化发布一次事件。 */
  function updateRunPhase(currentRun: ActiveRunOwnership, nextPhase: RunPhase): void {
    if (currentRun.phase === nextPhase) {
      return;
    }
    currentRun.phase = nextPhase;
    publishEvent({
      type: "run_phase_changed",
      runId: currentRun.runId,
      phase: nextPhase,
    });
  }

  /** 防御性收口仍活动的瞬时 Reasoning，不保存它的正文。 */
  function closeVisibleReasoning(currentRun: ActiveRunOwnership): void {
    if (!currentRun.visibleReasoningActive) {
      return;
    }
    currentRun.visibleReasoningActive = false;
    publishEvent({ type: "reasoning_end", runId: currentRun.runId });
  }
  function subscribeToEvents(listener: AgentListener): () => void {
    runtime.eventListeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      runtime.eventListeners.delete(listener);
    };
  }

  /** 只在 Agent 空闲时改变后续 Run 的权限快照。 */
  function setPermissionMode(nextPermissionMode: PermissionMode): PermissionModeChangeResult {
    if (state.closeRequested) {
      return Object.freeze({ status: "rejected", reason: "closed" });
    }
    if (state.activeRun !== null || state.sessionLeaseAcquisitionPending) {
      return Object.freeze({ status: "rejected", reason: "busy" });
    }
    if (state.permissionMode !== nextPermissionMode) {
      state.permissionMode = nextPermissionMode;
      publishEvent({ type: "permission_mode_changed", permissionMode: state.permissionMode });
    }
    return Object.freeze({ status: "accepted", permissionMode: state.permissionMode });
  }

  /** 请求中止当前 Run，实际终结继续由 Agent Loop 和统一收口路径完成。 */
  function abortActiveRun(source: NonNullable<RunDiagnostic["abortSource"]> = "user"): void {
    const currentRun = state.activeRun;
    if (currentRun === null || currentRun.abortController.signal.aborted) {
      return;
    }
    currentRun.abortSource = source;
    currentRun.abortController.abort(source);
    resolvePendingToolApproval(currentRun, "aborted");
  }

  /** 只解决当前标识完全匹配的确认，不直接执行任何 Tool。 */
  function respondToToolApproval(
    toolApprovalRequestId: string,
    decision: "approve" | "deny",
  ): ToolApprovalResponse {
    const pendingApproval = state.pendingToolApproval;
    if (pendingApproval === null) {
      return Object.freeze({ status: "rejected", reason: "not_pending" });
    }
    if (pendingApproval.request.toolApprovalRequestId !== toolApprovalRequestId) {
      return Object.freeze({ status: "rejected", reason: "request_mismatch" });
    }
    if (
      state.activeRun?.runId !== pendingApproval.runId ||
      state.activeRun.phase !== "awaiting_tool_approval"
    ) {
      return Object.freeze({ status: "rejected", reason: "request_mismatch" });
    }

    state.pendingToolApproval = null;
    publishEvent({
      type: "tool_approval_resolved",
      request: pendingApproval.request,
      decision,
    });
    pendingApproval.resolve(decision);
    return Object.freeze({ status: "accepted" });
  }

  /** 解决当前 Run 唯一待决确认，晚到或其他 Run 的请求保持不变。 */
  function resolvePendingToolApproval(currentRun: ActiveRunOwnership, decision: "aborted"): void {
    const pendingApproval = state.pendingToolApproval;
    if (pendingApproval === null || pendingApproval.runId !== currentRun.runId) {
      return;
    }
    state.pendingToolApproval = null;
    publishEvent({
      type: "tool_approval_resolved",
      request: pendingApproval.request,
      decision,
    });
    pendingApproval.resolve(decision);
  }

  /** 发布完整预览并等待当前 ToolCall 的一次性确认决定。 */
  function waitForToolApproval(
    currentRun: ActiveRunOwnership,
    toolCall: AssistantToolCallPart,
    approvalPlan: ToolApprovalPlan,
  ): Promise<AgentLoopToolApproval> {
    const request: ToolApprovalRequest = Object.freeze({
      toolApprovalRequestId: randomUUID(),
      toolCallId: toolCall.toolCallId,
      toolName: approvalPlan.toolName,
      workspaceRoot: runtime.session.workspaceRoot,
      target: approvalPlan.target,
      preview: approvalPlan.preview,
      permissionMode: currentRun.permissionMode,
      riskSummary: approvalPlan.riskSummary,
      executionBoundary: approvalPlan.executionBoundary,
    });
    return new Promise((resolve) => {
      state.pendingToolApproval = Object.freeze({
        runId: currentRun.runId,
        request,
        resolve: (decision) =>
          resolve(
            Object.freeze({
              toolApprovalRequestId: request.toolApprovalRequestId,
              decision,
            }),
          ),
      });
      publishEvent({ type: "tool_approval_requested", request });
      if (currentRun.abortController.signal.aborted) {
        resolvePendingToolApproval(currentRun, "aborted");
      }
    });
  }

  async function saveToolAuthorization(
    currentRun: ActiveRunOwnership,
    toolCall: AssistantToolCallPart,
    details: {
      source: "user" | "auto_review" | "policy" | "workspace";
      decision: "allowed" | "denied" | "needs_user";
      reason: string;
      authorizationEntryIds: readonly string[];
      actionFingerprint: string;
      toolApprovalRequestId: string;
    },
  ): Promise<void> {
    const reason = [...details.reason]
      .map((character) => {
        const point = character.codePointAt(0) ?? 0;
        return point < 32 || (point >= 127 && point <= 159) ? " " : character;
      })
      .join("")
      .slice(0, 300);
    try {
      await currentRun.sessionLease.appendApprovalDecision({
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        permissionMode: currentRun.permissionMode,
        decisionSource: details.source,
        decision: details.decision,
        reason,
        authorizationEntryIds: details.authorizationEntryIds,
        ...(runtime.authorizationRecords && details.authorizationEntryIds.length
          ? { authorizationSessionId: runtime.session.rootSessionId }
          : {}),
        actionFingerprint: details.actionFingerprint,
        toolApprovalRequestId: details.toolApprovalRequestId,
      });
    } catch {
      currentRun.sessionWriteFailed = true;
      state.sessionUnavailableResult = SESSION_FAILED_RESULT;
      throw new Error(SAFE_SESSION_ERROR);
    }
    if (details.source === "user" && details.decision === "denied")
      currentRun.deniedToolActionFingerprints.add(details.actionFingerprint);
    if (details.decision === "allowed") {
      currentRun.toolAuthorizations.set(toolCall.toolCallId, details.toolApprovalRequestId);
    }
    publishEvent({
      type: "tool_authorization",
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      source: details.source,
      decision: details.decision,
      reason,
    });
  }

  /** 审核只读取持久真实授权；人工与自动批准共用同一落盘后执行路径。 */
  async function authorizeTool(
    currentRun: ActiveRunOwnership,
    toolCall: AssistantToolCallPart,
    approvalPlan: ToolApprovalPlan,
    recordUsage: (usage: ModelUsage | undefined, fingerprint: string) => Promise<void>,
  ): Promise<AgentLoopToolApproval> {
    if (currentRun.abortController.signal.aborted)
      return { toolApprovalRequestId: randomUUID(), decision: "aborted" };
    const fingerprint = approvalPlan.actionFingerprint;
    if (currentRun.permissionMode === "full_access") {
      const toolApprovalRequestId = randomUUID();
      // 完整访问来自本次 Run 的显式模式；不绑定 AutoAllow 的工作区授权撤销版本。
      await saveToolAuthorization(currentRun, toolCall, {
        source: "policy",
        decision: "allowed",
        reason: "用户已显式启用 Full Access，本次动作跳过人工与模型审批。",
        authorizationEntryIds: [],
        actionFingerprint: fingerprint,
        toolApprovalRequestId,
      });
      return { toolApprovalRequestId, decision: "approve" };
    }
    const permissionRevision = runtime.permissions.workspace?.revision();
    if (permissionRevision)
      currentRun.toolAuthorizationRevisions.set(toolCall.toolCallId, permissionRevision);
    const denied = currentRun.deniedToolActionFingerprints.has(fingerprint);
    if (
      currentRun.permissionMode === "auto_allow" &&
      !denied &&
      runtime.permissions.workspace?.matches(
        toolCall,
        approvalPlan,
        runtime.session.workspaceRoot,
        runtime.permissions.member,
      )
    ) {
      const toolApprovalRequestId = randomUUID();
      await saveToolAuthorization(currentRun, toolCall, {
        source: "workspace",
        decision: "allowed",
        reason: "当前工作区的显式授权允许本次动作。",
        authorizationEntryIds: [],
        actionFingerprint: fingerprint,
        toolApprovalRequestId,
      });
      return { toolApprovalRequestId, decision: "approve" };
    }
    const workspaceRevoked = runtime.permissions.workspace?.isRevoked() === true;
    // 明确拒绝与授权撤销持续生效；其他新 ToolCall 仍按真实用户原文重新审核。
    if (currentRun.permissionMode === "auto_allow" && (denied || workspaceRevoked)) {
      const toolApprovalRequestId = randomUUID();
      await saveToolAuthorization(currentRun, toolCall, {
        source: "policy",
        decision: denied ? "denied" : "needs_user",
        reason: denied
          ? "用户已在当前 Run 拒绝同一动作，重提调用不会重新放行。"
          : "工作区授权已撤销，旧授权不再适用，请明确批准本次动作。",
        authorizationEntryIds: [],
        actionFingerprint: fingerprint,
        toolApprovalRequestId,
      });
      if (denied) return { toolApprovalRequestId, decision: "deny" };
    } else if (currentRun.permissionMode === "auto_allow") {
      const toolApprovalRequestId = randomUUID();
      updateRunPhase(currentRun, "reviewing_tool");
      publishEvent({
        type: "tool_auto_review_start",
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
      });
      const reviewResult = await reviewToolApproval({
        modelStream: runtime.modelStream,
        budget: runtime.context.budget,
        records: runtime.authorizationRecords?.() ?? runtime.session.records,
        executionRecords: runtime.session.records,
        runId: currentRun.runId,
        ...(runtime.remainingTaskTimeMs
          ? { remainingTaskTimeMs: runtime.remainingTaskTimeMs }
          : {}),
        workspaceRoot: runtime.session.workspaceRoot,
        toolCall,
        approvalPlan,
        abortSignal: currentRun.abortController.signal,
        onUsage: (usage) => recordUsage(usage, approvalPlan.actionFingerprint),
        onRetry: (event) => {
          updateRunPhase(
            currentRun,
            event.phase === "waiting" ? "retrying_model" : "reviewing_tool",
          );
          publishEvent({ ...event, recoveryKind: "approval", runId: currentRun.runId });
        },
      }).catch((error: unknown) => {
        if (error instanceof ModelRequestError) currentRun.diagnostic = error.diagnostic;
        throw error;
      });
      if (currentRun.sessionWriteFailed) throw new Error(SAFE_SESSION_ERROR);
      if (reviewResult.decision === "aborted" || currentRun.abortController.signal.aborted)
        return { toolApprovalRequestId, decision: "aborted" };
      await saveToolAuthorization(currentRun, toolCall, {
        source: "auto_review",
        decision:
          reviewResult.decision === "allow"
            ? "allowed"
            : reviewResult.decision === "deny"
              ? "denied"
              : "needs_user",
        reason: reviewResult.reason,
        authorizationEntryIds: reviewResult.authorizationEntryIds,
        actionFingerprint: approvalPlan.actionFingerprint,
        toolApprovalRequestId,
      });
      if (reviewResult.decision === "allow") return { toolApprovalRequestId, decision: "approve" };
    }
    if (
      currentRun.abortController.signal.aborted ||
      (permissionRevision && runtime.permissions.workspace?.revision() !== permissionRevision)
    )
      return { toolApprovalRequestId: randomUUID(), decision: "aborted" };
    updateRunPhase(currentRun, "awaiting_tool_approval");
    const approval = await waitForToolApproval(currentRun, toolCall, approvalPlan);
    if (approval.decision === "aborted" || currentRun.abortController.signal.aborted)
      return { ...approval, decision: "aborted" };
    await saveToolAuthorization(currentRun, toolCall, {
      source: "user",
      decision: approval.decision === "approve" ? "allowed" : "denied",
      reason: approval.decision === "approve" ? "用户批准本次具体操作。" : "用户拒绝本次具体操作。",
      authorizationEntryIds: [],
      actionFingerprint: approvalPlan.actionFingerprint,
      toolApprovalRequestId: approval.toolApprovalRequestId,
    });
    return approval;
  }

  /** 在异步获取 lease 之前登记整个 prompt，关闭流程也能等待尚未开始的 Run。 */
  function prompt(
    promptText: string,
    internalInput?: AgentInputDetails,
    controlCall?: AssistantToolCallPart,
  ): Promise<PromptResult> {
    if (state.closeRequested) {
      return Promise.resolve(CLOSED_PROMPT_RESULT);
    }
    if (
      state.ownedPromptResultPromise !== null ||
      state.activeRun !== null ||
      state.sessionLeaseAcquisitionPending
    ) {
      return Promise.resolve(BUSY_PROMPT_RESULT);
    }
    const promptCompletion = Promise.withResolvers<PromptResult>();
    state.ownedPromptResultPromise = promptCompletion.promise;
    void submitPrompt(promptText, internalInput, controlCall).then(
      (result) => {
        state.ownedPromptResultPromise = null;
        promptCompletion.resolve(result);
      },
      (error: unknown) => {
        state.ownedPromptResultPromise = null;
        promptCompletion.reject(error);
      },
    );
    return promptCompletion.promise;
  }

  /** 终态事件交付后才释放 Session 使用标记，保证清理任务不会命中仍在退出的 Agent。 */
  function close(): Promise<void> {
    if (state.closeCompletionPromise !== null) {
      return state.closeCompletionPromise;
    }
    state.closeRequested = true;
    abortActiveRun("shutdown");
    state.closeCompletionPromise = (async () => {
      try {
        await state.ownedPromptResultPromise;
      } finally {
        try {
          try {
            await runtime.artifactStore.close();
          } finally {
            await runtime.session.close();
          }
        } finally {
          try {
            await stopCleanup?.();
          } finally {
            unsubscribePermissions?.();
            runtime.eventListeners.clear();
          }
        }
      }
    })();
    return state.closeCompletionPromise;
  }
  async function submitPrompt(
    promptText: string,
    internalInput?: AgentInputDetails,
    controlCall?: AssistantToolCallPart,
  ): Promise<PromptResult> {
    if (promptText.trim().length === 0) {
      return EMPTY_PROMPT_RESULT;
    }
    if (state.activeRun !== null || state.sessionLeaseAcquisitionPending) {
      return BUSY_PROMPT_RESULT;
    }
    if (state.sessionChanged) {
      return SESSION_CHANGED_PROMPT_RESULT;
    }
    if (state.sessionUnavailableResult !== null) {
      return state.sessionUnavailableResult;
    }

    state.lastError = null;
    const runId = randomUUID();
    state.sessionLeaseAcquisitionPending = true;
    let sessionRunAcquisition: Awaited<ReturnType<Session["acquireRun"]>>;
    try {
      sessionRunAcquisition = await runtime.session.acquireRun(runId);
    } catch {
      state.sessionUnavailableResult = SESSION_FAILED_RESULT;
      state.lastError = SAFE_SESSION_ERROR;
      return SESSION_FAILED_RESULT;
    } finally {
      state.sessionLeaseAcquisitionPending = false;
    }
    if (sessionRunAcquisition.status === "rejected") {
      if (sessionRunAcquisition.reason === "session_changed") {
        state.sessionChanged = true;
        return SESSION_CHANGED_PROMPT_RESULT;
      }
      return SESSION_BUSY_PROMPT_RESULT;
    }

    if (state.closeRequested) {
      await sessionRunAcquisition.lease.release();
      return ABORTED_PROMPT_RESULT;
    }

    const currentRun: ActiveRunOwnership = {
      runId,
      phase: "requesting_model",
      sessionLease: sessionRunAcquisition.lease,
      abortController: new AbortController(),
      permissionMode: state.permissionMode,
      visibleReasoningActive: false,
      sessionWriteFailed: false,
      toolAuthorizations: new Map(),
      toolAuthorizationRevisions: new Map(),
      deniedToolActionFingerprints: new Set(),
      terminalResultPromise: null,
      requestToolRunners: new WeakMap(),
    };
    state.activeRun = currentRun;

    const userMessage: UserMessage = internalInput
      ? agentInputMessage(internalInput)
      : Object.freeze({ role: "user", content: promptText });
    try {
      // UserMessage 刷新成功后 Run 才算被接受，后续事件与 Tool 才能开始。
      if (internalInput) await currentRun.sessionLease.appendAgentInput(internalInput);
      else await currentRun.sessionLease.appendMessage(userMessage);
      const userRecord = runtime.session.records.findLast(
        (record) => record.type === (internalInput ? "agent_input" : "message"),
      );
      if (userRecord) state.messageEntryIds.set(userMessage, userRecord.entryId);
    } catch {
      return failBeforeRunStart(currentRun);
    }

    state.messageHistory.push(userMessage);
    publishEvent({ type: "run_start", runId });
    publishEvent({ type: "message_start", message: userMessage });
    publishEvent({ type: "message_end", message: userMessage });

    try {
      if (state.closeRequested || currentRun.abortController.signal.aborted) {
        return finishRun(currentRun, ABORTED_PROMPT_RESULT);
      }
      let contextFailure: string | null = null;

      const contextModelStream = runtime.context.controller.wrapRun({
        ...(runtime.remainingTaskTimeMs
          ? { remainingTaskTimeMs: runtime.remainingTaskTimeMs }
          : {}),
        lease: currentRun.sessionLease,
        beforeRequest: async (signal) => {
          try {
            await runtime.beforeRequest?.(currentRun.sessionLease, signal);
            await runtime.context.sources.prepare(signal);
          } catch (error) {
            contextFailure = error instanceof Error ? error.message : "上下文来源准备失败。";
            throw error;
          }
        },
        extendRequest: (request, requestIdentity) => {
          const prepared = prepareRequest(request, currentRun.permissionMode);
          // 模型回复只能执行该请求看见的工具；并行成员和后续请求不会替换这里的快照。
          currentRun.requestToolRunners.set(requestIdentity, prepared.toolRunner);
          return prepared.request;
        },
        emit: (event) => {
          if (event.type === "context_usage") publishEvent(event);
          else {
            updateRunPhase(
              currentRun,
              event.type === "compaction_start" ? "compacting" : "requesting_model",
            );
            publishEvent({ ...event, runId: currentRun.runId });
          }
        },
        onFailure: (error) => {
          contextFailure = error;
        },
        onStorageFailure: () => {
          currentRun.sessionWriteFailed = true;
          state.sessionUnavailableResult = SESSION_FAILED_RESULT;
        },
      });
      const controlModelStream = controlCall ? controlToolStream(controlCall) : null;
      const requestModelStream: ModelStream = controlModelStream
        ? (request, signal) => {
            const prepared = prepareRequest(request, currentRun.permissionMode);
            currentRun.requestToolRunners.set(request, prepared.toolRunner);
            return controlModelStream(prepared.request, signal);
          }
        : contextModelStream.modelStream;
      const loopResult = await runAgentLoop({
        messages: state.messageHistory,
        messageEntryId: (message) => state.messageEntryIds.get(message),
        modelStream: requestModelStream,
        systemPrompt: createCodingSystemPrompt(),
        toolDefinitions: [],
        permissionMode: currentRun.permissionMode,
        toolRunner: createToolRunnerFromTools([]),
        toolRunnerForRequest: (request) => currentRun.requestToolRunners.get(request),
        artifactStore: runtime.artifactStore,
        abortController: currentRun.abortController,
        ...(runtime.remainingTaskTimeMs
          ? { remainingTaskTimeMs: runtime.remainingTaskTimeMs }
          : {}),
        emit: (event) => processAgentLoopEvent(currentRun, event),
        updatePhase: (phase) => updateRunPhase(currentRun, phase),
        requestToolApproval: (toolCall, approvalPlan) =>
          authorizeTool(currentRun, toolCall, approvalPlan, contextModelStream.recordApprovalUsage),
      });
      if (loopResult.diagnostic) currentRun.diagnostic = loopResult.diagnostic;
      return finishRun(
        currentRun,
        currentRun.sessionWriteFailed
          ? SESSION_FAILED_RESULT
          : loopResult.status === "failed" && contextFailure !== null
            ? { status: "failed", error: contextFailure }
            : toFinishedPromptResult(loopResult),
      );
    } catch {
      const requestedResult = currentRun.sessionWriteFailed
        ? SESSION_FAILED_RESULT
        : currentRun.abortController.signal.aborted
          ? ABORTED_PROMPT_RESULT
          : MODEL_FAILED_RESULT;
      return finishRun(currentRun, requestedResult);
    }
  }

  /** 在 run_start 之前安全处理首条 UserMessage 或 lease 释放失败。 */
  async function failBeforeRunStart(currentRun: ActiveRunOwnership): Promise<FinishedPromptResult> {
    let failedResult: FinishedPromptResult = SESSION_FAILED_RESULT;
    try {
      await currentRun.sessionLease.release();
    } catch {
      failedResult = SESSION_RELEASE_FAILED_RESULT;
    }
    state.lastError = failedResult.status === "failed" ? failedResult.error : SAFE_SESSION_ERROR;
    state.sessionUnavailableResult = failedResult;
    if (state.activeRun === currentRun) {
      state.activeRun = null;
    }
    return failedResult;
  }

  /** 持久化 Agent Loop 事实，再投影为稳定的公开 AgentEvent。 */
  async function processAgentLoopEvent(
    currentRun: ActiveRunOwnership,
    event: AgentLoopEvent,
  ): Promise<void> {
    switch (event.type) {
      case "tool_preparation":
        publishEvent({ ...event, runId: currentRun.runId });
        return;
      case "model_retry":
        updateRunPhase(
          currentRun,
          event.phase === "waiting" ? "retrying_model" : "requesting_model",
        );
        publishEvent({ ...event, runId: currentRun.runId });
        return;
      case "reasoning_start":
        closeVisibleReasoning(currentRun);
        currentRun.visibleReasoningActive = true;
        publishEvent({ type: "reasoning_start", runId: currentRun.runId });
        return;
      case "reasoning_update":
        if (!currentRun.visibleReasoningActive) {
          currentRun.visibleReasoningActive = true;
          publishEvent({ type: "reasoning_start", runId: currentRun.runId });
        }
        publishEvent({
          type: "reasoning_update",
          runId: currentRun.runId,
          delta: event.delta,
        });
        return;
      case "reasoning_end":
        closeVisibleReasoning(currentRun);
        return;
      case "assistant_message_start":
        state.activeAssistantMessage = event.message;
        publishEvent({ type: "message_start", message: event.message });
        return;
      case "assistant_message_update":
        state.activeAssistantMessage = event.message;
        if (event.delta !== null) {
          publishEvent({
            type: "message_update",
            message: event.message,
            delta: event.delta,
          });
        }
        return;
      case "assistant_message_end":
        if (event.message.diagnostic) currentRun.diagnostic = event.message.diagnostic;
        await appendCompletedMessage(currentRun, event.message, true);
        state.activeAssistantMessage = null;
        return;
      case "tool_result":
        await appendCompletedMessage(currentRun, event.message, false);
        return;
      case "tool_policy_denied":
        await saveToolAuthorization(currentRun, event.toolCall, {
          source: "policy",
          decision: "denied",
          reason: event.reason,
          authorizationEntryIds: [],
          actionFingerprint: createHash("sha256")
            .update(JSON.stringify(event.toolCall))
            .digest("hex"),
          toolApprovalRequestId: randomUUID(),
        });
        return;
      case "tool_execution_start": {
        const authorizationRevision = currentRun.toolAuthorizationRevisions.get(
          event.toolCall.toolCallId,
        );
        if (
          authorizationRevision &&
          runtime.permissions.workspace?.revision() !== authorizationRevision
        ) {
          throw new Error("工作区授权已变化，此动作尚未执行，请重新确认。");
        }
        try {
          await runtime.context.sources.checkExecution(currentRun.abortController.signal);
        } catch {
          currentRun.abortController.abort();
          throw new Error("当前记忆已撤销，工具执行已停止。");
        }
        if (isSideEffectToolName(event.toolCall.toolName)) {
          let approvalId = currentRun.toolAuthorizations.get(event.toolCall.toolCallId);
          if (approvalId === undefined) {
            // 外部 Tool 必须已有匹配本次调用的审批，不能使用本地 Policy 的兜底。
            if (event.toolCall.toolName.startsWith("mcp_"))
              throw new Error("MCP Tool 缺少已保存的授权。");
            approvalId = randomUUID();
            await saveToolAuthorization(currentRun, event.toolCall, {
              source: "policy",
              decision: "allowed",
              reason: "确定性策略允许本次准备动作。",
              authorizationEntryIds: [],
              toolApprovalRequestId: approvalId,
              actionFingerprint: createHash("sha256")
                .update(JSON.stringify(event.toolCall))
                .digest("hex"),
            });
          }
          await appendToolExecutionStarted(currentRun, event.toolCall, approvalId);
          if (
            authorizationRevision &&
            runtime.permissions.workspace?.revision() !== authorizationRevision
          ) {
            currentRun.abortController.abort();
            throw new Error("工作区授权已撤销，执行已停止。");
          }
        }
        publishEvent({
          type: "tool_execution_start",
          activity: Object.freeze({
            toolCallId: event.toolCall.toolCallId,
            toolName: event.toolCall.toolName,
            summary: event.activitySummary,
          }),
        });
        return;
      }
      case "tool_execution_update":
        publishEvent(event);
        return;
      case "tool_execution_end":
        publishEvent(event);
        return;
    }
  }

  /** 刷新副作用开始事实，失败时封存 Session 且不执行副作用。 */
  async function appendToolExecutionStarted(
    currentRun: ActiveRunOwnership,
    toolCall: AssistantToolCallPart,
    toolApprovalRequestId: string,
  ): Promise<void> {
    if (!isSideEffectToolName(toolCall.toolName)) {
      throw new Error("副作用 Tool 名称无效。");
    }
    try {
      await currentRun.sessionLease.appendToolExecutionStarted({
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        toolApprovalRequestId,
      });
    } catch {
      currentRun.sessionWriteFailed = true;
      state.sessionUnavailableResult = SESSION_FAILED_RESULT;
      state.lastError = SAFE_SESSION_ERROR;
      throw new Error(SAFE_SESSION_ERROR);
    }
  }

  /** 先刷新完成消息，再更新内存投影并发布结束事件。 */
  async function appendCompletedMessage(
    currentRun: ActiveRunOwnership,
    message: Message,
    messageStartAlreadyPublished: boolean,
  ): Promise<void> {
    try {
      await currentRun.sessionLease.appendMessage(message);
      const messageRecord = runtime.session.records.findLast((record) => record.type === "message");
      if (messageRecord) state.messageEntryIds.set(message, messageRecord.entryId);
    } catch {
      currentRun.sessionWriteFailed = true;
      state.sessionUnavailableResult = SESSION_FAILED_RESULT;
      state.lastError = SAFE_SESSION_ERROR;
      throw new Error(SAFE_SESSION_ERROR);
    }
    if (message.role === "tool" && message.artifact !== undefined)
      runtime.artifactStore.registerReference(message.artifact);
    state.messageHistory.push(message);
    if (!messageStartAlreadyPublished) {
      publishEvent({ type: "message_start", message });
    }
    publishEvent({ type: "message_end", message });
  }
  function finishRun(
    currentRun: ActiveRunOwnership,
    requestedResult: FinishedPromptResult,
  ): Promise<FinishedPromptResult> {
    if (currentRun.terminalResultPromise !== null) {
      return currentRun.terminalResultPromise;
    }
    currentRun.terminalResultPromise = finalizeRun(currentRun, requestedResult);
    return currentRun.terminalResultPromise;
  }

  /** 写入唯一 RunFinishedRecord，交付 run_end 后释放 Session 所有权。 */
  async function finalizeRun(
    currentRun: ActiveRunOwnership,
    requestedResult: FinishedPromptResult,
  ): Promise<FinishedPromptResult> {
    let finalResult = requestedResult;
    let diagnostic =
      finalResult.status === "aborted"
        ? createRunDiagnostic("aborted", {
            ...currentRun.diagnostic,
            abortSource:
              currentRun.abortSource ??
              (currentRun.diagnostic?.abortSource && currentRun.diagnostic.abortSource !== "unknown"
                ? currentRun.diagnostic.abortSource
                : runtime.remainingTaskTimeMs?.() === 0
                  ? "task_deadline"
                  : "unknown"),
          })
        : finalResult.status === "failed" && currentRun.diagnostic?.category === "completed"
          ? createRunDiagnostic("unknown", currentRun.diagnostic)
          : (currentRun.diagnostic ??
            createRunDiagnostic(finalResult.status === "completed" ? "completed" : "unknown"));
    state.lastRunDiagnostic = diagnostic;
    resolvePendingToolApproval(currentRun, "aborted");
    closeVisibleReasoning(currentRun);
    state.activeAssistantMessage = null;
    if (finalResult.status === "failed") {
      state.lastError = finalResult.error;
    }

    try {
      if (currentRun.sessionWriteFailed) {
        throw new Error(SAFE_SESSION_ERROR);
      }
      await currentRun.sessionLease.appendRunFinished({ status: finalResult.status, diagnostic });
    } catch {
      finalResult = SESSION_FAILED_RESULT;
      diagnostic = createRunDiagnostic("storage", diagnostic);
      state.lastRunDiagnostic = diagnostic;
      state.lastError = finalResult.error;
      state.sessionUnavailableResult = SESSION_FAILED_RESULT;
    }

    if (currentRun.memoryCommittedBeforeFailure && finalResult.status === "failed") {
      finalResult = {
        status: "failed",
        error: "记忆已保存，但本会话未能采用该版本；恢复会话后继续。 " + finalResult.error,
      };
      state.lastError = finalResult.error;
      if (currentRun.sessionWriteFailed) state.sessionUnavailableResult = finalResult;
    }

    // activeRun 保留到 run_end 同步交付后，阻止终态订阅者重入 prompt。
    publishEvent({
      type: "run_end",
      runId: currentRun.runId,
      result: finalResult,
      diagnostic,
    });
    try {
      await currentRun.sessionLease.release();
    } catch {
      state.sessionUnavailableResult = SESSION_RELEASE_FAILED_RESULT;
      state.lastError = SAFE_SESSION_RELEASE_ERROR;
    } finally {
      if (state.activeRun === currentRun) {
        state.activeRun = null;
      }
    }
    return finalResult;
  }

  const unsubscribePermissions = runtime.permissions.workspace?.subscribe(() => {
    if (state.activeRun && runtime.permissions.workspace?.isRevoked())
      resolvePendingToolApproval(state.activeRun, "aborted");
    publishEvent({ type: "permissions_changed" });
  });
  const stopCleanup = startCleanup?.((result) => publishEvent({ type: "session_cleanup", result }));

  return Object.freeze({
    get state() {
      return createStateSnapshot();
    },
    prompt,
    promptInternal(input) {
      if (input.rootSessionId !== runtime.session.rootSessionId)
        return Promise.resolve({ status: "failed", error: "内部输入的根 Session 不匹配。" });
      return prompt(input.content, input);
    },
    runTool(toolName, input) {
      const call: AssistantToolCallPart = {
        type: "tool_call",
        toolCallId: randomUUID(),
        toolName,
        input,
        invalid: false,
      };
      return prompt("用户直接执行 " + toolName + "：\n" + JSON.stringify(input), undefined, call);
    },
    external: runtime.tools.external,
    async compact(signal: AbortSignal) {
      await runtime.context.sources.prepare(signal);
      await runtime.context.controller.compact(
        prepareRequest(
          {
            systemPrompt: createCodingSystemPrompt(),
            messages: state.messageHistory.map((message) => {
              const entryId = state.messageEntryIds.get(message);
              return entryId ? { ...message, entryId } : message;
            }),
            tools: [],
          },
          state.permissionMode,
        ).request,
        signal,
        (event) => {
          if (event.type === "context_usage") publishEvent(event);
        },
        () => {
          state.sessionUnavailableResult = SESSION_FAILED_RESULT;
          state.lastError = SAFE_SESSION_ERROR;
        },
      );
    },
    setPermissionMode,
    respondToToolApproval,
    abort: abortActiveRun,
    close,
    subscribe: subscribeToEvents,
  });
}
function toFinishedPromptResult(loopResult: AgentLoopResult): FinishedPromptResult {
  switch (loopResult.status) {
    case "completed":
      return Object.freeze({ status: "completed" });
    case "aborted":
      return Object.freeze({ status: "aborted" });
    case "failed":
      return Object.freeze({ status: "failed", error: loopResult.error });
  }
}

/** 用户命令沿现有 Run、审批与 Tool Loop 执行，不为确定动作额外请求 Provider。 */
function controlToolStream(call: AssistantToolCallPart): ModelStream {
  let issued = false;
  return async function* () {
    if (!issued) {
      issued = true;
      yield {
        type: "tool_call",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
        invalid: false,
      };
      yield { type: "finish", finishReason: "tool_calls" };
    } else {
      yield { type: "text_delta", delta: "操作已结束，请查看工具结果。" };
      yield { type: "finish", finishReason: "stop" };
    }
  };
}
