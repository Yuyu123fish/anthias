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
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { createCommandAutocomplete } from "./command.js";
import { createMarkdownContent, type MarkdownContent } from "./content/markdown.js";
import {
  type CodeHighlighter,
  sanitizeTerminalText,
  type TerminalCapabilities,
} from "./content-renderer.js";
import { formatRunDiagnostic } from "./diagnostic-view.js";
import {
  createExecutionTurn,
  type ExecutionControl,
  type ExecutionStep,
  type ExecutionTurn,
} from "./execution-view.js";
import { collaborationStatus } from "./multi-agent-view.js";
import { missingWorkspaceGrantNotice } from "./permission-view.js";
import { createTheme } from "./theme.js";

export type ConversationView = Readonly<{
  start(): void;
  event(event: AgentEvent): void;
  notice(text: string, title?: string): void;
  recoverDraft(): void;
  reviewPermissions(text: string | null): void;
  showApproval(): void;
  canGrantPermissions(): boolean;
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
type ExecutionDetail = Detail & {
  step: ExecutionStep;
  body: Text;
  turn: ExecutionTurn;
  runId?: string;
  authorization?: string;
  toolStage?: "input" | "ready" | "approval" | "running" | "retry" | "finished";
};

/** 长期保留布局、消息组件和滚动容器；AgentEvent 只更新发生变化的内容。 */
export function createConversationView(options: {
  agent: Agent;
  terminal: Terminal;
  capabilities: TerminalCapabilities;
  submit(text: string): Promise<boolean>;
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
  let draftRevision = 0;
  const rejectedDrafts: string[] = [];
  let permissionReview: string | null = null;
  let panel: "details" | "approval" | "permissions" = "details";
  let approval: ToolApprovalRequest | null = agent.state.pendingToolApproval;
  let approvalUnrenderable = false;
  let activeAssistant:
    | { content: MarkdownContent; step: ExecutionStep; fullText: string }
    | undefined;
  let assistantPrefix = "";
  let activeReasoning: ExecutionDetail | undefined;
  let retryStatus: string | null = null;
  let activeTurn: ExecutionTurn | undefined;
  const executionTurns = new Map<Component, { controls: ExecutionControl[] }>();
  const currentRunTurns = new Set<ExecutionTurn>();
  let conversationRevision = 0;
  let conversationCache:
    | { width: number; revision: number; lines: string[]; controls: ExecutionControl[] }
    | undefined;
  let pendingScrollTop: number | undefined;
  let headerHeight = 2;
  let renderedColumns = 0;
  let renderedRows = 0;
  let renderedDetailsVisible = false;
  let renderedConversationRevision = -1;
  let pressedControl: { activate: () => void; dragged: boolean; x: number; y: number } | undefined;
  const details: Detail[] = [];
  const toolDetails = new Map<string, ExecutionDetail>();
  const markdownContents = new Set<MarkdownContent>();
  const conversation = new Container();
  const detailText = new Text("当前没有详情。", 1, 0);
  const detailButtons = [
    { label: "[<]", activate: () => toggleDetails("prev") },
    { label: "[>]", activate: () => toggleDetails("next") },
    { label: "[x]", activate: () => toggleDetails() },
  ];
  let detailControls: ExecutionControl[] = [];
  const detailHeading: Component = {
    invalidate() {},
    render(width) {
      detailControls = [];
      if (panel === "approval" && approval !== null)
        return [truncateToWidth(theme.coral(" 执行确认 · PageDown 浏览"), width, "")];
      if (panel === "permissions" && permissionReview !== null)
        return [truncateToWidth(theme.coral(" 工作区授权 · PageDown 浏览"), width, "")];
      let line = ` 详情 ${details.length ? selectedDetail + 1 : 0}/${details.length} `;
      for (const button of detailButtons) {
        const column = visibleWidth(line);
        if (column + button.label.length > width) break;
        detailControls.push({
          row: 0,
          column,
          width: button.label.length,
          activate: button.activate,
        });
        line += `${button.label} `;
      }
      return [truncateToWidth(theme.lagoon(line), width, "")];
    },
  };
  const conversationScroll = new ScrollView(conversation, {
    follow: "end",
    primary: true,
    scrollbar: "always",
    scrollbarStyle: theme.scrollbar,
  });
  let detailContentHeight = 0;
  let pendingDetailScrollEnd = false;
  let renderedApprovalId: string | undefined;
  let renderedPermissionReview: string | null = null;
  let renderedTerminalColumns = 0;
  let renderedTerminalRows = 0;
  const detailDocument: Component = {
    invalidate() {
      detailText.invalidate();
    },
    render(width) {
      const lines = detailText.render(width);
      detailContentHeight = lines.length;
      if (pendingDetailScrollEnd) {
        detailScroll.updateLayout(lines.length, detailScroll.viewportHeight, requestRender);
        detailScroll.scrollToEnd();
        pendingDetailScrollEnd = false;
      }
      renderedApprovalId = panel === "approval" ? approval?.toolApprovalRequestId : undefined;
      renderedPermissionReview = panel === "permissions" ? permissionReview : null;
      renderedTerminalColumns = options.terminal.columns;
      renderedTerminalRows = options.terminal.rows;
      return lines;
    },
  };
  const detailScroll = new ScrollView(detailDocument, {
    follow: "none",
    scrollbar: "always",
    scrollbarStyle: theme.scrollbar,
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
          pressedControl = undefined;
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
        if (data.includes("\u001b[?2026h")) {
          renderedColumns = options.terminal.columns;
          renderedRows = options.terminal.rows;
          renderedDetailsVisible = detailsVisible;
          renderedConversationRevision = conversationCache?.revision ?? -1;
        }
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
    const submissionRevision = draftRevision;
    void options
      .submit(promptText)
      .then((accepted) => {
        if (accepted || closed) return;
        // 异步拒绝只能恢复提交时的空编辑器，不能覆盖用户随后输入或手动清空的新草稿。
        if (draftRevision === submissionRevision && editor.getText() === "")
          editor.setText(promptText);
        else {
          rejectedDrafts.push(promptText);
          appendNotice("输入未接受", "新草稿已保留；输入 /draft 可恢复上一份未接受的输入。");
        }
        requestRender();
      })
      .catch(options.failure);
  };
  editor.onChange = () => {
    draftRevision += 1;
    requestRender();
  };
  editor.setAutocompleteProvider(createCommandAutocomplete(agent));
  const header: Component = {
    invalidate() {},
    render(width) {
      const lines = [
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
      headerHeight = lines.length;
      return lines;
    },
  };
  const status: Component = {
    invalidate() {},
    render(width) {
      const state = agent.state;
      const phase = approval
        ? "等待确认 · /approval"
        : state.operation === "compacting"
          ? "压缩中"
          : state.operation === "switching_session"
            ? "切换会话"
            : state.operation === "updating_capabilities"
              ? "更新外部能力"
              : retryStatus !== null
                ? retryStatus
                : activeReasoning
                  ? "思考中"
                  : state.activeAssistantMessage
                    ? "正在回答"
                    : state.activeRun?.phase === "reviewing_tool"
                      ? "自动审批"
                      : state.activeRun?.phase === "executing_tool"
                        ? "Tool 运行中"
                        : state.activeRun?.phase === "retrying_model"
                          ? "等待模型重试 · Ctrl+C 停止"
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
            `${state.permissionMode} · ${phase} · ${contextText}${collaborationStatus(state.collaboration)}${scrollText}${detailHint}`,
          ),
          width,
        ),
      ];
    },
  };
  const detailPanel = new VStack([
    { component: detailHeading, shrink: 0 },
    { component: detailScroll, basis: 0, grow: 1, minSize: 0 },
  ]);
  const body = new HStack(
    [
      {
        component: conversationScroll,
        basis: 0,
        grow: 1,
        minSize: 0,
        visible: (viewport) => !detailsVisible || viewport.width >= 100,
      },
      {
        component: detailPanel,
        basis: 42,
        grow: 0,
        shrink: 0,
        visible: (viewport) => detailsVisible && viewport.width >= 100,
      },
      {
        component: detailPanel,
        basis: 0,
        grow: 1,
        minSize: 0,
        visible: (viewport) => detailsVisible && viewport.width < 100,
      },
    ],
    { gap: 1 },
  );
  const layout = new VStack([
    { component: header, shrink: 0 },
    { component: body, basis: 0, grow: 1, minSize: 1 },
    { component: editor, shrink: 1, minSize: 3, maxSize: 12 },
    { component: status, shrink: 0 },
  ]);
  const compactTerminal = new Text("终端空间不足，请放大窗口。", 0, 0);
  const root = new VStack([
    {
      component: layout,
      basis: 0,
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
  for (const component of [
    header,
    status,
    editor,
    detailHeading,
    detailDocument,
    compactTerminal,
  ]) {
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
  const invalidate = conversation.invalidate.bind(conversation);
  conversation.invalidate = () => {
    conversationRevision += 1;
    invalidate();
  };
  conversation.render = (width) => {
    if (conversationCache?.width === width && conversationCache.revision === conversationRevision)
      return conversationCache.lines;
    try {
      const lines: string[] = [];
      const controls: ExecutionControl[] = [];
      for (const child of conversation.children) {
        const offset = lines.length;
        for (const line of child.render(width)) lines.push(line);
        for (const control of executionTurns.get(child)?.controls ?? [])
          controls.push({ ...control, row: offset + control.row });
      }
      const safeLines = lines.map((line) => truncateToWidth(line, Math.max(1, width), ""));
      conversationCache = { width, revision: conversationRevision, lines: safeLines, controls };
      if (pendingScrollTop !== undefined) {
        // 手动展开沿用被点击标题的位置；先让 ScrollView 知道新高度，避免末尾跟随把标题推走。
        conversationScroll.updateLayout(
          safeLines.length,
          conversationScroll.viewportHeight,
          requestRender,
        );
        conversationScroll.scrollTo(pendingScrollTop);
        pendingScrollTop = undefined;
      }
      return safeLines;
    } catch {
      options.failure();
      return [];
    }
  };
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
  function invalidateConversation(): void {
    conversationRevision += 1;
    requestRender();
  }
  function ensureTurn(): ExecutionTurn {
    if (activeTurn === undefined) {
      activeTurn = createExecutionTurn(theme, capabilities.unicode, () => {
        pendingScrollTop = conversationScroll.scrollTop;
        invalidateConversation();
      });
      executionTurns.set(activeTurn, activeTurn);
      currentRunTurns.add(activeTurn);
      conversation.addChild(activeTurn);
    }
    return activeTurn;
  }
  function newMarkdown(text: string): MarkdownContent {
    const content = createMarkdownContent({
      workspaceRoot: agent.state.workspaceRoot,
      capabilities,
      requestRender: invalidateConversation,
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
    invalidateConversation();
  }
  function splitPresentation(): void {
    if (activeAssistant !== undefined) {
      assistantPrefix = activeAssistant.fullText;
      activeAssistant = undefined;
    }
    activeTurn = undefined;
  }
  function currentAssistantText(message: AssistantMessage): string {
    const fullText = assistantText(message);
    if (!fullText.startsWith(assistantPrefix)) assistantPrefix = "";
    return fullText.slice(assistantPrefix.length);
  }
  function appendNotice(title: string, text: string): void {
    splitPresentation();
    const content = sanitizeTerminalText(text);
    const preview = summarizeText(content, 4, 420);
    const long = preview !== content.trim();
    const detail: Detail | undefined = long
      ? {
          id: `notice:${details.length}`,
          title: sanitizeTerminalText(title),
          content: content.slice(0, 128 * 1024),
          truncated: content.length > 128 * 1024,
          startedAt: now(),
        }
      : undefined;
    if (detail !== undefined) {
      details.push(detail);
      if (!detailsVisible) selectedDetail = details.length - 1;
    }
    const open = () => {
      if (detail === undefined) return;
      selectedDetail = details.indexOf(detail);
      panel = "details";
      detailsVisible = true;
      updateDetails(true);
    };
    const component: Component & { controls: ExecutionControl[] } = {
      controls: [],
      invalidate() {},
      render(width) {
        const label = truncateToWidth(
          theme.lagoon(` ${sanitizeTerminalText(title)}${long ? " · [详情]" : ""}`),
          width,
          "",
        );
        component.controls = long
          ? [{ row: 1, column: 1, width: Math.max(1, visibleWidth(label) - 1), activate: open }]
          : [];
        return ["", label, ...new Text(preview, 1, 0).render(width)];
      },
    };
    executionTurns.set(component, component);
    conversation.addChild(component);
    invalidateConversation();
  }
  function moveDetail(detail: ExecutionDetail): void {
    const turn = ensureTurn();
    if (detail.turn === turn) return;
    const index = detail.turn.steps.indexOf(detail.step);
    if (index >= 0) detail.turn.steps.splice(index, 1);
    turn.steps.push(detail.step);
    detail.turn = turn;
  }
  function appendExecutionText(title: string, text: string): void {
    if (activeTurn === undefined || activeTurn.status !== "running") {
      appendText(title, text);
      return;
    }
    const content = sanitizeTerminalText(text);
    activeTurn.steps.push({
      kind: "detail",
      title: sanitizeTerminalText(title),
      text: content,
      content: new Text(content, 0, 0),
      expanded: true,
    });
    invalidateConversation();
  }
  function appendMessage(message: Message): void {
    if (message.role === "user") {
      finishActiveTurn();
      currentRunTurns.clear();
      activeTurn = undefined;
      assistantPrefix = "";
      appendText("You", message.content, "coral");
      ensureTurn();
    } else if (message.role === "assistant") {
      const turn = ensureTurn();
      const text = currentAssistantText(message);
      const content = newMarkdown(text);
      const step: ExecutionStep = {
        kind: "message",
        title: "中间回复",
        text,
        content,
        expanded: true,
        hasToolCalls: message.content.some((part) => part.type === "tool_call"),
        messageStatus: message.status,
      };
      turn.steps.push(step);
      turn.answer = step.hasToolCalls ? undefined : step;
      if (message.status === "streaming")
        activeAssistant = { content, step, fullText: assistantText(message) };
      invalidateConversation();
    } else
      completeTool(
        message.toolCallId,
        message.toolName,
        message.status,
        message.content,
        message.truncated,
      );
  }
  function updateAssistant(message: AssistantMessage): void {
    if (activeAssistant === undefined) {
      appendMessage(message);
      return;
    }
    const { content, step } = activeAssistant;
    step.text = currentAssistantText(message);
    activeAssistant.fullText = assistantText(message);
    step.hasToolCalls = message.content.some((part) => part.type === "tool_call");
    step.messageStatus = message.status;
    content.setText(step.text);
    ensureTurn().answer = step.hasToolCalls ? undefined : step;
    invalidateConversation();
  }
  function finishActiveTurn(status?: "completed" | "failed" | "aborted"): void {
    for (const turn of currentRunTurns) turn.finish(status);
  }
  function resetConversation(): void {
    for (const content of markdownContents) content.close();
    markdownContents.clear();
    conversation.clear();
    details.length = 0;
    toolDetails.clear();
    executionTurns.clear();
    currentRunTurns.clear();
    assistantPrefix = "";
    activeTurn = undefined;
    conversationCache = undefined;
    pressedControl = undefined;
    activeAssistant = undefined;
    activeReasoning = undefined;
    retryStatus = null;
    approval = agent.state.pendingToolApproval;
    detailsVisible = approval !== null;
    panel = approval === null ? "details" : "approval";
    permissionReview = null;
    for (const message of agent.state.messageHistory) appendMessage(message);
    if (!agent.state.running) finishActiveTurn();
    const lastAssistant = agent.state.messageHistory.findLast(
      (message) => message.role === "assistant",
    );
    const diagnostic = agent.state.lastRunDiagnostic ?? lastAssistant?.diagnostic;
    if (
      diagnostic?.category !== "completed" &&
      (diagnostic != null ||
        lastAssistant?.status === "failed" ||
        lastAssistant?.status === "aborted")
    )
      appendNotice("最近运行诊断", formatRunDiagnostic(diagnostic));
    if (agent.state.activeAssistantMessage !== null)
      appendMessage(agent.state.activeAssistantMessage);
    if (agent.state.messageHistory.length === 0)
      appendText("开始工作", "描述你的任务，或输入 / 查看命令。", "muted");
    const permissionNotice = missingWorkspaceGrantNotice(
      agent.state.permissionMode,
      agent.permissions.snapshot(),
    );
    if (permissionNotice !== null) appendNotice("工作区授权", permissionNotice);
    conversationScroll.scrollToEnd();
    invalidateConversation();
    updateDetails();
  }
  let displayedDetailText = "";
  function setDetailText(text: string): void {
    if (text === displayedDetailText) return;
    displayedDetailText = text;
    detailText.setText(text);
  }
  function updateDetails(resetScroll = false): void {
    if (panel === "approval" && approval !== null) {
      const text = formatApproval(approval);
      approvalUnrenderable =
        !isApprovalDisplayable(approval) || terminal.columns < 20 || terminal.rows < 8;
      setDetailText(
        approvalUnrenderable
          ? "终端空间不足或审批内容无法完整呈现，无法安全确认。请放大窗口或输入 deny。"
          : text,
      );
    } else if (panel === "permissions" && permissionReview !== null) {
      setDetailText(permissionReview);
    } else {
      selectedDetail = Math.max(0, Math.min(selectedDetail, details.length - 1));
      const selected = details[selectedDetail];
      setDetailText(
        selected === undefined
          ? "当前没有可显示的详情。"
          : `${selected.title}${selected.endedAt === undefined ? "" : ` · ${((selected.endedAt - selected.startedAt) / 1000).toFixed(1)}s`}\n${selected.truncated ? "[较早详情已省略]\n" : ""}${selected.content || "（等待内容）"}`,
      );
    }
    if (resetScroll) detailScroll.scrollToStart();
    requestRender();
  }
  function appendDetail(detail: ExecutionDetail, delta: string): void {
    moveDetail(detail);
    const next = detail.content + sanitizeTerminalText(delta);
    detail.truncated ||= next.length > 128 * 1024;
    detail.content = next.slice(-128 * 1024);
    detail.body.setText(`${detail.truncated ? "[较早详情已省略]\n" : ""}${detail.content}`);
    invalidateConversation();
  }
  function createDetail(id: string, title: string, content: string): ExecutionDetail {
    const body = new Text(sanitizeTerminalText(content), 0, 0);
    const step: ExecutionStep = {
      kind: "detail",
      title: sanitizeTerminalText(title),
      text: "",
      content: body,
      expanded: true,
    };
    const turn = ensureTurn();
    turn.steps.push(step);
    const detail: ExecutionDetail = {
      id,
      title: sanitizeTerminalText(title),
      content: sanitizeTerminalText(content),
      truncated: false,
      startedAt: now(),
      step,
      body,
      turn,
    };
    details.push(detail);
    if (!detailsVisible) selectedDetail = details.length - 1;
    invalidateConversation();
    return detail;
  }
  function toolIdentity(id: string, source: { memberSessionId?: string } = {}): string {
    return `${source.memberSessionId ?? agent.state.sessionId}:${id}`;
  }
  function ensureTool(
    id: string,
    name: string,
    source: { memberSessionId?: string; memberName?: string; runId?: string } = {},
  ): ExecutionDetail {
    const identity = toolIdentity(id, source);
    let detail = toolDetails.get(identity);
    if (detail === undefined) {
      const member = source.memberSessionId
        ? ` · 成员 ${source.memberName ?? source.memberSessionId}`
        : "";
      detail = createDetail(identity, `${name} [${id.slice(-8)}]${member}`, "");
      detail.step.expanded = false;
      detail.toolStage = "ready";
      toolDetails.set(identity, detail);
    }
    if (source.runId !== undefined) detail.runId = source.runId;
    return detail;
  }
  function readyTools(message: AssistantMessage): void {
    for (const part of message.content) {
      if (part.type !== "tool_call") continue;
      const detail = ensureTool(part.toolCallId, part.toolName);
      if (detail.endedAt !== undefined || detail.step.summary !== undefined) continue;
      detail.step.title = `${detail.title} · 等待执行`;
      detail.step.summary = "完整请求已收到，等待校验与执行。";
    }
  }
  function completeTool(
    id: string,
    name: string,
    status: string,
    content: string,
    truncated: boolean,
    source: { memberSessionId?: string; memberName?: string } = {},
  ): void {
    const detail = ensureTool(id, name, source);
    if (detail.endedAt === undefined) {
      detail.truncated ||= truncated;
      appendDetail(detail, `\n[result] ${content}`);
      detail.endedAt = now();
      detail.step.expanded = false;
    }
    const statuses: Record<string, string> = {
      completed: "已完成",
      failed: "失败",
      denied: "已拒绝",
      aborted: "已停止",
      unknown: "结果未知",
    };
    detail.step.title = `${detail.title} · ${statuses[status] ?? sanitizeTerminalText(status)}`;
    detail.toolStage = "finished";
    detail.step.attention = status !== "completed";
    detail.step.summary =
      summarizeText(
        sanitizeTerminalText(content),
        status === "completed" ? 2 : 5,
        status === "completed" ? 200 : 600,
      ) || (status === "completed" ? "执行完成，无输出。" : "没有可确认的结果，请查看详情。");
    if (detail.authorization)
      detail.step.summary = `来源：${detail.authorization}\n${detail.step.summary}`;
    if (status === "unknown") detail.step.summary += "\n结果未知，不自动重放；先核对实际状态。";
    invalidateConversation();
  }
  function finishUnresolvedTools(sessionId: string, runId: string, reason?: string): void {
    for (const detail of toolDetails.values()) {
      if (
        !detail.id.startsWith(`${sessionId}:`) ||
        (detail.runId !== undefined && detail.runId !== runId) ||
        detail.toolStage === "finished" ||
        detail.toolStage === "retry"
      )
        continue;
      detail.step.title = `${detail.title} · ${detail.toolStage === "running" ? "结果待核对" : "未执行"}`;
      detail.step.summary =
        (reason ? reason + "\n" : "") +
        (detail.toolStage === "running"
          ? "运行已结束，但未收到该工具的完成结果；先核对实际状态，不自动重放。"
          : "运行已结束，该请求未进入执行阶段。");
      detail.step.attention = true;
      detail.endedAt = now();
      detail.toolStage = "finished";
    }
    invalidateConversation();
  }
  function controlAt(x: number, y: number): ExecutionControl | undefined {
    if (
      (detailsVisible && panel !== "details") ||
      !hasLayoutSpace(terminal.columns, terminal.rows) ||
      renderedColumns !== terminal.columns ||
      renderedRows !== terminal.rows ||
      renderedDetailsVisible !== detailsVisible
    )
      return undefined;
    if (detailsVisible && y === headerHeight) {
      const left = terminal.columns >= 100 ? terminal.columns - 42 : 0;
      if (x >= left)
        return detailControls.find(
          (control) => x - left >= control.column && x - left < control.column + control.width,
        );
    }
    if (detailsVisible && terminal.columns < 100) return undefined;
    const width = terminal.columns - (detailsVisible ? 43 : 0);
    if (
      x < 0 ||
      x >= width - 1 ||
      y < headerHeight ||
      y >= headerHeight + conversationScroll.viewportHeight ||
      // 后台内容可能已变脏；只要缓存仍对应屏幕上的帧，点击位置就仍然有效。
      renderedConversationRevision !== conversationCache?.revision
    )
      return undefined;
    const row = y - headerHeight + conversationScroll.scrollTop;
    return conversationCache?.controls.find(
      (control) => control.row === row && x >= control.column && x < control.column + control.width,
    );
  }
  function handleMouse(data: string): boolean {
    if (!data.startsWith("\u001b")) return false;
    const match = /^\[<(\d+);(\d+);(\d+)([Mm])$/u.exec(data.slice(1));
    if (match === null) return false;
    const button = Number(match[1]);
    const x = Number(match[2]) - 1;
    const y = Number(match[3]) - 1;
    const release = match[4] === "m";
    if (
      pressedControl !== undefined &&
      (button & 32) !== 0 &&
      (x !== pressedControl.x || y !== pressedControl.y)
    )
      pressedControl.dragged = true;
    if (button !== 0) return false;
    if (release) {
      const pressed = pressedControl;
      pressedControl = undefined;
      if (pressed === undefined) return false;
      if (!pressed.dragged && controlAt(x, y)?.activate === pressed.activate) pressed.activate();
      return true;
    }
    const control = controlAt(x, y);
    if (control === undefined) return false;
    pressedControl = { activate: control.activate, dragged: false, x, y };
    return true;
  }
  function handleInput(data: string): boolean {
    if (closed) return true;
    if (handleMouse(data)) return true;
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
      panel === "details" &&
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
      if (detailsVisible) pendingDetailScrollEnd = true;
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
    if (direction === undefined) {
      if (detailsVisible && panel !== "details") return;
      detailsVisible = !detailsVisible;
      panel = "details";
    } else {
      panel = "details";
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
      if (
        event.memberSessionId === undefined &&
        ["message_update", "reasoning_start", "tool_preparation", "tool_execution_start"].includes(
          event.type,
        )
      )
        retryStatus = null;
      switch (event.type) {
        case "session_changed":
          resetConversation();
          editor.setAutocompleteProvider(createCommandAutocomplete(agent));
          break;
        case "memory_changed":
        case "skills_changed":
        case "mcp_changed":
          editor.setAutocompleteProvider(createCommandAutocomplete(agent));
          break;
        case "message_start":
          retryStatus = null;
          if (event.message.role === "assistant") assistantPrefix = "";
          appendMessage(event.message);
          break;
        case "message_update":
          updateAssistant(event.message);
          break;
        case "message_end":
          if (event.message.role === "assistant") {
            updateAssistant(event.message);
            readyTools(event.message);
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
          activeReasoning = createDetail(
            `reasoning:${event.runId}:${details.length}`,
            "Reasoning",
            "",
          );
          activeReasoning.step.title = "Reasoning · 思考中";
          break;
        }
        case "reasoning_update":
          if (activeReasoning !== undefined) {
            appendDetail(activeReasoning, event.delta);
            activeReasoning.step.title = `Reasoning · ${((now() - activeReasoning.startedAt) / 1000).toFixed(1)}s`;
          }
          break;
        case "reasoning_end":
          if (activeReasoning !== undefined) {
            activeReasoning.endedAt = now();
            activeReasoning.step.title = `Reasoning · 已思考 ${((activeReasoning.endedAt - activeReasoning.startedAt) / 1000).toFixed(1)}s`;
            activeReasoning.step.expanded = false;
            activeReasoning = undefined;
            invalidateConversation();
          }
          break;
        case "tool_preparation": {
          const detail = ensureTool(event.toolCallId, event.toolName, event);
          moveDetail(detail);
          if (detail.toolStage === "retry") delete detail.endedAt;
          detail.toolStage = event.phase;
          detail.step.title = `${detail.title} · ${event.phase === "input" ? "参数生成中" : "等待执行"}`;
          detail.step.summary =
            event.phase === "input"
              ? "目标尚未完整；参数生成中，不会提前执行。"
              : "完整请求已收到，等待校验与执行。";
          invalidateConversation();
          break;
        }
        case "tool_auto_review_start": {
          const detail = ensureTool(event.toolCallId, event.toolName, event);
          moveDetail(detail);
          detail.step.title = `${detail.title} · 自动审核中`;
          detail.step.summary = "正在核对本次动作的授权；Ctrl+C 可停止。";
          invalidateConversation();
          break;
        }
        case "tool_execution_start": {
          const { activity } = event;
          const detail = ensureTool(activity.toolCallId, activity.toolName, event);
          appendDetail(detail, `\n${activity.summary}`);
          detail.toolStage = "running";
          detail.step.title = `${detail.title} · 运行中`;
          detail.step.summary =
            (detail.authorization ? `来源：${detail.authorization}\n` : "") +
            summarizeText(sanitizeTerminalText(activity.summary)) +
            "\nCtrl+C 停止";
          break;
        }
        case "tool_execution_update": {
          const detail = toolDetails.get(toolIdentity(event.toolCallId, event));
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
            event,
          );
          if (event.cleanupUncertain)
            appendExecutionText("资源状态", "Tool 资源清理结果不确定，请查看详情。");
          break;
        case "tool_approval_requested":
          approval = event.request;
          {
            const detail = ensureTool(approval.toolCallId, approval.toolName, approval);
            moveDetail(detail);
            detail.toolStage = "approval";
            detail.step.title = `${detail.title} · 等待批准`;
            detail.step.summary = `${sanitizeTerminalText(approval.target)}\n${sanitizeTerminalText(approval.riskSummary)}\n/approval 查看动作、来源和授权边界`;
            invalidateConversation();
          }
          if (!detailsVisible) {
            panel = "approval";
            detailsVisible = true;
            updateDetails(true);
          }
          break;
        case "tool_approval_resolved":
          approval = null;
          if (panel === "approval") {
            detailsVisible = false;
            panel = "details";
          }
          {
            const detail = ensureTool(
              event.request.toolCallId,
              event.request.toolName,
              event.request,
            );
            moveDetail(detail);
            detail.step.title = `${detail.title} · ${event.decision === "approve" ? "批准后复核" : event.decision === "deny" ? "已拒绝" : "审批已失效"}`;
            detail.step.summary =
              event.decision === "approve"
                ? "仅本次具体动作获准，执行前仍会复核。"
                : event.decision === "deny"
                  ? "本次动作被用户拒绝。"
                  : "本次审批已失效，旧批准不能再次执行。";
            invalidateConversation();
          }
          break;
        case "tool_authorization": {
          const detail = ensureTool(event.toolCallId, event.toolName, event);
          const source = {
            workspace: "工作区授权",
            user: "本次批准",
            auto_review: "自动审核",
            policy: "安全策略",
          }[event.source];
          detail.authorization = source;
          appendDetail(detail, `\n授权来源：${source} · ${event.reason}`);
          detail.step.summary = `授权来源：${source}\n${sanitizeTerminalText(event.reason)}`;
          break;
        }
        case "model_retry":
          if (event.phase === "requesting") {
            for (const detail of toolDetails.values()) {
              if (
                !detail.id.startsWith(`${event.memberSessionId ?? agent.state.sessionId}:`) ||
                detail.toolStage !== "input"
              )
                continue;
              detail.toolStage = "retry";
              detail.endedAt = now();
              detail.step.title = `${detail.title} · 准备已中断`;
              detail.step.summary = "上次请求未形成完整工具参数，未执行；正在重试模型请求。";
              detail.step.expanded = false;
            }
            invalidateConversation();
          }
          if (event.memberSessionId === undefined)
            retryStatus =
              event.phase === "waiting"
                ? `等待重试 ${event.retryCount}/2 · Ctrl+C 停止`
                : `正在重试 ${event.retryCount}/2`;
          appendNotice(
            event.memberSessionId
              ? `成员 ${event.memberName ?? event.memberSessionId} · 模型重试`
              : "模型重试",
            event.phase === "waiting"
              ? `${event.diagnostic.summary}\n等待 ${(event.delayMs / 1000).toFixed(1)} 秒后重试 ${event.retryCount}/2；Ctrl+C 可停止。`
              : `正在发起重试 ${event.retryCount}/2。`,
          );
          break;
        case "compaction_start":
          appendExecutionText("Context", "正在压缩上下文，完整历史会保留。");
          break;
        case "compaction_end":
          appendExecutionText(
            "Context",
            `压缩完成 ${event.inputTokensBefore} → ${event.inputTokensAfter} tokens`,
          );
          break;
        case "compaction_failed":
          appendExecutionText("Context", event.error);
          break;
        case "run_end":
          if (event.memberSessionId !== undefined) {
            finishUnresolvedTools(event.memberSessionId, event.runId, event.diagnostic?.summary);
            break;
          }
          retryStatus = null;
          finishUnresolvedTools(agent.state.sessionId, event.runId);
          finishActiveTurn(event.result.status);
          activeAssistant = undefined;
          activeReasoning = undefined;
          invalidateConversation();
          if (event.result.status !== "completed")
            appendNotice(
              event.result.status === "failed" ? "运行失败" : "已停止",
              event.diagnostic
                ? formatRunDiagnostic(event.diagnostic)
                : `${event.result.status === "failed" ? event.result.error + "\n" : ""}${formatRunDiagnostic(undefined)}`,
            );
          break;
      }
      if (detailsVisible) updateDetails();
      requestRender();
    },
    notice(text, title = "Anthias") {
      appendNotice(title, text);
      // 窄屏详情会覆盖正文；短提示独立呈现，不改变审批内容或阅读位置。
      if (detailsVisible && terminal.columns < 100) {
        tui.flash(sanitizeTerminalText(text).split("\n")[0] ?? "", 4_000);
      }
      requestRender();
    },
    recoverDraft() {
      const draft = rejectedDrafts.pop();
      if (draft === undefined) {
        appendNotice("草稿", "没有待恢复的输入。");
        return;
      }
      const currentDraft = editor.getExpandedText();
      if (currentDraft) rejectedDrafts.push(currentDraft);
      editor.setText(draft);
      requestRender();
    },
    reviewPermissions(text) {
      permissionReview = text === null ? null : sanitizeTerminalText(text);
      if (text === null) {
        if (panel === "permissions") {
          detailsVisible = false;
          panel = "details";
        }
      } else {
        panel = "permissions";
        detailsVisible = true;
      }
      updateDetails(true);
    },
    showApproval() {
      if (approval === null) {
        appendNotice("执行确认", "当前没有待批准请求。");
        return;
      }
      panel = "approval";
      detailsVisible = true;
      updateDetails(true);
    },
    canGrantPermissions() {
      return (
        permissionReview !== null &&
        renderedPermissionReview === permissionReview &&
        panel === "permissions" &&
        hasLayoutSpace(terminal.columns, terminal.rows) &&
        renderedTerminalColumns === terminal.columns &&
        renderedTerminalRows === terminal.rows &&
        detailScroll.viewportHeight > 0 &&
        detailScroll.scrollTop + detailScroll.viewportHeight >= detailContentHeight
      );
    },
    details: toggleDetails,
    canApprove() {
      return (
        approval !== null &&
        panel === "approval" &&
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

function summarizeText(text: string, maxLines = 3, maxCharacters = 300): string {
  const lines = text.trim().split("\n");
  const summary = lines.slice(0, maxLines).join("\n").slice(0, maxCharacters);
  return summary.length < text.trim().length ? summary + "\n…" : summary;
}

export function formatApproval(request: ToolApprovalRequest): string {
  return sanitizeTerminalText(
    [
      ...(request.memberSessionId
        ? [
            "成员: " +
              (request.memberName ?? request.memberSessionId) +
              " · " +
              request.memberSessionId,
          ]
        : []),
      ...(request.workspaceRoot ? [`Workspace: ${request.workspaceRoot}`] : []),
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
