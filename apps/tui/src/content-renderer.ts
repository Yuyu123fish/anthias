import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export type TerminalColorDepth = "none" | "ansi16" | "ansi256" | "truecolor";

/** 描述一次 TUI 呈现可以安全使用的终端能力。 */
export type TerminalCapabilities = Readonly<{
  colorDepth: TerminalColorDepth;
  hyperlinks: boolean;
  unicode: boolean;
}>;

export type TerminalPaletteColor =
  | "finViolet"
  | "reefRose"
  | "lagoon"
  | "anthiasCoral"
  | "reefSlate";

export type HighlightedCodeToken = Readonly<{
  text: string;
  color: TerminalPaletteColor | null;
  dim: boolean;
}>;

export type HighlightedCodeLine = readonly HighlightedCodeToken[];

export type CodeHighlighter = (
  code: string,
  language: string,
) => Promise<readonly HighlightedCodeLine[] | null>;

export type AssistantContentRendererOptions = Readonly<{
  workspaceRoot: string;
  capabilities: TerminalCapabilities;
  codeHighlighter?: CodeHighlighter;
}>;

export type AssistantContentRenderer = Readonly<{
  push(delta: string): Promise<string>;
  finish(): Promise<string>;
}>;

type TextSpan = Readonly<{
  type: "text";
  text: string;
  color: TerminalPaletteColor | null;
  dim: boolean;
}>;

type FileSpan = Readonly<{
  type: "file";
  text: string;
  fileUrl: string;
}>;

type ContentSpan = TextSpan | FileSpan;

type OpenFence = {
  markerLength: number;
  language: string;
  raw: string;
  code: string;
};

type ResolvedFileReference = Readonly<{
  relativePath: string;
  line?: number;
  column?: number;
  fileUrl: string;
}>;

const MAX_HIGHLIGHT_BYTES = 64 * 1024;
const MAX_HIGHLIGHT_LINES = 2_000;

const PALETTE = Object.freeze({
  finViolet: Object.freeze({ rgb: [139, 111, 242] as const, ansi256: 141, ansi16: 95 }),
  reefRose: Object.freeze({ rgb: [232, 93, 158] as const, ansi256: 205, ansi16: 95 }),
  lagoon: Object.freeze({ rgb: [70, 191, 195] as const, ansi256: 80, ansi16: 36 }),
  anthiasCoral: Object.freeze({ rgb: [255, 128, 102] as const, ansi256: 209, ansi16: 91 }),
  reefSlate: Object.freeze({ rgb: [142, 135, 150] as const, ansi256: 102, ansi16: 90 }),
} satisfies Record<
  TerminalPaletteColor,
  Readonly<{ rgb: readonly [number, number, number]; ansi256: number; ansi16: number }>
>);

/**
 * 创建一次 Assistant Message 的增量渲染器。只有完整行和闭合代码块会被提交，
 * 从而保证异步文件解析与高亮不会改变 AgentEvent 的显示顺序。
 */
