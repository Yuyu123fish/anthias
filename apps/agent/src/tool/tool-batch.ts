import type { AgentLoopResult, RunAgentLoopOptions } from "../agent-loop.js";
import {
  boundTextToTokenBudget,
  estimateTextTokens,
  TOOL_RESULT_BATCH_TOKEN_LIMIT,
  TOOL_RESULT_TOKEN_LIMIT,
} from "../context/budget.js";
import {
  type AssistantMessage,
  type AssistantToolCallPart,
  isToolCallPart,
  type ToolArtifactReference,
  type ToolResultMessage,
} from "../message.js";
import { ModelRequestError } from "../model/model-stream.js";
import { finalizeToolResult } from "./tool-result.js";
import type { PreparedToolExecution, ToolCallPlan } from "./tool-runner.js";
import { selectConcurrentToolBatch } from "./tool-scheduling.js";

type ToolBatchOptions = Pick<
  RunAgentLoopOptions,
  | "toolRunner"
  | "permissionMode"
  | "artifactStore"
  | "abortController"
  | "recordMessage"
  | "emit"
  | "updatePhase"
  | "requestToolApproval"
>;
type ToolBatchResult = AgentLoopResult | Readonly<{ status: "call_limit" }>;
const TOOL_CALL_BATCH_LIMIT = 32;
const TOOL_CONCURRENCY_LIMIT = 4;
type PlannedToolCall = Readonly<{
  sourceIndex: number;
  toolCall: AssistantToolCallPart;
  plan: ToolCallPlan;
}>;
type ToolPreparationWaitResult =
  | Readonly<{ status: "prepared"; preparation: Awaited<ReturnType<ToolCallPlan["prepare"]>> }>
  | Readonly<{ status: "failed" }>
  | Readonly<{ status: "aborted" }>;
type SourceOrderStartGate = Readonly<{
  waitForTurn(sourceIndex: number): Promise<void>;
  completeTurn(sourceIndex: number): void;
}>;
type ToolResultBudget = {
  tokenBudgetPerResult: number;
  remainingTokens: number;
};

/** 一个响应内的预检、审批、资源屏障和结果提交共用同一协议；完成后才允许下一次模型请求。 */
export async function runToolBatch(
  toolCalls: readonly AssistantToolCallPart[],
  options: ToolBatchOptions,
): Promise<ToolBatchResult> {
  if (toolCalls.length > TOOL_CALL_BATCH_LIMIT) {
    await appendToolResults(
      toolCalls,
      "failed",
      "单次模型响应包含过多 ToolCall，调用未执行。",
      options,
    );
    return { status: "call_limit" };
  }

  const plannedToolCalls = toolCalls.map((toolCall, sourceIndex) =>
    Object.freeze({
      sourceIndex,
      toolCall,
      plan: options.toolRunner.createPlan(toolCall, options.permissionMode),
    }),
  );

  const toolResultBudget = createToolResultBudget(plannedToolCalls.length);
  for (let offset = 0; offset < plannedToolCalls.length; ) {
    const selectedPlans = selectConcurrentToolBatch(
      plannedToolCalls.map(({ plan }) => plan),
      offset,
    );
    const batch = plannedToolCalls
      .slice(offset, offset + selectedPlans.length)
      .map((plannedToolCall, sourceIndex) => ({ ...plannedToolCall, sourceIndex }));
    const toolBatchResult = await executeConcurrentToolBatch(
      batch,
      options,
      toolResultBudget.tokenBudgetPerResult,
    );
    for (const toolResult of toolBatchResult.toolResults) {
      await appendToolResultMessage(
        boundToolResultForBudget(toolResult, toolResultBudget),
        options,
      );
    }
    offset += batch.length;
    if (toolBatchResult.approvalFailure !== null) {
      await appendToolResults(
        plannedToolCalls.slice(offset).map(({ toolCall }) => toolCall),
        "aborted",
        "自动审核技术故障，后续调用未执行。",
        options,
        toolResultBudget,
      );
      return {
        status: "failed",
        error: "自动审核技术故障：" + toolBatchResult.approvalFailure.diagnostic.summary,
        diagnostic: toolBatchResult.approvalFailure.diagnostic,
      };
    }
    if (options.abortController.signal.aborted) {
      await appendToolResults(
        plannedToolCalls.slice(offset).map(({ toolCall }) => toolCall),
        "aborted",
        "Run 已停止，调用未执行。",
        options,
        toolResultBudget,
      );
      return { status: "aborted" };
    }
  }
  return { status: "completed" };
}

