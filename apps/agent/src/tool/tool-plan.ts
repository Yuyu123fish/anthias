import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { AssistantToolCallPart } from "../message.js";
import type { PermissionMode } from "../permission/permission-mode.js";
import { decideToolPolicy, type ToolPolicyDecision } from "../permission/tool-policy.js";
import type { PreparedCommandTool } from "./basetool/execute-command.js";
import {
  executePreparedFileTool,
  type PreparedFileResult,
  type PreparedFileTool,
} from "./basetool/file-change.js";
import type { ReadOnlyToolName } from "./definitions.js";
import { isRecord } from "./input-validation.js";
import type { ToolExecutionResult } from "./tool-result.js";
import type {
  ToolApprovalPlan,
  ToolCallPlan,
  ToolCallPreparation,
  ToolCallScheduling,
} from "./tool-runner.js";
import type { ToolWorkspace } from "./workspace-path.js";

/** 创建无需人工确认的只读 Tool 计划。 */
export function createReadOnlyToolCallPlan(
  toolCall: AssistantToolCallPart,
  toolName: ReadOnlyToolName,
  permissionMode: PermissionMode,
  workspace: ToolWorkspace,
  activitySummary: string,
  recursive: boolean,
  executeTool: (
    toolCall: AssistantToolCallPart,
    workspace: ToolWorkspace,
    abortSignal: AbortSignal,
  ) => Promise<ToolExecutionResult>,
): ToolCallPlan {
  const policyDecision = decideToolPolicy({ permissionMode, toolName });
  if (policyDecision.kind !== "allow") {
    return createPolicyDeniedPlan(policyDecision);
  }
  return Object.freeze({
    scheduling: fileAccess(toolCall, workspace, "read", recursive),
    abortedPreparationContent: "Tool 执行已停止。",
    prepare: () =>
      Promise.resolve(
        Object.freeze({
          ok: true,
          preparedExecution: Object.freeze({
            approval: null,
            activitySummary: createToolActivitySummary(activitySummary),
            executionUnavailableContent: "Run 已停止，Tool 未执行。",
            async execute(abortSignal: AbortSignal) {
              try {
                return {
                  ...(await executeTool(toolCall, workspace, abortSignal)),
                  cleanupUncertain: false,
                };
              } catch {
                return failedExecution(false);
              }
            },
          }),
        }),
      ),
  });
}

/** 创建需要预检和人工确认的文件 Tool 计划。 */
export function createFileToolCallPlan(
  toolCall: AssistantToolCallPart,
  permissionMode: PermissionMode,
  workspace: ToolWorkspace,
  prepareTool: (
    toolCall: AssistantToolCallPart,
    workspace: ToolWorkspace,
  ) => Promise<PreparedFileResult>,
): ToolCallPlan {
  return Object.freeze({
    scheduling: fileAccess(toolCall, workspace, "write"),
    abortedPreparationContent: "Run 已停止，文件未写入。",
    async prepare() {
      const preparedResult = await prepareTool(toolCall, workspace);
      if (!preparedResult.ok) {
        return Object.freeze({ ok: false, result: preparedResult.result });
      }
      const preparedTool = preparedResult.preparedTool;
      const policyDecision = decideToolPolicy({
        permissionMode,
        toolName: preparedTool.toolName,
        externalFile: preparedTool.scope === "external",
      });
      if (policyDecision.kind === "deny") {
        return Object.freeze({ ok: false, result: policyResult(policyDecision) });
      }
      return Object.freeze({
        ok: true,
        preparedExecution: Object.freeze({
          approval: createApprovalPlan(preparedTool, policyDecision),
          activitySummary: createToolActivitySummary(`target: ${preparedTool.target}`),
          executionUnavailableContent: "Run 已停止，文件未写入。",
          async execute(abortSignal: AbortSignal) {
            try {
              return Object.freeze({
                ...(await executePreparedFileTool(preparedTool, abortSignal)),
                cleanupUncertain: false,
              });
            } catch {
              return failedExecution(false);
            }
          },
        }),
      });
    },
  });
}

/** 删除终端控制字符、折叠换行，并以 Unicode code point 限制展示长度。 */
export function createToolActivitySummary(summary: string): string {
  const singleLineSummary = [...summary]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  const visibleCharacters = [...singleLineSummary];
  return visibleCharacters.length <= 160
    ? singleLineSummary
    : `${visibleCharacters.slice(0, 159).join("")}…`;
}

/** 创建 Permission 或 hard danger 的不可批准结果。 */
export function createPolicyDeniedPlan(policyDecision: ToolPolicyDecision): ToolCallPlan {
  return Object.freeze({
    scheduling: "serial",
    abortedPreparationContent: "Tool 未执行。",
    prepare: () =>
      Promise.resolve(Object.freeze({ ok: false, result: policyResult(policyDecision) })),
  });
}

/** 创建无效输入或未知 Tool 的直接失败计划。 */
export function createRejectedToolCallPlan(content: string): ToolCallPlan {
  return Object.freeze({
    scheduling: "serial",
    abortedPreparationContent: "Tool 未执行。",
    prepare: () =>
      Promise.resolve(
        Object.freeze({
          ok: false,
          result: Object.freeze({ status: "failed", content, truncated: false }),
        }),
      ),
  });
}

export function createApprovalPlan(
  preparedTool: PreparedFileTool | PreparedCommandTool,
  policyDecision: ToolPolicyDecision,
): ToolApprovalPlan {
  // 指纹覆盖完整准备快照，不能只绑定展示预览；文件身份在部分平台上可能是 bigint。
  const actionFingerprint = createHash("sha256")
    .update(
      JSON.stringify(preparedTool, (_key, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    )
    .digest("hex");
  return Object.freeze({
    toolName: preparedTool.toolName,
    target: preparedTool.target,
    preview: preparedTool.preview,
    actionFingerprint,
    ruleId: policyDecision.ruleId,
    riskSummary: policyDecision.riskSummary,
    executionBoundary: policyDecision.executionBoundary,
    deniedContent: `用户拒绝执行 ${preparedTool.toolName}。`,
  });
}

export function policyResult(
  policyDecision: ToolPolicyDecision,
): Extract<ToolCallPreparation, { ok: false }>["result"] {
  return Object.freeze({
    status: policyDecision.kind === "deny" ? "denied" : "failed",
    content: `${policyDecision.riskSummary}（规则：${policyDecision.ruleId}）`,
    truncated: false,
  });
}

/** 将副作用 Tool 的意外异常转换为不含本地细节的失败结果。 */
export function failedExecution(
  cleanupUncertain: boolean,
): ToolExecutionResult & Readonly<{ cleanupUncertain: boolean }> {
  return Object.freeze({
    status: "failed",
    content: "Tool 执行失败。",
    truncated: false,
    cleanupUncertain,
  });
}

function fileAccess(
  toolCall: AssistantToolCallPart,
  workspace: ToolWorkspace,
  access: "read" | "write",
  recursive = false,
): ToolCallScheduling {
  const input = toolCall.input;
  if (!isRecord(input)) return "serial";
  const path = typeof input.path === "string" ? input.path : ".";
  return {
    path: resolve(workspace.workspaceRoot, path),
    access,
    recursive,
  };
}
