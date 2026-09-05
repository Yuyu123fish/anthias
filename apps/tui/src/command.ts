import type { Agent, ContextUsage, PermissionMode } from "@anthias/agent";
import { CombinedAutocompleteProvider, type SlashCommand } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./content-renderer.js";

const COMMANDS = [
  { name: "help", argumentHint: "", description: "命令与快捷键" },
  { name: "new", argumentHint: "", description: "新建当前工作区的会话" },
  { name: "resume", argumentHint: "[id]", description: "列出或恢复会话" },
  { name: "context", argumentHint: "", description: "上下文窗口和调用用量" },
  { name: "compact", argumentHint: "", description: "手动压缩上下文" },
  { name: "mode", argumentHint: "[agent|plan|auto_allow]", description: "查看或切换权限模式" },
  { name: "skills", argumentHint: "[reload|clear]", description: "外部 Skill 目录与激活状态" },
  { name: "skill:name", argumentHint: "[任务]", description: "激活指定 Skill，可附带用户任务" },
  {
    name: "mcp",
    argumentHint: "[connect|disconnect|inspect|read|prompt ...]",
    description: "MCP 连接与外部能力",
  },
  { name: "details", argumentHint: "[prev|next]", description: "查看 Reasoning 和 Tool 详情" },
  { name: "exit", argumentHint: "", description: "停止 Agent 并退出" },
] as const;

export type ParsedInput =
  | Readonly<{ type: "prompt"; text: string }>
  | Readonly<{ type: "command"; name: string; argumentsText: string }>;

export function parseInput(text: string): ParsedInput {
  if (text.startsWith("//")) return { type: "prompt", text: text.slice(1) };
  if (!text.startsWith("/")) return { type: "prompt", text };
  const match = /^\/([^\s]*)(?:\s([\s\S]*))?$/u.exec(text);
  return { type: "command", name: match?.[1] ?? "", argumentsText: match?.[2] ?? "" };
}

export function commandHelp(): string {
  return [
    ...COMMANDS.map(
      (command) =>
        `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}  ${command.description}`,
    ),
    "",
    "/mcp connect <id> | disconnect <id> | inspect <id>",
    "/mcp read <id> <uri>",
    '/mcp prompt <id> <name> [{"参数名":"值"}]',
    "",
    "Enter 提交 · Alt+Enter / Shift+Enter 换行 · Tab 补全",
    "PageUp / PageDown 滚动 · Ctrl+Home / Ctrl+End 顶部/末尾",
    "Ctrl+T 详情 · Ctrl+C 停止运行，空闲时退出 · Ctrl+D 空输入时退出",
    "审批时输入 approve 或 deny；先完整浏览审批详情，再确认。",
    "// 开头会将一个 / 作为普通文本发送。",
  ].join("\n");
}

/** 菜单、参数提示与 /help 使用同一命令目录。 */
export function createCommandAutocomplete(agent: Agent): CombinedAutocompleteProvider {
  const commands: SlashCommand[] = COMMANDS.filter((command) => command.name !== "skill:name").map(
    (command) => ({
      ...command,
      async getArgumentCompletions(prefix) {
        const choices =
          command.name === "mode"
            ? ["agent", "plan", "auto_allow"]
            : command.name === "skills"
              ? ["reload", "clear"]
              : command.name === "details"
                ? ["prev", "next"]
                : command.name === "mcp"
                  ? ["connect", "disconnect", "inspect", "read", "prompt"]
                  : [];
        if (command.name === "resume") {
          const result = await agent.sessions.list();
          return result.ok
            ? result.value
                .filter((session) => session.id.startsWith(prefix))
                .map((session) => ({
                  value: session.id,
                  label: sanitizeTerminalText(session.id),
                  description: sanitizeTerminalText(session.title ?? session.createdAt),
                }))
            : null;
        }
        if (command.name === "mcp" && prefix.includes(" ")) {
          const operation = prefix.split(/\s+/u)[0] ?? "";
          const serverPrefix = prefix.slice(operation.length).trimStart();
          return agent.mcp
            .list()
            .filter((server) => server.id.startsWith(serverPrefix))
            .map((server) => ({
              value: `${operation} ${server.id}`,
              label: sanitizeTerminalText(server.id),
              description: sanitizeTerminalText(`${server.status} · ${server.source}`),
            }));
        }
        return choices
          .filter((choice) => choice.startsWith(prefix))
          .map((value) => ({ value, label: value }));
      },
    }),
  );
  const skills = agent.skills.list();
  for (const skill of skills) {
    const identity =
      skills.filter((candidate) => candidate.name === skill.name).length === 1
        ? skill.name
        : skill.id;
    commands.push({
      name: `skill:${identity}`,
      description: sanitizeTerminalText(skill.description),
      argumentHint: "[任务]",
    });
  }
  return new CombinedAutocompleteProvider(commands, agent.state.workspaceRoot);
}

