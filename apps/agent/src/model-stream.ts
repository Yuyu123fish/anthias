import { randomUUID } from "node:crypto";
import {
  type AssistantContentPart,
  type AssistantMessage,
  type AssistantToolCallPart,
  isToolCallPart,
  type JsonValue,
  type Message,
  type ToolResultMessage,
} from "./message.js";
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
  | Readonly<{
      type: "text_delta";
      delta: string;
    }>
  | Readonly<{
      type: "tool_call";
      toolCallId: string;
      toolName: string;
      input: unknown;
      invalid: boolean;
    }>
  | Readonly<{
      type: "finish";
      finishReason: ModelFinishReason;
    }>;

/** 枚举流式组装边界交给 Agent Loop 的当前 AssistantMessage。 */
export type AssistantMessageStreamEvent =
  | Readonly<{
      type: "start";
      partialAssistantMessage: AssistantMessage;
    }>
  | Readonly<{
      type: "update";
      partialAssistantMessage: AssistantMessage;
      delta: string | null;
    }>
  | Readonly<{
      type: "finish";
      message: AssistantMessage;
      finishReason: ModelFinishReason | null;
    }>;

/**
 * 定义可被生产 Adapter 与确定性测试实现替换的结构化模型流。
 * Adapter 必须在 AbortSignal 触发后结束迭代或抛出，不能留下挂起的读取。
 */
export type ModelStream = (
  modelRequest: ModelRequest,
  abortSignal: AbortSignal,
) => AsyncIterable<ModelStreamEvent>;

/**
 * 将一次 Model Stream 组装成唯一的 AssistantMessage。
 * 私有 builder 原地推进；每次交付的 partial 都独立冻结且不会被后续增量回写。
 */
export async function* streamAssistantMessage(
  modelStream: ModelStream,
  modelRequest: ModelRequest,
  abortSignal: AbortSignal,
): AsyncIterable<AssistantMessageStreamEvent> {
  const content: AssistantContentPart[] = [];
  const toolCallIds = new Set<string>();
  let finishReason: ModelFinishReason | null = null;

  yield Object.freeze({
    type: "start",
    partialAssistantMessage: createAssistantMessage(content, "streaming"),
  });

  try {
    if (!abortSignal.aborted) {
      for await (const modelEvent of modelStream(modelRequest, abortSignal)) {
        if (abortSignal.aborted) {
          break;
        }
        if (modelEvent.type === "text_delta") {
          if (modelEvent.delta.length > 0) {
            appendTextPart(content, modelEvent.delta);
            yield Object.freeze({
              type: "update",
              partialAssistantMessage: createAssistantMessage(content, "streaming"),
              delta: modelEvent.delta,
            });
          }
          continue;
        }
        if (modelEvent.type === "tool_call") {
          const toolCall = normalizeToolCall(modelEvent, toolCallIds);
          toolCallIds.add(toolCall.toolCallId);
          content.push(toolCall);
          yield Object.freeze({
            type: "update",
            partialAssistantMessage: createAssistantMessage(content, "streaming"),
            delta: null,
          });
          continue;
        }

        finishReason = modelEvent.finishReason;
        break;
      }
    }
  } catch {
    // Provider 错误只决定本条消息失败，原始异常不得越过 Model Stream seam。
  }

  const status: AssistantMessage["status"] = abortSignal.aborted
    ? "aborted"
    : finishReason !== null &&
        isSuccessfulAssistantFinish(finishReason, content.some(isToolCallPart))
      ? "completed"
      : "failed";
  const finalMessage = createAssistantMessage(content, status);
  yield Object.freeze({ type: "finish", message: finalMessage, finishReason });
}

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
    content: message.content,
  });
}

/** 把相邻文本增量合并为一个 text part，同时保留 ToolCall 相对顺序。 */
function appendTextPart(content: AssistantContentPart[], delta: string): void {
  const previousPart = content.at(-1);
  if (previousPart?.type === "text") {
    content[content.length - 1] = Object.freeze({
      type: "text",
      text: previousPart.text + delta,
    });
    return;
  }
  content.push(Object.freeze({ type: "text", text: delta }));
}

/** 从边界私有 builder 形成不会被后续增量回写的 AssistantMessage。 */
function createAssistantMessage(
  content: readonly AssistantContentPart[],
  status: AssistantMessage["status"],
): AssistantMessage {
  return Object.freeze({
    role: "assistant",
    content: Object.freeze([...content]),
    status,
  });
}

/** 在外部模型事件进入 AssistantMessage 时收窄 ToolCall 身份和 JSON 输入。 */
function normalizeToolCall(
  modelToolCall: Extract<ModelStreamEvent, { type: "tool_call" }>,
  existingToolCallIds: ReadonlySet<string>,
): AssistantToolCallPart {
  const toolCallId =
    isUuid(modelToolCall.toolCallId) && !existingToolCallIds.has(modelToolCall.toolCallId)
      ? modelToolCall.toolCallId
      : randomUUID();
  const jsonInput = toJsonValue(modelToolCall.input);
  return Object.freeze({
    type: "tool_call",
    toolCallId,
    toolName: modelToolCall.toolName,
    input: jsonInput.value,
    invalid: modelToolCall.invalid || !jsonInput.valid,
  });
}

/** 判断 finish reason 与 ToolCall 组合是否形成完整 AssistantMessage。 */
function isSuccessfulAssistantFinish(
  finishReason: ModelFinishReason,
  hasToolCall: boolean,
): boolean {
  return (
    (finishReason === "stop" && !hasToolCall) || (finishReason === "tool_calls" && hasToolCall)
  );
}

/** 把未知输入复制并递归冻结为 JSON 值，无法表示时使用 null 并标记 invalid。 */
function toJsonValue(value: unknown): Readonly<{ valid: boolean; value: JsonValue }> {
  try {
    const serializedValue = JSON.stringify(value);
    if (serializedValue === undefined) {
      return Object.freeze({ valid: false, value: null });
    }
    const jsonValue = JSON.parse(serializedValue, (_key, nestedValue: unknown) =>
      nestedValue !== null && typeof nestedValue === "object"
        ? Object.freeze(nestedValue)
        : nestedValue,
    ) as JsonValue;
    return Object.freeze({ valid: true, value: jsonValue });
  } catch {
    return Object.freeze({ valid: false, value: null });
  }
}

/** 判断字符串是否为当前消息 Schema 接受的 UUID v4。 */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
