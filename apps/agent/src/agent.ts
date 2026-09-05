import type { ActionResult, AgentControls, AgentOperation } from "./agent-controls.js";
import { createSession, openSession } from "./session/index.js";
import { listSessions } from "./session/list.js";
import {
  type AgentEvent,
  type AgentListener,
  type CreateAgentWithModelStreamOptions,
  createSessionAgent,
  type SessionAgent,
} from "./session-agent.js";

export type {
  ActiveRun,
  AgentEvent,
  AgentListener,
  AgentState,
  CreateAgentWithModelStreamOptions,
  FinishedPromptResult,
  PermissionMode,
  PermissionModeChangeResult,
  PromptResult,
  RunPhase,
  ToolActivity,
  ToolApprovalRequest,
  ToolApprovalResponse,
} from "./session-agent.js";
export type Agent = Omit<SessionAgent, "external" | "compact"> & AgentControls;

/** 稳定 Agent 持有当前会话及所有外部连接；切换准备失败不影响原会话。 */
export function createAgentWithModelStream(options: CreateAgentWithModelStreamOptions): Agent {
  const { startCleanup, ...sessionOptions } = options;
  let currentSession = options.session;
  let currentAgent = createSessionAgent(sessionOptions);
  const listeners = new Set<AgentListener>();
  let operation: AgentOperation = null;
  let operationController: AbortController | null = null;
  let operationPromise: Promise<unknown> | null = null;
  let closed = false;
  let closePromise: Promise<void> | null = null;
  function emit(event: AgentEvent) {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        /* 观察者不能破坏 Agent 生命周期。 */
      }
    }
  }
  let unsubscribe = currentAgent.subscribe(emit);
  const stopCleanup = startCleanup?.((result) => emit({ type: "session_cleanup", result }));

  function perform<T>(
    name: Exclude<AgentOperation, null>,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<ActionResult<T>> {
    if (closed) return Promise.resolve({ ok: false, error: "Agent 已关闭。" });
    if (operation !== null || currentAgent.state.running)
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
        return controller.signal.aborted
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
    try {
      preparedAgent = createSessionAgent({
        ...sessionOptions,
        session: target,
        permissionMode: currentAgent.state.permissionMode,
      });
      await preparedAgent.external.diagnoseSkills();
      if (signal.aborted || closed) throw new Error("cancelled");
    } catch (error) {
      if (preparedAgent) await preparedAgent.close();
      else await target.close();
      throw error;
    }
    const previousAgent = currentAgent;
    unsubscribe();
    currentSession = target;
    currentAgent = preparedAgent;
    unsubscribe = currentAgent.subscribe(emit);
    emit({ type: "session_changed", sessionId: target.sessionId });
    emit({ type: "skills_changed" });
    await previousAgent.close();
  }

  const agent: Agent = {
    get state() {
      return Object.freeze({ ...currentAgent.state, operation });
    },
    prompt(text) {
      if (closed) return Promise.resolve({ status: "rejected", reason: "closed" });
      if (operation !== null) return Promise.resolve({ status: "rejected", reason: "busy" });
      return currentAgent.prompt(text);
    },
    setPermissionMode(mode) {
      if (closed) return { status: "rejected", reason: "closed" };
      if (operation !== null) return { status: "rejected", reason: "busy" };
      return currentAgent.setPermissionMode(mode);
    },
    respondToToolApproval(id, decision) {
      return currentAgent.respondToToolApproval(id, decision);
    },
    abort() {
      operationController?.abort();
      currentAgent.abort();
    },
    close() {
      if (closePromise !== null) return closePromise;
      closed = true;
      operationController?.abort();
      currentAgent.abort();
      closePromise = (async () => {
        try {
          await operationPromise;
          await currentAgent.close();
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
