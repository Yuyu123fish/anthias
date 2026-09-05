import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, jsonSchema, type ModelMessage, streamText, type ToolSet, tool } from "ai";
import type { ModelConfig } from "./model-config.js";
import {
  type ModelFinishReason,
  type ModelInputMessage,
  ModelRequestError,
  type ModelStream,
  type ModelStreamEvent,
  type ModelUsage,
} from "./model-stream.js";

/** 创建生产 OpenAI-compatible Model Stream，并将 Provider 细节封装在 Agent 内部。 */
export function createOpenAICompatibleModelStream({
  baseURL,
  modelId,
  apiKey,
}: Pick<ModelConfig, "baseURL" | "modelId" | "apiKey">): ModelStream {
  const provider = createOpenAICompatible({
    name: "anthias-openai-compatible",
    baseURL,
    apiKey,
    includeUsage: true,
  });

  return async function* (modelRequest, abortSignal) {
    try {
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
        maxOutputTokens: modelRequest.maxOutputTokens ?? 16_000,
        // 原始 Provider 错误不得由 AI SDK 写入终端；下方统一转换为 Adapter 内部异常。
        onError: () => undefined,
      });

      // fullStream 保留 error part，Adapter 才能在不暴露 Provider 细节时可靠地让本轮失败。
      yield* streamModelEvents(streamResult.fullStream);
    } catch (error) {
      throw normalizeModelError(error);
    }
  };
}

/** 转换模型完整流，并丢弃 Provider 元数据和原始错误。 */
async function* streamModelEvents(
  fullStream: AsyncIterable<Readonly<{ type: string; [key: string]: unknown }>>,
): AsyncIterable<ModelStreamEvent> {
  let stepUsage: ModelUsage | null = null;
  for await (const streamPart of fullStream) {
    if (streamPart.type === "finish-step") {
      stepUsage = normalizeModelUsage(streamPart.usage);
      continue;
    }
    if (streamPart.type === "reasoning-start") {
      yield Object.freeze({ type: "reasoning_start" });
      continue;
    }
    if (streamPart.type === "reasoning-delta" && typeof streamPart.text === "string") {
      yield Object.freeze({ type: "reasoning_delta", delta: streamPart.text });
      continue;
    }
    if (streamPart.type === "reasoning-end") {
      yield Object.freeze({ type: "reasoning_end" });
      continue;
    }
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
        input: streamPart.input,
        invalid: streamPart.invalid === true,
      });
      continue;
    }
    if (streamPart.type === "finish") {
      yield Object.freeze({
        type: "finish",
        finishReason: normalizeFinishReason(streamPart.finishReason),
        usage: stepUsage ?? normalizeModelUsage(streamPart.totalUsage),
      });
      continue;
    }
    if (streamPart.type === "error") {
      throw normalizeModelError(streamPart.error);
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
      content: message.content.map((part) => {
        if (part.type === "text") {
          return { type: "text" as const, text: part.text };
        }
        if (part.type === "reasoning") {
          return { type: "reasoning" as const, text: part.text };
        }
        return {
          type: "tool-call" as const,
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
        };
      }),
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

/** SDK 汇总会丢失 raw，且兼容层会把缺失值补零；只信任 step 原始用量字段。 */
function normalizeModelUsage(value: unknown): ModelUsage {
  const rawUsage = asRecord(asRecord(value)?.raw);
  const promptDetails = asRecord(rawUsage?.prompt_tokens_details);
  return Object.freeze({
    inputTokens: tokenCount(rawUsage?.prompt_tokens) ?? tokenCount(rawUsage?.input_tokens),
    outputTokens: tokenCount(rawUsage?.completion_tokens) ?? tokenCount(rawUsage?.output_tokens),
    cachedInputTokens:
      tokenCount(promptDetails?.cached_tokens) ??
      tokenCount(rawUsage?.prompt_cache_hit_tokens) ??
      tokenCount(rawUsage?.cache_read_input_tokens),
    cacheWriteInputTokens:
      tokenCount(promptDetails?.cache_write_tokens) ??
      tokenCount(rawUsage?.cache_creation_input_tokens) ??
      tokenCount(rawUsage?.cache_write_input_tokens),
  });
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 只用错误身份和明确的容量语义归类，原始响应与 Provider 文本不越过 Adapter。 */
function normalizeModelError(error: unknown): ModelRequestError {
  if (error instanceof ModelRequestError) return error;
  const apiError = APICallError.isInstance(error) ? error : null;
  let errorData = asRecord(apiError?.data) ?? asRecord(error);
  if (apiError?.responseBody !== undefined) {
    try {
      errorData = asRecord(JSON.parse(apiError.responseBody)) ?? errorData;
    } catch {
      // 非 JSON 错误仍可使用 SDK 已识别的错误身份，不返回原始正文。
    }
  }
  const details = asRecord(errorData?.error) ?? errorData;
  const errorCode = details?.code;
  if (
    typeof errorCode === "string" &&
    [
      "context_length_exceeded",
      "context_window_exceeded",
      "max_context_length_exceeded",
      "prompt_too_long",
      "input_token_limit_exceeded",
    ].includes(errorCode)
  ) {
    return new ModelRequestError("context_overflow");
  }
  if (
    apiError !== null &&
    [400, 413, 422].includes(apiError.statusCode ?? 0) &&
    /maximum context length|context (?:length|window).{0,40}(?:exceed|limit)|prompt (?:is )?too long/i.test(
      apiError.message,
    )
  ) {
    return new ModelRequestError("context_overflow");
  }
  return new ModelRequestError("model_error");
}
