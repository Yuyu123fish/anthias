import { link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentWithModelStream } from "../src/agent.js";
import type { AssistantToolCallPart } from "../src/message.js";
import type { ModelStream } from "../src/model/model-stream.js";
import { createWorkspacePermissions } from "../src/permission/workspace-permissions.js";
import { createSession } from "../src/session/index.js";
import type { ToolApprovalPlan } from "../src/tool/tool-runner.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});
async function fixture() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-grants-"));
  cleanup.push(() => rm(workspaceRoot, { recursive: true, force: true }));
  return { workspaceRoot, directory: join(workspaceRoot, ".permissions") };
}
function call(toolName: string, input: AssistantToolCallPart["input"]): AssistantToolCallPart {
  return { type: "tool_call", toolCallId: "call", toolName, input, invalid: false };
}
function approval(toolName: string, target: string, ruleId: string): ToolApprovalPlan {
  return {
    toolName,
    target,
    ruleId,
    preview: "preview",
    riskSummary: "risk",
    executionBoundary: "boundary",
    deniedContent: "denied",
    actionFingerprint: "a".repeat(64),
  };
}
async function createAgentFixture(
  modelStream: ModelStream,
  mode: "agent" | "plan" | "auto_allow" = "auto_allow",
) {
  const location = await fixture();
  const session = await createSession({
    workspaceRoot: location.workspaceRoot,
    sessionDirectory: join(location.workspaceRoot, "sessions"),
    shell: {
      kind: "powershell",
      executable: `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      arguments: ["-NoProfile", "-NonInteractive", "-Command"],
    },
  });
  const agent = createAgentWithModelStream({
    session,
    modelStream,
    permissionMode: mode,
    permissionDirectory: location.directory,
    protectedPaths: [join(location.workspaceRoot, ".env")],
  });
  cleanup.push(() => agent.close());
  return { ...location, session, agent };
}
function writeSequence(
  paths: string[],
  onReview: () => void = () => {
    throw new Error("unexpected review");
  },
): ModelStream {
  let requestCount = 0;
  return async function* (request) {
    if (request.purpose === "approval") {
      onReview();
      return;
    }
    const path = paths[requestCount++];
    if (path !== undefined) {
      yield {
        type: "tool_call",
        toolCallId: `write-${requestCount}`,
        toolName: "write_file",
        input: { path, content: "saved" },
        invalid: false,
      };
      yield { type: "finish", finishReason: "tool_calls" };
    } else {
      yield { type: "text_delta", delta: "Finished." };
      yield { type: "finish", finishReason: "stop" };
    }
  };
}

describe("Workspace authorization", () => {
  it("remembers an exact workspace and matches only declared commands and registered member scope", async () => {
    const location = await fixture();
    const permissions = createWorkspacePermissions(location);
    expect((await permissions.grant({ remember: true, includeMembers: false })).ok).toBe(true);
    const reopened = createWorkspacePermissions(location);
    const commandApproval = approval(
      "execute_command",
      location.workspaceRoot,
      "command.current_user_review",
    );
    expect(
      reopened.matches(
        call("execute_command", { command: "pnpm check && pnpm test" }),
        commandApproval,
        location.workspaceRoot,
        false,
      ),
    ).toBe(true);
    for (const command of [
      "pnpm test --help",
      "pnpm test | powershell",
      "pnpm test & calc",
      "pnpm test; git push",
      "$cmd",
      "pwsh -c pnpm test",
    ]) {
      expect(
        reopened.matches(
          call("execute_command", { command }),
          commandApproval,
          location.workspaceRoot,
          false,
        ),
      ).toBe(false);
    }
    const fileCall = call("write_file", { path: "note.txt", content: "saved" });
    expect(
      reopened.matches(
        fileCall,
        approval("write_file", "note.txt", "file.workspace_exact_review"),
        location.workspaceRoot,
        false,
      ),
    ).toBe(true);
    expect(
      reopened.matches(
        fileCall,
        approval("write_file", "note.txt", "file.workspace_exact_review"),
        join(location.workspaceRoot, "other"),
        false,
      ),
    ).toBe(false);
    expect(
      reopened.matches(
        fileCall,
        approval("write_file", "note.txt", "file.external_exact_review"),
        location.workspaceRoot,
        false,
      ),
    ).toBe(false);
    expect(
      reopened.matches(
        fileCall,
        approval("write_file", "note.txt", "file.workspace_exact_review"),
        location.workspaceRoot,
        true,
      ),
    ).toBe(false);
    await permissions.grant({ remember: true, includeMembers: true });
    expect(
      reopened.matches(
        fileCall,
        approval("write_file", "note.txt", "file.workspace_exact_review"),
        join(location.workspaceRoot, "managed-member"),
        true,
      ),
    ).toBe(true);
    await permissions.revoke();
    expect(reopened.snapshot().revoked).toBe(true);
    expect(reopened.snapshot().grant).toBeNull();
  });

  it("revokes immediately while a preceding grant is still being saved", async () => {
    const location = await fixture();
    const permissions = createWorkspacePermissions(location);
    const pendingGrant = permissions.grant({ remember: true, includeMembers: true });
    const pendingRevocation = permissions.revoke();
    expect(permissions.snapshot().grant).toBeNull();
    expect(permissions.snapshot().revoked).toBe(true);
    await Promise.all([pendingGrant, pendingRevocation]);
    expect(createWorkspacePermissions(location).snapshot().revoked).toBe(true);
  });

  it("reports persistence failures without losing the current local decision", async () => {
    const location = await fixture();
    await writeFile(location.directory, "not a directory");
    const permissions = createWorkspacePermissions(location);
    expect((await permissions.grant({ remember: true, includeMembers: false })).ok).toBe(false);
    expect(permissions.snapshot().grant?.remember).toBe(false);
    expect((await permissions.revoke()).ok).toBe(false);
    expect(permissions.snapshot().revoked).toBe(true);
    expect(permissions.snapshot().grant).toBeNull();
  });

  it("executes successive workspace writes without model review or manual approval", async () => {
    const { agent, workspaceRoot, session } = await createAgentFixture(
      writeSequence(["one.txt", "two.txt"]),
    );
    let manualApprovals = 0;
    agent.subscribe((event) => {
      if (event.type === "tool_approval_requested") {
        manualApprovals++;
        agent.respondToToolApproval(event.request.toolApprovalRequestId, "deny");
      }
    });
    await agent.permissions.grant({ remember: true, includeMembers: false });
    expect(await agent.prompt("Write the two requested files.")).toEqual({ status: "completed" });
    expect(await readFile(join(workspaceRoot, "two.txt"), "utf8")).toBe("saved");
    expect(manualApprovals).toBe(0);
    expect(
      session.records.filter(
        (record) => record.type === "approval_decision" && record.decisionSource === "workspace",
      ),
    ).toHaveLength(2);
  });

  it("does not execute a saved approval after its workspace grant was revoked", async () => {
    const { agent, workspaceRoot } = await createAgentFixture(
      writeSequence(["must-not-exist.txt"]),
    );
    await agent.permissions.grant({ remember: true, includeMembers: false });
    let revocation: Promise<unknown> | undefined;
    // 授权事实已保存但开始事实尚未写入时撤销，覆盖事件同步重入的竞争窗口。
    agent.subscribe((event) => {
      if (event.type === "tool_authorization" && event.source === "workspace")
        revocation = agent.permissions.revoke();
    });
    await agent.prompt("Write the requested file.");
    await revocation;
    await expect(readFile(join(workspaceRoot, "must-not-exist.txt"))).rejects.toThrow();
    expect(agent.permissions.snapshot().revoked).toBe(true);
  });

  it.each(["agent", "plan"] as const)(
    "does not use a workspace grant to bypass %s mode",
    async (mode) => {
      const { agent, workspaceRoot } = await createAgentFixture(
        writeSequence(["denied.txt"]),
        mode,
      );
      let manualRequests = 0;
      agent.subscribe((event) => {
        if (event.type === "tool_approval_requested") {
          manualRequests++;
          agent.respondToToolApproval(event.request.toolApprovalRequestId, "deny");
        }
      });
      await agent.permissions.grant({ remember: false, includeMembers: true });
      await agent.prompt("Write a file.");
      expect(manualRequests).toBe(mode === "agent" ? 1 : 0);
      await expect(readFile(join(workspaceRoot, "denied.txt"))).rejects.toThrow();
    },
  );

  it("prevents fixed tools from changing the authorization directory", async () => {
    const { agent, directory } = await createAgentFixture(
      writeSequence([".permissions/forged.json"]),
    );
    await agent.permissions.grant({ remember: true, includeMembers: false });
    await agent.prompt("Write the requested file.");
    await expect(readFile(join(directory, "forged.json"))).rejects.toThrow();
    expect(
      agent.state.messageHistory.some(
        (message) =>
          message.role === "tool" &&
          message.status === "failed" &&
          message.content.includes("保留目录"),
      ),
    ).toBe(true);
  });
  it("keeps configuration contents and hard-link aliases out of tool results and history", async () => {
    let requestCount = 0;
    const { agent, session, workspaceRoot } = await createAgentFixture(async function* () {
      if (requestCount++ === 0) {
        for (const [index, toolCall] of [
          call("read_file", { path: ".env" }),
          call("read_file", { path: "alias.env" }),
          call("grep", { pattern: "API_KEY", path: ".", filePattern: "*.env" }),
          call("write_file", { path: ".env", content: "corruption" }),
        ].entries())
          yield { ...toolCall, type: "tool_call", toolCallId: String(index) };
        yield { type: "finish", finishReason: "tool_calls" };
      } else {
        yield { type: "text_delta", delta: "Finished." };
        yield { type: "finish", finishReason: "stop" };
      }
    });
    const syntheticKey = "configuration-fixture-do-not-forward";
    await writeFile(join(workspaceRoot, ".env"), "ANTHIAS_MODEL_API_KEY=" + syntheticKey);
    await link(join(workspaceRoot, ".env"), join(workspaceRoot, "alias.env"));
    await agent.permissions.grant({ remember: false, includeMembers: false });
    let manualRequests = 0;
    agent.subscribe((event) => {
      if (event.type === "tool_approval_requested") {
        manualRequests++;
        agent.respondToToolApproval(event.request.toolApprovalRequestId, "deny");
      }
    });
    await agent.prompt("Check configuration access boundaries.");
    expect(JSON.stringify(session.records)).not.toContain(syntheticKey);
    expect(await readFile(join(workspaceRoot, ".env"), "utf8")).toContain(syntheticKey);
    expect(manualRequests).toBe(0);
  });
});
