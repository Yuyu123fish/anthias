import { createInterface } from "node:readline";
import type { Agent, AgentEvent, PromptResult } from "@anthias/agent";

/** 抽象 TUI 所需的最小 SIGINT 订阅行为。 */
export type TuiSignalSource = Readonly<{
  on(event: "SIGINT", listener: () => void): void;
  off(event: "SIGINT", listener: () => void): void;
}>;

/** 配置 TUI 使用的 Agent、输入输出流与信号来源。 */
export type RunTuiOptions = Readonly<{
  agent: Agent;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  signalSource?: TuiSignalSource;
}>;

const INPUT_PROMPT = "anthias> ";

/** 运行单进程行式 TUI，并在退出前中止活动请求、取消订阅和移除信号监听器。 */
export function runTui({
  agent,
  input = process.stdin,
  output = process.stdout,
  signalSource = process,
}: RunTuiOptions): Promise<number> {
  const readlineInterface = createInterface({ input, output, terminal: false });
  const exitCompletion = Promise.withResolvers<number>();
  let pendingPromptResultPromise: Promise<PromptResult> | null = null;
  let exitStarted = false;

  renderInitialState(agent.state, output);
  const unsubscribeFromAgentEvents = agent.subscribe((event) => renderEvent(event, output));

  /** 运行时 Ctrl+C 只停止当前生成；空闲时 Ctrl+C 退出 TUI。 */
  const onSigint = () => {
    if (agent.state.running) {
      agent.abort();
      return;
    }
    void requestExit();
  };

  /** 统一关闭输入、等待活动 prompt 结束并释放 TUI 持有的监听器。 */
  async function requestExit(): Promise<void> {
    if (exitStarted) {
      return;
    }
    exitStarted = true;
    agent.abort();
    readlineInterface.close();

    try {
      await pendingPromptResultPromise;
    } finally {
      unsubscribeFromAgentEvents();
      signalSource.off("SIGINT", onSigint);
      exitCompletion.resolve(0);
    }
  }

  /** 将一行终端输入转换为退出命令或 Agent prompt。 */
  async function handleLine(line: string): Promise<void> {
    if (exitStarted) {
      return;
    }
    if (line.trim() === "/exit") {
      await requestExit();
      return;
    }
    const pendingApproval = agent.state.pendingToolApproval;
    if (pendingApproval !== null) {
      const normalizedDecision = line.trim().toLocaleLowerCase("en-US");
      if (normalizedDecision === "y" || normalizedDecision === "yes") {
        agent.respondToToolApproval(pendingApproval.toolApprovalRequestId, "approve");
      } else if (
        normalizedDecision === "" ||
        normalizedDecision === "n" ||
        normalizedDecision === "no"
      ) {
        agent.respondToToolApproval(pendingApproval.toolApprovalRequestId, "deny");
      } else {
        output.write("请输入 y/yes 批准，或 n/no/空行拒绝。\n");
      }
      return;
    }
    if (line.trim().length === 0) {
      output.write("请输入非空提示词。\n");
      writeInputPrompt(output);
      return;
    }
    if (agent.state.running) {
      output.write("当前响应仍在生成，请先停止。\n");
      return;
    }

    const promptResultPromise = agent.prompt(line);
    pendingPromptResultPromise = promptResultPromise;
    const promptResult = await promptResultPromise;
    if (pendingPromptResultPromise === promptResultPromise) {
      pendingPromptResultPromise = null;
    }

    if (promptResult.status === "rejected") {
      output.write(renderPromptRejection(promptResult.reason));
    }
    if (!exitStarted) {
      writeInputPrompt(output);
    }
  }

  signalSource.on("SIGINT", onSigint);
  readlineInterface.on("line", (line) => {
    void handleLine(line);
  });
  readlineInterface.on("close", () => {
    void requestExit();
  });

  writeInputPrompt(output);
  return exitCompletion.promise;
}

/** 将 AgentEvent 顺序映射为终端输出，不维护第二份 Agent 状态。 */
function renderEvent(event: AgentEvent, output: NodeJS.WritableStream): void {
  switch (event.type) {
    case "run_start":
      return;
    case "message_start":
      if (event.message.role === "user") {
        output.write(`You: ${event.message.content}\n`);
      } else if (event.message.role === "assistant") {
        output.write("Assistant: ");
      }
      return;
    case "message_update":
      output.write(event.delta);
      return;
    case "message_end":
      if (event.message.role === "assistant") {
        output.write("\n");
      } else if (event.message.role === "tool") {
        output.write(
          `ToolResult: ${event.message.toolName} ${event.message.status}${event.message.truncated ? "（已截断）" : ""}\n${event.message.content}\n`,
        );
      }
      return;
    case "tool_execution_start":
      output.write(`Tool: ${event.toolName} (${event.toolCallId})\n`);
      return;
    case "tool_execution_update":
      output.write(`[${event.stream}] ${event.delta}`);
      return;
    case "tool_execution_end":
      if (event.cleanupUncertain) {
        output.write("警告：Tool 资源清理结果不确定。\n");
      }
      return;
    case "tool_approval_requested":
      output.write(
        `需要确认：${event.request.toolName}\n目标：${event.request.target}\n${event.request.preview}\n允许执行？[y/N] `,
      );
      return;
    case "tool_approval_resolved":
      if (event.decision === "aborted") {
        output.write("确认等待已停止。\n");
      } else {
        output.write(event.decision === "approve" ? "已批准本次调用。\n" : "已拒绝本次调用。\n");
      }
      return;
    case "run_end":
      if (event.result.status === "failed") {
        output.write(`错误：${event.result.error}\n`);
      } else if (event.result.status === "aborted") {
        output.write("已停止当前响应。\n");
      } else if (event.result.status === "budget_exhausted") {
        output.write(`已达到 Run 预算：${event.result.budget}。\n`);
      } else {
        output.write("已完成。\n");
      }
      output.write(
        `Run 用量：模型请求 ${event.metrics.modelRequestCount}，ToolCall ${event.metrics.processedToolCallCount}/${event.metrics.producedToolCallCount}，活动 ${event.metrics.activeDurationMilliseconds} ms。\n`,
      );
      return;
  }
}

/** TUI 只从 AgentState 呈现重开投影，不直接读取 Session 文件。 */
function renderInitialState(state: Agent["state"], output: NodeJS.WritableStream): void {
  output.write(`Session: ${state.sessionId}\n`);
  output.write(`Workspace: ${state.workspaceRoot}\n`);
  for (const message of state.messageHistory) {
    if (message.role === "user") {
      output.write(`You: ${message.content}\n`);
    } else if (message.role === "assistant") {
      output.write(`Assistant: ${message.content}\n`);
    } else {
      output.write(`ToolResult: ${message.toolName} ${message.status}\n${message.content}\n`);
    }
  }
}

/** 写出下一次终端输入提示。 */
function writeInputPrompt(output: NodeJS.WritableStream): void {
  output.write(INPUT_PROMPT);
}

/** 将不同 prompt 拒绝原因映射为可操作且不混淆的终端文案。 */
function renderPromptRejection(
  reason: Extract<PromptResult, { status: "rejected" }>["reason"],
): string {
  switch (reason) {
    case "empty":
      return "请输入非空提示词。\n";
    case "busy":
      return "当前响应仍在生成。\n";
    case "session_busy":
      return "Session 正被其他进程使用，请稍后重试。\n";
    case "session_changed":
      return "Session 文件已发生变化，请重新打开 Session。\n";
  }
}
