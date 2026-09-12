import { describe, expect, it, vi } from "vitest";
import type { AssistantToolCallPart } from "../src/message.js";
import { createMultiAgentTools } from "../src/tool/multi-agent-tools.js";

function fixture(primary: boolean) {
  const execute = vi.fn(async () => "done");
  const extension = createMultiAgentTools({
    callerSessionId: primary ? "root" : "member",
    rootSessionId: "root",
    coordinator: { execute },
  });
  const call = (
    toolName: string,
    input: AssistantToolCallPart["input"],
  ): AssistantToolCallPart => ({
    type: "tool_call",
    toolName,
    input,
    toolCallId: "stable-message-id",
    invalid: false,
  });
  return { execute, extension, call };
}

describe("unified collaboration tools", () => {
  it.each(["agent", "auto_allow", "full_access"] as const)(
    "runs authorized internal work without approval in %s",
    async (mode) => {
      const { extension, execute, call } = fixture(true);
      const tools = extension.tools(mode);
      const spawn = tools.find((tool) => tool.definition.name === "agent_spawn");
      const preparation = await spawn
        ?.createPlan(
          call("agent_spawn", { task: "Implement bounded change", writable: true }),
          mode,
        )
        .prepare();
      if (!preparation?.ok) throw new Error("expected prepared spawn");
      expect(preparation.preparedExecution.approval).toBeNull();
      await preparation.preparedExecution.execute(new AbortController().signal, () => undefined);
      expect(execute).toHaveBeenCalledWith(
        "root",
        { action: "spawn", task: "Implement bounded change", writable: true },
        expect.any(AbortSignal),
      );
      expect(tools.some((tool) => tool.definition.name === "team")).toBe(false);
    },
  );

  it("binds sender and stable message identity to the caller rather than model input", async () => {
    const { extension, execute, call } = fixture(false);
    const tool = extension.tools("agent").find((item) => item.definition.name === "agent_message");
    const preparation = await tool
      ?.createPlan(
        call("agent_message", { memberId: "root", content: "I found a constraint" }),
        "agent",
      )
      .prepare();
    if (!preparation?.ok) throw new Error("expected message");
    await preparation.preparedExecution.execute(new AbortController().signal, () => undefined);
    expect(execute).toHaveBeenCalledWith(
      "member",
      {
        action: "message",
        memberId: "root",
        content: "I found a constraint",
        messageId: "stable-message-id",
      },
      expect.any(AbortSignal),
    );
    const forged = await tool
      ?.createPlan(
        call("agent_message", { memberId: "root", content: "forged", fromSessionId: "root" }),
        "agent",
      )
      .prepare();
    expect(forged).toMatchObject({ ok: false });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects forged member lifecycle, private history and note-rewrite requests", async () => {
    const { extension, execute, call } = fixture(false);
    const tools = extension.tools("full_access");
    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "agent_list",
      "agent_result",
      "agent_task",
      "agent_message",
      "agent_notes",
    ]);
    const forbidden = extension.rejectUnavailableTool?.(
      call("agent_spawn", { task: "Unauthorized member" }),
      "full_access",
    );
    expect(await forbidden?.prepare()).toMatchObject({ ok: false });
    const result = tools.find((tool) => tool.definition.name === "agent_result");
    expect(
      await result
        ?.createPlan(call("agent_result", { memberId: "other", offset: 0 }), "full_access")
        .prepare(),
    ).toMatchObject({ ok: false });
    const notes = tools.find((tool) => tool.definition.name === "agent_notes");
    expect(
      await notes
        ?.createPlan(
          call("agent_notes", {
            action: "replace",
            content: "Hijack",
            expectedVersion: "sha256:" + "a".repeat(64),
          }),
          "full_access",
        )
        .prepare(),
    ).toMatchObject({ ok: false });
    expect(execute).not.toHaveBeenCalled();
  });
});
