import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { Message } from "../message.js";
import {
  appendJsonLine,
  appendRecoveryRecords,
  ensureSessionGitignore,
  readCompleteSessionJournal,
  readSessionCheckpoint,
  readSessionJournal,
  SessionChangedError,
  type SessionFileCheckpoint,
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
  type SessionLockOwnership,
  type SessionLockSystem,
  type SessionUsageMarkerOwnership,
} from "./lock.js";
import {
  completePublishedMigration,
  completeSessionSchemaUpgrade,
  migrateLegacySession,
  upgradeSessionToSchema3,
} from "./migration.js";
import { readOrRebuildResumeIndex } from "./resume-index.js";
import {
  type AgentInputDetails,
  type AgentInputRecord,
  type ApprovalDecisionDetails,
  type ApprovalDecisionRecord,
  areSameShell,
  areSameWorkspace,
  type CompactionDetails,
  type CompactionRecord,
  type ContextSourceDetails,
  type ContextSourceRecord,
  type CoordinationDetails,
  type CoordinationRecord,
  fromDurableMessage,
  getSessionOwnership,
  isJsonValue,
  isSideEffectToolName,
  isUuid,
  isValidCompactionRecord,
  type MessageRecord,
  parseSessionRecord,
  type RequestUsageDetails,
  type RequestUsageRecord,
  type RunFinishedDetails,
  type Schema2SessionHeader,
  type SessionHeader,
  type SessionKind,
  type SessionRecord,
  type SessionShell,
  type SessionUseDetails,
  type SessionUseRecord,
  snapshotJsonValue,
  snapshotSessionShell,
  type ToolExecutionStartedDetails,
  toDurableMessage,
  validateSessionRecords,
} from "./schema.js";

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

/** 持有单个已接受 Run 的 Session 写锁与串行追加能力。 */
export type SessionRunLease = Readonly<{
  appendContextSource(details: ContextSourceDetails): Promise<void>;
  appendCoordination(details: CoordinationDetails): Promise<void>;
  appendAgentInput(details: AgentInputDetails): Promise<void>;
  appendMessage(message: Message): Promise<void>;
  appendToolExecutionStarted(details: ToolExecutionStartedDetails): Promise<void>;
  appendRunFinished(details: RunFinishedDetails): Promise<void>;
  appendCompaction(details: CompactionDetails): Promise<void>;
  appendRequestUsage(details: RequestUsageDetails): Promise<void>;
  appendApprovalDecision(details: ApprovalDecisionDetails): Promise<void>;
  release(): Promise<void>;
}>;

/** 表示 Run 已取得独占 lease，或在任何副作用前被 Session 拒绝。 */
export type SessionRunAcquisition =
  | Readonly<{ status: "acquired"; lease: SessionRunLease }>
  | Readonly<{ status: "rejected"; reason: "session_busy" | "session_changed" }>;

