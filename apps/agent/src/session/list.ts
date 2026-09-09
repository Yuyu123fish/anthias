import type { SessionSummary } from "../agent-controls.js";
import { enumerateSessionStorage } from "./locations.js";
import { areSameWorkspace, getSessionOwnership } from "./schema.js";

/** 列表只消费 Header；个别损坏候选不妨碍其他根摘要，扫描截断不能伪装为完整列表。 */
export async function listSessions(
  sessionDirectory: string,
  workspaceRoot: string,
): Promise<readonly SessionSummary[]> {
  const scan = await enumerateSessionStorage(sessionDirectory);
  if (!scan.complete) throw new Error("Session 列表扫描不完整，请缩小历史目录后重试。");
  const summaries = new Map<string, SessionSummary>();
  for (const { header } of scan.entries) {
    if (
      getSessionOwnership(header).sessionKind === "primary" &&
      areSameWorkspace(header.workspaceRoot, workspaceRoot)
    ) {
      summaries.set(header.sessionId, { id: header.sessionId, createdAt: header.createdAt });
    }
  }
  return Object.freeze(
    [...summaries.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 100),
  );
}
