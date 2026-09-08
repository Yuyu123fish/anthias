/** 表示一条已经被 Agent 接受的用户文本消息。 */
export type UserMessage = Readonly<{
  role: "user";
  content: string;
}>;

/** 枚举 Assistant ToolCall 可以安全持久化并回传模型的 JSON 值。 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | Readonly<{ [key: string]: JsonValue }>;

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
  input: JsonValue;
  invalid: boolean;
}>;

/** 枚举 AssistantMessage 可以持久化的有序内容 part。 */
export type AssistantContentPart = AssistantTextPart | AssistantToolCallPart;

/** 说明 Tool 原文未能完整保存的可枚举原因。 */
export type ToolArtifactIncompleteReason =
  | "artifact_limit"
  | "session_limit"
  | "write_failed"
  | "source_failed"
  | "aborted"
  | "unknown";

/** 保存当前 Session 内可再次读取的 Tool 原文引用。 */
export type ToolArtifactReference = Readonly<{
  artifactId: string;
  toolCallId: string;
  byteLength: number;
  complete: boolean;
  incompleteReason?: ToolArtifactIncompleteReason;
}>;

/** 只保存已经确认的模型与 Run 结束事实，不包含 Provider 原始错误。 */
export type RunDiagnostic = Readonly<{
  category:
    | "completed"
    | "context_overflow"
    | "output_limit"
    | "authentication"
    | "configuration"
    | "invalid_request"
    | "rate_limit"
    | "network"
    | "service"
    | "empty_response"
    | "content_filter"
    | "unknown"
    | "aborted"
    | "resource_limit"
    | "storage";
  summary: string;
  providerFinishReason:
    | "stop"
    | "tool_calls"
    | "length"
    | "content_filter"
    | "error"
    | "other"
    | null;
  usage: Readonly<{
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
    cacheWriteInputTokens: number | null;
  }> | null;
  retryCount: number | null;
  abortSource: "user" | "task_deadline" | "shutdown" | "parent" | "internal" | "unknown" | null;
  httpStatus: number | null;
  retryStopReason: "exhausted" | "content_delivered" | "wait_too_long" | "deadline" | null;
}>;

/** 表示活动中或已经终结的一条 Assistant 消息。 */
export type AssistantMessage = Readonly<{
  role: "assistant";
  content: readonly AssistantContentPart[];
  status: "streaming" | "completed" | "aborted" | "failed";
  diagnostic?: RunDiagnostic;
}>;

/** 表示与一个 ToolCall 一一对应、会进入后续模型上下文的结果消息。 */
export type ToolResultMessage = Readonly<{
  role: "tool";
  toolCallId: string;
  toolName: string;
  status: "completed" | "failed" | "denied" | "aborted" | "unknown";
  content: string;
  truncated: boolean;
  artifact?: ToolArtifactReference;
}>;

/** 枚举 Agent 对外可见的线性消息。 */
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/** 判断 Assistant 内容 part 是否为 ToolCall。 */
export function isToolCallPart(part: AssistantContentPart): part is AssistantToolCallPart {
  return part.type === "tool_call";
}
