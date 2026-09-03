import type { AssistantToolCallPart } from "../message.js";
import type { SessionShell } from "../session.js";
import { executePreparedCommand, prepareCommandTool } from "./command-tool.js";
import { isReadOnlyToolName } from "./definitions.js";
import { executePreparedFileTool, isFileToolName, prepareFileTool } from "./file-tool.js";
import { executeReadOnlyTool } from "./read-only-tool.js";
import type { ToolExecutionResult } from "./tool-result.js";
import type { ToolWorkspace } from "./workspace-path.js";

/** 配置一个绑定固定工作区与 Shell 的 ToolRunner。 */
export type CreateToolRunnerOptions = Readonly<{
  workspace: ToolWorkspace;
  shell: SessionShell;
}>;

/** 隐藏 Tool 分派细节，只向 Agent Loop 提供统一计划入口。 */
export type ToolRunner = Readonly<{
  createPlan(toolCall: AssistantToolCallPart): ToolCallPlan;
}>;

/** 描述 Tool 执行期间可以按发生顺序发布的输出。 */
type ToolExecutionUpdate = Readonly<{
  stream: "stdout" | "stderr";
  delta: string;
}>;

/** 描述副作用 Tool 在执行前必须展示的一次性确认。 */
export type ToolApprovalPlan = Readonly<{
  toolName: "edit_file" | "write_file" | "execute_command";
  target: string;
  preview: string;
  deniedContent: string;
}>;

/** 保存已经完成预检、可以由 Agent Loop 执行的 ToolCall。 */
export type PreparedToolExecution = Readonly<{
  approval: ToolApprovalPlan | null;
  executionUnavailableContent: string;
  execute(
    abortSignal: AbortSignal,
    publishUpdate: (update: ToolExecutionUpdate) => void,
  ): Promise<
    ToolExecutionResult &
      Readonly<{
        cleanupUncertain: boolean;
      }>
  >;
}>;

/** 表示 ToolCall 已形成可执行计划，或可以立即返回安全失败。 */
type ToolCallPreparation =
  | Readonly<{ ok: true; preparedExecution: PreparedToolExecution }>
  | Readonly<{ ok: false; result: ToolExecutionResult }>;

/** 隐藏具体 Tool 分派，并声明预检是否消耗 Run 活动时间。 */
export type ToolCallPlan = Readonly<{
  preparationConsumesActiveDuration: boolean;
  preparationUnavailableContent: string;
  abortedPreparationContent: string;
  prepare(remainingActiveDurationMilliseconds: number): Promise<ToolCallPreparation>;
}>;

/** 创建已经绑定运行环境、可以被 Agent Loop 直接调用的 ToolRunner。 */
export function createToolRunner(options: CreateToolRunnerOptions): ToolRunner {
  const runnerOptions = Object.freeze({
    workspace: options.workspace,
    shell: options.shell,
  });
  return Object.freeze({
    createPlan: (toolCall) => createToolCallPlan(toolCall, runnerOptions),
  });
}

/** 将任意 ToolCall 解析为统一的预检与执行计划。 */
function createToolCallPlan(
  toolCall: AssistantToolCallPart,
  options: CreateToolRunnerOptions,
): ToolCallPlan {
  if (isReadOnlyToolName(toolCall.toolName)) {
    return createReadOnlyToolCallPlan(toolCall, options.workspace);
  }
  if (toolCall.toolName === "execute_command") {
    return createCommandToolCallPlan(toolCall, options);
  }
  if (isFileToolName(toolCall.toolName)) {
    return createFileToolCallPlan(toolCall, options.workspace);
  }
  return createRejectedToolCallPlan(toolCall);
}

/** 创建无需预检和人工确认的只读 Tool 计划。 */
function createReadOnlyToolCallPlan(
  toolCall: AssistantToolCallPart,
  workspace: ToolWorkspace,
): ToolCallPlan {
  return Object.freeze({
    preparationConsumesActiveDuration: false,
    preparationUnavailableContent: "Run 活动执行时长预算已耗尽，Tool 未执行。",
    abortedPreparationContent: "Tool 执行已停止。",
    prepare: () =>
      Promise.resolve(
        Object.freeze({
          ok: true,
          preparedExecution: Object.freeze({
            approval: null,
            executionUnavailableContent: "Run 活动执行时长预算已耗尽，Tool 未执行。",
            async execute(abortSignal: AbortSignal) {
              return Object.freeze({
                ...(await executeReadOnlyTool(toolCall, workspace, abortSignal)),
                cleanupUncertain: false,
              });
            },
          }),
        }),
      ),
  });
}

