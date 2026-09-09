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
