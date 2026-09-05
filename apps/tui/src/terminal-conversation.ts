import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import type {
  Agent,
  AgentEvent,
  AssistantMessage,
  ContextUsage,
  PermissionMode,
  PromptResult,
  RunPhase,
  ToolApprovalRequest,
  ToolResultMessage,
} from "@anthias/agent";
import {
  type AssistantContentRenderer,
  createAssistantContentRenderer,
  detectTerminalCapabilities,
  renderAssistantContent,
  sanitizeTerminalText,
  styleTerminalText,
  type TerminalCapabilities,
  type TerminalPaletteColor,
} from "./content-renderer.js";
import {
  createReadlineOutputSink,
  createTerminalDriver,
  type DynamicTerminalFrame,
  formatVisibleInput,
  supportsInteractiveTerminalSize,
  type TerminalDriver,
  terminalTextWidth,
  wrapTerminalText,
} from "./terminal-driver.js";

/** 抽象 TUI 所需的最小 SIGINT 订阅行为。 */
export type TuiSignalSource = Readonly<{
  on(event: "SIGINT", listener: () => void): void;
  off(event: "SIGINT", listener: () => void): void;
}>;

/** 配置唯一 Terminal Conversation 入口及其可测试 seam。 */
export type RunTuiOptions = Readonly<{
  agent: Agent;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  signalSource?: TuiSignalSource;
  terminalCapabilities?: TerminalCapabilities;
  terminalDriver?: TerminalDriver;
  now?: () => number;
}>;

type VisibleReasoning = {
  runId: string;
  content: string;
  startedAt: number;
  endedAt: number | null;
  plainContentStarted: boolean;
  truncated: boolean;
};

type VisibleTool = {
  toolCallId: string;
  toolName: string;
  summary: string;
  status: ToolResultMessage["status"] | "running";
  startedAt: number;
  endedAt: number | null;
  details: string;
  truncated: boolean;
  cleanupUncertain: boolean;
};

type TuiPresentationState = {
  activeAssistantRenderer: AssistantContentRenderer | null;
  receivedAssistantText: string;
  assistantStreaming: boolean;
  assistantHeadingCommitted: boolean;
  runPhase: RunPhase | null;
  activeReasoning: VisibleReasoning | null;
  reasoningHistory: VisibleReasoning[];
  tools: Map<string, VisibleTool>;
  pendingApproval: ToolApprovalRequest | null;
  detailsVisible: boolean;
  detailPageFromEnd: number;
  compactMode: boolean;
  compactContextSignature: string | null;
};

type Keypress = Readonly<{ name?: string; ctrl?: boolean }>;
type KeypressInput = NodeJS.ReadableStream & {
  prependListener(
    event: "keypress",
    listener: (character: string | undefined, key: Keypress) => void,
  ): KeypressInput;
  off(
    event: "keypress",
    listener: (character: string | undefined, key: Keypress) => void,
  ): KeypressInput;
};

type ResizeOutput = NodeJS.WritableStream & {
  on(event: "resize", listener: () => void): ResizeOutput;
  off(event: "resize", listener: () => void): ResizeOutput;
};

const INPUT_PROMPT = "> ";
const MAX_REASONING_CHARACTERS = 128 * 1024;
const MAX_TOOL_DETAIL_CHARACTERS = 128 * 1024;
const TICK_INTERVAL_MILLISECONDS = 250;
const TOOL_STATUS_PRESENTATION = Object.freeze({
  running: Object.freeze({ label: "运行中", unicodeSymbol: "◌", asciiSymbol: "[*]" }),
  completed: Object.freeze({ label: "完成", unicodeSymbol: "✓", asciiSymbol: "[ok]" }),
  failed: Object.freeze({ label: "失败", unicodeSymbol: "✕", asciiSymbol: "[failed]" }),
  denied: Object.freeze({ label: "已拒绝", unicodeSymbol: "⊘", asciiSymbol: "[denied]" }),
  aborted: Object.freeze({ label: "已停止", unicodeSymbol: "■", asciiSymbol: "[stopped]" }),
  unknown: Object.freeze({ label: "未知结果", unicodeSymbol: "✕", asciiSymbol: "[failed]" }),
} satisfies Record<
  VisibleTool["status"],
  Readonly<{ label: string; unicodeSymbol: string; asciiSymbol: string }>
>);

/**
 * 运行 Anthias Terminal Conversation。Agent 是业务事实权威；本 Module 只持有输入、
 * 动态区域、详情、计时、渲染顺序与终端资源。
 */
