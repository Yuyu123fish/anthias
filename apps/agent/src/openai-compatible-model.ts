import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText } from "ai";
import type { ModelStream } from "./agent.js";
import type { ModelConfig } from "./model-config.js";

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

/** 只转发文本增量，并把 Provider error part 转换为内部失败。 */
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
