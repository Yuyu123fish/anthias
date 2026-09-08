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
    `本次请求用量：输入 ${tokens(diagnostic.usage?.inputTokens)} · 输出 ${tokens(diagnostic.usage?.outputTokens)} tokens`,
  ]
    .filter(Boolean)
    .join("\n");
}