export function runTui({
  agent,
  input = process.stdin,
  output = process.stdout,
  signalSource = process,
  terminalCapabilities: requestedTerminalCapabilities,
  terminalDriver: requestedTerminalDriver,
  now = () => performance.now(),
}: RunTuiOptions): Promise<number> {
  const detectedInteractive = isTty(input) && isTty(output);
  const terminalDriver =
    requestedTerminalDriver ?? createTerminalDriver({ output, interactive: detectedInteractive });
  const interactive = terminalDriver.kind === "interactive";
  const selectedTerminalCapabilities =
    requestedTerminalCapabilities ?? detectTerminalCapabilities(output);
  // plain 输出是可重定向的数据边界，即使测试或宿主误报能力也不能写出 ANSI / OSC。
  const terminalCapabilities =
    detectedInteractive && interactive
      ? selectedTerminalCapabilities
      : Object.freeze({
          colorDepth: "none" as const,
          hyperlinks: false,
          unicode: selectedTerminalCapabilities.unicode,
        });
  const readlineOutput = interactive ? createReadlineOutputSink(output) : output;
  const readlineInterface = createInterface({
    input,
    output: readlineOutput,
    terminal: interactive,
  });
  readlineInterface.setPrompt(INPUT_PROMPT);
  const presentationState: TuiPresentationState = {
    activeAssistantRenderer: null,
    receivedAssistantText: "",
    assistantStreaming: false,
    assistantHeadingCommitted: false,
    runPhase: agent.state.activeRun?.phase ?? null,
    activeReasoning: null,
    reasoningHistory: [],
    tools: new Map(),
    pendingApproval: agent.state.pendingToolApproval,
    detailsVisible: false,
    detailPageFromEnd: 0,
    compactMode: false,
    compactContextSignature: null,
  };
  const exitCompletion = Promise.withResolvers<number>();
  let pendingPromptResultPromise: Promise<PromptResult> | null = null;
  let exitStarted = false;
  let requestedExitCode = 0;
  let renderQueue: Promise<void> = Promise.resolve();
  let repaintTimer: NodeJS.Timeout | null = null;

  /** 串行提交异步内容和 frame；任何一个结果都不能越过后续 AgentEvent。 */
  function enqueueRender(operation: () => void | Promise<void>): Promise<void> {
    renderQueue = renderQueue
      .then(operation)
      .then(() => {
        synchronizeRepaintTimer();
        if (interactive && !exitStarted) {
          const dynamicFrame = createDynamicFrame(
            presentationState,
            agent.state,
            readlineInterface.line,
            readlineInterface.cursor,
            terminalDriver.width(),
            terminalDriver.height(),
            terminalCapabilities,
            now(),
          );
          synchronizeCompactContext(
            dynamicFrame,
            presentationState,
            agent.state,
            terminalDriver,
            terminalCapabilities,
          );
          terminalDriver.renderDynamic(dynamicFrame);
        }
      })
      .catch(() => {
        presentationState.activeAssistantRenderer = null;
        presentationState.receivedAssistantText = "";
        presentationState.assistantStreaming = false;
        try {
          terminalDriver.writeStable("内容呈现失败，TUI 即将安全退出。\n");
        } catch {
          // Driver 自身失败时无法再依赖终端输出，但仍必须执行资源清理。
        }
        void requestExit(1);
      });
    return renderQueue;
  }

  function synchronizeRepaintTimer(): void {
    const needsRepaint =
      interactive &&
      (presentationState.activeReasoning !== null ||
        [...presentationState.tools.values()].some((tool) => tool.status === "running"));
    if (needsRepaint && repaintTimer === null) {
      repaintTimer = setInterval(() => {
        if (!exitStarted) {
          void enqueueRender(() => undefined);
        }
      }, TICK_INTERVAL_MILLISECONDS);
      repaintTimer.unref();
    } else if (!needsRepaint && repaintTimer !== null) {
      clearInterval(repaintTimer);
      repaintTimer = null;
    }
  }

  void enqueueRender(async () => {
    await renderInitialState(agent.state, terminalDriver, terminalCapabilities);
    if (!interactive) {
      writePlainInputArea(agent.state, terminalDriver, terminalCapabilities);
    }
  });

  const unsubscribeFromAgentEvents = agent.subscribe((event) => {
    const eventTimestamp = now();
    void enqueueRender(() =>
      renderEvent(
        event,
        terminalDriver,
        presentationState,
        agent.state.workspaceRoot,
        terminalCapabilities,
        eventTimestamp,
      ),
    );
  });

  /** Run 中 Ctrl+C 请求 abort；idle 时退出，不在 TUI 内提前伪造终态。 */
  const onSigint = () => {
    if (agent.state.running) {
      agent.abort();
      return;
    }
    void requestExit();
  };

  /** Enter 前清除动态区；普通键后按 readline 的真实缓冲重绘。 */
  const onKeypress = (_character: string | undefined, key: Keypress) => {
    if (key.name === "return" || key.name === "enter") {
      terminalDriver.clearDynamic();
      return;
    }
    queueMicrotask(() => {
      if (!exitStarted) {
        void enqueueRender(() => undefined);
      }
    });
  };

  const onResize = () => {
    if (!exitStarted) {
      void enqueueRender(() => undefined);
    }
  };

  /** 等待活动 Run 和渲染队列收口，再释放 raw mode、timer、cursor 与监听器。 */
  async function requestExit(exitCode = 0): Promise<void> {
    requestedExitCode = Math.max(requestedExitCode, exitCode);
    if (exitStarted) {
      return;
    }
    exitStarted = true;
    try {
      terminalDriver.clearDynamic();
    } catch {
      requestedExitCode = 1;
    }
    try {
      agent.abort();
    } catch {
      requestedExitCode = 1;
    }
    readlineInterface.close();

    try {
      await pendingPromptResultPromise;
    } finally {
      try {
        await agent.close();
      } catch {
        requestedExitCode = 1;
      }
      await renderQueue;
      try {
        const remainingAssistantText = await flushActiveAssistant(presentationState);
        commitAssistantContent(
          terminalDriver,
          presentationState,
          remainingAssistantText,
          terminalCapabilities,
        );
      } catch {
        requestedExitCode = 1;
      }
      if (repaintTimer !== null) {
        clearInterval(repaintTimer);
        repaintTimer = null;
      }
      unsubscribeFromAgentEvents();
      signalSource.off("SIGINT", onSigint);
      readlineInterface.off("SIGINT", onSigint);
      if (interactive) {
        (input as KeypressInput).off("keypress", onKeypress);
        (output as ResizeOutput).off("resize", onResize);
        readlineOutput.end();
      }
      try {
        terminalDriver.close();
      } catch {
        requestedExitCode = 1;
      }
      exitCompletion.resolve(requestedExitCode);
    }
  }

  /** 把一行输入映射为本地详情、控制命令、approval 或 Agent prompt。 */
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
    if (trimmedLine === "/details" || trimmedLine.startsWith("/details ")) {
      await enqueueRender(() => {
        const detailsArgument = trimmedLine.slice("/details".length).trim();
        if (detailsArgument.length === 0) {
          presentationState.detailsVisible = !presentationState.detailsVisible;
          presentationState.detailPageFromEnd = 0;
          terminalDriver.writeStable(
            `${presentationState.detailsVisible ? "Details: on" : "Details: off"}\n`,
          );
        } else if (detailsArgument === "prev" || detailsArgument === "next") {
          presentationState.detailsVisible = true;
          presentationState.detailPageFromEnd =
            detailsArgument === "prev"
              ? presentationState.detailPageFromEnd + 1
              : Math.max(0, presentationState.detailPageFromEnd - 1);
          terminalDriver.writeStable(`Details: ${detailsArgument} page\n`);
        } else {
          terminalDriver.writeStable("用法：/details、/details prev 或 /details next。\n");
          return;
        }
        if (presentationState.detailsVisible && terminalDriver.kind === "plain") {
          const detailSnapshot = createDetailSnapshot(presentationState, terminalCapabilities);
          terminalDriver.writeStable(
            detailSnapshot.length > 0 ? `${detailSnapshot}\n` : "当前没有可显示的详情。\n",
          );
        }
        if (!interactive) {
          writePlainInputArea(agent.state, terminalDriver, terminalCapabilities);
        }
      });
      return;
    }
    if (trimmedLine === "/context") {
      void enqueueRender(() =>
        terminalDriver.writeStable(renderContextUsage(agent.state.contextUsage) + "\n"),
      );
      return;
    }
    if (trimmedLine === "/mode" || trimmedLine.startsWith("/mode ")) {
      await enqueueRender(() => {
        const modeResult = handleModeCommand(trimmedLine, agent);
        if (modeResult !== null) {
          terminalDriver.writeStable(modeResult);
        }
        if (!interactive) {
          writePlainInputArea(agent.state, terminalDriver, terminalCapabilities);
        }
      });
      return;
    }

    if (presentationState.compactMode) {
      await enqueueRender(() => {
        terminalDriver.writeStable("终端空间不足，已暂停提交与确认；请放大窗口后重试。\n");
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
          terminalDriver.writeStable("请输入 y/yes 批准，或 n/no/空行拒绝。\n");
          if (!interactive) {
            writePlainInputArea(agent.state, terminalDriver, terminalCapabilities);
          }
        });
      }
      return;
    }
    if (trimmedLine.length === 0) {
      await enqueueRender(() => {
        terminalDriver.writeStable("请输入非空提示词。\n");
        if (!interactive) {
          writePlainInputArea(agent.state, terminalDriver, terminalCapabilities);
        }
      });
      return;
    }
    if (agent.state.running) {
      await enqueueRender(() => {
        terminalDriver.writeStable("当前响应仍在生成；可用 Ctrl+C 停止，或 /details 查看详情。\n");
        if (!interactive) {
          writePlainInputArea(agent.state, terminalDriver, terminalCapabilities);
        }
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
        terminalDriver.writeStable(renderPromptRejection(promptResult.reason));
      }
      if (!interactive && !exitStarted) {
        writePlainInputArea(agent.state, terminalDriver, terminalCapabilities);
      }
    });
  }

  signalSource.on("SIGINT", onSigint);
  readlineInterface.on("SIGINT", onSigint);
  readlineInterface.on("line", (line) => {
    void handleLine(line);
  });
  readlineInterface.on("close", () => {
    void requestExit();
  });
  if (interactive) {
    (input as KeypressInput).prependListener("keypress", onKeypress);
    (output as ResizeOutput).on("resize", onResize);
  }

  return exitCompletion.promise;
}

