import { describe, expect, it, vi } from "vitest";
import {
  commandHelp,
  createCommandAutocomplete,
  executeCommand,
  parseInput,
} from "../src/command.js";
import { createFakeAgent } from "./fixtures.js";

describe("slash commands", () => {
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
      "/mode plan",
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
        await executeCommand(command, { agent, notice, details, exit });
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
    ]) {
      const command = parseInput(line);
      if (command.type === "command")
        await executeCommand(command, { agent, notice, details() {}, exit() {} });
    }
    expect(notice).toHaveBeenCalledTimes(10);
    expect(agent.sessions.create).not.toHaveBeenCalled();
    expect(agent.mcp.getPrompt).not.toHaveBeenCalled();
    expect(agent.skills.activate).not.toHaveBeenCalled();
    expect(agent.prompt).not.toHaveBeenCalled();
  });

  it("returns the original skill task only after successful activation", async () => {
    const { agent } = createFakeAgent();
    const options = { agent, notice: vi.fn(), details() {}, exit() {} };
    const command = {
      type: "command" as const,
      name: "skill:typescript",
      argumentsText: "check this\n  preserve indentation",
    };
    await expect(executeCommand(command, options)).resolves.toBe(command.argumentsText);
    vi.mocked(agent.skills.activate).mockResolvedValueOnce({ ok: false, error: "ambiguous skill" });
    await expect(executeCommand(command, options)).resolves.toBeUndefined();
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
});