export function createAssistantContentRenderer({
  workspaceRoot,
  capabilities,
  codeHighlighter = highlightCodeWithLazyShiki,
}: AssistantContentRendererOptions): AssistantContentRenderer {
  let pendingText = "";
  let openFence: OpenFence | null = null;
  let finished = false;
  let operationQueue: Promise<void> = Promise.resolve();
  let workspaceRealPathPromise: Promise<string> | undefined;
  const fileReferenceCache = new Map<string, Promise<ResolvedFileReference | null>>();
  const getWorkspaceRealPath = () => {
    workspaceRealPathPromise ??= realpath(workspaceRoot);
    return workspaceRealPathPromise;
  };

  const enqueue = (operation: () => Promise<string>): Promise<string> => {
    const resultPromise = operationQueue.then(operation);
    operationQueue = resultPromise.then(
      () => undefined,
      () => undefined,
    );
    return resultPromise;
  };

  const renderStablePlainText = async (text: string): Promise<string> => {
    const safeText = sanitizeModelText(text);
    const spans = await parseInlineContent(safeText, async (candidate) => {
      let resolutionPromise = fileReferenceCache.get(candidate);
      if (resolutionPromise === undefined) {
        resolutionPromise = resolveWorkspaceFileReference(candidate, getWorkspaceRealPath());
        fileReferenceCache.set(candidate, resolutionPromise);
      }
      return resolutionPromise;
    });
    return writeContentSpans(spans, capabilities);
  };

  const renderClosedFence = async (fence: OpenFence): Promise<string> => {
    const safeCode = sanitizeModelText(fence.code);
    let highlightedLines: readonly HighlightedCodeLine[] | null = null;
    if (
      capabilities.colorDepth !== "none" &&
      fence.language.length > 0 &&
      Buffer.byteLength(safeCode, "utf8") <= MAX_HIGHLIGHT_BYTES &&
      countLines(safeCode) <= MAX_HIGHLIGHT_LINES
    ) {
      try {
        const candidateLines = await codeHighlighter(safeCode, fence.language);
        if (candidateLines !== null && reconstructHighlightedCode(candidateLines) === safeCode) {
          highlightedLines = candidateLines;
        }
      } catch {
        highlightedLines = null;
      }
    }

    const frameLabel = fence.language.length === 0 ? "code" : fence.language;
    const opening = capabilities.unicode ? `╭─ ${frameLabel}\n` : `--- ${frameLabel}\n`;
    const closing = capabilities.unicode ? "╰─\n" : "---\n";
    const body =
      highlightedLines === null
        ? safeCode
        : writeHighlightedCode(highlightedLines, capabilities.colorDepth);
    return `${opening}${body}${body.endsWith("\n") ? "" : "\n"}${closing}`;
  };

  const consumeCompleteLines = async (): Promise<string> => {
    let rendered = "";
    while (true) {
      const newlineIndex = pendingText.indexOf("\n");
      if (newlineIndex < 0) {
        return rendered;
      }
      const line = pendingText.slice(0, newlineIndex + 1);
      pendingText = pendingText.slice(newlineIndex + 1);

      if (openFence === null) {
        const fenceOpening = parseFenceOpening(line);
        if (fenceOpening === null) {
          rendered += await renderStablePlainText(line);
        } else {
          openFence = {
            markerLength: fenceOpening.markerLength,
            language: fenceOpening.language,
            raw: line,
            code: "",
          };
        }
        continue;
      }

      openFence.raw += line;
      if (isFenceClosing(line, openFence.markerLength)) {
        rendered += await renderClosedFence(openFence);
        openFence = null;
      } else {
        openFence.code += line;
      }
    }
  };

  return Object.freeze({
    push(delta) {
      return enqueue(async () => {
        if (finished) {
          throw new Error("Assistant Content Renderer 已结束，不能继续写入。");
        }
        pendingText += delta;
        return consumeCompleteLines();
      });
    },
    finish() {
      return enqueue(async () => {
        if (finished) {
          return "";
        }
        finished = true;
        const renderedCompleteLines = await consumeCompleteLines();
        if (openFence !== null) {
          if (isFenceClosing(pendingText, openFence.markerLength)) {
            openFence.raw += pendingText;
            pendingText = "";
            const closedFence = openFence;
            openFence = null;
            return `${renderedCompleteLines}${await renderClosedFence(closedFence)}`;
          }
          const unfinishedFence = `${openFence.raw}${pendingText}`;
          openFence = null;
          pendingText = "";
          return `${renderedCompleteLines}${sanitizeModelText(unfinishedFence)}`;
        }
        const renderedTail = await renderStablePlainText(pendingText);
        pendingText = "";
        return `${renderedCompleteLines}${renderedTail}`;
      });
    },
  });
}

/** 一次性渲染完整 Assistant 文本，供历史消息和测试复用。 */
export async function renderAssistantContent(
  content: string,
  options: AssistantContentRendererOptions,
): Promise<string> {
  const renderer = createAssistantContentRenderer(options);
  return `${await renderer.push(content)}${await renderer.finish()}`;
}

