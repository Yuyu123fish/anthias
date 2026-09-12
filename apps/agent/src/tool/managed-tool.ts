import { createHash } from "node:crypto";
import type { AssistantToolCallPart } from "../message.js";
import type { PermissionMode } from "../permission/permission-mode.js";
import type { AgentTool, ToolCallPlan } from "./tool-runner.js";

export type AgentToolExtension = Readonly<{
  tools(mode: PermissionMode): readonly AgentTool[];
  /** 只解释已知但未开放工具的拒绝原因，不能返回可执行行为。 */
  rejectUnavailableTool?(call: AssistantToolCallPart, mode: PermissionMode): ToolCallPlan | null;
}>;

export type ManagedOperation = Readonly<{
  target: string;
  preview: string;
  approval: boolean;
  execute(signal: AbortSignal): Promise<string>;
}>;

/** 只统一两种内部工具的审批与结果协议，业务校验仍由各自 Module 持有。 */
export function managedToolPlan(
  call: AssistantToolCallPart,
  _mode: PermissionMode,
  prepare: (signal?: AbortSignal) => Promise<ManagedOperation>,
): ToolCallPlan {
  return {
    scheduling: "serial",
    waitForPreparationOnAbort: true,
    abortedPreparationContent: "操作准备已取消。",
    async prepare(signal) {
      try {
        signal?.throwIfAborted();
        if (call.invalid) throw new Error("工具参数无效。");
        const operation = await prepare(signal);
        return {
          ok: true,
          preparedExecution: {
            activitySummary: operation.target,
            executionUnavailableContent: "操作已取消，未执行。",
            approval: operation.approval
              ? {
                  toolName: call.toolName,
                  target: operation.target,
                  preview: operation.preview,
                  ruleId: "managed_operation",
                  riskSummary: "此操作会改变本地代码、Git 状态，或启动受限成员执行。",
                  executionBoundary: "仅执行本次明确动作；成员任务不构成新的用户授权。",
                  deniedContent: "用户未批准本次操作。",
                  actionFingerprint: createHash("sha256")
                    .update(
                      JSON.stringify([
                        call.toolName,
                        call.input,
                        operation.target,
                        operation.preview,
                      ]),
                    )
                    .digest("hex"),
                }
              : null,
            async execute(signal) {
              try {
                signal.throwIfAborted();
                const content = await operation.execute(signal);
                return { status: "completed", content, truncated: false, cleanupUncertain: false };
              } catch (error) {
                return {
                  status: "failed",
                  content: signal.aborted
                    ? "操作已停止；已保存的历史和成果保留。"
                    : error instanceof Error
                      ? error.message
                      : "操作失败，已保存事实保留。",
                  truncated: false,
                  cleanupUncertain: false,
                };
              }
            },
          },
        };
      } catch (error) {
        return {
          ok: false,
          result: {
            status: "failed",
            content: error instanceof Error ? error.message : "操作准备失败。",
            truncated: false,
          },
        };
      }
    },
  };
}
