import { createInterface } from "node:readline";
import type {
  Agent,
  AgentEvent,
  AssistantMessage,
  PermissionMode,
  PromptResult,
} from "@anthias/agent";
import {
  type AssistantContentRenderer,
  createAssistantContentRenderer,
  detectTerminalCapabilities,
  renderAssistantContent,
  sanitizeTerminalText,
  type TerminalCapabilities,
} from "./content-renderer.js";

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
  terminalCapabilities?: TerminalCapabilities;
}>;

type TuiPresentationState = {
  activeAssistantRenderer: AssistantContentRenderer | null;
  receivedAssistantText: string;
};

const INPUT_PROMPT = "anthias> ";

/** 运行单进程行式 TUI，并在退出前中止活动请求、取消订阅和移除信号监听器。 */
export function runTui({
  agent,
  input = process.stdin,
  output = process.stdout,
  signalSource = process,
  terminalCapabilities: requestedTerminalCapabilities,
}: RunTuiOptions): Promise<number> {
  const readlineInterface = createInterface({ input, output, terminal: false });
  const terminalCapabilities = requestedTerminalCapabilities ?? detectTerminalCapabilities(output);
  const presentationState: TuiPresentationState = {
    activeAssistantRenderer: null,
    receivedAssistantText: "",
  };
  const exitCompletion = Promise.withResolvers<number>();
  let pendingPromptResultPromise: Promise<PromptResult> | null = null;
  let exitStarted = false;
  let renderQueue: Promise<void> = Promise.resolve();

  /** 所有异步内容解析与终端写入共享同一队列，AgentEvent 的源顺序不会被越过。 */
  function enqueueRender(operation: () => void | Promise<void>): Promise<void> {
    renderQueue = renderQueue.then(operation).catch(() => {
      presentationState.activeAssistantRenderer = null;
      presentationState.receivedAssistantText = "";
      output.write("内容呈现失败，已回退到下一条事件。\n");
    });
    return renderQueue;
  }

  void enqueueRender(() => renderInitialState(agent.state, output, terminalCapabilities));
  const unsubscribeFromAgentEvents = agent.subscribe((event) => {
    void enqueueRender(() =>
      renderEvent(
        event,
        output,
        presentationState,
        agent.state.workspaceRoot,
        terminalCapabilities,
      ),
    );
  });

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
      await enqueueRender(async () => {
        const remainingAssistantText = await flushActiveAssistant(presentationState);
        if (remainingAssistantText.length > 0) {
          output.write(remainingAssistantText);
          output.write("\n");
        }
      });
      unsubscribeFromAgentEvents();
      signalSource.off("SIGINT", onSigint);
      exitCompletion.resolve(0);
    }
  }

  /** 将一行终端输入转换为退出命令或 Agent prompt。 */
  async function handleLine(line: string): Promise<void> {
    await renderQueue;
    if (exitStarted) {
      return;
    }
    const trimmedLine = line.trim();
    if (trimmedLine === "/exit") {
      await requestExit();
      return;
    }
    if (trimmedLine === "/mode" || trimmedLine.startsWith("/mode ")) {
      await enqueueRender(() => {
        handleModeCommand(trimmedLine, agent, output);
        writeInputPrompt(agent.state, output);
      });
      return;
    }
    const pendingApproval = agent.state.pendingToolApproval;
    if (pendingApproval !== null) {
      const normalizedDecision = trimmedLine.toLocaleLowerCase("en-US");
      if (normalizedDecision === "y" || normalizedDecision === "yes") {
        agent.respondToToolApproval(pendingApproval.toolApprovalRequestId, "approve");
      } else if (
        normalizedDecision === "" ||
        normalizedDecision === "n" ||
        normalizedDecision === "no"
      ) {
        agent.respondToToolApproval(pendingApproval.toolApprovalRequestId, "deny");
      } else {
        await enqueueRender(() => {
          output.write("请输入 y/yes 批准，或 n/no/空行拒绝。\n");
        });
      }
      return;
    }
    if (trimmedLine.length === 0) {
      await enqueueRender(() => {
        output.write("请输入非空提示词。\n");
        writeInputPrompt(agent.state, output);
      });
      return;
    }
    if (agent.state.running) {
      await enqueueRender(() => {
        output.write("当前响应仍在生成，请先停止。\n");
        writeInputPrompt(agent.state, output);
      });
      return;
    }

    const promptResultPromise = agent.prompt(line);
    pendingPromptResultPromise = promptResultPromise;
    const promptResult = await promptResultPromise;
    if (pendingPromptResultPromise === promptResultPromise) {
      pendingPromptResultPromise = null;
    }

    await enqueueRender(() => {
      if (promptResult.status === "rejected") {
        output.write(renderPromptRejection(promptResult.reason));
      }
      if (!exitStarted) {
        writeInputPrompt(agent.state, output);
      }
    });
  }

  signalSource.on("SIGINT", onSigint);
  readlineInterface.on("line", (line) => {
    void handleLine(line);
  });
  readlineInterface.on("close", () => {
    void requestExit();
  });

  void enqueueRender(() => {
    writeInputPrompt(agent.state, output);
  });
  return exitCompletion.promise;
}

