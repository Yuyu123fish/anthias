import { resolve } from "node:path";
import type { ActionResult, AgentControls, AgentOperation } from "./agent-controls.js";
import { type CollaborationAction, isDirectCollaborationControl } from "./multi-agent/index.js";
import { createAgentRuntime } from "./runtime.js";
import type { Session } from "./session/index.js";
import { createSession, openSession } from "./session/index.js";
import { listSessions } from "./session/query.js";
import type {
  AgentEvent,
  AgentListener,
  CreateAgentWithModelStreamOptions,
  PermissionMode,
  SessionAgent,
  ToolApprovalRequest,
} from "./session-agent.js";
import { executeGitAction, type GitAction, isGitQuery } from "./tool/basetool/git/tool.js";
import { collaborationToolCall } from "./tool/multi-agent-tools.js";

export type {
  ActiveRun,
  AgentEvent,
  AgentListener,
  AgentState,
  CreateAgentWithModelStreamOptions,
  FinishedPromptResult,
  InputMode,
  PendingInput,
  PermissionMode,
  PermissionModeChangeResult,
  PromptOptions,
  PromptResult,
  RunPhase,
  ToolActivity,
  ToolApprovalRequest,
  ToolApprovalResponse,
} from "./session-agent.js";
export type Agent = Omit<
  SessionAgent,
  "external" | "compact" | "promptInternal" | "queueInternal" | "runTool" | "abort" | "close"
> &
  AgentControls &
  Readonly<{ abort(): void; close(): Promise<void> }>;

