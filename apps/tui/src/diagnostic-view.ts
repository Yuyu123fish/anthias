import type { AgentEvent, RunDiagnostic } from "@anthias/agent";

export function formatRunDiagnostic(
  diagnostic: RunDiagnostic | null | undefined,
  error?: string,
): string {
  if (diagnostic == null)
    return (
      (error ? error + "\n" : "") +
      "结束原因未知：这份历史没有记录足够的诊断信息。\n输入 /continue 继续上一任务，或输入新的要求。"
    );
  const tokens = (value: number | null | undefined) =>
    value == null ? "未知" : value.toLocaleString("en-US");
  const abortSources = {
    input: "插入用户消息",
    user: "用户停止",
    task_deadline: "共享任务时限",
    shutdown: "程序关闭",
    parent: "父任务取消",
    internal: "内部中止",
    unknown: "未知",
  };
  return [
    error && error !== diagnostic.summary ? error : "",
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

/** 恢复进度不提示用户继续；只有 Run 终止诊断提供手动继续入口。 */
export function formatModelRecovery(event: Extract<AgentEvent, { type: "model_retry" }>) {
  const title =
    event.recoveryKind === "approval"
      ? "审核恢复"
      : event.recoveryKind === "continuation"
        ? "任务续跑"
        : "模型重试";
  const count = event.retryCount + "/" + (event.recoveryKind === "approval" ? 1 : 2);
  const status = (event.phase === "waiting" ? "等待" : "正在") + title + " " + count;
  const detail = [
    event.diagnostic.summary,
    event.recoveryKind === "continuation" ? "已保存失败响应，将依据实际工具结果继续。" : "",
    event.phase === "waiting"
      ? "等待 " + (event.delayMs / 1000).toFixed(1) + " 秒；Ctrl+C 可停止。"
      : "正在发起请求；Ctrl+C 可停止。",
  ]
    .filter(Boolean)
    .join("\n");
  return { title, status, detail };
}