/** 命令只把语义操作交给 Agent，不持有 Session 或外部能力生命周期。 */
export async function executeCommand(
  command: Extract<ParsedInput, { type: "command" }>,
  options: {
    agent: Agent;
    notice(text: string): void;
    details(direction?: "prev" | "next"): void;
    exit(): void;
  },
): Promise<string | undefined> {
  const { agent, notice } = options;
  const argumentsText = command.argumentsText.trim();
  const args = argumentsText ? argumentsText.split(/\s+/u) : [];
  const report = (result: { ok: boolean; error?: string }, success: string) =>
    notice(result.ok ? success : (result.error ?? "操作失败。"));
  const invalid = () => notice(`参数无效。使用 /help 查看 /${command.name} 的用法。`);
  if (command.name.startsWith("skill:")) {
    const identity = command.name.slice(6);
    if (!identity) {
      invalid();
      return;
    }
    const result = await agent.skills.activate(identity);
    report(result, `已激活 Skill ${identity}。`);
    return result.ok && argumentsText ? command.argumentsText : undefined;
  }
  switch (command.name) {
    case "help":
      if (args.length) invalid();
      else notice(commandHelp());
      break;
    case "new":
      if (args.length) invalid();
      else report(await agent.sessions.create(), `新会话已创建。`);
      break;
    case "resume": {
      if (args.length > 1) {
        invalid();
        break;
      }
      const identity = args[0];
      if (identity) {
        report(await agent.sessions.open(identity), "会话已恢复。");
        break;
      }
      const result = await agent.sessions.list();
      notice(
        result.ok
          ? result.value.length
            ? [
                "会话 · 输入 /resume <id> 打开，Tab 可补全",
                ...result.value.map(
                  (session) =>
                    `${session.id}${session.id === agent.state.sessionId ? " · 当前" : ""}\n  ${session.title ?? session.createdAt}`,
                ),
              ].join("\n")
            : "没有可恢复的会话。"
          : result.error,
      );
      break;
    }
    case "context":
      if (args.length) invalid();
      else notice(formatContextUsage(agent.state.contextUsage));
      break;
    case "compact":
      if (args.length) invalid();
      else report(await agent.compact(), "上下文已压缩，原始历史已保留。");
      break;
    case "mode": {
      const mode = args[0];
      if (args.length > 1 || (mode !== undefined && !isPermissionMode(mode))) {
        invalid();
        break;
      }
      if (mode === undefined) notice(`当前权限模式：${agent.state.permissionMode}`);
      else {
        const result = agent.setPermissionMode(mode);
        notice(
          result.status === "accepted"
            ? `权限模式：${result.permissionMode}`
            : `暂时不能切换模式：${result.reason}`,
        );
      }
      break;
    }
    case "skills":
      if (
        args.length > 1 ||
        (args[0] !== undefined && args[0] !== "reload" && args[0] !== "clear")
      ) {
        invalid();
        break;
      }
      if (args[0] === "reload") report(await agent.skills.reload(), "Skill 目录已重新加载。");
      else if (args[0] === "clear")
        report(await agent.skills.activate(null), "当前激活的 Skill 内容已清除。");
      else {
        const skills = agent.skills.list();
        notice(
          skills.length
            ? skills
                .map(
                  (skill) =>
                    `${skill.active ? "[active] " : ""}${skill.name} · ${skill.id}\n  ${skill.source}\n  ${skill.error ?? skill.description}`,
                )
                .join("\n\n")
            : "未发现 Skill。支持工作区和用户 .agents/skills，以及 ANTHIAS_SKILL_DIRS。",
        );
      }
      break;
    case "mcp": {
      const [operation, identity, name] = args;
      if (operation === undefined) {
        const servers = agent.mcp.list();
        notice(
          servers.length
            ? servers
                .map(
                  (server) =>
                    `${server.id} · ${server.status} · ${server.transport}\n  ${server.source}${server.error ? `\n  ${server.error}` : ""}`,
                )
                .join("\n\n")
            : "未配置 MCP。读取用户或工作区 .anthias/mcp.json；连接必须显式启用。",
        );
      } else if (
        (operation === "connect" || operation === "disconnect") &&
        identity &&
        args.length === 2
      ) {
        report(
          await agent.mcp[operation](identity),
          `${identity} 已${operation === "connect" ? "连接" : "断开"}。`,
        );
      } else if (operation === "inspect" && identity && args.length === 2) {
        const result = await agent.mcp.inspect(identity);
        notice(
          result.ok
            ? [
                ...(result.value.diagnostics ?? []).map((diagnostic) => `诊断：${diagnostic}`),
                `${identity} · Tools`,
                ...result.value.tools.map((tool) => `  ${tool.name} ${tool.description ?? ""}`),
                "Resources",
                ...result.value.resources.map(
                  (resource) => `  ${resource.uri} ${resource.name ?? ""}`,
                ),
                "Prompts",
                ...result.value.prompts.map(
                  (prompt) =>
                    `  ${prompt.name} ${(prompt.arguments ?? []).map((argument) => `${argument.name}${argument.required ? "*" : ""}`).join(", ")}`,
                ),
              ].join("\n")
            : result.error,
        );
      } else if (operation === "read" && identity && name && args.length === 3) {
        report(await agent.mcp.readResource(identity, name), "Resource 已加入当前外部上下文。");
      } else if (operation === "prompt" && identity && name) {
        const jsonText = argumentsText.replace(/^\S+\s+\S+\s+\S+\s*/u, "");
        let promptArguments: Record<string, string> | undefined;
        if (jsonText) {
          try {
            const parsed: unknown = JSON.parse(jsonText);
            if (
              parsed === null ||
              typeof parsed !== "object" ||
              Array.isArray(parsed) ||
              Object.values(parsed).some((value) => typeof value !== "string")
            ) {
              invalid();
              break;
            }
            promptArguments = parsed as Record<string, string>;
          } catch {
            invalid();
            break;
          }
        }
        report(
          await agent.mcp.getPrompt(identity, name, promptArguments),
          "Prompt 模板已加入当前外部上下文。",
        );
      } else invalid();
      break;
    }
    case "details":
      if (args.length > 1 || (args[0] !== undefined && args[0] !== "prev" && args[0] !== "next"))
        invalid();
      else options.details(args[0]);
      break;
    case "exit":
      if (args.length) invalid();
      else options.exit();
      break;
    default:
      notice(
        command.name ? `未知命令 /${command.name}。输入 /help 查看支持的命令。` : commandHelp(),
      );
  }
}

export function formatContextUsage(usage: ContextUsage): string {
  const tokens = (value: number | null) =>
    value === null ? "未知" : value.toLocaleString("en-US");
  const lines = [
    `上下文 ${tokens(usage.inputTokens)} / ${tokens(usage.contextWindow)} tokens · ${usage.source}`,
    `回复预算 ${tokens(usage.responseOutputTokens)} · 摘要预算 ${tokens(usage.summaryOutputTokens)} · 压缩 ${usage.compactions} 次`,
    `外部上下文 ${tokens(usage.externalTokens ?? null)} · 工具定义 ${tokens(usage.toolDefinitionTokens ?? null)} tokens`,
  ];
  for (const [purpose, totals] of Object.entries(usage.requests)) {
    lines.push(
      `${purpose}：${totals.requests} 次调用 · 输入 ${tokens(totals.inputTokens)} · 输出 ${tokens(totals.outputTokens)} · 缓存命中 ${tokens(totals.cachedInputTokens)} · 缓存写入 ${tokens(totals.cacheWriteInputTokens)}`,
    );
  }
  return lines.join("\n");
}

function isPermissionMode(value: string): value is PermissionMode {
  return value === "agent" || value === "plan" || value === "auto_allow";
}
