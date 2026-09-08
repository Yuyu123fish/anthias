import { createReadStream } from "node:fs";
import {
  boundTextToTokenBudget,
  estimateTextTokens,
  TOOL_RESULT_TOKEN_LIMIT,
} from "../context/budget.js";
import type { ArtifactSourceStatus, SessionArtifactStore } from "../session/artifacts.js";

/** 文件页范围只在结果收敛前存在，最终范围按实际可见完整行生成。 */
export type ToolFilePage = Readonly<{
  path: string;
  startLine: number;
  totalLines: number;
  lines: readonly string[];
}>;

import type { ToolArtifactIncompleteReason, ToolArtifactReference } from "../message.js";

type ToolExecutionResultContent = Readonly<{
  content: string;
  truncated: boolean;
  artifact?: ToolArtifactReference;
  cleanupUncertain?: boolean;
  originalContent?: string;
  sourceIncomplete?: ToolArtifactIncompleteReason;
  filePage?: ToolFilePage;
  /** 命令临时输出的所有权交给结果收敛处，成功失败都必须清理。 */
  outputFile?: Readonly<{ path: string; dispose(): Promise<void> }>;
}>;

/** 表示预检与执行层可以安全返回的失败结果。 */
export type ToolFailedResult = ToolExecutionResultContent & Readonly<{ status: "failed" }>;

/** 执行层交付的 Tool 结果；原文与分页信息在统一收敛后不进入 Session。 */
export type ToolExecutionResult =
  | (ToolExecutionResultContent & Readonly<{ status: "completed" }>)
  | ToolFailedResult;

/** 限制单个 ToolResult 可以保存的 UTF-8 字节数。 */
export const TOOL_RESULT_BYTE_LIMIT = 64 * 1024;

/** 限制单个 ToolResult 可以保存的文本行数。 */
export const TOOL_RESULT_LINE_LIMIT = 2000;

/** 工具仅交付结果；此处统一保存超限原文并形成可入 Session 的正文。 */
export async function finalizeToolResult(
  toolCallId: string,
  result: ToolExecutionResult,
  artifactStore: SessionArtifactStore | undefined,
  tokenBudget = TOOL_RESULT_TOKEN_LIMIT,
  sourceStatus: ArtifactSourceStatus = result.status === "completed" ? "completed" : "failed",
): Promise<ToolExecutionResult> {
  let artifact = result.artifact;
  let preservationFailed = false;
  let cleanupUncertain = false;
  const sourceContent = result.originalContent ?? result.content;
  const needsArtifact =
    result.outputFile !== undefined ||
    !fitsToolOutput(sourceContent, tokenBudget) ||
    !fitsToolOutput(result.content, tokenBudget);
  try {
    if (artifact === undefined && needsArtifact) {
      if (artifactStore !== undefined) {
        artifact =
          (await artifactStore.save(
            toolCallId,
            result.outputFile === undefined
              ? sourceContent
              : createReadStream(result.outputFile.path),
            sourceStatus,
            result.sourceIncomplete,
          )) ?? undefined;
      }
      preservationFailed = artifact === undefined;
    }
  } catch {
    preservationFailed = true;
  } finally {
    try {
      await result.outputFile?.dispose();
    } catch {
      cleanupUncertain = true;
    }
  }
  const metadata = [
    ...(artifact === undefined ? [] : [artifactMetadata(sourceStatus, artifact)]),
    ...(result.sourceIncomplete === undefined
      ? []
      : [
          "sourceIncomplete: " +
            result.sourceIncomplete +
            "\n来源输出未穷尽，不能据此断言搜索或输出完整。",
        ]),
  ].join("\n");
  const contentBudget = Math.max(
    0,
    tokenBudget -
      estimateTextTokens(metadata.length ? metadata + "\n" : "") -
      (metadata.length ? 2 : 0),
  );
  const preservationMarker = preservationFailed
    ? "...[结果已截断，原文产物未保存，无法回读]"
    : artifact === undefined
      ? "...[结果已截断，未穷尽]"
      : "...[结果已截断，原文可通过 read_artifact 回读]";
  const commandMarker = "...[命令输出已截断，管道已继续排空]";
  const marker = result.content.includes(commandMarker)
    ? commandMarker + "\n" + preservationMarker
    : preservationMarker;
  const previewContent = preservationFailed
    ? result.content + "\n" + preservationMarker
    : result.content;
  const preview =
    result.filePage === undefined
      ? boundTextToTokenBudget(
          boundToolOutput(previewContent.split("\n")).content,
          contentBudget,
          marker,
        )
      : boundFilePage(result.filePage, contentBudget, marker);
  return Object.freeze({
    status: result.status,
    ...(cleanupUncertain ? { cleanupUncertain: true } : {}),
    content: metadata.length === 0 ? preview.content : metadata + "\n" + preview.content,
    truncated:
      result.truncated ||
      preview.truncated ||
      needsArtifact ||
      preservationFailed ||
      result.sourceIncomplete !== undefined,
    ...(artifact === undefined ? {} : { artifact }),
  });
}

