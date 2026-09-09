import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGitWorkspace } from "./git/index.js";
import { createMemory } from "./memory/index.js";
import { createMultiAgent, type MultiAgent } from "./multi-agent/index.js";
import { createWorkspacePermissions } from "./permission/workspace-permissions.js";
import type { Session } from "./session/index.js";
import {
  type AgentEvent,
  type CreateAgentWithModelStreamOptions,
  createSessionAgent,
  type SessionAgent,
} from "./session-agent.js";
import { createGitTools } from "./tool/git-tools.js";
import type { AgentToolExtension } from "./tool/managed-tool.js";
import { createMultiAgentTools } from "./tool/multi-agent-tools.js";

/** 根与成员共享权限、Git 和任务时限；各自 Session、写锁、消息及 Memory 投影由各自 SessionAgent 持有。 */
export function createAgentRuntime(
  options: Omit<CreateAgentWithModelStreamOptions, "startCleanup">,
  events: {
    emit(event: AgentEvent): void;
    memberEvent(event: AgentEvent, member: { sessionId: string; name: string }): void;
  },
) {
  const { worktreeDirectory, ...sessionOptions } = options;
  const rootSession = options.session;
  const mode = options.permissionMode;
  const memoryDirectory =
    options.memoryDirectory ?? resolve(rootSession.sessionDirectory, "memory");
  const { emit } = events;
  const permissions = createWorkspacePermissions({
    workspaceRoot: rootSession.workspaceRoot,
    directory: options.permissionDirectory ?? resolve(rootSession.sessionDirectory, "permissions"),
  });
  const memory = createMemory({
    directory: memoryDirectory,
    workspaceRoot: rootSession.workspaceRoot,
  });
  const git = createGitWorkspace({
    workspaceRoot: rootSession.workspaceRoot,
    worktreeDirectory:
      worktreeDirectory ?? fileURLToPath(new URL("../../../data/worktrees", import.meta.url)),
    rootSessionId: rootSession.sessionId,
    readRecords: () => rootSession.records.filter((record) => record.type === "coordination"),
    appendRecord: (details) => rootSession.appendCoordination(details),
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
      }),
    ];
    return {
      definitions: (permissionMode) =>
        extensions.flatMap((extension) => extension.definitions(permissionMode)),
      createPlan: (call, permissionMode) => {
        for (const extension of extensions) {
          const plan = extension.createPlan(call, permissionMode);
          if (plan) return plan;
        }
        return null;
      },
    };
  }
  const coordinator = createMultiAgent({
    root: rootSession,
    git,
    modelStream: sessionOptions.modelStream,
    permissionMode: () => boundRuntime().agent.state.permissionMode,
    abortRoot: (source) => boundRuntime().agent.abort(source),
    changed: (snapshot) => emit({ type: "collaboration_changed", snapshot }),
    memberEvent: (member, event) => events.memberEvent(event, member),
    createMember(session, permissionMode) {
      const { coordinator } = boundRuntime();
      const memberMemory = createMemory({
        directory: memoryDirectory,
        workspaceRoot: session.workspaceRoot,
      });
      return createSessionAgent({
        session,
        permissionMode,
        modelStream: coordinator.modelStream,
        ...(sessionOptions.modelContext ? { modelContext: sessionOptions.modelContext } : {}),
        ...(sessionOptions.skills ? { skills: sessionOptions.skills } : {}),
        ...(sessionOptions.mcp ? { mcp: sessionOptions.mcp } : {}),
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
        managedTools: toolsFor(session, coordinator),
        beforeRequest: (lease, signal) => coordinator.drain(session.sessionId, lease, signal),
        authorizationRecords: () => rootSession.records,
        workspacePermissions: permissions,
        permissionMember: true,
        ...(sessionOptions.protectedPaths ? { protectedPaths: sessionOptions.protectedPaths } : {}),
        remainingTaskTimeMs: () => coordinator.remainingTaskTimeMs(),
      });
    },
  });
  const primary = createSessionAgent({
    ...sessionOptions,
    session: rootSession,
    permissionMode: mode,
    modelStream: coordinator.modelStream,
    memory,
    workspacePermissions: permissions,
    remainingTaskTimeMs: () => coordinator.remainingTaskTimeMs(),
    managedTools: toolsFor(rootSession, coordinator),
    beforeRequest: (lease, signal) => coordinator.drain(rootSession.sessionId, lease, signal),
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
      coordinator.abort(source);
    },
    async close() {
      // 成员可能向根写入终态；必须先收齐成员，再释放根的 Session 与写锁。
      try {
        await coordinator.close();
      } finally {
        await primary.close();
      }
    },
  };
}
