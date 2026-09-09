import { createInterface, type Interface } from "node:readline";
import type {
  Agent,
  AgentEvent,
  CollaborationSnapshot,
  Message,
  WorkspacePermissionSnapshot,
} from "@anthias/agent";
import type { Terminal } from "@earendil-works/pi-tui";
import { executeCommand, parseInput } from "./command.js";
import {
  type CodeHighlighter,
  detectTerminalCapabilities,
  sanitizeTerminalText,
  type TerminalCapabilities,
} from "./content-renderer.js";
import { formatRunDiagnostic } from "./diagnostic-view.js";
import {
  authorizationSourceName,
  eventNotice,
  eventSourceLabel,
  toolPreparationText,
  toolResultStatus,
} from "./event-text.js";
import { formatCollaboration } from "./multi-agent-view.js";
import {
  formatPermissions,
  type PermissionGrantChoice,
  permissionModeLabel,
  permissionModeNotice,
} from "./permission-view.js";
import { createTerminal } from "./terminal.js";
import {
  type ConversationView,
  createConversationView,
  formatApproval,
  isApprovalDisplayable,
} from "./view.js";

export type TuiSignalSource = Readonly<{
  on(event: "SIGINT", listener: () => void): void;
  off(event: "SIGINT", listener: () => void): void;
}>;

export type RunTuiOptions = Readonly<{
  agent: Agent;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  signalSource?: TuiSignalSource;
  terminalCapabilities?: TerminalCapabilities;
  terminal?: Terminal;
  now?: () => number;
  codeHighlighter?: CodeHighlighter;
}>;