/** 从实际输出流推导颜色、超链接和 Unicode 能力；非 TTY 永远使用纯文本。 */
export function detectTerminalCapabilities(
  output: NodeJS.WritableStream,
  environment: NodeJS.ProcessEnv = process.env,
): TerminalCapabilities {
  const terminalOutput = output as NodeJS.WritableStream & {
    isTTY?: boolean;
    getColorDepth?(): number;
  };
  if (terminalOutput.isTTY !== true) {
    return Object.freeze({ colorDepth: "none", hyperlinks: false, unicode: true });
  }

  const colorDepth =
    environment.NO_COLOR !== undefined
      ? "none"
      : mapColorDepth(terminalOutput.getColorDepth?.() ?? 4);
  const hyperlinks =
    environment.TERM === "dumb"
      ? false
      : environment.WT_SESSION !== undefined ||
        environment.TERM_PROGRAM !== undefined ||
        environment.VTE_VERSION !== undefined;
  const unicode =
    process.platform !== "win32" ||
    environment.WT_SESSION !== undefined ||
    environment.TERM_PROGRAM !== undefined;
  return Object.freeze({ colorDepth, hyperlinks, unicode });
}

function mapColorDepth(depth: number): TerminalColorDepth {
  if (depth >= 24) {
    return "truecolor";
  }
  if (depth >= 8) {
    return "ansi256";
  }
  if (depth >= 4) {
    return "ansi16";
  }
  return "none";
}

function parseFenceOpening(
  line: string,
): Readonly<{ markerLength: number; language: string }> | null {
  const match = /^(?: {0,3})(`{3,})([^`\r\n]*)\r?\n$/u.exec(line);
  if (match?.[1] === undefined) {
    return null;
  }
  const language = (match[2] ?? "").trim().split(/\s+/u)[0] ?? "";
  return Object.freeze({ markerLength: match[1].length, language });
}

function isFenceClosing(line: string, openingMarkerLength: number): boolean {
  const match = /^(?: {0,3})(`{3,})[ \t]*(?:\r?\n)?$/u.exec(line);
  return match?.[1] !== undefined && match[1].length >= openingMarkerLength;
}

async function parseInlineContent(
  text: string,
  resolveFile: (candidate: string) => Promise<ResolvedFileReference | null>,
): Promise<readonly ContentSpan[]> {
  const spans: ContentSpan[] = [];
  let plainText = "";
  let index = 0;

  const flushPlainText = () => {
    if (plainText.length > 0) {
      spans.push(textSpan(plainText));
      plainText = "";
    }
  };

  while (index < text.length) {
    if (text[index] === "`" && text[index - 1] !== "`" && text[index + 1] !== "`") {
      const closingIndex = findSingleBacktick(text, index + 1);
      if (closingIndex >= 0) {
        const raw = text.slice(index, closingIndex + 1);
        const candidate = text.slice(index + 1, closingIndex);
        const resolvedFile = await resolveFile(candidate);
        if (resolvedFile !== null) {
          flushPlainText();
          spans.push(fileSpan(resolvedFile));
        } else {
          plainText += raw;
        }
        index = closingIndex + 1;
        continue;
      }
    }

    if (text[index] === "[") {
      const parsedLink = parseMarkdownLink(text, index);
      if (parsedLink !== null) {
        const resolvedFile = await resolveFile(parsedLink.target);
        if (resolvedFile !== null) {
          flushPlainText();
          spans.push(fileSpan(resolvedFile));
        } else {
          plainText += parsedLink.raw;
        }
        index = parsedLink.endIndex;
        continue;
      }
    }

    plainText += text[index] ?? "";
    index += 1;
  }
  flushPlainText();
  return Object.freeze(spans);
}

function findSingleBacktick(text: string, startIndex: number): number {
  for (let index = startIndex; index < text.length; index += 1) {
    if (text[index] === "`" && text[index - 1] !== "`" && text[index + 1] !== "`") {
      return index;
    }
  }
  return -1;
}

function parseMarkdownLink(
  text: string,
  startIndex: number,
): Readonly<{ raw: string; target: string; endIndex: number }> | null {
  const labelEndIndex = text.indexOf("](", startIndex + 1);
  if (labelEndIndex < 0 || text.slice(startIndex + 1, labelEndIndex).includes("[")) {
    return null;
  }
  const targetEndIndex = text.indexOf(")", labelEndIndex + 2);
  if (targetEndIndex < 0) {
    return null;
  }
  const rawTarget = text.slice(labelEndIndex + 2, targetEndIndex);
  const target =
    rawTarget.startsWith("<") && rawTarget.endsWith(">") ? rawTarget.slice(1, -1) : rawTarget;
  return Object.freeze({
    raw: text.slice(startIndex, targetEndIndex + 1),
    target,
    endIndex: targetEndIndex + 1,
  });
}

