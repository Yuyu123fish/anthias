import type {
  Agent,
  AgentEvent,
  AssistantMessage,
  Message,
  ToolApprovalRequest,
} from "@anthias/agent";
import {
  type Component,
  Container,
  Editor,
  HStack,
  Key,
  matchesKey,
  ScrollView,
  type Terminal,
  Text,
  TuiAltScreen,
  truncateToWidth,
  VStack,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { createCommandAutocomplete } from "./command.js";
import { createMarkdownContent, type MarkdownContent } from "./content/markdown.js";
import {
  type CodeHighlighter,
  sanitizeTerminalText,
  type TerminalCapabilities,
} from "./content-renderer.js";
import { createTheme } from "./theme.js";

export type ConversationView = Readonly<{
  start(): void;
  event(event: AgentEvent): void;
  notice(text: string): void;
  details(direction?: "prev" | "next"): void;
  canApprove(): boolean;
  close(): Promise<void>;
}>;

type Detail = {
  id: string;
  title: string;
  content: string;
  truncated: boolean;
  startedAt: number;
  endedAt?: number;
};

/** 长期保留布局、消息组件和滚动容器；AgentEvent 只更新发生变化的内容。 */
export function createConversationView(options: {
  agent: Agent;
  terminal: Terminal;
  capabilities: TerminalCapabilities;
  submit(text: string): void;
  interrupt(): void;
  exit(): void;
  failure(): void;
  now?: () => number;
  codeHighlighter?: CodeHighlighter;
}): ConversationView {
  const { agent, capabilities } = options;
  const now = options.now ?? Date.now;
  const theme = createTheme(capabilities);
  let closed = false;
  let started = false;
  let detailsVisible = false;
  let selectedDetail = 0;
  let submittedEditorText: string | undefined;
  let approval: ToolApprovalRequest | null = agent.state.pendingToolApproval;
  let approvalUnrenderable = false;
  let activeAssistant: MarkdownContent | undefined;
  let activeReasoning: Detail | undefined;
  let activeReasoningLabel: Text | undefined;
  const details: Detail[] = [];
  const toolDetails = new Map<string, Detail>();
  const toolLabels = new Map<string, Text>();
  const markdownContents = new Set<MarkdownContent>();
  const conversation = new Container();
  const detailText = new Text("当前没有详情。", 1, 0);
  const detailHeading = new Text("", 1, 0);
  const conversationScroll = new ScrollView(conversation, {
    follow: "end",
    primary: true,
    scrollbar: "auto",
    scrollbarStyle: theme.muted,
  });
  let detailContentHeight = 0;
  let renderedApprovalId: string | undefined;
  let renderedTerminalColumns = 0;
  let renderedTerminalRows = 0;
  const detailDocument: Component = {
    invalidate() {
      detailText.invalidate();
    },
    render(width) {
      const lines = detailText.render(width);
      detailContentHeight = lines.length;
      renderedApprovalId = approval?.toolApprovalRequestId;
      renderedTerminalColumns = options.terminal.columns;
      renderedTerminalRows = options.terminal.rows;
      return lines;
    },
  };
  const detailScroll = new ScrollView(detailDocument, {
    follow: "none",
    scrollbar: "always",
    scrollbarStyle: theme.muted,
  });
  const terminal: Terminal = {
    get columns() {
      return options.terminal.columns;
    },
    get rows() {
      return options.terminal.rows;
    },
    get kittyProtocolActive() {
      return options.terminal.kittyProtocolActive;
    },
    start(onInput, onResize) {
      options.terminal.start(
        (data) => {
          if (!handleInput(data)) onInput(data);
        },
        () => {
          if (approval !== null) updateDetails();
          onResize();
        },
      );
    },
    stop() {
      options.terminal.stop();
    },
    drainInput: (...args) => options.terminal.drainInput(...args),
    write(data) {
      try {
        options.terminal.write(data);
      } catch {
        options.failure();
      }
    },
    moveBy: (lines) => options.terminal.moveBy(lines),
    hideCursor: () => options.terminal.hideCursor(),
    showCursor: () => options.terminal.showCursor(),
    clearLine: () => options.terminal.clearLine(),
    clearFromCursor: () => options.terminal.clearFromCursor(),
    clearScreen: () => options.terminal.clearScreen(),
    setTitle: (title) => options.terminal.setTitle(title),
    setProgress: (active) => options.terminal.setProgress(active),
  };
  const tui = new TuiAltScreen(terminal, true, undefined, { wheelScrollLines: 3 });
  const editor = new Editor(tui, theme.editor, { paddingX: 1, autocompleteMaxVisible: 5 });
  editor.onSubmit = (text) => {
    // Editor 默认 trim 提交值；在按键进入组件前保留用户实际看到的完整文本。
    const promptText = submittedEditorText ?? text;
    submittedEditorText = undefined;
    editor.addToHistory(promptText);
    options.submit(promptText);
  };
  editor.onChange = () => requestRender();
  editor.setAutocompleteProvider(createCommandAutocomplete(agent));
  const header: Component = {
    invalidate() {},
    render(width) {
      return [
        truncateToWidth(
          theme.coral("><> Anthias") +
            theme.muted(`  Session ${sanitizeTerminalText(agent.state.sessionId.slice(0, 8))}`),
          width,
        ),
        ...wrapTextWithAnsi(
          theme.muted(`Workspace: ${sanitizeTerminalText(agent.state.workspaceRoot)}`),
          width,
        ),
      ];
    },
  };
  const status: Component = {
    invalidate() {},
    render(width) {
      const state = agent.state;
      const phase = approval
        ? "等待确认"
        : state.operation === "compacting"
          ? "压缩中"
          : state.operation === "switching_session"
            ? "切换会话"
            : state.operation === "updating_capabilities"
              ? "更新外部能力"
              : activeReasoning
                ? "思考中"
                : state.activeAssistantMessage
                  ? "正在回答"
                  : state.activeRun?.phase === "reviewing_tool"
                    ? "自动审批"
                    : state.activeRun?.phase === "executing_tool"
                      ? "Tool 运行中"
                      : state.running
                        ? "请求模型中"
                        : "等待输入";
      const usage = state.contextUsage;
      const contextText =
        usage.inputTokens === null
          ? "context 未知"
          : `context ${Math.round((100 * usage.inputTokens) / usage.contextWindow)}%`;
      const scrollText = !conversationScroll.isFollowingEnd ? " · 阅读历史 · Ctrl+End 跟随" : "";
      const detailHint = detailsVisible ? " · Ctrl+T 关闭详情" : " · / 命令 · Ctrl+T 详情";
      return [
        truncateToWidth(
          theme.muted(
            `${state.permissionMode} · ${phase} · ${contextText}${scrollText}${detailHint}`,
          ),
          width,
        ),
      ];
    },
  };
  const detailPanel = new VStack([
    { component: detailHeading, shrink: 0 },
    { component: detailScroll, grow: 1, minSize: 0 },
  ]);
  const body = new HStack(
    [
      {
        component: conversationScroll,
        grow: 1,
        minSize: 0,
        visible: (viewport) => !detailsVisible || viewport.width >= 100,
      },
      { component: detailPanel, basis: 42, grow: 1, minSize: 0, visible: () => detailsVisible },
    ],
    { gap: 1 },
  );
  const layout = new VStack([
    { component: header, shrink: 0 },
    { component: body, grow: 1, minSize: 1 },
    { component: editor, shrink: 1, minSize: 3, maxSize: 12 },
    { component: status, shrink: 0 },
  ]);
  const compactTerminal = new Text("终端空间不足，请放大窗口。", 0, 0);
  const root = new VStack([
    {
      component: layout,
      grow: 1,
      minSize: 0,
      visible: (viewport) => hasLayoutSpace(viewport.width, viewport.height),
    },
    {
      component: compactTerminal,
      visible: (viewport) => !hasLayoutSpace(viewport.width, viewport.height),
    },
  ]);
  // pi 的定时绘制在回调中运行；叶组件失败也必须回到 TUI 的统一资源收口。
  for (const component of [header, status, editor, detailDocument, conversation, compactTerminal]) {
    const render = component.render.bind(component);
    component.render = (width) => {
      try {
        return render(width).map((line) => truncateToWidth(line, Math.max(1, width), ""));
      } catch {
        options.failure();
        return [];
      }
    };
  }
  tui.setLayoutRoot(root);
  tui.setFocus(editor);

  function hasLayoutSpace(width: number, height: number): boolean {
    return (
      width >= 20 &&
      height >= 8 &&
      wrapTextWithAnsi(`Workspace: ${sanitizeTerminalText(agent.state.workspaceRoot)}`, width)
        .length +
        6 <=
        height
    );
  }
  function requestRender(): void {
    if (!closed) tui.requestRender();
  }
  function newMarkdown(text: string): MarkdownContent {
    const content = createMarkdownContent({
      workspaceRoot: agent.state.workspaceRoot,
      capabilities,
      requestRender,
      ...(options.codeHighlighter === undefined
        ? {}
        : { codeHighlighter: options.codeHighlighter }),
    });
    content.setText(text);
    markdownContents.add(content);
    return content;
  }
  function appendText(
    title: string,
    text: string,
    color: "coral" | "muted" | "lagoon" = "muted",
  ): void {
    conversation.addChild(new Text(theme[color](sanitizeTerminalText(title)), 1, 1));
    conversation.addChild(new Text(sanitizeTerminalText(text), 1, 0));
  }
  function appendMessage(message: Message): void {
    if (message.role === "user") appendText("You", message.content, "coral");
    else if (message.role === "assistant") {
      conversation.addChild(new Text(theme.coral("><> Anthias"), 1, 1));
      const content = newMarkdown(assistantText(message));
      conversation.addChild(content);
      if (message.status === "streaming") activeAssistant = content;
    } else
      completeTool(
        message.toolCallId,
        message.toolName,
        message.status,
        message.content,
        message.truncated,
      );
  }
  function resetConversation(): void {
    for (const content of markdownContents) content.close();
    markdownContents.clear();
    conversation.clear();
    details.length = 0;
    toolDetails.clear();
    toolLabels.clear();
    activeAssistant = undefined;
    activeReasoning = undefined;
    activeReasoningLabel = undefined;
    approval = agent.state.pendingToolApproval;
    detailsVisible = approval !== null;
    for (const message of agent.state.messageHistory) appendMessage(message);
    if (agent.state.activeAssistantMessage !== null)
      appendMessage(agent.state.activeAssistantMessage);
    if (agent.state.messageHistory.length === 0)
      appendText("开始工作", "描述你的任务，或输入 / 查看命令。", "muted");
    conversationScroll.scrollToEnd();
    updateDetails();
  }
  function updateDetails(resetScroll = false): void {
    if (approval !== null) {
      const text = formatApproval(approval);
      approvalUnrenderable =
        !isApprovalDisplayable(approval) || terminal.columns < 20 || terminal.rows < 8;
      detailHeading.setText(theme.coral("执行确认 · PageDown 浏览"));
      detailText.setText(
        approvalUnrenderable
          ? "终端空间不足或审批内容无法完整呈现，无法安全确认。请放大窗口或输入 deny。"
          : text,
      );
    } else {
      selectedDetail = Math.max(0, Math.min(selectedDetail, details.length - 1));
      const selected = details[selectedDetail];
      detailHeading.setText(
        theme.lagoon(
          `详情 ${details.length ? selectedDetail + 1 : 0}/${details.length} · /details prev|next`,
        ),
      );
      detailText.setText(
        selected === undefined
          ? "当前没有可显示的详情。"
          : `${selected.title}${selected.endedAt === undefined ? "" : ` · ${((selected.endedAt - selected.startedAt) / 1000).toFixed(1)}s`}\n${selected.truncated ? "[较早详情已省略]\n" : ""}${selected.content || "（等待内容）"}`,
      );
    }
    if (resetScroll) detailScroll.scrollToStart();
    requestRender();
  }
  function appendDetail(detail: Detail, delta: string): void {
    const next = detail.content + sanitizeTerminalText(delta);
    detail.truncated ||= next.length > 128 * 1024;
    detail.content = next.slice(-128 * 1024);
  }
  function completeTool(
    id: string,
    name: string,
    status: string,
    content: string,
    truncated: boolean,
  ): void {
    let detail = toolDetails.get(id);
    if (detail === undefined) {
      detail = {
        id,
        title: sanitizeTerminalText(`${name} [${id.slice(-8)}]`),
        content: "",
        truncated: false,
        startedAt: now(),
      };
      details.push(detail);
      toolDetails.set(id, detail);
    }
    if (detail.endedAt === undefined) {
      appendDetail(detail, `\n[result] ${content}`);
      detail.truncated ||= truncated;
      detail.endedAt = now();
    }
    let label = toolLabels.get(id);
    if (label === undefined) {
      label = new Text("", 1, 1);
      conversation.addChild(label);
      toolLabels.set(id, label);
    }
    label.setText(theme.lagoon(sanitizeTerminalText(`${name} [${id.slice(-8)}] · ${status}`)));
  }
  function handleInput(data: string): boolean {
    if (closed) return true;
    if (matchesKey(data, Key.ctrl("c"))) {
      options.interrupt();
      return true;
    }
    if (matchesKey(data, Key.ctrl("d")) && editor.getText().length === 0) {
      options.exit();
      return true;
    }
    if (matchesKey(data, Key.ctrl("t"))) {
      toggleDetails();
      return true;
    }
    if (
      matchesKey(data, Key.escape) &&
      detailsVisible &&
      approval === null &&
      !editor.isShowingAutocomplete()
    ) {
      detailsVisible = false;
      requestRender();
      return true;
    }
    const scroll = detailsVisible ? detailScroll : conversationScroll;
    if (matchesKey(data, Key.pageUp)) {
      scroll.scrollBy(-Math.max(1, scroll.viewportHeight - 2));
      requestRender();
      return true;
    }
    if (matchesKey(data, Key.pageDown)) {
      scroll.scrollBy(Math.max(1, scroll.viewportHeight - 2));
      requestRender();
      return true;
    }
    if (matchesKey(data, Key.ctrl("home"))) {
      scroll.scrollToStart();
      requestRender();
      return true;
    }
    if (matchesKey(data, Key.ctrl("end"))) {
      scroll.scrollToEnd();
      requestRender();
      return true;
    }
    if (matchesKey(data, Key.enter)) {
      const inputText = editor.getExpandedText();
      const safeExitInput =
        inputText.trim() === "/exit" ||
        (approval !== null && inputText.trim().toLowerCase() === "deny");
      if (!hasLayoutSpace(terminal.columns, terminal.rows) && !safeExitInput) return true;
      submittedEditorText = inputText;
    }
    return false;
  }
  function toggleDetails(direction?: "prev" | "next"): void {
    if (direction === undefined) detailsVisible = approval !== null || !detailsVisible;
    else {
      detailsVisible = true;
      selectedDetail = Math.max(
        0,
        Math.min(details.length - 1, selectedDetail + (direction === "prev" ? -1 : 1)),
      );
    }
    updateDetails(true);
  }
  resetConversation();

  return {
    start() {
      if (!started) {
        started = true;
        tui.start();
      }
    },
    event(event) {
      if (closed) return;
      switch (event.type) {
        case "session_changed":
          resetConversation();
          editor.setAutocompleteProvider(createCommandAutocomplete(agent));
          break;
        case "skills_changed":
        case "mcp_changed":
          editor.setAutocompleteProvider(createCommandAutocomplete(agent));
          break;
        case "message_start":
          appendMessage(event.message);
          break;
        case "message_update":
          if (activeAssistant === undefined) appendMessage(event.message);
          else activeAssistant.setText(assistantText(event.message));
          break;
        case "message_end":
          if (event.message.role === "assistant") {
            activeAssistant?.setText(assistantText(event.message));
            activeAssistant = undefined;
          } else if (event.message.role === "tool")
            completeTool(
              event.message.toolCallId,
              event.message.toolName,
              event.message.status,
              event.message.content,
              event.message.truncated,
            );
          break;
        case "reasoning_start": {
          activeReasoning = {
            id: `reasoning:${event.runId}:${details.length}`,
            title: "Reasoning",
            content: "",
            truncated: false,
            startedAt: now(),
          };
          details.push(activeReasoning);
          activeReasoningLabel = new Text(theme.muted("Reasoning · 思考中"), 1, 1);
          conversation.addChild(activeReasoningLabel);
          if (!detailsVisible) selectedDetail = details.length - 1;
          break;
        }
        case "reasoning_update":
          if (activeReasoning !== undefined) {
            appendDetail(activeReasoning, event.delta);
            const preview = activeReasoning.content.slice(-320).split("\n").slice(-3).join("\n");
            activeReasoningLabel?.setText(
              theme.muted(
                `Reasoning · ${((now() - activeReasoning.startedAt) / 1000).toFixed(1)}s\n${preview}`,
              ),
            );
          }
          break;
        case "reasoning_end":
          if (activeReasoning !== undefined) {
            activeReasoning.endedAt = now();
            activeReasoningLabel?.setText(
              theme.muted(
                `Reasoning · 已思考 ${((activeReasoning.endedAt - activeReasoning.startedAt) / 1000).toFixed(1)}s · Ctrl+T 查看详情`,
              ),
            );
            activeReasoning = undefined;
            activeReasoningLabel = undefined;
          }
          break;
        case "tool_execution_start": {
          const { activity } = event;
          const detail: Detail = {
            id: activity.toolCallId,
            title: sanitizeTerminalText(`${activity.toolName} [${activity.toolCallId.slice(-8)}]`),
            content: sanitizeTerminalText(activity.summary),
            truncated: false,
            startedAt: now(),
          };
          details.push(detail);
          toolDetails.set(activity.toolCallId, detail);
          const label = new Text(theme.lagoon(`${detail.title} · 运行中\n${detail.content}`), 1, 1);
          toolLabels.set(activity.toolCallId, label);
          conversation.addChild(label);
          if (!detailsVisible) selectedDetail = details.length - 1;
          break;
        }
        case "tool_execution_update": {
          const detail = toolDetails.get(event.toolCallId);
          if (detail !== undefined) appendDetail(detail, `\n[${event.stream}] ${event.delta}`);
          break;
        }
        case "tool_execution_end":
          completeTool(
            event.toolCallId,
            event.toolName,
            event.result.status,
            event.result.content,
            event.result.truncated,
          );
          if (event.cleanupUncertain)
            appendText("资源状态", "Tool 资源清理结果不确定，请查看详情。");
          break;
        case "tool_approval_requested":
          approval = event.request;
          detailsVisible = true;
          updateDetails(true);
          break;
        case "tool_approval_resolved":
          approval = null;
          appendText("执行确认", event.decision);
          break;
        case "tool_authorization":
          appendText(`授权 · ${event.source} · ${event.decision}`, event.reason);
          break;
        case "compaction_start":
          appendText("Context", "正在压缩上下文，完整历史会保留。");
          break;
        case "compaction_end":
          appendText(
            "Context",
            `压缩完成 ${event.inputTokensBefore} → ${event.inputTokensAfter} tokens`,
          );
          break;
        case "compaction_failed":
          appendText("Context", event.error);
          break;
        case "run_end":
          if (event.result.status === "failed") appendText("运行失败", event.result.error);
          else if (event.result.status === "aborted")
            appendText("已停止", "可以继续输入新的任务。");
          break;
      }
      if (detailsVisible) updateDetails();
      requestRender();
    },
    notice(text) {
      appendText("Anthias", text);
      // 窄屏详情会覆盖正文；短提示独立呈现，不改变审批内容或阅读位置。
      if (detailsVisible && terminal.columns < 100) {
        tui.flash(sanitizeTerminalText(text).split("\n")[0] ?? "", 4_000);
      }
      requestRender();
    },
    details: toggleDetails,
    canApprove() {
      return (
        approval !== null &&
        !approvalUnrenderable &&
        terminal.columns >= 20 &&
        terminal.rows >= 8 &&
        renderedApprovalId === approval.toolApprovalRequestId &&
        renderedTerminalColumns === terminal.columns &&
        renderedTerminalRows === terminal.rows &&
        detailScroll.viewportHeight > 0 &&
        detailScroll.scrollTop + detailScroll.viewportHeight >= detailContentHeight
      );
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const content of markdownContents) content.close();
      editor.setAutocompleteProvider({
        async getSuggestions() {
          return null;
        },
        applyCompletion(lines, cursorLine, cursorCol) {
          return { lines, cursorLine, cursorCol };
        },
      });
      try {
        if (started) tui.stop({ preserveScreen: true });
      } finally {
        await terminal.drainInput(100, 20);
      }
    },
  };
}

export function formatApproval(request: ToolApprovalRequest): string {
  return sanitizeTerminalText(
    [
      `Tool: ${request.toolName}`,
      `Target: ${request.target}`,
      `Mode: ${request.permissionMode}`,
      `Risk: ${request.riskSummary}`,
      `Boundary: ${request.executionBoundary}`,
      "",
      request.preview,
      "",
      "以上为本次执行的完整预览。输入 approve 确认，或 deny 拒绝。",
    ].join("\n"),
  );
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function isApprovalDisplayable(request: ToolApprovalRequest): boolean {
  const original = Object.values(request).join("\n").replace(/\r\n?/gu, "\n");
  return original.length <= 256 * 1024 && sanitizeTerminalText(original) === original;
}
