import type { ModelInputMessage, ModelRequest } from "../model/model-stream.js";

/** 区分模型容量与普通回复、摘要和保留原文的应用策略。 */
export type ContextBudget = Readonly<{
  contextWindow: number;
  modelMaxOutputTokens?: number;
  safetyTokens: number;
  responseOutputTokens: number;
  summaryOutputTokens: number;
  retainedTokens: number;
}>;

/** 只在默认策略时收窄输出；显式超出模型能力的配置必须拒绝。 */
export function createContextBudget(
  capabilities: Readonly<{ contextWindow: number; maxOutputTokens?: number }>,
  overrides: Readonly<{
    responseOutputTokens?: number;
    summaryOutputTokens?: number;
    retainedTokens?: number;
  }> = {},
): ContextBudget {
  requirePositiveTokenCount(capabilities.contextWindow, "模型上下文窗口");
  if (capabilities.maxOutputTokens !== undefined) {
    requirePositiveTokenCount(capabilities.maxOutputTokens, "模型输出能力");
  }
  // 小窗口沿用原默认预算，避免提高默认值使已有自定义模型无法启动。
  const defaultResponseOutputTokens = capabilities.contextWindow <= 84_000 ? 16_000 : 64_000;
  const responseOutputTokens = resolveOutputBudget(
    overrides.responseOutputTokens,
    defaultResponseOutputTokens,
    capabilities.maxOutputTokens,
  );
  const summaryOutputTokens = resolveOutputBudget(
    overrides.summaryOutputTokens,
    8_000,
    capabilities.maxOutputTokens,
  );
  const retainedTokens = overrides.retainedTokens ?? 32_000;
  requirePositiveTokenCount(retainedTokens, "原文保留目标");
  if (capabilities.contextWindow <= 20_000 + Math.max(responseOutputTokens, summaryOutputTokens)) {
    throw new Error("模型窗口无法同时容纳 20,000 token 安全余量、输出预算和请求输入。");
  }
  return Object.freeze({
    contextWindow: capabilities.contextWindow,
    ...(capabilities.maxOutputTokens === undefined
      ? {}
      : { modelMaxOutputTokens: capabilities.maxOutputTokens }),
    safetyTokens: 20_000,
    responseOutputTokens,
    summaryOutputTokens,
    retainedTokens,
  });
}

/** 估算实际重发的消息内容，不将本地工具产物元数据当作 Provider 输入。 */
export function estimateModelMessageTokens(message: ModelInputMessage): number {
  if (message.role === "tool") {
    return estimateJsonTokens({
      role: "tool",
      tool_call_id: message.toolCallId,
      name: message.toolName,
      content: message.content,
    });
  }
  return estimateJsonTokens(message);
}

/** 覆盖固定指令、消息封装、完整工具 Schema 与生成回复的封装余量。 */
export function estimateModelRequestTokens(
  request: Pick<ModelRequest, "systemPrompt" | "messages" | "tools">,
): number {
  return (
    estimateJsonTokens({ role: "system", content: request.systemPrompt }) +
    request.messages.reduce((tokens, message) => tokens + estimateModelMessageTokens(message), 0) +
    (request.tools.length === 0 ? 0 : estimateJsonTokens(request.tools)) +
    3
  );
}

function resolveOutputBudget(
  requested: number | undefined,
  defaultValue: number,
  capability: number | undefined,
): number {
  const value = requested ?? Math.min(defaultValue, capability ?? defaultValue);
  requirePositiveTokenCount(value, "模型输出预算");
  if (capability !== undefined && value > capability) {
    throw new Error("显式模型输出预算超过已声明的模型输出能力。");
  }
  return value;
}

function requirePositiveTokenCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label}必须是正整数 token 数。`);
  }
}

/** Tool 结果在模型上下文中的首期单项上限。 */
export const TOOL_RESULT_TOKEN_LIMIT = 4_000;

/** 同一条 Assistant 回复产生的 Tool 结果共享的首期上限。 */
export const TOOL_RESULT_BATCH_TOKEN_LIMIT = 8_000;

/** 估算一段文本占用的 token 数；这是保守启发式，不等同于 Provider tokenizer。 */
export function estimateTextTokens(text: string): number {
  let tokens = 0;
  let asciiCharacterCount = 0;

  const flushAsciiCharacters = () => {
    tokens += Math.ceil(asciiCharacterCount / 3);
    asciiCharacterCount = 0;
  };

  for (const character of text) {
    if (isAsciiCharacter(character)) {
      asciiCharacterCount += 1;
      continue;
    }
    flushAsciiCharacters();
    tokens += 1;
  }
  flushAsciiCharacters();
  return tokens;
}

/** 将文本限制在 token 预算内，并保留明确的截断标记。 */
export function boundTextToTokenBudget(
  text: string,
  tokenBudget: number,
  truncationMarker = "...[结果已截断，原文可通过产物读取]",
): Readonly<{ content: string; truncated: boolean; estimatedTokens: number }> {
  if (tokenBudget <= 0) {
    return Object.freeze({ content: "", truncated: text.length > 0, estimatedTokens: 0 });
  }
  const estimatedTokens = estimateTextTokens(text);
  if (estimatedTokens <= tokenBudget) {
    return Object.freeze({ content: text, truncated: false, estimatedTokens });
  }

  const markerTokens = estimateTextTokens(truncationMarker);
  if (markerTokens >= tokenBudget) {
    const markerCharacters = Array.from(truncationMarker);
    const marker = takeTextPrefix(markerCharacters, tokenBudget);
    return Object.freeze({
      content: marker,
      truncated: true,
      estimatedTokens: estimateTextTokens(marker),
    });
  }

  const characters = Array.from(text);
  let lower = 0;
  let upper = characters.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    const prefix = characters.slice(0, middle).join("");
    const candidate = prefix + "\n" + truncationMarker;
    if (estimateTextTokens(candidate) <= tokenBudget) {
      lower = middle;
    } else {
      upper = middle - 1;
    }
  }
  const prefix = characters.slice(0, lower).join("");
  const content = prefix + (prefix.length === 0 ? "" : "\n") + truncationMarker;
  return Object.freeze({
    content,
    truncated: true,
    estimatedTokens: estimateTextTokens(content),
  });
}

/** 估算结构化输入的文本表示，并保留少量消息封装余量。 */
export function estimateJsonTokens(value: unknown): number {
  let serializedValue: string;
  try {
    serializedValue = JSON.stringify(value) ?? "";
  } catch {
    serializedValue = "";
  }
  return estimateTextTokens(serializedValue) + 4;
}

function takeTextPrefix(characters: readonly string[], tokenBudget: number): string {
  let prefix = "";
  for (const character of characters) {
    const nextPrefix = prefix + character;
    if (estimateTextTokens(nextPrefix) > tokenBudget) {
      break;
    }
    prefix = nextPrefix;
  }
  return prefix;
}

function isAsciiCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint <= 0x7f;
}