async function resolveWorkspaceFileReference(
  candidate: string,
  workspaceRealPathPromise: Promise<string>,
): Promise<ResolvedFileReference | null> {
  const parsedCandidate = parseFileLocation(candidate.trim());
  if (parsedCandidate === null || isRejectedPathForm(parsedCandidate.path)) {
    return null;
  }
  try {
    const workspaceRealPath = await workspaceRealPathPromise;
    if (isUncPath(workspaceRealPath)) {
      return null;
    }
    const candidatePath = isAbsolute(parsedCandidate.path)
      ? parsedCandidate.path
      : resolve(workspaceRealPath, parsedCandidate.path);
    const targetRealPath = await realpath(candidatePath);
    const targetStats = await stat(targetRealPath);
    if (!targetStats.isFile()) {
      return null;
    }
    const workspaceRelativePath = relative(workspaceRealPath, targetRealPath);
    if (!isPathInsideWorkspace(workspaceRelativePath)) {
      return null;
    }
    return Object.freeze({
      relativePath: workspaceRelativePath.split(sep).join("/"),
      ...(parsedCandidate.line === undefined ? {} : { line: parsedCandidate.line }),
      ...(parsedCandidate.column === undefined ? {} : { column: parsedCandidate.column }),
      fileUrl: pathToFileURL(targetRealPath).href,
    });
  } catch {
    return null;
  }
}

function parseFileLocation(
  candidate: string,
): Readonly<{ path: string; line?: number; column?: number }> | null {
  if (candidate.length === 0 || candidate.includes("\n") || candidate.includes("\t")) {
    return null;
  }
  const hashLocation = /^(.*)#L([1-9]\d*)(?:C([1-9]\d*))?$/u.exec(candidate);
  if (hashLocation?.[1] !== undefined && hashLocation[2] !== undefined) {
    const line = toSafePositiveInteger(hashLocation[2]);
    const column =
      hashLocation[3] === undefined ? undefined : toSafePositiveInteger(hashLocation[3]);
    if (line === null || column === null) {
      return null;
    }
    return Object.freeze({
      path: hashLocation[1],
      line,
      ...(column === undefined ? {} : { column }),
    });
  }

  const finalNumber = /:([1-9]\d*)$/u.exec(candidate);
  if (finalNumber?.[1] === undefined || finalNumber.index === undefined) {
    return Object.freeze({ path: candidate });
  }
  const finalValue = toSafePositiveInteger(finalNumber[1]);
  if (finalValue === null) {
    return null;
  }
  const beforeFinalNumber = candidate.slice(0, finalNumber.index);
  const precedingNumber = /:([1-9]\d*)$/u.exec(beforeFinalNumber);
  if (precedingNumber?.[1] !== undefined && precedingNumber.index !== undefined) {
    const line = toSafePositiveInteger(precedingNumber[1]);
    if (line === null) {
      return null;
    }
    return Object.freeze({
      path: beforeFinalNumber.slice(0, precedingNumber.index),
      line,
      column: finalValue,
    });
  }
  return Object.freeze({ path: beforeFinalNumber, line: finalValue });
}

