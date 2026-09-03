import type { AssistantContentPart, Message, ToolResultMessage } from "./message.js";
import { snapshotAssistantPart } from "./message.js";
import type { ModelToolDefinition } from "./tool/definitions.js";

/** 表示送入 Model Adapter 的一条 Agent 自有消息。 */
export type ModelInputMessage =
  | Readonly<{ role: "user"; content: string }>
  | Readonly<{ role: "assistant"; content: readonly AssistantContentPart[] }>
  | ToolResultMessage;

/** 描述一次 Model Adapter 调用需要的完整 Agent 自有输入。 */
export type ModelRequest = Readonly<{
  systemPrompt: string;
  messages: readonly ModelInputMessage[];
  tools: readonly ModelToolDefinition[];
}>;

/** 保存一次模型请求可以累加到 Run 的标准化用量。 */
export type ModelUsage = Readonly<{
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}>;

/** 枚举 Agent 理解的模型完成原因。 */
export type ModelFinishReason =
  | "stop"
  | "tool_calls"
  | "length"
  | "content_filter"
  | "error"
  | "other";

/** 枚举生产 Adapter 和确定性测试 Adapter 产生的结构化事件。 */
export type ModelStreamEvent =
  | Readonly<{ type: "text_delta"; delta: string }>
  | Readonly<{
      type: "tool_call";
      toolCallId: string;
      toolName: string;
      input: unknown;
      invalid: boolean;
    }>
  | Readonly<{ type: "finish"; finishReason: ModelFinishReason; usage: ModelUsage }>;

/** 定义可被生产 Adapter 与确定性测试实现替换的结构化模型流。 */
export type ModelStream = (
  modelRequest: ModelRequest,
  abortSignal: AbortSignal,
) => AsyncIterable<ModelStreamEvent>;

/** 将线性消息投影成内部 Model Stream 所需的 Provider 无关形状。 */
export function toModelInputMessage(message: Message): ModelInputMessage {
  if (message.role === "user") {
    return Object.freeze({ role: "user", content: message.content });
  }
  if (message.role === "tool") {
    return Object.freeze({ ...message });
  }
  return Object.freeze({
    role: "assistant",
    content: Object.freeze(message.parts.map(snapshotAssistantPart)),
  });
}
