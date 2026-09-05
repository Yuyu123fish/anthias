import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAssistantContentRenderer,
  renderAssistantContent,
  type TerminalCapabilities,
} from "../src/content-renderer.js";

const temporaryDirectories = new Set<string>();
const PLAIN_CAPABILITIES: TerminalCapabilities = Object.freeze({
  colorDepth: "none",
  hyperlinks: false,
  unicode: true,
});

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

describe("Assistant Content Renderer", () => {
  it("commits complete lines and closed fences without overtaking pending content", async () => {
    const workspaceRoot = await createWorkspace();
    await mkdir(join(workspaceRoot, "src"));
    await writeFile(join(workspaceRoot, "src", "example.ts"), "export {};\n", "utf8");
    const renderer = createAssistantContentRenderer({
      workspaceRoot,
      capabilities: PLAIN_CAPABILITIES,
    });

    await expect(renderer.push("Before `src/ex")).resolves.toBe("");
    expect(renderer.preview()).toBe("Before `src/ex");
    await expect(renderer.push("ample.ts:1`\n```ts\nconst value")).resolves.toBe(
      "Before ▧ src/example.ts:1\n",
    );
    expect(renderer.preview()).toBe("```ts\nconst value");
    await expect(renderer.push(": number = 42;\n```\nAfter")).resolves.toBe(
      "╭─ ts\nconst value: number = 42;\n╰─\n",
    );
    expect(renderer.preview()).toBe("After");
    await expect(renderer.finish()).resolves.toBe("After");
    expect(renderer.preview()).toBe("");
  });

  it("links only real local files inside the Workspace and keeps line data in the label", async () => {
    const workspaceRoot = await createWorkspace();
    const outsideRoot = await createWorkspace();
    const relativePath = "目录/file name#%.ts";
    const filePath = join(workspaceRoot, "目录", "file name#%.ts");
    await mkdir(join(workspaceRoot, "目录"));
    await writeFile(filePath, "export {};\n", "utf8");
    await mkdir(join(workspaceRoot, "folder"));
    const outsideFilePath = join(outsideRoot, "outside.ts");
    await writeFile(outsideFilePath, "outside\n", "utf8");
    const capabilities: TerminalCapabilities = Object.freeze({
      colorDepth: "none",
      hyperlinks: true,
      unicode: true,
    });

    const rendered = await renderAssistantContent(
      [
        `inline \`${relativePath}:12:3\``,
        `[source](${relativePath}:8)`,
        `\`${outsideFilePath}:2\``,
        "`folder` `missing.ts` [remote](ssh://host/file.ts) [unc](\\\\server\\share\\file.ts)",
      ].join("\n"),
      { workspaceRoot, capabilities },
    );

    expect(rendered).toContain(`▧ ${relativePath}:12:3`);
    expect(rendered).toContain(`▧ ${relativePath}:8`);
    expect(rendered).toContain(`\u001B]8;;${pathToFileURL(filePath).href}\u001B\\`);
    expect(rendered).not.toContain(`${pathToFileURL(filePath).href}:12`);
    expect(rendered).toContain(`\`${outsideFilePath}:2\``);
    expect(rendered).toContain("`folder` `missing.ts`");
    expect(rendered).toContain("[remote](ssh://host/file.ts)");
    expect(rendered).toContain("[unc](\\\\server\\share\\file.ts)");
    expect(rendered.split("\u001B]8;;")).toHaveLength(5);
  });

  it("uses an ASCII file marker without requiring color or hyperlinks", async () => {
    const workspaceRoot = await createWorkspace();
    await writeFile(join(workspaceRoot, "README.md"), "hello\n", "utf8");

    await expect(
      renderAssistantContent("`README.md:3`", {
        workspaceRoot,
        capabilities: { colorDepth: "none", hyperlinks: false, unicode: false },
      }),
    ).resolves.toBe("[file] README.md:3");
  });

  it("removes model-provided terminal controls before plain or styled output", async () => {
    const workspaceRoot = await createWorkspace();
    const malicious = "safe\u001B]8;;https://evil.example\u0007linked\u001B[31m red\u0000 end";

    const plain = await renderAssistantContent(malicious, {
      workspaceRoot,
      capabilities: PLAIN_CAPABILITIES,
    });
    const styled = await renderAssistantContent(`\`\`\`ts\nconst value = "${malicious}";\n\`\`\``, {
      workspaceRoot,
      capabilities: { colorDepth: "truecolor", hyperlinks: false, unicode: true },
    });

    expect([...plain].every(isAllowedTerminalCharacter)).toBe(true);
    expect(plain).not.toContain("\u001B");
    expect(stripAnsi(styled)).not.toContain("\u001B");
    expect(stripAnsi(styled)).toContain("safe�]8;;https://evil.example�linked�[31m red� end");
  });

  it.each([
    ["ts", "const value: number = 42; // note"],
    ["powershell", '$value = "hello"\nWrite-Output $value'],
    ["java", 'public class Demo { String value = "hello"; }'],
    ["markdown", "# Heading\n`inline`"],
  ])("highlights supported %s fences while preserving source text", async (language, source) => {
    const workspaceRoot = await createWorkspace();
    const rendered = await renderAssistantContent(`\`\`\`${language}\n${source}\n\`\`\``, {
      workspaceRoot,
      capabilities: { colorDepth: "truecolor", hyperlinks: false, unicode: true },
    });

    expect(rendered).toContain("\u001B[38;2;");
    expect(stripCodeFrame(stripAnsi(rendered))).toBe(`${source}\n`);
  });

  it("maps the Anthias theme to truecolor, 256-color, and 16-color writers", async () => {
    const workspaceRoot = await createWorkspace();
    const source = "const value = 42; // note";
    const renderAt = (colorDepth: TerminalCapabilities["colorDepth"]) =>
      renderAssistantContent(`\`\`\`ts\n${source}\n\`\`\``, {
        workspaceRoot,
        capabilities: { colorDepth, hyperlinks: false, unicode: true },
      });

    await expect(renderAt("truecolor")).resolves.toContain("\u001B[38;2;");
    await expect(renderAt("ansi256")).resolves.toContain("\u001B[38;5;");
    const ansi16 = await renderAt("ansi16");
    expect(["\u001B[95m", "\u001B[91m", "\u001B[90;2m"].some((code) => ansi16.includes(code))).toBe(
      true,
    );
    await expect(renderAt("none")).resolves.not.toContain("\u001B");
  });

  it("falls back to uncolored source for unknown, unmarked, oversized, unclosed, or failed highlighting", async () => {
    const workspaceRoot = await createWorkspace();
    const failingHighlighter = vi.fn(async () => {
      throw new Error("highlight failed");
    });
    const capabilities: TerminalCapabilities = Object.freeze({
      colorDepth: "truecolor",
      hyperlinks: false,
      unicode: true,
    });

    const unknown = await renderAssistantContent("```unknown\nconst x = 1;\n```", {
      workspaceRoot,
      capabilities,
    });
    const unmarked = await renderAssistantContent("```\nconst x = 1;\n```", {
      workspaceRoot,
      capabilities,
    });
    const oversizedSource = "x".repeat(64 * 1024 + 1);
    const oversized = await renderAssistantContent(`\`\`\`ts\n${oversizedSource}\n\`\`\``, {
      workspaceRoot,
      capabilities,
    });
    const unclosed = await renderAssistantContent("```ts\nconst x = 1;", {
      workspaceRoot,
      capabilities,
    });
    const failed = await renderAssistantContent("```ts\nconst x = 1;\n```", {
      workspaceRoot,
      capabilities,
      codeHighlighter: failingHighlighter,
    });

    for (const rendered of [unknown, unmarked, failed]) {
      expect(rendered).not.toContain("\u001B");
      expect(stripCodeFrame(rendered)).toContain("const x = 1;");
    }
    expect(oversized).not.toContain("\u001B");
    expect(oversized).toContain(oversizedSource);
    expect(unclosed).toBe("```ts\nconst x = 1;");
    expect(failingHighlighter).toHaveBeenCalledOnce();
  });
});

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-content-renderer-"));
  temporaryDirectories.add(workspaceRoot);
  return workspaceRoot;
}

function stripAnsi(value: string): string {
  let plain = "";
  let index = 0;
  while (index < value.length) {
    if (value.startsWith("\u001B]8;;", index)) {
      const endIndex = value.indexOf("\u001B\\", index + 5);
      if (endIndex >= 0) {
        index = endIndex + 2;
        continue;
      }
    }
    if (value.startsWith("\u001B[", index)) {
      const endIndex = value.indexOf("m", index + 2);
      if (endIndex >= 0) {
        index = endIndex + 1;
        continue;
      }
    }
    plain += value[index] ?? "";
    index += 1;
  }
  return plain;
}

function stripCodeFrame(value: string): string {
  const lines = value.split("\n");
  return `${lines.slice(1, -2).join("\n")}\n`;
}

function isAllowedTerminalCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return (
    character === "\n" ||
    character === "\t" ||
    (codePoint >= 0x20 && codePoint < 0x7f) ||
    codePoint > 0x9f
  );
}