function synchronizeCompactContext(
  dynamicFrame: DynamicTerminalFrame,
  presentationState: TuiPresentationState,
  agentState: Agent["state"],
  terminalDriver: TerminalDriver,
  terminalCapabilities: TerminalCapabilities,
): void {
  if (dynamicFrame.compact !== true) {
    presentationState.compactMode = false;
    presentationState.compactContextSignature = null;
    return;
  }
  presentationState.compactMode = true;
  const contextSignature = [
    agentState.workspaceRoot,
    agentState.permissionMode,
    agentState.sessionId,
    renderCurrentStatus(presentationState),
  ].join("\u0000");
  if (presentationState.compactContextSignature === contextSignature) {
    return;
  }
  presentationState.compactContextSignature = contextSignature;
  const separator = terminalCapabilities.unicode ? "│" : "|";
  terminalDriver.writeStable(
    `终端空间不足，已暂停提交与确认；请放大窗口。\ncwd: ${sanitizeTerminalText(
      agentState.workspaceRoot,
    )}\n${renderPermissionMode(agentState.permissionMode)} ${separator} ${renderCurrentStatus(
      presentationState,
    )} ${separator} Session ${agentState.sessionId.slice(0, 8)}\n`,
  );
}

/** 将一个 AgentEvent 投影到稳定 scrollback 或当前动态状态。 */
async function renderEvent(
  event: AgentEvent,
  terminalDriver: TerminalDriver,
  presentationState: TuiPresentationState,
  workspaceRoot: string,
  terminalCapabilities: TerminalCapabilities,
  eventTimestamp: number,
): Promise<void> {
  switch (event.type) {
    case "context_usage":
      if (terminalDriver.kind === "plain")
        terminalDriver.writeStable(renderContextUsage(event.usage) + "\n");
      return;
    case "compaction_start":
      terminalDriver.writeStable("正在压缩历史上下文…\n");
      return;
    case "compaction_end":
      terminalDriver.writeStable(
        `上下文压缩完成：约 ${event.inputTokensBefore} → ${event.inputTokensAfter} token，继续原任务。\n`,
      );
      return;
    case "compaction_failed":
      terminalDriver.writeStable(sanitizeTerminalText(event.error) + "\n");
      return;
    case "session_cleanup": {
      if (event.result.deleted > 0)
        terminalDriver.writeStable(
          `已清理 ${event.result.deleted} 个超过两周未使用的对话及产物。\n`,
        );
      if (event.result.status === "unavailable")
        terminalDriver.writeStable("对话清理未完成，将在下次启动时重试。\n");
      const uncertainReasons = event.result.skipReasons.filter(
        (reason) => !["近期使用", "仍有使用者", "旧对话仍在使用或未过期"].includes(reason),
      );
      if (uncertainReasons.length > 0)
        terminalDriver.writeStable(
          `对话清理已跳过：${uncertainReasons.map(sanitizeTerminalText).join("；")}。\n`,
        );
      return;
    }
    case "run_start":
      presentationState.runPhase = "requesting_model";
      presentationState.assistantHeadingCommitted = false;
      presentationState.assistantStreaming = false;
      if (terminalDriver.kind === "plain") {
        terminalDriver.writeStable(`${terminalCapabilities.unicode ? "◌" : "[*]"} 正在请求模型\n`);
      }
      return;
    case "run_phase_changed":
      presentationState.runPhase = event.phase;
      if (terminalDriver.kind === "plain") {
        terminalDriver.writeStable(`状态：${renderRunPhase(event.phase)}\n`);
      }
      return;
    case "reasoning_start": {
      const reasoning: VisibleReasoning = {
        runId: event.runId,
        content: "",
        startedAt: eventTimestamp,
        endedAt: null,
        plainContentStarted: false,
        truncated: false,
      };
      presentationState.activeReasoning = reasoning;
      presentationState.reasoningHistory.push(reasoning);
      return;
    }
    case "reasoning_update": {
      const safeDelta = sanitizeTerminalText(event.delta);
      const activeReasoning = presentationState.activeReasoning;
      if (activeReasoning === null || activeReasoning.runId !== event.runId) {
        return;
      }
      const appendResult = appendBoundedText(
        activeReasoning.content,
        safeDelta,
        MAX_REASONING_CHARACTERS,
      );
      activeReasoning.content = appendResult.text;
      activeReasoning.truncated ||= appendResult.truncated;
      if (terminalDriver.kind === "plain") {
        if (!activeReasoning.plainContentStarted) {
          terminalDriver.writeStable("思考中：");
          activeReasoning.plainContentStarted = true;
        }
        terminalDriver.writeStable(safeDelta);
      }
      return;
    }
    case "reasoning_end": {
      const activeReasoning = presentationState.activeReasoning;
      if (activeReasoning === null || activeReasoning.runId !== event.runId) {
        return;
      }
      activeReasoning.endedAt = eventTimestamp;
      presentationState.activeReasoning = null;
      if (activeReasoning.content.length > 0) {
        if (terminalDriver.kind === "plain" && !activeReasoning.content.endsWith("\n")) {
          terminalDriver.writeStable("\n");
        }
        terminalDriver.writeStable(
          `${terminalCapabilities.unicode ? "▸" : ">"} 思考了 ${formatDuration(
            activeReasoning.endedAt - activeReasoning.startedAt,
          )}\n`,
        );
      }
      return;
    }
    case "permission_mode_changed":
      terminalDriver.writeStable(`模式：${renderPermissionMode(event.permissionMode)}\n`);
      return;
    case "message_start":
      if (event.message.role === "user") {
        terminalDriver.writeStable(renderUserMessage(event.message.content, terminalCapabilities));
      } else if (event.message.role === "assistant") {
        const unfinishedAssistantText = await flushActiveAssistant(presentationState);
        commitAssistantContent(
          terminalDriver,
          presentationState,
          unfinishedAssistantText,
          terminalCapabilities,
        );
        presentationState.activeAssistantRenderer = createAssistantContentRenderer({
          workspaceRoot,
          capabilities: terminalCapabilities,
        });
        presentationState.receivedAssistantText = "";
      }
      return;
    case "message_update":
      if (presentationState.activeAssistantRenderer === null) {
        presentationState.activeAssistantRenderer = createAssistantContentRenderer({
          workspaceRoot,
          capabilities: terminalCapabilities,
        });
      }
      if (event.delta.length > 0) {
        commitAssistantHeading(terminalDriver, presentationState, terminalCapabilities);
        presentationState.assistantStreaming = true;
      }
      presentationState.receivedAssistantText += event.delta;
      commitAssistantContent(
        terminalDriver,
        presentationState,
        await presentationState.activeAssistantRenderer.push(event.delta),
        terminalCapabilities,
      );
      return;
    case "message_end":
      if (event.message.role === "assistant") {
        await renderAssistantMessageEnd(
          event.message,
          terminalDriver,
          presentationState,
          workspaceRoot,
          terminalCapabilities,
        );
      } else if (event.message.role === "tool") {
        renderToolResult(
          event.message,
          terminalDriver,
          presentationState,
          terminalCapabilities,
          eventTimestamp,
        );
      }
      return;
    case "tool_execution_start": {
      const tool: VisibleTool = {
        toolCallId: event.activity.toolCallId,
        toolName: event.activity.toolName,
        summary: sanitizeTerminalText(event.activity.summary),
        status: "running",
        startedAt: eventTimestamp,
        endedAt: null,
        details: "",
        truncated: false,
        cleanupUncertain: false,
      };
      presentationState.tools.set(tool.toolCallId, tool);
      if (terminalDriver.kind === "plain") {
        terminalDriver.writeStable(`${renderToolSummary(tool, terminalCapabilities)}\n`);
      }
      return;
    }
    case "tool_execution_update": {
      const tool = presentationState.tools.get(event.toolCallId);
      if (tool === undefined) {
        return;
      }
      const detailLine = `${tool.details.length === 0 ? "" : "\n"}[${event.stream}] ${sanitizeTerminalText(
        event.delta,
      )}`;
      const appendResult = appendBoundedText(tool.details, detailLine, MAX_TOOL_DETAIL_CHARACTERS);
      tool.details = appendResult.text;
      tool.truncated ||= appendResult.truncated;
      if (presentationState.detailsVisible && terminalDriver.kind === "plain") {
        writeStableBlock(
          terminalDriver,
          `[${shortToolCallId(tool.toolCallId)}] ${tool.toolName} ${event.stream}\n${sanitizeTerminalText(
            event.delta,
          )}`,
        );
      }
      return;
    }
    case "tool_execution_end": {
      const existingTool = presentationState.tools.get(event.toolCallId);
      const tool =
        existingTool ??
        createUnknownTool(event.toolCallId, event.toolName, event.result.status, eventTimestamp);
      tool.status = event.result.status;
      tool.endedAt = eventTimestamp;
      tool.cleanupUncertain = event.cleanupUncertain;
      presentationState.tools.set(tool.toolCallId, tool);
      terminalDriver.writeStable(`${renderToolSummary(tool, terminalCapabilities)}\n`);
      const artifactSummary = renderArtifactSummary(event.result, terminalCapabilities);
      if (artifactSummary.length > 0) terminalDriver.writeStable(`${artifactSummary}\n`);
      if (event.cleanupUncertain) {
        terminalDriver.writeStable("! Tool 资源清理结果不确定，请在继续前检查相关进程。\n");
      }
      return;
    }
    case "tool_approval_requested":
      presentationState.pendingApproval = event.request;
      // 决策依据完整进入 scrollback；动态区只保留短焦点，不能在矮窗口留下按钮却裁掉风险。
      terminalDriver.writeStable(
        `${createApprovalLines(
          event.request,
          terminalDriver.kind === "interactive"
            ? Math.max(10, terminalDriver.width() - 1)
            : terminalDriver.width(),
          terminalCapabilities,
        ).join("\n")}\n`,
      );
      return;
    case "tool_approval_resolved":
      presentationState.pendingApproval = null;
      if (terminalDriver.kind === "interactive") {
        terminalDriver.writeStable(
          `${createApprovalLines(
            event.request,
            terminalDriver.width() - 1,
            terminalCapabilities,
            renderApprovalDecision(event.decision, terminalCapabilities),
          ).join("\n")}\n`,
        );
      } else {
        terminalDriver.writeStable(
          `${renderApprovalDecision(event.decision, terminalCapabilities)}\n`,
        );
      }
      return;
    case "run_end": {
      const unfinishedAssistantText = await flushActiveAssistant(presentationState);
      commitAssistantContent(
        terminalDriver,
        presentationState,
        unfinishedAssistantText,
        terminalCapabilities,
      );
      presentationState.assistantStreaming = false;
      presentationState.runPhase = null;
      presentationState.pendingApproval = null;
      if (event.result.status === "failed") {
        terminalDriver.writeStable(
          `${terminalCapabilities.unicode ? "✕" : "[failed]"} 运行失败：${sanitizeTerminalText(
            event.result.error,
          )}\n可修改输入后重试。\n`,
        );
      } else if (event.result.status === "aborted") {
        terminalDriver.writeStable(
          `${terminalCapabilities.unicode ? "■" : "[stopped]"} 已停止当前响应，可以继续输入。\n`,
        );
      } else {
        terminalDriver.writeStable(`${terminalCapabilities.unicode ? "✓" : "[ok]"} 已完成。\n`);
      }
      return;
    }
  }
}

