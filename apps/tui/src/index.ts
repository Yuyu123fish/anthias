import { createInterface } from "node:readline";
import type { Agent, AgentEvent } from "@anthias/agent";

export type TuiSignalSource = Readonly<{
  on(event: "SIGINT", listener: () => void): void;
  off(event: "SIGINT", listener: () => void): void;
}>;

export type RunTuiOptions = Readonly<{
  agent: Agent;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  signals?: TuiSignalSource;
}>;

const INPUT_PROMPT = "anthias> ";

/** 运行单进程行式 TUI，并在退出前中止活动请求、取消订阅和移除信号监听器。 */
export function runTui({
  agent,
  input = process.stdin,
  output = process.stdout,
  signals = process,
}: RunTuiOptions): Promise<number> {
  const readline = createInterface({ input, output, terminal: false });
  const done = Promise.withResolvers<number>();
  let pendingPrompt: Promise<unknown> | null = null;
  let exitStarted = false;

  const unsubscribe = agent.subscribe((event) => renderEvent(event, output));

  const onSigint = () => {
    if (agent.state.running) {
      agent.abort();
      return;
    }
    void requestExit();
  };

  async function requestExit(): Promise<void> {
    if (exitStarted) {
      return;
    }
    exitStarted = true;
    agent.abort();
    readline.close();

    try {
      await pendingPrompt;
    } finally {
      unsubscribe();
      signals.off("SIGINT", onSigint);
      done.resolve(0);
    }
  }

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
      writePrompt(output);
      return;
    }
    if (agent.state.running) {
      output.write("当前响应仍在生成，请先停止。\n");
      return;
    }

    const execution = agent.prompt(line);
    pendingPrompt = execution;
    const result = await execution;
    if (pendingPrompt === execution) {
      pendingPrompt = null;
    }

    if (result.status === "rejected") {
      output.write(result.reason === "empty" ? "请输入非空提示词。\n" : "当前响应仍在生成。\n");
    }
    if (!exitStarted) {
      writePrompt(output);
    }
  }

  signals.on("SIGINT", onSigint);
  readline.on("line", (line) => {
    void handleLine(line);
  });
  readline.on("close", () => {
    void requestExit();
  });

  writePrompt(output);
  return done.promise;
}

function renderEvent(event: AgentEvent, output: NodeJS.WritableStream): void {
  switch (event.type) {
    case "agent_start":
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
    case "agent_end":
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

function writePrompt(output: NodeJS.WritableStream): void {
  output.write(INPUT_PROMPT);
}