/** 按源索引保存并发结果，并为未领取调用补齐 aborted 消息。 */
async function executeConcurrentToolBatch(
  plannedToolCalls: readonly PlannedToolCall[],
  options: ToolBatchOptions,
  resultTokenBudget: number,
): Promise<
  Readonly<{
    toolResults: readonly ToolResultMessage[];
    approvalFailure: ModelRequestError | null;
  }>
> {
  const toolResultMessages: Array<ToolResultMessage | undefined> = Array.from({
    length: plannedToolCalls.length,
  });
  const startGate = createSourceOrderStartGate(plannedToolCalls.length);
  let nextSourceIndex = 0;
  async function runWorker(): Promise<void> {
    while (!options.abortController.signal.aborted) {
      const sourceIndex = nextSourceIndex;
      if (sourceIndex >= plannedToolCalls.length) {
        return;
      }
      nextSourceIndex += 1;
      const plannedToolCall = plannedToolCalls[sourceIndex];
      if (plannedToolCall === undefined) {
        throw new Error("ToolCall 并发队列状态缺失。");
      }

      try {
        toolResultMessages[sourceIndex] = await formToolResultMessage(
          plannedToolCall,
          options,
          startGate,
          resultTokenBudget,
        );
      } catch (error) {
        options.abortController.abort();
        await skipExecutionStart(sourceIndex, startGate);
        throw error;
      }
    }
  }

  const workerCount = Math.min(TOOL_CONCURRENCY_LIMIT, plannedToolCalls.length);
  // 持久化或事件失败时先取消并收齐其他 worker，不能让副作用逃出 Run 生命周期。
  const workerResults = await Promise.allSettled(
    Array.from({ length: workerCount }, () => runWorker()),
  );
  // 审核技术故障仍须保存其他 worker 的真实结果；存储失败优先向外传播。
  const rejectedWorkers = workerResults.filter((result) => result.status === "rejected");
  const unexpectedFailure = rejectedWorkers.find(
    (result) => !(result.reason instanceof ModelRequestError),
  );
  if (unexpectedFailure !== undefined) throw unexpectedFailure.reason;
  const approvalFailure = rejectedWorkers[0]?.reason;
  if (approvalFailure !== undefined && !(approvalFailure instanceof ModelRequestError))
    throw approvalFailure;
  for (const plannedToolCall of plannedToolCalls) {
    toolResultMessages[plannedToolCall.sourceIndex] ??= createAbortedToolResultMessage(
      plannedToolCall.toolCall,
      "Run 已停止，调用未执行。",
    );
  }
  return Object.freeze({
    approvalFailure: approvalFailure ?? null,
    toolResults: Object.freeze(
      toolResultMessages.map((toolResultMessage) => {
        if (toolResultMessage === undefined) throw new Error("ToolCall 结果缺失。");
        return toolResultMessage;
      }),
    ),
  });
}
async function formToolResultMessage(
  plannedToolCall: PlannedToolCall,
  options: ToolBatchOptions,
  startGate: SourceOrderStartGate,
  resultTokenBudget: number,
): Promise<ToolResultMessage> {
  const { plan, toolCall } = plannedToolCall;
  const preparationWaitResult = await waitForPreparationOrAbort(
    plan,
    options.abortController.signal,
  );
  if (preparationWaitResult.status === "aborted") {
    await skipExecutionStart(plannedToolCall.sourceIndex, startGate);
    return createAbortedToolResultMessage(toolCall, plan.abortedPreparationContent);
  }
  if (preparationWaitResult.status === "failed") {
    await skipExecutionStart(plannedToolCall.sourceIndex, startGate);
    return createToolResultMessage(toolCall, {
      status: "failed",
      content: "Tool 预检失败。",
      truncated: false,
    });
  }
  const { preparation } = preparationWaitResult;
  if (options.abortController.signal.aborted) {
    await skipExecutionStart(plannedToolCall.sourceIndex, startGate);
    return createAbortedToolResultMessage(toolCall, plan.abortedPreparationContent);
  }

  if (!preparation.ok) {
    await skipExecutionStart(plannedToolCall.sourceIndex, startGate);
    if (preparation.result.status === "denied")
      await options.emit({
        type: "tool_policy_denied",
        toolCall,
        reason: preparation.result.content,
      });
    return createToolResultMessage(toolCall, preparation.result);
  }
  return executePreparedToolCall(
    plannedToolCall,
    preparation.preparedExecution,
    options,
    startGate,
    resultTokenBudget,
  );
}