/** 输入与呈现共用 Agent 行为；关闭等待业务资源和终端恢复完成。 */
export function runTui(options: RunTuiOptions): Promise<number> {
  const { agent } = options;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const signalSource = options.signalSource ?? process;
  const interactive = options.terminal !== undefined || (isTty(input) && isTty(output));
  const tuiExitPromiseResolvers = Promise.withResolvers<number>();
  let view: ConversationView | undefined;
  let readlineInterface: Interface | undefined;
  let exiting = false;
  let exitCode = 0;
  let plainAssistantStreaming = false;
  let plainAssistantNeedsLabel = false;
  let plainDetailsVisible = false;
  let latestPlainDetails = "";
  let renderedPlainCollaboration = "";
  let submissionPending = false;
  let pendingWorkspaceGrantReview: { choice: PermissionGrantChoice; scope: string } | undefined;
  const renderedPlainToolResultIds = new Set<string>();
  let unsubscribe = () => {};

  function write(text: string): void {
    try {
      output.write(sanitizeTerminalText(text));
    } catch {
      void exit(1);
    }
  }
  function notice(text: string, title = "Anthias"): void {
    if (exiting) return;
    if (view !== undefined) view.notice(text, title);
    else {
      if (plainAssistantStreaming) plainAssistantNeedsLabel = true;
      write(`\n${title}\n${text}\n`);
    }
  }
  function interrupt(): void {
    if (agent.state.running || agent.state.operation !== null) {
      agent.abort();
      notice("已请求停止，正在等待资源关闭。");
    } else void exit();
  }
  async function exit(code = 0): Promise<void> {
    exitCode = Math.max(exitCode, code);
    if (exiting) return;
    exiting = true;
    unsubscribe();
    signalSource.off("SIGINT", interrupt);
    input.off("end", eof);
    input.off("error", inputFailure);
    output.off("error", inputFailure);
    readlineInterface?.close();
    try {
      await agent.close();
    } catch {
      exitCode = 1;
    }
    try {
      await view?.close();
    } catch {
      exitCode = 1;
    }
    tuiExitPromiseResolvers.resolve(exitCode);
  }
  function eof(): void {
    void exit();
  }
  function inputFailure(): void {
    void exit(1);
  }

  async function submit(text: string): Promise<boolean> {
    if (exiting) return true;
    const confirmation = text.trim().toLowerCase();
    if (
      pendingWorkspaceGrantReview !== undefined &&
      (confirmation === "grant" || confirmation === "cancel")
    ) {
      if (confirmation === "cancel") {
        pendingWorkspaceGrantReview = undefined;
        view?.reviewPermissions(null);
        notice("已取消，没有新增工作区授权。", "/permissions");
        return true;
      }
      if (agent.state.pendingToolApproval !== null) {
        pendingWorkspaceGrantReview = undefined;
        view?.reviewPermissions(null);
        notice(
          "当前有待执行的工具审批，请用 /approval 处理后重新查看授权范围。grant 不会批准当前动作。",
          "/permissions",
        );
        return true;
      }
      if (view !== undefined && !view.canGrantPermissions()) {
        notice("请完整浏览授权范围到底部，再输入 grant。也可输入 cancel 取消。", "/permissions");
        return true;
      }
      const currentSnapshot = agent.permissions.snapshot();
      if (pendingWorkspaceGrantReview.scope !== permissionScope(currentSnapshot)) {
        pendingWorkspaceGrantReview = undefined;
        view?.reviewPermissions(null);
        notice(
          "工作区或当前授权状态已变化，请重新执行 /permissions grant 或 /permissions command 查看范围。",
          "/permissions",
        );
        return true;
      }
      const choice = pendingWorkspaceGrantReview.choice;
      pendingWorkspaceGrantReview = undefined;
      view?.reviewPermissions(null);
      try {
        const result = await agent.permissions.grant(choice);
        notice(
          result.ok
            ? `工作区授权已生效${result.value.grant?.remember ? "并记住" : "，仅本次会话"}。仅 auto_allow 模式采用该授权。`
            : result.error,
          "/permissions",
        );
        if (!result.ok)
          notice(
            formatPermissions(agent.permissions.snapshot(), agent.state.permissionMode),
            "/permissions 当前状态",
          );
      } catch {
        notice("授权操作未完成，请查看 /permissions 核对当前实际范围。", "/permissions");
      }
      return true;
    }
    const pendingToolApprovalRequest = agent.state.pendingToolApproval;
    const approvalAnswer = text.trim().toLowerCase();
    if (pendingToolApprovalRequest !== null && approvalAnswer === "grant") {
      notice(
        "grant 不会批准当前工具动作；请用 /approval 查看后输入 approve 或 deny。",
        "/permissions",
      );
      return true;
    }
    if (
      pendingToolApprovalRequest !== null &&
      (approvalAnswer === "approve" || approvalAnswer === "deny")
    ) {
      if (
        approvalAnswer === "approve" &&
        (!isApprovalDisplayable(pendingToolApprovalRequest) ||
          (view !== undefined && !view.canApprove()))
      ) {
        notice(
          "请先使用 /approval 浏览完整审批详情到底部；空间不足时请放大终端。也可以输入 deny 拒绝。",
        );
        return true;
      }
      const result = agent.respondToToolApproval(
        pendingToolApprovalRequest.toolApprovalRequestId,
        approvalAnswer,
      );
      if (result.status === "rejected") notice("该审批已失效，请查看当前请求。");
      return true;
    }
    const parsed = parseInput(text);
    try {
      let promptText: string;
      if (parsed.type === "command") {
        const title = `/${parsed.name}`;
        if (parsed.name === "permissions" && parsed.argumentsText.trim() === "revoke") {
          pendingWorkspaceGrantReview = undefined;
          view?.reviewPermissions(null);
        }
        if (
          ["compact", "new", "agent", "team", "git"].includes(parsed.name) ||
          parsed.name.startsWith("skill:") ||
          (["mcp", "resume", "skills"].includes(parsed.name) && parsed.argumentsText.trim())
        )
          notice("正在执行；Ctrl+C 可停止活动操作。", title);
        const commandResult = await executeCommand(parsed, {
          agent,
          notice: (message) => notice(message, title),
          recoverDraft() {
            if (view !== undefined) view.recoverDraft();
            else notice("非交互输入不能编辑草稿，请重新输入上一条任务。", "/draft");
          },
          approval() {
            if (view !== undefined) view.showApproval();
            else {
              const currentToolApprovalRequest = agent.state.pendingToolApproval;
              notice(
                currentToolApprovalRequest === null
                  ? "当前没有待批准请求。"
                  : formatApproval(currentToolApprovalRequest),
                "/approval",
              );
            }
          },
          permissions(choice) {
            if (agent.state.pendingToolApproval !== null) {
              pendingWorkspaceGrantReview = undefined;
              view?.reviewPermissions(null);
              notice(
                "当前有待执行的工具审批，请先用 /approval 处理；新增工作区授权不会批准当前动作。",
                "/permissions",
              );
              return false;
            }
            const snapshot = agent.permissions.snapshot();
            pendingWorkspaceGrantReview = {
              choice,
              scope: permissionScope(snapshot),
            };
            const text = formatPermissions(snapshot, agent.state.permissionMode, choice);
            if (view !== undefined) view.reviewPermissions(text);
            else notice(text, "/permissions");
            return true;
          },
          details(direction) {
            if (view !== undefined) view.details(direction);
            else {
              plainDetailsVisible = direction === undefined ? !plainDetailsVisible : true;
              notice(
                plainDetailsVisible
                  ? latestPlainDetails || "当前没有可显示的详情。"
                  : "详情已关闭。",
              );
            }
          },
          exit: () => {
            void exit();
          },
        });
        if (commandResult.kind !== "prompt") return commandResult.kind === "handled";
        promptText = commandResult.text;
      } else promptText = parsed.text;
      if (exiting) return true;
      if (submissionPending) {
        notice("Agent 正在处理当前输入，请等待完成或按 Ctrl+C 停止；本条输入未排队。");
        return false;
      }
      submissionPending = true;
      try {
        const result = await agent.prompt(promptText);
        if (result.status === "rejected") {
          const reasons = {
            empty: "请输入任务或 /help。",
            busy: "Agent 正在运行，本条输入未排队。",
            session_busy: "此会话被其他运行占用。",
            session_changed: "会话已经切换，请核对当前会话。",
            closed: "Agent 已关闭。",
          };
          notice(`当前输入未接受：${reasons[result.reason]}`);
          return false;
        }
        return true;
      } finally {
        submissionPending = false;
      }
    } catch {
      notice("操作失败，当前会话仍可继续使用。");
      return false;
    }
  }

  function plainMessage(message: Message): void {
    if (message.role === "user") write(`\nYou\n${message.content}\n`);
    else if (message.role === "assistant") {
      write(
        `\n><> Anthias\n${message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("")}\n`,
      );
    } else plainToolResult(message);
  }
  function plainToolResult(
    message: Extract<Message, { role: "tool" }>,
    memberSessionId?: string,
    memberName?: string,
  ): void {
    const identity = `${memberSessionId ?? agent.state.sessionId}:${message.toolCallId}`;
    if (renderedPlainToolResultIds.has(identity)) return;
    renderedPlainToolResultIds.add(identity);
    const member = memberSessionId ? ` · 成员 ${memberName ?? memberSessionId}` : "";
    const status = toolResultStatus(message.status);
    write(
      `\n${message.toolName} [${message.toolCallId.slice(-8)}]${member} · ${status}\n${message.content.slice(0, 600)}${message.content.length > 600 ? "\n… /details 查看完整预览" : ""}\n`,
    );
    latestPlainDetails = appendBounded(
      latestPlainDetails,
      `\n${message.toolName}${member}\n${message.content}`,
    );
  }
  function plainCollaboration(snapshot: CollaborationSnapshot | undefined): void {
    if (!snapshot) return;
    const text = formatCollaboration({
      ...snapshot,
      rootSessionId: snapshot.rootSessionId ?? agent.state.sessionId,
    });
    if (text === renderedPlainCollaboration) return;
    renderedPlainCollaboration = text;
    if (plainAssistantStreaming) plainAssistantNeedsLabel = true;
    write(`\n${text}\n`);
  }
  function plainEvent(event: AgentEvent): void {
    // 纯文本没有可折叠组件；成员过程留在有来源的详情与成员历史中，默认只打印概览和终态。
    const text = memberToolText(event);
    if (text !== null) {
      const source = eventSourceLabel(event);
      latestPlainDetails = appendBounded(latestPlainDetails, `\n${source}\n${text}\n`);
      if (plainDetailsVisible) {
        if (plainAssistantStreaming) plainAssistantNeedsLabel = true;
        write(`\n${source}\n${text}\n`);
      }
      return;
    }
    const notification = eventNotice(event);
    if (notification) {
      if (plainAssistantStreaming) plainAssistantNeedsLabel = true;
      write(`\n${notification.title}\n${notification.text}\n`);
      return;
    }
    switch (event.type) {
      case "collaboration_changed":
        plainCollaboration(event.snapshot);
        break;
      case "session_changed":
        pendingWorkspaceGrantReview = undefined;
        renderedPlainToolResultIds.clear();
        renderedPlainCollaboration = "";
        plainAssistantStreaming = false;
        plainAssistantNeedsLabel = false;
        write(
          `\n根会话 Session: ${agent.state.sessionId}\nWorkspace: ${agent.state.workspaceRoot}\nMode: ${permissionModeLabel(agent.state.permissionMode)}\n`,
        );
        for (const message of agent.state.messageHistory) plainMessage(message);
        plainCollaboration(agent.state.collaboration);
        latestPlainDetails = "";
        if (
          agent.state.lastRunDiagnostic?.category !== "completed" &&
          agent.state.lastRunDiagnostic != null
        )
          write(`\n${formatRunDiagnostic(agent.state.lastRunDiagnostic)}\n`);
        break;
      case "message_start":
        if (event.message.role === "assistant") {
          write("\n><> Anthias\n");
          plainAssistantStreaming = true;
          plainAssistantNeedsLabel = false;
        } else if (event.message.role === "user") plainMessage(event.message);
        break;
      case "message_update":
        if (plainAssistantNeedsLabel) {
          write("\n><> Anthias · 主 Agent（继续）\n");
          plainAssistantNeedsLabel = false;
        }
        write(event.delta);
        break;
      case "message_end":
        if (event.message.role === "assistant" && plainAssistantStreaming) {
          write("\n");
          plainAssistantStreaming = false;
        } else if (event.message.role === "tool") {
          plainMessage(event.message);
          if (plainDetailsVisible) write(`${event.message.content}\n`);
        }
        break;
      case "reasoning_start":
        latestPlainDetails = appendBounded(latestPlainDetails, "\n主 Agent · Reasoning\n");
        break;
      case "reasoning_update":
        latestPlainDetails = appendBounded(latestPlainDetails, event.delta);
        if (plainDetailsVisible) write(event.delta);
        break;
      case "reasoning_end":
        write("\nReasoning 已完成 · /details 查看\n");
        break;
      case "tool_preparation":
        write(
          `\n${event.toolName} [${event.toolCallId.slice(-8)}]${event.memberSessionId ? ` · 成员 ${event.memberName ?? event.memberSessionId}` : ""} · ${toolPreparationText(event.phase).status}\n`,
        );
        break;
      case "tool_execution_end":
        plainToolResult(event.result, event.memberSessionId, event.memberName);
        break;
      case "tool_execution_start":
        write(
          `\n${event.activity.toolName} [${event.activity.toolCallId.slice(-8)}] · 运行中\n${event.activity.summary}\n`,
        );
        break;
      case "tool_execution_update":
        latestPlainDetails = appendBounded(
          latestPlainDetails,
          `\n主 Agent · ${event.toolName} [${event.stream}] ${event.delta}`,
        );
        if (plainDetailsVisible)
          write(`${eventSourceLabel(event)} · [${event.stream}] ${event.delta}`);
        break;
      case "tool_approval_requested":
        if (plainAssistantStreaming) plainAssistantNeedsLabel = true;
        write(`\n${formatApproval(event.request)}\n`);
        break;
      case "tool_authorization":
        write(
          `\n授权 · ${authorizationSourceName(event.source)} · ${event.decision}\n${event.reason}\n`,
        );
        break;
    }
  }

  try {
    if (interactive) {
      view = createConversationView({
        agent,
        terminal: options.terminal ?? createTerminal(input, output),
        capabilities: options.terminalCapabilities ?? detectTerminalCapabilities(output),
        submit,
        interrupt,
        exit: () => {
          void exit();
        },
        failure: () => {
          void exit(1);
        },
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.codeHighlighter === undefined
          ? {}
          : { codeHighlighter: options.codeHighlighter }),
      });
    } else {
      write(
        `><> Anthias\n根会话 Session: ${agent.state.sessionId}\nWorkspace: ${agent.state.workspaceRoot}\nMode: ${permissionModeLabel(agent.state.permissionMode)}\n/help 查看命令\n`,
      );
      for (const message of agent.state.messageHistory) plainMessage(message);
      plainCollaboration(agent.state.collaboration);
      const permissionNotice = permissionModeNotice(
        agent.state.permissionMode,
        agent.permissions.snapshot(),
      );
      if (permissionNotice !== null) notice(permissionNotice, "权限模式");
      if (
        agent.state.lastRunDiagnostic?.category !== "completed" &&
        agent.state.lastRunDiagnostic != null
      )
        write(`\n${formatRunDiagnostic(agent.state.lastRunDiagnostic)}\n`);
      readlineInterface = createInterface({
        input,
        crlfDelay: Number.POSITIVE_INFINITY,
        terminal: false,
      });
      readlineInterface.on("line", (text) => {
        void submit(text);
      });
      readlineInterface.on("close", eof);
    }
    unsubscribe = agent.subscribe((event) => {
      if (exiting) return;
      try {
        if (event.type === "session_changed") pendingWorkspaceGrantReview = undefined;
        if (event.type === "tool_approval_requested" && pendingWorkspaceGrantReview !== undefined) {
          pendingWorkspaceGrantReview = undefined;
          view?.reviewPermissions(null);
          notice(
            "工具执行正在等待确认，已取消尚未确认的工作区授权；请用 /approval 处理后重新查看授权范围。",
            "/permissions",
          );
        }
        if (view === undefined) plainEvent(event);
        else view.event(event);
      } catch {
        void exit(1);
      }
    });
    signalSource.on("SIGINT", interrupt);
    input.on("end", eof);
    input.on("error", inputFailure);
    output.on("error", inputFailure);
    view?.start();
  } catch {
    void exit(1);
  }
  return tuiExitPromiseResolvers.promise;
}