async function renderInitialState(
  state: Agent["state"],
  terminalDriver: TerminalDriver,
  terminalCapabilities: TerminalCapabilities,
): Promise<void> {
  terminalDriver.writeStable(`${renderBrand(terminalCapabilities)}\n`);
  terminalDriver.writeStable(`Session: ${state.sessionId}\n`);
  terminalDriver.writeStable(`Workspace: ${sanitizeTerminalText(state.workspaceRoot)}\n`);
  terminalDriver.writeStable(`Mode: ${renderPermissionMode(state.permissionMode)}\n`);
  if (state.contextUsage.compactions > 0)
    terminalDriver.writeStable(
      `已恢复压缩后的模型上下文（${state.contextUsage.compactions} 次压缩）；下方显示完整历史。\n`,
    );
  let historicalAssistantHeadingCommitted = false;
  for (const message of state.messageHistory) {
    if (message.role === "user") {
      historicalAssistantHeadingCommitted = false;
      terminalDriver.writeStable(renderUserMessage(message.content, terminalCapabilities));
    } else if (message.role === "assistant") {
      const assistantText = getAssistantText(message);
      if (assistantText.length === 0) {
        continue;
      }
      if (!historicalAssistantHeadingCommitted) {
        terminalDriver.writeStable(renderAssistantHeading(terminalCapabilities));
        historicalAssistantHeadingCommitted = true;
      }
      const assistantContent = await renderAssistantContent(assistantText, {
        workspaceRoot: state.workspaceRoot,
        capabilities: terminalCapabilities,
      });
      writeStableBlock(terminalDriver, assistantContent);
    } else {
      terminalDriver.writeStable(`${renderHistoricalToolResult(message, terminalCapabilities)}\n`);
    }
  }
}

