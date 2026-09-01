/** 保存生产 Model Adapter 所需的本地配置。 */
export type ModelConfig = Readonly<{
  baseURL: string;
  modelId: string;
  apiKey: string;
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

/** 枚举 Anthias 读取的模型环境变量名。 */
type ModelVariable = (typeof MODEL_VARIABLES)[number];

/** 限定模型配置读取函数可观察的环境变量集合。 */
type ModelEnvironment = Readonly<Partial<Record<ModelVariable, string | undefined>>>;

/** 读取并本地校验模型环境变量，不验证远端凭据或模型可用性。 */
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

  return Object.freeze({
    ok: true,
    config: Object.freeze({
      baseURL: baseURL.replace(/\/+$/, ""),
      modelId: environment.ANTHIAS_MODEL_ID?.trim() ?? "",
      apiKey: environment.ANTHIAS_MODEL_API_KEY?.trim() ?? "",
    }),
  });
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
