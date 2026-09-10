import type { AssistantToolCallPart, ToolResultMessage } from "../message.js";
import type { PermissionMode } from "../permission/permission-mode.js";
import type { SessionShell } from "../session/index.js";
import type { SessionArtifactStore } from "./artifacts.js";
import {
  BASE_TOOLS,
  isReadOnlyToolName,
  isSideEffectToolName,
  type ModelToolDefinition,
} from "./definitions.js";
import { createRejectedToolCallPlan } from "./tool-plan.js";
import type { ToolExecutionResult } from "./tool-result.js";
import type { ToolWorkspace } from "./workspace-path.js";

/** 配置一个绑定固定工作区与 Shell 的 ToolRunner。 */
export type CreateToolRunnerOptions = Readonly<{
  workspace: ToolWorkspace;
  shell: SessionShell;
  artifactStore?: SessionArtifactStore;
}>;

/** 隐藏 Tool 分派细节，只向 Agent Loop 提供统一计划入口。 */
export type ToolRunner = Readonly<{
  createPlan(toolCall: AssistantToolCallPart, permissionMode: PermissionMode): ToolCallPlan;
}>;

/** 描述 Tool 执行期间可以按发生顺序发布的输出。 */
type ToolExecutionUpdate = Readonly<{
  stream: "stdout" | "stderr";
  delta: string;
}>;

/** 描述副作用 Tool 在执行前必须展示的一次性确认。 */
export type ToolApprovalPlan = Readonly<{
  toolName: string;
  target: string;
  preview: string;
  ruleId: string;
  riskSummary: string;
  executionBoundary: string;
  deniedContent: string;
  actionFingerprint: string;
}>;

/** 保存已经完成预检、可以由 Agent Loop 执行的 ToolCall。 */
export type PreparedToolExecution = Readonly<{
  approval: ToolApprovalPlan | null;
  activitySummary: string;
  executionUnavailableContent: string;
  execute(
    abortSignal: AbortSignal,
    publishUpdate: (update: ToolExecutionUpdate) => void,
    resultTokenBudget?: number,
  ): Promise<
    ToolExecutionResult &
      Readonly<{
        cleanupUncertain: boolean;
      }>
  >;
}>;

/** 表示预检或 Policy 已经可以直接形成的非执行结果。 */
type ImmediateToolResult = Readonly<{
  status: Extract<ToolResultMessage["status"], "failed" | "denied">;
  content: string;
  truncated: boolean;
}>;

/** 表示 ToolCall 已形成可执行计划，或可以立即返回安全结果。 */
export type ToolCallPreparation =
  | Readonly<{ ok: true; preparedExecution: PreparedToolExecution }>
  | Readonly<{ ok: false; result: ImmediateToolResult }>;

/** 描述单个调用对整个 Tool Batch 调度方式的要求。 */
export type ToolCallScheduling =
  | "parallel"
  | "serial"
  | Readonly<{
      path: string;
      access: "read" | "write";
      recursive?: boolean;
    }>;

/** 隐藏具体 Tool 分派，并提供统一的无副作用预检入口。 */
export type ToolCallPlan = Readonly<{
  scheduling: ToolCallScheduling;
  abortedPreparationContent: string;
  prepare(signal?: AbortSignal): Promise<ToolCallPreparation>;
  /** 持有子进程的预检必须等取消完成，避免关闭后遗留进程。 */
  waitForPreparationOnAbort?: boolean;
}>;

/** 定义和计划绑定同一个工具，模型可见性不能替代计划内的权限检查。 */
export type AgentTool = Readonly<{
  definition: ModelToolDefinition;
  createPlan(toolCall: AssistantToolCallPart, permissionMode: PermissionMode): ToolCallPlan;
}>;

/** 基础工具只在绑定时接收工作区资源，定义与计划始终来自工具自身。 */
export type BaseTool = Readonly<{
  definition: ModelToolDefinition;
  createPlan(
    toolCall: AssistantToolCallPart,
    permissionMode: PermissionMode,
    options: CreateToolRunnerOptions,
  ): ToolCallPlan;
}>;

/** 每次请求选取同一组工具；Full Access 的路径能力仍由调用时的权限决定。 */
export function createBaseTools(
  options: CreateToolRunnerOptions,
  mode: PermissionMode,
): readonly AgentTool[] {
  return Object.freeze(
    BASE_TOOLS.filter((tool) => mode !== "plan" || isReadOnlyToolName(tool.definition.name)).map(
      (tool) =>
        Object.freeze({
          definition: tool.definition,
          createPlan: (toolCall: AssistantToolCallPart, permissionMode: PermissionMode) =>
            tool.createPlan(toolCall, permissionMode, {
              ...options,
              workspace: {
                ...options.workspace,
                allowExternalPaths: permissionMode === "full_access",
              },
            }),
        }),
    ),
  );
}

/** Runner 只按同源工具集合查找，不持有另一套业务分派。 */
export function createToolRunnerFromTools(tools: readonly AgentTool[]): ToolRunner {
  const toolsByName = new Map<string, AgentTool>();
  for (const tool of tools) {
    if (toolsByName.has(tool.definition.name))
      throw new Error("工具名称重复：" + tool.definition.name);
    toolsByName.set(tool.definition.name, tool);
  }
  return Object.freeze({
    createPlan(toolCall, permissionMode) {
      return (
        toolsByName.get(toolCall.toolName)?.createPlan(toolCall, permissionMode) ??
        createRejectedToolCallPlan(
          toolCall.invalid
            ? `${toolCall.toolName} 输入无法解析或不符合 Schema。`
            : `未知或尚不可执行的 Tool：${toolCall.toolName}`,
        )
      );
    },
  });
}

/** 确定性测试可直接构造基础 Runner；执行仍经过工具自身的模式校验。 */
export function createToolRunner(options: CreateToolRunnerOptions): ToolRunner {
  return createToolRunnerFromTools(createBaseTools(options, "agent"));
}

/** 隐藏的副作用工具仍先校验参数再拒绝；复用同一计划入口，不能另开执行路径。 */
export function rejectUnavailableBaseTool(
  toolCall: AssistantToolCallPart,
  permissionMode: PermissionMode,
  options: CreateToolRunnerOptions,
): ToolCallPlan | null {
  if (permissionMode !== "plan" || !isSideEffectToolName(toolCall.toolName)) return null;
  return (
    BASE_TOOLS.find((tool) => tool.definition.name === toolCall.toolName)?.createPlan(
      toolCall,
      permissionMode,
      options,
    ) ?? null
  );
}