async function renderAssistantMessageEnd(
  assistantMessage: AssistantMessage,
  terminalDriver: TerminalDriver,
  presentationState: TuiPresentationState,
  workspaceRoot: string,
  terminalCapabilities: TerminalCapabilities,
): Promise<void> {
  if (presentationState.activeAssistantRenderer === null) {
    presentationState.activeAssistantRenderer = createAssistantContentRenderer({
      workspaceRoot,
      capabilities: terminalCapabilities,
    });
  }
  const completeAssistantText = getAssistantText(assistantMessage);
  if (completeAssistantText.startsWith(presentationState.receivedAssistantText)) {
    const missingAssistantText = completeAssistantText.slice(
      presentationState.receivedAssistantText.length,
    );
    if (missingAssistantText.length > 0) {
      presentationState.receivedAssistantText += missingAssistantText;
      commitAssistantContent(
        terminalDriver,
        presentationState,
        await presentationState.activeAssistantRenderer.push(missingAssistantText),
        terminalCapabilities,
      );
    }
  }
  commitAssistantContent(
    terminalDriver,
    presentationState,
    await flushActiveAssistant(presentationState),
    terminalCapabilities,
  );
  presentationState.assistantStreaming = false;
}

function renderToolResult(
  message: ToolResultMessage,
  terminalDriver: TerminalDriver,
  presentationState: TuiPresentationState,
  terminalCapabilities: TerminalCapabilities,
  eventTimestamp: number,
): void {
  const safeContent = sanitizeTerminalText(message.content);
  let tool = presentationState.tools.get(message.toolCallId);
  if (tool === undefined) {
    tool = createUnknownTool(message.toolCallId, message.toolName, message.status, eventTimestamp);
    tool.details = `[result] ${safeContent}`;
    tool.truncated = message.truncated;
    presentationState.tools.set(tool.toolCallId, tool);
    terminalDriver.writeStable(`${renderHistoricalToolResult(message, terminalCapabilities)}\n`);
    if (presentationState.detailsVisible && terminalDriver.kind === "plain") {
      writeStableBlock(
        terminalDriver,
        `[${shortToolCallId(tool.toolCallId)}] ${tool.toolName} result\n${safeContent}`,
      );
    }
    return;
  }
  const appendResult = appendBoundedText(
    tool.details,
    `${tool.details.length === 0 ? "" : "\n"}[result] ${safeContent}`,
    MAX_TOOL_DETAIL_CHARACTERS,
  );
  tool.details = appendResult.text;
  tool.truncated ||= appendResult.truncated || message.truncated;
  if (presentationState.detailsVisible && terminalDriver.kind === "plain") {
    writeStableBlock(
      terminalDriver,
      `[${shortToolCallId(tool.toolCallId)}] ${tool.toolName} result\n${safeContent}`,
    );
  }
}

/** 完成当前 Assistant renderer，并立即释放该 Message 的瞬时所有权。 */
async function flushActiveAssistant(presentationState: TuiPresentationState): Promise<string> {
  const activeAssistantRenderer = presentationState.activeAssistantRenderer;
  presentationState.activeAssistantRenderer = null;
  presentationState.receivedAssistantText = "";
  return activeAssistantRenderer === null ? "" : activeAssistantRenderer.finish();
}

function commitAssistantContent(
  terminalDriver: TerminalDriver,
  presentationState: TuiPresentationState,
  content: string,
  terminalCapabilities: TerminalCapabilities,
): void {
  if (content.length === 0) {
    return;
  }
  commitAssistantHeading(terminalDriver, presentationState, terminalCapabilities);
  writeStableBlock(terminalDriver, content);
}

function commitAssistantHeading(
  terminalDriver: TerminalDriver,
  presentationState: TuiPresentationState,
  terminalCapabilities: TerminalCapabilities,
): void {
  if (presentationState.assistantHeadingCommitted) {
    return;
  }
  terminalDriver.writeStable(renderAssistantHeading(terminalCapabilities));
  presentationState.assistantHeadingCommitted = true;
}

