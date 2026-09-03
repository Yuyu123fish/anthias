import { glob as nodeGlob, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import type { JSONSchema7 } from "ai";
import type { AssistantToolCallPart } from "./agent.js";
import type { SessionShell } from "./session.js";

/** 枚举 Feature 002 固定提供给模型的六个 Tool 名称。 */
export type FixedToolName =
  | "read_file"
  | "glob"
  | "grep"
  | "edit_file"
  | "write_file"
  | "execute_command";

/** 描述 Model Adapter 所需且不含 execute 回调的固定 Tool。 */
export type ModelToolDefinition = Readonly<{
  name: FixedToolName;
  description: string;
  inputSchema: JSONSchema7;
}>;

/** 提供固定 Tool 执行时唯一可见的工作区与保留目录。 */
export type ToolWorkspace = Readonly<{
  workspaceRoot: string;
  sessionDirectory: string;
}>;

/** 表示一个已经收敛且可直接持久化的 Tool 结果。 */
export type ToolExecutionResult = Readonly<{
  status: "completed" | "failed";
  content: string;
  truncated: boolean;
}>;

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

/** 保存一个经过真实路径校验的工作区文件或目录。 */
export type ResolvedWorkspacePath = Readonly<{
  absolutePath: string;
  relativePath: string;
}>;

/** 保存 Glob 的稳定文件集合以及是否因候选预算未穷尽。 */
type DiscoveredFiles = Readonly<{
  paths: readonly ResolvedWorkspacePath[];
  truncated: boolean;
}>;

export const TOOL_RESULT_BYTE_LIMIT = 64 * 1024;
export const TOOL_RESULT_LINE_LIMIT = 2000;
const FILE_DISCOVERY_LIMIT = 10000;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** Feature 002 的固定 Tool Schema；实际输入仍由 Agent 自己再次校验。 */
export const FIXED_TOOL_DEFINITIONS: readonly ModelToolDefinition[] = Object.freeze([
  defineTool("read_file", "读取工作区内 UTF-8 文本文件的指定行范围。", {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", minLength: 1 },
      startLine: { type: "integer", minimum: 1 },
      lineCount: { type: "integer", minimum: 1, maximum: 2000 },
    },
  }),
  defineTool("glob", "按 Glob 模式发现工作区内的文件。", {
    type: "object",
    additionalProperties: false,
    required: ["pattern"],
    properties: {
      pattern: { type: "string", minLength: 1 },
      path: { type: "string", minLength: 1 },
    },
  }),
  defineTool("grep", "按正则搜索工作区内 UTF-8 文本文件。", {
    type: "object",
    additionalProperties: false,
    required: ["pattern"],
    properties: {
      pattern: { type: "string" },
      path: { type: "string", minLength: 1 },
      filePattern: { type: "string", minLength: 1 },
      contextLines: { type: "integer", minimum: 0, maximum: 10 },
    },
  }),
  defineTool("edit_file", "对已有 UTF-8 文本文件执行一组精确替换。", {
    type: "object",
    additionalProperties: false,
    required: ["path", "replacements"],
    properties: {
      path: { type: "string", minLength: 1 },
      replacements: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["oldText", "newText"],
          properties: {
            oldText: { type: "string", minLength: 1 },
            newText: { type: "string" },
          },
        },
      },
    },
  }),
  defineTool("write_file", "创建 UTF-8 文本文件或完整覆盖已有文件。", {
    type: "object",
    additionalProperties: false,
    required: ["path", "content"],
    properties: {
      path: { type: "string", minLength: 1 },
      content: { type: "string" },
    },
  }),
  defineTool("execute_command", "在 Session 固定 Shell 中执行一次性非交互命令。", {
    type: "object",
    additionalProperties: false,
    required: ["command"],
    properties: {
      command: { type: "string", minLength: 1 },
      cwd: { type: "string", minLength: 1 },
      timeoutMs: { type: "integer", minimum: 1000, maximum: 1800000 },
    },
  }),
]);

/** 构建每次模型请求使用、但不写入 Session 的 Coding Agent 系统提示词。 */
export function createCodingSystemPrompt(workspaceRoot: string, shell: SessionShell): string {
  const shellCommand = [shell.executable, ...shell.arguments].join(" ");
  return [
    "你是 Anthias，一个本地优先的 Coding Agent。",
    `当前工作区：${workspaceRoot}`,
    `当前平台：${process.platform}`,
    `固定 Shell：${shellCommand}`,
    "只能使用 read_file、glob、grep、edit_file、write_file、execute_command 六个 Tool。",
    "先检查真实代码，再做必要修改；修改已有文件优先使用 edit_file。",
    "read_file、glob、grep 自动执行；edit_file、write_file、execute_command 每次都需要用户确认。",
    "修改后运行相关验证，并在最终回答中如实报告成功、失败和未验证边界。",
  ].join("\n");
}

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

