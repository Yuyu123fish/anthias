import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, open, readdir, readFile, realpath, rename } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { hasRecoverableIncompleteSessionTail } from "./journal.js";
import {
  hasExactKeys,
  isUuid,
  parseJsonObject,
  parseSessionHeader,
  type SessionHeader,
} from "./schema.js";

const LOCATION_INDEX_FILE_NAME = "session-locations.json";
const DATE_DIRECTORY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const SESSION_DIRECTORY_PATTERN = /^(\d{8}T\d{9}Z)-([0-9a-f-]{36})$/iu;

/** 表示一个 Session 的已验证存储位置；根目录和会话独占目录刻意分开。 */
export type SessionStorageLocation = Readonly<{
  sessionId: string;
  storageDirectory: string;
  sessionFilePath: string;
  relativeStorageDirectory: string | null;
  source: "schema2" | "schema1";
  legacyFilePath?: string;
}>;

type SessionLocationIndex = Readonly<{
  schemaVersion: 1;
  locations: Readonly<Record<string, Readonly<{ relativeStorageDirectory: string }>>>;
}>;

/** 由不可变 Header 生成 UTC 日期与时间戳目录，绝不依据重新打开时间移动 Session。 */
export function getSessionStorageRelativeDirectory(header: SessionHeader): string {
  const dateDirectory = header.createdAt.slice(0, 10);
  const timestampDirectory = `${header.createdAt.replace(/[-:.]/gu, "")}-${header.sessionId}`;
  if (
    !DATE_DIRECTORY_PATTERN.test(dateDirectory) ||
    !SESSION_DIRECTORY_PATTERN.test(timestampDirectory) ||
    !timestampDirectory.endsWith(`-${header.sessionId}`)
  ) {
    throw new Error("Session Header 创建时间不能生成合法存储目录。");
  }
  return join(dateDirectory, timestampDirectory);
}

/** 创建一个尚未发布内容的 Schema 2 独占目录。 */
export async function createSessionStorageDirectory(
  sessionDirectory: string,
  header: SessionHeader,
): Promise<SessionStorageLocation> {
  const normalizedSessionDirectory = await realpath(sessionDirectory);
  const relativeStorageDirectory = getSessionStorageRelativeDirectory(header);
  const dateDirectory = await ensureDateDirectory(
    normalizedSessionDirectory,
    dirname(relativeStorageDirectory),
  );
  const storageDirectoryName = basename(relativeStorageDirectory);
  const storageDirectory = join(dateDirectory, storageDirectoryName);
  await mkdir(storageDirectory);
  const canonicalStorageDirectory = await realpath(storageDirectory);
  assertDirectChild(dateDirectory, canonicalStorageDirectory, storageDirectoryName);
  return Object.freeze({
    sessionId: header.sessionId,
    storageDirectory: canonicalStorageDirectory,
    sessionFilePath: join(canonicalStorageDirectory, "session.jsonl"),
    relativeStorageDirectory,
    source: "schema2",
  });
}
/** 按稳定 ID 定位 Session；缓存不是权威，失效时完整扫描兼容布局。 */
export async function locateSessionStorage(
  sessionDirectory: string,
  sessionId: string,
): Promise<SessionStorageLocation> {
  if (!isUuid(sessionId)) {
    throw new Error("Session ID 无效。");
  }
  const normalizedSessionDirectory = await realpath(sessionDirectory);
  const cachedLocation = await readCachedSessionLocation(
    normalizedSessionDirectory,
    sessionId,
  ).catch(() => null);
  const candidates: SessionStorageLocation[] = [];
  if (cachedLocation !== null) {
    const location = await inspectSchema2Location(
      normalizedSessionDirectory,
      sessionId,
      cachedLocation.relativeStorageDirectory,
    ).catch(() => null);
    if (location !== null) {
      candidates.push(location);
    }
  }
  for (const location of await scanSessionLocations(normalizedSessionDirectory, sessionId)) {
    if (!candidates.some((candidate) => candidate.sessionFilePath === location.sessionFilePath)) {
      candidates.push(location);
    }
  }
  const resolvedLocation = await resolveLocationCandidates(candidates);
  if (resolvedLocation.source === "schema2") {
    await writeSessionLocation(normalizedSessionDirectory, resolvedLocation).catch(() => undefined);
  }
  return resolvedLocation;
}

