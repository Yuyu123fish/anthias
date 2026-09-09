import type { CollaborationSnapshot, MemberSummary } from "@anthias/agent";
import { describe, expect, it, vi } from "vitest";
import { runCollaborationCommand } from "../src/multi-agent-view.js";
import { createFakeAgent } from "./fixtures.js";

function member(change: Partial<MemberSummary> = {}): MemberSummary {
  return {
    sessionId: "member-1",
    name: "Checker",
    kind: "subagent",
    status: "closed",
    workspaceRoot: process.cwd(),
    writable: false,
    task: "Check the saved result",
    result: "Existing verification result",
    ...change,
  };
}

function setup(members = [member()]) {
  const fake = createFakeAgent();
  const snapshot: CollaborationSnapshot = {
    rootSessionId: fake.agent.state.sessionId,
    members,
    team: null,
    tasks: [],
  };
  vi.mocked(fake.agent.collaboration.snapshot).mockReturnValue(snapshot);
  const notice = vi.fn<(text: string) => void>();
  return { ...fake, snapshot, notice };
}

function expectReadOnly(agent: ReturnType<typeof setup>["agent"]): void {
  expect(agent.prompt).not.toHaveBeenCalled();
  expect(agent.abort).not.toHaveBeenCalled();
  expect(agent.sessions.open).not.toHaveBeenCalled();
  expect(agent.sessions.create).not.toHaveBeenCalled();
}

describe("member result presentation", () => {
  it("shows root ownership and explicit missing facts without starting members", async () => {
    const { agent, notice } = setup([
      member({ name: " ", result: "", status: "failed", error: "Member log is missing" }),
      member({ sessionId: "member-2", name: "Reviewer", kind: "teammate" }),
    ]);
    expect(await runCollaborationCommand("agents", "", agent, notice)).toEqual({ kind: "handled" });
    const text = notice.mock.calls[0]?.[0] ?? "";
    expect(text).toContain("主 Agent · 根 Session：" + agent.state.sessionId);
    expect(text).toContain("member-1 · subagent · 失败");
    expect(text).toContain("尚无结果摘要。");
    expect(text).toContain("Member log is missing");
    expect(text).toContain("Reviewer · teammate · 已释放");
    expect(text).toContain("Check the saved result");
    expect(text).toContain("Existing verification result");
    expect(agent.collaboration.execute).not.toHaveBeenCalled();
    expectReadOnly(agent);
  });

  it("keeps result and artifact reads attached to the captured root and member", async () => {
    const { agent, setState, notice, snapshot } = setup();
    let finishRead: ((value: { ok: true; value: string }) => void) | undefined;
    vi.mocked(agent.collaboration.execute).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    const pending = runCollaborationCommand("agent", "result member-1", agent, notice);
    setState({ sessionId: "another-root" });
    finishRead?.({
      ok: true,
      value: JSON.stringify({
        memberSessionId: "member-1",
        status: "closed",
        history: "Saved tool result",
        nextOffset: null,
        artifacts: [{ artifactId: "artifact-1" }],
      }),
    });
    expect(await pending).toEqual({ kind: "handled" });
    const resultText = notice.mock.calls[0]?.[0] ?? "";
    expect(resultText).toContain("根 Session：" + snapshot.rootSessionId);
    expect(resultText).not.toContain("another-root");
    expect(resultText).toContain("成员 Checker [member-1]");
    expect(resultText).toContain("种类：subagent\n状态：已释放\n任务：Check the saved result");
    expect(resultText).toContain("尚无结果摘要。");
    expect(resultText).toContain("Saved tool result");
    expect(resultText).toContain("artifact-1");

    vi.mocked(agent.collaboration.execute).mockResolvedValueOnce({
      ok: true,
      value: JSON.stringify({ content: "Existing artifact content", nextCursor: null }),
    });
    expect(
      await runCollaborationCommand("agent", "artifact member-1 artifact-1", agent, notice),
    ).toEqual({ kind: "handled" });
    expect(notice.mock.calls[1]?.[0]).toContain("产物：artifact-1");
    expect(notice.mock.calls[1]?.[0]).toContain("成员 Checker [member-1]");
    expect(notice.mock.calls[1]?.[0]).toContain("Existing artifact content");
    expect(agent.collaboration.execute).toHaveBeenNthCalledWith(1, {
      action: "result",
      memberId: "member-1",
    });
    expect(agent.collaboration.execute).toHaveBeenNthCalledWith(2, {
      action: "result",
      memberId: "member-1",
      artifactId: "artifact-1",
    });
    expectReadOnly(agent);
  });

  it.each(["result member-1", "artifact member-1 artifact-missing"])(
    "keeps an explicit failure attributable when reading %s",
    async (args) => {
      const { agent, notice } = setup([member({ name: "", status: "interrupted", result: "" })]);
      vi.mocked(agent.collaboration.execute).mockResolvedValueOnce({
        ok: false,
        error: "Member history or artifact is unavailable",
      });
      expect(await runCollaborationCommand("agent", args, agent, notice)).toEqual({
        kind: "rejected",
      });
      const text = notice.mock.calls[0]?.[0] ?? "";
      expect(text).toContain("根 Session：" + agent.state.sessionId);
      expect(text).toContain("成员 member-1 [member-1]");
      expect(text).toContain("状态：已中断");
      expect(text).toContain("Member history or artifact is unavailable");
      expect(text).not.toContain("已完成");
      if (args.startsWith("artifact")) expect(text).toContain("产物：artifact-missing");
      expectReadOnly(agent);
    },
  );

  it("keeps ownership when the read rejects before returning a result", async () => {
    const { agent, notice } = setup();
    vi.mocked(agent.collaboration.execute).mockRejectedValueOnce(new Error("Broken member log"));
    expect(await runCollaborationCommand("agent", "result member-unknown", agent, notice)).toEqual({
      kind: "rejected",
    });
    expect(notice).toHaveBeenCalledWith(
      expect.stringContaining("根 Session：" + agent.state.sessionId),
    );
    expect(notice).toHaveBeenCalledWith(
      expect.stringContaining("成员 member-unknown [member-unknown]"),
    );
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("Broken member log"));
    expectReadOnly(agent);
  });
});
