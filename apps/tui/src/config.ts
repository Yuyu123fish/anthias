export type ModelConfig = Readonly<{
  baseURL: string;
  modelId: string;
  apiKey: string;
}>;

export type ModelConfigResult =
  | Readonly<{ ok: true; config: ModelConfig }>
  | Readonly<{ ok: false; error: string }>;

const MODEL_VARIABLES = [
  "ANTHIAS_MODEL_BASE_URL",
  "ANTHIAS_MODEL_ID",
  "ANTHIAS_MODEL_API_KEY",
] as const;

type ModelVariable = (typeof MODEL_VARIABLES)[number];
type Environment = Readonly<Partial<Record<ModelVariable, string | undefined>>>;

export function readModelConfig(environment: Environment = process.env): ModelConfigResult {
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

  return Object.freeze({
    ok: true,
    config: Object.freeze({
      baseURL: baseURL.replace(/\/+$/, ""),
      modelId: environment.ANTHIAS_MODEL_ID?.trim() ?? "",
      apiKey: environment.ANTHIAS_MODEL_API_KEY?.trim() ?? "",
    }),
  });
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
