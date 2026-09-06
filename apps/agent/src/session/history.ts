import type { Message } from "../message.js";
import { readSessionJournal } from "./journal.js";
import { locateSessionStorage } from "./locations.js";
import {
  fromDurableMessage,
  getSessionOwnership,
  isUuid,
  type ParsedSessionHeader,
  type SessionRecord,
} from "./schema.js";

export type SessionHistory = Readonly<{
  header: ParsedSessionHeader;
  records: readonly SessionRecord[];
  messages: readonly Message[];
}>;

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
    .map((record) => fromDurableMessage(record.message));
  return Object.freeze({
    header: journal.header,
    records: Object.freeze([...journal.records]),
    messages: Object.freeze(messages),
  });
}
