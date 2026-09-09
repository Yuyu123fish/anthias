import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  appendJsonLine,
  appendRecoveryRecords,
  ensureSessionGitignore,
  readCompleteSessionJournal,
  readSessionCheckpoint,
  SessionChangedError,
  writeNewSessionHeader,
} from "./journal.js";
import {
  createSessionStorageDirectory,
  locateSessionStorage,
  type SessionStorageLocation,
  writeSessionLocation,
} from "./locations.js";
import {
  acquireSessionLock,
  acquireSessionUsageMarker,
  DEFAULT_SESSION_LOCK_SYSTEM,
  getSessionLockDirectory,
  releaseSessionLock,
  releaseSessionUsageMarker,
  SessionBusyError,
  type SessionLockSystem,
  type SessionUsageMarkerOwnership,
} from "./lock.js";
import {
  completePublishedMigration,
  completeSessionSchemaUpgrade,
  migrateLegacySession,
} from "./migration.js";
import { readOrRebuildResumeIndex } from "./resume-index.js";
import {
  areSameShell,
  areSameWorkspace,
  getSessionOwnership,
  isUuid,
  type Schema2SessionHeader,
  type SessionHeader,
  type SessionKind,
  type SessionRecord,
  type SessionShell,
  type SessionUseDetails,
  type SessionUseRecord,
  snapshotSessionShell,
  validateSessionRecords,
} from "./schema.js";
import { createSessionWriter } from "./writer.js";

export { readSessionHistory, type SessionHistory } from "./history.js";
export type { SessionLockSystem } from "./lock.js";
export type {
  AgentInputDetails,
  ApprovalDecisionDetails,
  CompactionDetails,
  CoordinationDetails,
  RequestUsageDetails,
  RunFinishedDetails,
  SessionKind,
  SessionShell,
  SessionUseDetails,
  ToolExecutionStartedDetails,
} from "./schema.js";
export type { SessionRunAcquisition, SessionRunLease } from "./writer.js";
export { SessionBusyError, SessionChangedError };

/** 表示请求的 Session 身份或持久文件不能安全打开。 */
export class InvalidSessionError extends Error {}

/** 保留 Workspace mismatch 的两端规范化路径，供组合根生成安全提示。 */
export class SessionWorkspaceMismatchError extends Error {
  readonly recordedWorkspaceRoot: string;
  readonly requestedWorkspaceRoot: string;

  constructor(recordedWorkspaceRoot: string, requestedWorkspaceRoot: string) {
    super("Session workspace root 不匹配。");
    this.name = "SessionWorkspaceMismatchError";
    this.recordedWorkspaceRoot = recordedWorkspaceRoot;
    this.requestedWorkspaceRoot = requestedWorkspaceRoot;
  }
}

/** 表示当前固定 Shell 不可用或与 Session Header 不一致。 */
export class SessionShellUnavailableError extends Error {}

/** 提供线性 Session 的持久事实、只读消息投影与关闭生命周期。 */
export type Session = Readonly<{
  sessionId: string;
  rootSessionId: string;
  sessionKind: SessionKind;
  workspaceRoot: string;
  sessionDirectory: string;
  storageDirectory: string;
  shell: SessionShell;
}> &
  ReturnType<typeof createSessionWriter>;
/** 配置一个新 Session 绑定的工作区、数据根与固定 Shell。 */
export type CreateSessionOptions = Readonly<{
  workspaceRoot: string;
  sessionDirectory: string;
  shell: SessionShell;
  sessionId?: string;
  rootSessionId?: string;
  sessionKind?: SessionKind;
  lockSystem?: SessionLockSystem;
}>;

/** 配置要在同一工作区中重新打开的 Session。 */
export type OpenSessionOptions = Omit<
  CreateSessionOptions,
  "sessionId" | "rootSessionId" | "sessionKind"
> &
  Readonly<{
    sessionId: string;
  }>;