/** 稳定 Agent 持有当前会话及所有外部连接；切换准备失败不影响原会话。 */
export function createAgentWithModelStream(options: CreateAgentWithModelStreamOptions): Agent {
  const { startCleanup, ...sessionOptions } = options;
  let currentSession = options.session;
  const memoryDirectory =
    options.memoryDirectory ?? resolve(options.session.sessionDirectory, "memory");
  const pendingApprovals = new Map<string, ToolApprovalRequest>();
  const listeners = new Set<AgentListener>();
  let operation: AgentOperation = null;
  let operationController: AbortController | null = null;
  let operationPromise: Promise<unknown> | null = null;
  let closed = false;
  let closePromise: Promise<void> | null = null;
  const directControls = new Map<AbortController, Promise<unknown>>();
  let currentRuntime = createRuntime(currentSession, options.permissionMode);
  let currentAgent = currentRuntime.agent;

  async function runDirectControl<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (closed || operation !== null) throw new Error("Agent 已关闭或正在切换会话。");
    const controller = new AbortController();
    const completion = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return work(controller.signal);
    });
    directControls.set(controller, completion);
    try {
      return await completion;
    } finally {
      directControls.delete(controller);
    }
  }
  function emit(event: AgentEvent) {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        /* 观察者不能破坏 Agent 生命周期。 */
      }
    }
  }
  let unsubscribe = currentAgent.subscribe((event) => routeEvent(event));
  const stopCleanup = startCleanup?.((result) => emit({ type: "session_cleanup", result }));

  function routeEvent(event: AgentEvent, member?: { sessionId: string; name: string }) {
    if (event.type === "tool_approval_requested") {
      const request = member
        ? { ...event.request, memberSessionId: member.sessionId, memberName: member.name }
        : event.request;
      pendingApprovals.set(request.toolApprovalRequestId, request);
      if (pendingApprovals.size === 1) emit({ ...event, request });
      return;
    }
    if (event.type === "tool_approval_resolved") {
      const first = pendingApprovals.values().next().value;
      const request = pendingApprovals.get(event.request.toolApprovalRequestId);
      pendingApprovals.delete(event.request.toolApprovalRequestId);
      if (first?.toolApprovalRequestId === event.request.toolApprovalRequestId) {
        emit({ ...event, request: request ?? event.request });
        const nextApproval = pendingApprovals.values().next().value;
        if (nextApproval) emit({ type: "tool_approval_requested", request: nextApproval });
      }
      return;
    }
    if (!member) emit(event);
    else if (event.type.startsWith("tool_") || event.type === "model_retry")
      emit({ ...event, memberSessionId: member.sessionId, memberName: member.name });
    else if (event.type === "run_end") {
      emit({ ...event, memberSessionId: member.sessionId, memberName: member.name });
      emit({ type: "collaboration_changed", snapshot: currentRuntime.coordinator.snapshot() });
    } else if (event.type === "run_start" || event.type === "run_phase_changed")
      emit({ type: "collaboration_changed", snapshot: currentRuntime.coordinator.snapshot() });
  }

  function createRuntime(rootSession: Session, mode?: PermissionMode) {
    if (
      rootSession.sessionKind !== "primary" ||
      rootSession.rootSessionId !== rootSession.sessionId
    )
      fail("成员 Session 必须从其根 Session 查看或继续，不能作为主 Agent 打开。");
    return createAgentRuntime(
      { ...sessionOptions, session: rootSession, permissionMode: mode, memoryDirectory },
      { emit, memberEvent: routeEvent },
    );
  }

  async function invokeTool(
    toolName: string,
    input: import("./message.js").JsonValue,
  ): Promise<ActionResult<string>> {
    if (closed || operation !== null) return { ok: false, error: "Agent 已关闭或正在切换会话。" };
    if (currentAgent.state.running)
      return { ok: false, error: "主 Agent 正在执行，请等待或停止后再发起操作。" };
    currentRuntime.coordinator.beginTask();
    const toolRunPromptResult = await currentAgent.runTool(toolName, input);
    if (toolRunPromptResult.status !== "completed")
      return {
        ok: false,
        error:
          toolRunPromptResult.status === "failed"
            ? toolRunPromptResult.error
            : toolRunPromptResult.status === "rejected"
              ? toolRunPromptResult.reason
              : "操作已停止。",
      };
    const toolResult = currentAgent.state.messageHistory.findLast(
      (message) => message.role === "tool",
    );
    return toolResult?.role === "tool" && toolResult.status === "completed"
      ? { ok: true, value: toolResult.content }
      : { ok: false, error: toolResult?.role === "tool" ? toolResult.content : "操作未返回结果。" };
  }

  function perform<T>(
    name: Exclude<AgentOperation, null>,
    work: (signal: AbortSignal) => Promise<T>,
    preservesCommittedResult = false,
  ): Promise<ActionResult<T>> {
    if (closed) return Promise.resolve({ ok: false, error: "Agent 已关闭。" });
    if (
      operation !== null ||
      directControls.size > 0 ||
      currentAgent.state.running ||
      currentRuntime.coordinator.busy()
    )
      return Promise.resolve({ ok: false, error: "Agent 正忙，请先停止或等待当前操作完成。" });
    operation = name;
    const controller = new AbortController();
    operationController = controller;
    // 先登记可等待的操作，再向允许同步重入的订阅者发布状态。
    const completion = Promise.withResolvers<ActionResult<T>>();
    operationPromise = completion.promise;
    emit({ type: "operation_changed", operation });
    void (async (): Promise<ActionResult<T>> => {
      try {
        if (closed || controller.signal.aborted) return { ok: false, error: "操作已取消。" };
        const value = await work(controller.signal);
        return controller.signal.aborted && !preservesCommittedResult
          ? { ok: false, error: "操作已取消。" }
          : { ok: true, value };
      } catch (error) {
        return {
          ok: false,
          error: controller.signal.aborted
            ? "操作已取消。"
            : isSafeFailure(error)
              ? error.error
              : "操作未完成；当前会话历史已保留，请检查目标或稍后重试。",
        };
      } finally {
        operation = null;
        operationController = null;
        operationPromise = null;
        emit({ type: "operation_changed", operation });
      }
    })().then(completion.resolve, completion.reject);
    return completion.promise;
  }

  async function switchSession(id: string | undefined, signal: AbortSignal) {
    if (id === currentSession.sessionId) return;
    const settings = {
      workspaceRoot: currentSession.workspaceRoot,
      sessionDirectory: currentSession.sessionDirectory,
      shell: currentSession.shell,
    };
    const target =
      id === undefined
        ? await createSession(settings)
        : await openSession({ ...settings, sessionId: id });
    let preparedAgent: SessionAgent | undefined;
    let preparedRuntime: ReturnType<typeof createRuntime> | undefined;
    try {
      preparedRuntime = createRuntime(target, currentAgent.state.permissionMode);
      preparedAgent = preparedRuntime.agent;
      await preparedAgent.external.diagnoseSkills();
      if (signal.aborted || closed) throw new Error("cancelled");
    } catch (error) {
      if (preparedRuntime) await preparedRuntime.close();
      else await target.close();
      throw error;
    }
    const previousRuntime = currentRuntime;
    const unsubscribePrevious = unsubscribe;
    currentSession = target;
    currentAgent = preparedAgent;
    if (!preparedRuntime) throw new Error("会话装配未完成。");
    currentRuntime = preparedRuntime;
    pendingApprovals.clear();
    unsubscribe = currentAgent.subscribe((event) => routeEvent(event));
    emit({ type: "session_changed", sessionId: target.sessionId });
    emit({ type: "skills_changed" });
    try {
      await previousRuntime.close("session_changed");
    } finally {
      unsubscribePrevious();
    }
  }

  const agent: Agent = {
    get state() {
      return Object.freeze({
        ...currentAgent.state,
        operation,
        running: currentAgent.state.running || currentRuntime.coordinator.busy(),
        pendingToolApproval: pendingApprovals.values().next().value ?? null,
        collaboration: currentRuntime.coordinator.snapshot(),
      });
    },
    prompt(text, promptOptions) {
      if (closed) return Promise.resolve({ status: "rejected", reason: "closed" });
      if (operation !== null) return Promise.resolve({ status: "rejected", reason: "busy" });
      if (!currentAgent.state.running) currentRuntime.coordinator.beginTask();
      return currentAgent.prompt(text, promptOptions);
    },
    setPermissionMode(mode) {
      if (closed) return { status: "rejected", reason: "closed" };
      if (operation !== null || directControls.size > 0 || currentRuntime.coordinator.busy())
        return { status: "rejected", reason: "busy" };
      return currentAgent.setPermissionMode(mode);
    },
    respondToToolApproval(id, decision) {
      const primary = currentAgent.respondToToolApproval(id, decision);
      return primary.status === "accepted"
        ? primary
        : currentRuntime.coordinator.respondToToolApproval(id, decision);
    },
    abort() {
      operationController?.abort();
      for (const controller of directControls.keys()) controller.abort();
      currentRuntime.abort();
    },
    close() {
      if (closePromise !== null) return closePromise;
      closed = true;
      operationController?.abort();
      for (const controller of directControls.keys()) controller.abort();
      currentRuntime.abort("shutdown");
      closePromise = (async () => {
        try {
          await operationPromise;
          await Promise.allSettled([...directControls.values()]);
          await currentRuntime.close();
        } finally {
          try {
            await options.mcp?.close();
          } finally {
            try {
              await stopCleanup?.();
            } finally {
              unsubscribe();
              listeners.clear();
            }
          }
        }
      })();
      return closePromise;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    permissions: {
      snapshot: () => currentRuntime.permissions.snapshot(),
      async grant(input) {
        try {
          return await runDirectControl(() => currentRuntime.permissions.grant(input));
        } catch {
          return { ok: false, error: "当前无法变更授权，请等待会话切换完成。" };
        }
      },
      async revoke() {
        try {
          return await runDirectControl(() => currentRuntime.permissions.revoke());
        } catch {
          return { ok: false, error: "当前无法撤销授权，请等待会话切换完成。" };
        }
      },
    },
    memory: {
      async query(query) {
        try {
          return {
            ok: true,
            value: await runDirectControl((signal) => currentRuntime.memory.query(query, signal)),
          };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : "记忆不可读取。" };
        }
      },
      execute: (action) =>
        perform(
          "updating_memory",
          async (signal) => {
            try {
              const snapshot = await currentRuntime.memory.execute(
                action,
                {
                  explicit: true,
                  source: {
                    kind: "user",
                    sessionId: currentSession.sessionId,
                    entryIds: [],
                    note: "用户通过 /memory 管理。",
                  },
                },
                signal,
              );
              emit({ type: "memory_changed" });
              return snapshot;
            } catch (error) {
              return fail(error instanceof Error ? error.message : "记忆维护失败。");
            }
          },
          true,
        ),
    },
    collaboration: {
      snapshot: () => currentRuntime.coordinator.snapshot(),
      async execute(action: CollaborationAction) {
        try {
          if (closed) return { ok: false, error: "Agent 已关闭。" };
          if (isDirectCollaborationControl(action)) {
            return {
              ok: true,
              value: await runDirectControl((signal) =>
                currentRuntime.coordinator.execute(currentSession.sessionId, action, signal),
              ),
            };
          }
          const call = collaborationToolCall(action);
          return invokeTool(call.toolName, call.input);
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : "协作操作失败。" };
        }
      },
    },
    git: {
      async execute(action: GitAction) {
        try {
          if (closed) return { ok: false, error: "Agent 已关闭。" };
          if (isGitQuery(action))
            return {
              ok: true,
              value: await runDirectControl((signal) =>
                executeGitAction(currentRuntime.git, action, signal),
              ),
            };
          return invokeTool("git", action);
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : "Git 操作失败。" };
        }
      },
    },
    sessions: {
      async list() {
        try {
          return {
            ok: true,
            value: await listSessions(
              currentSession.sessionDirectory,
              currentSession.workspaceRoot,
            ),
          };
        } catch {
          return { ok: false, error: "Session 列表暂时不可用。" };
        }
      },
      create: () => perform("switching_session", (signal) => switchSession(undefined, signal)),
      open: (id) => perform("switching_session", (signal) => switchSession(id, signal)),
    },
    compact: () => perform("compacting", (signal) => currentAgent.compact(signal)),
    skills: {
      list: () => currentAgent.external.listSkills(),
      reload: () =>
        perform("updating_capabilities", async () => {
          await currentAgent.external.reloadSkills();
          emit({ type: "skills_changed" });
        }),
      activate: (id) =>
        perform("updating_capabilities", async (signal) => {
          try {
            await currentAgent.external.activate(id, signal);
          } catch (error) {
            fail(error instanceof Error ? error.message : "Skill 激活失败。");
          }
          emit({ type: "skills_changed" });
        }),
    },
    mcp: {
      list: () =>
        (options.mcp?.list() ?? []).map((server) => ({
          id: server.id,
          source: server.source,
          transport: server.transport,
          status: server.state,
          ...(server.error ? { error: server.error } : {}),
        })),
      connect: (id) =>
        perform("updating_capabilities", async (signal) => {
          const result = await options.mcp?.connect(id, signal);
          emit({ type: "mcp_changed" });
          if (!result?.ok) fail(result && !result.ok ? result.error : "MCP 未启用。");
        }),
      disconnect: (id) =>
        perform("updating_capabilities", async () => {
          const result = await options.mcp?.disconnect(id);
          emit({ type: "mcp_changed" });
          if (!result?.ok) fail(result && !result.ok ? result.error : "MCP 未启用。");
        }),
      async inspect(id) {
        const result = await options.mcp?.inspect(id);
        if (!result?.ok)
          return { ok: false, error: result && !result.ok ? result.error : "MCP 未启用。" };
        return {
          ok: true,
          value: {
            tools: result.value.tools.map(({ name, description }) => ({ name, description })),
            resources: result.value.resources,
            prompts: result.value.prompts,
            diagnostics: [...result.value.diagnostics, ...currentAgent.external.mcpDiagnostics()],
          },
        };
      },
      readResource: (id, uri) =>
        perform("updating_capabilities", async (signal) => {
          const result = await options.mcp?.readResource(id, uri, signal);
          if (!result?.ok) fail(result && !result.ok ? result.error : "MCP 未启用。");
          if (signal.aborted) return;
          await currentAgent.external.saveMcpContent(
            "mcp_resource",
            `${id} / ${uri}`,
            result.value,
          );
        }),
      getPrompt: (id, name, args) =>
        perform("updating_capabilities", async (signal) => {
          const result = await options.mcp?.getPrompt(id, name, args, signal);
          if (!result?.ok) fail(result && !result.ok ? result.error : "MCP 未启用。");
          if (signal.aborted) return;
          await currentAgent.external.saveMcpContent("mcp_prompt", `${id} / ${name}`, result.value);
        }),
    },
  };
  return Object.freeze(agent);
}

function fail(error: string): never {
  throw { ok: false, error };
}
function isSafeFailure(value: unknown): value is { ok: false; error: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    value.ok === false &&
    "error" in value &&
    typeof value.error === "string"
  );
}