function memberToolText(event: AgentEvent): string | null {
  if (!event.memberSessionId) return null;
  switch (event.type) {
    case "tool_execution_end":
      return `${event.toolName} · ${toolResultStatus(event.result.status)}\n${event.result.content}`;
    case "tool_execution_update":
      return `${event.toolName} [${event.stream}] ${event.delta}`;
    case "tool_execution_start":
      return `${event.activity.toolName} · 运行中\n${event.activity.summary}`;
    case "tool_authorization":
      return `${event.toolName} · ${authorizationSourceName(event.source)} · ${event.decision}\n${event.reason}`;
    case "tool_preparation":
      return `${event.toolName} · ${toolPreparationText(event.phase).status}`;
    case "tool_auto_review_start":
      return `${event.toolName} · 自动审核中`;
    default:
      return null;
  }
}

function appendBounded(previous: string, addition: string): string {
  const combined = previous + sanitizeTerminalText(addition);
  return combined.length > 128 * 1024
    ? `[较早详情已省略]\n${combined.slice(-128 * 1024)}`
    : combined;
}
function isTty(stream: NodeJS.ReadableStream | NodeJS.WritableStream): boolean {
  return (stream as { isTTY?: boolean }).isTTY === true;
}

/** 浏览后若授权或撤销状态改变，旧确认不能覆盖新的用户决定。 */
function permissionScope(snapshot: WorkspacePermissionSnapshot): string {
  return JSON.stringify([
    snapshot.workspaceRoot,
    snapshot.grant,
    snapshot.revoked,
    snapshot.availableCommands,
    snapshot.error,
  ]);
}
