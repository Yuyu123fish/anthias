import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { JSONSchema7 } from "ai";
import type { SkillSummary } from "./agent-controls.js";
import { estimateTextTokens } from "./context/budget.js";
import type { ContextSources } from "./context/sources.js";
import type { McpConnections, McpContent } from "./mcp/index.js";
import type { AssistantToolCallPart } from "./message.js";
import type { ModelRequest } from "./model/model-stream.js";
import type { PermissionMode } from "./permission/permission-mode.js";
import type { SkillContent, SkillLibrary } from "./skill/index.js";
import type { ModelToolDefinition } from "./tool/definitions.js";
import { isRecord } from "./tool/input-validation.js";
import type { ToolCallPlan } from "./tool/tool-runner.js";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const skillKey = (id: string) => `skill:${id}`;

/** 文件/连接能力共享，激活事实与产物严格绑定当前 Session。 */
export function createExternalCapabilities(options: {
  sources: ContextSources;
  skills: SkillLibrary | undefined;
  mcp: McpConnections | undefined;
}) {
  const activeSources = options.sources.active;
  const skillDiagnostics = new Map<string, string>();
  let visibleMcpTools = new Set<string>();
  let omittedMcpTools = 0;
  const saveSource = options.sources.save;

  async function activate(id: string | null, signal?: AbortSignal, replace = true) {
    signal?.throwIfAborted();
    if (id === null) {
      for (const source of [...activeSources.values()].filter(
        (item) => item.kind === "skill" || item.kind === "skill_reference",
      )) {
        signal?.throwIfAborted();
        await saveSource({ ...source, content: null });
      }
      skillDiagnostics.clear();
      return;
    }
    if (!options.skills) throw new Error("Skill 目录尚未启用。");
    if (!replace) {
      const matches = listSkills().filter((skill) => skill.id === id || skill.name === id);
      const matchedSkill = matches[0];
      if (matches.length === 1 && matchedSkill && activeSources.has(skillKey(matchedSkill.id)))
        return;
    }
    const loaded = await options.skills.load(id);
    signal?.throwIfAborted();
    const previous = activeSources.get(skillKey(loaded.skill.id));
    await saveSkill(loaded, false);
    if (previous && previous.fingerprint !== loaded.fingerprint) {
      for (const reference of [...activeSources.values()].filter((item) =>
        item.sourceId.startsWith("skill-ref:" + loaded.skill.id + ":"),
      )) {
        signal?.throwIfAborted();
        await saveSource({ ...reference, content: null });
      }
    }
  }

  async function saveSkill(loaded: SkillContent, reference: boolean) {
    await saveSource({
      sourceId: reference
        ? `skill-ref:${loaded.skill.id}:${JSON.stringify(loaded.path)}`
        : skillKey(loaded.skill.id),
      kind: reference ? "skill_reference" : "skill",
      label: `${loaded.skill.id} / ${loaded.path}`,
      content: loaded.content,
      fingerprint: loaded.fingerprint,
    });
    if (!reference) skillDiagnostics.delete(loaded.skill.id);
  }

  async function diagnoseSkills() {
    skillDiagnostics.clear();
    for (const source of activeSources.values()) {
      if (source.kind !== "skill") continue;
      const id = source.sourceId.slice("skill:".length);
      try {
        const body = await options.skills?.load(id);
        if (body?.fingerprint !== source.fingerprint)
          skillDiagnostics.set(id, "正文已变化，当前仍使用 Session 保存的版本；可显式重新激活。");
        for (const reference of activeSources.values()) {
          const prefix = "skill-ref:" + id + ":";
          if (!reference.sourceId.startsWith(prefix)) continue;
          const loaded = await options.skills?.read(
            id,
            JSON.parse(reference.sourceId.slice(prefix.length)) as string,
          );
          if (loaded?.fingerprint !== reference.fingerprint)
            skillDiagnostics.set(
              id,
              "正文或参考文件已变化，当前仍使用 Session 保存的版本；可显式重新激活。",
            );
        }
      } catch {
        skillDiagnostics.set(id, "正文或参考文件不可用，当前仍使用 Session 保存的版本。");
      }
    }
  }

  function listSkills(): readonly SkillSummary[] {
    const summaries: SkillSummary[] = (options.skills?.list() ?? [])
      .map((skill) => {
        const error = skill.error ?? skillDiagnostics.get(skill.id);
        return {
          ...skill,
          active: activeSources.has(skillKey(skill.id)),
          ...(error ? { error } : { error: undefined }),
        };
      })
      .map(({ error, ...skill }) => (error === undefined ? skill : { ...skill, error }));
    for (const source of activeSources.values()) {
      if (source.kind !== "skill") continue;
      const id = source.sourceId.slice("skill:".length);
      if (!summaries.some((skill) => skill.id === id))
        summaries.push({
          id,
          name: id,
          description: "恢复的 Skill",
          path: "",
          source: "Session",
          active: true,
          error: skillDiagnostics.get(id) ?? "当前目录中未发现原 Skill；保留已保存版本。",
        });
    }
    return Object.freeze(summaries);
  }

  function directoryItems() {
    const directory: Array<{ id: string; name: string; description: string }> = [];
    for (const skill of [...(options.skills?.list() ?? [])].sort((left, right) =>
      left.id.localeCompare(right.id),
    )) {
      if (skill.error !== null) continue;
      const item = { id: skill.id, name: skill.name, description: skill.description };
      if (Buffer.byteLength(JSON.stringify([...directory, item])) > 8192) break;
      directory.push(item);
    }
    return directory;
  }

  function project(request: ModelRequest, permissionMode: PermissionMode): ModelRequest {
    const directory = directoryItems();
    const hasSkills =
      directory.length > 0 || [...activeSources.values()].some((source) => source.kind === "skill");
    const extraTools: ModelToolDefinition[] = [];
    if (hasSkills)
      extraTools.push(
        {
          name: "load_skill",
          description: "按目录中的稳定 ID 或唯一名称加载 Skill 指令；不会执行脚本。",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["id"],
            properties: { id: { type: "string", minLength: 1 } },
          },
        },
        {
          name: "read_skill",
          description: "读取已激活 Skill 根目录内的参考文本；不会执行脚本。",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["id", "path"],
            properties: {
              id: { type: "string", minLength: 1 },
              path: { type: "string", minLength: 1 },
            },
          },
        },
      );
    if (options.mcp?.list().some((server) => server.state === "connected"))
      extraTools.push({
        name: "read_mcp_resource",
        description: "按 URI 读取已连接 MCP Server 的 Resource 作为外部上下文。",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["serverId", "uri"],
          properties: {
            serverId: { type: "string", minLength: 1 },
            uri: { type: "string", minLength: 1 },
          },
        },
      });
    let omittedTools = 0;
    if (permissionMode !== "plan")
      for (const tool of [...(options.mcp?.tools() ?? [])].sort((left, right) =>
        left.name.localeCompare(right.name),
      )) {
        const definition = {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as JSONSchema7,
        };
        if (
          extraTools.length >= 64 ||
          estimateTextTokens(JSON.stringify([...extraTools, definition])) > 12000
        ) {
          omittedTools += 1;
          continue;
        }
        extraTools.push(definition);
      }
    omittedMcpTools = omittedTools;
    visibleMcpTools = new Set(extraTools.map((tool) => tool.name));
    return { ...request, tools: [...request.tools, ...extraTools] };
  }

  async function saveMcpContent(
    kind: "mcp_resource" | "mcp_prompt",
    id: string,
    content: McpContent,
  ) {
    if (content.isError) throw new Error("MCP 返回失败，未激活其内容。");
    const text = `${content.text}${content.truncated ? "\n[内容已截断]" : ""}${content.unsupportedContent ? "\n[包含不支持的内容]" : ""}`;
    await saveSource({
      sourceId: `${kind}:${id}`,
      kind,
      label: id,
      fingerprint: digest(text),
      content: text,
    });
  }

  function rejected(content: string, denied = false): ToolCallPlan {
    return {
      scheduling: "serial",
      abortedPreparationContent: "外部能力未执行。",
      prepare: async () => ({
        ok: false,
        result: { status: denied ? "denied" : "failed", content, truncated: false },
      }),
    };
  }

  function createPlan(
    call: AssistantToolCallPart,
    permissionMode: PermissionMode,
  ): ToolCallPlan | null {
    const managed = ["load_skill", "read_skill", "read_mcp_resource"].includes(call.toolName);
    const mcpTool = options.mcp?.tools().find((tool) => tool.name === call.toolName);
    if (!managed && !mcpTool) return null;
    if (call.invalid || !isRecord(call.input)) return rejected("外部 Tool 输入必须是有效对象。");
    const input = call.input;
    if (managed) {
      const fields =
        call.toolName === "read_mcp_resource"
          ? ["serverId", "uri"]
          : call.toolName === "read_skill"
            ? ["id", "path"]
            : ["id"];
      if (
        Object.keys(input).length !== fields.length ||
        !fields.every(
          (field) => typeof input[field] === "string" && String(input[field]).length > 0,
        )
      )
        return rejected("外部 Tool 参数不符合 Schema。");
    }
    if (mcpTool && permissionMode === "plan")
      return rejected("Plan 模式不允许执行未知副作用的 MCP Tool。", true);
    if (mcpTool && !visibleMcpTools.has(mcpTool.name))
      return rejected("MCP Tool 定义未进入当前请求预算。");
    if (mcpTool) {
      const validation = options.mcp?.validateToolCall(mcpTool.name, input, mcpTool.generation);
      if (!validation?.ok)
        return rejected(validation && !validation.ok ? validation.error : "MCP 未启用。");
    }
    const fingerprint = digest(JSON.stringify({ tool: mcpTool, input }));
    return {
      scheduling: "serial",
      abortedPreparationContent: "外部能力未执行。",
      prepare: async () => ({
        ok: true,
        preparedExecution: {
          approval: mcpTool
            ? {
                toolName: mcpTool.name,
                target: `${mcpTool.serverId} / ${mcpTool.originalName}`,
                preview: JSON.stringify(input, null, 2),
                ruleId: "mcp.exact_call",
                riskSummary: "外部 Tool 可能修改文件或远端状态；服务注解不构成权限保证。",
                executionBoundary: `仅允许当前连接版本 ${mcpTool.generation} 的这个 Tool 和完整参数；无 OS 沙箱，执行结果不明时不重试。`,
                deniedContent: "MCP Tool 未获准执行。",
                actionFingerprint: fingerprint,
              }
            : null,
          activitySummary: mcpTool
            ? `${mcpTool.serverId} / ${mcpTool.originalName}`
            : call.toolName,
          executionUnavailableContent: "Run 已停止，外部能力未执行。",
          async execute(signal, _publishUpdate, _resultTokenBudget) {
            if (signal.aborted)
              return {
                status: "failed",
                content: "外部能力已取消。",
                truncated: false,
                cleanupUncertain: false,
              };
            try {
              if (call.toolName === "load_skill") await activate(String(input.id), signal, false);
              else if (call.toolName === "read_skill") {
                const skill =
                  options.skills?.list().find((candidate) => candidate.id === input.id) ??
                  options.skills
                    ?.list()
                    .filter((candidate) => candidate.name === input.id)
                    .find((_candidate, _index, all) => all.length === 1);
                if (!skill || !activeSources.has(skillKey(skill.id)))
                  throw new Error("请先加载唯一确定的 Skill，再读取参考资料。");
                const normalizedPath = posix.normalize(String(input.path).replaceAll("\\", "/"));
                const stored = activeSources.get(
                  "skill-ref:" + skill.id + ":" + JSON.stringify(normalizedPath),
                );
                if (!stored) {
                  const loaded = await options.skills?.read(skill.id, String(input.path));
                  if (!loaded) throw new Error("Skill 不可用。");
                  signal.throwIfAborted();
                  if (
                    !activeSources.has("skill-ref:" + skill.id + ":" + JSON.stringify(loaded.path))
                  )
                    await saveSkill(loaded, true);
                }
              } else if (call.toolName === "read_mcp_resource") {
                const result = await options.mcp?.readResource(
                  String(input.serverId),
                  String(input.uri),
                  signal,
                );
                if (!result?.ok)
                  throw new Error(result && !result.ok ? result.error : "MCP 不可用。");
                signal.throwIfAborted();
                await saveMcpContent(
                  "mcp_resource",
                  `${String(input.serverId)} / ${String(input.uri)}`,
                  result.value,
                );
              } else if (mcpTool && options.mcp) {
                const result = await options.mcp.callTool(
                  mcpTool.name,
                  input,
                  mcpTool.generation,
                  signal,
                );
                if (!result.ok)
                  return {
                    status: "failed",
                    content: result.error,
                    truncated: false,
                    cleanupUncertain: true,
                  };
                return {
                  status: result.value.isError ? "failed" : "completed",
                  content: result.value.text,
                  originalContent: result.value.originalText ?? result.value.text,
                  ...(result.value.sourceTruncated
                    ? { sourceIncomplete: "source_failed" as const }
                    : {}),
                  truncated: result.value.truncated,
                  cleanupUncertain: false,
                };
              }
              return {
                status: "completed",
                content: "已保存有来源的外部上下文，后续请求会按预算提供。",
                truncated: false,
                cleanupUncertain: false,
              };
            } catch (error) {
              return {
                status: "failed",
                content:
                  managed && error instanceof Error
                    ? error.message
                    : "外部 Tool 执行失败；不会自动重试。",
                truncated: false,
                cleanupUncertain: !!mcpTool,
              };
            }
          },
        },
      }),
    };
  }

  return {
    project,
    directory: () => JSON.stringify(directoryItems()),
    mcpDiagnostics: () =>
      omittedMcpTools ? [`${omittedMcpTools} 个工具定义超出当前请求预算，未提供给模型。`] : [],
    createPlan,
    activate,
    listSkills,
    diagnoseSkills,
    saveMcpContent,
    async reloadSkills() {
      await options.skills?.reload();
      await diagnoseSkills();
    },
  };
}