/** 创建需要活动时间预检和人工确认的文件 Tool 计划。 */
function createFileToolCallPlan(
  toolCall: AssistantToolCallPart,
  workspace: ToolWorkspace,
): ToolCallPlan {
  return Object.freeze({
    preparationConsumesActiveDuration: true,
    preparationUnavailableContent: "Run 活动执行时长预算已耗尽，文件未写入。",
    abortedPreparationContent: "Run 已停止，文件未写入。",
    async prepare() {
      const preparedResult = await prepareFileTool(toolCall, workspace);
      if (!preparedResult.ok) {
        return Object.freeze({ ok: false, result: preparedResult.result });
      }
      const preparedTool = preparedResult.preparedTool;
      return Object.freeze({
        ok: true,
        preparedExecution: Object.freeze({
          approval: Object.freeze({
            toolName: preparedTool.toolName,
            target: preparedTool.target,
            preview: preparedTool.preview,
            deniedContent: `用户拒绝执行 ${preparedTool.toolName}。`,
          }),
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

/** 创建需要活动时间预检和人工确认的命令 Tool 计划。 */
function createCommandToolCallPlan(
  toolCall: AssistantToolCallPart,
  options: CreateToolRunnerOptions,
): ToolCallPlan {
  return Object.freeze({
    preparationConsumesActiveDuration: true,
    preparationUnavailableContent: "Run 活动执行时长预算已耗尽，命令未启动。",
    abortedPreparationContent: "Run 已停止，命令未启动。",
    async prepare(remainingActiveDurationMilliseconds) {
      const preparedResult = await prepareCommandTool(
        toolCall,
        options.workspace,
        options.shell,
        remainingActiveDurationMilliseconds,
      );
      if (!preparedResult.ok) {
        return Object.freeze({ ok: false, result: preparedResult.result });
      }
      const preparedTool = preparedResult.preparedTool;
      return Object.freeze({
        ok: true,
        preparedExecution: Object.freeze({
          approval: Object.freeze({
            toolName: preparedTool.toolName,
            target: preparedTool.target,
            preview: preparedTool.preview,
            deniedContent: "用户拒绝执行 execute_command。",
          }),
          executionUnavailableContent: "Run 已停止，命令未启动。",
          async execute(
            abortSignal: AbortSignal,
            publishUpdate: (update: ToolExecutionUpdate) => void,
          ) {
            try {
              return await executePreparedCommand(preparedTool, abortSignal, publishUpdate);
            } catch {
              return failedExecution(true);
            }
          },
        }),
      });
    },
  });
}

/** 将未知 Tool 或无法解析的调用收敛为无需活动时间的失败计划。 */
function createRejectedToolCallPlan(toolCall: AssistantToolCallPart): ToolCallPlan {
  return Object.freeze({
    preparationConsumesActiveDuration: false,
    preparationUnavailableContent: "Tool 未执行。",
    abortedPreparationContent: "Tool 未执行。",
    prepare: () =>
      Promise.resolve(
        Object.freeze({
          ok: false,
          result: Object.freeze({
            status: "failed",
            content: toolCall.invalid
              ? `${toolCall.toolName} 输入无法解析或不符合 Schema。`
              : `未知或尚不可执行的 Tool：${toolCall.toolName}`,
            truncated: false,
          }),
        }),
      ),
  });
}

/** 将副作用 Tool 的意外异常转换为不含本地细节的失败结果。 */
function failedExecution(
  cleanupUncertain: boolean,
): ToolExecutionResult & Readonly<{ cleanupUncertain: boolean }> {
  return Object.freeze({
    status: "failed",
    content: "Tool 执行失败。",
    truncated: false,
    cleanupUncertain,
  });
}
