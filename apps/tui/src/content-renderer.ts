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

export type ResolvedFileReference = Readonly<{
  relativePath: string;
  line?: number;
  column?: number;
  fileUrl: string;
}>;

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

export async function resolveWorkspaceFileReference(
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

/** 使用 Content Renderer 的同一调色板呈现 TUI 固定标签。 */
export function styleTerminalText(
  value: string,
  color: TerminalPaletteColor,
  capabilities: TerminalCapabilities,
  dim = false,
): string {
  return writeStyledText(sanitizeModelText(value), color, dim, capabilities.colorDepth);
}

/** 只用于已经清理正文后、由主题组合产生的样式片段。 */
export function styleTerminalFragment(
  value: string,
  color: TerminalPaletteColor,
  capabilities: TerminalCapabilities,
): string {
  return writeStyledText(value, color, false, capabilities.colorDepth);
}