function createDynamicFrame(
  presentationState: TuiPresentationState,
  agentState: Agent["state"],
  input: string,
  cursorIndex: number,
  terminalWidth: number,
  terminalHeight: number,
  terminalCapabilities: TerminalCapabilities,
  currentTime: number,
) {
  if (!supportsInteractiveTerminalSize(terminalWidth, terminalHeight)) {
    return createCompactDynamicFrame(
      input,
      cursorIndex,
      terminalWidth,
      terminalHeight,
      terminalCapabilities,
    );
  }
  const layoutWidth = Math.max(10, terminalWidth - 1);
  const lines: string[] = [];
  const assistantPreview = presentationState.activeAssistantRenderer?.preview() ?? "";
  if (presentationState.assistantStreaming && assistantPreview.length > 0) {
    if (!presentationState.assistantHeadingCommitted) {
      lines.push(renderBrand(terminalCapabilities));
    }
    const previewLines = wrapTerminalText(assistantPreview, layoutWidth);
    const recentPreviewLines = previewLines.slice(-4);
    lines.push(
      ...(previewLines.length > recentPreviewLines.length
        ? [terminalCapabilities.unicode ? "…" : "...", ...recentPreviewLines]
        : recentPreviewLines),
    );
  }
  const activeReasoning = presentationState.activeReasoning;
  if (activeReasoning !== null && activeReasoning.content.length > 0) {
    const reasoningLines = wrapTerminalText(activeReasoning.content, Math.max(8, layoutWidth - 4));
    const recentLines = reasoningLines.slice(-4);
    const visibleLines =
      reasoningLines.length > recentLines.length
        ? [terminalCapabilities.unicode ? "…" : "...", ...recentLines]
        : recentLines;
    lines.push(
      ...createBoxLines(
        `思考中 ${semanticSeparator(terminalCapabilities)} ${formatDuration(
          currentTime - activeReasoning.startedAt,
        )}`,
        visibleLines,
        layoutWidth,
        terminalCapabilities,
        "reefRose",
      ),
    );
  }

  for (const tool of presentationState.tools.values()) {
    if (tool.status !== "running") {
      continue;
    }
    const elapsed = formatDuration(currentTime - tool.startedAt);
    const rawLine = `${terminalCapabilities.unicode ? "◌" : "[*]"} [${shortToolCallId(
      tool.toolCallId,
    )}] ${tool.toolName}  ${tool.summary}  ${elapsed}`;
    const toolLines = wrapTerminalText(rawLine, layoutWidth);
    lines.push(
      ...toolLines.map((line, lineIndex) =>
        lineIndex === 0 ? styleTerminalText(line, "lagoon", terminalCapabilities) : line,
      ),
    );
  }

  const approvalLines =
    presentationState.pendingApproval === null
      ? []
      : createActiveApprovalLines(
          presentationState.pendingApproval,
          layoutWidth,
          terminalCapabilities,
        );

  const dividerCharacter = terminalCapabilities.unicode ? "─" : "-";
  const visibleInput = formatVisibleInput(
    input,
    cursorIndex,
    layoutWidth,
    INPUT_PROMPT,
    terminalCapabilities.unicode ? "…" : "...",
  );
  const footerLines = [
    styleTerminalText(
      dividerCharacter.repeat(Math.max(1, layoutWidth)),
      "reefSlate",
      terminalCapabilities,
      true,
    ),
    ...wrapTerminalText(visibleInput.line, layoutWidth),
    ...wrapTerminalText(`cwd: ${agentState.workspaceRoot}`, layoutWidth),
    ...wrapTerminalText(
      createStatusLine(presentationState, agentState, terminalCapabilities) +
        (agentState.contextUsage.inputTokens === null
          ? ""
          : ` · ${renderContextUsage(agentState.contextUsage).split("；累计")[0]}`),
      layoutWidth,
    ),
  ];
  const maximumFrameLines = Math.max(1, terminalHeight - 1);
  if (footerLines.length > maximumFrameLines) {
    return createCompactDynamicFrame(
      input,
      cursorIndex,
      terminalWidth,
      terminalHeight,
      terminalCapabilities,
    );
  }
  if (presentationState.detailsVisible) {
    // 详情本身已包含活动 Reasoning 与 Tool；打开时暂停重复活动卡，保证矮终端仍有正文。
    lines.length = 0;
    const maximumDetailLines =
      maximumFrameLines - lines.length - approvalLines.length - footerLines.length;
    if (maximumDetailLines > 0) {
      const detailPage = createDetailPageLines(
        createDetailSnapshot(presentationState, terminalCapabilities),
        layoutWidth,
        maximumDetailLines,
        presentationState.detailPageFromEnd,
        terminalCapabilities,
      );
      presentationState.detailPageFromEnd = detailPage.pageFromEnd;
      lines.push(...detailPage.lines);
    }
  }
  lines.push(...approvalLines);
  const maximumContentLines = Math.max(0, maximumFrameLines - footerLines.length);
  if (lines.length > maximumContentLines) {
    const retainedLines = maximumContentLines === 0 ? [] : lines.slice(-maximumContentLines);
    if (retainedLines.length > 0) {
      retainedLines[0] = styleTerminalText(
        terminalCapabilities.unicode ? "… 较早动态内容已省略" : "... 较早动态内容已省略",
        "reefSlate",
        terminalCapabilities,
      );
    }
    lines.splice(0, lines.length, ...retainedLines);
  }
  const inputLineIndex = lines.length + 1;
  lines.push(...footerLines);
  return Object.freeze({
    lines: Object.freeze(lines),
    inputLineIndex,
    inputColumn: visibleInput.cursorColumn,
    inputPrefix: visibleInput.cursorPrefix,
  });
}

function createCompactDynamicFrame(
  input: string,
  cursorIndex: number,
  terminalWidth: number,
  terminalHeight: number,
  terminalCapabilities: TerminalCapabilities,
) {
  const layoutWidth = Math.max(1, terminalWidth - 1);
  const maximumLines = Math.max(1, terminalHeight - 1);
  if (layoutWidth < 8) {
    return Object.freeze({
      lines: Object.freeze([""]),
      inputLineIndex: 0,
      inputColumn: 0,
      inputPrefix: "",
      compact: true,
    });
  }
  const visibleInput = formatVisibleInput(
    input,
    cursorIndex,
    layoutWidth,
    INPUT_PROMPT,
    terminalCapabilities.unicode ? "…" : ".",
  );
  const lines =
    maximumLines > 1
      ? [
          styleTerminalText(
            truncateTerminalLine(
              "终端空间不足，请放大窗口",
              layoutWidth,
              terminalCapabilities.unicode ? "…" : "...",
            ),
            "reefSlate",
            terminalCapabilities,
          ),
          visibleInput.line,
        ]
      : [visibleInput.line];
  return Object.freeze({
    lines: Object.freeze(lines),
    inputLineIndex: lines.length - 1,
    inputColumn: visibleInput.cursorColumn,
    inputPrefix: visibleInput.cursorPrefix,
    compact: true,
  });
}

function createStatusLine(
  presentationState: TuiPresentationState,
  agentState: Agent["state"],
  terminalCapabilities: TerminalCapabilities,
): string {
  const separator = terminalCapabilities.unicode ? "│" : "|";
  return `${renderPermissionMode(agentState.permissionMode)} ${separator} ${renderCurrentStatus(
    presentationState,
  )} ${separator} Session ${agentState.sessionId.slice(0, 8)} ${separator} ${
    presentationState.runPhase === null ? "Ctrl+C 退出" : "Ctrl+C 停止"
  }`;
}

function renderCurrentStatus(presentationState: TuiPresentationState): string {
  if (presentationState.pendingApproval !== null) {
    return "等待确认";
  }
  if (presentationState.activeReasoning !== null) {
    return "思考中";
  }
  if ([...presentationState.tools.values()].some((tool) => tool.status === "running")) {
    return "正在运行 Tool";
  }
  if (presentationState.assistantStreaming) {
    return "正在回答";
  }
  if (presentationState.runPhase !== null) {
    return renderRunPhase(presentationState.runPhase);
  }
  return "等待输入";
}

function createDetailSnapshot(
  presentationState: TuiPresentationState,
  terminalCapabilities: TerminalCapabilities,
): string {
  const detailSections: string[] = [];
  for (const reasoning of presentationState.reasoningHistory) {
    if (reasoning.content.length === 0) {
      continue;
    }
    const truncationNotice = reasoning.truncated
      ? `${terminalCapabilities.unicode ? "…" : "..."}较早内容已省略\n`
      : "";
    detailSections.push(
      `${createReasoningDetailHeading(reasoning, presentationState, terminalCapabilities)}\n${truncationNotice}${reasoning.content}`,
    );
  }
  for (const tool of presentationState.tools.values()) {
    const truncationNotice = tool.truncated
      ? `${terminalCapabilities.unicode ? "…" : "..."}较早输出已省略\n`
      : "";
    detailSections.push(
      `详情 ${semanticSeparator(terminalCapabilities)} [${shortToolCallId(tool.toolCallId)}] ${
        tool.toolName
      } ${semanticSeparator(terminalCapabilities)} ${renderToolStatus(
        tool.status,
      )}\n${truncationNotice}${tool.details.length > 0 ? tool.details : "（无详细输出）"}`,
    );
  }
  return detailSections.join("\n\n");
}

