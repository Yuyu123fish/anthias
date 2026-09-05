/** 枚举当前 Agent Run 可以请求的能力范围。 */
export type PermissionMode = "agent" | "plan" | "auto_allow";

/** 未显式指定模式时保留完整的交互式 Agent 能力。 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "agent";

/** 在 CLI 等运行时边界收窄权限模式文本。 */
export function isPermissionMode(value: string): value is PermissionMode {
  return value === "agent" || value === "plan" || value === "auto_allow";
}
