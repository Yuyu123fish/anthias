import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentWithModelStream } from "../src/agent.js";
import type { AssistantToolCallPart } from "../src/message.js";
import type { ModelStream } from "../src/model/model-stream.js";
import { createWorkspacePermissions } from "../src/permission/workspace-permissions.js";
import { createSession } from "../src/session/index.js";
import type { ToolApprovalPlan } from "../src/tool/tool-runner.js";
import { promptToCompletion } from "./prompt-helper.js";

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
    expect(await promptToCompletion(agent, "Write the two requested files.")).toEqual({
      status: "completed",
    });
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
    await promptToCompletion(agent, "Write the requested file.");
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
      await promptToCompletion(agent, "Write a file.");
      expect(manualRequests).toBe(mode === "agent" ? 1 : 0);
      await expect(readFile(join(workspaceRoot, "denied.txt"))).rejects.toThrow();
    },
  );

  it("prevents fixed tools from changing the authorization directory", async () => {
    const { agent, directory } = await createAgentFixture(
      writeSequence([".permissions/forged.json"]),
    );
    await agent.permissions.grant({ remember: true, includeMembers: false });
    await promptToCompletion(agent, "Write the requested file.");
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
    await promptToCompletion(agent, "Check configuration access boundaries.");
    expect(JSON.stringify(session.records)).not.toContain(syntheticKey);
    expect(await readFile(join(workspaceRoot, ".env"), "utf8")).toContain(syntheticKey);
    expect(manualRequests).toBe(0);
  });
});

it("remembers explicit prefixes and scopes each literal command to its exact directory", async () => {
  const location = await fixture();
  await mkdir(join(location.workspaceRoot, "app files"));
  const permissions = createWorkspacePermissions(location);
  const commands = [
    { command: "python -c", cwd: "app files", allowArguments: true },
    { command: "node --check demo.js", cwd: "app files" },
    { command: "Get-ChildItem", cwd: "app files", allowArguments: true },
    { command: "Select-Object Name", cwd: "app files" },
  ];
  expect((await permissions.grant({ remember: true, includeMembers: false, commands })).ok).toBe(
    true,
  );
  const reopened = createWorkspacePermissions(location);
  expect(reopened.snapshot().grant?.commands).toEqual(commands);
  const matches = (command: string, cwd = "app files") =>
    reopened.matches(
      call("execute_command", { command, cwd }),
      approval("execute_command", join(location.workspaceRoot, cwd), "command.current_user_review"),
      location.workspaceRoot,
      false,
    );
  expect(matches('python -c "print(1); print(2)"')).toBe(true);
  expect(matches('python -c "print(1)" && node --check demo.js')).toBe(true);
  expect(matches("Get-ChildItem . | Select-Object Name")).toBe(true);
  for (const command of [
    "python3 -c code",
    "python -m pip",
    "node --check demo.js --extra",
    "python -c code\rGet-Date",
    "python -c code\r\nGet-Date",
    "python -c code\u2028Get-Date",
    "python -c code; git push",
    "python -c code > output.txt",
    "python -c $script",
    "python -c code & calc",
    "python -c code | powershell",
    "python -c code || calc",
    "python -c @args",
    'python -c "unclosed',
  ])
    expect(matches(command), command).toBe(false);
  expect(matches("python -c code", ".")).toBe(false);
  await reopened.revoke();
  expect(matches("python -c code")).toBe(false);
});

it("rejects external directory aliases and never expands legacy command grants", async () => {
  const location = await fixture();
  const external = await fixture();
  await symlink(external.workspaceRoot, join(location.workspaceRoot, "external"), "junction");
  const permissions = createWorkspacePermissions(location);
  expect((await permissions.grant({ remember: true, includeMembers: false })).ok).toBe(true);
  const before = permissions.snapshot().grant;
  const oversized = await permissions.grant({
    remember: true,
    includeMembers: false,
    commands: Array.from({ length: 49 }, (_, index) => ({
      command: `python ${"文".repeat(1_900)}${index}`,
      cwd: ".",
    })),
  });
  expect(oversized.ok).toBe(false);
  expect(permissions.snapshot().grant).toEqual(before);
  const outside = await permissions.grant({
    remember: true,
    includeMembers: false,
    commands: [{ command: "python", cwd: "external", allowArguments: true }],
  });
  expect(outside.ok).toBe(false);
  expect(permissions.snapshot().grant).toEqual(before);
  expect(
    permissions.matches(
      call("execute_command", { command: "pnpm test --help" }),
      approval("execute_command", location.workspaceRoot, "command.current_user_review"),
      location.workspaceRoot,
      false,
    ),
  ).toBe(false);
  for (const command of ["git push", "Remove-Item .", "npm publish", "python -c x; node x"])
    expect(
      (
        await permissions.grant({
          remember: false,
          includeMembers: false,
          commands: [{ command, cwd: "." }],
        })
      ).ok,
    ).toBe(false);
});

it("rechecks a registered directory when it becomes an external junction", async () => {
  const location = await fixture();
  const external = await fixture();
  const directory = join(location.workspaceRoot, "checks");
  await mkdir(directory);
  const permissions = createWorkspacePermissions(location);
  await permissions.grant({
    remember: false,
    includeMembers: false,
    commands: [{ command: "python", cwd: "checks", allowArguments: true }],
  });
  await rm(directory, { recursive: true });
  await symlink(external.workspaceRoot, directory, "junction");
  expect(
    permissions.matches(
      call("execute_command", { command: "python check.py", cwd: "checks" }),
      approval("execute_command", external.workspaceRoot, "command.current_user_review"),
      location.workspaceRoot,
      false,
    ),
  ).toBe(false);
});

it("executes different literal arguments of an explicitly granted command without another approval", async () => {
  let count = 0;
  const { agent, session } = await createAgentFixture(async function* (request) {
    if (request.purpose === "approval") throw new Error("unexpected model approval");
    if (++count <= 2) {
      yield {
        type: "tool_call",
        toolCallId: "command-" + count,
        toolName: "execute_command",
        input: { command: "Write-Output result" + count, cwd: "." },
        invalid: false,
      };
      yield { type: "finish", finishReason: "tool_calls" };
    } else {
      yield { type: "text_delta", delta: "Finished." };
      yield { type: "finish", finishReason: "stop" };
    }
  });
  await agent.permissions.grant({
    remember: false,
    includeMembers: false,
    commands: [{ command: "Write-Output", cwd: ".", allowArguments: true }],
  });
  let manualApprovals = 0;
  agent.subscribe((event) => {
    if (event.type === "tool_approval_requested") manualApprovals++;
  });
  expect((await promptToCompletion(agent, "检查两次输出")).status).toBe("completed");
  expect(manualApprovals).toBe(0);
  expect(
    session.records
      .filter((record) => record.type === "approval_decision")
      .map((record) => record.decisionSource),
  ).toEqual(["workspace", "workspace"]);
});