function createDetailPageLines(
  detailSnapshot: string,
  terminalWidth: number,
  maximumLines: number,
  requestedPageFromEnd: number,
  terminalCapabilities: TerminalCapabilities,
): Readonly<{ lines: readonly string[]; pageFromEnd: number }> {
  const detailLines = wrapTerminalText(
    detailSnapshot.length > 0 ? detailSnapshot : "当前没有可显示的详情。",
    terminalWidth,
  );
  const detailLinesPerPage = Math.max(1, maximumLines - 1);
  const pageCount = Math.max(1, Math.ceil(detailLines.length / detailLinesPerPage));
  const pageFromEnd = Math.min(Math.max(0, requestedPageFromEnd), pageCount - 1);
  const pageIndex = pageCount - pageFromEnd - 1;
  const pageStart = pageIndex * detailLinesPerPage;
  const pageLines = detailLines.slice(pageStart, pageStart + detailLinesPerPage);
  const pageLabel = truncateTerminalLine(
    `详情 ${pageIndex + 1}/${pageCount} ${semanticSeparator(
      terminalCapabilities,
    )} /details prev|next`,
    terminalWidth,
    terminalCapabilities.unicode ? "…" : "...",
  );
  const lines = [styleTerminalText(pageLabel, "reefSlate", terminalCapabilities)];
  if (maximumLines > 1) {
    lines.push(...pageLines);
  }
  return Object.freeze({ lines: Object.freeze(lines), pageFromEnd });
}

function createReasoningDetailHeading(
  reasoning: VisibleReasoning,
  presentationState: TuiPresentationState,
  terminalCapabilities: TerminalCapabilities,
): string {
  const spanNumber = presentationState.reasoningHistory.indexOf(reasoning) + 1;
  return `详情 ${semanticSeparator(terminalCapabilities)} Reasoning ${spanNumber} [${shortToolCallId(
    reasoning.runId,
  )}]`;
}

function createApprovalLines(
  request: ToolApprovalRequest,
  terminalWidth: number,
  terminalCapabilities: TerminalCapabilities,
  resolvedDecision?: string,
): readonly string[] {
  const body = [
    `Tool: ${request.toolName}`,
    `调用: [${shortToolCallId(request.toolCallId)}]`,
    `权限模式: ${renderPermissionMode(request.permissionMode)}`,
    `目标: ${sanitizeTerminalText(request.target)}`,
    `风险: ${sanitizeTerminalText(request.riskSummary)}`,
    `边界: ${sanitizeTerminalText(request.executionBoundary)}`,
    sanitizeTerminalText(request.preview),
    resolvedDecision ?? "[y] 允许一次    [n] 拒绝",
  ];
  return createBoxLines(
    resolvedDecision === undefined ? "需要确认" : "确认结果",
    body,
    terminalWidth,
    terminalCapabilities,
    "finViolet",
  );
}

function createBoxLines(
  title: string,
  body: readonly string[],
  terminalWidth: number,
  terminalCapabilities: TerminalCapabilities,
  color: TerminalPaletteColor,
): readonly string[] {
  const width = Math.max(10, terminalWidth);
  const innerWidth = Math.max(1, width - 4);
  const horizontal = terminalCapabilities.unicode ? "─" : "-";
  const topLeft = terminalCapabilities.unicode ? "╭" : "+";
  const topRight = terminalCapabilities.unicode ? "╮" : "+";
  const bottomLeft = terminalCapabilities.unicode ? "╰" : "+";
  const bottomRight = terminalCapabilities.unicode ? "╯" : "+";
  const vertical = terminalCapabilities.unicode ? "│" : "|";
  const visibleTitle = truncateTerminalLine(
    title,
    Math.max(1, width - 5),
    terminalCapabilities.unicode ? "…" : "...",
  );
  const titlePrefix = `${topLeft}${horizontal} ${visibleTitle} `;
  const titleFill = horizontal.repeat(
    Math.max(0, width - terminalTextWidth(titlePrefix) - terminalTextWidth(topRight)),
  );
  const lines = [
    styleTerminalText(`${titlePrefix}${titleFill}${topRight}`, color, terminalCapabilities),
  ];
  for (const bodyLine of body) {
    for (const wrappedLine of wrapTerminalText(bodyLine, innerWidth)) {
      lines.push(`${vertical} ${padTerminalLine(wrappedLine, innerWidth)} ${vertical}`);
    }
  }
  lines.push(
    styleTerminalText(
      `${bottomLeft}${horizontal.repeat(Math.max(1, width - 2))}${bottomRight}`,
      color,
      terminalCapabilities,
    ),
  );
  return Object.freeze(lines);
}

function createActiveApprovalLines(
  request: ToolApprovalRequest,
  terminalWidth: number,
  terminalCapabilities: TerminalCapabilities,
): readonly string[] {
  const heading = truncateTerminalLine(
    `等待确认 [${shortToolCallId(request.toolCallId)}] ${request.toolName}`,
    terminalWidth,
    terminalCapabilities.unicode ? "…" : "...",
  );
  return Object.freeze([
    styleTerminalText(heading, "finViolet", terminalCapabilities),
    ...wrapTerminalText("[y] 允许一次 / [n] 拒绝", terminalWidth),
  ]);
}

function padTerminalLine(line: string, width: number): string {
  return `${line}${" ".repeat(Math.max(0, width - terminalTextWidth(line)))}`;
}

function truncateTerminalLine(value: string, maximumWidth: number, marker: string): string {
  const safeValue = sanitizeTerminalText(value);
  if (terminalTextWidth(safeValue) <= maximumWidth) {
    return safeValue;
  }
  const markerWidth = terminalTextWidth(marker);
  const head = wrapTerminalText(safeValue, Math.max(1, maximumWidth - markerWidth))[0] ?? "";
  return `${head}${marker}`;
}

function writePlainInputArea(
  state: Agent["state"],
  terminalDriver: TerminalDriver,
  terminalCapabilities: TerminalCapabilities,
): void {
  const separator = terminalCapabilities.unicode ? "─" : "-";
  terminalDriver.writeStable(`${separator.repeat(32)}\n`);
  terminalDriver.writeStable(`${INPUT_PROMPT}\n`);
  terminalDriver.writeStable(`cwd: ${sanitizeTerminalText(state.workspaceRoot)}\n`);
  terminalDriver.writeStable(
    `${renderPermissionMode(state.permissionMode)} ${terminalCapabilities.unicode ? "│" : "|"} ${
      state.running ? "运行中" : "等待输入"
    } ${terminalCapabilities.unicode ? "│" : "|"} Session ${state.sessionId.slice(0, 8)}\n`,
  );
}

function renderUserMessage(content: string, capabilities: TerminalCapabilities): string {
  return `\n${styleTerminalText("You", "finViolet", capabilities)}\n${indentContent(
    sanitizeTerminalText(content),
  )}\n`;
}

function renderAssistantHeading(capabilities: TerminalCapabilities): string {
  return `\n${renderBrand(capabilities)}\n`;
}

