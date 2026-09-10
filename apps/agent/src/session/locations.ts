import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, opendir, readFile, realpath, rename } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { hasRecoverableIncompleteSessionTail } from "./journal.js";
import {
  hasExactKeys,
  isUuid,
  type ParsedSessionHeader,
  parseJsonObject,
  parseSessionHeader,
  type Schema3SessionHeader,
  type SessionHeader,
} from "./schema.js";

const LOCATION_INDEX_FILE_NAME = "session-locations.json";
const locationIndexUpdateQueues = new Map<string, Promise<void>>();
const DATE_DIRECTORY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const SESSION_DIRECTORY_PATTERN = /^(\d{8}T\d{9}Z)-([0-9a-f-]{36})$/iu;

/** 表示一个 Session 的已验证存储位置；根目录和会话独占目录刻意分开。 */
export type SessionStorageLocation = Readonly<{
  sessionId: string;
  storageDirectory: string;
  sessionFilePath: string;
  relativeStorageDirectory: string | null;
  source: "directory" | "legacy";
  legacyFilePath?: string;
}>;

type SessionLocationIndex = Readonly<{
  schemaVersion: 1;
  locations: Readonly<Record<string, Readonly<{ relativeStorageDirectory: string }>>>;
}>;

/** 由不可变 Header 生成 UTC 日期与时间戳目录，绝不依据重新打开时间移动 Session。 */
export function getSessionStorageRelativeDirectory(header: ParsedSessionHeader): string {
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

/** 成员在根位置确认后创建；跨日执行不改变归属目录或 Header 的真实时间。 */
export async function createSessionStorageDirectory(
  sessionDirectory: string,
  header: SessionHeader | Schema3SessionHeader,
): Promise<SessionStorageLocation> {
  const normalizedSessionDirectory = await realpath(sessionDirectory);
  const existing = await enumerateSessionStorage(normalizedSessionDirectory);
  if (
    !existing.complete ||
    existing.entries.some(({ location }) => location.sessionId === header.sessionId) ||
    existing.diagnostics.some((diagnostic) => diagnostic.sessionId === header.sessionId)
  ) {
    throw new Error("Session ID 已存在或位置扫描不完整。");
  }
  let parentDirectory: string;
  let directoryName: string;
  if (header.sessionKind === "primary") {
    const relativeDirectory = getSessionStorageRelativeDirectory(header);
    parentDirectory = await ensureDateDirectory(
      normalizedSessionDirectory,
      dirname(relativeDirectory),
    );
    directoryName = basename(relativeDirectory);
  } else {
    const rootLocation = await locateSessionStorage(
      normalizedSessionDirectory,
      header.rootSessionId,
      { updateCache: false },
    );
    if (rootLocation.source !== "directory")
      throw new Error("成员创建需要已经显式打开的根 Session。");
    const rootHeader = await readManagedDirectoryHeader(
      rootLocation.storageDirectory,
      rootLocation.sessionFilePath,
    );
    if (
      (rootHeader.schemaVersion !== 3 && rootHeader.schemaVersion !== 4) ||
      rootHeader.sessionKind !== "primary" ||
      rootHeader.sessionId !== header.rootSessionId ||
      rootHeader.rootSessionId !== header.rootSessionId
    ) {
      throw new Error("成员 Header 的根归属无效。");
    }
    parentDirectory = join(rootLocation.storageDirectory, "members");
    await mkdir(parentDirectory, { recursive: true });
    await resolveExistingDirectChild(rootLocation.storageDirectory, "members");
    directoryName = header.sessionId;
  }
  const storageDirectory = join(parentDirectory, directoryName);
  await mkdir(storageDirectory);
  const canonicalStorageDirectory = await realpath(storageDirectory);
  assertDirectChild(parentDirectory, canonicalStorageDirectory, directoryName);
  return Object.freeze({
    sessionId: header.sessionId,
    storageDirectory: canonicalStorageDirectory,
    sessionFilePath: join(canonicalStorageDirectory, "session.jsonl"),
    relativeStorageDirectory: relative(normalizedSessionDirectory, canonicalStorageDirectory),
    source: "directory",
  });
}
/** 按稳定 ID 完整核验兼容布局；定位缓存可重建，不能代替来源冲突检查。 */
export async function locateSessionStorage(
  sessionDirectory: string,
  sessionId: string,
  options: Readonly<{ updateCache?: boolean }> = {},
): Promise<SessionStorageLocation> {
  if (!isUuid(sessionId)) throw new Error("Session ID 无效。");
  const root = await realpath(sessionDirectory);
  // 缓存无法排除另一位置的同 ID 日志，只有完整枚举才能确定写入权威。
  const scan = await enumerateSessionStorage(root);
  if (!scan.complete) throw new Error("Session 位置扫描不完整，无法确认唯一来源。");
  if (scan.diagnostics.some((diagnostic) => diagnostic.sessionId === sessionId)) {
    throw new Error("Session ID 存在损坏或归属不明的位置。");
  }
  const location = await resolveLocationCandidates(
    scan.entries
      .filter((entry) => entry.location.sessionId === sessionId)
      .map((entry) => entry.location),
  );
  if (location.source === "directory" && options.updateCache !== false) {
    await writeSessionLocation(root, location).catch(() => undefined);
  }
  return location;
}
/** 更新可重建 ID 定位缓存；缓存写入失败不能回滚已经发布的 JSONL。 */
export async function writeSessionLocation(
  sessionDirectory: string,
  location: SessionStorageLocation,
): Promise<void> {
  if (location.source !== "directory" || location.relativeStorageDirectory === null) {
    return;
  }
  const normalizedSessionDirectory = await realpath(sessionDirectory);
  await serializeLocationIndexUpdate(normalizedSessionDirectory, async () => {
    const existingIndex = await readSessionLocationIndex(normalizedSessionDirectory).catch(() =>
      emptyIndex(),
    );
    const locations = {
      ...existingIndex.locations,
      [location.sessionId]: Object.freeze({
        relativeStorageDirectory: location.relativeStorageDirectory as string,
      }),
    };
    await writeSessionLocationIndex(
      normalizedSessionDirectory,
      Object.freeze({ schemaVersion: 1, locations }),
    );
  });
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
  await serializeLocationIndexUpdate(normalizedSessionDirectory, async () => {
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
  });
}

/** 只校验受管相对路径语法；实际访问仍需校验 Header 与每一层真实路径。 */
export function isSessionStorageRelativeDirectory(
  value: unknown,
  sessionId?: string,
): value is string {
  if (typeof value !== "string") return false;
  const segments = value.split(/[\\/]/u);
  if (
    !DATE_DIRECTORY_PATTERN.test(segments[0] ?? "") ||
    !SESSION_DIRECTORY_PATTERN.test(segments[1] ?? "")
  )
    return false;
  const pathId =
    segments.length === 2
      ? SESSION_DIRECTORY_PATTERN.exec(segments[1] ?? "")?.[2]
      : segments.length === 4 && segments[2] === "members"
        ? segments[3]
        : undefined;
  return (
    isUuid(pathId) && (sessionId === undefined || pathId.toLowerCase() === sessionId.toLowerCase())
  );
}

/** 返回物理包含成员目录的 Session 路径；平铺布局没有物理父 Session，归属仍以 Header 为准。 */
export function getContainingSessionStorageDirectory(
  relativeStorageDirectory: string,
): string | null {
  if (!isSessionStorageRelativeDirectory(relativeStorageDirectory))
    throw new Error("Session location 路径无效。");
  const segments = relativeStorageDirectory.split(/[\\/]/u);
  return segments.length === 4 ? segments.slice(0, 2).join("/") : null;
}

export function isSessionStorageDirectory(
  sessionDirectory: string,
  storageDirectory: string,
  sessionId: string,
): boolean {
  return (
    isUuid(sessionId) &&
    isSessionStorageRelativeDirectory(
      relative(resolve(sessionDirectory), resolve(storageDirectory)),
      sessionId,
    )
  );
}

/** 创建迁移暂存目录，名称不能被扫描器当作一个正常 Session。 */
export async function createMigrationStagingDirectory(
  sessionDirectory: string,
  header: ParsedSessionHeader,
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
      !isSessionStorageRelativeDirectory(location.relativeStorageDirectory, sessionId)
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

async function serializeLocationIndexUpdate(
  sessionDirectory: string,
  update: () => Promise<void>,
): Promise<void> {
  const previousUpdate = locationIndexUpdateQueues.get(sessionDirectory) ?? Promise.resolve();
  const currentUpdate = previousUpdate.catch(() => undefined).then(update);
  const queueTail = currentUpdate.catch(() => undefined);
  locationIndexUpdateQueues.set(sessionDirectory, queueTail);
  try {
    await currentUpdate;
  } finally {
    if (locationIndexUpdateQueues.get(sessionDirectory) === queueTail) {
      locationIndexUpdateQueues.delete(sessionDirectory);
    }
  }
}

async function inspectDirectoryLocation(
  sessionDirectory: string,
  sessionId: string,
  relativeStorageDirectory: string,
): Promise<SessionStorageEntry> {
  if (!isSessionStorageRelativeDirectory(relativeStorageDirectory, sessionId)) {
    throw new Error("Session location 路径无效。");
  }
  const segments = relativeStorageDirectory.split(/[\\/]/u);
  let storageDirectory = sessionDirectory;
  for (const segment of segments) {
    const child = await resolveExistingDirectChild(storageDirectory, segment);
    if (child === null) throw new Error("Session 存储目录不存在。");
    storageDirectory = child;
  }
  const sessionFilePath = join(storageDirectory, "session.jsonl");
  const header = await readManagedDirectoryHeader(storageDirectory, sessionFilePath);
  if (header.schemaVersion === 1 || header.sessionId !== sessionId) {
    throw new Error("Session location 与 Header 不匹配。");
  }
  if (segments.length === 2) {
    if (getSessionStorageRelativeDirectory(header) !== join(...segments)) {
      throw new Error("Session creation path mismatch");
    }
  } else {
    const rootRelativeDirectory = join(...segments.slice(0, 2));
    const rootId = SESSION_DIRECTORY_PATTERN.exec(segments[1] ?? "")?.[2];
    if (rootId === undefined) throw new Error("Session 根目录身份无效。");
    const root = await inspectDirectoryLocation(sessionDirectory, rootId, rootRelativeDirectory);
    if (
      (root.header.schemaVersion !== 3 && root.header.schemaVersion !== 4) ||
      root.header.sessionKind !== "primary" ||
      root.header.rootSessionId !== rootId ||
      (header.schemaVersion !== 3 && header.schemaVersion !== 4) ||
      header.sessionKind === "primary" ||
      header.rootSessionId !== rootId
    ) {
      throw new Error("Session 成员归属与根 Header 不匹配。");
    }
  }
  return Object.freeze({
    header,
    location: Object.freeze({
      sessionId,
      storageDirectory,
      sessionFilePath,
      relativeStorageDirectory,
      source: "directory",
    }),
  });
}

async function readManagedDirectoryHeader(
  storageDirectory: string,
  sessionFilePath: string,
): Promise<ParsedSessionHeader> {
  try {
    return await readHeaderFile(storageDirectory, sessionFilePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await readHeaderFileExists(
      storageDirectory,
      join(storageDirectory, "schema-upgrade-state.json"),
    );
    return readHeaderFile(storageDirectory, join(storageDirectory, "schema2-session.jsonl"));
  }
}

async function readHeaderFileExists(parentDirectory: string, filePath: string): Promise<void> {
  const stats = await lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Session 日志不是受管普通文件。");
  assertDirectChild(parentDirectory, await realpath(filePath), basename(filePath));
}

async function readHeaderFile(
  parentDirectory: string,
  filePath: string,
): Promise<ParsedSessionHeader> {
  await readHeaderFileExists(parentDirectory, filePath);
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(16 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = text.indexOf("\n");
    if (newline < 0 && bytesRead === buffer.length)
      throw new Error("Session Header 超过读取预算。");
    return parseSessionHeader(newline < 0 ? text : text.slice(0, newline));
  } finally {
    await handle.close();
  }
}

export const MAXIMUM_MANAGED_SESSION_DIRECTORIES = 4096;
export type SessionStorageEntry = Readonly<{
  location: SessionStorageLocation;
  header: ParsedSessionHeader;
}>;
export type SessionStorageScan = Readonly<{
  entries: readonly SessionStorageEntry[];
  complete: boolean;
  diagnostics: readonly Readonly<{
    relativePath: string;
    sessionId?: string;
    rootSessionId?: string;
    message: string;
  }>[];
}>;

/** 只枚举固定布局，不打开 Session；损坏候选保留诊断供列表容错与组清理保守判断。 */
export async function enumerateSessionStorage(
  sessionDirectory: string,
  options: Readonly<{ maximumCandidates?: number }> = {},
): Promise<SessionStorageScan> {
  const root = await realpath(sessionDirectory);
  const maximumCandidates = Math.max(
    1,
    Math.min(
      MAXIMUM_MANAGED_SESSION_DIRECTORIES,
      options.maximumCandidates ?? MAXIMUM_MANAGED_SESSION_DIRECTORIES,
    ),
  );
  const entries: SessionStorageEntry[] = [];
  const diagnostics: Array<{
    relativePath: string;
    sessionId?: string;
    rootSessionId?: string;
    message: string;
  }> = [];
  let complete = true;
  let visitedEntries = 0;
  let candidates = 0;
  const readNames = async (directory: string): Promise<string[]> => {
    const names: string[] = [];
    try {
      const handle = await opendir(directory);
      for await (const entry of handle) {
        visitedEntries += 1;
        if (visitedEntries > MAXIMUM_MANAGED_SESSION_DIRECTORIES * 4) {
          complete = false;
          break;
        }
        names.push(entry.name);
      }
    } catch {
      complete = false;
      diagnostics.push({ relativePath: relative(root, directory), message: "目录无法完整枚举" });
    }
    return names.sort();
  };
  const inspect = async (
    relativePath: string,
    sessionId: string,
    legacy = false,
    rootSessionId?: string,
  ): Promise<void> => {
    candidates += 1;
    if (candidates > maximumCandidates) {
      complete = false;
      return;
    }
    try {
      entries.push(
        legacy
          ? await inspectLegacyLocation(root, sessionId, join(root, relativePath))
          : await inspectDirectoryLocation(root, sessionId, relativePath),
      );
    } catch {
      diagnostics.push({
        relativePath,
        sessionId,
        ...(rootSessionId === undefined ? {} : { rootSessionId }),
        message: "日志身份、路径或 Header 无法核验",
      });
    }
  };
  for (const name of await readNames(root)) {
    if (!complete) break;
    if (name.endsWith(".jsonl") && isUuid(name.slice(0, -6))) {
      await inspect(name, name.slice(0, -6), true);
      continue;
    }
    if (!DATE_DIRECTORY_PATTERN.test(name)) continue;
    let dateDirectory: string | null;
    try {
      dateDirectory = await resolveExistingDateDirectory(root, name);
      if (dateDirectory === null) throw new Error("missing date directory");
    } catch {
      complete = false;
      diagnostics.push({ relativePath: name, message: "日期目录无法安全枚举" });
      break;
    }
    for (const directoryName of await readNames(dateDirectory)) {
      if (!complete) break;
      const sessionId = SESSION_DIRECTORY_PATTERN.exec(directoryName)?.[2];
      if (!isUuid(sessionId)) continue;
      const relativeDirectory = join(name, directoryName);
      await inspect(relativeDirectory, sessionId);
      if (!complete) break;
      try {
        const storageDirectory = await resolveExistingDirectChild(dateDirectory, directoryName);
        if (storageDirectory === null) continue;
        const membersDirectory = await resolveExistingDirectChild(storageDirectory, "members");
        if (membersDirectory === null) continue;
        const containingHeader = entries.find(
          (entry) => entry.location.relativeStorageDirectory === relativeDirectory,
        )?.header;
        const knownRoot =
          (containingHeader?.schemaVersion === 3 || containingHeader?.schemaVersion === 4) &&
          containingHeader.sessionKind === "primary"
            ? { rootSessionId: containingHeader.sessionId }
            : {};
        for (const memberId of await readNames(membersDirectory)) {
          if (!complete) break;
          const memberRelativePath = join(relativeDirectory, "members", memberId);
          if (!isUuid(memberId)) {
            diagnostics.push({
              relativePath: memberRelativePath,
              ...knownRoot,
              message: "成员目录包含未知内容",
            });
            continue;
          }
          await inspect(memberRelativePath, memberId, false, knownRoot.rootSessionId);
          try {
            await lstat(join(root, memberRelativePath, "members"));
            diagnostics.push({
              relativePath: memberRelativePath,
              sessionId: memberId,
              ...knownRoot,
              message: "成员目录包含未受管的派生层级",
            });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              diagnostics.push({
                relativePath: memberRelativePath,
                sessionId: memberId,
                ...knownRoot,
                message: "成员目录完整性无法核验",
              });
            }
          }
        }
      } catch {
        complete = false;
        diagnostics.push({
          relativePath: relativeDirectory,
          sessionId,
          message: "成员目录无法安全枚举",
        });
      }
    }
  }
  if (!complete)
    diagnostics.push({ relativePath: "", message: "Session 位置扫描未完成，不能确认全部候选" });
  return Object.freeze({
    entries: Object.freeze(entries),
    complete,
    diagnostics: Object.freeze(diagnostics),
  });
}

async function inspectLegacyLocation(
  sessionDirectory: string,
  sessionId: string,
  legacyFilePath: string,
): Promise<SessionStorageEntry> {
  const header = await readHeaderFile(sessionDirectory, legacyFilePath);
  if (header.schemaVersion !== 1 || header.sessionId !== sessionId)
    throw new Error("Legacy Session Header 无效。");
  return Object.freeze({
    header,
    location: Object.freeze({
      sessionId,
      storageDirectory: sessionDirectory,
      sessionFilePath: await realpath(legacyFilePath),
      relativeStorageDirectory: null,
      source: "legacy",
    }),
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
  const directoryLocation = distinctCandidates.find(
    (candidate) => candidate.source === "directory",
  );
  const legacyLocation = distinctCandidates.find((candidate) => candidate.source === "legacy");
  if (
    distinctCandidates.length === 2 &&
    directoryLocation !== undefined &&
    legacyLocation !== undefined &&
    (await hasMatchingMigrationBackup(directoryLocation, legacyLocation.sessionFilePath))
  ) {
    return Object.freeze({ ...directoryLocation, legacyFilePath: legacyLocation.sessionFilePath });
  }
  throw new Error("Session ID 存在多个无法确认权威来源的位置。");
}

async function hasMatchingMigrationBackup(
  directoryLocation: SessionStorageLocation,
  legacyFilePath: string,
): Promise<boolean> {
  try {
    const [backup, legacy] = await Promise.all([
      readFile(
        join(directoryLocation.storageDirectory, "migration-backup", "legacy-session.jsonl"),
      ),
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
    const childPath = join(parentDirectory, childName);
    const stats = await lstat(childPath);
    if (!stats.isDirectory() || stats.isSymbolicLink())
      throw new Error("Session 路径不是受管目录。");
    const canonicalChildPath = await realpath(childPath);
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
