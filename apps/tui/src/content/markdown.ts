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
  const fileReferencePromises = new Map<string, Promise<ResolvedFileReference | null>>();
  const allowedFileUrls = new Set<string>();
  const highlightedBlocks = new Map<string, string[]>();
  const pendingHighlightTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let currentText = "";
  let revision = 0;
  let closed = false;
  let fileDecorationTimer: ReturnType<typeof setTimeout> | undefined;
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
        !pendingHighlightTimers.has(key) &&
        !closed
      ) {
        // 限制排队高亮的版本数；同一正文中的多个代码块仍能独立完成。
        if (pendingHighlightTimers.size >= 8) {
          const oldest = pendingHighlightTimers.entries().next().value;
          if (oldest !== undefined) {
            clearTimeout(oldest[1]);
            pendingHighlightTimers.delete(oldest[0]);
          }
        }
        const timer = setTimeout(() => {
          pendingHighlightTimers.delete(key);
          void highlight(code, language, key);
        }, 60);
        timer.unref();
        pendingHighlightTimers.set(key, timer);
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
      const highlightedCodeLines = await highlighter(code, language);
      if (closed) return;
      const source = highlightedCodeLines
        ?.map((line) => line.map((token) => token.text).join(""))
        .join("\n");
      const lines =
        source === code && highlightedCodeLines !== null
          ? highlightedCodeLines.map((line) =>
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
    const workspaceRealPathPromise = realpath(options.workspaceRoot);
    // realpath 的拒绝只进入受控文件解析结果，不成为无订阅的 Promise rejection。
    void workspaceRealPathPromise.catch(() => undefined);
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
        let fileReferencePromise = fileReferencePromises.get(candidate);
        if (fileReferencePromise === undefined && fileReferencePromises.size < 128) {
          fileReferencePromise = resolveWorkspaceFileReference(candidate, workspaceRealPathPromise);
          fileReferencePromises.set(candidate, fileReferencePromise);
        }
        const resolvedFileReference = await fileReferencePromise;
        resolvedLine += line.slice(previousEnd, match.index);
        if (resolvedFileReference != null) {
          allowedFileUrls.add(resolvedFileReference.fileUrl);
          const markerText = capabilities.unicode ? "▧" : "[file]";
          const label = `${markerText} ${resolvedFileReference.relativePath}${resolvedFileReference.line === undefined ? "" : `:${resolvedFileReference.line}`}${resolvedFileReference.column === undefined ? "" : `:${resolvedFileReference.column}`}`;
          resolvedLine += `[${label.replace(/[[\]\\]/gu, "\\$&")}](${resolvedFileReference.fileUrl})`;
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
      if (fileDecorationTimer !== undefined) clearTimeout(fileDecorationTimer);
      const capturedRevision = revision;
      fileDecorationTimer = setTimeout(() => {
        fileDecorationTimer = undefined;
        void decorateFiles(safeText, capturedRevision).catch(() => undefined);
      }, 80);
      fileDecorationTimer.unref();
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
      if (fileDecorationTimer !== undefined) clearTimeout(fileDecorationTimer);
      for (const timer of pendingHighlightTimers.values()) clearTimeout(timer);
      pendingHighlightTimers.clear();
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
