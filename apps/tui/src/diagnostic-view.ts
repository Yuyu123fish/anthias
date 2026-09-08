import type { RunDiagnostic } from "@anthias/agent";

export function formatRunDiagnostic(diagnostic: RunDiagnostic | null | undefined): string {
  if (diagnostic == null)
    return "结束原因未知：这份历史没有记录足够的诊断信息。\n输入 /continue 继续上一任务，或输入新的要求。";
  const tokens = (value: number | null | undefined) =>
    value == null ? "未知" : value.toLocaleString("en-US");
  const abortSources = {
    user: "用户停止",
    task_deadline: "共享任务时限",
    shutdown: "程序关闭",
    parent: "父任务取消",
    internal: "内部中止",
    unknown: "未知",
  };
  return [
    diagnostic.summary,
    diagnostic.category === "completed"
      ? ""
      : "输入 /continue 继续上一任务，或输入新的要求；已完成事实会保留。",
    `分类：${diagnostic.category} · HTTP：${diagnostic.httpStatus ?? "未知"} · 自动重试：${diagnostic.retryCount ?? "未知"}`,
    `Provider 结束原因：${diagnostic.providerFinishReason ?? "未知"} · 中止来源：${diagnostic.abortSource === null ? "未知" : abortSources[diagnostic.abortSource]}`,
    `Provider 错误码：${diagnostic.providerErrorCode ?? "未知"} · 参数：${diagnostic.providerErrorParam ?? "未知"}`,
    `本次请求用量：输入 ${tokens(diagnostic.usage?.inputTokens)} · 输出 ${tokens(diagnostic.usage?.outputTokens)} · 思考 ${tokens(diagnostic.usage?.reasoningTokens)} tokens`,
    diagnostic.requestSummary == null
      ? "请求结构：未知，当前记录未提供。"
      : [
          `请求规模：${diagnostic.requestSummary.purpose} · 输出上限 ${tokens(diagnostic.requestSummary.maxOutputTokens)} · 消息 ${diagnostic.requestSummary.messageCount}（含 system） · Tool 定义 ${diagnostic.requestSummary.toolDefinitionCount}`,
          `工具衔接：调用 ${diagnostic.requestSummary.toolCallCount} · 结果 ${diagnostic.requestSummary.toolResultCount} · 未配对调用 ${diagnostic.requestSummary.unpairedToolCallCount} · 无对应调用的结果 ${diagnostic.requestSummary.unexpectedToolResultCount}`,
          `携带 Reasoning 的消息：${diagnostic.requestSummary.reasoningMessageCount}`,
        ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n");
}