/** 提供线性 Session 的持久事实、只读消息投影与关闭生命周期。 */
export type Session = Readonly<{
  sessionId: string;
  rootSessionId: string;
  sessionKind: SessionKind;
  workspaceRoot: string;
  sessionDirectory: string;
  storageDirectory: string;
  shell: SessionShell;
  readonly messageHistory: readonly Message[];
  readonly records: readonly SessionRecord[];
  acquireRun(runId: string): Promise<SessionRunAcquisition>;
  appendContextSource(details: ContextSourceDetails): Promise<void>;
  appendCoordination(details: CoordinationDetails): Promise<void>;
  appendAgentInput(details: AgentInputDetails): Promise<void>;
  appendCompaction(details: CompactionDetails): Promise<void>;
  appendRequestUsage(details: RequestUsageDetails): Promise<void>;
  appendApprovalDecision(details: ApprovalDecisionDetails): Promise<void>;
  close(): Promise<void>;
}>;

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
    return createSessionRuntime({
      sessionFilePath: location.sessionFilePath,
      sessionId: sessionHeader.sessionId,
      rootSessionId: sessionHeader.rootSessionId,
      sessionKind: sessionHeader.sessionKind,
      initialHeader: sessionHeader,
      workspaceRoot: normalizedWorkspaceRoot,
      sessionDirectory: normalizedSessionDirectory,
      storageDirectory: location.storageDirectory,
      shell: sessionHeader.shell,
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
    if (location.source === "schema1") {
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
    const ownership = getSessionOwnership(journal.header);
    return createSessionRuntime({
      sessionFilePath: location.sessionFilePath,
      sessionId,
      rootSessionId: ownership.rootSessionId,
      sessionKind: ownership.sessionKind,
      initialHeader: journal.header,
      workspaceRoot: normalizedWorkspaceRoot,
      sessionDirectory: normalizedSessionDirectory,
      storageDirectory: location.storageDirectory,
      shell: journal.header.shell,
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
type SessionRuntimeOptions = Readonly<{
  sessionFilePath: string;
  sessionId: string;
  rootSessionId: string;
  sessionKind: SessionKind;
  initialHeader: SessionHeader | Schema2SessionHeader;
  workspaceRoot: string;
  sessionDirectory: string;
  storageDirectory: string;
  shell: SessionShell;
  initialRecords: readonly SessionRecord[];
  initialCheckpoint: SessionFileCheckpoint;
  lockDirectory: string;
  lockSystem: SessionLockSystem;
  usageMarker: SessionUsageMarkerOwnership;
}>;

/** 从已验证的 Header 与记录投影组装 Session 运行时。 */
function createSessionRuntime(options: SessionRuntimeOptions): Session {
  const messageHistory = options.initialRecords
    .filter((record): record is MessageRecord => record.type === "message")
    .map((record) => fromDurableMessage(record.message));
  let currentHeader: SessionHeader | Schema2SessionHeader = options.initialHeader;
  let records = [...options.initialRecords];
  let checkpoint = options.initialCheckpoint;
  let sessionChanged = false;
  let closed = false;
  let closePromise: Promise<void> | null = null;
  let activeLeaseCompletion: Promise<void> | null = null;
  type RecordFactory = (sequence: number, parentEntryId: string | null) => SessionRecord;
  type RecordAppender = (
    createRecord: RecordFactory,
    afterAppend?: (record: SessionRecord) => void,
    requiresSchema3?: boolean,
    acceptedBeforeClose?: boolean,
  ) => Promise<void>;
  let activeRunAppend: Readonly<{
    runId: string;
    enqueue: RecordAppender;
    hasScheduledInitialInput(): boolean;
    markInitialInputScheduled(): void;
    hasScheduledFinish(): boolean;
  }> | null = null;
  const pendingRunAcquisitionCompletions = new Set<Promise<void>>();
  let sessionAppendQueue: Promise<void> = Promise.resolve();

  function enqueueSessionAppend<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (closed) {
      return Promise.reject(new Error("Session 已关闭，不能追加持久事实。"));
    }
    const appendPromise = sessionAppendQueue.then(operation);
    sessionAppendQueue = appendPromise.then(
      () => undefined,
      () => undefined,
    );
    return appendPromise;
  }

  async function appendUsingCurrentRunOrLock(
    appendToRun: (appender: NonNullable<typeof activeRunAppend>) => Promise<void>,
    appendWithLock: () => Promise<void>,
  ): Promise<void> {
    while (true) {
      const appender = activeRunAppend;
      if (appender !== null) {
        // 取得引用后不再 await，立即入其队列，避免 release 清空 appender 后继续使用旧 lease。
        return appendToRun(appender);
      }
      const acquisitions = [...pendingRunAcquisitionCompletions];
      if (acquisitions.length > 0) {
        await Promise.all(acquisitions);
        continue;
      }
      const leaseCompletion = activeLeaseCompletion;
      if (leaseCompletion !== null) {
        await leaseCompletion;
        continue;
      }
      return appendWithLock();
    }
  }

  async function refreshAfterUsageOnlyAppend(): Promise<boolean> {
    const journal = await readSessionJournal(options.sessionFilePath).catch(() => null);
    if (
      journal === null ||
      journal.header.schemaVersion === 1 ||
      journal.header.sessionId !== options.sessionId ||
      JSON.stringify(journal.header) !== JSON.stringify(currentHeader)
    ) {
      sessionChanged = true;
      return false;
    }
    const diskRecords = journal.records;
    if (records.length === diskRecords.length) {
      if (
        records.every(
          (record, index) => JSON.stringify(record) === JSON.stringify(diskRecords[index]),
        )
      ) {
        const refreshedCheckpoint = await readSessionCheckpoint(options.sessionFilePath).catch(
          () => null,
        );
        if (refreshedCheckpoint === null) {
          sessionChanged = true;
          return false;
        }
        checkpoint = refreshedCheckpoint;
        return true;
      }
      sessionChanged = true;
      return false;
    }
    const knownPrefixIsUnchanged =
      records.length < diskRecords.length &&
      records.every(
        (record, index) => JSON.stringify(record) === JSON.stringify(diskRecords[index]),
      );
    const appendedRecords = diskRecords.slice(records.length);
    if (
      !knownPrefixIsUnchanged ||
      appendedRecords.some((record) => record.type !== "session_use")
    ) {
      sessionChanged = true;
      return false;
    }
    const refreshedCheckpoint = await readSessionCheckpoint(options.sessionFilePath).catch(
      () => null,
    );
    if (refreshedCheckpoint === null) {
      sessionChanged = true;
      return false;
    }
    records = [...diskRecords];
    checkpoint = refreshedCheckpoint;
    await refreshResumeIndex().catch(() => undefined);
    return true;
  }

  async function refreshResumeIndex(): Promise<void> {
    const journal = await readCompleteSessionJournal(options.sessionFilePath);
    if (journal.header.schemaVersion === 1) {
      throw new Error("Session 恢复索引只能写入目录日志。");
    }
    await readOrRebuildResumeIndex(options.storageDirectory, journal);
  }

  async function ensureSchema3(): Promise<void> {
    if (currentHeader.schemaVersion === 3) {
      return;
    }
    currentHeader = await upgradeSessionToSchema3(options.storageDirectory, {
      sessionId: options.sessionId,
      rootSessionId: options.rootSessionId,
      sessionKind: options.sessionKind,
    });
    checkpoint = await readSessionCheckpoint(options.sessionFilePath);
  }

  async function appendRecord(
    createRecord: RecordFactory,
    afterAppend?: (record: SessionRecord) => void,
    requiresSchema3 = false,
  ): Promise<void> {
    if (requiresSchema3) {
      await ensureSchema3();
    }
    const rawRecord = createRecord(checkpoint.lastSequence + 1, records.at(-1)?.entryId ?? null);
    if (rawRecord.type === "agent_input") {
      const existingInput = records.find(
        (record): record is AgentInputRecord =>
          record.type === "agent_input" && record.messageId === rawRecord.messageId,
      );
      if (existingInput !== undefined) {
        if (areSameAgentInput(existingInput, rawRecord)) {
          return;
        }
        throw new Error("AgentInputRecord messageId 已绑定其他内容。");
      }
    }
    const record = parseSessionRecord(
      JSON.stringify(rawRecord),
      checkpoint.lastSequence + 1,
      currentHeader.schemaVersion,
    );
    if (record.type === "compaction") {
      const previousRecordsByEntryId = new Map<string, SessionRecord>();
      for (const previousRecord of records) {
        previousRecordsByEntryId.set(previousRecord.entryId, previousRecord);
      }
      if (!isValidCompactionRecord(record, previousRecordsByEntryId)) {
        throw new Error("CompactionEntry 引用无效。");
      }
    }
    validateSessionRecords([...records, record], currentHeader);
    await appendJsonLine(options.sessionFilePath, record);
    records.push(record);
    checkpoint = await readSessionCheckpoint(options.sessionFilePath);
    afterAppend?.(record);
    await refreshResumeIndex().catch(() => undefined);
  }

  async function appendStandaloneRecordNow(
    createRecord: RecordFactory,
    requiresSchema3 = false,
  ): Promise<void> {
    let ownership: SessionLockOwnership;
    try {
      ownership = await acquireSessionLock(options.lockDirectory, options.lockSystem);
    } catch (error) {
      if (error instanceof SessionBusyError) {
        throw new SessionBusyError("Session 正在被 Run 使用。");
      }
      throw error;
    }
    try {
      if (!(await refreshAfterUsageOnlyAppend())) {
        throw new SessionChangedError("Session 业务历史已变化，不能用旧上下文追加事实。");
      }
      await appendRecord(createRecord, undefined, requiresSchema3);
    } finally {
      await releaseSessionLock(ownership);
    }
  }

  function appendCoordinationToRun(
    details: CoordinationDetails,
    appender: NonNullable<typeof activeRunAppend>,
    acceptedBeforeClose = false,
  ): Promise<void> {
    const associatedRunId =
      appender.hasScheduledInitialInput() && !appender.hasScheduledFinish()
        ? appender.runId
        : undefined;
    return appender.enqueue(
      (sequence, parentEntryId) =>
        createCoordinationRecord(sequence, parentEntryId, details, associatedRunId),
      undefined,
      true,
      acceptedBeforeClose,
    );
  }

  function appendCoordination(details: CoordinationDetails): Promise<void> {
    return enqueueSessionAppend(() =>
      appendUsingCurrentRunOrLock(
        (appender) => appendCoordinationToRun(details, appender, true),
        () =>
          appendStandaloneRecordNow(
            (sequence, parentEntryId) => createCoordinationRecord(sequence, parentEntryId, details),
            true,
          ),
      ),
    );
  }

  function appendAgentInputToRun(
    details: AgentInputDetails,
    appender: NonNullable<typeof activeRunAppend>,
    acceptedBeforeClose = false,
  ): Promise<void> {
    if (!appender.hasScheduledFinish()) {
      appender.markInitialInputScheduled();
    }
    const associatedRunId = appender.hasScheduledFinish() ? undefined : appender.runId;
    return appender.enqueue(
      (sequence, parentEntryId) =>
        createAgentInputRecord(sequence, parentEntryId, details, associatedRunId),
      undefined,
      true,
      acceptedBeforeClose,
    );
  }

  function appendAgentInput(details: AgentInputDetails): Promise<void> {
    return enqueueSessionAppend(() =>
      appendUsingCurrentRunOrLock(
        (appender) => appendAgentInputToRun(details, appender, true),
        () =>
          appendStandaloneRecordNow(
            (sequence, parentEntryId) => createAgentInputRecord(sequence, parentEntryId, details),
            true,
          ),
      ),
    );
  }
  return Object.freeze({
    sessionId: options.sessionId,
    rootSessionId: options.rootSessionId,
    sessionKind: options.sessionKind,
    workspaceRoot: options.workspaceRoot,
    sessionDirectory: options.sessionDirectory,
    storageDirectory: options.storageDirectory,
    shell: options.shell,
    get messageHistory() {
      return Object.freeze([...messageHistory]);
    },
    get records() {
      return Object.freeze([...records]);
    },
    async acquireRun(runId) {
      if (!isUuid(runId)) {
        throw new Error("Run ID 无效。");
      }
      if (closed) {
        throw new Error("Session 已关闭，不能开始新的 Run。");
      }
      return enqueueSessionAppend<SessionRunAcquisition>(async () => {
        const releasingLeaseCompletion = activeRunAppend === null ? activeLeaseCompletion : null;
        if (releasingLeaseCompletion !== null) {
          await releasingLeaseCompletion;
        }
        if (closed) {
          return Object.freeze({ status: "rejected", reason: "session_busy" });
        }
        if (sessionChanged) {
          return Object.freeze({ status: "rejected", reason: "session_changed" });
        }

        let resolveAcquisitionCompletion!: () => void;
        const acquisitionCompletion = new Promise<void>((resolve) => {
          resolveAcquisitionCompletion = resolve;
        });
        pendingRunAcquisitionCompletions.add(acquisitionCompletion);
        let ownership: SessionLockOwnership | null = null;
        try {
          try {
            ownership = await acquireSessionLock(options.lockDirectory, options.lockSystem);
          } catch (error) {
            if (error instanceof SessionBusyError) {
              return Object.freeze({ status: "rejected", reason: "session_busy" });
            }
            throw error;
          }
          if (closed || !(await refreshAfterUsageOnlyAppend())) {
            const rejectedOwnership = ownership;
            ownership = null;
            await releaseSessionLock(rejectedOwnership);
            return Object.freeze({
              status: "rejected",
              reason: closed ? "session_busy" : "session_changed",
            });
          }

          const leaseOwnership = ownership;
          if (leaseOwnership === null) {
            throw new Error("Session Run 锁所有权丢失。");
          }
          let released = false;
          let runFinished = false;
          let initialRunInputScheduled = false;
          let runFinishScheduled = false;
          let appendFailure: unknown = null;
          let resolveLeaseCompletion!: () => void;
          activeLeaseCompletion = new Promise<void>((resolve) => {
            resolveLeaseCompletion = resolve;
          });
          let appendQueue: Promise<void> = Promise.resolve();

          const enqueueRecord: RecordAppender = (
            createRecord,
            afterAppend,
            requiresSchema3 = false,
            acceptedBeforeClose = false,
          ) => {
            if (released || (closed && !acceptedBeforeClose)) {
              return Promise.reject(new Error("Session Run lease 已释放或 Session 已关闭。"));
            }
            if (appendFailure !== null) {
              return Promise.reject(new Error("Session Run 先前的持久写入已经失败。"));
            }
            const appendPromise = appendQueue.then(async () => {
              if (appendFailure !== null) {
                throw new Error("Session Run 先前的持久写入已经失败。");
              }
              try {
                await appendRecord(createRecord, afterAppend, requiresSchema3);
              } catch (error) {
                appendFailure = error;
                sessionChanged = true;
                throw error;
              }
            });
            appendQueue = appendPromise.catch(() => undefined);
            return appendPromise;
          };

          const leaseAppender = Object.freeze({
            runId,
            enqueue: enqueueRecord,
            hasScheduledInitialInput: () => initialRunInputScheduled,
            markInitialInputScheduled: () => {
              initialRunInputScheduled = true;
            },
            hasScheduledFinish: () => runFinishScheduled,
          });
          activeRunAppend = leaseAppender;
          const lease: SessionRunLease = Object.freeze({
            appendMessage(message) {
              const durableMessage = toDurableMessage(message);
              if (durableMessage.type === "user") {
                initialRunInputScheduled = true;
              }
              const historyMessage = fromDurableMessage(durableMessage);
              return enqueueRecord(
                (sequence, parentEntryId) =>
                  Object.freeze({
                    type: "message",
                    entryId: randomUUID(),
                    seq: sequence,
                    timestamp: new Date().toISOString(),
                    parentEntryId,
                    runId,
                    message: durableMessage,
                  }),
                () => messageHistory.push(historyMessage),
              );
            },
            appendCoordination(details) {
              return appendCoordinationToRun(details, leaseAppender);
            },
            appendAgentInput(details) {
              return appendAgentInputToRun(details, leaseAppender);
            },
            appendToolExecutionStarted(details) {
              if (
                !isUuid(details.toolCallId) ||
                !isSideEffectToolName(details.toolName) ||
                !isUuid(details.toolApprovalRequestId)
              ) {
                return Promise.reject(new Error("ToolExecutionStarted 身份无效。"));
              }
              return enqueueRecord((sequence, parentEntryId) =>
                Object.freeze({
                  type: "tool_execution_started",
                  entryId: randomUUID(),
                  seq: sequence,
                  timestamp: new Date().toISOString(),
                  parentEntryId,
                  runId,
                  toolCallId: details.toolCallId,
                  toolName: details.toolName,
                  toolApprovalRequestId: details.toolApprovalRequestId,
                }),
              );
            },
            appendRunFinished(details) {
              if (runFinishScheduled) {
                return Promise.reject(new Error("Session Run 终态已经安排写入。"));
              }
              runFinishScheduled = true;
              return enqueueRecord(
                (sequence, parentEntryId) =>
                  Object.freeze({
                    type: "run_finished",
                    entryId: randomUUID(),
                    seq: sequence,
                    timestamp: new Date().toISOString(),
                    parentEntryId,
                    runId,
                    status: details.status,
                  }),
                () => {
                  runFinished = true;
                },
              );
            },
            appendContextSource(details) {
              return enqueueRecord((sequence, parentEntryId) =>
                createContextSourceRecord(sequence, parentEntryId, details, runId),
              );
            },
            appendCompaction(details) {
              return enqueueRecord((sequence, parentEntryId) =>
                createCompactionRecord(sequence, parentEntryId, details, runId),
              );
            },
            appendRequestUsage(details) {
              return enqueueRecord((sequence, parentEntryId) =>
                createRequestUsageRecord(sequence, parentEntryId, details, runId),
              );
            },
            appendApprovalDecision(details) {
              return enqueueRecord((sequence, parentEntryId) =>
                createApprovalDecisionRecord(sequence, parentEntryId, details, runId),
              );
            },
            async release() {
              if (released) {
                return;
              }
              released = true;
              if (activeRunAppend === leaseAppender) {
                activeRunAppend = null;
              }
              try {
                await appendQueue;
                if (!runFinished || appendFailure !== null) {
                  sessionChanged = true;
                }
              } finally {
                try {
                  await releaseSessionLock(leaseOwnership);
                } finally {
                  resolveLeaseCompletion();
                  activeLeaseCompletion = null;
                }
              }
            },
          });
          ownership = null;
          return Object.freeze({ status: "acquired", lease });
        } finally {
          try {
            if (ownership !== null) {
              await releaseSessionLock(ownership);
            }
          } finally {
            resolveAcquisitionCompletion();
            pendingRunAcquisitionCompletions.delete(acquisitionCompletion);
          }
        }
      });
    },
    appendContextSource(details) {
      return enqueueSessionAppend(() =>
        appendStandaloneRecordNow((sequence, parentEntryId) =>
          createContextSourceRecord(sequence, parentEntryId, details),
        ),
      );
    },
    appendCoordination,
    appendAgentInput,
    appendCompaction(details) {
      return enqueueSessionAppend(() =>
        appendStandaloneRecordNow((sequence, parentEntryId) =>
          createCompactionRecord(sequence, parentEntryId, details),
        ),
      );
    },
    appendRequestUsage(details) {
      return enqueueSessionAppend(() =>
        appendStandaloneRecordNow((sequence, parentEntryId) =>
          createRequestUsageRecord(sequence, parentEntryId, details),
        ),
      );
    },
    appendApprovalDecision(details) {
      return enqueueSessionAppend(() =>
        appendStandaloneRecordNow((sequence, parentEntryId) =>
          createApprovalDecisionRecord(sequence, parentEntryId, details),
        ),
      );
    },
    close() {
      if (closePromise !== null) {
        return closePromise;
      }
      closed = true;
      const acquisitionsAtClose = [...pendingRunAcquisitionCompletions];
      closePromise = (async () => {
        try {
          await Promise.all(acquisitionsAtClose);
          await sessionAppendQueue;
          await activeLeaseCompletion;
        } finally {
          await releaseSessionUsageMarker(options.usageMarker);
        }
      })();
      return closePromise;
    },
  });
}
function areSameAgentInput(left: AgentInputRecord, right: AgentInputRecord): boolean {
  return (
    left.messageId === right.messageId &&
    left.rootSessionId === right.rootSessionId &&
    left.fromSessionId === right.fromSessionId &&
    left.kind === right.kind &&
    left.content === right.content
  );
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
function createCoordinationRecord(
  sequence: number,
  parentEntryId: string | null,
  details: CoordinationDetails,
  runId?: string,
): CoordinationRecord {
  if (!isJsonValue(details.payload)) {
    throw new Error("Coordination payload 不是合法有限 JSON。");
  }
  const payload = snapshotJsonValue(details.payload);
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 256 * 1024) {
    throw new Error("Coordination payload 超过 256 KiB。");
  }
  return Object.freeze({
    type: "coordination",
    entryId: randomUUID(),
    seq: sequence,
    timestamp: new Date().toISOString(),
    parentEntryId,
    ...(runId === undefined ? {} : { runId }),
    kind: details.kind,
    key: details.key,
    payload,
  });
}

function createAgentInputRecord(
  sequence: number,
  parentEntryId: string | null,
  details: AgentInputDetails,
  runId?: string,
): AgentInputRecord {
  return Object.freeze({
    type: "agent_input",
    entryId: randomUUID(),
    seq: sequence,
    timestamp: new Date().toISOString(),
    parentEntryId,
    ...(runId === undefined ? {} : { runId }),
    messageId: details.messageId,
    rootSessionId: details.rootSessionId,
    fromSessionId: details.fromSessionId,
    kind: details.kind,
    content: details.content,
  });
}

function createCompactionRecord(
  sequence: number,
  parentEntryId: string | null,
  details: CompactionDetails,
  runId?: string,
): CompactionRecord {
  return Object.freeze({
    type: "compaction",
    entryId: randomUUID(),
    seq: sequence,
    timestamp: new Date().toISOString(),
    parentEntryId,
    ...(runId === undefined ? {} : { runId }),
    summary: details.summary,
    coversThroughEntryId: details.coversThroughEntryId,
    firstKeptEntryId: details.firstKeptEntryId,
    retainedUserEntryIds: Object.freeze([...details.retainedUserEntryIds]),
    usageBefore: snapshotUsage(details.usageBefore),
    inputTokenEstimateAfter: details.inputTokenEstimateAfter,
    modelId: details.modelId,
    contextVersion: details.contextVersion,
  });
}

function createRequestUsageRecord(
  sequence: number,
  parentEntryId: string | null,
  details: RequestUsageDetails,
  runId?: string,
): RequestUsageRecord {
  return Object.freeze({
    type: "request_usage",
    entryId: randomUUID(),
    seq: sequence,
    timestamp: new Date().toISOString(),
    parentEntryId,
    ...(runId === undefined ? {} : { runId }),
    purpose: details.purpose,
    requestEntryId: details.requestEntryId,
    contextVersion: details.contextVersion,
    usage: snapshotUsage(details.usage),
  });
}

function createApprovalDecisionRecord(
  sequence: number,
  parentEntryId: string | null,
  details: ApprovalDecisionDetails,
  runId?: string,
): ApprovalDecisionRecord {
  return Object.freeze({
    type: "approval_decision",
    entryId: randomUUID(),
    seq: sequence,
    timestamp: new Date().toISOString(),
    parentEntryId,
    ...(runId === undefined ? {} : { runId }),
    toolCallId: details.toolCallId,
    toolName: details.toolName,
    permissionMode: details.permissionMode,
    decisionSource: details.decisionSource,
    decision: details.decision,
    reason: details.reason,
    authorizationEntryIds: Object.freeze([...details.authorizationEntryIds]),
    ...(details.authorizationSessionId === undefined
      ? {}
      : { authorizationSessionId: details.authorizationSessionId }),
    ...(details.actionFingerprint === undefined
      ? {}
      : { actionFingerprint: details.actionFingerprint }),
    ...(details.toolApprovalRequestId === undefined
      ? {}
      : { toolApprovalRequestId: details.toolApprovalRequestId }),
  });
}

function snapshotUsage(
  usage: Readonly<{
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
    cacheWriteInputTokens?: number | null;
  }>,
): Readonly<{
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens?: number | null;
}> {
  return Object.freeze({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    ...(usage.cacheWriteInputTokens === undefined
      ? {}
      : { cacheWriteInputTokens: usage.cacheWriteInputTokens }),
  });
}

function createContextSourceRecord(
  seq: number,
  parentEntryId: string | null,
  details: ContextSourceDetails,
  runId?: string,
): ContextSourceRecord {
  return Object.freeze({
    type: "context_source",
    entryId: randomUUID(),
    seq,
    timestamp: new Date().toISOString(),
    parentEntryId,
    ...details,
    ...(runId === undefined ? {} : { runId }),
  });
}
