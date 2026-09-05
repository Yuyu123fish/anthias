import type {
  Agent,
  AgentEvent,
  AgentListener,
  AgentState,
  PromptResult,
  ToolApprovalRequest,
} from "@anthias/agent";
import { vi } from "vitest";

export function createFakeAgent() {
  const listeners = new Set<AgentListener>();
  const emptyUsage = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
  };
  let state: AgentState = {
    sessionId: "00000000-0000-4000-8000-000000000001",
    workspaceRoot: process.cwd(),
    permissionMode: "agent",
    contextUsage: {
      contextWindow: 128_000,
      inputTokens: 1_000,
      source: "estimated",
      responseOutputTokens: 16_000,
      summaryOutputTokens: 8_000,
      compactions: 0,
      externalTokens: 200,
      toolDefinitionTokens: 600,
      requests: { response: emptyUsage, compaction: emptyUsage, approval: emptyUsage },
    },
    messageHistory: [],
    activeAssistantMessage: null,
    activeRun: null,
    pendingToolApproval: null,
    running: false,
    operation: null,
    lastError: null,
  };
  const ok = () => Promise.resolve({ ok: true as const, value: undefined });
  const agent: Agent = {
    get state() {
      return state;
    },
    prompt: vi.fn<Agent["prompt"]>(async (): Promise<PromptResult> => ({ status: "completed" })),
    close: vi.fn<Agent["close"]>(async () => {}),
    abort: vi.fn(),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setPermissionMode: vi.fn<Agent["setPermissionMode"]>((permissionMode) => {
      state = { ...state, permissionMode };
      return { status: "accepted", permissionMode };
    }),
    respondToToolApproval: vi.fn<Agent["respondToToolApproval"]>(() => ({ status: "accepted" })),
    sessions: {
      list: vi.fn<Agent["sessions"]["list"]>(async () => ({
        ok: true,
        value: [{ id: state.sessionId, createdAt: "2026-09-05", title: "Current session" }],
      })),
      create: vi.fn(ok),
      open: vi.fn(ok),
    },
    compact: vi.fn(ok),
    skills: {
      list: vi.fn(() => [
        {
          id: "project:typescript",
          name: "typescript",
          description: "TypeScript coding",
          source: "project",
          path: process.cwd(),
          active: false,
        },
      ]),
      activate: vi.fn(ok),
      reload: vi.fn(ok),
    },
    mcp: {
      list: vi.fn<Agent["mcp"]["list"]>(() => [
        { id: "local", source: "project", transport: "stdio", status: "disconnected" },
      ]),
      connect: vi.fn(ok),
      disconnect: vi.fn(ok),
      inspect: vi.fn<Agent["mcp"]["inspect"]>(async () => ({
        ok: true,
        value: {
          tools: [{ name: "echo" }],
          resources: [{ uri: "local://readme" }],
          prompts: [{ name: "review", arguments: [{ name: "path", required: true }] }],
        },
      })),
      readResource: vi.fn(ok),
      getPrompt: vi.fn(ok),
    },
  };
  return {
    agent,
    setState(change: Partial<AgentState>) {
      state = { ...state, ...change };
    },
    emit(event: AgentEvent) {
      for (const listener of listeners) listener(event);
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

export function approvalRequest(preview = "echo hello"): ToolApprovalRequest {
  return {
    toolApprovalRequestId: "approval-1",
    toolCallId: "call-1",
    toolName: "execute_command",
    target: process.cwd(),
    preview,
    permissionMode: "agent",
    riskSummary: "Runs a workspace command",
    executionBoundary: "Local process; no OS sandbox",
  };
}
