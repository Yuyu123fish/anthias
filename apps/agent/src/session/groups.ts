import { readdir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { readSessionJournal } from "./journal.js";
import {
  getSessionOwnership,
  isUuid,
  type Schema2SessionHeader,
  type SessionHeader,
  type SessionRecord,
} from "./schema.js";

const DATE_DIRECTORY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const SESSION_DIRECTORY_PATTERN = /^\d{8}T\d{9}Z-([0-9a-f-]{36})$/iu;
export const MAXIMUM_MANAGED_SESSION_DIRECTORIES = 4096;

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
}>;

/** 只按 Header 归属定位同根日志；任务、交付与资源终态由清理调用方解释。 */
export async function locateSessionGroup(
  sessionDirectory: string,
  sessionId: string,
): Promise<LocatedSessionGroup> {
  if (!isUuid(sessionId)) {
    throw new Error("Session group 身份无效。");
  }
  const root = await realpath(sessionDirectory);
  const candidates: LocatedGroupSession[] = [];
  let scannedManagedDirectories = 0;
  let exceededScanLimit = false;

  const dateDirectoryNames = (await readdir(root))
    .filter((name) => DATE_DIRECTORY_PATTERN.test(name))
    .sort();
  for (const dateDirectoryName of dateDirectoryNames) {
    const dateDirectory = join(root, dateDirectoryName);
    const sessionDirectoryNames = (await readdir(dateDirectory).catch(() => [] as string[])).sort();
    for (const sessionDirectoryName of sessionDirectoryNames) {
      const matchedSessionId = SESSION_DIRECTORY_PATTERN.exec(sessionDirectoryName)?.[1];
      if (matchedSessionId === undefined || !isUuid(matchedSessionId)) {
        continue;
      }
      scannedManagedDirectories += 1;
      if (scannedManagedDirectories > MAXIMUM_MANAGED_SESSION_DIRECTORIES) {
        exceededScanLimit = true;
        break;
      }
      const storageDirectory = await realpath(join(dateDirectory, sessionDirectoryName)).catch(
        () => null,
      );
      if (
        storageDirectory === null ||
        !isPathInside(root, storageDirectory) ||
        relative(dateDirectory, storageDirectory) !== sessionDirectoryName
      ) {
        continue;
      }
      const sessionFilePath = join(storageDirectory, "session.jsonl");
      const journal = await readSessionJournal(sessionFilePath).catch(() => null);
      if (
        journal === null ||
        journal.header.schemaVersion === 1 ||
        journal.header.sessionId !== matchedSessionId
      ) {
        continue;
      }
      candidates.push(
        Object.freeze({
          sessionId: matchedSessionId,
          storageDirectory,
          sessionFilePath,
          relativeStorageDirectory: `${dateDirectoryName}/${sessionDirectoryName}`,
          header: journal.header,
          records: journal.records,
        }),
      );
    }
    if (exceededScanLimit) {
      break;
    }
  }

  const requestedCandidates = candidates.filter((candidate) => candidate.sessionId === sessionId);
  if (requestedCandidates.length !== 1) {
    throw new Error("Session group 的请求身份不存在或重复。");
  }
  const requestedSession = requestedCandidates[0] as LocatedGroupSession;
  const requestedOwnership = getSessionOwnership(requestedSession.header);
  if (requestedSession.header.schemaVersion === 2) {
    return Object.freeze({
      rootSessionId: requestedSession.sessionId,
      sessions: Object.freeze([requestedSession]),
      complete: !exceededScanLimit,
    });
  }

  const groupSessions = candidates.filter(
    (candidate) =>
      candidate.header.schemaVersion === 3 &&
      candidate.header.rootSessionId === requestedOwnership.rootSessionId,
  );
  const sessionIdentityCounts = new Map<string, number>();
  for (const candidate of groupSessions) {
    sessionIdentityCounts.set(
      candidate.sessionId,
      (sessionIdentityCounts.get(candidate.sessionId) ?? 0) + 1,
    );
  }
  const rootSessions = groupSessions.filter(
    (candidate) =>
      candidate.header.schemaVersion === 3 &&
      candidate.sessionId === requestedOwnership.rootSessionId &&
      candidate.header.sessionKind === "primary",
  );
  const complete =
    !exceededScanLimit &&
    rootSessions.length === 1 &&
    groupSessions.every((candidate) => sessionIdentityCounts.get(candidate.sessionId) === 1);
  return Object.freeze({
    rootSessionId: requestedOwnership.rootSessionId,
    sessions: Object.freeze(
      [...groupSessions].sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
    ),
    complete,
  });
}

function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(".." + sep) &&
    !relativePath.startsWith("/") &&
    !relativePath.startsWith("\\")
  );
}