/** 更新可重建 ID 定位缓存；缓存写入失败不能回滚已经发布的 JSONL。 */
export async function writeSessionLocation(
  sessionDirectory: string,
  location: SessionStorageLocation,
): Promise<void> {
  if (location.source !== "schema2" || location.relativeStorageDirectory === null) {
    return;
  }
  const normalizedSessionDirectory = await realpath(sessionDirectory);
  const existingIndex = await readSessionLocationIndex(normalizedSessionDirectory).catch(() =>
    emptyIndex(),
  );
  const locations = {
    ...existingIndex.locations,
    [location.sessionId]: Object.freeze({
      relativeStorageDirectory: location.relativeStorageDirectory,
    }),
  };
  await writeSessionLocationIndex(
    normalizedSessionDirectory,
    Object.freeze({ schemaVersion: 1, locations }),
  );
}

/** 清理发布后移除缓存条目；缓存损坏由后续扫描重建，不阻止文件清理。 */
export async function removeSessionLocation(
  sessionDirectory: string,
  sessionId: string,
): Promise<void> {
  if (!isUuid(sessionId)) {
    throw new Error("Session ID 无效。");
  }
  const normalizedSessionDirectory = await realpath(sessionDirectory);
  const existingIndex = await readSessionLocationIndex(normalizedSessionDirectory).catch(
    () => null,
  );
  if (existingIndex === null || !Object.hasOwn(existingIndex.locations, sessionId)) {
    return;
  }
  const locations = { ...existingIndex.locations };
  delete locations[sessionId];
  await writeSessionLocationIndex(
    normalizedSessionDirectory,
    Object.freeze({ schemaVersion: 1, locations }),
  );
}

/** 检查目录是否恰好属于 Schema 2 的受管布局，供清理在删除前做最后确认。 */
export function isSessionStorageDirectory(
  sessionDirectory: string,
  storageDirectory: string,
  sessionId: string,
): boolean {
  if (!isUuid(sessionId)) {
    return false;
  }
  const relativeStorageDirectory = relative(resolve(sessionDirectory), resolve(storageDirectory));
  const segments = relativeStorageDirectory.split(/[\\/]/u);
  if (segments.length !== 2 || !DATE_DIRECTORY_PATTERN.test(segments[0] ?? "")) {
    return false;
  }
  const match = SESSION_DIRECTORY_PATTERN.exec(segments[1] ?? "");
  return match?.[2]?.toLocaleLowerCase("en-US") === sessionId.toLocaleLowerCase("en-US");
}

/** 创建迁移暂存目录，名称不能被扫描器当作一个正常 Session。 */
export async function createMigrationStagingDirectory(
  sessionDirectory: string,
  header: SessionHeader,
): Promise<string> {
  const normalizedSessionDirectory = await realpath(sessionDirectory);
  const relativeStorageDirectory = getSessionStorageRelativeDirectory(header);
  const dateDirectory = await ensureDateDirectory(
    normalizedSessionDirectory,
    dirname(relativeStorageDirectory),
  );
  const stagingDirectoryName = `.${basename(relativeStorageDirectory)}.migration-${randomUUID()}`;
  const stagingDirectory = join(dateDirectory, stagingDirectoryName);
  await mkdir(stagingDirectory);
  const canonicalStagingDirectory = await realpath(stagingDirectory);
  assertDirectChild(dateDirectory, canonicalStagingDirectory, stagingDirectoryName);
  return canonicalStagingDirectory;
}
/** 只读取并严格校验定位缓存；任何异常都由调用方降级为扫描。 */
async function readCachedSessionLocation(
  sessionDirectory: string,
  sessionId: string,
): Promise<Readonly<{ relativeStorageDirectory: string }> | null> {
  const index = await readSessionLocationIndex(sessionDirectory);
  const location = index.locations[sessionId];
  return location ?? null;
}

async function readSessionLocationIndex(sessionDirectory: string): Promise<SessionLocationIndex> {
  const indexText = await readFile(join(sessionDirectory, LOCATION_INDEX_FILE_NAME), "utf8");
  const index = parseJsonObject(indexText);
  if (!hasExactKeys(index, ["schemaVersion", "locations"]) || index.schemaVersion !== 1) {
    throw new Error("Session location index 无效。");
  }
  if (
    index.locations === null ||
    typeof index.locations !== "object" ||
    Array.isArray(index.locations)
  ) {
    throw new Error("Session location index locations 无效。");
  }
  const locations: Record<string, Readonly<{ relativeStorageDirectory: string }>> = {};
  for (const [sessionId, value] of Object.entries(index.locations as Record<string, unknown>)) {
    if (!isUuid(sessionId) || value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Session location index 条目无效。");
    }
    const location = value as Record<string, unknown>;
    if (
      !hasExactKeys(location, ["relativeStorageDirectory"]) ||
      typeof location.relativeStorageDirectory !== "string" ||
      !isRelativeStorageDirectoryForSession(location.relativeStorageDirectory, sessionId)
    ) {
      throw new Error("Session location index 条目无效。");
    }
    locations[sessionId] = Object.freeze({
      relativeStorageDirectory: location.relativeStorageDirectory,
    });
  }
  return Object.freeze({ schemaVersion: 1, locations: Object.freeze(locations) });
}

