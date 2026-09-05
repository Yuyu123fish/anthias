import { realpath } from "node:fs/promises";
import {
  type Component,
  Markdown,
  type MarkdownTheme,
  stripTerminalSequences,
} from "@earendil-works/pi-tui";
import {
  type CodeHighlighter,
  type ResolvedFileReference,
  resolveWorkspaceFileReference,
  sanitizeTerminalText,
  styleTerminalText,
  type TerminalCapabilities,
} from "../content-renderer.js";
import { createTheme } from "../theme.js";

export type MarkdownContent = Component & {
  setText(text: string): void;
  close(): void;
};

/** 正文立即可读；文件解析和语法高亮只改进当前版本，不能阻塞事件或输入。 */
export function createMarkdownContent(options: {
  workspaceRoot: string;
  capabilities: TerminalCapabilities;
  requestRender(): void;
  codeHighlighter?: CodeHighlighter;
}): MarkdownContent {
  const { capabilities } = options;
  const fileReferences = new Map<string, Promise<ResolvedFileReference | null>>();
  const allowedFileUrls = new Set<string>();
  const highlightedBlocks = new Map<string, string[]>();
  const pendingHighlights = new Map<string, ReturnType<typeof setTimeout>>();
  let currentText = "";
  let revision = 0;
  let closed = false;
  let fileTimer: ReturnType<typeof setTimeout> | undefined;
  const theme: MarkdownTheme = {
    ...createTheme(capabilities).markdown,
    highlightCode(code, language = "") {
      const key = `${language}\n${code}`;
      const cached = highlightedBlocks.get(key);
      if (cached !== undefined) return cached;
      if (
        capabilities.colorDepth !== "none" &&
        language &&
        Buffer.byteLength(code) <= 64 * 1024 &&
        code.split("\n").length <= 2_000 &&
        !pendingHighlights.has(key) &&
        !closed
      ) {
        // 限制排队高亮的版本数；同一正文中的多个代码块仍能独立完成。
        if (pendingHighlights.size >= 8) {
          const oldest = pendingHighlights.entries().next().value;
          if (oldest !== undefined) {
            clearTimeout(oldest[1]);
            pendingHighlights.delete(oldest[0]);
          }
        }
        const timer = setTimeout(() => {
          pendingHighlights.delete(key);
          void highlight(code, language, key);
        }, 60);
        timer.unref();
        pendingHighlights.set(key, timer);
      }
      return code.split("\n");
    },
  };
  const markdown = new Markdown("", 1, 0, theme, undefined, { renderLatex: false });

  async function highlight(code: string, language: string, key: string): Promise<void> {
    try {
      const highlighter =
        options.codeHighlighter ??
        (await import("../syntax-highlighter.js")).highlightCodeWithShiki;
      const tokens = await highlighter(code, language);
      if (closed) return;
      const source = tokens?.map((line) => line.map((token) => token.text).join("")).join("\n");
      const lines =
        source === code && tokens !== null
          ? tokens.map((line) =>
              line
                .map((token) =>
                  token.color === null
                    ? sanitizeTerminalText(token.text)
                    : styleTerminalText(token.text, token.color, capabilities, token.dim),
                )
                .join(""),
            )
          : code.split("\n");
      highlightedBlocks.set(key, lines);
      if (highlightedBlocks.size > 16) {
        const oldestKey = highlightedBlocks.keys().next().value;
        if (oldestKey !== undefined) highlightedBlocks.delete(oldestKey);
      }
      markdown.invalidate();
      options.requestRender();
    } catch {
      if (!closed) highlightedBlocks.set(key, code.split("\n"));
    }
  }

  async function decorateFiles(text: string, capturedRevision: number): Promise<void> {
    const workspacePath = realpath(options.workspaceRoot);
    // realpath 的拒绝只进入受控文件解析结果，不成为无订阅的 Promise rejection。
    void workspacePath.catch(() => undefined);
    const lines = text.split("\n");
    let fence: string | undefined;
    const renderedLines: string[] = [];
    for (const line of lines) {
      const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
      if (marker !== undefined) {
        if (fence === undefined) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        renderedLines.push(line);
        continue;
      }
      if (fence !== undefined) {
        renderedLines.push(line);
        continue;
      }
      const matches = [...line.matchAll(/(?<!`)(`([^`\n]+)`)(?!`)|\[([^\]\n]*)\]\(([^)\n]+)\)/gu)];
      let resolvedLine = "";
      let previousEnd = 0;
      for (const match of matches) {
        const candidate = (match[2] ?? match[4] ?? "").replace(/^<|>$/gu, "");
        let reference = fileReferences.get(candidate);
        if (reference === undefined && fileReferences.size < 128) {
          reference = resolveWorkspaceFileReference(candidate, workspacePath);
          fileReferences.set(candidate, reference);
        }
        const file = await reference;
        resolvedLine += line.slice(previousEnd, match.index);
        if (file != null) {
          allowedFileUrls.add(file.fileUrl);
          const markerText = capabilities.unicode ? "▧" : "[file]";
          const label = `${markerText} ${file.relativePath}${file.line === undefined ? "" : `:${file.line}`}${file.column === undefined ? "" : `:${file.column}`}`;
          resolvedLine += `[${label.replace(/[[\]\\]/gu, "\\$&")}](${file.fileUrl})`;
        } else resolvedLine += match[0];
        previousEnd = match.index + match[0].length;
      }
      renderedLines.push(resolvedLine + line.slice(previousEnd));
    }
    if (!closed && revision === capturedRevision) {
      markdown.setText(renderedLines.join("\n"));
      options.requestRender();
    }
  }

  return {
    setText(text) {
      const safeText = sanitizeTerminalText(text);
      if (safeText === currentText) return;
      currentText = safeText;
      revision += 1;
      markdown.setText(safeText);
      if (fileTimer !== undefined) clearTimeout(fileTimer);
      const capturedRevision = revision;
      fileTimer = setTimeout(() => {
        fileTimer = undefined;
        void decorateFiles(safeText, capturedRevision).catch(() => undefined);
      }, 80);
      fileTimer.unref();
    },
    render(width) {
      return markdown.render(width).map((line) => {
        if (capabilities.colorDepth === "none" && !capabilities.hyperlinks)
          return stripTerminalSequences(line);
        // Markdown 的 href 不可信；只允许 Web URL 与已经 realpath 校验的工作区文件。
        return line.replace(
          // biome-ignore lint/suspicious/noControlCharactersInRegex: 这里识别并限制由 Markdown 渲染器生成的 OSC 8。
          /\u001b\]8;;([^\u001b\u0007]*)(?:\u001b\\|\u0007)/gu,
          (sequence, url: string) =>
            capabilities.hyperlinks && (url === "" || isWebUrl(url) || allowedFileUrls.has(url))
              ? sequence
              : "",
        );
      });
    },
    invalidate() {
      markdown.invalidate();
    },
    close() {
      closed = true;
      if (fileTimer !== undefined) clearTimeout(fileTimer);
      for (const timer of pendingHighlights.values()) clearTimeout(timer);
      pendingHighlights.clear();
    },
  };
}

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
}
