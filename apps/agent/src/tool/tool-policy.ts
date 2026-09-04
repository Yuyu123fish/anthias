import type { PermissionMode } from "../permission-mode.js";
import type { FixedToolName } from "./definitions.js";

/** 描述一次 ToolCall 在执行前形成的不可变安全决定。 */
export type ToolPolicyDecision = Readonly<{
  kind: "allow" | "ask" | "deny";
  ruleId: string;
  riskSummary: string;
  executionBoundary: string;
}>;

type ToolPolicyInput = Readonly<{
  permissionMode: PermissionMode;
  toolName: FixedToolName;
  command?: string;
  externalFile?: boolean;
}>;

type HardDanger = Readonly<{
  ruleId: string;
  riskSummary: string;
}>;

const CURRENT_USER_COMMAND_BOUNDARY =
  "命令以 Anthias 当前用户权限运行，无 OS 沙箱；cwd 仅固定在工作区，但命令仍可访问该用户可访问的工作区外文件、网络与系统资源。";

/** 按权限模式、Tool 类型和准备结果形成唯一 Policy Decision。 */
export function decideToolPolicy(input: ToolPolicyInput): ToolPolicyDecision {
  if (input.toolName === "read_file" || input.toolName === "glob" || input.toolName === "grep") {
    return freezeDecision(
      "allow",
      "read.workspace_only",
      "只读取工作区内且不属于活动 Session 的内容。",
      "路径解析和真实路径校验均限制在当前工作区。",
    );
  }
  if (input.permissionMode === "plan") {
    return freezeDecision(
      "deny",
      "permission.plan_read_only",
      `Plan 模式不允许执行 ${input.toolName}。`,
      "调用不会请求批准，也不会启动文件写入或命令。",
    );
  }
  if (input.toolName === "edit_file" || input.toolName === "write_file") {
    return input.externalFile === true
      ? freezeDecision(
          "ask",
          "file.external_exact_review",
          "该调用将修改工作区外的本地文件。",
          "一次批准只允许写入预览中显示的一个精确文件；执行前会重验父目录、目标身份与内容指纹。",
        )
      : freezeDecision(
          "ask",
          "file.workspace_exact_review",
          "该调用将修改工作区内的本地文件。",
          "一次批准只允许写入预览中显示的一个精确文件；活动 Session 目录仍不可访问。",
        );
  }
  return classifyCommandSafety(input.command ?? "");
}

/** 纯字符串识别高置信危险命令；普通且可审阅的命令交给 HITL。 */
export function classifyCommandSafety(commandText: string): ToolPolicyDecision {
  const hardDanger = findHardDanger(commandText.normalize("NFKC"), 0);
  if (hardDanger !== null) {
    return freezeDecision(
      "deny",
      hardDanger.ruleId,
      hardDanger.riskSummary,
      "硬拒绝规则不可由 approval 覆盖；命令不会交给 Shell。",
    );
  }
  return freezeDecision(
    "ask",
    "command.current_user_review",
    "该命令将以 Anthias 当前用户权限执行，静态检查无法证明其全部副作用。",
    CURRENT_USER_COMMAND_BOUNDARY,
  );
}

/** 在有限递归内检查直接命令与字面量 Shell wrapper。 */
function findHardDanger(commandText: string, wrapperDepth: number): HardDanger | null {
  const directDanger = findDirectHardDanger(commandText);
  if (directDanger !== null) {
    return directDanger;
  }
  const wrappedCommand = extractLiteralWrappedCommand(commandText);
  if (wrappedCommand === null) {
    return null;
  }
  if (wrapperDepth >= 3) {
    return Object.freeze({
      ruleId: "danger.opaque_command",
      riskSummary: "Shell wrapper 嵌套过深，无法向用户提供可信的待执行文本。",
    });
  }
  return findHardDanger(unwrapLiteral(wrappedCommand), wrapperDepth + 1);
}

