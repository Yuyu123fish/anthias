import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  resetCapabilitiesCache,
  setCapabilities,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMarkdownContent, type MarkdownContent } from "../src/content/markdown.js";
import {
  type CodeHighlighter,
  sanitizeTerminalText,
  type TerminalCapabilities,
} from "../src/content-renderer.js";

import { highlightCodeWithShiki } from "../src/syntax-highlighter.js";

const roots = new Set<string>();
const contents = new Set<MarkdownContent>();
afterEach(async () => {
  for (const content of contents) content.close();
  contents.clear();
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
  resetCapabilitiesCache();
});
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "anthias-markdown-"));
  roots.add(root);
  return root;
}
function renderer(
  workspaceRoot: string,
  capabilities: TerminalCapabilities = { colorDepth: "truecolor", hyperlinks: true, unicode: true },
  highlighter?: CodeHighlighter,
) {
  setCapabilities({ images: null, trueColor: true, hyperlinks: true });
  const content = createMarkdownContent({
    workspaceRoot,
    capabilities,
    requestRender() {},
    ...(highlighter === undefined ? {} : { codeHighlighter: highlighter }),
  });
  contents.add(content);
  return content;
}
const plain = (content: MarkdownContent, width = 80) =>
  content.render(width).map(stripTerminalSequences).join("\n");

describe("streaming Markdown", () => {
  it("renders headings, emphasis, tables and unfinished code without waiting for a fence", async () => {
    const content = renderer(await workspace());
    content.setText(
      "# Heading\n\nA **bold** and `inline` value.\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst value = 42;",
    );
    expect(plain(content)).toContain("Heading");
    expect(plain(content)).not.toContain("**bold**");
    expect(plain(content)).toContain("const value = 42;");
    expect(content.render(25).every((line) => visibleWidth(line) <= 25)).toBe(true);
  });

  it("links only real workspace files and retains line labels", async () => {
    const root = await workspace();
    const outside = await workspace();
    await mkdir(join(root, "目录"));
    const file = join(root, "目录", "file name#%.ts");
    await writeFile(file, "export {};\n");
    await writeFile(join(outside, "outside.ts"), "outside");
    const content = renderer(root);
    content.setText(
      `\`目录/file name#%.ts:12:3\`\n\n[source](目录/file name#%.ts:8)\n\n[outside](${join(outside, "outside.ts")})\n\n[unsafe](javascript:alert) [remote](ssh://host/file)`,
    );
    await vi.waitFor(() => expect(plain(content)).toContain("▧ 目录/file name#%.ts:12:3"));
    const styled = content.render(100).join("\n");
    expect(styled).toContain(`\u001b]8;;${pathToFileURL(file).href}`);
    expect(styled).not.toContain(`\u001b]8;;${pathToFileURL(join(outside, "outside.ts")).href}`);
    expect(styled).not.toContain("\u001b]8;;javascript:");
    expect(styled).not.toContain("\u001b]8;;ssh:");
  });

  it("rejects a file link through a directory junction outside the workspace", async () => {
    const root = await workspace();
    const outside = await workspace();
    await writeFile(join(outside, "outside.ts"), "outside");
    await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    const content = renderer(root);
    content.setText("[outside](linked/outside.ts)");
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(content.render(80).join("\n")).not.toContain("\u001b]8;;file:");
  });

  it("keeps an old async highlight from replacing newer streaming text", async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<CodeHighlighter>>>();
    const highlighter = vi
      .fn<CodeHighlighter>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(null);
    const content = renderer(await workspace(), undefined, highlighter);
    content.setText("```ts\nconst old = 1;");
    expect(plain(content)).toContain("const old = 1;");
    await vi.waitFor(() => expect(highlighter).toHaveBeenCalledOnce());
    content.setText("```ts\nconst newer = 2;");
    expect(plain(content)).toContain("const newer = 2;");
    pending.resolve([[{ text: "const old = 1;", color: "anthiasCoral", dim: false }]]);
    await Promise.resolve();
    expect(plain(content)).toContain("const newer = 2;");
    expect(plain(content)).not.toContain("const old = 1;");
  });

  it.each([
    ["typescript", "const value = 42;"],
    ["powershell", '$value = "hello"'],
    ["java", "public class Demo {}"],
    ["markdown", "# source"],
  ])("loads Shiki lazily for %s and preserves source", async (language, source) => {
    const highlighter = vi.fn(highlightCodeWithShiki);
    const content = renderer(await workspace(), undefined, highlighter);
    expect(highlighter).not.toHaveBeenCalled();
    content.setText(`\`\`\`${language}\n${source}\n\`\`\``);
    content.render(100);
    await vi.waitFor(() => expect(highlighter).toHaveBeenCalledWith(source, language));
    const tokens: Awaited<ReturnType<CodeHighlighter>> | undefined =
      await highlighter.mock.results[0]?.value;
    expect(tokens?.map((line) => line.map((token) => token.text).join("")).join("\n")).toBe(source);
    expect(plain(content)).toContain(source);
  });

  it("highlights multiple code blocks without cancelling another block", async () => {
    const highlighter = vi.fn<CodeHighlighter>(async (code) => [
      [{ text: code, color: "anthiasCoral", dim: false }],
    ]);
    const content = renderer(await workspace(), undefined, highlighter);
    content.setText("```ts\nfirst\n```\n\n```ts\nsecond\n```");
    content.render(100);
    await vi.waitFor(() => expect(highlighter).toHaveBeenCalledTimes(2));
    expect(highlighter).toHaveBeenCalledWith("first", "ts");
    expect(highlighter).toHaveBeenCalledWith("second", "ts");
  });

  it("sanitizes controls and falls back safely after a highlighter failure", async () => {
    const failing = vi.fn<CodeHighlighter>(async () => {
      throw new Error("no grammar");
    });
    const content = renderer(
      await workspace(),
      { colorDepth: "truecolor", hyperlinks: false, unicode: true },
      failing,
    );
    content.setText('```ts\nconst x = "safe\u001b[2J";\n```');
    content.render(80);
    await vi.waitFor(() => expect(failing).toHaveBeenCalledOnce());
    expect(plain(content)).toContain('const x = "safe�[2J";');
    expect(content.render(80).join("\n")).not.toContain("\u001b[2J");
    expect(sanitizeTerminalText("\u0000\ud800\r\n")).toBe("��\n");
  });
});
