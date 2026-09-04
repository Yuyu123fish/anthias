import { readFile } from "node:fs/promises";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** 读取严格 UTF-8 文本，并拒绝包含 NUL 的二进制内容。 */
export async function readStrictUtf8File(filePath: string): Promise<string> {
  return decodeStrictUtf8(await readFile(filePath));
}

/** 以 fatal UTF-8 解码文本，并拒绝包含 NUL 的二进制内容。 */
export function decodeStrictUtf8(bytes: Uint8Array): string {
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
export function splitTextLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}