/** 协调一个已预检 Tool 的确认、执行和事件，结果由调用方串行提交。 */
async function executePreparedToolCall(
  plannedToolCall: PlannedToolCall,
  preparedExecution: PreparedToolExecution,
  options: ToolBatchOptions,
  startGate: SourceOrderStartGate,
  resultTokenBudget: number,
): Promise<ToolResultMessage> {
  const { toolCall, sourceIndex } = plannedToolCall;
  let toolApprovalRequestId: string | null = null;
  const approvalPlan = preparedExecution.approval;
  if (approvalPlan !== null) {
    await startGate.waitForTurn(sourceIndex);
    options.updatePhase("awaiting_tool_approval");
    const approval = await options.requestToolApproval(toolCall, approvalPlan);
    toolApprovalRequestId = approval.toolApprovalRequestId;
    if (approval.decision !== "approve" || options.abortController.signal.aborted) {
      await skipExecutionStart(sourceIndex, startGate);
      return createToolResultMessage(toolCall, {
        status: approval.decision === "deny" ? "denied" : "aborted",
        content:
          approval.decision === "deny"
            ? approvalPlan.deniedContent
            : preparedExecution.executionUnavailableContent,
        truncated: false,
      });
    }
  }

  if (options.abortController.signal.aborted) {
    await skipExecutionStart(sourceIndex, startGate);
    return createAbortedToolResultMessage(toolCall, preparedExecution.executionUnavailableContent);
  }

  const executionStarted = await publishExecutionStart(
    plannedToolCall,
    toolApprovalRequestId,
    preparedExecution.activitySummary,
    options,
    startGate,
  );
  if (!executionStarted) {
    return createAbortedToolResultMessage(toolCall, preparedExecution.executionUnavailableContent);
  }

  let executionResult: Awaited<ReturnType<PreparedToolExecution["execute"]>>;
  try {
    executionResult = await preparedExecution.execute(
      options.abortController.signal,
      (update) => {
        if (!options.abortController.signal.aborted) {
          void options.emit({
            type: "tool_execution_update",
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            stream: update.stream,
            delta: update.delta,
          });
        }
      },
      resultTokenBudget,
    );
  } catch {
    executionResult = Object.freeze({
      status: "failed",
      content: "Tool 执行失败。",
      truncated: false,
      cleanupUncertain: true,
    });
  }

  const finalizedResult = await finalizeToolResult(
    toolCall.toolCallId,
    executionResult,
    options.artifactStore,
    resultTokenBudget,
    executionResult.status === "completed"
      ? "completed"
      : options.abortController.signal.aborted
        ? "aborted"
        : "failed",
  );
  const toolResultMessage = createToolResultMessage(toolCall, {
    status:
      executionResult.status === "completed"
        ? "completed"
        : options.abortController.signal.aborted
          ? "aborted"
          : "failed",
    content: finalizedResult.content,
    truncated: finalizedResult.truncated,
    ...(finalizedResult.artifact === undefined ? {} : { artifact: finalizedResult.artifact }),
  });
  await options.emit({
    type: "tool_execution_end",
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    result: toolResultMessage,
    cleanupUncertain: executionResult.cleanupUncertain || finalizedResult.cleanupUncertain === true,
  });
  return toolResultMessage;
}

