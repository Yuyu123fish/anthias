import { createHash } from "node:crypto";
import type { AssistantToolCallPart, ToolResultMessage } from "../message.js";
import type { PermissionMode } from "../permission/permission-mode.js";
import { decideToolPolicy, type ToolPolicyDecision } from "../permission/tool-policy.js";
import type {
  ArtifactSourceStatus,
  ArtifactWriter,
  SessionArtifactStore,
} from "../session/artifacts.js";
import type { SessionShell } from "../session/index.js";
import { prepareEditFileTool, validateEditFileToolCallInput } from "./basetool/edit-file.js";
import {
  executePreparedCommand,
  type PreparedCommandTool,
  prepareCommandTool,
  validateCommandToolCallInput,
} from "./basetool/execute-command.js";
import {
  executePreparedFileTool,
  type PreparedFileResult,
  type PreparedFileTool,
} from "./basetool/file-change.js";
import { executeGlobTool, validateGlobToolCallInput } from "./basetool/glob.js";
import { executeGrepTool, validateGrepToolCallInput } from "./basetool/grep.js";
import {
  executeReadArtifactTool,
  validateReadArtifactToolCallInput,
} from "./basetool/read-artifact.js";
import { executeReadFileTool, validateReadFileToolCallInput } from "./basetool/read-file.js";
import { prepareWriteFileTool, validateWriteFileToolCallInput } from "./basetool/write-file.js";
import type { ReadOnlyToolName } from "./definitions.js";
import { isRecord } from "./input-validation.js";
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
  toolName: "edit_file" | "write_file" | "execute_command";
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

type ToolExecutionOutcome = ToolExecutionResult &
  Readonly<{
    cleanupUncertain?: boolean;
  }>;

/** 表示 ToolCall 已形成可执行计划，或可以立即返回安全结果。 */
export type ToolCallPreparation =
  | Readonly<{ ok: true; preparedExecution: PreparedToolExecution }>
  | Readonly<{ ok: false; result: ImmediateToolResult }>;

/** 描述单个调用对整个 Tool Batch 调度方式的要求。 */
export type ToolCallScheduling = "parallel_read_only" | "source_order_serial";

/** 隐藏具体 Tool 分派，并提供统一的无副作用预检入口。 */
export type ToolCallPlan = Readonly<{
  scheduling: ToolCallScheduling;
  abortedPreparationContent: string;
  prepare(): Promise<ToolCallPreparation>;
}>;

/** 创建已经绑定运行环境、可以被 Agent Loop 直接调用的 ToolRunner。 */
export function createToolRunner(options: CreateToolRunnerOptions): ToolRunner {
  const runnerOptions = Object.freeze({
    workspace: options.workspace,
    shell: options.shell,
    ...(options.artifactStore === undefined ? {} : { artifactStore: options.artifactStore }),
  });
  return Object.freeze({
    createPlan: (toolCall, permissionMode) =>
      createToolCallPlan(toolCall, permissionMode, runnerOptions),
  });
}

