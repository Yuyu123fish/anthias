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

  return (modelMessages, abortSignal) => {
    const streamResult = streamText({
      model: provider.chatModel(modelId),
      messages: modelMessages.map(({ role, content }) => ({ role, content })),
      abortSignal,
      maxRetries: 0,
      // 原始 Provider 错误不得由 AI SDK 写入终端；下方统一转换为 Adapter 内部异常。
      onError: () => undefined,
    });

    // fullStream 保留 error part，Adapter 才能在不暴露 Provider 细节时可靠地让本轮失败。
    return streamTextDeltas(streamResult.fullStream);
  };
}

async function* streamTextDeltas(
  fullStream: AsyncIterable<
    Readonly<{ type: "text-delta"; text: string }> | Readonly<{ type: string }>
  >,
): AsyncIterable<string> {
  for await (const streamPart of fullStream) {
    if (streamPart.type === "text-delta" && "text" in streamPart) {
      yield streamPart.text;
    } else if (streamPart.type === "error") {
      throw new Error("OpenAI-compatible 模型流失败。");
    }
  }
}
