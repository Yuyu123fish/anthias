import type {
  AgentEvent,
  AgentState,
  FinishedPromptResult,
  PromptOptions,
  PromptResult,
} from "../src/agent.js";

type PromptAgent = Readonly<{
  state: AgentState;
  prompt(text: string, options?: PromptOptions): Promise<PromptResult>;
  subscribe(listener: (event: AgentEvent) => void): () => void;
}>;

/** 旧执行场景显式等到其输入对应的 Run 终态；回执与队列场景直接测试 prompt。 */
export async function promptToCompletion(
  agent: PromptAgent,
  text: string,
  options: PromptOptions = { resume: true },
): Promise<FinishedPromptResult | Extract<PromptResult, { status: "rejected" }>> {
  const completion = Promise.withResolvers<FinishedPromptResult>();
  const consumed = new Map<string, string>();
  const finished = new Map<string, FinishedPromptResult>();
  let inputId: string | undefined;
  const resolveCompletion = () => {
    const runId = inputId ? consumed.get(inputId) : undefined;
    const result = runId ? finished.get(runId) : undefined;
    if (result) completion.resolve(result);
  };
  const unsubscribe = agent.subscribe((event) => {
    if (event.memberSessionId) return;
    if (event.type === "input_consumed") consumed.set(event.inputId, event.runId);
    else if (event.type === "run_end") finished.set(event.runId, event.result);
    else if (event.type === "session_unavailable")
      completion.resolve({ status: "failed", error: event.error });
    resolveCompletion();
  });
  try {
    const receipt = await agent.prompt(text, options);
    if (receipt.status === "rejected")
      return receipt.reason === "session_unavailable"
        ? { status: "failed", error: agent.state.lastError ?? "Session 不可继续。" }
        : receipt;
    inputId = receipt.inputId;
    resolveCompletion();
    const result = await completion.promise;
    // run_end 是已持久终态；下一步会话控制还须等拥有者完成当前微任务的资源交接。
    await new Promise<void>((resolve) => setImmediate(resolve));
    return result;
  } finally {
    unsubscribe();
  }
}
