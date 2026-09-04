import { glob as nodeGlob, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { AssistantToolCallPart } from "../message.js";
import {
  hasOnlyKeys,
  isNonEmptyString,
  isOptionalIntegerInRange,
  isOptionalNonEmptyString,
  isRecord,
} from "./input-validation.js";
import {
  boundToolOutput,
  TOOL_RESULT_LINE_LIMIT,
  type ToolExecutionResult,
} from "./tool-result.js";
import {
  isPathSameOrInside,
  normalizeWorkspaceRelativePath,
  type ResolvedWorkspacePath,
  resolveExistingAbsoluteWorkspacePath,
  resolveExistingWorkspacePath,
  type ToolWorkspace,
  validateWorkspaceRelativePath,
} from "./workspace-path.js";

/** 表示只读 Tool 已完成运行时校验后的固定输入。 */
type ReadOnlyToolInput =
  | Readonly<{ toolName: "read_file"; path: string; startLine: number; lineCount: number }>
  | Readonly<{ toolName: "glob"; pattern: string; path: string }>
  | Readonly<{
      toolName: "grep";
      pattern: string;
      path: string;
      filePattern: string;
      contextLines: number;
    }>;

/** 保存 Glob 的稳定文件集合以及是否因候选上限未穷尽。 */
type DiscoveredFiles = Readonly<{
  paths: readonly ResolvedWorkspacePath[];
  truncated: boolean;
}>;

const FILE_DISCOVERY_LIMIT = 10000;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** 自动执行一个已形成的只读 ToolCall，并把预期失败收敛为 ToolResult。 */
export async function executeReadOnlyTool(
  toolCall: AssistantToolCallPart,
  workspace: ToolWorkspace,
  abortSignal: AbortSignal,
): Promise<ToolExecutionResult> {
  if (abortSignal.aborted) {
    return failedResult("Tool 执行已停止。");
  }
  const inputResult = parseReadOnlyToolInput(toolCall);
  if (!inputResult.ok) {
    return failedResult(inputResult.error);
  }
  try {
    switch (inputResult.input.toolName) {
      case "read_file":
        return await executeReadFile(inputResult.input, workspace, abortSignal);
      case "glob":
        return await executeGlob(inputResult.input, workspace, abortSignal);
      case "grep":
        return await executeGrep(inputResult.input, workspace, abortSignal);
    }
  } catch (error) {
    if (abortSignal.aborted) {
      return failedResult("Tool 执行已停止。");
    }
    return failedResult(toSafeToolError(error));
  }
}

/** 执行 read_file 并返回有范围、继续位置和截断事实的文本。 */
async function executeReadFile(
  input: Extract<ReadOnlyToolInput, { toolName: "read_file" }>,
  workspace: ToolWorkspace,
  abortSignal: AbortSignal,
): Promise<ToolExecutionResult> {
  const target = await resolveExistingWorkspacePath(input.path, workspace);
  const targetStats = await stat(target.absolutePath);
  if (!targetStats.isFile()) {
    return failedResult(`read_file 目标不是文件：${target.relativePath}`);
  }
  const text = await readStrictUtf8File(target.absolutePath);
  if (abortSignal.aborted) {
    return failedResult("Tool 执行已停止。");
  }
  const lines = splitTextLines(text);
  const startIndex = Math.min(input.startLine - 1, lines.length);
  const selectedLines = lines.slice(startIndex, startIndex + input.lineCount);
  const endLine = selectedLines.length === 0 ? startIndex : startIndex + selectedLines.length;
  const hasMoreLines = startIndex + selectedLines.length < lines.length;
  const rendered = boundToolOutput([
    `path: ${target.relativePath}`,
    `lines: ${selectedLines.length === 0 ? "none" : `${startIndex + 1}-${endLine}`} of ${lines.length}`,
    `nextStartLine: ${hasMoreLines ? endLine + 1 : "none"}`,
    "---",
    ...selectedLines.map((line, index) => `${startIndex + index + 1}| ${line}`),
  ]);
  return Object.freeze({
    status: "completed",
    content: rendered.content,
    truncated: hasMoreLines || rendered.truncated,
  });
}

/** 执行 glob 并稳定排序工作区相对文件路径。 */
async function executeGlob(
  input: Extract<ReadOnlyToolInput, { toolName: "glob" }>,
  workspace: ToolWorkspace,
  abortSignal: AbortSignal,
): Promise<ToolExecutionResult> {
  const discoveredFiles = await discoverFiles(input.pattern, input.path, workspace, abortSignal);
  const rendered = boundToolOutput([
    `pattern: ${input.pattern}`,
    `base: ${input.path}`,
    ...discoveredFiles.paths.map((file) => file.relativePath),
  ]);
  return Object.freeze({
    status: "completed",
    content: rendered.content,
    truncated: discoveredFiles.truncated || rendered.truncated,
  });
}

/** 执行 grep，并用相对路径、行号和可选上下文呈现匹配。 */
async function executeGrep(
  input: Extract<ReadOnlyToolInput, { toolName: "grep" }>,
  workspace: ToolWorkspace,
  abortSignal: AbortSignal,
): Promise<ToolExecutionResult> {
  let searchPattern: RegExp;
  try {
    searchPattern = new RegExp(input.pattern, "u");
  } catch {
    return failedResult("grep pattern 不是有效的 JavaScript Unicode 正则。");
  }
  const discoveredFiles = await discoverFiles(
    input.filePattern,
    input.path,
    workspace,
    abortSignal,
  );
  const resultLines: string[] = [`pattern: ${input.pattern}`, `base: ${input.path}`];
  let skippedFileCount = 0;
  let resultTruncated = discoveredFiles.truncated;

  for (const file of discoveredFiles.paths) {
    if (abortSignal.aborted) {
      return failedResult("Tool 执行已停止。");
    }
    let text: string;
    try {
      text = await readStrictUtf8File(file.absolutePath);
    } catch {
      skippedFileCount += 1;
      continue;
    }
    const fileLines = splitTextLines(text);
    for (let lineIndex = 0; lineIndex < fileLines.length; lineIndex += 1) {
      if (!searchPattern.test(fileLines[lineIndex] ?? "")) {
        continue;
      }
      const contextStart = Math.max(0, lineIndex - input.contextLines);
      const contextEnd = Math.min(fileLines.length - 1, lineIndex + input.contextLines);
      for (let contextIndex = contextStart; contextIndex <= contextEnd; contextIndex += 1) {
        const marker = contextIndex === lineIndex ? ":" : "-";
        resultLines.push(
          `${file.relativePath}${marker}${contextIndex + 1}${marker}${fileLines[contextIndex] ?? ""}`,
        );
      }
      if (resultLines.length > TOOL_RESULT_LINE_LIMIT * 2) {
        resultTruncated = true;
        break;
      }
    }
    if (resultTruncated && resultLines.length > TOOL_RESULT_LINE_LIMIT * 2) {
      break;
    }
  }
  resultLines.splice(2, 0, `skippedNonUtf8OrBinaryFiles: ${skippedFileCount}`);
  const rendered = boundToolOutput(resultLines);
  return Object.freeze({
    status: "completed",
    content: rendered.content,
    truncated: resultTruncated || rendered.truncated,
  });
}

/** 解析三个只读 Tool 的精确输入，拒绝未知字段和错误类型。 */
function parseReadOnlyToolInput(
  toolCall: AssistantToolCallPart,
): Readonly<{ ok: true; input: ReadOnlyToolInput }> | Readonly<{ ok: false; error: string }> {
  if (toolCall.invalid) {
    return Object.freeze({
      ok: false,
      error: `${toolCall.toolName} 输入无法解析或不符合 Schema。`,
    });
  }
  if (!isRecord(toolCall.input)) {
    return Object.freeze({ ok: false, error: `${toolCall.toolName} 输入必须是 JSON 对象。` });
  }
  const input = toolCall.input;
  if (toolCall.toolName === "read_file") {
    if (
      !hasOnlyKeys(input, ["path", "startLine", "lineCount"]) ||
      !isNonEmptyString(input.path) ||
      !isOptionalIntegerInRange(input.startLine, 1, Number.MAX_SAFE_INTEGER) ||
      !isOptionalIntegerInRange(input.lineCount, 1, 2000)
    ) {
      return Object.freeze({ ok: false, error: "read_file 输入不符合 Schema。" });
    }
    return Object.freeze({
      ok: true,
      input: Object.freeze({
        toolName: "read_file",
        path: input.path,
        startLine: input.startLine ?? 1,
        lineCount: input.lineCount ?? 200,
      }),
    });
  }
  if (toolCall.toolName === "glob") {
    if (
      !hasOnlyKeys(input, ["pattern", "path"]) ||
      !isNonEmptyString(input.pattern) ||
      !isOptionalNonEmptyString(input.path)
    ) {
      return Object.freeze({ ok: false, error: "glob 输入不符合 Schema。" });
    }
    return Object.freeze({
      ok: true,
      input: Object.freeze({ toolName: "glob", pattern: input.pattern, path: input.path ?? "." }),
    });
  }
  if (toolCall.toolName === "grep") {
    if (
      !hasOnlyKeys(input, ["pattern", "path", "filePattern", "contextLines"]) ||
      typeof input.pattern !== "string" ||
      !isOptionalNonEmptyString(input.path) ||
      !isOptionalNonEmptyString(input.filePattern) ||
      !isOptionalIntegerInRange(input.contextLines, 0, 10)
    ) {
      return Object.freeze({ ok: false, error: "grep 输入不符合 Schema。" });
    }
    return Object.freeze({
      ok: true,
      input: Object.freeze({
        toolName: "grep",
        pattern: input.pattern,
        path: input.path ?? ".",
        filePattern: input.filePattern ?? "**/*",
        contextLines: input.contextLines ?? 0,
      }),
    });
  }
  return Object.freeze({ ok: false, error: `未知 Tool：${toolCall.toolName}` });
}

/** 发现并真实路径校验文件，保证稳定排序且隔离 Session 目录。 */
async function discoverFiles(
  pattern: string,
  basePath: string,
  workspace: ToolWorkspace,
  abortSignal: AbortSignal,
): Promise<DiscoveredFiles> {
  validateWorkspaceRelativePath(pattern, "Glob pattern");
  const base = await resolveExistingWorkspacePath(basePath, workspace);
  const baseStats = await stat(base.absolutePath);
  if (!baseStats.isDirectory()) {
    throw new Error(`搜索基准不是目录：${base.relativePath}`);
  }
  const files: ResolvedWorkspacePath[] = [];
  let truncated = false;
  const sessionExcludePatterns = createSessionGlobExclusions(
    base.absolutePath,
    workspace.sessionDirectory,
  );
  for await (const candidate of nodeGlob(pattern, {
    cwd: base.absolutePath,
    exclude: sessionExcludePatterns,
  })) {
    if (abortSignal.aborted) {
      throw new Error("Tool 执行已停止。");
    }
    const candidatePath = resolve(base.absolutePath, candidate);
    let resolvedCandidate: ResolvedWorkspacePath;
    try {
      resolvedCandidate = await resolveExistingAbsoluteWorkspacePath(candidatePath, workspace);
      if (!(await stat(resolvedCandidate.absolutePath)).isFile()) {
        continue;
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("Session 保留目录")) {
        continue;
      }
      throw error;
    }
    files.push(resolvedCandidate);
    if (files.length >= FILE_DISCOVERY_LIMIT) {
      truncated = true;
      break;
    }
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
  return Object.freeze({ paths: Object.freeze(files), truncated });
}

/** 在 Node Glob 进入目录前排除 Session 路径，避免先遍历再过滤。 */
function createSessionGlobExclusions(
  basePath: string,
  sessionDirectory: string,
): readonly string[] {
  if (!isPathSameOrInside(basePath, sessionDirectory)) {
    return Object.freeze([]);
  }
  const sessionRelativePath = normalizeWorkspaceRelativePath(relative(basePath, sessionDirectory));
  return Object.freeze([sessionRelativePath, `${sessionRelativePath}/**`]);
}

/** 以 fatal UTF-8 解码读取文本，并拒绝包含 NUL 的二进制内容。 */
async function readStrictUtf8File(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  if (bytes.includes(0)) {
    throw new Error("文件包含二进制内容。");
  }
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw new Error("文件不是有效的 UTF-8 文本。");
  }
}

/** 按跨平台换行拆分文本，同时不虚构末尾额外空行。 */
function splitTextLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

/** 生成一个不会抛出到 Agent Loop 的预期 Tool 失败。 */
function failedResult(content: string): ToolExecutionResult {
  return Object.freeze({ status: "failed", content, truncated: false });
}

/** 将文件系统异常收敛为不包含绝对路径和堆栈的安全文本。 */
function toSafeToolError(error: unknown): string {
  const errorCode = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof errorCode === "string") {
    return `Tool 文件操作失败：${errorCode}`;
  }
  return error instanceof Error ? error.message : "Tool 执行失败。";
}