/** 取消阻止迟到预检进入执行；持有进程的预检先完成取消收口。 */
function waitForPreparationOrAbort(
  plan: ToolCallPlan,
  abortSignal: AbortSignal,
): Promise<ToolPreparationWaitResult> {
  if (abortSignal.aborted) {
    return Promise.resolve(Object.freeze({ status: "aborted" }));
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ToolPreparationWaitResult) => {
      if (settled) {
        return;
      }
      settled = true;
      abortSignal.removeEventListener("abort", handleAbort);
      resolve(result);
    };
    const handleAbort = () => {
      if (!plan.waitForPreparationOnAbort) finish(Object.freeze({ status: "aborted" }));
    };
    abortSignal.addEventListener("abort", handleAbort, { once: true });
    if (abortSignal.aborted) {
      finish(Object.freeze({ status: "aborted" }));
      return;
    }
    void Promise.resolve()
      .then(() => plan.prepare(abortSignal))
      .then(
        (preparation) =>
          finish(
            abortSignal.aborted
              ? Object.freeze({ status: "aborted" })
              : Object.freeze({ status: "prepared", preparation }),
          ),
        () => finish(Object.freeze({ status: abortSignal.aborted ? "aborted" : "failed" })),
      );
  });
}

function createAbortedToolResultMessage(
  toolCall: AssistantToolCallPart,
  content: string,
): ToolResultMessage {
  return createToolResultMessage(toolCall, { status: "aborted", content, truncated: false });
}

/** 串行提交已经形成的结果消息，再把它加入下一轮模型上下文。 */
async function appendToolResultMessage(
  toolResultMessage: ToolResultMessage,
  options: ToolBatchOptions,
): Promise<void> {
  await options.recordMessage(toolResultMessage, false);
}

function createToolResultMessage(
  toolCall: AssistantToolCallPart,
  result: Readonly<{
    status: ToolResultMessage["status"];
    content: string;
    truncated: boolean;
    artifact?: ToolArtifactReference;
  }>,
): ToolResultMessage {
  return Object.freeze({
    role: "tool",
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    status: result.status,
    content: result.content,
    truncated: result.truncated,
    ...(result.artifact === undefined ? {} : { artifact: result.artifact }),
  });
}
function createSourceOrderStartGate(toolCallCount: number): SourceOrderStartGate {
  const turns = Array.from({ length: toolCallCount }, () => Promise.withResolvers<void>());
  turns[0]?.resolve();
  return Object.freeze({
    async waitForTurn(sourceIndex) {
      await turns[sourceIndex]?.promise;
    },
    completeTurn(sourceIndex) {
      turns[sourceIndex + 1]?.resolve();
    },
  });
}

/** 对不执行的调用也按源顺序释放后续 start gate。 */
async function skipExecutionStart(
  sourceIndex: number,
  startGate: SourceOrderStartGate,
): Promise<void> {
  await startGate.waitForTurn(sourceIndex);
  startGate.completeTurn(sourceIndex);
}

