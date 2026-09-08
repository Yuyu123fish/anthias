import { opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  CombinedAutocompleteProvider,
  fuzzyFilter,
  type SlashCommand,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./content-renderer.js";

const MAX_ENTRIES = 4_000;
const MAX_SUGGESTIONS = 100;
const MAX_DEPTH = 8;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

type FilePrefix = Readonly<{
  text: string;
  path: string;
  reference: boolean;
  quote: string;
}>;

type FileCandidate = Readonly<{
  relativePath: string;
  name: string;
  directory: boolean;
}>;

/** 只查询候选；按键、取消、过期结果与光标生命周期仍由 Editor 持有。 */
export function createInputAutocomplete(
  commands: SlashCommand[],
  workspaceRoot: string,
): AutocompleteProvider {
  const commandProvider = new CombinedAutocompleteProvider(commands, workspaceRoot);
  return {
    triggerCharacters: ["\\"],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      if (options.signal.aborted) return null;
      const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
      const filePrefix = extractFilePrefix(textBeforeCursor);
      // Editor 会把无菜单的参数 Tab 标成 force；这不能改变当前命令的参数语义。
      if (!filePrefix.reference && isCommandContext(textBeforeCursor, cursorLine)) {
        return commandProvider.getSuggestions(lines, cursorLine, cursorCol, {
          ...options,
          force: false,
        });
      }
      if (
        !options.force &&
        !filePrefix.reference &&
        !/[\\/]/u.test(filePrefix.path) &&
        !filePrefix.path.startsWith(".") &&
        !filePrefix.path.startsWith("~")
      )
        return null;
      const items = await fileSuggestions(filePrefix, workspaceRoot, options.signal);
      return items.length && !options.signal.aborted ? { items, prefix: filePrefix.text } : null;
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const currentLine = lines[cursorLine] ?? "";
      if (!prefix.startsWith("@") && isCommandContext(currentLine.slice(0, cursorCol), cursorLine))
        return commandProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
      const afterCursor = currentLine.slice(cursorCol);
      const directory = /[\\/]$/u.test(item.label);
      const quote = extractFilePrefix(prefix).quote;
      const closingQuote = quote || (item.value.endsWith('"') ? '"' : "");
      const consumesQuote = closingQuote !== "" && afterCursor.startsWith(closingQuote);
      const remainingText = afterCursor.slice(consumesQuote ? 1 : 0);
      const referenceFile = prefix.startsWith("@") && !directory;
      const existingSpace = referenceFile && remainingText.startsWith(" ");
      const suffix = referenceFile && !existingSpace ? " " : "";
      const updatedLines = [...lines];
      updatedLines[cursorLine] = beforePrefix + item.value + suffix + remainingText;
      return {
        lines: updatedLines,
        cursorLine,
        cursorCol:
          beforePrefix.length +
          item.value.length +
          suffix.length +
          (existingSpace ? 1 : 0) -
          (directory && closingQuote !== "" ? 1 : 0),
      };
    },
  };
}

function isCommandContext(text: string, cursorLine: number): boolean {
  return cursorLine === 0 && /^\/[^/\\\s]*(?:\s|$)/u.test(text);
}

function extractFilePrefix(text: string): FilePrefix {
  let tokenStart = 0;
  let activeQuote = "";
  for (let index = 0; index < text.length; index++) {
    const character = text[index] ?? "";
    if (activeQuote) {
      if (character === activeQuote) activeQuote = "";
    } else if (character === '"' || character === "'") {
      activeQuote = character;
    } else if (/\s/u.test(character) || character === "=") {
      tokenStart = index + 1;
    }
  }
  const prefix = text.slice(tokenStart);
  const reference = prefix.startsWith("@");
  let path = prefix.slice(reference ? 1 : 0);
  const quote = path.startsWith('"') ? '"' : path.startsWith("'") ? "'" : "";
  if (quote) {
    path = path.slice(1);
    if (path.endsWith(quote)) path = path.slice(0, -1);
  }
  return { text: prefix, path, reference, quote };
}

async function fileSuggestions(
  prefix: FilePrefix,
  workspaceRoot: string,
  signal: AbortSignal,
): Promise<AutocompleteItem[]> {
  let normalizedPath = prefix.path.replace(/\\/gu, "/");
  if (normalizedPath === "~" || (process.platform === "win32" && /^[a-z]:$/iu.test(normalizedPath)))
    normalizedPath += "/";
  const separator = prefix.path.includes("\\") ? "\\" : "/";
  const lastSeparator = normalizedPath.lastIndexOf("/");
  const displayDirectory = normalizedPath.slice(0, lastSeparator + 1);
  const query = normalizedPath.slice(lastSeparator + 1);
  const directoryPath = displayDirectory.startsWith("~/")
    ? resolve(homedir(), displayDirectory.slice(2))
    : resolve(workspaceRoot, displayDirectory || ".");
  const candidates = await readCandidates(
    directoryPath,
    prefix.reference && query.length > 0,
    signal,
  );
  const matches = prefix.reference
    ? fuzzyFilter(candidates, query, (candidate) => candidate.relativePath)
    : candidates.filter((candidate) =>
        process.platform === "win32"
          ? candidate.name.toLowerCase().startsWith(query.toLowerCase())
          : candidate.name.startsWith(query),
      );
  return matches.slice(0, MAX_SUGGESTIONS).map((candidate) => {
    const path = (
      displayDirectory +
      candidate.relativePath +
      (candidate.directory ? "/" : "")
    ).replaceAll("/", separator);
    const quote = prefix.quote || (/\s/u.test(path) ? '"' : "");
    return {
      value: `${prefix.reference ? "@" : ""}${quote}${path}${quote}`,
      label: sanitizeTerminalText(candidate.name + (candidate.directory ? separator : "")),
      description: sanitizeTerminalText(displayDirectory + candidate.relativePath),
    };
  });
}

async function readCandidates(
  directoryPath: string,
  recursive: boolean,
  signal: AbortSignal,
): Promise<FileCandidate[]> {
  const candidates: FileCandidate[] = [];
  const directories = [{ relativePath: "", depth: 0 }];
  let inspectedEntries = 0;
  for (let index = 0; index < directories.length && inspectedEntries < MAX_ENTRIES; index++) {
    const directory = directories[index];
    if (directory === undefined || signal.aborted) break;
    try {
      const directoryHandle = await opendir(resolve(directoryPath, directory.relativePath));
      // for-await 在取消与达到预算时也关闭目录句柄；不跟随链接递归，避免环与无限扫描。
      for await (const entry of directoryHandle) {
        if (signal.aborted || inspectedEntries++ >= MAX_ENTRIES) break;
        if (
          [...entry.name].some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          ) ||
          entry.name === ".git"
        )
          continue;
        const relativePath = directory.relativePath + entry.name;
        let isDirectory = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          try {
            isDirectory = (await stat(resolve(directoryPath, relativePath))).isDirectory();
          } catch {
            continue;
          }
        }
        candidates.push({ relativePath, name: entry.name, directory: isDirectory });
        if (
          recursive &&
          entry.isDirectory() &&
          directory.depth < MAX_DEPTH &&
          !SKIPPED_DIRECTORIES.has(entry.name)
        )
          directories.push({ relativePath: `${relativePath}/`, depth: directory.depth + 1 });
      }
    } catch {
      // 候选只是提示；目录删除、权限不足或不可访问时保留输入并结束该目录查询。
    }
  }
  return candidates.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, undefined, { numeric: true }),
  );
}
