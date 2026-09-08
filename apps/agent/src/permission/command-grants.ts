import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { isRecord } from "../tool/input-validation.js";
import { arePathsEqual, isPathSameOrInside } from "../tool/workspace-path.js";
import { classifyCommandSafety } from "./tool-policy.js";
import type { WorkspaceCommand } from "./workspace-permissions.js";

const COMMAND_LIMIT = 49;
const COMMAND_LENGTH = 2_000;

/** 用户登记的是字面入口及参数范围；这里不推断脚本运行时的副作用。 */
export function normalizeCommandGrants(
  values: unknown,
  workspaceRoot: string,
): readonly WorkspaceCommand[] {
  if (!Array.isArray(values) || values.length > COMMAND_LIMIT)
    throw new Error("命令授权最多保存 49 个明确入口。");
  const commands: WorkspaceCommand[] = [];
  for (const value of values) {
    if (!isCommandGrant(value))
      throw new Error("命令授权需要有效的字面命令、相对 cwd 和参数范围。");
    let directory: string;
    try {
      directory = realpathSync(resolve(workspaceRoot, value.cwd));
      if (!statSync(directory).isDirectory() || !isPathSameOrInside(workspaceRoot, directory))
        throw new Error("invalid directory");
    } catch {
      throw new Error("命令授权 cwd 必须是当前工作区内已存在的目录，不能经链接指向外部。");
    }
    const command = Object.freeze({
      command: value.command.trim(),
      cwd: relative(workspaceRoot, directory) || ".",
      ...(value.allowArguments === true ? { allowArguments: true } : {}),
    });
    if (
      !commands.some(
        (existing) =>
          existing.command === command.command &&
          existing.cwd === command.cwd &&
          existing.allowArguments === command.allowArguments,
      )
    )
      commands.push(command);
  }
  return Object.freeze(commands);
}

/** 磁盘记录仅校验字面格式；实际 cwd 身份在执行前重新核对，不缓存目录信任。 */
export function isCommandGrant(value: unknown): value is WorkspaceCommand {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["command", "cwd", "allowArguments"].includes(key)) ||
    typeof value.command !== "string" ||
    typeof value.cwd !== "string" ||
    value.cwd.length === 0 ||
    value.cwd.length > 1_024 ||
    isAbsolute(value.cwd) ||
    /^[a-z]:/iu.test(value.cwd) ||
    value.cwd.split(/[\\/]/u).includes("..") ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 授权路径明确拒绝控制字符。
    /[\x00-\x1f]/u.test(value.cwd) ||
    (value.allowArguments !== undefined && typeof value.allowArguments !== "boolean")
  )
    return false;
  const segments = literalCommands(value.command);
  return (
    segments !== null &&
    segments.length === 1 &&
    !excludedCommand(segments[0] ?? []) &&
    classifyCommandSafety(value.command).kind !== "deny"
  );
}

export function matchesCommandGrants(
  command: string,
  actualDirectory: string,
  workspaceRoot: string,
  grants: readonly WorkspaceCommand[],
): boolean {
  const segments = literalCommands(command);
  if (segments === null || classifyCommandSafety(command).kind === "deny") return false;
  return segments.every(
    (tokens) =>
      !excludedCommand(tokens) &&
      grants.some((grant) => {
        // 目录可能在授权后被换成链接；最终 cwd 和重新解析后的登记路径必须同时匹配。
        let grantedDirectory: string;
        try {
          grantedDirectory = realpathSync(resolve(workspaceRoot, grant.cwd));
        } catch {
          return false;
        }
        if (
          !isPathSameOrInside(workspaceRoot, grantedDirectory) ||
          !arePathsEqual(grantedDirectory, actualDirectory)
        )
          return false;
        const expected = literalCommands(grant.command)?.[0];
        if (!expected || expected.length > tokens.length) return false;
        return (
          (grant.allowArguments === true || expected.length === tokens.length) &&
          expected.every((token, index) => token === tokens[index])
        );
      }),
  );
}

/** 只识别无展开的字面 Shell 子集；不确定语法交回审核，不能把引号内分隔符当成新动作。 */
function literalCommands(command: string): readonly (readonly string[])[] | null {
  if (
    command.length === 0 ||
    command.length > COMMAND_LENGTH ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 命令只接受已定义的空白与分隔符，其余控制字符转审核。
    /[\x00-\x08\x0b\x0c\x0e-\x1f\u0085\u2028\u2029$`]/u.test(command) ||
    /\\["']/u.test(command)
  )
    return null;
  const segments: string[][] = [];
  let tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "'" | '"' | null = null;
  const finishToken = () => {
    if (tokenStarted) tokens.push(token);
    token = "";
    tokenStarted = false;
  };
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (quote !== null) {
      if (character === quote) {
        // PowerShell 单引号转义与 POSIX 相邻字面量语义不一致，保守回到审核。
        if (command[index + 1] === quote) return null;
        quote = null;
      } else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
    } else if (character === " " || character === "\t") {
      finishToken();
    } else if (
      character === ";" ||
      character === "\n" ||
      character === "\r" ||
      character === "|" ||
      character === "&"
    ) {
      // PowerShell 也把单独的 CR 作为命令边界，CRLF 则只分隔一次。
      if (character === "\r" && command[index + 1] === "\n") index++;
      if (character === "&" && command[index + 1] !== "&") return null;
      if (character === "&") index++;
      if (character === "|" && command[index + 1] === "|") return null;
      finishToken();
      if (tokens.length === 0) return null;
      segments.push(tokens);
      tokens = [];
    } else if (character === undefined || /[<>(){}\[\]@]/u.test(character)) {
      return null;
    } else {
      token += character;
      tokenStarted = true;
    }
  }
  if (quote !== null) return null;
  finishToken();
  if (tokens.length === 0) return null;
  segments.push(tokens);
  return segments.every((segment) => /^[\p{L}\p{N}_.:/\\-]+$/u.test(segment[0] ?? ""))
    ? segments
    : null;
}

function excludedCommand(tokens: readonly string[]): boolean {
  const executable = (tokens[0] ?? "")
    .replace(/^.*[\\/]/u, "")
    .replace(/\.exe$/iu, "")
    .toLowerCase();
  if (
    ["git", "rm", "rmdir", "rd", "del", "erase", "remove-item", "clear-content"].includes(
      executable,
    )
  )
    return true;
  return (
    ["npm", "pnpm", "yarn"].includes(executable) &&
    tokens.slice(1).some((token) => /^(?:publish|deploy)$/iu.test(token))
  );
}