/** 将任意 ToolCall 解析为统一的预检、Policy 与执行计划。 */
function createToolCallPlan(
  toolCall: AssistantToolCallPart,
  permissionMode: PermissionMode,
  options: CreateToolRunnerOptions,
): ToolCallPlan {
  if (toolCall.toolName === "read_file") {
    const validationError = validateReadFileToolCallInput(toolCall);
    return validationError === null
      ? createReadOnlyToolCallPlan(
          toolCall,
          "read_file",
          permissionMode,
          options.workspace,
          options.artifactStore,
          executeReadFileTool,
        )
      : createRejectedToolCallPlan(validationError);
  }
  if (toolCall.toolName === "glob") {
    const validationError = validateGlobToolCallInput(toolCall);
    return validationError === null
      ? createReadOnlyToolCallPlan(
          toolCall,
          "glob",
          permissionMode,
          options.workspace,
          options.artifactStore,
          executeGlobTool,
        )
      : createRejectedToolCallPlan(validationError);
  }
  if (toolCall.toolName === "grep") {
    const validationError = validateGrepToolCallInput(toolCall);
    return validationError === null
      ? createReadOnlyToolCallPlan(
          toolCall,
          "grep",
          permissionMode,
          options.workspace,
          options.artifactStore,
          executeGrepTool,
        )
      : createRejectedToolCallPlan(validationError);
  }
  if (toolCall.toolName === "read_artifact") {
    const validationError = validateReadArtifactToolCallInput(toolCall);
    if (validationError !== null) {
      return createRejectedToolCallPlan(validationError);
    }
    return createReadArtifactToolCallPlan(toolCall, permissionMode, options.artifactStore);
  }
  if (toolCall.toolName === "execute_command") {
    const validationError = validateCommandToolCallInput(toolCall);
    if (validationError !== null) {
      return createRejectedToolCallPlan(validationError);
    }
    if (permissionMode === "plan") {
      return createPolicyDeniedPlan(
        decideToolPolicy({ permissionMode, toolName: "execute_command" }),
      );
    }
    return createCommandToolCallPlan(toolCall, permissionMode, options);
  }
  if (toolCall.toolName === "edit_file") {
    const validationError = validateEditFileToolCallInput(toolCall);
    if (validationError !== null) {
      return createRejectedToolCallPlan(validationError);
    }
    if (permissionMode === "plan") {
      return createPolicyDeniedPlan(decideToolPolicy({ permissionMode, toolName: "edit_file" }));
    }
    return createFileToolCallPlan(toolCall, permissionMode, options.workspace, prepareEditFileTool);
  }
  if (toolCall.toolName === "write_file") {
    const validationError = validateWriteFileToolCallInput(toolCall);
    if (validationError !== null) {
      return createRejectedToolCallPlan(validationError);
    }
    if (permissionMode === "plan") {
      return createPolicyDeniedPlan(decideToolPolicy({ permissionMode, toolName: "write_file" }));
    }
    return createFileToolCallPlan(
      toolCall,
      permissionMode,
      options.workspace,
      prepareWriteFileTool,
    );
  }
  return createRejectedToolCallPlan(
    toolCall.invalid
      ? `${toolCall.toolName} 输入无法解析或不符合 Schema。`
      : `未知或尚不可执行的 Tool：${toolCall.toolName}`,
  );
}

/** 创建无需人工确认的只读 Tool 计划。 */
function createReadOnlyToolCallPlan(
  toolCall: AssistantToolCallPart,
  toolName: ReadOnlyToolName,
  permissionMode: PermissionMode,
  workspace: ToolWorkspace,
  artifactStore: SessionArtifactStore | undefined,
  executeTool: (
    toolCall: AssistantToolCallPart,
    workspace: ToolWorkspace,
    abortSignal: AbortSignal,
    artifactWriter?: ArtifactWriter,
  ) => Promise<ToolExecutionResult>,
): ToolCallPlan {
  const policyDecision = decideToolPolicy({ permissionMode, toolName });
  if (policyDecision.kind !== "allow") {
    return createPolicyDeniedPlan(policyDecision);
  }
  return Object.freeze({
    scheduling: "parallel_read_only",
    abortedPreparationContent: "Tool 执行已停止。",
    prepare: () =>
      Promise.resolve(
        Object.freeze({
          ok: true,
          preparedExecution: Object.freeze({
            approval: null,
            activitySummary: createReadOnlyToolActivitySummary(toolCall, toolName),
            executionUnavailableContent: "Run 已停止，Tool 未执行。",
            async execute(abortSignal: AbortSignal) {
              let artifactWriter: ArtifactWriter | undefined;
              try {
                artifactWriter = artifactStore?.createWriter(toolCall.toolCallId);
              } catch {
                artifactWriter = undefined;
              }
              let executionResult: ToolExecutionResult;
              try {
                executionResult = await executeTool(
                  toolCall,
                  workspace,
                  abortSignal,
                  artifactWriter,
                );
              } catch {
                executionResult = Object.freeze({
                  status: "failed",
                  content: "Tool 执行失败。",
                  truncated: false,
                });
              }
              return attachArtifactResult(
                executionResult,
                artifactWriter,
                toArtifactSourceStatus(executionResult.status, abortSignal),
              );
            },
          }),
        }),
      ),
  });
}

