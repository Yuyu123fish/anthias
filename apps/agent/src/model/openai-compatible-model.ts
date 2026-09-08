import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, jsonSchema, type ModelMessage, streamText, type ToolSet, tool } from "ai";
import { createContextBudget } from "../context/budget.js";
import type { RunDiagnostic } from "../message.js";
import type { ModelConfig } from "./model-config.js";
import { normalizeProviderErrorCode, normalizeProviderErrorParam } from "./model-diagnostics.js";
import {
  type ModelFinishReason,
  type ModelInputMessage,
  type ModelRequest,
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
  capabilities,
  contextBudget,
  responseReasoningEffort,
  approvalReasoningEffort,
}: Pick<
  ModelConfig,
  "baseURL" | "modelId" | "apiKey" | "responseReasoningEffort" | "approvalReasoningEffort"
> &
  Partial<Pick<ModelConfig, "capabilities" | "contextBudget">>): ModelStream {
  const outputBudget =
    contextBudget ?? (capabilities === undefined ? undefined : createContextBudget(capabilities));
  const provider = createOpenAICompatible({
    name: "anthias-openai-compatible",
    baseURL,
    apiKey,
    includeUsage: true,
  });

  return async function* (modelRequest, abortSignal) {
    const purpose = modelRequest.purpose ?? "response";
    const defaultOutputTokens =
      purpose === "approval"
        ? 2_000
        : purpose === "compaction"
          ? (outputBudget?.summaryOutputTokens ?? 8_000)
          : (outputBudget?.responseOutputTokens ?? 64_000);
    const maxOutputTokens =
      modelRequest.maxOutputTokens ??
      Math.min(defaultOutputTokens, capabilities?.maxOutputTokens ?? defaultOutputTokens);
    const reasoningEffort =
      purpose === "approval"
        ? approvalReasoningEffort
        : purpose === "response"
          ? responseReasoningEffort
          : undefined;
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
        maxOutputTokens,
        // 只有用户明确配置时才发送可选字段，避免改变不支持 reasoning_effort 的兼容服务。
        ...(reasoningEffort === undefined
          ? {}
          : { providerOptions: { openaiCompatible: { reasoningEffort } } }),
        // 原始 Provider 错误不得由 AI SDK 写入终端；下方统一转换为 Adapter 内部异常。
        onError: () => undefined,
      });

      // fullStream 保留 error part，Adapter 才能在不暴露 Provider 细节时可靠地让本轮失败。
      yield* streamModelEvents(streamResult.fullStream);
    } catch (error) {
      throw normalizeModelError(error, summarizeModelRequest(modelRequest, maxOutputTokens));
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
    if (
      streamPart.type === "tool-input-start" &&
      typeof streamPart.id === "string" &&
      typeof streamPart.toolName === "string"
    ) {
      yield Object.freeze({
        type: "tool_input_start",
        toolCallId: streamPart.id,
        toolName: streamPart.toolName,
      });
      continue;
    }
    if (
      streamPart.type === "tool-input-delta" &&
      typeof streamPart.id === "string" &&
      typeof streamPart.delta === "string"
    ) {
      yield Object.freeze({
        type: "tool_input_delta",
        toolCallId: streamPart.id,
        delta: streamPart.delta,
      });
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
      throw streamPart.error;
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
  const completionDetails = asRecord(rawUsage?.completion_tokens_details);
  const outputDetails = asRecord(rawUsage?.output_tokens_details);
  return Object.freeze({
    inputTokens: tokenCount(rawUsage?.prompt_tokens) ?? tokenCount(rawUsage?.input_tokens),
    outputTokens: tokenCount(rawUsage?.completion_tokens) ?? tokenCount(rawUsage?.output_tokens),
    reasoningTokens:
      tokenCount(completionDetails?.reasoning_tokens) ??
      tokenCount(outputDetails?.reasoning_tokens),
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
function normalizeModelError(
  error: unknown,
  requestSummary: NonNullable<RunDiagnostic["requestSummary"]>,
): ModelRequestError {
  if (error instanceof ModelRequestError)
    return new ModelRequestError(error.diagnostic.category, {
      ...error.diagnostic,
      requestSummary,
      retryAfterMs: error.retryAfterMs,
    });
  const apiError = APICallError.isInstance(error) ? error : null;
  let errorData = asRecord(apiError?.data) ?? asRecord(error);
  if (apiError?.responseBody !== undefined && apiError.responseBody.length <= 65_536) {
    try {
      errorData = asRecord(JSON.parse(apiError.responseBody)) ?? errorData;
    } catch {
      // 非 JSON 错误仍可使用 SDK 已识别的错误身份，不返回原始正文。
    }
  }
  const details = asRecord(errorData?.error) ?? errorData;
  const errorCode = details?.code;
  const httpStatus =
    typeof apiError?.statusCode === "number" &&
    Number.isInteger(apiError.statusCode) &&
    apiError.statusCode >= 100 &&
    apiError.statusCode <= 599
      ? apiError.statusCode
      : null;
  const retryAfterMs = parseRetryAfter(apiError?.responseHeaders);
  const diagnosticDetails = {
    httpStatus,
    providerErrorCode: normalizeProviderErrorCode(errorCode),
    providerErrorParam: normalizeProviderErrorParam(details?.param),
    requestSummary,
  };
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
    return new ModelRequestError("context_overflow", { ...diagnosticDetails });
  }
  if (
    apiError !== null &&
    [400, 413, 422].includes(apiError.statusCode ?? 0) &&
    /maximum context length|context (?:length|window).{0,40}(?:exceed|limit)|prompt (?:is )?too long/i.test(
      apiError.message,
    )
  ) {
    return new ModelRequestError("context_overflow", { ...diagnosticDetails });
  }
  if (
    [
      "insufficient_quota",
      "model_not_found",
      "invalid_model",
      "billing_hard_limit_reached",
    ].includes(String(errorCode))
  ) {
    return new ModelRequestError("configuration", { ...diagnosticDetails });
  }
  if (httpStatus === 401 || httpStatus === 403)
    return new ModelRequestError("authentication", { ...diagnosticDetails });
  if (httpStatus === 404) return new ModelRequestError("configuration", { ...diagnosticDetails });
  if (httpStatus === 429)
    return new ModelRequestError("rate_limit", { ...diagnosticDetails, retryAfterMs });
  if (httpStatus !== null && [408, 425, 500, 502, 503, 504].includes(httpStatus))
    return new ModelRequestError("service", { ...diagnosticDetails, retryAfterMs });
  if (httpStatus !== null && httpStatus >= 400 && httpStatus < 500)
    return new ModelRequestError("invalid_request", { ...diagnosticDetails });
  const networkCodes = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET",
  ]);
  let cause = asRecord(error);
  for (let depth = 0; cause !== null && depth < 4; depth++) {
    if (typeof cause.code === "string" && networkCodes.has(cause.code))
      return new ModelRequestError("network", { ...diagnosticDetails });
    if (cause.name === "AbortError")
      return new ModelRequestError("aborted", { ...diagnosticDetails, abortSource: "internal" });
    cause = asRecord(cause.cause);
  }
  return new ModelRequestError("unknown", { ...diagnosticDetails });
}

/** Retry-After 仅转为有界数值事实；保留过长等待供上层明确拒绝自动恢复。 */
function parseRetryAfter(headers: Record<string, string> | undefined): number | null {
  const value = Object.entries(headers ?? {}).find(
    ([name]) => name.toLowerCase() === "retry-after",
  )?.[1];
  if (value === undefined || value.length > 128) return null;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const milliseconds = Number(value.trim()) * 1000;
    return Number.isFinite(milliseconds) && milliseconds >= 0
      ? Math.min(milliseconds, 86_400_000)
      : null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.min(86_400_000, Math.max(0, timestamp - Date.now()))
    : null;
}

/** 只保存形状计数；任何用户文本、工具参数、名称和身份都不能进入安全诊断。 */
function summarizeModelRequest(
  request: ModelRequest,
  maxOutputTokens: number,
): NonNullable<RunDiagnostic["requestSummary"]> {
  const pendingToolCalls = new Map<string, string[]>();
  let toolCallCount = 0;
  let toolResultCount = 0;
  let reasoningMessageCount = 0;
  let unpairedToolCallCount = 0;
  let unexpectedToolResultCount = 0;
  const closeToolGroup = () => {
    for (const toolNames of pendingToolCalls.values()) unpairedToolCallCount += toolNames.length;
    pendingToolCalls.clear();
  };
  for (const message of request.messages) {
    if (message.role === "tool") {
      toolResultCount += 1;
      const toolNames = pendingToolCalls.get(message.toolCallId);
      const matchingIndex = toolNames?.indexOf(message.toolName) ?? -1;
      if (toolNames === undefined || matchingIndex < 0) unexpectedToolResultCount += 1;
      else toolNames.splice(matchingIndex, 1);
      continue;
    }
    closeToolGroup();
    if (message.role !== "assistant") continue;
    if (message.content.some((part) => part.type === "reasoning")) reasoningMessageCount += 1;
    for (const part of message.content) {
      if (part.type !== "tool_call") continue;
      toolCallCount += 1;
      const toolNames = pendingToolCalls.get(part.toolCallId) ?? [];
      toolNames.push(part.toolName);
      pendingToolCalls.set(part.toolCallId, toolNames);
    }
  }
  closeToolGroup();
  const boundCount = (count: number) => Math.min(count, 1_000_000);
  return Object.freeze({
    purpose: request.purpose ?? "response",
    maxOutputTokens:
      Number.isSafeInteger(maxOutputTokens) && maxOutputTokens >= 0 ? maxOutputTokens : 0,
    messageCount: boundCount(request.messages.length + 1),
    toolDefinitionCount: boundCount(request.tools.length),
    toolCallCount: boundCount(toolCallCount),
    toolResultCount: boundCount(toolResultCount),
    reasoningMessageCount: boundCount(reasoningMessageCount),
    unpairedToolCallCount: boundCount(unpairedToolCallCount),
    unexpectedToolResultCount: boundCount(unexpectedToolResultCount),
  });
}
