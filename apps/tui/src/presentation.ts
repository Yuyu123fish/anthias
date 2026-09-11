import type {
  AgentEvent,
  AgentState,
  AssistantMessage,
  CollaborationSnapshot,
  MemberSummary,
  Message,
  ToolResultMessage,
} from "@anthias/agent";
import {
  type Component,
  Container,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { createMarkdownContent, type MarkdownContent } from "./content/markdown.js";
import {
  type CodeHighlighter,
  sanitizeTerminalText,
  type TerminalCapabilities,
} from "./content-renderer.js";
import { formatModelRecovery, formatRunDiagnostic } from "./diagnostic-view.js";
import {
  authorizationSourceName,
  eventNotice,
  eventSourceLabel,
  toolPreparationText,
  toolResultStatus,
} from "./event-text.js";
import {
  createExecutionTurn,
  type ExecutionControl,
  type ExecutionStep,
  type ExecutionTurn,
} from "./execution-view.js";
import { memberStatusName } from "./multi-agent-view.js";
import type { createTheme } from "./theme.js";

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
  stepTitle: string;
  body: Text;
  turn: ExecutionTurn;
  memberSessionId?: string;
  runId?: string;
  authorization?: string;
  toolStage?: "input" | "ready" | "approval" | "running" | "retry" | "finished";
};
type MemberSource = { memberSessionId?: string; memberName?: string; runId?: string };
type MemberPresentation = Component & {
  sessionId: string;
  name: string | undefined;
  summary: MemberSummary | undefined;
  noticeText: string;
  runs: Map<string | undefined, ExecutionTurn>;
  expanded: boolean;
  controls: ExecutionControl[];
};

