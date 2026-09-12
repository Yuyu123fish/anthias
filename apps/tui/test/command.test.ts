import { describe, expect, it, vi } from "vitest";
import {
  commandHelp,
  createCommandAutocomplete,
  executeCommand,
  parseInput,
} from "../src/command.js";
import { createFakeAgent } from "./fixtures.js";

describe("slash commands", () => {
  it("routes memory management without creating a user prompt", async () => {
    const { agent } = createFakeAgent();
    const notice = vi.fn();
    for (const line of [
      "/memory",
      "/memory all",
      "/memory list user candidate",
      "/memory all experience review",
      "/memory show record",
      "/memory off",
      "/memory save user global 以后先给结论",
      "/memory forget record 2 no-send",
    ]) {
      const command = parseInput(line);
      if (command.type === "command")
        await expect(
          executeCommand(command, { agent, notice, details() {}, exit() {} }),
        ).resolves.toEqual({ kind: "handled" });
    }
    expect(agent.memory.query).toHaveBeenCalledWith({ status: "all", scope: "current" });
    expect(agent.memory.query).toHaveBeenCalledWith({
      kind: "user",
      status: "candidate",
      scope: "current",
    });
    expect(agent.memory.query).toHaveBeenCalledWith({
      kind: "experience",
      status: "review",
      scope: "all",
    });
    expect(agent.memory.execute).toHaveBeenCalledWith({ action: "settings", automatic: false });
    expect(agent.memory.execute).toHaveBeenCalledWith({
      action: "save",
      kind: "user",
      scope: "global",
      content: "以后先给结论",
    });
    expect(agent.memory.execute).toHaveBeenCalledWith({
      action: "forget",
      id: "record",
      revision: 2,
      stopSending: true,
    });
    expect(agent.prompt).not.toHaveBeenCalled();
    expect(commandHelp()).toContain("/memory");
  });

  it("preserves ordinary prompts and supports a literal leading slash", () => {
    expect(parseInput("read a/b and /help")).toEqual({
      type: "prompt",
      text: "read a/b and /help",
    });
    expect(parseInput("//help")).toEqual({ type: "prompt", text: "/help" });
    expect(parseInput("/skill:typescript\ncheck the code\nkeep this line")).toEqual({
      type: "command",
      name: "skill:typescript",
      argumentsText: "check the code\nkeep this line",
    });
  });

  it("runs semantic controls and never leaks commands to prompt", async () => {
    const { agent } = createFakeAgent();
    const notice = vi.fn();
    const details = vi.fn();
    const exit = vi.fn();
    for (const line of [
      "/help",
      "/new",
      "/resume",
      "/resume saved-id",
      "/context",
      "/compact",
      "/mode auto_allow",
      "/skills",
      "/skills reload",
      "/skills clear",
      "/mcp",
      "/mcp connect local",
      "/mcp inspect local",
      "/mcp read local local://readme",
      '/mcp prompt local review {"path":"a file.ts"}',
      "/mcp disconnect local",
      "/details next",
      "/exit",
    ]) {
      const command = parseInput(line);
      if (command.type === "command")
        await expect(executeCommand(command, { agent, notice, details, exit })).resolves.toEqual({
          kind: "handled",
        });
    }
    expect(agent.prompt).not.toHaveBeenCalled();
    expect(agent.sessions.create).toHaveBeenCalledOnce();
    expect(agent.sessions.open).toHaveBeenCalledWith("saved-id");
    expect(agent.compact).toHaveBeenCalledOnce();
    expect(agent.skills.activate).toHaveBeenCalledWith(null);
    expect(agent.mcp.getPrompt).toHaveBeenCalledWith("local", "review", { path: "a file.ts" });
    expect(agent.mcp.readResource).toHaveBeenCalledWith("local", "local://readme");
    expect(details).toHaveBeenCalledWith("next");
    expect(exit).toHaveBeenCalledOnce();
    expect(notice.mock.calls.flat().join("\n")).toContain("外部上下文 200 · 工具定义 600");
  });

  it("does not claim to reload the current session", async () => {
    const { agent } = createFakeAgent();
    const notice = vi.fn();
    const command = parseInput(`/resume ${agent.state.sessionId}`);
    if (command.type !== "command") throw new Error("Expected a local command");
    await expect(
      executeCommand(command, { agent, notice, details() {}, exit() {} }),
    ).resolves.toEqual({ kind: "handled" });
    expect(agent.sessions.open).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith(
      expect.stringContaining(`请 /exit 后用 --session ${agent.state.sessionId} 重新启动`),
    );
    expect(notice.mock.calls.flat().join("\n")).not.toContain("会话已恢复");
  });

  it("rejects unknown commands and malformed arguments locally", async () => {
    const { agent } = createFakeAgent();
    const notice = vi.fn();
    for (const line of [
      "/not-a-command",
      "/new extra",
      "/resume one two",
      "/skills install",
      "/mode invalid",
      "/mcp read local",
      "/mcp prompt local review []",
      '/mcp prompt local review {"path":42}',
      "/details prev extra",
      "/skill:",
      "/memory list invalid",
      "/memory list user invalid",
      "/agents extra",
      "/agent spawn",
    ]) {
      const command = parseInput(line);
      if (command.type === "command")
        await expect(
          executeCommand(command, { agent, notice, details() {}, exit() {} }),
        ).resolves.toEqual({ kind: "rejected" });
    }
    expect(notice).toHaveBeenCalledTimes(14);
    expect(agent.sessions.create).not.toHaveBeenCalled();
    expect(agent.mcp.getPrompt).not.toHaveBeenCalled();
    expect(agent.skills.activate).not.toHaveBeenCalled();
    expect(agent.prompt).not.toHaveBeenCalled();
  });

  it("propagates rejected memory and collaboration operations without command fallthrough", async () => {
    const { agent } = createFakeAgent();
    const notice = vi.fn();
    vi.mocked(agent.memory.query).mockResolvedValueOnce({ ok: false, error: "memory unavailable" });
    vi.mocked(agent.collaboration.execute).mockResolvedValueOnce({
      ok: false,
      error: "member unavailable",
    });
    vi.mocked(agent.git.execute).mockResolvedValueOnce({ ok: false, error: "git unavailable" });
    for (const line of ["/memory", "/agent spawn inspect files", "/git status"]) {
      const command = parseInput(line);
      if (command.type !== "command") throw new Error("Expected a local command");
      await expect(
        executeCommand(command, { agent, notice, details() {}, exit() {} }),
      ).resolves.toEqual({ kind: "rejected" });
    }
    expect(notice.mock.calls.flat()).toEqual([
      "memory unavailable",
      "member unavailable",
      "git unavailable",
    ]);
    expect(agent.prompt).not.toHaveBeenCalled();
  });

  it("merges a literal command prefix with the existing reviewed scope", async () => {
    const { agent } = createFakeAgent();
    const existing = [{ command: "npm run lint", cwd: "." }];
    vi.mocked(agent.permissions.snapshot).mockReturnValue({
      workspaceRoot: agent.state.workspaceRoot,
      grant: { remember: true, includeMembers: true, files: true, commands: existing },
      revoked: false,
      availableCommands: [{ command: "pnpm test", cwd: "." }],
    });
    const permissions = vi.fn(() => true);
    const command = parseInput(
      '/permissions command --prefix --cwd "web app" -- python -u "check page.py"',
    );
    if (command.type !== "command") throw new Error("Expected a local command");
    const options = { agent, permissions, notice: vi.fn(), details() {}, exit() {} };
    await expect(executeCommand(command, options)).resolves.toEqual({ kind: "handled" });
    permissions.mockReturnValueOnce(false);
    await expect(executeCommand(command, options)).resolves.toEqual({ kind: "rejected" });
    expect(permissions).toHaveBeenCalledWith({
      remember: true,
      includeMembers: true,
      commands: [
        ...existing,
        { command: 'python -u "check page.py"', cwd: "web app", allowArguments: true },
      ],
    });
    expect(agent.permissions.grant).not.toHaveBeenCalled();
    expect(agent.prompt).not.toHaveBeenCalled();
  });

  it("starts command additions from the default scope and rejects malformed options", async () => {
    const { agent } = createFakeAgent();
    const permissions = vi.fn(() => true);
    const notice = vi.fn();
    const options = { agent, permissions, notice, details() {}, exit() {} };
    for (const line of [
      "/permissions command --remember --members --cwd 'web app' -- python \"check page.py\"",
      "/permissions command -- python validate.py",
    ]) {
      const command = parseInput(line);
      if (command.type === "command") await executeCommand(command, options);
    }
    expect(permissions).toHaveBeenNthCalledWith(1, {
      remember: true,
      includeMembers: true,
      commands: [
        { command: "pnpm test", cwd: "." },
        { command: 'python "check page.py"', cwd: "web app" },
      ],
    });
    expect(permissions).toHaveBeenNthCalledWith(2, {
      remember: false,
      includeMembers: false,
      commands: [
        { command: "pnpm test", cwd: "." },
        { command: "python validate.py", cwd: "." },
      ],
    });
    for (const line of [
      "/permissions command python validate.py",
      "/permissions command --prefix --prefix -- python",
      "/permissions command --remember --remember -- python",
      "/permissions command --cwd -- python",
      '/permissions command --cwd "web app -- python',
      "/permissions command --unknown -- python",
      "/permissions command --",
    ]) {
      const command = parseInput(line);
      if (command.type === "command") await executeCommand(command, options);
    }
    expect(permissions).toHaveBeenCalledTimes(2);
    expect(notice).toHaveBeenCalledTimes(7);
    expect(agent.permissions.grant).not.toHaveBeenCalled();
  });

  it("explains that auto review does not grant workspace permissions when switching modes", async () => {
    const { agent } = createFakeAgent();
    const notice = vi.fn();
    await executeCommand(
      { type: "command", name: "mode", argumentsText: "auto_allow" },
      { agent, notice, details() {}, exit() {} },
    );
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("自动审核不等于工作区授权"));
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("/permissions grant --remember"));
    expect(agent.permissions.grant).not.toHaveBeenCalled();
  });

  it("keeps FullAccess explicit when workspace authorization is revoked", async () => {
    const { agent } = createFakeAgent();
    const notice = vi.fn();
    const options = { agent, notice, details() {}, exit() {} };
    await executeCommand({ type: "command", name: "mode", argumentsText: "full_access" }, options);
    expect(agent.setPermissionMode).toHaveBeenCalledWith("full_access");
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("访问能力不等于任务授权"));
    await executeCommand(
      { type: "command", name: "permissions", argumentsText: "revoke" },
      options,
    );
    expect(agent.permissions.revoke).toHaveBeenCalledOnce();
    expect(agent.state.permissionMode).toBe("full_access");
    expect(notice).toHaveBeenLastCalledWith(expect.stringContaining("FullAccess 仍然生效"));
    vi.mocked(agent.permissions.revoke).mockResolvedValueOnce({
      ok: false,
      error: "revocation persistence failed",
    });
    await expect(
      executeCommand({ type: "command", name: "permissions", argumentsText: "revoke" }, options),
    ).resolves.toEqual({ kind: "handled" });
    expect(notice).toHaveBeenCalledWith("revocation persistence failed");
    await executeCommand({ type: "command", name: "permissions", argumentsText: "" }, options);
    expect(notice).toHaveBeenLastCalledWith(expect.stringContaining("权限模式：FullAccess"));
    expect(agent.prompt).not.toHaveBeenCalled();
    expect(agent.respondToToolApproval).not.toHaveBeenCalled();
  });

  it("returns the original skill task only after successful activation", async () => {
    const { agent } = createFakeAgent();
    const options = { agent, notice: vi.fn(), details() {}, exit() {} };
    const command = {
      type: "command" as const,
      name: "skill:typescript",
      argumentsText: "check this\n  preserve indentation",
    };
    await expect(executeCommand(command, options)).resolves.toEqual({
      kind: "prompt",
      text: command.argumentsText,
    });
    vi.mocked(agent.skills.activate).mockResolvedValueOnce({ ok: false, error: "ambiguous skill" });
    await expect(executeCommand(command, options)).resolves.toEqual({ kind: "rejected" });
    expect(options.notice).toHaveBeenLastCalledWith("ambiguous skill");
  });

  it("uses the help catalog for menu entries and skill completions", async () => {
    const { agent } = createFakeAgent();
    const provider = createCommandAutocomplete(agent);
    const suggestions = await provider.getSuggestions(["/"], 0, 1, {
      signal: new AbortController().signal,
    });
    const values = suggestions?.items.map((item) => item.value) ?? [];
    expect(values).toContain("compact");
    expect(values).toContain("skill:typescript");
    expect(commandHelp()).toContain("/compact");
    expect(commandHelp()).toContain("Alt+Enter");
  });
  it("shows declared subcommand arguments in help and completion suggestions", async () => {
    const { agent } = createFakeAgent();
    const provider = createCommandAutocomplete(agent);
    const help = commandHelp();
    for (const [prefix, value, usage] of [
      ["/agent ar", "artifact", "<id> <artifactId> [cursor]"],
      ["/git rem", "remove", "<id> [discard]"],
      ["/memory f", "forget", "<id> <版本> [no-send]"],
      ["/mcp p", "prompt", '<id> <name> [{"参数名":"值"}]'],
    ]) {
      if (prefix === undefined || value === undefined || usage === undefined) {
        throw new Error("Expected a complete command discovery case");
      }
      const suggestions = await provider.getSuggestions([prefix], 0, prefix.length, {
        signal: new AbortController().signal,
      });
      expect(suggestions?.items.find((item) => item.value === value)?.description).toContain(usage);
      expect(help).toContain(prefix.split(" ")[0] + " " + value + " " + usage);
    }
    expect(help.split("\n").find((line) => line.startsWith("/agent ["))).toContain("artifact");
    expect(help).toContain("/agent wait <id> [其他成员，最多九个]");
    expect(agent.prompt).not.toHaveBeenCalled();
  });

  it("uses the same memory usage for explicit help and invalid arguments", async () => {
    const { agent } = createFakeAgent();
    const notice = vi.fn();
    const options = { agent, notice, details() {}, exit() {} };
    await expect(
      executeCommand({ type: "command", name: "memory", argumentsText: "help" }, options),
    ).resolves.toEqual({ kind: "handled" });
    const help = notice.mock.calls[0]?.[0];
    expect(help).toContain(
      "/memory [list] [user|experience] [active|candidate|review|expired|forgotten|all]",
    );
    expect(help).toContain("/memory forget <id> <版本> [no-send]");
    expect(help).toContain("原始会话清理由独立功能负责");
    expect(commandHelp()).toContain(help);
    await expect(
      executeCommand(
        { type: "command", name: "memory", argumentsText: "confirm missing-version" },
        options,
      ),
    ).resolves.toEqual({ kind: "rejected" });
    expect(notice).toHaveBeenLastCalledWith(help);
    expect(agent.memory.query).not.toHaveBeenCalled();
    expect(agent.memory.execute).not.toHaveBeenCalled();
    expect(agent.prompt).not.toHaveBeenCalled();
  });

  it("queries dynamic identities only for the declared command family", async () => {
    const { agent } = createFakeAgent();
    const provider = createCommandAutocomplete(agent);
    for (const prefix of ["/agent unknown ", "/team result ", "/mcp unknown "]) {
      const suggestions = await provider.getSuggestions([prefix], 0, prefix.length, {
        signal: new AbortController().signal,
      });
      expect(suggestions?.items ?? []).toEqual([]);
    }
    expect(agent.collaboration.snapshot).not.toHaveBeenCalled();
    expect(agent.mcp.list).not.toHaveBeenCalled();

    const memberPrefix = "/agent result ";
    await provider.getSuggestions([memberPrefix], 0, memberPrefix.length, {
      signal: new AbortController().signal,
    });
    expect(agent.collaboration.snapshot).toHaveBeenCalledOnce();
    const serverPrefix = "/mcp read l";
    const serverSuggestions = await provider.getSuggestions(
      [serverPrefix],
      0,
      serverPrefix.length,
      {
        signal: new AbortController().signal,
      },
    );
    expect(serverSuggestions?.items.map((item) => item.value)).toContain("read local");
    expect(agent.mcp.list).toHaveBeenCalledOnce();
    expect(agent.sessions.open).not.toHaveBeenCalled();
    expect(agent.collaboration.execute).not.toHaveBeenCalled();
    expect(agent.mcp.readResource).not.toHaveBeenCalled();
  });

  it("routes collaboration and Git commands through Agent controls", async () => {
    const { agent } = createFakeAgent();
    const notice = vi.fn();
    for (const line of [
      "/agents",
      "/agent spawn implement a bounded change",
      "/agent assign member-id Review task",
      "/agent message member-id queued message",
      "/git status",
      '/git commit {"paths":["a file.ts"],"message":"change"}',
    ]) {
      const command = parseInput(line);
      if (command.type === "command")
        await expect(
          executeCommand(command, { agent, notice, details() {}, exit() {} }),
        ).resolves.toEqual({ kind: "handled" });
    }
    expect(agent.collaboration.execute).toHaveBeenCalledWith({
      action: "spawn",
      task: "implement a bounded change",
      writable: true,
      name: "implement a bounded change",
    });
    expect(agent.collaboration.execute).toHaveBeenCalledWith({
      action: "message",
      memberId: "member-id",
      content: "queued message",
    });
    expect(agent.git.execute).toHaveBeenCalledWith({
      action: "commit",
      paths: ["a file.ts"],
      message: "change",
    });
    expect(agent.prompt).not.toHaveBeenCalled();
  });
});
