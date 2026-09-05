export type ActionResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: string }>;
export type AgentOperation = "compacting" | "switching_session" | "updating_capabilities" | null;
export type SessionSummary = Readonly<{ id: string; createdAt: string; title?: string }>;
export type SkillSummary = Readonly<{
  id: string;
  name: string;
  description: string;
  source: string;
  path: string;
  active: boolean;
  error?: string;
}>;
export type McpServerSummary = Readonly<{
  id: string;
  source: string;
  transport: string;
  status: "disconnected" | "connecting" | "connected" | "error";
  error?: string;
}>;
export type McpCapabilities = Readonly<{
  diagnostics?: readonly string[];
  tools: readonly Readonly<{ name: string; description?: string }>[];
  resources: readonly Readonly<{ uri: string; name?: string; description?: string }>[];
  prompts: readonly Readonly<{
    name: string;
    description?: string;
    arguments?: readonly Readonly<{ name: string; required?: boolean }>[];
  }>[];
}>;
/** 这些行为由 Agent 持有；交互层只映射命令和展示安全摘要。 */
export type AgentControls = Readonly<{
  sessions: Readonly<{
    list(): Promise<ActionResult<readonly SessionSummary[]>>;
    create(): Promise<ActionResult<void>>;
    open(id: string): Promise<ActionResult<void>>;
  }>;
  compact(): Promise<ActionResult<void>>;
  skills: Readonly<{
    list(): readonly SkillSummary[];
    reload(): Promise<ActionResult<void>>;
    activate(id: string | null): Promise<ActionResult<void>>;
  }>;
  mcp: Readonly<{
    list(): readonly McpServerSummary[];
    connect(id: string): Promise<ActionResult<void>>;
    disconnect(id: string): Promise<ActionResult<void>>;
    inspect(id: string): Promise<ActionResult<McpCapabilities>>;
    readResource(id: string, uri: string): Promise<ActionResult<void>>;
    getPrompt(
      id: string,
      name: string,
      args?: Readonly<Record<string, string>>,
    ): Promise<ActionResult<void>>;
  }>;
}>;