function toSafePositiveInteger(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isRejectedPathForm(path: string): boolean {
  if (path.length === 0 || isUncPath(path)) {
    return true;
  }
  if (/^[A-Za-z]:[^\\/]/u.test(path)) {
    return true;
  }
  if (/^[^/\\\s]+@[^/\\\s]+:/u.test(path)) {
    return true;
  }
  return /^[A-Za-z][A-Za-z\d+.-]*:/u.test(path) && !/^[A-Za-z]:[\\/]/u.test(path);
}

function isUncPath(path: string): boolean {
  return path.startsWith("\\\\") || path.startsWith("//");
}

function isPathInsideWorkspace(workspaceRelativePath: string): boolean {
  return (
    workspaceRelativePath.length > 0 &&
    workspaceRelativePath !== ".." &&
    !workspaceRelativePath.startsWith(`..${sep}`) &&
    !isAbsolute(workspaceRelativePath)
  );
}

function fileSpan(reference: ResolvedFileReference): FileSpan {
  const location = `${reference.line === undefined ? "" : `:${reference.line}`}${
    reference.column === undefined ? "" : `:${reference.column}`
  }`;
  return Object.freeze({
    type: "file",
    text: `${reference.relativePath}${location}`,
    fileUrl: reference.fileUrl,
  });
}

function textSpan(text: string, color: TerminalPaletteColor | null = null, dim = false): TextSpan {
  return Object.freeze({ type: "text", text, color, dim });
}

function writeContentSpans(
  spans: readonly ContentSpan[],
  capabilities: TerminalCapabilities,
): string {
  return spans
    .map((span) => {
      if (span.type === "text") {
        return writeStyledText(span.text, span.color, span.dim, capabilities.colorDepth);
      }
      const marker = capabilities.unicode ? "▧" : "[file]";
      const label = `${marker} ${span.text}`;
      const styledLabel = writeStyledText(label, "lagoon", false, capabilities.colorDepth);
      return capabilities.hyperlinks
        ? `\u001B]8;;${span.fileUrl}\u001B\\${styledLabel}\u001B]8;;\u001B\\`
        : styledLabel;
    })
    .join("");
}

function writeHighlightedCode(
  lines: readonly HighlightedCodeLine[],
  colorDepth: TerminalColorDepth,
): string {
  return lines
    .map((line) =>
      line.map((token) => writeStyledText(token.text, token.color, token.dim, colorDepth)).join(""),
    )
    .join("\n");
}

function writeStyledText(
  text: string,
  color: TerminalPaletteColor | null,
  dim: boolean,
  colorDepth: TerminalColorDepth,
): string {
  if (text.length === 0 || colorDepth === "none" || (color === null && !dim)) {
    return text;
  }
  const parameters: string[] = [];
  if (color !== null) {
    const paletteColor = PALETTE[color];
    switch (colorDepth) {
      case "truecolor":
        parameters.push(`38;2;${paletteColor.rgb.join(";")}`);
        break;
      case "ansi256":
        parameters.push(`38;5;${paletteColor.ansi256}`);
        break;
      case "ansi16":
        parameters.push(String(paletteColor.ansi16));
        break;
    }
  }
  if (dim) {
    parameters.push("2");
  }
  return `\u001B[${parameters.join(";")}m${text}\u001B[0m`;
}

function reconstructHighlightedCode(lines: readonly HighlightedCodeLine[]): string {
  return lines.map((line) => line.map((token) => token.text).join("")).join("\n");
}

function countLines(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  let lineCount = 1;
  for (const character of value) {
    if (character === "\n") {
      lineCount += 1;
    }
  }
  return lineCount;
}

/** 模型文本只能保留可显示字符、LF 与 Tab；控制序列和畸形 UTF-16 都替换为 U+FFFD。 */
function sanitizeModelText(value: string): string {
  let safeText = "";
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x0d) {
      if (value.charCodeAt(index + 1) === 0x0a) {
        index += 1;
      }
      safeText += "\n";
      continue;
    }
    if (codeUnit === 0x0a || codeUnit === 0x09) {
      safeText += value[index];
      continue;
    }
    if (codeUnit <= 0x1f || (codeUnit >= 0x7f && codeUnit <= 0x9f)) {
      safeText += "�";
      continue;
    }
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        safeText += `${value[index] ?? ""}${value[index + 1] ?? ""}`;
        index += 1;
      } else {
        safeText += "�";
      }
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      safeText += "�";
      continue;
    }
    safeText += value[index] ?? "";
  }
  return safeText;
}

/** 清理所有即将写入终端的非受控文本，不生成任何终端控制序列。 */
export function sanitizeTerminalText(value: string): string {
  return sanitizeModelText(value);
}

/** 普通启动与纯文本消息不加载 Shiki；首次合格代码块才解析高亮 Module。 */
const highlightCodeWithLazyShiki: CodeHighlighter = async (code, language) => {
  const { highlightCodeWithShiki } = await import("./syntax-highlighter.js");
  return highlightCodeWithShiki(code, language);
};
