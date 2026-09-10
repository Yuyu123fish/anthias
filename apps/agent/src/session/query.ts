import type { Message } from "../message.js";
import { readSessionJournal } from "./journal.js";
import { enumerateSessionStorage, locateSessionStorage } from "./locations.js";
import {
  areSameWorkspace,
  getSessionOwnership,
  isUuid,
  type ParsedSessionHeader,
  type SessionRecord,
} from "./schema.js";

export type SessionSummary = Readonly<{ id: string; createdAt: string; title?: string }>;

export type SessionHistory = Readonly<{
  header: ParsedSessionHeader;
  records: readonly SessionRecord[];
  messages: readonly Message[];
}>;

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

/** 只读历史不取得运行权、不修复日志，也不要求原 Workspace 仍然存在。 */
export async function readSessionHistory({
  sessionDirectory,
  sessionId,
  rootSessionId,
}: Readonly<{
  sessionDirectory: string;
  sessionId: string;
  rootSessionId?: string;
}>): Promise<SessionHistory> {
  if (!isUuid(sessionId) || (rootSessionId !== undefined && !isUuid(rootSessionId))) {
    throw new Error("Session 历史身份无效。");
  }
  const location = await locateSessionStorage(sessionDirectory, sessionId, {
    updateCache: false,
  });
  const journal = await readSessionJournal(location.sessionFilePath);
  if (journal.header.sessionId !== sessionId) {
    throw new Error("Session 历史身份不匹配。");
  }
  const ownership = getSessionOwnership(journal.header);
  if (rootSessionId !== undefined && ownership.rootSessionId !== rootSessionId) {
    throw new Error("Session 历史不属于请求的根 Session。");
  }
  const messages = journal.records
    .filter((record) => record.type === "message")
    .map((record) => record.message);
  return Object.freeze({
    header: journal.header,
    records: Object.freeze([...journal.records]),
    messages: Object.freeze(messages),
  });
}
