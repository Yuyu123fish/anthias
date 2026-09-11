import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMemory } from "./memory/index.js";
import { createMultiAgent, type MultiAgent } from "./multi-agent/index.js";
import { createWorkspacePermissions } from "./permission/workspace-permissions.js";
import type { Session } from "./session/index.js";
import {
  type AgentEvent,
  type CreateAgentWithModelStreamOptions,
  createSessionAgent,
  type PermissionMode,
  type SessionAgent,
  type SessionAgentOptions,
} from "./session-agent.js";
import { createGitWorkspace } from "./tool/basetool/git/index.js";
import { createGitTools } from "./tool/basetool/git/tool.js";
import type { AgentToolExtension } from "./tool/managed-tool.js";
import { createMultiAgentTools } from "./tool/multi-agent-tools.js";
import { sharedWorkspaceAccess } from "./tool/workspace-access.js";

/** 根与成员共享权限、Git 和任务时限；各自 Session、写锁、消息及 Memory 投影由各自 SessionAgent 持有。 */
export function createAgentRuntime(
  options: Omit<CreateAgentWithModelStreamOptions, "startCleanup">,
  events: {
    emit(event: AgentEvent): void;
    memberEvent(event: AgentEvent, member: { sessionId: string; name: string }): void;
  },
) {
  const {
    worktreeDirectory,
    memoryDirectory: configuredMemoryDirectory,
    permissionDirectory,
    ...sessionOptions
  } = options;
  const rootSession = options.session;
  const mode = options.permissionMode;
  const memoryDirectory =
    configuredMemoryDirectory ?? resolve(rootSession.sessionDirectory, "memory");
  const { emit } = events;
  const permissions = createWorkspacePermissions({
    workspaceRoot: rootSession.workspaceRoot,
    directory: permissionDirectory ?? resolve(rootSession.sessionDirectory, "permissions"),
  });
  const memory = createMemory({
    directory: memoryDirectory,
    workspaceRoot: rootSession.workspaceRoot,
  });
  const git = createGitWorkspace({
    workspaceAccess: sharedWorkspaceAccess,
    workspaceRoot: rootSession.workspaceRoot,
    worktreeDirectory:
      worktreeDirectory ?? fileURLToPath(new URL("../../../data/worktrees", import.meta.url)),
    rootSessionId: rootSession.sessionId,
    readRecords: () => rootSession.records.filter((record) => record.type === "coordination"),
    appendRecord: async (details) => {
      await rootSession.appendCoordination(null, details);
    },
  });
  let bindings: { agent: SessionAgent; coordinator: MultiAgent } | null = null;
  // 构造只恢复已有事实，不启动 Run；所有运行回调在装配发布后才能访问彼此。
  function boundRuntime() {
    if (bindings === null) throw new Error("Runtime 尚未完成装配。");
    return bindings;
  }
  function toolsFor(session: Session, coordinator: MultiAgent): AgentToolExtension {
    const member =
      session.sessionId === rootSession.sessionId
        ? undefined
        : coordinator.member(session.sessionId);
    const extensions = [
      ...(options.managedTools ? [options.managedTools] : []),
      createMultiAgentTools({
        callerSessionId: session.sessionId,
        rootSessionId: rootSession.sessionId,
        coordinator,
      }),
      createGitTools({
        git,
        primary: !member,
        ...(member?.worktreeId ? { memberWorktreeId: member.worktreeId } : {}),
        assertIdle: (id) => coordinator.assertWorktreeIdle(id),
        assertWriteAllowed: (id) => boundRuntime().agent.toolAccess.assertWriteAllowed(id),
        resourceState: (id, state) => boundRuntime().agent.toolAccess.resourceState(id, state),
      }),
    ];
    return {
      tools: (permissionMode) => extensions.flatMap((extension) => extension.tools(permissionMode)),
      rejectUnavailableTool(call, permissionMode) {
        for (const extension of extensions) {
          const rejection = extension.rejectUnavailableTool?.(call, permissionMode);
          if (rejection) return rejection;
        }
        return null;
      },
    };
  }
  function commonAgentOptions(
    session: Session,
    permissionMode: PermissionMode | undefined,
    coordinator: MultiAgent,
  ): SessionAgentOptions {
    return {
      session,
      permissionMode,
      modelStream: coordinator.modelStream,
      ...(sessionOptions.modelContext ? { modelContext: sessionOptions.modelContext } : {}),
      ...(sessionOptions.skills ? { skills: sessionOptions.skills } : {}),
      ...(sessionOptions.mcp ? { mcp: sessionOptions.mcp } : {}),
      ...(sessionOptions.protectedPaths ? { protectedPaths: sessionOptions.protectedPaths } : {}),
      managedTools: toolsFor(session, coordinator),
      pendingInputs: () => coordinator.pendingInputs(session.sessionId),
      acknowledgeInput: (input) => coordinator.acknowledgeInput(input),
      workspacePermissions: permissions,
      remainingTaskTimeMs: () => coordinator.remainingTaskTimeMs(),
    };
  }
  const coordinator = createMultiAgent({
    root: rootSession,
    git,
    modelStream: sessionOptions.modelStream,
    permissionMode: () => boundRuntime().agent.state.permissionMode,
    receiveRootInput(input) {
      const { agent, coordinator } = boundRuntime();
      if (agent.state.running || agent.state.inputQueue.paused || !coordinator.schedulingEnabled())
        agent.queueInternal(input);
      else void agent.promptInternal(input).catch(() => undefined);
    },
    abortRoot: (source) => boundRuntime().agent.abort(source),
    changed: (snapshot) => emit({ type: "collaboration_changed", snapshot }),
    memberEvent: (member, event) => events.memberEvent(event, member),
    createMember(session, permissionMode, writable) {
      const { coordinator } = boundRuntime();
      const memberMemory = createMemory({
        directory: memoryDirectory,
        workspaceRoot: session.workspaceRoot,
      });
      return createSessionAgent({
        ...commonAgentOptions(session, permissionMode, coordinator),
        memory: memberMemory,
        maintainMemory: async (action, writer, signal) => {
          if (action.action !== "save" || action.id)
            throw new Error("成员只能提交新候选，不能覆盖共享记忆。");
          const snapshot = await memberMemory.execute(
            action,
            { ...writer, explicit: false, candidate: true },
            signal,
          );
          emit({ type: "memory_changed" });
          return snapshot;
        },
        authorizationRecords: () => rootSession.records,
        permissionMember: true,
        writable,
      });
    },
  });
  const primary = createSessionAgent({
    ...sessionOptions,
    ...commonAgentOptions(rootSession, mode, coordinator),
    memory,
    onRunSettled(result) {
      if (boundRuntime().agent.state.running) return;
      if (result.status === "completed") coordinator.endTask();
      else coordinator.abort("parent");
    },
  });
  bindings = { agent: primary, coordinator };
  return {
    agent: primary,
    coordinator,
    git,
    memory,
    permissions,
    abort(source?: "shutdown") {
      primary.abort(source);
      coordinator.abort(source ?? "user");
    },
    async close(reason: "closed" | "session_changed" = "closed") {
      // 成员可能向根写入终态；必须先收齐成员，再释放根的 Session 与写锁。
      try {
        await coordinator.close();
      } finally {
        await primary.close(reason);
      }
    },
  };
}
