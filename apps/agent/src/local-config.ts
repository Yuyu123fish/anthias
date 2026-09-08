import { lstat, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPermissionMode, type PermissionMode } from "./permission/permission-mode.js";

export const LOCAL_ENVIRONMENT_TEMPLATE = `# Anthias 配置：.env-example 可提交，填入凭据的 .env 不提交。
# 只读取 Anthias 根目录的 .env，不读取任务工作区中的同名文件。
# 进程环境覆盖本文件，包括显式空值。值可用单引号或双引号包裹，不展开变量。
ANTHIAS_MODEL_BASE_URL=
ANTHIAS_MODEL_ID=
ANTHIAS_MODEL_API_KEY=

# 自定义模型必须声明上下文窗口；已知模型可使用内置能力数据。
# ANTHIAS_MODEL_CONTEXT_WINDOW=128000
# ANTHIAS_MODEL_MAX_OUTPUT_TOKENS=64000
# 普通输出默认 64000；窗口不超过 84000 时沿用 16000，再按模型输出能力收窄。
# 显式配置保留原值，超过已声明能力或无法容纳安全余量时拒绝启动。
# ANTHIAS_RESPONSE_MAX_TOKENS=64000
# ANTHIAS_COMPACTION_MAX_TOKENS=8000
# ANTHIAS_CONTEXT_KEEP_TOKENS=32000

# 可选 reasoning_effort：low / medium / high，需由当前服务明确支持所选值。
# 未配置时不发送此参数；普通生成与自动审核独立设置，压缩不继承。
# ANTHIAS_RESPONSE_REASONING_EFFORT=low
# ANTHIAS_APPROVAL_REASONING_EFFORT=low

# 可选；缺少此 Key 只影响 web_search。
SEARCHAPI_API_KEY=

# agent / plan / auto_allow / full_access；AutoAllow 按工作区授权或真实用户要求审核。
# Full Access 跳过人工和模型审批，可访问系统用户权限内的工作区外文件；没有 OS 沙箱。
# --mode 优先于此默认值；运行中的 /mode 不改写本文件。
ANTHIAS_PERMISSION_MODE=agent
`;

export type LocalConfigurationResult =
  | Readonly<{ ok: true; environment: NodeJS.ProcessEnv; permissionMode: PermissionMode }>
  | Readonly<{ ok: false; error: string }>;

/** 根配置属于安装位置；调用方只可由启动装配或测试显式给出根，不能以任务 cwd 推导。 */
export async function loadLocalConfiguration({
  environment = process.env,
  anthiasRoot = fileURLToPath(new URL("../../../", import.meta.url)),
  permissionMode,
  onConfigurationWarning,
}: {
  environment?: NodeJS.ProcessEnv;
  anthiasRoot?: string;
  permissionMode?: PermissionMode | undefined;
  onConfigurationWarning?: ((message: string) => void) | undefined;
} = {}): Promise<LocalConfigurationResult> {
  if (!isAbsolute(anthiasRoot)) {
    return { ok: false, error: "Anthias 配置根目录必须是绝对路径。" };
  }
  const configurationPath = join(anthiasRoot, ".env");
  let fileEnvironment: NodeJS.ProcessEnv = {};
  try {
    try {
      // 独占创建避免覆盖已有凭据；模板只含空值与非敏感默认值。
      await writeFile(configurationPath, LOCAL_ENVIRONMENT_TEMPLATE, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        try {
          await lstat(configurationPath);
        } catch {
          onConfigurationWarning?.(
            `无法创建本地配置 ${safePath(configurationPath)}；本次只采用进程环境。`,
          );
          return resolveConfiguration(environment, {}, permissionMode);
        }
        throw error;
      }
    }
    const configurationStat = await lstat(configurationPath);
    if (!configurationStat.isFile() || configurationStat.size > 64 * 1024) {
      return {
        ok: false,
        error: `本地配置 ${safePath(configurationPath)} 必须是至多 64 KiB 的普通文件。`,
      };
    }
    const configurationText = await readFile(configurationPath, "utf8");
    const parsedEnvironment = parseEnvironment(configurationText);
    if (!parsedEnvironment.ok) {
      return {
        ok: false,
        error: `本地配置 ${safePath(configurationPath)} 第 ${parsedEnvironment.line} 行格式错误；使用 NAME=value，引号必须闭合，不支持多行值。`,
      };
    }
    fileEnvironment = parsedEnvironment.environment;
  } catch {
    return { ok: false, error: `无法读取本地配置 ${safePath(configurationPath)}。` };
  }
  return resolveConfiguration(environment, fileEnvironment, permissionMode);
}

function resolveConfiguration(
  processEnvironment: NodeJS.ProcessEnv,
  fileEnvironment: NodeJS.ProcessEnv,
  explicitMode: PermissionMode | undefined,
): LocalConfigurationResult {
  // spread 保留进程中显式空串或 undefined；它们都不能重新取得文件中的密钥。
  const environment = { ...fileEnvironment, ...processEnvironment };
  const permissionMode = explicitMode ?? environment.ANTHIAS_PERMISSION_MODE ?? "agent";
  if (!isPermissionMode(permissionMode)) {
    return {
      ok: false,
      error: "ANTHIAS_PERMISSION_MODE 配置无效；只能为 agent、plan、auto_allow 或 full_access。",
    };
  }
  return { ok: true, environment, permissionMode };
}

function parseEnvironment(
  text: string,
): { ok: true; environment: NodeJS.ProcessEnv } | { ok: false; line: number } {
  const environment: NodeJS.ProcessEnv = Object.create(null);
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line || line.startsWith("#")) continue;
    const assignment = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!assignment) return { ok: false, line: index + 1 };
    const name = assignment[1];
    const rawValue = assignment[2] ?? "";
    if (
      !name ||
      [...rawValue].some((character) => character.charCodeAt(0) < 0x20 && character !== "\t")
    ) {
      return { ok: false, line: index + 1 };
    }
    const quote = rawValue[0];
    if (quote === '"' || quote === "'") {
      const closingQuote = rawValue.indexOf(quote, 1);
      if (closingQuote < 0 || !/^\s*(?:#.*)?$/.test(rawValue.slice(closingQuote + 1))) {
        return { ok: false, line: index + 1 };
      }
      environment[name] = rawValue.slice(1, closingQuote);
    } else {
      environment[name] = rawValue.split("#", 1)[0]?.trim() ?? "";
    }
  }
  return { ok: true, environment };
}

function safePath(path: string): string {
  return [...path]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? "�" : character;
    })
    .join("");
}