function renderBrand(capabilities: TerminalCapabilities): string {
  const icon = capabilities.unicode ? "><°>" : "><o>";
  return `${styleTerminalText(icon, "anthiasCoral", capabilities)} ${styleTerminalText(
    "Anthias",
    "reefRose",
    capabilities,
  )}`;
}

function indentContent(content: string): string {
  return content
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function writeStableBlock(terminalDriver: TerminalDriver, content: string): void {
  if (content.length === 0) {
    return;
  }
  terminalDriver.writeStable(`${content}${content.endsWith("\n") ? "" : "\n"}`);
}

function renderToolSummary(tool: VisibleTool, terminalCapabilities: TerminalCapabilities): string {
  const duration =
    tool.endedAt === null ? "" : `  ${formatDuration(tool.endedAt - tool.startedAt)}`;
  return `${renderToolSymbol(tool, terminalCapabilities)} [${shortToolCallId(tool.toolCallId)}] ${
    tool.toolName
  }  ${tool.summary}${duration}`;
}

function renderToolSymbol(tool: VisibleTool, terminalCapabilities: TerminalCapabilities): string {
  if (tool.cleanupUncertain) {
    return terminalCapabilities.unicode ? "!" : "[!]";
  }
  const presentation = TOOL_STATUS_PRESENTATION[tool.status];
  return terminalCapabilities.unicode ? presentation.unicodeSymbol : presentation.asciiSymbol;
}

function renderHistoricalToolResult(
  message: ToolResultMessage,
  terminalCapabilities: TerminalCapabilities,
): string {
  const tool = createUnknownTool(message.toolCallId, message.toolName, message.status, 0);
  tool.truncated = message.truncated;
  return `${renderToolSymbol(tool, terminalCapabilities)} [${shortToolCallId(
    message.toolCallId,
  )}] ${message.toolName}  ${renderToolStatus(message.status)}${
    message.truncated
      ? ` ${semanticSeparator(terminalCapabilities)} ${message.artifact === undefined ? "已截断" : "预览已压缩"}`
      : ""
  }${message.artifact === undefined ? "" : `\n${renderArtifactSummary(message, terminalCapabilities)}`}`;
}

function createUnknownTool(
  toolCallId: string,
  toolName: string,
  status: VisibleTool["status"],
  timestamp: number,
): VisibleTool {
  return {
    toolCallId,
    toolName,
    summary: renderToolStatus(status),
    status,
    startedAt: timestamp,
    endedAt: timestamp,
    details: "",
    truncated: false,
    cleanupUncertain: false,
  };
}

function renderToolStatus(status: VisibleTool["status"]): string {
  return TOOL_STATUS_PRESENTATION[status].label;
}

function renderApprovalDecision(
  decision: "approve" | "deny" | "aborted",
  terminalCapabilities: TerminalCapabilities,
): string {
  switch (decision) {
    case "approve":
      return `${terminalCapabilities.unicode ? "✓" : "[ok]"} 已批准本次调用。`;
    case "deny":
      return `${terminalCapabilities.unicode ? "⊘" : "[denied]"} 已拒绝本次调用。`;
    case "aborted":
      return `${terminalCapabilities.unicode ? "■" : "[stopped]"} 确认等待已停止。`;
  }
}

function shortToolCallId(toolCallId: string): string {
  return sanitizeTerminalText(toolCallId).slice(-8);
}

function semanticSeparator(terminalCapabilities: TerminalCapabilities): "·" | "-" {
  return terminalCapabilities.unicode ? "·" : "-";
}

function appendBoundedText(
  previous: string,
  delta: string,
  maximumCharacters: number,
): Readonly<{ text: string; truncated: boolean }> {
  const combined = `${previous}${delta}`;
  if (combined.length <= maximumCharacters) {
    return Object.freeze({ text: combined, truncated: false });
  }
  let sliceStart = combined.length - maximumCharacters;
  const firstCodeUnit = combined.charCodeAt(sliceStart);
  const previousCodeUnit = combined.charCodeAt(sliceStart - 1);
  if (
    firstCodeUnit >= 0xdc00 &&
    firstCodeUnit <= 0xdfff &&
    previousCodeUnit >= 0xd800 &&
    previousCodeUnit <= 0xdbff
  ) {
    sliceStart += 1;
  }
  return Object.freeze({ text: combined.slice(sliceStart), truncated: true });
}

function formatDuration(milliseconds: number): string {
  return `${Math.max(0, milliseconds / 1_000).toFixed(1)} s`;
}

function handleModeCommand(command: string, agent: Agent): string | null {
  const commandParts = command.split(/\s+/u);
  if (commandParts.length === 1) {
    return `Mode: ${renderPermissionMode(agent.state.permissionMode)}\n`;
  }
  const requestedMode = commandParts[1];
  if (commandParts.length !== 2 || (requestedMode !== "agent" && requestedMode !== "plan")) {
    return "用法：/mode、/mode agent 或 /mode plan。\n";
  }
  const previousMode = agent.state.permissionMode;
  const result = agent.setPermissionMode(requestedMode);
  if (result.status === "rejected") {
    return "当前 Run 正在进行，不能切换权限模式。\n";
  }
  return previousMode === result.permissionMode
    ? `Mode: ${renderPermissionMode(result.permissionMode)}\n`
    : null;
}

function renderPermissionMode(permissionMode: PermissionMode): "Agent" | "Plan" {
  return permissionMode === "agent" ? "Agent" : "Plan";
}

function renderContextUsage(usage: ContextUsage): string {
  const input =
    usage.inputTokens === null
      ? "未知"
      : `${usage.source === "estimated" ? "约 " : ""}${usage.inputTokens}`;
  const requests = (["response", "compaction", "approval"] as const).map((purpose) => {
    const total = usage.requests[purpose];
    return `${purpose}: ${total.requests} 次/${total.inputTokens ?? "未知"} 入/${total.outputTokens ?? "未知"} 出`;
  });
  return `上下文 ${input}/${usage.contextWindow} token；累计 ${requests.join("，")}`;
}

function renderRunPhase(phase: RunPhase): string {
  switch (phase) {
    case "requesting_model":
      return "正在请求模型";
    case "compacting":
      return "正在压缩上下文";
    case "awaiting_tool_approval":
      return "等待确认";
    case "executing_tool":
      return "正在运行 Tool";
  }
}

function getAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function renderPromptRejection(
  reason: Extract<PromptResult, { status: "rejected" }>["reason"],
): string {
  switch (reason) {
    case "closed":
      return "Agent 已关闭。\n";
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

function isTty(stream: NodeJS.ReadableStream | NodeJS.WritableStream): boolean {
  return (stream as { isTTY?: boolean }).isTTY === true;
}

function renderArtifactSummary(
  message: ToolResultMessage,
  capabilities: TerminalCapabilities,
): string {
  const artifact = message.artifact;
  if (artifact === undefined) return "";
  const separator = semanticSeparator(capabilities);
  return `原文产物 ${sanitizeTerminalText(artifact.artifactId)} ${separator} ${artifact.byteLength} bytes ${separator} ${artifact.complete ? "完整" : "部分保存"}`;
}
