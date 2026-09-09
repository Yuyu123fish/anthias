import { lstat } from "node:fs/promises";
import { readSessionJournal } from "./journal.js";
import { enumerateSessionStorage, type SessionStorageScan } from "./locations.js";
import {
  getSessionOwnership,
  isUuid,
  type Schema2SessionHeader,
  type SessionHeader,
  type SessionRecord,
} from "./schema.js";

export type LocatedGroupSession = Readonly<{
  sessionId: string;
  storageDirectory: string;
  sessionFilePath: string;
  relativeStorageDirectory: string;
  header: SessionHeader | Schema2SessionHeader;
  records: readonly SessionRecord[];
}>;

export type LocatedSessionGroup = Readonly<{
  rootSessionId: string;
  sessions: readonly LocatedGroupSession[];
  complete: boolean;
  diagnostics: readonly string[];
}>;

/** 已知物理根的损坏成员只影响该组；归属未知的候选可能属于任一组，必须保守保留。 */
export async function locateSessionGroup(
  sessionDirectory: string,
  sessionId: string,
  scannedStorage?: SessionStorageScan,
): Promise<LocatedSessionGroup> {
  if (!isUuid(sessionId)) throw new Error("Session group 身份无效。");
  const scan = scannedStorage ?? (await enumerateSessionStorage(sessionDirectory));
  const requestedCandidates = scan.entries.filter(
    ({ location }) => location.source === "directory" && location.sessionId === sessionId,
  );
  if (requestedCandidates.length !== 1) throw new Error("Session group 的请求身份不存在或重复。");
  const requested = requestedCandidates[0];
  if (requested === undefined) throw new Error("Session group 身份不存在。");
  const rootSessionId = getSessionOwnership(requested.header).rootSessionId;
  const candidates = scan.entries.filter(
    ({ location, header }) =>
      location.source === "directory" &&
      getSessionOwnership(header).rootSessionId === rootSessionId,
  );
  const diagnostics = scan.diagnostics
    .filter(
      (diagnostic) =>
        diagnostic.rootSessionId === undefined || diagnostic.rootSessionId === rootSessionId,
    )
    .map((diagnostic) => diagnostic.message);
  const sessions: LocatedGroupSession[] = [];
  for (const { location, header } of candidates) {
    try {
      if (
        header.schemaVersion === 1 ||
        location.relativeStorageDirectory === null ||
        (await lstat(location.sessionFilePath)).size > 64 * 1024 * 1024
      ) {
        throw new Error("Session journal exceeds group read budget");
      }
      const journal = await readSessionJournal(location.sessionFilePath);
      if (JSON.stringify(journal.header) !== JSON.stringify(header)) {
        throw new Error("Session Header changed during enumeration");
      }
      sessions.push(
        Object.freeze({
          sessionId: location.sessionId,
          storageDirectory: location.storageDirectory,
          sessionFilePath: location.sessionFilePath,
          relativeStorageDirectory: location.relativeStorageDirectory.replaceAll("\\", "/"),
          header,
          records: journal.records,
        }),
      );
    } catch {
      diagnostics.push("组成员日志无法核验");
    }
  }
  const identities = new Set(sessions.map((session) => session.sessionId));
  const roots = sessions.filter(
    (session) =>
      session.sessionId === rootSessionId &&
      getSessionOwnership(session.header).sessionKind === "primary",
  );
  return Object.freeze({
    rootSessionId,
    sessions: Object.freeze(
      sessions.sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
    ),
    complete:
      scan.complete &&
      diagnostics.length === 0 &&
      roots.length === 1 &&
      identities.size === sessions.length &&
      sessions.length === candidates.length,
    diagnostics: Object.freeze(diagnostics),
  });
}
