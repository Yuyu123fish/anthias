import { createInterface, type Interface } from "node:readline";
import type { Agent, AgentEvent, Message } from "@anthias/agent";
import type { Terminal } from "@earendil-works/pi-tui";
import { executeCommand, parseInput } from "./command.js";
import {
  type CodeHighlighter,
  detectTerminalCapabilities,
  sanitizeTerminalText,
  type TerminalCapabilities,
} from "./content-renderer.js";
import { collaborationStatus } from "./multi-agent-view.js";
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
  const completion = Promise.withResolvers<number>();
  let view: ConversationView | undefined;
  let readlineInterface: Interface | undefined;
  let exiting = false;
  let exitCode = 0;
  let plainAssistantStreaming = false;
  let plainDetailsVisible = false;
  let latestPlainDetails = "";
  let submissionPending = false;
  let unsubscribe = () => {};

  function write(text: string): void {
    try {
      output.write(sanitizeTerminalText(text));
    } catch {
      void exit(1);
    }
  }
  function notice(text: string): void {
    if (exiting) return;
    if (view !== undefined) view.notice(text);
    else write(`\n${text}\n`);
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
    agent.abort();
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
    completion.resolve(exitCode);
  }
  function eof(): void {
    void exit();
  }
  function inputFailure(): void {
    void exit(1);
  }

  async function submit(text: string): Promise<void> {
    if (exiting) return;
    const approval = agent.state.pendingToolApproval;
    const approvalAnswer = text.trim().toLowerCase();
    if (approval !== null && (approvalAnswer === "approve" || approvalAnswer === "deny")) {
      if (
        approvalAnswer === "approve" &&
        (!isApprovalDisplayable(approval) || (view !== undefined && !view.canApprove()))
      ) {
        notice("请先浏览完整审批详情到底部；空间不足时请放大终端。也可以输入 deny 拒绝。");
        return;
      }
      const result = agent.respondToToolApproval(approval.toolApprovalRequestId, approvalAnswer);
      if (result.status === "rejected") notice("该审批已失效，请查看当前请求。");
      return;
    }
    const parsed = parseInput(text);
    try {
      let promptText: string | undefined;
      if (parsed.type === "command") {
        promptText = await executeCommand(parsed, {
          agent,
          notice,
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
      } else promptText = parsed.text;
      if (promptText === undefined || exiting) return;
      if (submissionPending) {
        notice("Agent 正在处理当前输入，请等待完成或按 Ctrl+C 停止。");
        return;
      }
      submissionPending = true;
      try {
        const result = await agent.prompt(promptText);
        if (result.status === "rejected")
          notice(
            result.reason === "empty" ? "请输入任务或 /help。" : `当前输入未接受：${result.reason}`,
          );
      } finally {
        submissionPending = false;
      }
    } catch {
      notice("操作失败，当前会话仍可继续使用。");
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
    } else write(`\n${message.toolName} [${message.toolCallId.slice(-8)}] · ${message.status}\n`);
  }
  function plainEvent(event: AgentEvent): void {
    switch (event.type) {
      case "collaboration_changed":
        write("\n" + collaborationStatus(event.snapshot).replace(/^ · /u, "") + "\n");
        break;
      case "session_changed":
        write(
          `\nSession: ${agent.state.sessionId}\nWorkspace: ${agent.state.workspaceRoot}\nMode: ${{ agent: "Agent", plan: "Plan", auto_allow: "AutoAllow" }[agent.state.permissionMode]}\n`,
        );
        for (const message of agent.state.messageHistory) plainMessage(message);
        latestPlainDetails = "";
        break;
      case "message_start":
        if (event.message.role === "assistant") {
          write("\n><> Anthias\n");
          plainAssistantStreaming = true;
        } else if (event.message.role === "user") plainMessage(event.message);
        break;
      case "message_update":
        write(event.delta);
        break;
      case "message_end":
        if (event.message.role === "assistant" && plainAssistantStreaming) {
          write("\n");
          plainAssistantStreaming = false;
        } else if (event.message.role === "tool") {
          plainMessage(event.message);
          latestPlainDetails = appendBounded(
            latestPlainDetails,
            `\n${event.message.toolName}\n${event.message.content}`,
          );
          if (plainDetailsVisible) write(`${event.message.content}\n`);
        }
        break;
      case "reasoning_start":
        latestPlainDetails = appendBounded(latestPlainDetails, "\nReasoning\n");
        break;
      case "reasoning_update":
        latestPlainDetails = appendBounded(latestPlainDetails, event.delta);
        if (plainDetailsVisible) write(event.delta);
        break;
      case "reasoning_end":
        write("\nReasoning 已完成 · /details 查看\n");
        break;
      case "tool_execution_start":
        write(
          `\n${event.activity.toolName} [${event.activity.toolCallId.slice(-8)}] · 运行中\n${event.activity.summary}\n`,
        );
        break;
      case "tool_execution_update":
        latestPlainDetails = appendBounded(
          latestPlainDetails,
          `\n[${event.stream}] ${event.delta}`,
        );
        if (plainDetailsVisible) write(event.delta);
        break;
      case "tool_approval_requested":
        write(`\n${formatApproval(event.request)}\n`);
        break;
      case "tool_authorization":
        write(`\n授权 · ${event.source} · ${event.decision}\n${event.reason}\n`);
        break;
      case "compaction_start":
        write("\n正在压缩上下文。\n");
        break;
      case "compaction_end":
        write(`\n压缩完成 ${event.inputTokensBefore} -> ${event.inputTokensAfter} tokens\n`);
        break;
      case "compaction_failed":
        write(`\n${event.error}\n`);
        break;
      case "run_end":
        if (event.result.status === "failed") write(`\n${event.result.error}\n`);
        else if (event.result.status === "aborted") write("\n已停止。\n");
        break;
    }
  }

  try {
    if (interactive) {
      view = createConversationView({
        agent,
        terminal: options.terminal ?? createTerminal(input, output),
        capabilities: options.terminalCapabilities ?? detectTerminalCapabilities(output),
        submit: (text) => {
          void submit(text);
        },
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
        `><> Anthias\nSession: ${agent.state.sessionId}\nWorkspace: ${agent.state.workspaceRoot}\nMode: ${{ agent: "Agent", plan: "Plan", auto_allow: "AutoAllow" }[agent.state.permissionMode]}\n/help 查看命令\n`,
      );
      for (const message of agent.state.messageHistory) plainMessage(message);
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
  return completion.promise;
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
