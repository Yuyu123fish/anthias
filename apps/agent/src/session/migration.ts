import { randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  assertSessionCheckpoint,
  hasRecoverableIncompleteSessionTail,
  publishSessionJournal,
  readCompleteSessionText,
  readSessionJournal,
  type VerifiedSessionJournal,
} from "./journal.js";
import {
  createMigrationStagingDirectory,
  getSessionStorageRelativeDirectory,
  type SessionStorageLocation,
  writeSessionLocation,
} from "./locations.js";
import { SessionBusyError } from "./lock.js";
import {
  encodeLegacySessionRecord,
  getSessionOwnership,
  hasExactKeys,
  hasValidCompactionNavigation,
  isUuid,
  type LegacySessionHeader,
  migrateLegacySessionRecords,
  parseLegacySessionRecord,
  parseSessionHeader,
  rebuildCompactionNavigation,
  type Schema2SessionHeader,
  type Schema3SessionHeader,
  type SessionHeader,
  type SessionKind,
  type SessionRecord,
  validateSessionRecords,
} from "./schema.js";

const MIGRATION_STATE_FILE_NAME = "migration-state.json";
const MIGRATION_BACKUP_FILE_NAME = "legacy-session.jsonl";
const SCHEMA_UPGRADE_STATE_FILE_NAME = "schema-upgrade-state.json";
const SCHEMA_UPGRADE_BACKUP_FILE_NAME = "schema2-session.jsonl";
const SCHEMA_UPGRADE_TEMP_FILE_NAME = "session.schema3.tmp";

/** 描述完成格式转换、但尚未移除旧平铺来源的可恢复发布状态。 */
type MigrationState = Readonly<{
  schemaVersion: 1;
  sessionId: string;
  legacyFileName: string;
  state: "published";
}>;

/** 迁移输出保留已验证投影，调用方不会再读取旧文件或执行旧 Tool。 */
export type MigratedSession = Readonly<{
  location: SessionStorageLocation;
  header: Schema2SessionHeader;
  records: readonly SessionRecord[];
}>;

/** 在调用方已取得同一 Session 写锁后，将 Schema 1 发布为带备份的 Schema 2 目录。 */
export async function migrateLegacySession(
  sessionDirectory: string,
  legacyLocation: SessionStorageLocation,
): Promise<MigratedSession> {
  if (legacyLocation.source !== "legacy") {
    throw new Error("只能迁移 Schema 1 Session。");
  }
  await rejectLegacyWriter(legacyLocation.sessionFilePath);
  const originalLegacyBytes = await readFile(legacyLocation.sessionFilePath);
  const legacyText = await readCompleteSessionText(legacyLocation.sessionFilePath);
  const lines = legacyText.slice(0, -1).split("\n");
  const legacyHeader = parseSessionHeader(lines[0]);
  if (legacyHeader.schemaVersion !== 1 || legacyHeader.sessionId !== legacyLocation.sessionId) {
    throw new Error("Legacy Session Header 无效。");
  }
  const legacyRecords = lines
    .slice(1)
    .map((line, index) => parseLegacySessionRecord(line, index + 1));
  const migratedRecords = migrateLegacySessionRecords(legacyRecords);
  const migratedHeader = createMigratedHeader(legacyHeader);
  const stagingDirectory = await createMigrationStagingDirectory(sessionDirectory, migratedHeader);
  const finalRelativeDirectory = getSessionStorageRelativeDirectory(migratedHeader);
  const finalDirectory = join(dirname(stagingDirectory), basename(finalRelativeDirectory));

  await writeMigrationBackup(stagingDirectory, originalLegacyBytes);
  await writeMigrationState(stagingDirectory, {
    schemaVersion: 1,
    sessionId: migratedHeader.sessionId,
    legacyFileName: basename(legacyLocation.sessionFilePath),
    state: "published",
  });
  await writeMigratedJournal(stagingDirectory, migratedHeader, migratedRecords);
  const stagedJournal = await readSessionJournal(join(stagingDirectory, "session.jsonl"));
  if (
    stagedJournal.header.schemaVersion !== 2 ||
    stagedJournal.header.sessionId !== migratedHeader.sessionId ||
    stagedJournal.records.length !== migratedRecords.length
  ) {
    throw new Error("Session 迁移暂存日志校验失败。");
  }
  await rename(stagingDirectory, finalDirectory);

  const location: SessionStorageLocation = Object.freeze({
    sessionId: migratedHeader.sessionId,
    storageDirectory: finalDirectory,
    sessionFilePath: join(finalDirectory, "session.jsonl"),
    relativeStorageDirectory: finalRelativeDirectory,
    source: "directory",
    legacyFilePath: legacyLocation.sessionFilePath,
  });
  await writeSessionLocation(sessionDirectory, location).catch(() => undefined);
  await completePublishedMigration(sessionDirectory, location);
  return Object.freeze({
    location: withoutLegacyFilePath(location),
    header: migratedHeader,
    records: migratedRecords,
  });
}

