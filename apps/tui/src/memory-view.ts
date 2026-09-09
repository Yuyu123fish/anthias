import type { Agent, MemoryAction, MemoryEntry, MemorySnapshot } from "@anthias/agent";
import { MEMORY_HELP } from "./command-definitions.js";
import type { CommandResult } from "./command-result.js";
import { sanitizeTerminalText } from "./content-renderer.js";

export function formatMemory(snapshot: MemorySnapshot): string {
  return sanitizeTerminalText(
    [
      "记忆 · 自动维护" + (snapshot.automatic ? "开启" : "关闭") + " · " + snapshot.projectId,
      ...snapshot.diagnostics,
      ...snapshot.entries.map(
        (entry) =>
          entry.id +
          " @" +
          entry.revision +
          " · " +
          entry.kind +
          " · " +
          entry.status +
          " · " +
          (entry.scope === "global" ? "通用" : entry.scope) +
          "\n  " +
          (entry.content ?? "正文已遗忘").replace(/\n/g, " ").slice(0, 160),
      ),
      snapshot.entries.length ? "" : "当前没有匹配的记忆。",
      "/memory show <id> 查看来源与条件；/memory help 查看维护命令。",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}
function formatEntry(entry: MemoryEntry): string {
  return sanitizeTerminalText(
    [
      entry.id + " @" + entry.revision + " · " + entry.kind + " · " + entry.status,
      "范围：" + entry.scope,
      entry.content ?? "正文已遗忘。",
      "来源：" + entry.source.kind + " · " + entry.source.note,
      "来源会话：" + entry.source.sessionId,
      "来源记录：" + (entry.source.entryIds.join("、") || "用户直接管理"),
      "最后确认：" + (entry.confirmedAt ?? "尚未确认"),
      "到期：" + (entry.expiresAt ?? "无固定期限"),
      "复核：" + (entry.reviewAt ?? "按适用条件"),
      "适用分支：" + (entry.conditions.branch ?? "不限"),
      ...entry.conditions.files.map((file) => "条件文件：" + file.path),
    ].join("\n"),
  );
}
/** 命令只组装已知动作，内容和版本仍由 Agent 校验。 */
export async function runMemoryCommand(
  argumentsText: string,
  agent: Agent,
  notice: (text: string) => void,
): Promise<CommandResult> {
  const [operation = "", first, second, ...remaining] = argumentsText.trim().split(/\s+/u);
  const report = (result: Awaited<ReturnType<Agent["memory"]["query"]>>): CommandResult => {
    notice(result.ok ? formatMemory(result.value) : result.error);
    return { kind: result.ok ? "handled" : "rejected" };
  };
  if (operation === "help") {
    notice(MEMORY_HELP);
    return { kind: "handled" };
  }
  if (operation === "" || operation === "list" || operation === "all") {
    const kind = first === "user" || first === "experience" ? first : undefined;
    const status = (["active", "candidate", "review", "expired", "forgotten", "all"] as const).find(
      (value) => value === second,
    );
    if ((first && !kind) || (second && !status) || remaining.length) {
      notice(MEMORY_HELP);
      return { kind: "rejected" };
    }
    return report(
      await agent.memory.query({
        status: status ?? "all",
        scope: operation === "all" ? "all" : "current",
        ...(kind ? { kind } : {}),
      }),
    );
  }
  if (operation === "show" && first && !second) {
    const result = await agent.memory.query({ id: first, scope: "all", status: "all" });
    notice(
      result.ok
        ? result.value.entries.map(formatEntry).join("\n\n") || "未找到记忆。"
        : result.error,
    );
    return { kind: result.ok ? "handled" : "rejected" };
  }
  let action: MemoryAction;
  if ((operation === "on" || operation === "off") && !first) {
    action = { action: "settings", automatic: operation === "on" };
  } else if (
    operation === "save" &&
    (first === "user" || first === "experience") &&
    (second === "global" || second === "project") &&
    remaining.length
  ) {
    action = { action: "save", kind: first, scope: second, content: remaining.join(" ") };
  } else if (
    ["correct", "confirm", "forget"].includes(operation) &&
    first &&
    second &&
    /^\d+$/.test(second)
  ) {
    const revision = Number(second);
    if (operation === "correct" && remaining.length) {
      const snapshot = await agent.memory.query({ id: first, status: "all" });
      const entry = snapshot.ok ? snapshot.value.entries[0] : undefined;
      if (!entry) {
        notice(snapshot.ok ? "未找到当前范围的记忆。" : snapshot.error);
        return { kind: "rejected" };
      }
      action = {
        action: "save",
        id: first,
        revision,
        kind: entry.kind,
        scope: entry.scope === "global" ? "global" : "project",
        content: remaining.join(" "),
      };
    } else if (operation === "confirm" && !remaining.length)
      action = { action: "confirm", id: first, revision };
    else if (
      operation === "forget" &&
      (remaining.length === 0 || (remaining.length === 1 && remaining[0] === "no-send"))
    )
      action = { action: "forget", id: first, revision, stopSending: remaining[0] === "no-send" };
    else {
      notice(MEMORY_HELP);
      return { kind: "rejected" };
    }
  } else {
    notice(MEMORY_HELP);
    return { kind: "rejected" };
  }
  return report(await agent.memory.execute(action));
}