/** 在 gate 内按源顺序发布 start，并在 abort 时只释放后续调用。 */
async function publishExecutionStart(
  plannedToolCall: PlannedToolCall,
  toolApprovalRequestId: string | null,
  activitySummary: string,
  options: ToolBatchOptions,
  startGate: SourceOrderStartGate,
): Promise<boolean> {
  await startGate.waitForTurn(plannedToolCall.sourceIndex);
  try {
    if (options.abortController.signal.aborted) {
      return false;
    }
    options.updatePhase("executing_tool");
    await options.emit({
      type: "tool_execution_start",
      toolCall: plannedToolCall.toolCall,
      toolApprovalRequestId,
      activitySummary,
    });
    return true;
  } finally {
    startGate.completeTurn(plannedToolCall.sourceIndex);
  }
}
export async function appendToolResults(
  toolCalls: readonly AssistantToolCallPart[],
  status: Extract<ToolResultMessage["status"], "failed" | "aborted">,
  content: string,
  options: ToolBatchOptions,
  toolResultBudget: ToolResultBudget = createToolResultBudget(toolCalls.length),
): Promise<void> {
  for (const toolCall of toolCalls) {
    const toolResultMessage = createToolResultMessage(toolCall, {
      status,
      content,
      truncated: false,
    });
    await appendToolResultMessage(
      boundToolResultForBudget(toolResultMessage, toolResultBudget),
      options,
    );
  }
}

/** 为异常终止的 AssistantMessage 补齐其中尚未执行的 ToolCall。 */
export async function appendUnresolvedToolResults(
  assistantMessage: AssistantMessage,
  options: ToolBatchOptions,
): Promise<void> {
  await appendToolResults(
    assistantMessage.content.filter(isToolCallPart),
    "aborted",
    "模型请求未正常完成，ToolCall 未执行。",
    options,
  );
}

function createToolResultBudget(resultCount = 1): ToolResultBudget {
  const normalizedResultCount = Math.max(1, resultCount);
  return {
    tokenBudgetPerResult: Math.min(
      TOOL_RESULT_TOKEN_LIMIT,
      Math.max(1, Math.floor(TOOL_RESULT_BATCH_TOKEN_LIMIT / normalizedResultCount)),
    ),
    remainingTokens: TOOL_RESULT_BATCH_TOKEN_LIMIT,
  };
}

/** 按单项和批次双重上限收口 ToolResult；预算消耗严格跟随模型源顺序。 */
function boundToolResultForBudget(
  toolResultMessage: ToolResultMessage,
  toolResultBudget: ToolResultBudget,
): ToolResultMessage {
  const availableTokenBudget = Math.max(
    0,
    Math.min(toolResultBudget.tokenBudgetPerResult, toolResultBudget.remainingTokens),
  );
  const contentTokenBudget = availableTokenBudget;
  const boundedContent = boundTextToTokenBudget(
    toolResultMessage.content,
    contentTokenBudget,
    getToolResultTruncationMarker(
      toolResultMessage.content,
      toolResultMessage.artifact !== undefined,
    ),
  );
  const resultContent = boundedContent.content || getTerminalStateContent(toolResultMessage.status);
  const consumedTokens = Math.min(availableTokenBudget, estimateTextTokens(resultContent));
  toolResultBudget.remainingTokens = Math.max(0, toolResultBudget.remainingTokens - consumedTokens);
  return Object.freeze({
    ...toolResultMessage,
    content: resultContent,
    truncated: toolResultMessage.truncated || boundedContent.truncated,
  });
}
/** 预算截断时区分可回读、部分保存和完全未保存的结果。 */
function getToolResultTruncationMarker(content: string, artifactAvailable: boolean): string {
  const commandMarker = "...[命令输出已截断，管道已继续排空]";
  const preservationMessage = artifactAvailable
    ? "...[结果已截断，原文可通过产物读取]"
    : "...[结果已截断，原文产物未保存，无法回读]";
  return content.includes(commandMarker)
    ? `${commandMarker}\n${preservationMessage}`
    : preservationMessage;
}

function getTerminalStateContent(status: ToolResultMessage["status"]): string {
  return status === "completed"
    ? "Tool 已完成。"
    : status === "aborted"
      ? "Tool 已停止。"
      : "Tool 执行失败。";
}