export function renderToolFilePage(page: ToolFilePage, lineCount = page.lines.length): string {
  const endLine = page.startLine - 1 + lineCount;
  return [
    "path: " + page.path,
    "lines: " +
      (lineCount === 0 ? "none" : page.startLine + "-" + endLine) +
      " of " +
      page.totalLines,
    "nextStartLine: " + (endLine < page.totalLines ? endLine + 1 : "none"),
    "---",
    ...page.lines.slice(0, lineCount).map((line, index) => page.startLine + index + "| " + line),
  ].join("\n");
}

function boundFilePage(page: ToolFilePage, tokenBudget: number, marker: string) {
  const fullContent = renderToolFilePage(page);
  if (fitsToolOutput(fullContent, tokenBudget)) return { content: fullContent, truncated: false };
  const note = marker + "\n按 nextStartLine 继续读取；首行超限时使用产物读取剩余内容。";
  let lower = 0;
  let upper = page.lines.length;
  while (lower < upper) {
    const lineCount = Math.ceil((lower + upper) / 2);
    if (fitsToolOutput(renderToolFilePage(page, lineCount) + "\n" + note, tokenBudget))
      lower = lineCount;
    else upper = lineCount - 1;
  }
  const content = renderToolFilePage(page, lower) + "\n" + note;
  return fitsToolOutput(content, tokenBudget)
    ? { content, truncated: true }
    : {
        content: "文件页元数据超过预算；请缩小请求范围。\nnextStartLine: " + page.startLine,
        truncated: true,
      };
}

function fitsToolOutput(content: string, tokenBudget: number): boolean {
  return (
    Buffer.byteLength(content, "utf8") <= TOOL_RESULT_BYTE_LIMIT - 1024 &&
    content.split("\n").length <= TOOL_RESULT_LINE_LIMIT - 16 &&
    estimateTextTokens(content) <= tokenBudget
  );
}

function artifactMetadata(status: ArtifactSourceStatus, artifact: ToolArtifactReference): string {
  return [
    "toolStatus: " + status,
    "artifactId: " + artifact.artifactId,
    "artifactBytes: " + artifact.byteLength,
    "artifactComplete: " + artifact.complete,
    ...(artifact.complete
      ? []
      : ["artifactIncompleteReason: " + (artifact.incompleteReason ?? "unknown")]),
    "可使用 read_artifact 通过 artifactId 分页读取已保存原文。",
  ].join("\n");
}

/** 创建一个不会被误判为截断结果的 Tool 失败。 */
export function failedToolResult(content: string): ToolFailedResult {
  return Object.freeze({ status: "failed", content, truncated: false });
}

/** 收敛只读文件 Tool 的系统错误，避免绝对路径或堆栈进入消息。 */
export function toSafeToolFileError(error: unknown): string {
  const errorCode = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof errorCode === "string") {
    return `Tool 文件操作失败：${errorCode}`;
  }
  return error instanceof Error ? error.message : "Tool 执行失败。";
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
    // 只修改预览，丢掉超限行
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
