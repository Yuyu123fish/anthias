import type {
  AssistantContentPart,
  AssistantMessage,
  Message,
  RunDiagnostic,
  ToolResultMessage,
  UserMessage,
} from "../message.js";
import {
  type DurableMessage,
  type DurableTextPart,
  type DurableToolCallPart,
  isJsonValue,
  isToolArtifactReference,
  snapshotJsonValue,
  type ToolArtifactReference,
} from "./schema.js";

/** 将公开消息转换为不包含流式状态的 Schema 2 持久形状。 */
export function toDurableMessage(message: Message): DurableMessage {
  if (message.role === "user") {
    return Object.freeze({
      type: "user",
      content: Object.freeze([Object.freeze({ type: "text" as const, text: message.content })]),
    });
  }
  if (message.role === "tool") {
    const artifact = getToolResultArtifact(message);
    return Object.freeze({
      type: "tool_result",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      status: message.status,
      content: message.content,
      truncated: message.truncated,
      ...(artifact === undefined ? {} : { artifact: snapshotArtifactReference(artifact) }),
    });
  }
  if (message.status === "streaming") {
    throw new Error("Session 只能持久化最终 AssistantMessage。");
  }
  return Object.freeze({
    type: "assistant",
    content: Object.freeze(message.content.map(toDurableAssistantPart)),
    status: message.status,
    ...(message.diagnostic === undefined
      ? {}
      : { diagnostic: snapshotRunDiagnostic(message.diagnostic) }),
  });
}

/** 将持久消息恢复为 Agent 与 TUI 共用的消息投影。 */
export function fromDurableMessage(message: DurableMessage): Message {
  if (message.type === "tool_result") {
    return Object.freeze({
      role: "tool",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      status: message.status,
      content: message.content,
      truncated: message.truncated,
      ...(message.artifact === undefined
        ? {}
        : { artifact: snapshotArtifactReference(message.artifact) }),
    } as ToolResultMessage);
  }
  if (message.type === "user") {
    return Object.freeze({
      role: "user",
      content: message.content.map((part) => part.text).join(""),
    } satisfies UserMessage);
  }
  return Object.freeze({
    role: "assistant",
    content: Object.freeze(message.content.map(fromDurableAssistantPart)),
    status: message.status,
    ...(message.diagnostic === undefined
      ? {}
      : { diagnostic: snapshotRunDiagnostic(message.diagnostic) }),
  } satisfies AssistantMessage);
}

function toDurableAssistantPart(part: AssistantContentPart): DurableTextPart | DurableToolCallPart {
  if (part.type === "text") {
    return Object.freeze({ type: "text", text: part.text });
  }
  if (!isJsonValue(part.input)) {
    throw new Error("ToolCall 输入不是可持久化 JSON 值。");
  }
  return Object.freeze({
    type: "tool_call",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    input: snapshotJsonValue(part.input),
    invalid: part.invalid,
  });
}

function fromDurableAssistantPart(
  part: DurableTextPart | DurableToolCallPart,
): AssistantContentPart {
  return part.type === "text"
    ? Object.freeze({ type: "text", text: part.text })
    : Object.freeze({
        type: "tool_call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: snapshotJsonValue(part.input),
        invalid: part.invalid,
      });
}

function getToolResultArtifact(message: ToolResultMessage): ToolArtifactReference | undefined {
  const artifact = (message as ToolResultMessage & { artifact?: unknown }).artifact;
  if (artifact === undefined) {
    return undefined;
  }
  if (!isToolArtifactReference(artifact) || artifact.toolCallId !== message.toolCallId) {
    throw new Error("ToolResult artifact 引用无效。");
  }
  return artifact;
}

function snapshotArtifactReference(artifact: ToolArtifactReference): ToolArtifactReference {
  if (artifact.complete) {
    return Object.freeze({
      artifactId: artifact.artifactId,
      toolCallId: artifact.toolCallId,
      byteLength: artifact.byteLength,
      complete: true,
    });
  }
  if (artifact.incompleteReason === undefined) {
    throw new Error("ToolResult artifact 不完整时必须说明原因。");
  }
  return Object.freeze({
    artifactId: artifact.artifactId,
    toolCallId: artifact.toolCallId,
    byteLength: artifact.byteLength,
    complete: false,
    incompleteReason: artifact.incompleteReason,
  });
}
function snapshotRunDiagnostic(diagnostic: RunDiagnostic): RunDiagnostic {
  return Object.freeze({
    ...diagnostic,
    usage: diagnostic.usage === null ? null : Object.freeze({ ...diagnostic.usage }),
    ...(diagnostic.requestSummary == null
      ? {}
      : { requestSummary: Object.freeze({ ...diagnostic.requestSummary }) }),
  });
}
