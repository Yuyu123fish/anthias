/** 已确认的模型容量；未声明输出能力时不把应用策略冒充 Provider 能力。 */
export type ModelCapabilities = Readonly<{
  contextWindow: number;
  maxOutputTokens?: number;
}>;

const KNOWN_MODEL_CAPABILITIES: Readonly<
  Record<
    string,
    ModelCapabilities &
      Readonly<{
        version: string;
        verifiedAt: string;
        sources: readonly string[];
      }>
  >
> = Object.freeze({
  "deepseek-v4-flash": Object.freeze({
    contextWindow: 1_048_576,
    maxOutputTokens: 384_000,
    version: "DeepSeek-V4-Flash-0731",
    verifiedAt: "2026-09-05",
    sources: Object.freeze([
      "https://api-docs.deepseek.com/quick_start/agent_integrations/codex/",
      "https://api-docs.deepseek.com/quick_start/pricing/",
    ]),
  }),
});

/** 只按已核验数据或显式声明解析能力，不从模型名数字推测窗口。 */
export function resolveModelCapabilities(
  modelId: string,
  overrides: Readonly<{ contextWindow?: number; maxOutputTokens?: number }> = {},
): ModelCapabilities {
  const knownCapabilities = KNOWN_MODEL_CAPABILITIES[modelId];
  const contextWindow = overrides.contextWindow ?? knownCapabilities?.contextWindow;
  const maxOutputTokens = overrides.maxOutputTokens ?? knownCapabilities?.maxOutputTokens;
  if (contextWindow === undefined) {
    throw new Error("未知模型需要配置 ANTHIAS_MODEL_CONTEXT_WINDOW。");
  }
  return Object.freeze({
    contextWindow,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  });
}