async function writeSessionLocationIndex(
  sessionDirectory: string,
  index: SessionLocationIndex,
): Promise<void> {
  const temporaryIndexPath = join(
    sessionDirectory,
    `.${LOCATION_INDEX_FILE_NAME}.${randomUUID()}.tmp`,
  );
  const indexPath = join(sessionDirectory, LOCATION_INDEX_FILE_NAME);
  const indexHandle = await open(temporaryIndexPath, "wx");
  try {
    await indexHandle.writeFile(`${JSON.stringify(index)}\n`, "utf8");
    await indexHandle.sync();
  } finally {
    await indexHandle.close();
  }
  await rename(temporaryIndexPath, indexPath);
}

async function inspectSchema2Location(
  sessionDirectory: string,
  sessionId: string,
  relativeStorageDirectory: string,
): Promise<SessionStorageLocation> {
  if (!isRelativeStorageDirectoryForSession(relativeStorageDirectory, sessionId)) {
    throw new Error("Session location 缓存路径无效。");
  }
  const segments = relativeStorageDirectory.split(/[\\/]/u);
  const dateDirectoryName = segments[0];
  const storageDirectoryName = segments[1];
  if (dateDirectoryName === undefined || storageDirectoryName === undefined) {
    throw new Error("Session location 缓存路径无效。");
  }
  const dateDirectory = await resolveExistingDateDirectory(sessionDirectory, dateDirectoryName);
  if (dateDirectory === null) {
    throw new Error("Session 日期目录不存在。");
  }
  const storageDirectory = await resolveExistingDirectChild(dateDirectory, storageDirectoryName);
  if (storageDirectory === null) {
    throw new Error("Session 存储目录不存在。");
  }
  const sessionFilePath = join(storageDirectory, "session.jsonl");
  const header = parseSessionHeader((await readFile(sessionFilePath, "utf8")).split("\n", 1)[0]);
  if (header.schemaVersion !== 2 || header.sessionId !== sessionId) {
    throw new Error("Session location 与 Header 不匹配。");
  }
  return Object.freeze({
    sessionId,
    storageDirectory,
    sessionFilePath,
    relativeStorageDirectory,
    source: "schema2",
  });
}
async function scanSessionLocations(
  sessionDirectory: string,
  sessionId: string,
): Promise<SessionStorageLocation[]> {
  const entries = await readdir(sessionDirectory, { withFileTypes: true });
  const locations: SessionStorageLocation[] = [];
  for (const dateEntry of entries) {
    if (!dateEntry.isDirectory() || !DATE_DIRECTORY_PATTERN.test(dateEntry.name)) {
      continue;
    }
    const dateDirectory = await resolveExistingDateDirectory(
      sessionDirectory,
      dateEntry.name,
    ).catch(() => null);
    if (dateDirectory === null) {
      continue;
    }
    const dateEntries = await readdir(dateDirectory, { withFileTypes: true }).catch(
      () => [] as Dirent[],
    );
    for (const sessionEntry of dateEntries) {
      if (!sessionEntry.isDirectory() || !isSessionDirectoryForId(sessionEntry.name, sessionId)) {
        continue;
      }
      const relativeStorageDirectory = join(dateEntry.name, sessionEntry.name);
      const location = await inspectSchema2Location(
        sessionDirectory,
        sessionId,
        relativeStorageDirectory,
      ).catch(() => null);
      if (location !== null) {
        locations.push(location);
      }
    }
  }
  const legacyFilePath = join(sessionDirectory, `${sessionId}.jsonl`);
  const legacyLocation = await inspectLegacyLocation(
    sessionDirectory,
    sessionId,
    legacyFilePath,
  ).catch(() => null);
  if (legacyLocation !== null) {
    locations.push(legacyLocation);
  }
  return locations;
}
async function inspectLegacyLocation(
  sessionDirectory: string,
  sessionId: string,
  legacyFilePath: string,
): Promise<SessionStorageLocation> {
  const canonicalFilePath = await realpath(legacyFilePath);
  assertDirectChild(sessionDirectory, canonicalFilePath, `${sessionId}.jsonl`);
  const header = parseSessionHeader((await readFile(canonicalFilePath, "utf8")).split("\n", 1)[0]);
  if (header.schemaVersion !== 1 || header.sessionId !== sessionId) {
    throw new Error("Legacy Session Header 无效。");
  }
  return Object.freeze({
    sessionId,
    storageDirectory: sessionDirectory,
    sessionFilePath: canonicalFilePath,
    relativeStorageDirectory: null,
    source: "schema1",
  });
}

