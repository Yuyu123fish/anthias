import type { Agent, AgentEvent, ToolApprovalRequest } from "@anthias/agent";
import {
  type Component,
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
import {
  type CodeHighlighter,
  sanitizeTerminalText,
  type TerminalCapabilities,
} from "./content-renderer.js";
import type { ExecutionControl } from "./execution-view.js";
import { collaborationStatus } from "./multi-agent-view.js";
import { permissionModeNotice } from "./permission-view.js";
import { createConversationPresentation } from "./presentation.js";
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
  let workspaceGrantReviewText: string | null = null;
  let panel: "details" | "approval" | "permissions" = "details";
  let pendingToolApprovalRequest: ToolApprovalRequest | null = agent.state.pendingToolApproval;
  let approvalUnrenderable = false;
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
  const presentation = createConversationPresentation({
    state: () => agent.state,
    collaboration: () => agent.collaboration.snapshot(),
    capabilities,
    theme,
    now,
    changed: invalidateConversation,
    toggled: () => {
      pendingScrollTop = conversationScroll.scrollTop;
      invalidateConversation();
    },
    detailAdded: (index) => {
      if (!detailsVisible) selectedDetail = index;
    },
    openDetail: (index) => {
      selectedDetail = index;
      panel = "details";
      detailsVisible = true;
      updateDetails(true);
    },
    ...(options.codeHighlighter === undefined ? {} : { codeHighlighter: options.codeHighlighter }),
  });
  const conversation = presentation.document;
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
      if (panel === "approval" && pendingToolApprovalRequest !== null)
        return [truncateToWidth(theme.coral(" 执行确认 · PageDown 浏览"), width, "")];
      if (panel === "permissions" && workspaceGrantReviewText !== null)
        return [truncateToWidth(theme.coral(" 工作区授权 · PageDown 浏览"), width, "")];
      let line = ` 详情 ${presentation.details.length ? selectedDetail + 1 : 0}/${presentation.details.length} `;
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
  let renderedToolApprovalRequestId: string | undefined;
  let renderedWorkspaceGrantReviewText: string | null = null;
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
      renderedToolApprovalRequestId =
        panel === "approval" ? pendingToolApprovalRequest?.toolApprovalRequestId : undefined;
      renderedWorkspaceGrantReviewText = panel === "permissions" ? workspaceGrantReviewText : null;
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
          if (pendingToolApprovalRequest !== null) updateDetails();
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
          presentation.notice("输入未接受", "新草稿已保留；输入 /draft 可恢复上一份未接受的输入。");
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
            theme.muted(`  主 Agent · 根 Session ${sanitizeTerminalText(agent.state.sessionId)}`),
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
      const phase = pendingToolApprovalRequest
        ? "等待确认 · /approval"
        : state.operation === "compacting"
          ? "压缩中"
          : state.operation === "switching_session"
            ? "切换会话"
            : state.operation === "updating_capabilities"
              ? "更新外部能力"
              : presentation.retryStatusText !== null
                ? presentation.retryStatusText
                : presentation.reasoningActive
                  ? "思考中"
                  : state.activeAssistantMessage
                    ? "正在回答"
                    : state.activeRun?.phase === "awaiting_workspace"
                      ? "等待工作区资源"
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
      const inputQueue = state.inputQueue;
      const queuedInputCount = inputQueue.steer.length + inputQueue.followUp.length;
      const queueText = queuedInputCount
        ? ` · 待插入 ${inputQueue.steer.length}/${inputQueue.followUp.length}${inputQueue.paused ? " · 已暂停 /continue" : ""}`
        : "";
      const scrollText = !conversationScroll.isFollowingEnd ? " · 阅读历史 · Ctrl+End 跟随" : "";
      const detailHint = detailsVisible ? " · Ctrl+T 关闭详情" : " · / 命令 · Ctrl+T 详情";
      return [
        truncateToWidth(
          theme.muted(
            `${state.permissionMode} · ${phase}${queueText} · ${contextText}${collaborationStatus(state.collaboration)}${scrollText}${detailHint}`,
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
        for (const control of presentation.controlsFor(child))
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
  function resetConversation(): void {
    conversationCache = undefined;
    pressedControl = undefined;
    selectedDetail = 0;
    pendingToolApprovalRequest = agent.state.pendingToolApproval;
    detailsVisible = pendingToolApprovalRequest !== null;
    panel = pendingToolApprovalRequest === null ? "details" : "approval";
    workspaceGrantReviewText = null;
    presentation.restore();
    const permissionNotice = permissionModeNotice(
      agent.state.permissionMode,
      agent.permissions.snapshot(),
    );
    if (permissionNotice !== null) presentation.notice("权限模式", permissionNotice);
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
    if (panel === "approval" && pendingToolApprovalRequest !== null) {
      const text = formatApproval(pendingToolApprovalRequest);
      approvalUnrenderable =
        !isApprovalDisplayable(pendingToolApprovalRequest) ||
        terminal.columns < 20 ||
        terminal.rows < 8;
      setDetailText(
        approvalUnrenderable
          ? "终端空间不足或审批内容无法完整呈现，无法安全确认。请放大窗口或输入 deny。"
          : text,
      );
    } else if (panel === "permissions" && workspaceGrantReviewText !== null) {
      setDetailText(workspaceGrantReviewText);
    } else {
      selectedDetail = Math.max(0, Math.min(selectedDetail, presentation.details.length - 1));
      const selected = presentation.details[selectedDetail];
      setDetailText(
        selected === undefined
          ? "当前没有可显示的详情。"
          : `${selected.title}${selected.endedAt === undefined ? "" : ` · ${((selected.endedAt - selected.startedAt) / 1000).toFixed(1)}s`}\n${selected.truncated ? "[较早详情已省略]\n" : ""}${selected.content || "（等待内容）"}`,
      );
    }
    if (resetScroll) detailScroll.scrollToStart();
    requestRender();
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
        (pendingToolApprovalRequest !== null && inputText.trim().toLowerCase() === "deny");
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
        Math.min(presentation.details.length - 1, selectedDetail + (direction === "prev" ? -1 : 1)),
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
      presentation.event(event);
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
        case "tool_approval_requested":
          pendingToolApprovalRequest = event.request;
          if (!detailsVisible) {
            panel = "approval";
            detailsVisible = true;
            updateDetails(true);
          }
          break;
        case "tool_approval_resolved":
          pendingToolApprovalRequest = null;
          if (panel === "approval") {
            detailsVisible = false;
            panel = "details";
          }
          break;
      }
      if (detailsVisible) updateDetails();
      requestRender();
      if (event.type === "run_end" || event.type === "session_unavailable")
        setImmediate(() => {
          // 已持久化终态之后仍有一次所有权交接；状态栏在该微任务收尾后重新读取。
          if (!closed) requestRender();
        });
    },
    notice(text, title = "Anthias") {
      presentation.notice(title, text);
      // 窄屏详情会覆盖正文；短提示独立呈现，不改变审批内容或阅读位置。
      if (detailsVisible && terminal.columns < 100) {
        tui.flash(sanitizeTerminalText(text).split("\n")[0] ?? "", 4_000);
      }
      requestRender();
    },
    recoverDraft() {
      const draft = rejectedDrafts.pop();
      if (draft === undefined) {
        presentation.notice("草稿", "没有待恢复的输入。");
        return;
      }
      const currentDraft = editor.getExpandedText();
      if (currentDraft) rejectedDrafts.push(currentDraft);
      editor.setText(draft);
      requestRender();
    },
    reviewPermissions(text) {
      workspaceGrantReviewText = text === null ? null : sanitizeTerminalText(text);
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
      if (pendingToolApprovalRequest === null) {
        presentation.notice("执行确认", "当前没有待批准请求。");
        return;
      }
      panel = "approval";
      detailsVisible = true;
      updateDetails(true);
    },
    canGrantPermissions() {
      return (
        workspaceGrantReviewText !== null &&
        renderedWorkspaceGrantReviewText === workspaceGrantReviewText &&
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
        pendingToolApprovalRequest !== null &&
        panel === "approval" &&
        !approvalUnrenderable &&
        terminal.columns >= 20 &&
        terminal.rows >= 8 &&
        renderedToolApprovalRequestId === pendingToolApprovalRequest.toolApprovalRequestId &&
        renderedTerminalColumns === terminal.columns &&
        renderedTerminalRows === terminal.rows &&
        detailScroll.viewportHeight > 0 &&
        detailScroll.scrollTop + detailScroll.viewportHeight >= detailContentHeight
      );
    },
    async close() {
      if (closed) return;
      closed = true;
      presentation.close();
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

export function formatApproval(toolApprovalRequest: ToolApprovalRequest): string {
  return sanitizeTerminalText(
    [
      ...(toolApprovalRequest.memberSessionId
        ? [
            "成员: " +
              (toolApprovalRequest.memberName ?? toolApprovalRequest.memberSessionId) +
              " · " +
              toolApprovalRequest.memberSessionId,
          ]
        : []),
      ...(toolApprovalRequest.workspaceRoot
        ? [`Workspace: ${toolApprovalRequest.workspaceRoot}`]
        : []),
      `Tool: ${toolApprovalRequest.toolName}`,
      `Target: ${toolApprovalRequest.target}`,
      `Mode: ${toolApprovalRequest.permissionMode}`,
      `Risk: ${toolApprovalRequest.riskSummary}`,
      `Boundary: ${toolApprovalRequest.executionBoundary}`,
      "",
      toolApprovalRequest.preview,
      "",
      "以上为本次执行的完整预览。输入 approve 确认，或 deny 拒绝。",
    ].join("\n"),
  );
}

export function isApprovalDisplayable(toolApprovalRequest: ToolApprovalRequest): boolean {
  const original = Object.values(toolApprovalRequest).join("\n").replace(/\r\n?/gu, "\n");
  return original.length <= 256 * 1024 && sanitizeTerminalText(original) === original;
}
