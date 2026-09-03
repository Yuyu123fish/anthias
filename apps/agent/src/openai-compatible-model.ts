import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { jsonSchema, type ModelMessage, streamText, type ToolSet, tool } from "ai";
import type { ModelConfig } from "./model-config.js";
import type {
  ModelFinishReason,
  ModelInputMessage,
  ModelStream,
  ModelStreamEvent,
  ModelUsage,
} from "./model-stream.js";

/** 创建生产 OpenAI-compatible Model Stream，并将 Provider 细节封装在 Agent 内部。 */
export function createOpenAICompatibleModelStream({
  baseURL,
  modelId,
  apiKey,
}: ModelConfig): ModelStream {
  const provider = createOpenAICompatible({
    name: "anthias-openai-compatible",
    baseURL,
    apiKey,
  });

  return (modelRequest, abortSignal) => {
    const modelTools: ToolSet = Object.fromEntries(
      modelRequest.tools.map((definition) => [
        definition.name,
        tool({
          description: definition.description,
          inputSchema: jsonSchema(definition.inputSchema),
        }),
      ]),
    );
    const streamResult = streamText({
      model: provider.chatModel(modelId),
      system: modelRequest.systemPrompt,
      messages: modelRequest.messages.map(toProviderMessage),
      tools: modelTools,
      abortSignal,
      maxRetries: 0,
      // 原始 Provider 错误不得由 AI SDK 写入终端；下方统一转换为 Adapter 内部异常。
      onError: () => undefined,
    });

    // fullStream 保留 error part，Adapter 才能在不暴露 Provider 细节时可靠地让本轮失败。
    return streamModelEvents(streamResult.fullStream);
  };
}

/** 转换模型完整流，并丢弃 Provider 元数据和原始错误。 */
async function* streamModelEvents(
  fullStream: AsyncIterable<Readonly<{ type: string; [key: string]: unknown }>>,
): AsyncIterable<ModelStreamEvent> {
  for await (const streamPart of fullStream) {
    if (streamPart.type === "text-delta" && typeof streamPart.text === "string") {
      yield Object.freeze({ type: "text_delta", delta: streamPart.text });
      continue;
    }
    if (
      streamPart.type === "tool-call" &&
      typeof streamPart.toolCallId === "string" &&
      typeof streamPart.toolName === "string"
    ) {
      yield Object.freeze({
        type: "tool_call",
        toolCallId: streamPart.toolCallId,
        toolName: streamPart.toolName,
        input: structuredClone(streamPart.input),
        invalid: streamPart.invalid === true,
      });
      continue;
    }
    if (streamPart.type === "finish") {
      yield Object.freeze({
        type: "finish",
        finishReason: normalizeFinishReason(streamPart.finishReason),
        usage: normalizeUsage(streamPart.totalUsage),
      });
      continue;
    }
    if (streamPart.type === "error") {
      throw new Error("OpenAI-compatible 模型流失败。");
    }
  }
}

/** 将 Agent 自有消息投影转换为 AI SDK ModelMessage。 */
function toProviderMessage(message: ModelInputMessage): ModelMessage {
  if (message.role === "user") {
    return { role: "user", content: message.content };
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content.map((part) =>
        part.type === "text"
          ? { type: "text" as const, text: part.text }
          : {
              type: "tool-call" as const,
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
            },
      ),
    };
  }
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        output: { type: "text", value: message.content },
      },
    ],
  };
}

/** 把 AI SDK finish reason 收窄为 Agent 内部固定枚举。 */
function normalizeFinishReason(value: unknown): ModelFinishReason {
  switch (value) {
    case "stop":
    case "length":
    case "error":
    case "other":
      return value;
    case "tool-calls":
      return "tool_calls";
    case "content-filter":
      return "content_filter";
    default:
      return "other";
  }
}

/** 只保留标准 token 计量，缺失值使用 null 而不是猜测。 */
function normalizeUsage(value: unknown): ModelUsage {
  const usage = isRecord(value) ? value : {};
  return Object.freeze({
    inputTokens: toNonNegativeIntegerOrNull(usage.inputTokens),
    outputTokens: toNonNegativeIntegerOrNull(usage.outputTokens),
    totalTokens: toNonNegativeIntegerOrNull(usage.totalTokens),
  });
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 将未知计量收窄为非负整数或 null。 */
function toNonNegativeIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