/** 将 AgentEvent 顺序映射为终端输出，不维护第二份 Agent 状态。 */
async function renderEvent(
  event: AgentEvent,
  output: NodeJS.WritableStream,
  presentationState: TuiPresentationState,
  workspaceRoot: string,
  terminalCapabilities: TerminalCapabilities,
): Promise<void> {
  switch (event.type) {
    case "run_start":
      output.write("Status: Requesting model\n");
      return;
    case "run_phase_changed":
      output.write(`Status: ${renderRunPhase(event.phase)}\n`);
      return;
    case "reasoning_start":
      output.write("Thinking: ");
      return;
    case "reasoning_update":
      output.write(sanitizeTerminalText(event.delta));
      return;
    case "reasoning_end":
      output.write("\n");
      return;
    case "permission_mode_changed":
      output.write(`Mode: ${renderPermissionMode(event.permissionMode)}\n`);
      return;
    case "message_start":
      if (event.message.role === "user") {
        output.write(`You: ${sanitizeTerminalText(event.message.content)}\n`);
      } else if (event.message.role === "assistant") {
        const unfinishedAssistantText = await flushActiveAssistant(presentationState);
        if (unfinishedAssistantText.length > 0) {
          output.write(`${unfinishedAssistantText}\n`);
        }
        output.write("Assistant: ");
        presentationState.activeAssistantRenderer = createAssistantContentRenderer({
          workspaceRoot,
          capabilities: terminalCapabilities,
        });
        presentationState.receivedAssistantText = "";
      }
      return;
    case "message_update":
      if (presentationState.activeAssistantRenderer === null) {
        output.write("Assistant: ");
        presentationState.activeAssistantRenderer = createAssistantContentRenderer({
          workspaceRoot,
          capabilities: terminalCapabilities,
        });
      }
      presentationState.receivedAssistantText += event.delta;
      output.write(await presentationState.activeAssistantRenderer.push(event.delta));
      return;
    case "message_end":
      if (event.message.role === "assistant") {
        if (presentationState.activeAssistantRenderer === null) {
          output.write("Assistant: ");
          presentationState.activeAssistantRenderer = createAssistantContentRenderer({
            workspaceRoot,
            capabilities: terminalCapabilities,
          });
        }
        const completeAssistantText = getAssistantText(event.message);
        if (completeAssistantText.startsWith(presentationState.receivedAssistantText)) {
          const missingAssistantText = completeAssistantText.slice(
            presentationState.receivedAssistantText.length,
          );
          if (missingAssistantText.length > 0) {
            presentationState.receivedAssistantText += missingAssistantText;
            output.write(
              await presentationState.activeAssistantRenderer.push(missingAssistantText),
            );
          }
        }
        output.write(await flushActiveAssistant(presentationState));
        output.write("\n");
      } else if (event.message.role === "tool") {
        output.write(
          `ToolResult: ${event.message.toolName} ${event.message.status}${event.message.truncated ? "（已截断）" : ""}\n${sanitizeTerminalText(event.message.content)}\n`,
        );
      }
      return;
    case "tool_execution_start":
      output.write(
        `Tool: ${event.activity.toolName} [${shortToolCallId(event.activity.toolCallId)}] ${sanitizeTerminalText(event.activity.summary)}\n`,
      );
      return;
    case "tool_execution_update":
      output.write(
        `[${event.toolName} ${shortToolCallId(event.toolCallId)} ${event.stream}] ${sanitizeTerminalText(event.delta)}`,
      );
      return;
    case "tool_execution_end":
      output.write(
        `Tool: ${event.toolName} [${shortToolCallId(event.toolCallId)}] end ${event.result.status}\n`,
      );
      if (event.cleanupUncertain) {
        output.write("警告：Tool 资源清理结果不确定。\n");
      }
      return;
    case "tool_approval_requested":
      output.write(
        `需要确认：${event.request.toolName}\n权限模式：${renderPermissionMode(event.request.permissionMode)}\n目标：${sanitizeTerminalText(event.request.target)}\n风险：${sanitizeTerminalText(event.request.riskSummary)}\n执行边界：${sanitizeTerminalText(event.request.executionBoundary)}\n${sanitizeTerminalText(event.request.preview)}\n允许执行？[y/N] `,
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
      {
        const unfinishedAssistantText = await flushActiveAssistant(presentationState);
        if (unfinishedAssistantText.length > 0) {
          output.write(`${unfinishedAssistantText}\n`);
        }
      }
      if (event.result.status === "failed") {
        output.write(`错误：${sanitizeTerminalText(event.result.error)}\n`);
      } else if (event.result.status === "aborted") {
        output.write("已停止当前响应。\n");
      } else {
        output.write("已完成。\n");
      }
      return;
  }
}

/** TUI 只从 AgentState 呈现重开投影，不直接读取 Session 文件。 */
async function renderInitialState(
  state: Agent["state"],
  output: NodeJS.WritableStream,
  terminalCapabilities: TerminalCapabilities,
): Promise<void> {
  output.write(`Session: ${state.sessionId}\n`);
  output.write(`Workspace: ${renderSafePath(state.workspaceRoot)}\n`);
  output.write(`Mode: ${renderPermissionMode(state.permissionMode)}\n`);
  for (const message of state.messageHistory) {
    if (message.role === "user") {
      output.write(`You: ${sanitizeTerminalText(message.content)}\n`);
    } else if (message.role === "assistant") {
      const assistantContent = await renderAssistantContent(getAssistantText(message), {
        workspaceRoot: state.workspaceRoot,
        capabilities: terminalCapabilities,
      });
      output.write(`Assistant: ${assistantContent}\n`);
    } else {
      output.write(
        `ToolResult: ${message.toolName} ${message.status}\n${sanitizeTerminalText(message.content)}\n`,
      );
    }
  }
}

/** 完成当前 Assistant Message，并立即清空瞬时 renderer 所有权。 */
async function flushActiveAssistant(presentationState: TuiPresentationState): Promise<string> {
  const activeAssistantRenderer = presentationState.activeAssistantRenderer;
  presentationState.activeAssistantRenderer = null;
  presentationState.receivedAssistantText = "";
  return activeAssistantRenderer === null ? "" : activeAssistantRenderer.finish();
}

/** 解析 TUI 自有模式命令，权限判断仍完全委托给 Agent。 */
function handleModeCommand(command: string, agent: Agent, output: NodeJS.WritableStream): void {
  const commandParts = command.split(/\s+/u);
  if (commandParts.length === 1) {
    output.write(`Mode: ${renderPermissionMode(agent.state.permissionMode)}\n`);
    return;
  }
  const requestedMode = commandParts[1];
  if (commandParts.length !== 2 || (requestedMode !== "agent" && requestedMode !== "plan")) {
    output.write("用法：/mode、/mode agent 或 /mode plan。\n");
    return;
  }
  const previousMode = agent.state.permissionMode;
  const result = agent.setPermissionMode(requestedMode);
  if (result.status === "rejected") {
    output.write("当前 Run 正在进行，不能切换权限模式。\n");
    return;
  }
  if (previousMode === result.permissionMode) {
    output.write(`Mode: ${renderPermissionMode(result.permissionMode)}\n`);
  }
}

function renderPermissionMode(permissionMode: PermissionMode): "Agent" | "Plan" {
  return permissionMode === "agent" ? "Agent" : "Plan";
}

function renderRunPhase(phase: NonNullable<Agent["state"]["activeRun"]>["phase"]): string {
  switch (phase) {
    case "requesting_model":
      return "Requesting model";
    case "awaiting_tool_approval":
      return "Awaiting tool approval";
    case "executing_tool":
      return "Executing tool";
  }
}

function shortToolCallId(toolCallId: string): string {
  return toolCallId.slice(-8);
}

/** TUI 在呈现历史时按顺序投影 Assistant 文本，不持有第二份正文。 */
function getAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/** 写出下一次终端输入提示。 */
function writeInputPrompt(state: Agent["state"], output: NodeJS.WritableStream): void {
  output.write(
    `cwd: ${renderSafePath(state.workspaceRoot)} | mode: ${renderPermissionMode(state.permissionMode)} | session: ${state.sessionId.slice(0, 8)} | status: ${state.running ? "active" : "idle"}\n`,
  );
  output.write(INPUT_PROMPT);
}

/** 路径与正文使用同一控制字符安全规则。 */
function renderSafePath(path: string): string {
  return sanitizeTerminalText(path);
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
