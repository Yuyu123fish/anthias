import type { ToolArtifactReference } from "../message.js";

type ToolExecutionResultContent = Readonly<{
  content: string;
  truncated: boolean;
  artifact?: ToolArtifactReference;
}>;

/** 表示预检与执行层可以安全返回的失败结果。 */
export type ToolFailedResult = ToolExecutionResultContent & Readonly<{ status: "failed" }>;

/** 表示一个已经收敛且可直接持久化的 Tool 执行结果。 */
export type ToolExecutionResult =
  | (ToolExecutionResultContent & Readonly<{ status: "completed" }>)
  | ToolFailedResult;

/** 限制单个 ToolResult 可以保存的 UTF-8 字节数。 */
export const TOOL_RESULT_BYTE_LIMIT = 64 * 1024;

/** 限制单个 ToolResult 可以保存的文本行数。 */
export const TOOL_RESULT_LINE_LIMIT = 2000;

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
