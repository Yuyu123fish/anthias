import { randomUUID } from "node:crypto";

/** 表示一条已经被 Agent 接受的用户文本消息。 */
export type UserMessage = Readonly<{
  role: "user";
  content: string;
}>;

/** 表示 AssistantMessage 中按模型产生顺序保存的文本 part。 */
export type AssistantTextPart = Readonly<{
  type: "text";
  text: string;
}>;

/** 表示 AssistantMessage 中一个已经完整形成的 ToolCall。 */
export type AssistantToolCallPart = Readonly<{
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: unknown;
  invalid: boolean;
}>;

/** 枚举 AssistantMessage 可以持久化的有序内容 part。 */
export type AssistantContentPart = AssistantTextPart | AssistantToolCallPart;

/** 表示活动中或已经终结的一条 Assistant 消息。 */
export type AssistantMessage = Readonly<{
  role: "assistant";
  content: string;
  parts: readonly AssistantContentPart[];
  status: "streaming" | "completed" | "aborted" | "failed";
}>;

/** 表示与一个 ToolCall 一一对应、会进入后续模型上下文的结果消息。 */
export type ToolResultMessage = Readonly<{
  role: "tool";
  toolCallId: string;
  toolName: string;
  status: "completed" | "failed" | "denied" | "aborted" | "unknown";
  content: string;
  truncated: boolean;
}>;

/** 枚举 Agent 对外可见的线性消息。 */
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/** 保存模型流正在累积的可变 Assistant 消息。 */
export type MutableAssistantMessage = {
  role: "assistant";
  content: string;
  parts: AssistantContentPart[];
  status: "streaming" | "completed" | "aborted" | "failed";
};

/** 将内部可变 Assistant 消息复制为只读公开快照。 */
export function snapshotAssistantMessage(message: AssistantMessage): AssistantMessage {
  return Object.freeze({
    role: "assistant",
    content: message.content,
    parts: Object.freeze(message.parts.map(snapshotAssistantPart)),
    status: message.status,
  });
}

/** 深复制并冻结一条公开消息。 */
export function snapshotMessage(message: Message): Message {
  if (message.role === "user") {
    return Object.freeze({ role: "user", content: message.content });
  }
  if (message.role === "tool") {
    return Object.freeze({ ...message });
  }
  return Object.freeze({
    role: "assistant",
    content: message.content,
    parts: Object.freeze(message.parts.map(snapshotAssistantPart)),
    status: message.status,
  });
}

/** 把相邻文本增量合并为一个持久 text part，同时保留 ToolCall 相对顺序。 */
export function appendTextPart(parts: AssistantContentPart[], delta: string): void {
  const previousPart = parts.at(-1);
  if (previousPart?.type === "text") {
    parts[parts.length - 1] = Object.freeze({ type: "text", text: previousPart.text + delta });
    return;
  }
  parts.push(Object.freeze({ type: "text", text: delta }));
}

/** 复制并冻结一个 Assistant 内容 part。 */
export function snapshotAssistantPart(part: AssistantContentPart): AssistantContentPart {
  return part.type === "text"
    ? Object.freeze({ type: "text", text: part.text })
    : Object.freeze({
        type: "tool_call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: structuredClone(part.input),
        invalid: part.invalid,
      });
}

/** 规范化 ToolCall 身份与 JSON 输入，防止 Provider 值破坏 Session Schema。 */
export function normalizeToolCall(
  modelToolCall: Readonly<{
    toolCallId: string;
    toolName: string;
    input: unknown;
    invalid: boolean;
  }>,
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

/** 判断 Assistant 内容 part 是否为 ToolCall。 */
export function isToolCallPart(part: AssistantContentPart): part is AssistantToolCallPart {
  return part.type === "tool_call";
}

/** 把未知输入复制为 JSON 值，无法表示时使用 null 并标记 invalid。 */
function toJsonValue(value: unknown): Readonly<{ valid: boolean; value: unknown }> {
  try {
    const serializedValue = JSON.stringify(value);
    if (serializedValue === undefined) {
      return Object.freeze({ valid: false, value: null });
    }
    return Object.freeze({ valid: true, value: JSON.parse(serializedValue) as unknown });
  } catch {
    return Object.freeze({ valid: false, value: null });
  }
}

/** 判断字符串是否为当前消息 Schema 接受的 UUID v4。 */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