async function resolveLocationCandidates(
  candidates: readonly SessionStorageLocation[],
): Promise<SessionStorageLocation> {
  const distinctCandidates = candidates.filter(
    (candidate, index) =>
      candidates.findIndex(
        (otherCandidate) => otherCandidate.sessionFilePath === candidate.sessionFilePath,
      ) === index,
  );
  if (distinctCandidates.length === 0) {
    throw new Error("未找到指定 Session。");
  }
  if (distinctCandidates.length === 1) {
    return distinctCandidates[0] as SessionStorageLocation;
  }
  const schema2Location = distinctCandidates.find((candidate) => candidate.source === "schema2");
  const schema1Location = distinctCandidates.find((candidate) => candidate.source === "schema1");
  if (
    distinctCandidates.length === 2 &&
    schema2Location !== undefined &&
    schema1Location !== undefined &&
    (await hasMatchingMigrationBackup(schema2Location, schema1Location.sessionFilePath))
  ) {
    return Object.freeze({ ...schema2Location, legacyFilePath: schema1Location.sessionFilePath });
  }
  throw new Error("Session ID 存在多个无法确认权威来源的位置。");
}

async function hasMatchingMigrationBackup(
  schema2Location: SessionStorageLocation,
  legacyFilePath: string,
): Promise<boolean> {
  try {
    const [backup, legacy] = await Promise.all([
      readFile(join(schema2Location.storageDirectory, "migration-backup", "legacy-session.jsonl")),
      readFile(legacyFilePath),
    ]);
    return (
      backup.equals(legacy) ||
      (legacy.at(-1) === 0x0a &&
        legacy.byteLength < backup.byteLength &&
        backup.subarray(0, legacy.byteLength).equals(legacy) &&
        hasRecoverableIncompleteSessionTail(backup))
    );
  } catch {
    return false;
  }
}
function isRelativeStorageDirectoryForSession(
  relativeStorageDirectory: string,
  sessionId: string,
): boolean {
  const segments = relativeStorageDirectory.split(/[\\/]/u);
  if (segments.length !== 2 || !DATE_DIRECTORY_PATTERN.test(segments[0] ?? "")) {
    return false;
  }
  return isSessionDirectoryForId(segments[1] ?? "", sessionId);
}

function isSessionDirectoryForId(directoryName: string, sessionId: string): boolean {
  const match = SESSION_DIRECTORY_PATTERN.exec(directoryName);
  return match?.[2]?.toLocaleLowerCase("en-US") === sessionId.toLocaleLowerCase("en-US");
}

async function ensureDateDirectory(
  sessionDirectory: string,
  dateDirectoryName: string,
): Promise<string> {
  if (!DATE_DIRECTORY_PATTERN.test(dateDirectoryName)) {
    throw new Error("Session 日期目录无效。");
  }
  const dateDirectory = join(sessionDirectory, dateDirectoryName);
  await mkdir(dateDirectory, { recursive: true });
  const canonicalDateDirectory = await realpath(dateDirectory);
  assertDirectChild(sessionDirectory, canonicalDateDirectory, dateDirectoryName);
  return canonicalDateDirectory;
}

async function resolveExistingDateDirectory(
  sessionDirectory: string,
  dateDirectoryName: string,
): Promise<string | null> {
  if (!DATE_DIRECTORY_PATTERN.test(dateDirectoryName)) {
    return null;
  }
  return resolveExistingDirectChild(sessionDirectory, dateDirectoryName);
}

async function resolveExistingDirectChild(
  parentDirectory: string,
  childName: string,
): Promise<string | null> {
  try {
    const canonicalChildPath = await realpath(join(parentDirectory, childName));
    assertDirectChild(parentDirectory, canonicalChildPath, childName);
    return canonicalChildPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function assertDirectChild(parentDirectory: string, childPath: string, childName: string): void {
  const relativePath = relative(resolve(parentDirectory), resolve(childPath));
  const normalizedRelativePath =
    process.platform === "win32" ? relativePath.toLocaleLowerCase("en-US") : relativePath;
  const normalizedChildName =
    process.platform === "win32" ? childName.toLocaleLowerCase("en-US") : childName;
  if (normalizedRelativePath !== normalizedChildName) {
    throw new Error("Session 路径超出受管数据根。");
  }
}
function emptyIndex(): SessionLocationIndex {
  return Object.freeze({ schemaVersion: 1, locations: Object.freeze({}) });
}