/** 只持有呈现对象；成员状态来自公开快照，查看和展开不能启动或切换 Agent。 */
export function createConversationPresentation(options: {
  state(): AgentState;
  collaboration(): CollaborationSnapshot;
  capabilities: TerminalCapabilities;
  theme: ReturnType<typeof createTheme>;
  now(): number;
  changed(): void;
  toggled(): void;
  detailAdded(index: number): void;
  openDetail(index: number): void;
  codeHighlighter?: CodeHighlighter;
}) {
  const { capabilities, theme, now } = options;
  const invalidateConversation = options.changed;
  const conversation = new Container();
  const details: Detail[] = [];
  const toolDetails = new Map<string, ExecutionDetail>();
  const memberViews = new Map<string, MemberPresentation>();
  const controlsByComponent = new Map<Component, { controls: ExecutionControl[] }>();
  const currentRunTurns = new Set<ExecutionTurn>();
  const markdownContents = new Set<MarkdownContent>();
  let activeAssistantView:
    | { content: MarkdownContent; step: ExecutionStep; fullText: string }
    | undefined;
  let renderedAssistantTextPrefix = "";
  let activeReasoningDetail: ExecutionDetail | undefined;
  let retryStatusText: string | null = null;
  let activeExecutionTurn: ExecutionTurn | undefined;
  let collaborationNotice: string | undefined;

  function ensureTurn(source: MemberSource = {}): ExecutionTurn {
    if (source.memberSessionId !== undefined) {
      const member = ensureMember(source.memberSessionId, source.memberName);
      const existing =
        source.runId === undefined
          ? [...member.runs.values()].at(-1)
          : member.runs.get(source.runId);
      if (existing) return existing;
      const turn = createExecutionTurn(theme, capabilities.unicode, options.toggled);
      member.runs.set(source.runId, turn);
      member.noticeText = "";
      return turn;
    }
    if (activeExecutionTurn === undefined) {
      activeExecutionTurn = createExecutionTurn(theme, capabilities.unicode, options.toggled);
      controlsByComponent.set(activeExecutionTurn, activeExecutionTurn);
      currentRunTurns.add(activeExecutionTurn);
      conversation.addChild(activeExecutionTurn);
    }
    return activeExecutionTurn;
  }
  function newMarkdown(text: string): MarkdownContent {
    const content = createMarkdownContent({
      workspaceRoot: options.state().workspaceRoot,
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
    if (activeAssistantView !== undefined) {
      renderedAssistantTextPrefix = activeAssistantView.fullText;
      activeAssistantView = undefined;
    }
    activeExecutionTurn = undefined;
  }
  function currentAssistantText(message: AssistantMessage): string {
    const fullText = assistantText(message);
    if (!fullText.startsWith(renderedAssistantTextPrefix)) renderedAssistantTextPrefix = "";
    return fullText.slice(renderedAssistantTextPrefix.length);
  }
  function appendNotice(title: string, text: string, source: MemberSource = {}): void {
    if (source.memberSessionId) {
      const member = ensureMember(source.memberSessionId, source.memberName);
      const turn = ensureTurn(source);
      if (turn === [...member.runs.values()].at(-1)) member.noticeText = sanitizeTerminalText(text);
      appendExecutionText(title, text, source);
      return;
    }
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
      options.detailAdded(details.length - 1);
    }
    const open = () => {
      if (detail === undefined) return;
      options.openDetail(details.indexOf(detail));
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
    controlsByComponent.set(component, component);
    conversation.addChild(component);
    invalidateConversation();
  }
  function moveDetail(detail: ExecutionDetail): void {
    // 成员详情固定在参数生成时识别的 Run；根详情允许随正文通知调整呈现位置。
    if (detail.memberSessionId !== undefined) return;
    const turn = ensureTurn();
    if (detail.turn === turn) return;
    const index = detail.turn.steps.indexOf(detail.step);
    if (index >= 0) detail.turn.steps.splice(index, 1);
    turn.steps.push(detail.step);
    detail.turn = turn;
  }
  function appendExecutionText(title: string, text: string, source: MemberSource = {}): void {
    const turn = source.memberSessionId ? ensureTurn(source) : activeExecutionTurn;
    if (turn === undefined || (!source.memberSessionId && turn.status !== "running")) {
      appendText(title, text);
      return;
    }
    const content = sanitizeTerminalText(text);
    turn.steps.push({
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
      activeExecutionTurn = undefined;
      renderedAssistantTextPrefix = "";
      appendText(
        message.source?.kind === "agent" ? `成员输入 · ${message.source.fromSessionId}` : "You",
        message.content,
        "coral",
      );
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
        activeAssistantView = { content, step, fullText: assistantText(message) };
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
    if (activeAssistantView === undefined) {
      appendMessage(message);
      return;
    }
    const { content, step } = activeAssistantView;
    step.text = currentAssistantText(message);
    activeAssistantView.fullText = assistantText(message);
    step.hasToolCalls = message.content.some((part) => part.type === "tool_call");
    step.messageStatus = message.status;
    content.setText(step.text);
    ensureTurn().answer = step.hasToolCalls ? undefined : step;
    invalidateConversation();
  }
  function finishActiveTurn(status?: "completed" | "failed" | "aborted"): void {
    for (const turn of currentRunTurns) turn.finish(status);
  }
  function appendDetail(detail: ExecutionDetail, delta: string): void {
    moveDetail(detail);
    const next = detail.content + sanitizeTerminalText(delta);
    detail.truncated ||= next.length > 128 * 1024;
    detail.content = next.slice(-128 * 1024);
    detail.body.setText(`${detail.truncated ? "[较早详情已省略]\n" : ""}${detail.content}`);
    invalidateConversation();
  }
  function createDetail(
    id: string,
    title: string,
    content: string,
    source: MemberSource = {},
  ): ExecutionDetail {
    const body = new Text(sanitizeTerminalText(content), 0, 0);
    const step: ExecutionStep = {
      kind: "detail",
      title: sanitizeTerminalText(title),
      text: "",
      content: body,
      expanded: true,
    };
    const turn = ensureTurn(source);
    turn.steps.push(step);
    const detail: ExecutionDetail = {
      id,
      title: sanitizeTerminalText(title),
      content: sanitizeTerminalText(content),
      truncated: false,
      startedAt: now(),
      step,
      stepTitle: sanitizeTerminalText(title),
      body,
      turn,
      ...(source.memberSessionId ? { memberSessionId: source.memberSessionId } : {}),
      ...(source.runId ? { runId: source.runId } : {}),
    };
    details.push(detail);
    options.detailAdded(details.length - 1);
    invalidateConversation();
    return detail;
  }
  function toolIdentity(id: string, source: { memberSessionId?: string } = {}): string {
    return `${source.memberSessionId ?? options.state().sessionId}:${id}`;
  }
  function ensureTool(
    id: string,
    name: string,
    source: { memberSessionId?: string; memberName?: string; runId?: string } = {},
  ): ExecutionDetail {
    const identity = toolIdentity(id, source);
    let detail = toolDetails.get(identity);
    if (detail === undefined || (source.runId !== undefined && detail.runId !== source.runId)) {
      detail = createDetail(identity, `${name} [${id.slice(-8)}]`, "", source);
      if (source.memberSessionId)
        detail.title += `\n${eventSourceLabel(source)}\n根 Session ${options.state().sessionId}${source.runId ? "\nRun " + source.runId : ""}`;
      detail.step.expanded = false;
      detail.toolStage = "ready";
      toolDetails.set(identity, detail);
    }
    return detail;
  }
  function readyTools(message: AssistantMessage): void {
    for (const part of message.content) {
      if (part.type !== "tool_call") continue;
      const detail = ensureTool(part.toolCallId, part.toolName);
      if (detail.endedAt !== undefined || detail.step.summary !== undefined) continue;
      detail.step.title = `${detail.stepTitle} · 等待执行`;
      detail.step.summary = "完整请求已收到，等待校验与执行。";
    }
  }
  function completeTool(
    id: string,
    name: string,
    status: ToolResultMessage["status"],
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
    detail.step.title = `${detail.stepTitle} · ${toolResultStatus(status)}`;
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
  function finishUnresolvedTools(
    sessionId: string,
    runId: string | undefined,
    reason?: string,
  ): void {
    for (const detail of toolDetails.values()) {
      if (
        !detail.id.startsWith(`${sessionId}:`) ||
        (runId !== undefined && detail.runId !== undefined && detail.runId !== runId) ||
        detail.toolStage === "finished" ||
        detail.toolStage === "retry"
      )
        continue;
      detail.step.title = `${detail.stepTitle} · ${detail.toolStage === "running" ? "结果待核对" : "未执行"}`;
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
  function ensureMember(sessionId: string, name?: string): MemberPresentation {
    const existing = memberViews.get(sessionId);
    if (existing) {
      if (name !== undefined) existing.name = name;
      return existing;
    }
    // 按下与抬起之间可能收到流式事件；重绘不能改变同一展开动作的身份。
    const toggleMember = () => {
      member.expanded = !member.expanded;
      options.toggled();
    };
    const member: MemberPresentation = {
      sessionId,
      name,
      summary: undefined,
      noticeText: "",
      runs: new Map(),
      expanded: false,
      controls: [],
      invalidate() {
        for (const turn of member.runs.values()) turn.invalidate();
      },
      render(width) {
        const summary = member.summary;
        const memberName = summary?.name.trim() || member.name?.trim();
        const source = eventSourceLabel({
          memberSessionId: sessionId,
          ...(memberName ? { memberName } : {}),
        });
        const latestTurn = [...member.runs.values()].at(-1);
        const status = summary
          ? memberStatusName(summary.status)
          : latestTurn
            ? memberStatusName(latestTurn.status)
            : "状态信息缺失";
        const marker = capabilities.unicode
          ? member.expanded
            ? "▾"
            : "▸"
          : member.expanded
            ? "v"
            : ">";
        const heading = theme.lagoon(`${marker} ${sanitizeTerminalText(source)} · ${status}`);
        const headingLines = wrapTextWithAnsi(heading, Math.max(1, width - 2));
        const lines = ["", ...headingLines.map((line) => " " + line)];
        member.controls = headingLines.map((line, index) => ({
          row: index + 1,
          column: 1,
          width: Math.max(1, visibleWidth(line)),
          activate: toggleMember,
        }));
        const overview = [
          "任务：" +
            summarizeText(sanitizeTerminalText(summary?.task?.trim() || "任务信息缺失"), 2, 220),
          summary?.result?.trim()
            ? "结果：" + summarizeText(sanitizeTerminalText(summary.result), 2, 220)
            : "尚无结果摘要。",
          ...(summary?.error ? ["原因：" + sanitizeTerminalText(summary.error)] : []),
          ...(member.noticeText ? [summarizeText(member.noticeText, 3, 300)] : []),
        ];
        for (const item of overview)
          lines.push(
            ...new Text(item, 0, 0).render(Math.max(1, width - 3)).map((line) => "   " + line),
          );
        if (member.expanded) {
          let hasProcess = false;
          for (const [runId, turn] of member.runs) {
            const process = turn.render(Math.max(1, width - 2));
            if (!process.length) continue;
            hasProcess = true;
            if (runId) lines.push(...new Text("Run " + runId, 1, 0).render(Math.max(1, width - 2)));
            const offset = lines.length;
            lines.push(...process.map((line) => "  " + line));
            member.controls.push(
              ...turn.controls.map((control) => ({
                ...control,
                row: control.row + offset,
                column: control.column + 2,
              })),
            );
          }
          if (!hasProcess)
            lines.push("   尚无可显示的执行过程；/agent result " + sessionId + " 查看已保存历史。");
        }
        return lines;
      },
    };
    memberViews.set(sessionId, member);
    controlsByComponent.set(member, member);
    conversation.addChild(member);
    return member;
  }

  function synchronizeMembers(snapshot: CollaborationSnapshot): void {
    for (const summary of snapshot.members) {
      const member = ensureMember(summary.sessionId, summary.name || undefined);
      if (
        (summary.status === "running" || summary.status === "preparing") &&
        member.summary?.status !== summary.status
      )
        member.noticeText = "";
      member.summary = summary;
    }
    if (snapshot.notice && snapshot.notice !== collaborationNotice)
      appendNotice("成员", snapshot.notice);
    collaborationNotice = snapshot.notice;
    invalidateConversation();
  }

  function restore(): void {
    for (const content of markdownContents) content.close();
    markdownContents.clear();
    conversation.clear();
    details.length = 0;
    toolDetails.clear();
    memberViews.clear();
    controlsByComponent.clear();
    currentRunTurns.clear();
    renderedAssistantTextPrefix = "";
    activeExecutionTurn = undefined;
    activeAssistantView = undefined;
    activeReasoningDetail = undefined;
    retryStatusText = null;
    collaborationNotice = undefined;
    const state = options.state();
    for (const message of state.messageHistory) appendMessage(message);
    if (!state.running) finishActiveTurn();
    const lastAssistantMessage = state.messageHistory.findLast(
      (message) => message.role === "assistant",
    );
    const diagnostic = state.lastRunDiagnostic ?? lastAssistantMessage?.diagnostic;
    if (
      diagnostic?.category !== "completed" &&
      (diagnostic != null ||
        lastAssistantMessage?.status === "failed" ||
        lastAssistantMessage?.status === "aborted")
    )
      appendNotice("最近运行诊断", formatRunDiagnostic(diagnostic));
    if (state.activeAssistantMessage !== null) appendMessage(state.activeAssistantMessage);
    if (state.messageHistory.length === 0)
      appendText("开始工作", "描述你的任务，或输入 / 查看命令。", "muted");
    synchronizeMembers(state.collaboration ?? options.collaboration());
  }

  return {
    document: conversation,
    controlsFor: (component: Component): readonly ExecutionControl[] =>
      controlsByComponent.get(component)?.controls ?? [],
    get details(): readonly Readonly<Detail>[] {
      return details;
    },
    get retryStatusText() {
      return retryStatusText;
    },
    get reasoningActive() {
      return activeReasoningDetail !== undefined;
    },
    restore,
    notice: appendNotice,
    event(event: AgentEvent) {
      if (
        event.memberSessionId === undefined &&
        ["message_update", "reasoning_start", "tool_preparation", "tool_execution_start"].includes(
          event.type,
        )
      )
        retryStatusText = null;
      switch (event.type) {
        case "input_queued":
        case "input_consumed":
        case "input_discarded": {
          const notice = eventNotice(event);
          if (notice) appendNotice(notice.title, notice.text);
          break;
        }
        case "session_unavailable": {
          finishUnresolvedTools(options.state().sessionId, undefined, event.error);
          finishActiveTurn("failed");
          retryStatusText = null;
          activeAssistantView = undefined;
          activeReasoningDetail = undefined;
          const notice = eventNotice(event);
          if (notice) appendNotice(notice.title, notice.text);
          break;
        }
        case "collaboration_changed":
          synchronizeMembers(event.snapshot);
          break;
        case "message_start":
          retryStatusText = null;
          if (event.message.role === "assistant") renderedAssistantTextPrefix = "";
          appendMessage(event.message);
          break;
        case "message_update":
          updateAssistant(event.message);
          break;
        case "message_end":
          if (event.message.role === "assistant") {
            updateAssistant(event.message);
            readyTools(event.message);
            activeAssistantView = undefined;
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
          activeReasoningDetail = createDetail(
            `reasoning:${event.runId}:${details.length}`,
            "Reasoning",
            "",
          );
          activeReasoningDetail.step.title = "Reasoning · 思考中";
          break;
        }
        case "reasoning_update":
          if (activeReasoningDetail !== undefined) {
            appendDetail(activeReasoningDetail, event.delta);
            activeReasoningDetail.step.title = `Reasoning · ${((now() - activeReasoningDetail.startedAt) / 1000).toFixed(1)}s`;
          }
          break;
        case "reasoning_end":
          if (activeReasoningDetail !== undefined) {
            activeReasoningDetail.endedAt = now();
            activeReasoningDetail.step.title = `Reasoning · 已思考 ${((activeReasoningDetail.endedAt - activeReasoningDetail.startedAt) / 1000).toFixed(1)}s`;
            activeReasoningDetail.step.expanded = false;
            activeReasoningDetail = undefined;
            invalidateConversation();
          }
          break;
        case "tool_preparation": {
          const detail = ensureTool(event.toolCallId, event.toolName, event);
          moveDetail(detail);
          if (detail.toolStage === "retry") delete detail.endedAt;
          detail.toolStage = event.phase;
          const preparation = toolPreparationText(event.phase);
          detail.step.title = `${detail.stepTitle} · ${preparation.status}`;
          detail.step.summary = preparation.detail;
          invalidateConversation();
          break;
        }
        case "tool_auto_review_start": {
          const detail = ensureTool(event.toolCallId, event.toolName, event);
          moveDetail(detail);
          detail.step.title = `${detail.stepTitle} · 自动审核中`;
          detail.step.summary = "正在核对本次动作的授权；Ctrl+C 可停止。";
          invalidateConversation();
          break;
        }
        case "tool_execution_start": {
          const { activity } = event;
          const detail = ensureTool(activity.toolCallId, activity.toolName, event);
          appendDetail(detail, `\n${activity.summary}`);
          detail.toolStage = "running";
          detail.step.title = `${detail.stepTitle} · 运行中`;
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
            appendExecutionText("资源状态", "Tool 资源清理结果不确定，请查看详情。", event);
          break;
        case "tool_approval_requested":
          {
            const pendingToolApprovalRequest = event.request;
            const detail = ensureTool(
              pendingToolApprovalRequest.toolCallId,
              pendingToolApprovalRequest.toolName,
              pendingToolApprovalRequest,
            );
            moveDetail(detail);
            detail.toolStage = "approval";
            detail.step.title = `${detail.stepTitle} · 等待批准`;
            detail.step.summary = `${sanitizeTerminalText(pendingToolApprovalRequest.target)}\n${sanitizeTerminalText(pendingToolApprovalRequest.riskSummary)}\n/approval 查看动作、来源和授权边界`;
            invalidateConversation();
          }
          break;
        case "tool_approval_resolved":
          {
            const detail = ensureTool(
              event.request.toolCallId,
              event.request.toolName,
              event.request,
            );
            moveDetail(detail);
            detail.step.title = `${detail.stepTitle} · ${event.decision === "approve" ? "批准后复核" : event.decision === "deny" ? "已拒绝" : "审批已失效"}`;
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
          const source = authorizationSourceName(event.source);
          detail.authorization = source;
          appendDetail(detail, `\n授权来源：${source} · ${event.reason}`);
          detail.step.summary = `授权来源：${source}\n${sanitizeTerminalText(event.reason)}`;
          break;
        }
        case "model_retry": {
          const recovery = formatModelRecovery(event);
          if (event.phase === "requesting" && event.recoveryKind !== "approval") {
            for (const detail of toolDetails.values()) {
              if (
                !detail.id.startsWith(`${event.memberSessionId ?? options.state().sessionId}:`) ||
                (detail.runId !== undefined && detail.runId !== event.runId) ||
                detail.toolStage !== "input"
              )
                continue;
              detail.toolStage = "retry";
              detail.endedAt = now();
              detail.step.title = `${detail.stepTitle} · 准备已中断`;
              detail.step.summary = "上次请求未形成完整工具参数，未执行；正在重试模型请求。";
              detail.step.expanded = false;
            }
            invalidateConversation();
          }
          if (event.memberSessionId === undefined) retryStatusText = recovery.status;
          const notice = eventNotice(event);
          if (notice) appendNotice(notice.title, notice.text, event);
          break;
        }
        case "compaction_start":
        case "compaction_end":
        case "compaction_failed": {
          const notice = eventNotice(event);
          if (notice) appendExecutionText(notice.title, notice.text, event);
          break;
        }
        case "run_end":
          if (event.memberSessionId !== undefined) {
            finishUnresolvedTools(event.memberSessionId, event.runId, event.diagnostic?.summary);
            const member = ensureMember(event.memberSessionId, event.memberName);
            const turn = ensureTurn(event);
            turn.finish(event.result.status);
            const notice = eventNotice(event);
            if (notice && turn === [...member.runs.values()].at(-1))
              member.noticeText = sanitizeTerminalText(notice.text);
            invalidateConversation();
            break;
          }
          retryStatusText = null;
          finishUnresolvedTools(options.state().sessionId, event.runId);
          finishActiveTurn(event.result.status);
          activeAssistantView = undefined;
          activeReasoningDetail = undefined;
          invalidateConversation();
          {
            const notice = eventNotice(event);
            if (notice) appendNotice(notice.title, notice.text);
          }
          break;
      }
    },
    close() {
      for (const content of markdownContents) content.close();
      markdownContents.clear();
    },
  };
}

function summarizeText(text: string, maxLines = 3, maxCharacters = 300): string {
  const lines = text.trim().split("\n");
  const summary = lines.slice(0, maxLines).join("\n").slice(0, maxCharacters);
  return summary.length < text.trim().length ? summary + "\n…" : summary;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}
