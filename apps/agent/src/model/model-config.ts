import { type ContextBudget, createContextBudget } from "../context/budget.js";
import { type ModelCapabilities, resolveModelCapabilities } from "./model-capabilities.js";

/** 保存生产 Model Adapter 配置与已经验证的上下文能力和策略。 */
export type ModelConfig = Readonly<{
  baseURL: string;
  modelId: string;
  apiKey: string;
  capabilities: ModelCapabilities;
  contextBudget: ContextBudget;
}>;

/** 表示模型配置读取成功或返回安全校验错误。 */
export type ModelConfigResult =
  | Readonly<{ ok: true; config: ModelConfig }>
  | Readonly<{ ok: false; error: string }>;

const MODEL_VARIABLES = [
  "ANTHIAS_MODEL_BASE_URL",
  "ANTHIAS_MODEL_ID",
  "ANTHIAS_MODEL_API_KEY",
] as const;

const BUDGET_VARIABLES = [
  "ANTHIAS_MODEL_CONTEXT_WINDOW",
  "ANTHIAS_MODEL_MAX_OUTPUT_TOKENS",
  "ANTHIAS_RESPONSE_MAX_TOKENS",
  "ANTHIAS_COMPACTION_MAX_TOKENS",
  "ANTHIAS_CONTEXT_KEEP_TOKENS",
] as const;

type ModelVariable = (typeof MODEL_VARIABLES)[number] | (typeof BUDGET_VARIABLES)[number];
type ModelEnvironment = Readonly<Partial<Record<ModelVariable, string | undefined>>>;

/** 本地解析凭据、能力与预算；失败只包含配置变量名或固定校验原因。 */
export function readModelConfig(environment: ModelEnvironment = process.env): ModelConfigResult {
  const missingVariables = MODEL_VARIABLES.filter((name) => !environment[name]?.trim());
  if (missingVariables.length > 0) {
    return Object.freeze({
      ok: false,
      error: `缺少模型配置：${missingVariables.join("、")}。请通过本地环境变量提供。`,
    });
  }
  const baseURL = environment.ANTHIAS_MODEL_BASE_URL?.trim() ?? "";
  if (!isHttpUrl(baseURL)) {
    return Object.freeze({
      ok: false,
      error: "模型配置格式错误：ANTHIAS_MODEL_BASE_URL 必须是有效的 http 或 https URL。",
    });
  }
  const modelId = environment.ANTHIAS_MODEL_ID?.trim() ?? "";
  try {
    const contextWindow = readTokenSetting(environment, "ANTHIAS_MODEL_CONTEXT_WINDOW");
    const maxOutputTokens = readTokenSetting(environment, "ANTHIAS_MODEL_MAX_OUTPUT_TOKENS");
    const responseOutputTokens = readTokenSetting(environment, "ANTHIAS_RESPONSE_MAX_TOKENS");
    const summaryOutputTokens = readTokenSetting(environment, "ANTHIAS_COMPACTION_MAX_TOKENS");
    const retainedTokens = readTokenSetting(environment, "ANTHIAS_CONTEXT_KEEP_TOKENS");
    const capabilities = resolveModelCapabilities(modelId, {
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    });
    const contextBudget = createContextBudget(capabilities, {
      ...(responseOutputTokens === undefined ? {} : { responseOutputTokens }),
      ...(summaryOutputTokens === undefined ? {} : { summaryOutputTokens }),
      ...(retainedTokens === undefined ? {} : { retainedTokens }),
    });
    return Object.freeze({
      ok: true,
      config: Object.freeze({
        baseURL: baseURL.replace(/\/+$/, ""),
        modelId,
        apiKey: environment.ANTHIAS_MODEL_API_KEY?.trim() ?? "",
        capabilities,
        contextBudget,
      }),
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      error: error instanceof Error ? error.message : "模型上下文配置无效。",
    });
  }
}

function readTokenSetting(
  environment: ModelEnvironment,
  name: (typeof BUDGET_VARIABLES)[number],
): number | undefined {
  const rawValue = environment[name];
  if (rawValue === undefined) return undefined;
  const value = Number(rawValue.trim());
  if (!/^[1-9]\d*$/.test(rawValue.trim()) || !Number.isSafeInteger(value)) {
    throw new Error(`模型配置格式错误：${name} 必须是正整数 token 数。`);
  }
  return value;
}

/** 仅接受可用于模型请求的 HTTP(S) Base URL。 */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