/** 检查无需执行或解释脚本即可确认的危险文本类别。 */
function findDirectHardDanger(commandText: string): HardDanger | null {
  if (
    /\b(?:pwsh|powershell)(?:\.exe)?\b[^\r\n]*(?:-(?:enc|encodedcommand|encodedarguments))\b/iu.test(
      commandText,
    ) ||
    /(?:^|[;&|]\s*)(?:invoke-expression|iex)\b/iu.test(commandText)
  ) {
    return danger("danger.opaque_command", "命令使用编码载荷或动态求值，无法进行可信人工审阅。");
  }
  if (
    /\b(?:curl|wget)(?:\.exe)?\b[\s\S]*\|\s*(?:ba)?sh\b/iu.test(commandText) ||
    /\b(?:curl|wget|iwr|invoke-webrequest)(?:\.exe)?\b[\s\S]*\|\s*(?:pwsh|powershell|iex|invoke-expression)\b/iu.test(
      commandText,
    )
  ) {
    return danger("danger.remote_script_execution", "命令会把远程脚本内容直接交给解释器执行。");
  }
  if (
    /\brm(?:\.exe)?\b(?=[^;\r\n|]*\s(?:-[a-z]*r[a-z]*|--recursive)\b)(?=[^;\r\n|]*\s(?:-[a-z]*f[a-z]*|--force)\b)[^;\r\n|]*\s(?:--\s+)?["']?\/["']?(?:\s*(?:$|[;&|]))/iu.test(
      commandText,
    )
  ) {
    return danger("danger.unix_root_recursive_delete", "命令会递归强制删除 Unix 根目录。");
  }
  if (/\bmkfs\.[a-z0-9_-]+\b/iu.test(commandText)) {
    return danger("danger.disk_format", "命令会格式化磁盘或分区。");
  }
  if (/\bdd\b(?=[\s\S]*\bif\s*=)(?=[\s\S]*\bof\s*=\s*["']?\/dev\/)/iu.test(commandText)) {
    return danger("danger.raw_disk_write", "命令会直接写入磁盘设备。");
  }
  if (/\bchmod\s+-R\s+777\s+["']?\/["']?(?:\s*(?:$|[;&|]))/iu.test(commandText)) {
    return danger("danger.root_permission_change", "命令会递归放开 Unix 根目录权限。");
  }
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/u.test(commandText)) {
    return danger("danger.fork_bomb", "命令是会耗尽进程资源的 fork bomb。");
  }
  if (/(?:^|[^>])>{1,2}\s*["']?\/dev\/sd[a-z0-9]*/iu.test(commandText)) {
    return danger("danger.device_overwrite", "命令会通过重定向覆盖磁盘设备。");
  }
  if (
    /\b(?:format-volume|clear-disk|initialize-disk|diskpart(?:\.exe)?|bcdedit(?:\.exe)?|bootrec(?:\.exe)?)\b/iu.test(
      commandText,
    ) ||
    /\bformat(?:\.com|\.exe)?\b[^;\r\n|]*\s["']?[a-z]:/iu.test(commandText)
  ) {
    return danger("danger.windows_system_destructive", "命令会修改磁盘、分区或系统启动配置。");
  }
  if (
    /\b(?:remove-item|rm|ri|rmdir|rd|del)\b(?=[^;\r\n|]*(?:-recurse|-r|\/s)\b)(?=[^;\r\n|]*(?:-force|-f|\/q)\b)[^;\r\n|]*["']?[a-z]:[\\/]["']?(?:\s|$)/iu.test(
      commandText,
    )
  ) {
    return danger("danger.windows_root_recursive_delete", "命令会递归强制删除 Windows 卷根目录。");
  }
  if (/\breg(?:\.exe)?\s+delete\s+(?:hklm|hkey_local_machine)\\[^\r\n]*\/f\b/iu.test(commandText)) {
    return danger("danger.windows_registry_delete", "命令会强制删除机器级注册表内容。");
  }
  return null;
}

/** 提取可见文本中的第一层常见 Shell 命令参数，不运行任何解析器。 */
function extractLiteralWrappedCommand(commandText: string): string | null {
  const wrapperPatterns = [
    /\b(?:pwsh|powershell)(?:\.exe)?\b[\s\S]*?\s-(?:command|c)\s+([\s\S]+)$/iu,
    /\bcmd(?:\.exe)?\b[\s\S]*?\s\/c\s+([\s\S]+)$/iu,
    /\b(?:bash|sh)(?:\.exe)?\b[\s\S]*?\s-c\s+([\s\S]+)$/iu,
  ];
  for (const pattern of wrapperPatterns) {
    const match = pattern.exec(commandText);
    if (match?.[1] !== undefined) {
      return match[1].trim();
    }
  }
  return null;
}

/** 只剥离成对的最外层引号；无法还原的内容仍保留给保守扫描。 */
function unwrapLiteral(commandText: string): string {
  if (commandText.length < 2) {
    return commandText;
  }
  const firstCharacter = commandText[0];
  return (firstCharacter === '"' || firstCharacter === "'") && commandText.at(-1) === firstCharacter
    ? commandText.slice(1, -1)
    : commandText;
}

function danger(ruleId: string, riskSummary: string): HardDanger {
  return Object.freeze({ ruleId, riskSummary });
}

function freezeDecision(
  kind: ToolPolicyDecision["kind"],
  ruleId: string,
  riskSummary: string,
  executionBoundary: string,
): ToolPolicyDecision {
  return Object.freeze({ kind, ruleId, riskSummary, executionBoundary });
}
