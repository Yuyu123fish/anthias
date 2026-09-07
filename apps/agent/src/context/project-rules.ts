import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { memoryHash } from "../memory/schema.js";
import type { MemoryProject } from "../memory/selection.js";
import type { ContextSourceDetails } from "../session/schema.js";

export async function readProjectRules(
  project: MemoryProject,
  signal?: AbortSignal,
): Promise<ContextSourceDetails> {
  const path = join(project.root, "AGENTS.md");
  try {
    signal?.throwIfAborted();
    const canonicalPath = await realpath(path);
    const relativePath = relative(project.root, canonicalPath);
    if (relativePath === ".." || relativePath.startsWith(".." + sep) || isAbsolute(relativePath))
      throw new Error("AGENTS.md 指向项目外部，未自动加载。");
    const metadata = await stat(canonicalPath);
    if (!metadata.isFile() || metadata.size > 64 * 1024)
      throw new Error("AGENTS.md 必须是完整的文本文件，且不能超过 64 KiB。");
    const content = await readFile(canonicalPath, "utf8");
    signal?.throwIfAborted();
    if (Buffer.byteLength(content) > 64 * 1024 || content.includes("\u0000"))
      throw new Error("AGENTS.md 内容不可完整加载。");
    return {
      sourceId: "project-rules",
      kind: "project_rules",
      label: path,
      fingerprint: memoryHash(content),
      content,
    };
  } catch (error) {
    signal?.throwIfAborted();
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return {
        sourceId: "project-rules",
        kind: "project_rules",
        label: path,
        fingerprint: memoryHash("missing"),
        content: null,
      };
    throw new Error(
      error instanceof Error && !("code" in error)
        ? error.message
        : "AGENTS.md 读取失败，请修复后重试。",
    );
  }
}
