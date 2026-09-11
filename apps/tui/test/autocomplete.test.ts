import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@anthias/agent";
import { Editor, TuiAltScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommandAutocomplete } from "../src/command.js";
import { createTheme } from "../src/theme.js";
import { createFakeAgent } from "./fixtures.js";
import { createTestTerminal } from "./terminal-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function createEditorHarness() {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "anthias-completion-"));
  cleanups.push(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const workspaceRoot = join(temporaryDirectory, "路径 空间");
  await mkdir(join(workspaceRoot, "apps", "src"), { recursive: true });
  await mkdir(join(workspaceRoot, "空格 目录"));
  await Promise.all([
    writeFile(join(workspaceRoot, "AGENTS.md"), "Rules"),
    writeFile(join(workspaceRoot, "package.json"), "{}"),
    writeFile(join(workspaceRoot, "apps", "src", "command.ts"), "export {};"),
    writeFile(join(workspaceRoot, "空格 目录", "中文 文件.md"), "正文"),
  ]);
  const { agent, setState } = createFakeAgent();
  setState({ workspaceRoot });
  const terminal = createTestTerminal();
  const tui = new TuiAltScreen(terminal.terminal);
  const editor = new Editor(
    tui,
    createTheme({ colorDepth: "none", hyperlinks: false, unicode: true }).editor,
  );
  editor.setAutocompleteProvider(createCommandAutocomplete(agent));
  const submitted = vi.fn();
  editor.onSubmit = submitted;
  tui.setLayoutRoot(editor);
  tui.setFocus(editor);
  tui.start();
  cleanups.push(async () => {
    editor.setText("");
    tui.stop();
    await terminal.flush();
    terminal.dispose();
  });
  return { agent, workspaceRoot, editor, terminal, submitted };
}

describe("editor autocomplete", () => {
  it("completes slash names and parameters after their menu is closed", async () => {
    const { editor, terminal, agent, submitted } = await createEditorHarness();
    terminal.send("/mod");
    await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
    terminal.send("\t");
    expect(editor.getText()).toBe("/mode ");
    editor.setText("/mode au");
    expect(editor.isShowingAutocomplete()).toBe(false);
    terminal.send("\t");
    await vi.waitFor(() => expect(editor.getText()).toBe("/mode auto_allow"));
    terminal.send("\t");
    await vi.waitFor(() => expect(editor.getText()).toBe("/mode auto_allow"));
    editor.setText("/mode f");
    terminal.send("\t");
    await vi.waitFor(() => expect(editor.getText()).toBe("/mode full_access"));
    editor.setText("/mode package");
    terminal.send("\t");
    await terminal.flush();
    expect(editor.getText()).toBe("/mode package");
    expect(agent.setPermissionMode).not.toHaveBeenCalled();
    expect(agent.prompt).not.toHaveBeenCalled();
    expect(submitted).not.toHaveBeenCalled();
  });

  it("reopens command candidates after Escape and completes an entire argument prefix", async () => {
    const { editor, terminal } = await createEditorHarness();
    editor.setText("/mode ");
    terminal.send("\t");
    await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
    terminal.send("\u001b");
    expect(editor.isShowingAutocomplete()).toBe(false);
    terminal.send("\t");
    await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
    terminal.send("\u001b[B");
    terminal.send("\t");
    expect(editor.getText()).toBe("/mode auto_allow");
    editor.setText("/permissions grant --r");
    terminal.send("\t");
    await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
    terminal.send("\t");
    expect(editor.getText()).toBe("/permissions grant --remember");
  });

  it.each([
    ["查看 pac", "查看 package.json"],
    ["查看 @AGENTS", "查看 @AGENTS.md "],
    ["查看 @command", "查看 @apps/src/command.ts "],
  ])("completes local files without fd from %s", async (prefix, completed) => {
    const { editor, terminal, agent } = await createEditorHarness();
    editor.setText(prefix);
    terminal.send("\t");
    await vi.waitFor(() => expect(editor.getText()).toBe(completed));
    expect(agent.prompt).not.toHaveBeenCalled();
    expect(agent.sessions.open).not.toHaveBeenCalled();
  });

  it.each(["/", "\\"])("descends through relative directories with %s", async (separator) => {
    const { editor, terminal } = await createEditorHarness();
    editor.setText(`查看 apps${separator}`);
    terminal.send("\t");
    await vi.waitFor(() => expect(editor.getText()).toBe(`查看 apps${separator}src${separator}`));
    terminal.send("\t");
    await vi.waitFor(() =>
      expect(editor.getText()).toBe(`查看 apps${separator}src${separator}command.ts`),
    );
  });

  it.each(['"', "'"])("keeps the cursor inside a directory quoted with %s", async (quote) => {
    const { editor, terminal } = await createEditorHarness();
    editor.setText(`查看 ${quote}空`);
    terminal.send("\t");
    await vi.waitFor(() => expect(editor.getText()).toBe(`查看 ${quote}空格 目录/${quote}`));
    expect(editor.getCursor().col).toBe(editor.getText().length - 1);
    terminal.send("\t");
    await vi.waitFor(() =>
      expect(editor.getText()).toBe(`查看 ${quote}空格 目录/中文 文件.md${quote}`),
    );
    expect(editor.getCursor().col).toBe(editor.getText().length);
    expect(editor.render(100).join("\n")).toContain("中文 文件.md");
  });

  it("continues a quoted file reference through a directory and preserves following text", async () => {
    const { editor, terminal } = await createEditorHarness();
    editor.setText('查看 @"空格 目录/" 然后继续');
    for (let index = 0; index < 6; index++) terminal.send("\u001b[D");
    expect(editor.getCursor().col).toBe('查看 @"空格 目录/'.length);
    terminal.send("\t");
    await vi.waitFor(() =>
      expect(editor.getText()).toBe('查看 @"空格 目录/中文 文件.md" 然后继续'),
    );
  });

  it.runIf(process.platform === "win32").each(["/", "\\"])(
    "completes a quoted Windows absolute path with %s",
    async (separator) => {
      const { workspaceRoot, editor, terminal } = await createEditorHarness();
      const absolutePrefix = workspaceRoot.replaceAll("\\", separator) + separator;
      editor.setText(`查看 "${absolutePrefix}app`);
      terminal.send("\t");
      await vi.waitFor(() =>
        expect(editor.getText()).toBe(`查看 "${absolutePrefix}apps${separator}"`),
      );
      terminal.send("\t");
      await vi.waitFor(() =>
        expect(editor.getText()).toBe(`查看 "${absolutePrefix}apps${separator}src${separator}"`),
      );
    },
  );

  it("discards a delayed completion after the user changes the draft", async () => {
    const { agent, editor, terminal } = await createEditorHarness();
    const sessions = Promise.withResolvers<Awaited<ReturnType<Agent["sessions"]["list"]>>>();
    vi.mocked(agent.sessions.list).mockReturnValueOnce(sessions.promise);
    editor.setText("/resume ");
    terminal.send("\t");
    await vi.waitFor(() => expect(agent.sessions.list).toHaveBeenCalledOnce());
    terminal.send("\u0015");
    terminal.send("新的草稿");
    sessions.resolve({ ok: true, value: [{ id: "saved-id", createdAt: "2026-09-08" }] });
    await terminal.flush();
    expect(editor.getText()).toBe("新的草稿");
    expect(editor.isShowingAutocomplete()).toBe(false);
    expect(agent.sessions.open).not.toHaveBeenCalled();
    expect(agent.prompt).not.toHaveBeenCalled();
  });
});