/** 按环境覆盖或给定 Anthias Project Root 解析 Session 数据目录。 */
export function resolveSessionDirectory(
  anthiasProjectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const overrideDirectory = environment.ANTHIAS_SESSION_DIR?.trim();
  if (overrideDirectory) {
    if (!isAbsolute(overrideDirectory)) {
      throw new Error("ANTHIAS_SESSION_DIR 必须是绝对路径。");
    }
    return resolve(overrideDirectory);
  }
  return join(resolve(anthiasProjectRoot), "data", "conversation");
}

/** 固定当前平台可复用的非交互 Shell；重开时必须与 Header 完全一致。 */
export async function resolveSessionShell(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<SessionShell> {
  if (platform === "win32") {
    const powerShellExecutable = await resolveExecutableFromPath("pwsh.exe", environment, ";");
    if (powerShellExecutable === null) {
      throw new SessionShellUnavailableError("当前平台没有可用的 pwsh executable。");
    }
    return snapshotSessionShell({
      kind: "powershell",
      executable: powerShellExecutable,
      arguments: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
    });
  }

  const configuredShell = environment.SHELL?.trim();
  if (configuredShell && isAbsolute(configuredShell)) {
    try {
      await access(configuredShell, constants.X_OK);
      return snapshotSessionShell({
        kind: "posix",
        executable: await realpath(configuredShell),
        arguments: ["-lc"],
      });
    } catch {
      // 不可执行的 SHELL 不是稳定运行时，统一回退到 POSIX 默认值。
    }
  }
  try {
    await access("/bin/sh", constants.X_OK);
    return snapshotSessionShell({
      kind: "posix",
      executable: await realpath("/bin/sh"),
      arguments: ["-lc"],
    });
  } catch {
    throw new SessionShellUnavailableError("当前平台没有可用的 /bin/sh executable。");
  }
}

async function resolveExecutableFromPath(
  executableName: string,
  environment: NodeJS.ProcessEnv,
  pathDelimiter: string,
): Promise<string | null> {
  const pathValue = Object.entries(environment).find(
    ([environmentName]) => environmentName.toLocaleLowerCase("en-US") === "path",
  )?.[1];
  if (!pathValue) {
    return null;
  }
  for (const rawDirectory of pathValue.split(pathDelimiter)) {
    const directory = rawDirectory.trim().replace(/^"|"$/gu, "");
    if (directory.length === 0) {
      continue;
    }
    try {
      const candidatePath = join(directory, executableName);
      await access(candidatePath, constants.X_OK);
      return await realpath(candidatePath);
    } catch {
      // PATH 中不可访问的候选项不是稳定的 Session Shell，继续检查下一项。
    }
  }
  return null;
}
/** 创建一个绑定规范化工作区、UTC 存储目录和独立使用标记的 Session。 */
export async function createSession({
  workspaceRoot,
  sessionDirectory,
  shell,
  sessionId = randomUUID(),
  rootSessionId,
  sessionKind = "primary",
  lockSystem = DEFAULT_SESSION_LOCK_SYSTEM,
}: CreateSessionOptions): Promise<Session> {
  const resolvedRootSessionId = rootSessionId ?? sessionId;
  if (
    !isUuid(sessionId) ||
    !isUuid(resolvedRootSessionId) ||
    (sessionKind !== "primary" && sessionKind !== "subagent" && sessionKind !== "teammate") ||
    (sessionKind === "primary") !== (resolvedRootSessionId === sessionId)
  ) {
    throw new InvalidSessionError("Session 成员身份无效。");
  }
  const normalizedWorkspaceRoot = await realpath(workspaceRoot);
  const normalizedSessionDirectory = await prepareSessionDirectory(sessionDirectory);
  const sessionHeader: SessionHeader = Object.freeze({
    type: "session_header",
    schemaVersion: 3,
    sessionId,
    rootSessionId: resolvedRootSessionId,
    sessionKind,
    createdAt: new Date().toISOString(),
    workspaceRoot: normalizedWorkspaceRoot,
    shell: snapshotSessionShell(shell),
  });
  const location = await createSessionStorageDirectory(normalizedSessionDirectory, sessionHeader);
  await writeNewSessionHeader(location.sessionFilePath, sessionHeader);
  await writeSessionLocation(normalizedSessionDirectory, location).catch(() => undefined);

  const lockDirectory = getSessionLockDirectory(
    normalizedSessionDirectory,
    sessionHeader.sessionId,
  );
  const ownership = await acquireSessionLock(lockDirectory, lockSystem);
  let usageMarker: SessionUsageMarkerOwnership | null = null;
  try {
    usageMarker = await acquireSessionUsageMarker(
      normalizedSessionDirectory,
      sessionHeader.sessionId,
      lockSystem,
    );
    const journal = await readCompleteSessionJournal(location.sessionFilePath);
    if (journal.header.schemaVersion !== 3) {
      throw new InvalidSessionError("新建 Session Header 不是 Schema 3。");
    }
    const checkpoint = await readSessionCheckpoint(location.sessionFilePath);
    await readOrRebuildResumeIndex(location.storageDirectory, journal).catch(() => undefined);
    return createSessionView(normalizedWorkspaceRoot, normalizedSessionDirectory, {
      sessionFilePath: location.sessionFilePath,
      initialHeader: sessionHeader,
      storageDirectory: location.storageDirectory,
      initialRecords: journal.records,
      initialCheckpoint: checkpoint,
      lockDirectory,
      lockSystem,
      usageMarker,
    });
  } catch (error) {
    if (usageMarker !== null) {
      await releaseSessionUsageMarker(usageMarker).catch(() => undefined);
    }
    throw error;
  } finally {
    await releaseSessionLock(ownership);
  }
}

/** 按稳定 ID 打开、必要时显式迁移旧格式，并在返回前写入本次打开的使用事实。 */
export async function openSession({
  sessionId,
  workspaceRoot,
  sessionDirectory,
  shell,
  lockSystem = DEFAULT_SESSION_LOCK_SYSTEM,
}: OpenSessionOptions): Promise<Session> {
  if (!isUuid(sessionId)) {
    throw new InvalidSessionError("Session ID 无效。");
  }
  const normalizedWorkspaceRoot = await realpath(workspaceRoot);
  const normalizedSessionDirectory = await realpath(sessionDirectory);
  let location = await locateSessionStorage(normalizedSessionDirectory, sessionId);
  const lockDirectory = getSessionLockDirectory(normalizedSessionDirectory, sessionId);
  const ownership = await acquireSessionLock(lockDirectory, lockSystem);
  let usageMarker: SessionUsageMarkerOwnership | null = null;
  try {
    location = await locateSessionStorage(normalizedSessionDirectory, sessionId);
    if (location.source === "legacy") {
      const migratedSession = await migrateLegacySession(normalizedSessionDirectory, location);
      location = migratedSession.location;
    } else {
      await completePublishedMigration(normalizedSessionDirectory, location);
      location = withoutLegacyFilePath(location);
    }
    await completeSessionSchemaUpgrade(location.storageDirectory);

    let journal = await readCompleteSessionJournal(location.sessionFilePath);
    if (
      (journal.header.schemaVersion !== 2 && journal.header.schemaVersion !== 3) ||
      journal.header.sessionId !== sessionId
    ) {
      throw new InvalidSessionError("Session Header 与请求的 Session ID 不匹配。");
    }
    if (!areSameWorkspace(journal.header.workspaceRoot, normalizedWorkspaceRoot)) {
      throw new SessionWorkspaceMismatchError(
        journal.header.workspaceRoot,
        normalizedWorkspaceRoot,
      );
    }
    const requestedShell = snapshotSessionShell(shell);
    if (!areSameShell(journal.header.shell, requestedShell)) {
      throw new SessionShellUnavailableError("Session Shell 与当前固定 Shell 不匹配。");
    }

    const recoveredRecords = [...journal.records];
    const unfinishedRun = validateSessionRecords(recoveredRecords, journal.header);
    if (unfinishedRun !== null) {
      await appendRecoveryRecords(location.sessionFilePath, recoveredRecords, unfinishedRun);
      journal = await readCompleteSessionJournal(location.sessionFilePath);
    }
    if (journal.header.schemaVersion !== 2 && journal.header.schemaVersion !== 3) {
      throw new InvalidSessionError("Session Schema 迁移未完成。");
    }
    usageMarker = await acquireSessionUsageMarker(
      normalizedSessionDirectory,
      sessionId,
      lockSystem,
    );
    const sessionRecords = [...journal.records];
    await appendSessionUseRecord(
      location.sessionFilePath,
      sessionRecords,
      { activity: "opened" },
      journal.header,
    );
    const checkpoint = await readSessionCheckpoint(location.sessionFilePath);
    journal = await readCompleteSessionJournal(location.sessionFilePath);
    if (journal.header.schemaVersion === 1) {
      throw new InvalidSessionError("Session Schema 迁移未完成。");
    }
    await readOrRebuildResumeIndex(location.storageDirectory, journal).catch(() => undefined);
    return createSessionView(normalizedWorkspaceRoot, normalizedSessionDirectory, {
      sessionFilePath: location.sessionFilePath,
      initialHeader: journal.header,
      storageDirectory: location.storageDirectory,
      initialRecords: journal.records,
      initialCheckpoint: checkpoint,
      lockDirectory,
      lockSystem,
      usageMarker,
    });
  } catch (error) {
    if (usageMarker !== null) {
      await releaseSessionUsageMarker(usageMarker).catch(() => undefined);
    }
    throw error;
  } finally {
    await releaseSessionLock(ownership);
  }
}

async function prepareSessionDirectory(sessionDirectory: string): Promise<string> {
  await mkdir(sessionDirectory, { recursive: true });
  await ensureSessionGitignore(sessionDirectory);
  return realpath(sessionDirectory);
}

function createSessionView(
  workspaceRoot: string,
  sessionDirectory: string,
  writerOptions: Parameters<typeof createSessionWriter>[0],
): Session {
  const sessionWriter = createSessionWriter(writerOptions);
  const sessionHeader = writerOptions.initialHeader;
  const sessionOwnership = getSessionOwnership(sessionHeader);
  return Object.freeze({
    sessionId: sessionHeader.sessionId,
    rootSessionId: sessionOwnership.rootSessionId,
    sessionKind: sessionOwnership.sessionKind,
    workspaceRoot,
    sessionDirectory,
    storageDirectory: writerOptions.storageDirectory,
    shell: sessionHeader.shell,
    get messageHistory() {
      return sessionWriter.messageHistory;
    },
    get records() {
      return sessionWriter.records;
    },
    acquireRun: sessionWriter.acquireRun,
    appendContextSource: sessionWriter.appendContextSource,
    appendCoordination: sessionWriter.appendCoordination,
    appendAgentInput: sessionWriter.appendAgentInput,
    appendCompaction: sessionWriter.appendCompaction,
    appendRequestUsage: sessionWriter.appendRequestUsage,
    appendApprovalDecision: sessionWriter.appendApprovalDecision,
    close: sessionWriter.close,
  });
}

async function appendSessionUseRecord(
  sessionFilePath: string,
  records: SessionRecord[],
  details: SessionUseDetails,
  header: SessionHeader | Schema2SessionHeader,
): Promise<void> {
  const record: SessionUseRecord = Object.freeze({
    type: "session_use",
    entryId: randomUUID(),
    seq: (records.at(-1)?.seq ?? 0) + 1,
    timestamp: new Date().toISOString(),
    parentEntryId: records.at(-1)?.entryId ?? null,
    activity: details.activity,
  });
  validateSessionRecords([...records, record], header);
  await appendJsonLine(sessionFilePath, record);
  records.push(record);
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
