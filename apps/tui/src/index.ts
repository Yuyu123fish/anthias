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
      output.write(
        promptResult.reason === "empty" ? "请输入非空提示词。\n" : "当前响应仍在生成。\n",
      );
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
      } else {
        output.write("Assistant: ");
      }
      return;
    case "message_update":
      output.write(event.delta);
      return;
    case "message_end":
      if (event.message.role === "assistant") {
        output.write("\n");
      }
      return;
    case "run_end":
      if (event.result.status === "failed") {
        output.write(`错误：${event.result.error}\n`);
      } else if (event.result.status === "aborted") {
        output.write("已停止当前响应。\n");
      } else {
        output.write("已完成。\n");
      }
      return;
  }
}

/** TUI 只从 AgentState 呈现重开投影，不直接读取 Session 文件。 */
function renderInitialState(state: Agent["state"], output: NodeJS.WritableStream): void {
  output.write(`Session: ${state.sessionId}\n`);
  output.write(`Workspace: ${state.workspaceRoot}\n`);
  for (const message of state.messageHistory) {
    output.write(
      message.role === "user" ? `You: ${message.content}\n` : `Assistant: ${message.content}\n`,
    );
  }
}

/** 写出下一次终端输入提示。 */
function writeInputPrompt(output: NodeJS.WritableStream): void {
  output.write(INPUT_PROMPT);
}