/** 完成一次已发布迁移；中断后只接受备份与原文件完全匹配的来源。 */
export async function completePublishedMigration(
  sessionDirectory: string,
  location: SessionStorageLocation,
): Promise<void> {
  if (location.source !== "directory") {
    return;
  }
  const state = await readMigrationState(location.storageDirectory);
  if (state === null) {
    return;
  }
  if (state.sessionId !== location.sessionId) {
    throw new Error("Session 迁移发布状态无效。");
  }
  const expectedLegacyFilePath = join(sessionDirectory, state.legacyFileName);
  if (location.legacyFilePath === undefined) {
    try {
      await access(expectedLegacyFilePath);
      throw new Error("Session 迁移旧来源未被定位，无法确认权威数据。");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    await unlink(join(location.storageDirectory, MIGRATION_STATE_FILE_NAME));
    await writeSessionLocation(sessionDirectory, withoutLegacyFilePath(location)).catch(
      () => undefined,
    );
    return;
  }
  if (basename(location.legacyFilePath) !== state.legacyFileName) {
    throw new Error("Session 迁移旧来源不匹配。");
  }
  const [backup, legacy] = await Promise.all([
    readFile(join(location.storageDirectory, "migration-backup", MIGRATION_BACKUP_FILE_NAME)),
    readFile(location.legacyFilePath),
  ]);
  if (!matchesPublishedMigrationBackup(backup, legacy)) {
    throw new Error("Session 迁移来源冲突，无法确认权威数据。");
  }
  await rejectLegacyWriter(location.legacyFilePath);
  await unlink(location.legacyFilePath);
  await unlink(join(location.storageDirectory, MIGRATION_STATE_FILE_NAME));
  await writeSessionLocation(sessionDirectory, withoutLegacyFilePath(location)).catch(
    () => undefined,
  );
}
/** 接受只在 EOF 恢复路径中安全截掉的旧尾段，其余差异一律拒绝。 */
function matchesPublishedMigrationBackup(backup: Buffer, legacy: Buffer): boolean {
  return (
    backup.equals(legacy) ||
    (legacy.at(-1) === 0x0a &&
      legacy.byteLength < backup.byteLength &&
      backup.subarray(0, legacy.byteLength).equals(legacy) &&
      hasRecoverableIncompleteSessionTail(backup))
  );
}
type SchemaUpgradeState = Readonly<{
  schemaVersion: 2;
  sessionId: string;
  rootSessionId: string;
  sessionKind: SessionKind;
  state: "prepared";
}>;

/** 执行打开持锁后才升级当前 Session；旧格式与导航修复共用完整候选发布。 */
export async function upgradeSessionToSchema4(
  sessionFilePath: string,
  journal: VerifiedSessionJournal,
) {
  const checkpoint = journal.checkpoint;
  await assertSessionCheckpoint(sessionFilePath, checkpoint);
  if (checkpoint.fileSize !== journal.fileSize) throw new Error("Session 升级前日志已变化。");
  const navigation = rebuildCompactionNavigation(journal.records);
  const header: SessionHeader = Object.freeze({
    type: "session_header",
    schemaVersion: 4,
    sessionId: journal.header.sessionId,
    ...getSessionOwnership(journal.header),
    createdAt: journal.header.createdAt,
    workspaceRoot: journal.header.workspaceRoot,
    shell: journal.header.shell,
    latestCompactionEntryId: navigation.latestCompactionEntryId,
  });
  if (
    journal.header.schemaVersion === 4 &&
    hasValidCompactionNavigation(journal.header, journal.records)
  ) {
    return Object.freeze({ header, records: journal.records, checkpoint });
  }
  const committedCheckpoint = await publishSessionJournal(
    sessionFilePath,
    header,
    navigation.records,
    checkpoint,
  );
  return Object.freeze({ header, records: navigation.records, checkpoint: committedCheckpoint });
}

/** 恢复已经刷新升级意图但尚未完成的同目录 Header 替换。 */
export async function completeSessionSchemaUpgrade(storageDirectory: string): Promise<void> {
  const state = await readSchemaUpgradeState(storageDirectory);
  if (state === null) {
    return;
  }
  const sessionFilePath = join(storageDirectory, "session.jsonl");
  const temporaryPath = join(storageDirectory, SCHEMA_UPGRADE_TEMP_FILE_NAME);
  const backupPath = join(storageDirectory, SCHEMA_UPGRADE_BACKUP_FILE_NAME);
  const currentJournal = await readJournalIfExists(sessionFilePath);
  const stagedJournal = await readJournalIfExists(temporaryPath);
  const backupJournal = await readJournalIfExists(backupPath);

  if (currentJournal?.header.schemaVersion === 3) {
    assertSchemaUpgradeTarget(currentJournal.header, state);
    await unlinkIfExists(backupPath);
    await unlinkIfExists(temporaryPath);
    await unlinkIfExists(join(storageDirectory, SCHEMA_UPGRADE_STATE_FILE_NAME));
    return;
  }
  if (
    currentJournal?.header.schemaVersion === 2 &&
    stagedJournal?.header.schemaVersion === 3 &&
    backupJournal === null
  ) {
    assertSchemaUpgradeTarget(stagedJournal.header, state);
    await rename(sessionFilePath, backupPath);
    await rename(temporaryPath, sessionFilePath);
    await completeSessionSchemaUpgrade(storageDirectory);
    return;
  }
  if (
    currentJournal === null &&
    backupJournal?.header.schemaVersion === 2 &&
    stagedJournal?.header.schemaVersion === 3
  ) {
    assertSchemaUpgradeTarget(stagedJournal.header, state);
    await rename(temporaryPath, sessionFilePath);
    await completeSessionSchemaUpgrade(storageDirectory);
    return;
  }
  throw new Error("Session Schema 3 升级状态无法安全恢复。");
}

/** 清理方遇到正在发布或格式异常的迁移标记时必须跳过该 Session。 */
export async function hasPendingSessionMigration(storageDirectory: string): Promise<boolean> {
  try {
    return (
      (await readMigrationState(storageDirectory)) !== null ||
      (await readSchemaUpgradeState(storageDirectory)) !== null
    );
  } catch {
    return true;
  }
}

/** 将 Schema 1 Header 的稳定字段逐字保留，只提升版本号。 */
function createMigratedHeader(legacyHeader: LegacySessionHeader): Schema2SessionHeader {
  return Object.freeze({
    type: "session_header",
    schemaVersion: 2,
    sessionId: legacyHeader.sessionId,
    createdAt: legacyHeader.createdAt,
    workspaceRoot: legacyHeader.workspaceRoot,
    shell: legacyHeader.shell,
  });
}

function withoutLegacyFilePath(location: SessionStorageLocation): SessionStorageLocation {
  return Object.freeze({
    sessionId: location.sessionId,
    storageDirectory: location.storageDirectory,
    sessionFilePath: location.sessionFilePath,
    relativeStorageDirectory: location.relativeStorageDirectory,
    source: location.source,
  });
}
async function writeMigrationBackup(stagingDirectory: string, legacyBytes: Buffer): Promise<void> {
  const backupDirectory = join(stagingDirectory, "migration-backup");
  await mkdir(backupDirectory);
  await writeSyncedFile(join(backupDirectory, MIGRATION_BACKUP_FILE_NAME), legacyBytes);
}

async function writeMigrationState(stagingDirectory: string, state: MigrationState): Promise<void> {
  await writeSyncedFile(
    join(stagingDirectory, MIGRATION_STATE_FILE_NAME),
    Buffer.from(`${JSON.stringify(state)}\n`, "utf8"),
  );
}

async function writeMigratedJournal(
  stagingDirectory: string,
  header: Schema2SessionHeader,
  records: readonly SessionRecord[],
): Promise<void> {
  validateSessionRecords(records);
  const journalText = `${JSON.stringify(header)}\n${records.map((record) => JSON.stringify(encodeLegacySessionRecord(record))).join("\n")}${records.length === 0 ? "" : "\n"}`;
  const normalizedJournalText = journalText.endsWith("\n") ? journalText : `${journalText}\n`;
  const temporaryJournalPath = join(stagingDirectory, `.session.${randomUUID()}.tmp`);
  const finalJournalPath = join(stagingDirectory, "session.jsonl");
  await writeSyncedFile(temporaryJournalPath, Buffer.from(normalizedJournalText, "utf8"));
  await rename(temporaryJournalPath, finalJournalPath);
}

async function rejectLegacyWriter(legacySessionFilePath: string): Promise<void> {
  const legacyLockDirectory = legacySessionFilePath.replace(/\.jsonl$/u, ".lock");
  try {
    await access(legacyLockDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new SessionBusyError("Session 正在被旧版本进程使用，暂时不能迁移。");
}

async function readMigrationState(storageDirectory: string): Promise<MigrationState | null> {
  try {
    const stateText = await readFile(join(storageDirectory, MIGRATION_STATE_FILE_NAME), "utf8");
    if (!stateText.endsWith("\n")) {
      throw new Error("Session 迁移状态不完整。");
    }
    const state = JSON.parse(stateText.slice(0, -1)) as unknown;
    if (state === null || typeof state !== "object" || Array.isArray(state)) {
      throw new Error("Session 迁移状态无效。");
    }
    const record = state as Record<string, unknown>;
    if (
      Object.keys(record).length !== 4 ||
      record.schemaVersion !== 1 ||
      typeof record.sessionId !== "string" ||
      !isUuid(record.sessionId) ||
      typeof record.legacyFileName !== "string" ||
      record.legacyFileName !== `${record.sessionId}.jsonl` ||
      record.state !== "published"
    ) {
      throw new Error("Session 迁移状态无效。");
    }
    return Object.freeze({
      schemaVersion: 1,
      sessionId: record.sessionId,
      legacyFileName: record.legacyFileName,
      state: "published",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readSchemaUpgradeState(
  storageDirectory: string,
): Promise<SchemaUpgradeState | null> {
  try {
    const stateText = await readFile(
      join(storageDirectory, SCHEMA_UPGRADE_STATE_FILE_NAME),
      "utf8",
    );
    if (!stateText.endsWith("\n")) {
      throw new Error("Session Schema 3 升级状态不完整。");
    }
    const value: unknown = JSON.parse(stateText.slice(0, -1));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Session Schema 3 升级状态无效。");
    }
    const state = value as Record<string, unknown>;
    if (
      !hasExactKeys(state, [
        "schemaVersion",
        "sessionId",
        "rootSessionId",
        "sessionKind",
        "state",
      ]) ||
      state.schemaVersion !== 2 ||
      !isUuid(state.sessionId) ||
      !isUuid(state.rootSessionId) ||
      (state.sessionKind !== "primary" &&
        state.sessionKind !== "subagent" &&
        state.sessionKind !== "teammate") ||
      state.state !== "prepared"
    ) {
      throw new Error("Session Schema 3 升级状态无效。");
    }
    return Object.freeze(state) as SchemaUpgradeState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function assertSchemaUpgradeTarget(
  header: Schema3SessionHeader,
  target: Readonly<{
    sessionId: string;
    rootSessionId: string;
    sessionKind: SessionKind;
  }>,
): void {
  if (
    header.sessionId !== target.sessionId ||
    header.rootSessionId !== target.rootSessionId ||
    header.sessionKind !== target.sessionKind
  ) {
    throw new Error("Session Schema 3 升级身份不匹配。");
  }
}

async function readJournalIfExists(path: string) {
  try {
    return await readSessionJournal(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function writeSyncedFile(path: string, content: Buffer): Promise<void> {
  const fileHandle = await open(path, "wx");
  try {
    await fileHandle.writeFile(content);
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }
}
