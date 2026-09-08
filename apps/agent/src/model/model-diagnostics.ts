import type { RunDiagnostic } from "../message.js";

const SUMMARIES: Readonly<Record<RunDiagnostic["category"], string>> = Object.freeze({
  completed: "模型已正常结束。",
  storage: "Session 写入失败，请检查本地存储后重试。",
  context_overflow: "模型上下文容量不足，已保留历史；请缩短输入或开启新对话。",
  output_limit: "模型输出达到上限，已保留现有内容；请明确继续或缩小本次输出。",
  authentication: "模型认证失败；请检查 API Key 及其访问权限。",
  configuration: "模型配置不可用；请检查服务地址、模型名称或账户配置。",
  invalid_request: "模型服务拒绝了请求参数；请检查模型配置或缩短输入。",
  rate_limit: "模型服务触发限流；请稍后明确继续。",
  network: "模型请求遇到暂时网络错误；请检查连接后明确继续。",
  service: "模型服务暂时不可用；请稍后明确继续。",
  empty_response: "模型未返回有效正文或完整工具请求；请明确继续或调整要求。",
  content_filter: "模型服务因内容过滤停止输出；已保留现有内容，请调整要求。",
  unknown: "模型请求失败，请检查模型配置或稍后重试。",
  aborted: "Run 已停止，已完成的消息与工具结果仍然保留。",
  resource_limit: "单次模型响应达到 ToolCall 数量限制，Run 已停止；已完成结果仍然保留。",
});

/** 安全文案只来自固定映射，调用者只能补充明确的事实字段。 */
export function createRunDiagnostic(
  category: RunDiagnostic["category"],
  details: Partial<Omit<RunDiagnostic, "category" | "summary">> = {},
): RunDiagnostic {
  const diagnostic = {
    category,
    providerFinishReason: details.providerFinishReason ?? null,
    usage: details.usage == null ? null : Object.freeze({ ...details.usage }),
    retryCount: details.retryCount ?? null,
    abortSource: details.abortSource ?? null,
    httpStatus: details.httpStatus ?? null,
    retryStopReason: details.retryStopReason ?? null,
  };
  const retrySummary =
    diagnostic.retryStopReason === "exhausted"
      ? " 自动重试已用完，不再发起请求。"
      : diagnostic.retryStopReason === "content_delivered"
        ? " 已交付部分内容或收到完整工具请求，不自动重试。"
        : diagnostic.retryStopReason === "wait_too_long"
          ? " 服务端要求等待超过 30 秒，本次不再自动重试。"
          : diagnostic.retryStopReason === "deadline"
            ? " 剩余任务时间不足以重试，本次请求已结束。"
            : "";
  const abortSummary =
    category === "aborted" || category === "resource_limit"
      ? diagnostic.abortSource === "task_deadline"
        ? "任务已达到共享时限；已完成的消息与工具结果仍然保留。"
        : diagnostic.abortSource === "shutdown"
          ? "程序关闭已停止 Run；已完成的消息与工具结果仍然保留。"
          : diagnostic.abortSource === "parent"
            ? "父任务取消已停止 Run；已完成的消息与工具结果仍然保留。"
            : diagnostic.abortSource === "internal"
              ? "内部中止已停止 Run；已完成的消息与工具结果仍然保留。"
              : SUMMARIES[category]
      : SUMMARIES[category];
  return Object.freeze({ ...diagnostic, summary: abortSummary + retrySummary });
}

/** 仅明确的暂时网络、限流与服务失败允许普通生成恢复。 */
export function isRetryableModelDiagnostic(diagnostic: RunDiagnostic): boolean {
  return ["network", "rate_limit", "service"].includes(diagnostic.category);
}
