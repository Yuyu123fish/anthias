import type { AgentEvent, ToolResultMessage } from "@anthias/agent";
import { formatModelRecovery, formatRunDiagnostic } from "./diagnostic-view.js";

export function eventSourceLabel(source: {
  memberSessionId?: string;
  memberName?: string;
}): string {
  return source.memberSessionId
    ? `成员 ${source.memberName?.trim() || source.memberSessionId} [${source.memberSessionId}]`
    : "主 Agent";
}

export function authorizationSourceName(
  source: Extract<AgentEvent, { type: "tool_authorization" }>["source"],
): string {
  return { workspace: "工作区授权", user: "本次批准", auto_review: "自动审核", policy: "安全策略" }[
    source
  ];
}

export function toolPreparationText(phase: "input" | "ready") {
  return phase === "input"
    ? { status: "参数生成中", detail: "目标尚未完整；参数生成中，不会提前执行。" }
    : { status: "等待执行", detail: "完整请求已收到，等待校验与执行。" };
}

export function toolResultStatus(status: ToolResultMessage["status"]): string {
  return {
    completed: "已完成",
    failed: "失败",
    denied: "已拒绝",
    aborted: "已停止",
    unknown: "结果未知",
  }[status];
}

/** 两种入口共用事件含义；流式状态、折叠和插入位置仍由各自呈现层决定。 */
export function eventNotice(event: AgentEvent): Readonly<{ title: string; text: string }> | null {
  switch (event.type) {
    case "input_interruption_changed":
      return {
        title: "插入用户消息",
        text:
          event.status === "blocked"
            ? "清理受阻，消息已保留；/agents 查看来源，/agent recover <blockId> 检查。"
            : "正在打断并清理，完成后处理排队消息。",
      };
    case "input_queued":
      return {
        title:
          event.input.source.kind === "agent"
            ? "成员输入 · 已排队"
            : event.input.mode === "steer"
              ? "优先插入 · 已排队"
              : "后续消息 · 已排队",
        text: `[${event.input.inputId.slice(-8)}] ${event.input.content}\n${event.input.source.kind === "agent" ? "成员投递已保存在协作历史，等待安全点插入。" : "尚未保存；当前任务结束后处理，Esc 立即打断并处理。停止后用 /continue 恢复，关闭前尚未消费的消息会丢弃。"}`,
      };
    case "input_consumed":
      return {
        title: "输入已插入",
        text: `[${event.inputId.slice(-8)}] 已保存并进入${event.mode === "steer" ? "当前执行" : "后续任务"}。`,
      };
    case "input_discarded":
      return {
        title: event.source.kind === "agent" ? "成员投递已保留" : "排队输入未保存",
        text: `[${event.inputId.slice(-8)}] ${event.reason === "closed" ? "Agent 已关闭" : "Session 已切换"}，${event.source.kind === "agent" ? "成员投递仍保存在协作历史，显式继续后处理。" : "该输入不会在重开后恢复。"}`,
      };
    case "session_unavailable":
      return {
        title: "Session 写入失败",
        text: `${event.error}\n执行与队列已暂停。请 /exit 后用 --session <当前 Session ID> 重新启动，核对已保存历史。`,
      };
    case "model_retry": {
      const recovery = formatModelRecovery(event);
      return {
        title: event.memberSessionId
          ? `${eventSourceLabel(event)} · ${recovery.title}`
          : recovery.title,
        text: `${recovery.status}\n${recovery.detail}`,
      };
    }
    case "compaction_start":
      return { title: "Context", text: "正在压缩上下文，完整历史会保留。" };
    case "compaction_end":
      return {
        title: "Context",
        text: `压缩完成 ${event.inputTokensBefore} → ${event.inputTokensAfter} tokens`,
      };
    case "compaction_failed":
      return { title: "Context", text: event.error };
    case "run_end":
      if (event.memberSessionId) {
        const status =
          event.result.status === "completed"
            ? "已完成"
            : event.result.status === "aborted"
              ? "已停止"
              : "运行失败";
        return {
          title: `${eventSourceLabel(event)} · ${status}`,
          text: [
            event.diagnostic?.summary ??
              (event.result.status === "failed" ? event.result.error : ""),
            `/agent result ${event.memberSessionId} 查看该成员历史；输入仍发送给主 Agent。`,
          ]
            .filter(Boolean)
            .join("\n"),
        };
      }
      return event.result.status === "completed"
        ? null
        : {
            title: event.result.status === "failed" ? "运行失败" : "已停止",
            text: formatRunDiagnostic(
              event.diagnostic,
              event.result.status === "failed" ? event.result.error : undefined,
            ),
          };
    default:
      return null;
  }
}
