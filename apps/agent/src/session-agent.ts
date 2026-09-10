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
  CompletedMessage,
  JsonValue,
  Message,
  RunDiagnostic,
  UserMessage,
} from "./message.js";
import { createRunDiagnostic } from "./model/model-diagnostics.js";
import {
  type ModelInputMessage,
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
import type { SessionCleanupResult } from "./session/cleanup.js";
import type { AgentInputDetails, Session } from "./session/index.js";
import { isSideEffectToolName, type SessionRecord } from "./session/schema.js";
import type { SkillLibrary } from "./skill/index.js";
import { createSessionArtifactStore } from "./tool/artifacts.js";
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
  inputQueue: Readonly<{
    steer: readonly PendingInput[];
    followUp: readonly PendingInput[];
    paused: boolean;
  }>;
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
export type InputMode = "steer" | "followUp";
export type PromptOptions = Readonly<{ mode?: InputMode; resume?: boolean }>;
export type PendingInput = Readonly<{
  inputId: string;
  content: string;
  mode: InputMode;
  source: Readonly<{ kind: "user" }> | NonNullable<UserMessage["source"]>;
}>;
export type PromptResult =
  | Readonly<{ status: "accepted" | "queued"; inputId: string; mode: InputMode; durable: false }>
  | Readonly<{
      status: "rejected";
      reason:
        | "empty"
        | "busy"
        | "session_busy"
        | "session_changed"
        | "session_unavailable"
        | "closed";
    }>;
type InternalPromptResult = FinishedPromptResult | Extract<PromptResult, { status: "rejected" }>;
type QueuedInput = PendingInput &
  Readonly<{
    internalInput?: AgentInputDetails;
    controlCall?: AssistantToolCallPart;
    completion?: ReturnType<typeof Promise.withResolvers<InternalPromptResult>>;
  }>;

/** 枚举 Agent 按实际发生顺序同步发布的瞬时事件。 */
export type AgentEvent = Readonly<{ memberSessionId?: string; memberName?: string }> &
  (
    | Readonly<{ type: "collaboration_changed"; snapshot: CollaborationSnapshot }>
    | Readonly<{ type: "operation_changed"; operation: AgentOperation }>
    | Readonly<{ type: "session_changed"; sessionId: string }>
    | Readonly<{ type: "input_queued"; input: PendingInput }>
    | Readonly<{
        type: "input_consumed";
        inputId: string;
        mode: InputMode;
        runId: string;
        entryId: string;
      }>
    | Readonly<{
        type: "input_discarded";
        inputId: string;
        reason: "closed" | "session_changed";
        source: PendingInput["source"];
      }>
    | Readonly<{ type: "session_unavailable"; error: string }>
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
  prompt(promptText: string, options?: PromptOptions): Promise<PromptResult>;
  promptInternal(input: AgentInputDetails): Promise<InternalPromptResult>;
  queueInternal(input: AgentInputDetails): void;
  runTool(toolName: string, input: JsonValue): Promise<InternalPromptResult>;
  setPermissionMode(permissionMode: PermissionMode): PermissionModeChangeResult;
  respondToToolApproval(
    toolApprovalRequestId: string,
    decision: "approve" | "deny",
  ): ToolApprovalResponse;
  abort(source?: NonNullable<RunDiagnostic["abortSource"]>): void;
  close(reason?: "closed" | "session_changed"): Promise<void>;
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
  pendingInputs?: () => readonly AgentInputDetails[];
  acknowledgeInput?: (input: AgentInputDetails) => Promise<void>;
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

/** 集中持有一个活动 Run 的取消、请求工具快照与唯一终态。 */
type ActiveRunOwnership = {
  runId: string;
  phase: RunPhase;
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
  inputCompletions: Set<NonNullable<QueuedInput["completion"]>>;
  resumeAfterTermination: boolean;
};

/** 持有当前确认 Promise 的唯一解决入口和对应请求。 */
type PendingToolApproval = Readonly<{
  runId: string;
  request: ToolApprovalRequest;
  resolve(decision: "approve" | "deny" | "aborted"): void;
}>;

/** 单 Agent 的可变事实；对外 AgentState 只从这里及资源快照投影。 */
type SessionAgentExecutionState = {
  readonly context: readonly ModelInputMessage[];
  history: Array<Readonly<{ entryId: string; message: Message }>>;
  steerQueue: QueuedInput[];
  followUpQueue: QueuedInput[];
  committedInputIds: Set<string>;
  inputsPaused: boolean;
  permissionMode: PermissionMode;
  activeAssistantMessage: AssistantMessage | null;
  lastError: string | null;
  lastRunDiagnostic: RunDiagnostic | null;
  activeRun: ActiveRunOwnership | null;
  sessionUnavailableResult: FinishedPromptResult | null;
  pendingToolApproval: PendingToolApproval | null;
  ownedRunResultPromise: Promise<FinishedPromptResult> | null;
  closeRequested: boolean;
  closeCompletionPromise: Promise<void> | null;
};

const SAFE_MODEL_ERROR = "模型请求失败，请检查模型配置或稍后重试。";
const SAFE_SESSION_ERROR = "Session 写入失败，请检查本地存储后重试。";
const SESSION_FAILED_RESULT = Object.freeze({
  status: "failed",
  error: SAFE_SESSION_ERROR,
} as const);
const MODEL_FAILED_RESULT = Object.freeze({ status: "failed", error: SAFE_MODEL_ERROR } as const);
const EMPTY_PROMPT_RESULT = Object.freeze({ status: "rejected", reason: "empty" } as const);
const BUSY_PROMPT_RESULT = Object.freeze({ status: "rejected", reason: "busy" } as const);
const SESSION_UNAVAILABLE_PROMPT_RESULT = Object.freeze({
  status: "rejected",
  reason: "session_unavailable",
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
  pendingInputs,
  acknowledgeInput,
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
    get context() {
      return contextController.projectMessages();
    },
    history: session.records.flatMap((record) =>
      record.type === "message"
        ? [{ entryId: record.entryId, message: record.message }]
        : record.type === "agent_input"
          ? [{ entryId: record.entryId, message: internalMessage(record) }]
          : [],
    ),
    steerQueue: [],
    followUpQueue: [],
    committedInputIds: new Set(
      session.records
        .filter((record) => record.type === "agent_input")
        .map((record) => record.messageId),
    ),
    inputsPaused: false,
    permissionMode: initialPermissionMode,
    activeAssistantMessage: null,
    lastError: null,
    lastRunDiagnostic:
      lastRunRecord?.type === "run_finished" ? (lastRunRecord.diagnostic ?? null) : null,
    activeRun: null,
    pendingToolApproval: null,
    sessionUnavailableResult: null,
    ownedRunResultPromise: null,
    closeRequested: false,
    closeCompletionPromise: null,
  };

  const contextBudget = modelContext?.budget ?? createContextBudget({ contextWindow: 128_000 });
  const artifactStore = createSessionArtifactStore({
    sessionId: session.sessionId,
    storageDirectory: session.storageDirectory,
  });
  for (const { message } of state.history) {
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
        await session.appendContextSource(state.activeRun?.runId ?? null, details);
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
    pendingInputs,
    acknowledgeInput,
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
      messageHistory: Object.freeze(state.history.map(({ message }) => message)),
      inputQueue: Object.freeze({
        steer: Object.freeze(state.steerQueue.map(inputSnapshot)),
        followUp: Object.freeze(state.followUpQueue.map(inputSnapshot)),
        paused: state.inputsPaused,
      }),
      activeAssistantMessage: state.activeAssistantMessage,
      activeRun: state.activeRun
        ? Object.freeze({
            runId: state.activeRun.runId,
            phase: state.activeRun.phase,
          })
        : null,
      pendingToolApproval: state.pendingToolApproval?.request ?? null,
      running: state.activeRun !== null || state.ownedRunResultPromise !== null,
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
    if (state.activeRun !== null || state.ownedRunResultPromise !== null) {
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
    state.inputsPaused = true;
    const currentRun = state.activeRun;
    if (currentRun === null || currentRun.abortController.signal.aborted) {
      return;
    }
    currentRun.resumeAfterTermination = false;
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
      await runtime.session.appendApprovalDecision(currentRun.runId, {
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

  function inputSnapshot(input: QueuedInput): PendingInput {
    return Object.freeze({
      inputId: input.inputId,
      content: input.content,
      mode: input.mode,
      source: Object.freeze(input.source),
    });
  }

  function inputRejection(): Extract<PromptResult, { status: "rejected" }> | null {
    return state.closeRequested
      ? CLOSED_PROMPT_RESULT
      : state.sessionUnavailableResult
        ? SESSION_UNAVAILABLE_PROMPT_RESULT
        : null;
  }

  function queueInput(input: QueuedInput): void {
    (input.mode === "steer" ? state.steerQueue : state.followUpQueue).push(input);
    publishEvent({ type: "input_queued", input: inputSnapshot(input) });
  }

  function queueInternal(input: AgentInputDetails): void {
    if (input.rootSessionId !== runtime.session.rootSessionId || state.closeRequested) return;
    if (
      state.committedInputIds.has(input.messageId) ||
      state.steerQueue.some((queued) => queued.inputId === input.messageId)
    )
      return;
    queueInput({
      inputId: input.messageId,
      content: input.content,
      mode: "steer",
      source: internalSource(input),
      internalInput: input,
    });
  }

  async function acknowledgeConsumedInput(
    currentRun: ActiveRunOwnership,
    input: AgentInputDetails,
  ): Promise<void> {
    try {
      await runtime.acknowledgeInput?.(input);
    } catch {
      currentRun.sessionWriteFailed = true;
      currentRun.abortController.abort();
      state.sessionUnavailableResult = SESSION_FAILED_RESULT;
      state.lastError = SAFE_SESSION_ERROR;
      throw new Error(SAFE_SESSION_ERROR);
    }
  }

  async function synchronizePendingInputs(currentRun: ActiveRunOwnership): Promise<void> {
    for (const input of runtime.pendingInputs?.() ?? []) {
      if (state.committedInputIds.has(input.messageId))
        await acknowledgeConsumedInput(currentRun, input);
      else queueInternal(input);
    }
  }

  function resumeInputs(): void {
    state.inputsPaused = false;
    const currentRun = state.activeRun;
    // 已取消或正在封口的 Run 先完成终态写入，再兑现此后收到的明确继续。
    if (
      currentRun &&
      (currentRun.abortController.signal.aborted || currentRun.terminalResultPromise !== null)
    )
      currentRun.resumeAfterTermination = true;
  }

  /** 接收只修改内存队列；开始和安全点消费分别负责持久化与真正执行。 */
  function prompt(promptText: string, options: PromptOptions = {}): Promise<PromptResult> {
    const rejection = inputRejection();
    if (rejection) return Promise.resolve(rejection);
    if (!promptText.trim()) {
      if (!options.resume) return Promise.resolve(EMPTY_PROMPT_RESULT);
      for (const input of runtime.pendingInputs?.() ?? []) queueInternal(input);
      const nextInput = state.steerQueue[0] ?? state.followUpQueue[0];
      if (!nextInput) return Promise.resolve(EMPTY_PROMPT_RESULT);
      resumeInputs();
      const accepted = state.ownedRunResultPromise === null;
      startQueuedRun(true);
      return Promise.resolve({
        status: accepted ? "accepted" : "queued",
        inputId: nextInput.inputId,
        mode: nextInput.mode,
        durable: false,
      });
    }
    if (options.resume) resumeInputs();
    const input: QueuedInput = {
      inputId: randomUUID(),
      content: promptText,
      mode: options.mode ?? "steer",
      source: { kind: "user" },
    };
    const accepted =
      state.ownedRunResultPromise === null &&
      !state.inputsPaused &&
      state.steerQueue.length === 0 &&
      state.followUpQueue.length === 0;
    queueInput(input);
    startQueuedRun(true);
    return Promise.resolve({
      status: accepted ? "accepted" : "queued",
      inputId: input.inputId,
      mode: input.mode,
      durable: false,
    });
  }

  function submitInternal(
    promptText: string,
    internalInput?: AgentInputDetails,
    controlCall?: AssistantToolCallPart,
  ): Promise<InternalPromptResult> {
    const rejection = inputRejection();
    if (rejection) return Promise.resolve(rejection);
    if (
      state.ownedRunResultPromise !== null ||
      (controlCall && (state.steerQueue.length > 0 || state.followUpQueue.length > 0))
    )
      return Promise.resolve(BUSY_PROMPT_RESULT);
    const completion = Promise.withResolvers<InternalPromptResult>();
    const input: QueuedInput = {
      inputId: internalInput?.messageId ?? randomUUID(),
      content: promptText,
      mode: "steer",
      source: internalInput ? internalSource(internalInput) : { kind: "user" },
      ...(internalInput ? { internalInput } : {}),
      ...(controlCall ? { controlCall } : {}),
      completion,
    };
    if (internalInput) state.inputsPaused = false;
    queueInput(input);
    startQueuedRun(true);
    return completion.promise;
  }

  /** 先登记整轮所有权，终态订阅者的新输入只会留给封口后的下一轮。 */
  function startQueuedRun(explicitInput = false): void {
    if (state.ownedRunResultPromise !== null || inputRejection()) return;
    const input = state.steerQueue[0] ?? state.followUpQueue[0];
    if (!input || (state.inputsPaused && !input.controlCall)) return;
    // 耐久投递只在活动安全点或显式继续时消费，终态迟到消息不能自行唤醒 Agent。
    if (
      !explicitInput &&
      input.source.kind === "agent" &&
      ![...state.steerQueue, ...state.followUpQueue].some((queued) => queued.source.kind === "user")
    )
      return;
    const completion = Promise.withResolvers<FinishedPromptResult>();
    state.ownedRunResultPromise = completion.promise;
    const currentRun: ActiveRunOwnership = {
      runId: randomUUID(),
      phase: "requesting_model",
      abortController: new AbortController(),
      permissionMode: state.permissionMode,
      visibleReasoningActive: false,
      sessionWriteFailed: false,
      toolAuthorizations: new Map(),
      toolAuthorizationRevisions: new Map(),
      deniedToolActionFingerprints: new Set(),
      terminalResultPromise: null,
      requestToolRunners: new WeakMap(),
      resumeAfterTermination: false,
      inputCompletions: new Set(
        [...state.steerQueue, ...state.followUpQueue].flatMap((queued) =>
          queued.completion ? [queued.completion] : [],
        ),
      ),
    };
    state.activeRun = currentRun;
    state.lastError = null;
    void executeRun(currentRun, input).then((result) => {
      state.ownedRunResultPromise = null;
      for (const inputCompletion of currentRun.inputCompletions) inputCompletion.resolve(result);
      completion.resolve(result);
      startQueuedRun();
    });
  }

  /** 关闭先收齐已接受写入，再报告尚未消费的正文，最后释放 Session 的长期锁。 */
  function close(reason: "closed" | "session_changed" = "closed"): Promise<void> {
    if (state.closeCompletionPromise !== null) return state.closeCompletionPromise;
    state.closeRequested = true;
    abortActiveRun("shutdown");
    state.closeCompletionPromise = (async () => {
      try {
        await state.ownedRunResultPromise;
      } finally {
        const discarded = [...state.steerQueue, ...state.followUpQueue];
        state.steerQueue.length = 0;
        state.followUpQueue.length = 0;
        for (const input of discarded) {
          input.completion?.resolve(ABORTED_PROMPT_RESULT);
          publishEvent({
            type: "input_discarded",
            inputId: input.inputId,
            reason,
            source: Object.freeze(input.source),
          });
        }
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

  async function consumeInput(
    currentRun: ActiveRunOwnership,
    input: QueuedInput,
    initial = false,
  ): Promise<void> {
    const message: UserMessage = input.internalInput
      ? internalMessage(input.internalInput)
      : Object.freeze({ role: "user", content: input.content });
    const entryId = await recordMessage(currentRun, message, false, input.internalInput, () => {
      const queue = input.mode === "steer" ? state.steerQueue : state.followUpQueue;
      const index = queue.indexOf(input);
      if (index >= 0) queue.splice(index, 1);
      if (initial) publishEvent({ type: "run_start", runId: currentRun.runId });
    });
    publishEvent({
      type: "input_consumed",
      inputId: input.inputId,
      mode: input.mode,
      runId: currentRun.runId,
      entryId,
    });
    if (input.internalInput) await acknowledgeConsumedInput(currentRun, input.internalInput);
  }

  async function consumeSteer(currentRun: ActiveRunOwnership): Promise<boolean> {
    if (state.closeRequested || state.inputsPaused || currentRun.abortController.signal.aborted)
      return false;
    await synchronizePendingInputs(currentRun);
    if (state.closeRequested || state.inputsPaused || currentRun.abortController.signal.aborted)
      return false;
    const input = state.steerQueue[0];
    if (!input) return false;
    await consumeInput(currentRun, input);
    return true;
  }

  async function executeRun(
    currentRun: ActiveRunOwnership,
    input: QueuedInput,
  ): Promise<FinishedPromptResult> {
    const controlCall = input.controlCall;
    try {
      await consumeInput(currentRun, input, true);
    } catch {
      return failBeforeRunStart(currentRun);
    }
    try {
      if (state.closeRequested || currentRun.abortController.signal.aborted) {
        return finishRun(currentRun, ABORTED_PROMPT_RESULT);
      }
      let contextFailure: string | null = null;

      const contextModelStream = runtime.context.controller.wrapRun({
        ...(runtime.remainingTaskTimeMs
          ? { remainingTaskTimeMs: runtime.remainingTaskTimeMs }
          : {}),
        runId: currentRun.runId,
        beforeRequest: async (signal) => {
          try {
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
        readMessages: () => state.context,
        recordMessage: (message, started) => recordMessage(currentRun, message, started),
        consumeSteer: () => (controlCall ? Promise.resolve(false) : consumeSteer(currentRun)),
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

  function failBeforeRunStart(currentRun: ActiveRunOwnership): FinishedPromptResult {
    currentRun.sessionWriteFailed = true;
    state.lastError = SAFE_SESSION_ERROR;
    state.sessionUnavailableResult = SESSION_FAILED_RESULT;
    state.inputsPaused = true;
    state.activeRun = null;
    publishEvent({ type: "session_unavailable", error: SAFE_SESSION_ERROR });
    return SESSION_FAILED_RESULT;
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
      await runtime.session.appendToolExecutionStarted(currentRun.runId, {
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

  /** 一个完成消息只有这个提交入口；Entry 返回后才更新唯一历史并交付完成事件。 */
  async function recordMessage(
    currentRun: ActiveRunOwnership,
    message: CompletedMessage,
    messageStartAlreadyPublished: boolean,
    internalInput?: AgentInputDetails,
    beforePublish?: () => void,
  ): Promise<string> {
    const alreadyCommitted =
      internalInput !== undefined && state.committedInputIds.has(internalInput.messageId);
    let entryId: string;
    let committedMessage: Message;
    try {
      const entry = internalInput
        ? await runtime.session.appendAgentInput(currentRun.runId, internalInput)
        : await runtime.session.appendMessage(currentRun.runId, message);
      entryId = entry.entryId;
      committedMessage = entry.type === "agent_input" ? internalMessage(entry) : entry.message;
      if (internalInput) state.committedInputIds.add(internalInput.messageId);
    } catch {
      currentRun.sessionWriteFailed = true;
      state.sessionUnavailableResult = SESSION_FAILED_RESULT;
      state.lastError = SAFE_SESSION_ERROR;
      currentRun.abortController.abort();
      throw new Error(SAFE_SESSION_ERROR);
    }
    if (committedMessage.role === "tool" && committedMessage.artifact !== undefined)
      runtime.artifactStore.registerReference(committedMessage.artifact);
    if (!alreadyCommitted) state.history.push({ entryId, message: committedMessage });
    if (committedMessage.role === "assistant") {
      if (committedMessage.diagnostic) currentRun.diagnostic = committedMessage.diagnostic;
      state.activeAssistantMessage = null;
    }
    beforePublish?.();
    if (!messageStartAlreadyPublished)
      publishEvent({ type: "message_start", message: committedMessage });
    publishEvent({ type: "message_end", message: committedMessage });
    return entryId;
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

  /** 完成唯一 Run 终态持久化后再交付事件；Session 写锁持续到整个 Agent 关闭。 */
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
      await runtime.session.appendRunFinished(currentRun.runId, {
        status: finalResult.status,
        diagnostic,
      });
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

    if (finalResult.status !== "completed")
      state.inputsPaused =
        state.sessionUnavailableResult !== null || !currentRun.resumeAfterTermination;
    if (state.activeRun === currentRun) state.activeRun = null;
    if (state.sessionUnavailableResult !== null) {
      publishEvent({ type: "session_unavailable", error: state.lastError ?? SAFE_SESSION_ERROR });
    } else {
      publishEvent({ type: "run_end", runId: currentRun.runId, result: finalResult, diagnostic });
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
    queueInternal,
    promptInternal(input) {
      if (input.rootSessionId !== runtime.session.rootSessionId)
        return Promise.resolve({ status: "failed", error: "内部输入的根 Session 不匹配。" });
      return submitInternal(input.content, input);
    },
    runTool(toolName, input) {
      const call: AssistantToolCallPart = {
        type: "tool_call",
        toolCallId: randomUUID(),
        toolName,
        input,
        invalid: false,
      };
      return submitInternal(
        "用户直接执行 " + toolName + "：\n" + JSON.stringify(input),
        undefined,
        call,
      );
    },
    external: runtime.tools.external,
    async compact(signal: AbortSignal) {
      await runtime.context.sources.prepare(signal);
      await runtime.context.controller.compact(
        prepareRequest(
          {
            systemPrompt: createCodingSystemPrompt(),
            messages: state.context,
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

function internalSource(input: AgentInputDetails): NonNullable<UserMessage["source"]> {
  return Object.freeze({
    kind: "agent",
    messageId: input.messageId,
    rootSessionId: input.rootSessionId,
    fromSessionId: input.fromSessionId,
  });
}
function internalMessage(input: AgentInputDetails): UserMessage {
  return Object.freeze({ ...agentInputMessage(input), source: internalSource(input) });
}
