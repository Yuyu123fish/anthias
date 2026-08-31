import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ModelStream } from "@anthias/agent";
import { streamText } from "ai";
import type { ModelConfig } from "./config.js";

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

  return (messages, signal) => {
    const result = streamText({
      model: provider.chatModel(modelId),
      messages: messages.map(({ role, content }) => ({ role, content })),
      abortSignal: signal,
      maxRetries: 0,
      // 原始 Provider 错误不得由 AI SDK 写入终端；下方统一转换为 Adapter 内部异常。
      onError: () => undefined,
    });

    // fullStream 保留 error part，Adapter 才能在不暴露 Provider 细节时可靠地让本轮失败。
    return streamTextDeltas(result.fullStream);
  };
}

async function* streamTextDeltas(
  stream: AsyncIterable<
    Readonly<{ type: "text-delta"; text: string }> | Readonly<{ type: string }>
  >,
): AsyncIterable<string> {
  for await (const part of stream) {
    if (part.type === "text-delta" && "text" in part) {
      yield part.text;
    } else if (part.type === "error") {
      throw new Error("OpenAI-compatible 模型流失败。");
    }
  }
}
