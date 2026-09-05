import { open, readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import type { SessionSummary } from "../agent-controls.js";
import { areSameWorkspace, isUuid, parseSessionHeader } from "./schema.js";

/** 只读取受管布局的有界 Header，不打开 Session 或取得其使用权。 */
export async function listSessions(
  sessionDirectory: string,
  workspaceRoot: string,
): Promise<readonly SessionSummary[]> {
  const root = await realpath(sessionDirectory);
  const candidates: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries
    .sort((left, right) => right.name.localeCompare(left.name))
    .slice(0, 512)) {
    if (entry.isFile() && entry.name.endsWith(".jsonl") && isUuid(entry.name.slice(0, -6)))
      candidates.push(join(root, entry.name));
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    for (const child of (await readdir(join(root, entry.name), { withFileTypes: true })).slice(
      0,
      512,
    )) {
      if (child.isDirectory() && /^\d{8}T\d{9}Z-[0-9a-f-]{36}$/i.test(child.name))
        candidates.push(join(root, entry.name, child.name, "session.jsonl"));
      if (candidates.length >= 1024) break;
    }
    if (candidates.length >= 1024) break;
  }
  const summaries = new Map<string, SessionSummary>();
  for (const candidate of candidates) {
    try {
      const canonicalPath = await realpath(candidate);
      const relativePath = relative(root, canonicalPath);
      if (relativePath.startsWith("..") || relativePath === "") continue;
      const file = await open(canonicalPath, "r");
      let headerText: string;
      try {
        const buffer = Buffer.alloc(16 * 1024);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        headerText = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0] ?? "";
      } finally {
        await file.close();
      }
      const header = parseSessionHeader(headerText);
      if (areSameWorkspace(header.workspaceRoot, workspaceRoot))
        summaries.set(header.sessionId, { id: header.sessionId, createdAt: header.createdAt });
    } catch {
      /* 列表允许跳过损坏文件；真正打开时仍由 Session 严格验证。 */
    }
  }
  return Object.freeze(
    [...summaries.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 100),
  );
}
