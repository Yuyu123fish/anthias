import type { Agent, ContextUsage, PermissionMode } from "@anthias/agent";
import { CombinedAutocompleteProvider, type SlashCommand } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./content-renderer.js";
import { formatRunDiagnostic } from "./diagnostic-view.js";
import { runMemoryCommand } from "./memory-view.js";
import { runCollaborationCommand } from "./multi-agent-view.js";
import { formatPermissions, type PermissionGrantChoice } from "./permission-view.js";

const COMMANDS = [
  { name: "agents", argumentHint: "", description: "成员、Team 与任务状态" },
  {
    name: "agent",
    argumentHint: "[spawn|result|wait|stop|release|resume ...]",
    description: "委派与成员历史",
  },
  {
    name: "team",
    argumentHint: "[create|add|assign|message|tasks|close ...]",
    description: "持续团队协作",
  },
  {
    name: "git",
    argumentHint: "[status|create|commit|integrate ...]",
    description: "本地 Git 与 worktree",
  },
  { name: "help", argumentHint: "", description: "命令与快捷键" },
  { name: "new", argumentHint: "", description: "新建当前工作区的会话" },
  { name: "resume", argumentHint: "[id]", description: "列出或恢复会话" },
  {
    name: "memory",
    argumentHint: "[list|all|show|save|correct|confirm|forget|on|off|help ...]",
    description: "查看和维护分层记忆",
  },
  { name: "context", argumentHint: "", description: "上下文窗口和调用用量" },
  {
    name: "permissions",
    argumentHint: "[grant [--remember] [--members]|revoke]",
    description: "查看、授予或撤销工作区授权",
  },
  { name: "approval", argumentHint: "", description: "查看当前执行确认" },
  { name: "diagnostics", argumentHint: "", description: "查看最近 Run 的安全诊断" },
  { name: "continue", argumentHint: "[补充要求]", description: "明确继续上一任务，开始新 Run" },
  { name: "draft", argumentHint: "", description: "恢复未接受的上一份输入" },
  { name: "compact", argumentHint: "", description: "手动压缩上下文" },
  { name: "mode", argumentHint: "[agent|plan|auto_allow]", description: "查看或切换权限模式" },
  { name: "skills", argumentHint: "[reload|clear]", description: "外部 Skill 目录与激活状态" },
  { name: "skill:name", argumentHint: "[任务]", description: "激活指定 Skill，可附带用户任务" },
  {
    name: "mcp",
    argumentHint: "[connect|disconnect|inspect|read|prompt ...]",
    description: "MCP 连接与外部能力",
  },
  { name: "details", argumentHint: "[prev|next]", description: "查看命令、Reasoning 和 Tool 详情" },
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
    "/agent spawn [--write] <任务> | result <id> [offset] | wait <id> | stop <id> | release <id> | resume <id> [任务]",
    "/agent artifact <id> <artifactId> [cursor]",
    "/team create <名称> | add [--write] <任务> | assign <id> <任务> | message <id> <消息> | tasks | close",
    "/git status|diff|log [worktreeId] | show [ref] | branches | worktrees",
    "/git create [ref] | inspect <id> | remove <id> [discard]",
    '/git commit {"paths":["文件路径"],"message":"提交说明","worktreeId":"可选"}',
    "/git integrate <worktreeId> <commit> | continue | abort",
    "可写成员从已提交版本创建；主目录未提交修改不会带入。",
    "",
    "/mcp connect <id> | disconnect <id> | inspect <id>",
    "/mcp read <id> <uri>",
    '/mcp prompt <id> <name> [{"参数名":"值"}]',
    "",
    "Enter 提交 · Alt+Enter / Shift+Enter 换行 · Tab 补全",
    "鼠标滚轮 / 拖动右侧滑块滚动 · 点击执行过程或步骤标题展开、收起",
    "PageUp / PageDown 滚动 · Ctrl+Home / Ctrl+End 顶部/末尾",
    "Ctrl+T 详情 · Ctrl+C 停止运行，空闲时退出 · Ctrl+D 空输入时退出",
    "审批时输入 approve 或 deny；先完整浏览审批详情，再确认。/approval 返回当前审批。",
    "工作区授权：/permissions grant [--remember] [--members]，浏览后输入 grant 或 cancel。",
    "拒绝的输入可用 /draft 恢复；/continue 明确继续上一任务。",
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
          command.name === "memory"
            ? ["list", "all", "show", "save", "correct", "confirm", "forget", "on", "off", "help"]
            : command.name === "permissions"
              ? [
                  "grant",
                  "grant --remember",
                  "grant --members",
                  "grant --remember --members",
                  "revoke",
                ]
              : command.name === "mode"
                ? ["agent", "plan", "auto_allow"]
                : command.name === "skills"
                  ? ["reload", "clear"]
                  : command.name === "details"
                    ? ["prev", "next"]
                    : command.name === "mcp"
                      ? ["connect", "disconnect", "inspect", "read", "prompt"]
                      : command.name === "agent"
                        ? ["spawn", "result", "artifact", "wait", "stop", "release", "resume"]
                        : command.name === "team"
                          ? ["create", "add", "assign", "message", "tasks", "close"]
                          : command.name === "git"
                            ? [
                                "status",
                                "diff",
                                "log",
                                "show",
                                "branches",
                                "worktrees",
                                "create",
                                "inspect",
                                "remove",
                                "commit",
                                "integrate",
                                "continue",
                                "abort",
                              ]
                            : [];
        if ((command.name === "agent" || command.name === "team") && prefix.includes(" ")) {
          const operation = prefix.split(/\s+/u)[0] ?? "";
          if (
            [
              "result",
              "artifact",
              "wait",
              "stop",
              "release",
              "resume",
              "assign",
              "message",
            ].includes(operation)
          ) {
            const memberPrefix = prefix.slice(operation.length).trimStart();
            return agent.collaboration
              .snapshot()
              .members.filter((member) => member.sessionId.startsWith(memberPrefix))
              .map((member) => ({
                value: operation + " " + member.sessionId,
                label: member.sessionId,
                description: sanitizeTerminalText(member.name + " · " + member.status),
              }));
          }
        }
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
    rejected?(): void;
    recoverDraft?(): void;
    approval?(): void;
    permissions?(choice: PermissionGrantChoice): void;
    exit(): void;
  },
): Promise<string | undefined> {
  const { agent, notice } = options;
  const argumentsText = command.argumentsText.trim();
  const args = argumentsText ? argumentsText.split(/\s+/u) : [];
  if (command.name === "memory") {
    await runMemoryCommand(command.argumentsText, agent, notice, options.rejected);
    return;
  }
  if (await runCollaborationCommand(command.name, argumentsText, agent, notice, options.rejected))
    return;
  const report = (result: { ok: boolean; error?: string }, success: string) => {
    if (!result.ok) options.rejected?.();
    notice(result.ok ? success : (result.error ?? "操作失败。"));
  };
  const invalid = () => {
    options.rejected?.();
    notice(`参数无效。使用 /help 查看 /${command.name} 的用法。`);
  };
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
    case "permissions": {
      if (args.length === 0) {
        notice(formatPermissions(agent.permissions.snapshot()));
      } else if (args[0] === "revoke" && args.length === 1) {
        const result = await agent.permissions.revoke();
        notice(
          result.ok
            ? "工作区授权已撤销。未开始的动作与待批准请求已失效；已开始动作可用 Ctrl+C 停止，已产生副作用不回滚。"
            : result.error,
        );
        if (!result.ok) notice(formatPermissions(agent.permissions.snapshot()));
      } else if (
        args[0] === "grant" &&
        args.slice(1).every((argument) => argument === "--remember" || argument === "--members") &&
        new Set(args.slice(1)).size === args.length - 1
      ) {
        options.permissions?.({
          remember: args.includes("--remember"),
          includeMembers: args.includes("--members"),
        });
      } else invalid();
      break;
    }
    case "diagnostics":
      if (args.length) invalid();
      else notice(formatRunDiagnostic(agent.state.lastRunDiagnostic));
      break;
    case "continue":
      return argumentsText
        ? `继续上一任务。补充要求：\n${command.argumentsText}`
        : "继续上一任务。先依据已保存消息、工具结果和当前工作区核对剩余工作，保留已经完成的成果，不重复已成功的副作用。";
    case "draft":
      if (args.length) invalid();
      else options.recoverDraft?.();
      break;
    case "approval":
      if (args.length) invalid();
      else options.approval?.();
      break;
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
      if (!result.ok) options.rejected?.();
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
        if (result.status === "rejected") options.rejected?.();
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
        if (!result.ok) options.rejected?.();
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
      options.rejected?.();
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