/** 创建需要预检和人工确认的文件 Tool 计划。 */
function createFileToolCallPlan(
  toolCall: AssistantToolCallPart,
  permissionMode: PermissionMode,
  workspace: ToolWorkspace,
  prepareTool: (
    toolCall: AssistantToolCallPart,
    workspace: ToolWorkspace,
  ) => Promise<PreparedFileResult>,
): ToolCallPlan {
  return Object.freeze({
    scheduling: "source_order_serial",
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
      if (policyDecision.kind !== "ask") {
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

/** 创建需要预检、分类和人工确认的命令 Tool 计划。 */
function createCommandToolCallPlan(
  toolCall: AssistantToolCallPart,
  permissionMode: PermissionMode,
  options: CreateToolRunnerOptions,
): ToolCallPlan {
  return Object.freeze({
    scheduling: "source_order_serial",
    abortedPreparationContent: "Run 已停止，命令未启动。",
    async prepare() {
      const preparedResult = await prepareCommandTool(toolCall, options.workspace, options.shell);
      if (!preparedResult.ok) {
        return Object.freeze({ ok: false, result: preparedResult.result });
      }
      const preparedTool = preparedResult.preparedTool;
      const policyDecision = decideToolPolicy({
        permissionMode,
        toolName: "execute_command",
        command: preparedTool.command,
      });
      if (policyDecision.kind === "deny") {
        return Object.freeze({ ok: false, result: policyResult(policyDecision) });
      }
      if (policyDecision.kind !== "ask") {
        throw new Error("execute_command Policy 必须是 ask 或 deny。");
      }
      return Object.freeze({
        ok: true,
        preparedExecution: Object.freeze({
          approval: createApprovalPlan(preparedTool, policyDecision),
          activitySummary: createToolActivitySummary(
            `cwd: ${preparedTool.target}; command: ${preparedTool.command}`,
          ),
          executionUnavailableContent: "Run 已停止，命令未启动。",
          async execute(
            abortSignal: AbortSignal,
            publishUpdate: (update: ToolExecutionUpdate) => void,
          ) {
            let artifactWriter: ArtifactWriter | undefined;
            try {
              artifactWriter = options.artifactStore?.createWriter(toolCall.toolCallId);
            } catch {
              artifactWriter = undefined;
            }
            try {
              const executionResult = await executePreparedCommand(
                preparedTool,
                abortSignal,
                publishUpdate,
                artifactWriter,
              );
              return attachArtifactResult(
                executionResult,
                artifactWriter,
                toArtifactSourceStatus(executionResult.status, abortSignal),
              );
            } catch {
              return attachArtifactResult(
                failedExecution(true),
                artifactWriter,
                toArtifactSourceStatus("failed", abortSignal),
              );
            }
          },
        }),
      });
    },
  });
}

/** 从已通过 Schema 校验的只读 ToolCall 形成不含原始 JSON 的动作摘要。 */
function createReadOnlyToolActivitySummary(
  toolCall: AssistantToolCallPart,
  toolName: ReadOnlyToolName,
): string {
  if (!isRecord(toolCall.input)) {
    throw new Error("已校验 ToolCall 缺少对象输入。");
  }
  const input = toolCall.input;
  if (toolName === "read_file") {
    const range =
      typeof input.startLine === "number" || typeof input.lineCount === "number"
        ? `; lines: ${typeof input.startLine === "number" ? input.startLine : 1}-${
            (typeof input.startLine === "number" ? input.startLine : 1) +
            (typeof input.lineCount === "number" ? input.lineCount : 200) -
            1
          }`
        : "";
    return createToolActivitySummary(`path: ${String(input.path)}${range}`);
  }
  if (toolName === "glob") {
    return createToolActivitySummary(
      `pattern: ${String(input.pattern)}; base: ${typeof input.path === "string" ? input.path : "."}`,
    );
  }
  if (toolName === "read_artifact") {
    if (!isRecord(toolCall.input)) {
      throw new Error("已校验 ToolCall 缺少对象输入。");
    }
    return createToolActivitySummary(`artifactId: ${String(toolCall.input.artifactId)}`);
  }
  return createToolActivitySummary(
    `pattern: ${String(input.pattern)}; base: ${typeof input.path === "string" ? input.path : "."}; files: ${
      typeof input.filePattern === "string" ? input.filePattern : "**/*"
    }`,
  );
}

function createReadArtifactToolCallPlan(
  toolCall: AssistantToolCallPart,
  permissionMode: PermissionMode,
  artifactStore: SessionArtifactStore | undefined,
): ToolCallPlan {
  const policyDecision = decideToolPolicy({ permissionMode, toolName: "read_artifact" });
  if (policyDecision.kind !== "allow") {
    return createPolicyDeniedPlan(policyDecision);
  }
  return Object.freeze({
    scheduling: "parallel_read_only",
    abortedPreparationContent: "Tool 执行已停止。",
    prepare: () =>
      Promise.resolve(
        Object.freeze({
          ok: true,
          preparedExecution: Object.freeze({
            approval: null,
            activitySummary: createReadOnlyToolActivitySummary(toolCall, "read_artifact"),
            executionUnavailableContent: "Run 已停止，Tool 未执行。",
            async execute(
              abortSignal: AbortSignal,
              _publishUpdate: (update: ToolExecutionUpdate) => void,
              resultTokenBudget?: number,
            ) {
              return Object.freeze({
                ...(await executeReadArtifactTool(
                  toolCall,
                  artifactStore,
                  abortSignal,
                  resultTokenBudget,
                )),
                cleanupUncertain: false,
              });
            },
          }),
        }),
      ),
  });
}

/** 删除终端控制字符、折叠换行，并以 Unicode code point 限制展示长度。 */
function createToolActivitySummary(summary: string): string {
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
function createPolicyDeniedPlan(policyDecision: ToolPolicyDecision): ToolCallPlan {
  return Object.freeze({
    scheduling: "source_order_serial",
    abortedPreparationContent: "Tool 未执行。",
    prepare: () =>
      Promise.resolve(Object.freeze({ ok: false, result: policyResult(policyDecision) })),
  });
}

/** 创建无效输入或未知 Tool 的直接失败计划。 */
function createRejectedToolCallPlan(content: string): ToolCallPlan {
  return Object.freeze({
    scheduling: "source_order_serial",
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

function createApprovalPlan(
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

function policyResult(policyDecision: ToolPolicyDecision): ImmediateToolResult {
  return Object.freeze({
    status: policyDecision.kind === "deny" ? "denied" : "failed",
    content: `${policyDecision.riskSummary}（规则：${policyDecision.ruleId}）`,
    truncated: false,
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

/** 在 Agent Loop 预算收口前统一保留已产生的原文，小产物仍受 Session 配额和清理约束。 */
async function attachArtifactResult(
  executionResult: ToolExecutionOutcome,
  artifactWriter: ArtifactWriter | undefined,
  sourceStatus: ArtifactSourceStatus,
): Promise<ToolExecutionOutcome & Readonly<{ cleanupUncertain: boolean }>> {
  const cleanupUncertain = executionResult.cleanupUncertain === true;
  if (artifactWriter === undefined) {
    return Object.freeze({ ...executionResult, cleanupUncertain });
  }
  const pendingOrWrittenByteLength = artifactWriter.byteLength + artifactWriter.pendingByteLength;
  const retainArtifact =
    pendingOrWrittenByteLength > 0 || executionResult.truncated || artifactWriter.hasIncomplete;
  let artifactReference: Awaited<ReturnType<ArtifactWriter["finish"]>>;
  try {
    artifactReference = await artifactWriter.finish(sourceStatus, retainArtifact);
  } catch {
    artifactReference = null;
  }
  if (artifactReference === null) {
    return Object.freeze({
      ...executionResult,
      content:
        retainArtifact && artifactWriter.hasIncomplete
          ? `${executionResult.content}\n...[原文产物未完整保存]`
          : executionResult.content,
      truncated: executionResult.truncated || (retainArtifact && artifactWriter.hasIncomplete),
      cleanupUncertain,
    });
  }
  return Object.freeze({ ...executionResult, artifact: artifactReference, cleanupUncertain });
}

function toArtifactSourceStatus(
  status: ToolExecutionResult["status"],
  abortSignal: AbortSignal,
): ArtifactSourceStatus {
  return abortSignal.aborted ? "aborted" : status === "completed" ? "completed" : "failed";
}