/** 判断名称是否属于无需人工确认的三个只读 Tool。 */
export function isReadOnlyToolName(toolName: string): boolean {
  return toolName === "read_file" || toolName === "glob" || toolName === "grep";
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
  validateRelativePath(pattern, "Glob pattern");
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
      resolvedCandidate = await resolveExistingAbsolutePath(candidatePath, workspace);
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
  if (!isSameOrInside(basePath, sessionDirectory)) {
    return Object.freeze([]);
  }
  const sessionRelativePath = normalizeRelativePath(relative(basePath, sessionDirectory));
  return Object.freeze([sessionRelativePath, `${sessionRelativePath}/**`]);
}

/** 解析一个工作区相对路径并执行真实路径与保留目录校验。 */
export async function resolveExistingWorkspacePath(
  requestedPath: string,
  workspace: ToolWorkspace,
  allowSessionDirectory = false,
): Promise<ResolvedWorkspacePath> {
  validateRelativePath(requestedPath, "Tool path");
  return resolveExistingAbsolutePath(
    resolve(workspace.workspaceRoot, requestedPath),
    workspace,
    allowSessionDirectory,
  );
}

/** 校验一个已组合的绝对路径仍位于工作区且未进入 Session 保留目录。 */
async function resolveExistingAbsolutePath(
  candidatePath: string,
  workspace: ToolWorkspace,
  allowSessionDirectory = false,
): Promise<ResolvedWorkspacePath> {
  const actualPath = await realpath(candidatePath);
  if (!isSameOrInside(workspace.workspaceRoot, actualPath)) {
    throw new Error("Tool path 越出工作区。");
  }
  if (!allowSessionDirectory && isSameOrInside(workspace.sessionDirectory, actualPath)) {
    throw new Error("Tool path 命中 Session 保留目录。");
  }
  return Object.freeze({
    absolutePath: actualPath,
    relativePath: normalizeRelativePath(relative(workspace.workspaceRoot, actualPath)),
  });
}

/** 拒绝绝对路径、父目录逃逸和会改变搜索基准的 Glob 片段。 */
function validateRelativePath(requestedPath: string, label: string): void {
  if (
    requestedPath.length === 0 ||
    isAbsolute(requestedPath) ||
    win32.isAbsolute(requestedPath) ||
    requestedPath.replaceAll("\\", "/").split("/").includes("..")
  ) {
    throw new Error(`${label} 必须是工作区相对路径。`);
  }
}

/** 使用平台路径语义判断目标是否等于或位于父目录内。 */
function isSameOrInside(parentPath: string, targetPath: string): boolean {
  const relativePath = relative(parentPath, targetPath);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== "..");
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

/** 同时按 UTF-8 字节和行数限制 ToolResult，并明确未穷尽。 */
export function boundToolOutput(
  lines: readonly string[],
): Readonly<{ content: string; truncated: boolean }> {
  const acceptedLines: string[] = [];
  let byteCount = 0;
  let truncated = false;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(`${line}\n`, "utf8");
    if (
      acceptedLines.length >= TOOL_RESULT_LINE_LIMIT ||
      byteCount + lineBytes > TOOL_RESULT_BYTE_LIMIT
    ) {
      truncated = true;
      break;
    }
    acceptedLines.push(line);
    byteCount += lineBytes;
  }
  if (truncated) {
    const marker = "...[结果已截断，未穷尽]";
    while (
      acceptedLines.length > 0 &&
      Buffer.byteLength(`${acceptedLines.join("\n")}\n${marker}`, "utf8") > TOOL_RESULT_BYTE_LIMIT
    ) {
      acceptedLines.pop();
    }
    acceptedLines.push(marker);
  }
  return Object.freeze({ content: acceptedLines.join("\n"), truncated });
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

/** 判断未知值是否为普通 JSON 对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 判断对象是否只包含 Schema 声明的字段。 */
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

/** 判断未知值是否为非空字符串。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** 判断可选值缺失或为非空字符串。 */
function isOptionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

/** 判断可选值缺失或为指定闭区间内的整数。 */
function isOptionalIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum)
  );
}

/** 把平台分隔符统一为模型可复用的正斜杠相对路径。 */
function normalizeRelativePath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

/** 创建并冻结一个不含执行行为的 Model Tool 定义。 */
function defineTool(
  name: FixedToolName,
  description: string,
  inputSchema: JSONSchema7,
): ModelToolDefinition {
  return Object.freeze({ name, description, inputSchema: Object.freeze(inputSchema) });
}
