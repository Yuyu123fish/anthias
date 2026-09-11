import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { CompletedMessage } from "../message.js";
import { isRecord } from "../tool/input-validation.js";
import {
  appendJsonLine,
  appendRecoveryRecords,
  assertSessionCheckpoint,
  discardSessionCandidate,
  ensureSessionGitignore,
  publishSessionJournal,
  readCompleteSessionJournal,
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
  assertSessionLockOwnership,
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
  upgradeSessionToSchema4,
} from "./migration.js";
import { readSessionHistory } from "./query.js";
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
  createSessionRecordValidator,
  getSessionOwnership,
  isJsonValue,
  isUuid,
  isValidCompactionRecord,
  type MessageRecord,
  parseSessionHeader,
  type RequestUsageDetails,
  type RequestUsageRecord,
  type RunFinishedDetails,
  type RunFinishedRecord,
  type SessionHeader,
  type SessionKind,
  type SessionRecord,
  type SessionShell,
  type SessionUseRecord,
  snapshotJsonValue,
  snapshotSessionShell,
  type ToolExecutionStartedDetails,
  type ToolExecutionStartedRecord,
  validateSessionRecord,
  validateSessionRecords,
} from "./schema.js";

export type { SessionLockSystem } from "./lock.js";
export { readSessionHistory, type SessionHistory } from "./query.js";
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

/** 提供已提交 Entry、压缩导航与独占写入生命周期。 */
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
    memberWorkspaceBinding?: Readonly<{ rootSessionId: string; workspaceRoot: string }>;
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
/** 创建完成后由 Session 持有执行写锁，空闲期也不交还。 */
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
    !["primary", "subagent", "teammate"].includes(sessionKind) ||
    (sessionKind === "primary") !== (resolvedRootSessionId === sessionId)
  )
    throw new InvalidSessionError("Session 成员身份无效。");
  const normalizedWorkspaceRoot = await realpath(workspaceRoot);
  const normalizedSessionDirectory = await prepareSessionDirectory(sessionDirectory);
  const header: SessionHeader = Object.freeze({
    type: "session_header",
    schemaVersion: 4,
    sessionId,
    rootSessionId: resolvedRootSessionId,
    sessionKind,
    createdAt: new Date().toISOString(),
    workspaceRoot: normalizedWorkspaceRoot,
    shell: snapshotSessionShell(shell),
    latestCompactionEntryId: null,
  });
  parseSessionHeader(JSON.stringify(header));
  const ownership = await acquireSessionLock(
    getSessionLockDirectory(normalizedSessionDirectory, sessionId),
    lockSystem,
  );
  let usageMarker: SessionUsageMarkerOwnership | null = null;
  try {
    const location = await createSessionStorageDirectory(normalizedSessionDirectory, header);
    const checkpoint = await writeNewSessionHeader(location.sessionFilePath, header);
    await writeSessionLocation(normalizedSessionDirectory, location).catch(() => undefined);
    usageMarker = await acquireSessionUsageMarker(
      normalizedSessionDirectory,
      sessionId,
      lockSystem,
    );
    return createSessionView(normalizedWorkspaceRoot, normalizedSessionDirectory, {
      sessionFilePath: location.sessionFilePath,
      storageDirectory: location.storageDirectory,
      initialHeader: header,
      initialRecords: [],
      initialCheckpoint: checkpoint,
      lockOwnership: ownership,
      usageMarker,
    });
  } catch (error) {
    await releaseFailedSessionOwnership(ownership, usageMarker);
    throw error;
  }
}

/** 执行打开完整校验并升级当前日志，随后持续持锁到 close。 */
export async function openSession({
  sessionId,
  workspaceRoot,
  sessionDirectory,
  shell,
  lockSystem = DEFAULT_SESSION_LOCK_SYSTEM,
  memberWorkspaceBinding,
}: OpenSessionOptions): Promise<Session> {
  if (!isUuid(sessionId)) throw new InvalidSessionError("Session ID 无效。");
  const normalizedWorkspaceRoot = await realpath(workspaceRoot);
  const normalizedSessionDirectory = await realpath(sessionDirectory);
  let location = await locateSessionStorage(normalizedSessionDirectory, sessionId);
  const ownership = await acquireSessionLock(
    getSessionLockDirectory(normalizedSessionDirectory, sessionId),
    lockSystem,
  );
  let usageMarker: SessionUsageMarkerOwnership | null = null;
  try {
    location = await locateSessionStorage(normalizedSessionDirectory, sessionId);
    if (location.source === "legacy") {
      location = (await migrateLegacySession(normalizedSessionDirectory, location)).location;
    } else {
      await completePublishedMigration(normalizedSessionDirectory, location);
      location = withoutLegacyFilePath(location);
    }
    await completeSessionSchemaUpgrade(location.storageDirectory);
    const journal = await readCompleteSessionJournal(location.sessionFilePath, {
      allowNavigationRepair: true,
    });
    if (journal.header.schemaVersion === 1 || journal.header.sessionId !== sessionId)
      throw new InvalidSessionError("Session Header 与请求的 Session ID 不匹配。");
    if (memberWorkspaceBinding) {
      const ownership = getSessionOwnership(journal.header);
      if (
        ownership.sessionKind === "primary" ||
        ownership.rootSessionId !== memberWorkspaceBinding.rootSessionId ||
        !areSameWorkspace(memberWorkspaceBinding.workspaceRoot, normalizedWorkspaceRoot)
      )
        throw new InvalidSessionError("受管成员工作区绑定身份不匹配。");
      const rootHistory = await readSessionHistory({
        sessionDirectory: normalizedSessionDirectory,
        sessionId: ownership.rootSessionId,
      });
      const binding = rootHistory.records.findLast(
        (record) =>
          record.type === "coordination" && record.kind === "member" && record.key === sessionId,
      );
      const payload = binding?.type === "coordination" ? binding.payload : null;
      if (
        !isRecord(payload) ||
        payload.sessionId !== sessionId ||
        typeof payload.workspaceRoot !== "string" ||
        !areSameWorkspace(payload.workspaceRoot, normalizedWorkspaceRoot)
      )
        throw new InvalidSessionError("根 Session 没有确认该成员的工作区绑定。");
    } else if (!areSameWorkspace(journal.header.workspaceRoot, normalizedWorkspaceRoot))
      throw new SessionWorkspaceMismatchError(
        journal.header.workspaceRoot,
        normalizedWorkspaceRoot,
      );
    if (!areSameShell(journal.header.shell, snapshotSessionShell(shell)))
      throw new SessionShellUnavailableError("Session Shell 与当前固定 Shell 不匹配。");
    const upgraded = await upgradeSessionToSchema4(location.sessionFilePath, journal);
    const records = [...upgraded.records];
    let checkpoint = upgraded.checkpoint;
    const unfinishedRun = validateSessionRecords(records, upgraded.header);
    if (unfinishedRun !== null)
      checkpoint = await appendRecoveryRecords(
        location.sessionFilePath,
        records,
        unfinishedRun,
        checkpoint,
      );
    await discardSessionCandidate(location.sessionFilePath);
    usageMarker = await acquireSessionUsageMarker(
      normalizedSessionDirectory,
      sessionId,
      lockSystem,
    );
    const useRecord: SessionUseRecord = Object.freeze({
      type: "session_use",
      entryId: randomUUID(),
      seq: (records.at(-1)?.seq ?? 0) + 1,
      timestamp: new Date().toISOString(),
      parentEntryId: records.at(-1)?.entryId ?? null,
      activity: "opened",
    });
    checkpoint = await appendJsonLine(location.sessionFilePath, useRecord, checkpoint);
    records.push(useRecord);
    return createSessionView(normalizedWorkspaceRoot, normalizedSessionDirectory, {
      sessionFilePath: location.sessionFilePath,
      storageDirectory: location.storageDirectory,
      initialHeader: upgraded.header,
      initialRecords: records,
      initialCheckpoint: checkpoint,
      lockOwnership: ownership,
      usageMarker,
    });
  } catch (error) {
    await releaseFailedSessionOwnership(ownership, usageMarker);
    throw error;
  }
}

async function releaseFailedSessionOwnership(
  ownership: SessionLockOwnership,
  usageMarker: SessionUsageMarkerOwnership | null,
): Promise<void> {
  try {
    if (usageMarker !== null) await releaseSessionUsageMarker(usageMarker);
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
    get header() {
      return sessionWriter.header;
    },
    get records() {
      return sessionWriter.records;
    },
    getEntry: sessionWriter.getEntry,
    appendMessage: sessionWriter.appendMessage,
    appendToolExecutionStarted: sessionWriter.appendToolExecutionStarted,
    appendRunFinished: sessionWriter.appendRunFinished,
    appendContextSource: sessionWriter.appendContextSource,
    appendCoordination: sessionWriter.appendCoordination,
    appendAgentInput: sessionWriter.appendAgentInput,
    appendCompaction: sessionWriter.appendCompaction,
    appendRequestUsage: sessionWriter.appendRequestUsage,
    appendApprovalDecision: sessionWriter.appendApprovalDecision,
    close: sessionWriter.close,
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

type RecordFactory<Entry extends SessionRecord> = (
  sequence: number,
  parentEntryId: string | null,
) => Entry;

/** Session 持有唯一 Entry 集合和串行提交队列，生命周期内不交还执行写锁。 */
function createSessionWriter(
  options: Readonly<{
    sessionFilePath: string;
    storageDirectory: string;
    initialHeader: SessionHeader;
    initialRecords: readonly SessionRecord[];
    initialCheckpoint: SessionFileCheckpoint;
    lockOwnership: SessionLockOwnership;
    usageMarker: SessionUsageMarkerOwnership;
  }>,
) {
  let currentHeader = snapshot(options.initialHeader);
  const records = options.initialRecords.map(snapshot);
  const recordsByEntryId = new Map(records.map((record) => [record.entryId, record]));
  const agentInputsByMessageId = new Map(
    records
      .filter((record): record is AgentInputRecord => record.type === "agent_input")
      .map((record) => [record.messageId, record]),
  );
  const validator = createSessionRecordValidator(currentHeader);
  for (const record of records) validator.append(record, { readingHistory: true });
  let checkpoint = options.initialCheckpoint;
  let changed = false;
  let closed = false;
  let closePromise: Promise<void> | null = null;
  let operationTailPromise: Promise<void> = Promise.resolve();

  function append<Entry extends SessionRecord>(factory: RecordFactory<Entry>): Promise<Entry> {
    if (closed) return Promise.reject(new Error("Session 已关闭，不能追加持久事实。"));
    if (changed)
      return Promise.reject(new SessionChangedError("Session 写入器已失效，必须关闭后重新打开。"));
    const operationPromise = operationTailPromise.then(async () => {
      if (changed) throw new SessionChangedError("Session 写入器已失效，必须关闭后重新打开。");
      try {
        await assertSessionLockOwnership(options.lockOwnership);
        await assertSessionCheckpoint(options.sessionFilePath, checkpoint);
        const rawRecord = factory((records.at(-1)?.seq ?? 0) + 1, records.at(-1)?.entryId ?? null);
        const record = snapshot(validateSessionRecord(rawRecord, rawRecord.seq, 4)) as Entry;
        if (record.type === "agent_input") {
          const existing = agentInputsByMessageId.get(record.messageId);
          if (existing !== undefined) {
            if (!areSameAgentInput(existing, record))
              throw new Error("AgentInputRecord messageId 已绑定其他内容。");
            return existing as Entry;
          }
        }
        if (record.type === "compaction" && !isValidCompactionRecord(record, recordsByEntryId))
          throw new Error("CompactionEntry 引用无效。");
        validator.append(record);
        let committedRecord: SessionRecord = record;
        if (record.type === "compaction") {
          const previous =
            currentHeader.latestCompactionEntryId === null
              ? undefined
              : recordsByEntryId.get(currentHeader.latestCompactionEntryId);
          if (previous !== undefined && previous.type !== "compaction")
            throw new Error("Session 压缩入口不是 CompactionEntry。");
          committedRecord = snapshot({
            ...record,
            previousCompactionEntryId: previous?.entryId ?? null,
            nextCompactionEntryId: null,
          });
          const updatedPrevious =
            previous === undefined
              ? undefined
              : snapshot({ ...previous, nextCompactionEntryId: committedRecord.entryId });
          const candidateRecords = records.map((entry) =>
            entry.entryId === previous?.entryId ? (updatedPrevious as CompactionRecord) : entry,
          );
          candidateRecords.push(committedRecord);
          const candidateHeader = snapshot({
            ...currentHeader,
            latestCompactionEntryId: committedRecord.entryId,
          });
          checkpoint = await publishSessionJournal(
            options.sessionFilePath,
            candidateHeader,
            candidateRecords,
            checkpoint,
          );
          if (updatedPrevious !== undefined) {
            records[updatedPrevious.seq - 1] = updatedPrevious;
            recordsByEntryId.set(updatedPrevious.entryId, updatedPrevious);
          }
          currentHeader = candidateHeader;
        } else {
          checkpoint = await appendJsonLine(options.sessionFilePath, record, checkpoint);
        }
        records.push(committedRecord);
        recordsByEntryId.set(committedRecord.entryId, committedRecord);
        if (committedRecord.type === "agent_input")
          agentInputsByMessageId.set(committedRecord.messageId, committedRecord);
        return committedRecord as Entry;
      } catch (error) {
        // 追加或身份检查失败后不能把旧 context 用于后续副作用；close 仍须排空并释放资源。
        changed = true;
        throw error;
      }
    });
    operationTailPromise = operationPromise.then(
      () => undefined,
      () => undefined,
    );
    return operationPromise;
  }

  function appendFact<Details, Entry extends SessionRecord>(
    runId: string | null,
    details: Details,
    factory: (
      sequence: number,
      parentEntryId: string | null,
      details: Details,
      runId?: string,
    ) => Entry,
  ): Promise<Entry> {
    if (runId !== null && !isUuid(runId)) return Promise.reject(new Error("Run ID 无效。"));
    const capturedDetails = snapshot(details);
    return append((sequence, parentEntryId) =>
      factory(sequence, parentEntryId, capturedDetails, runId ?? undefined),
    );
  }

  return Object.freeze({
    get header() {
      return currentHeader;
    },
    get records(): readonly SessionRecord[] {
      return Object.freeze([...records]);
    },
    getEntry(entryId: string): SessionRecord | undefined {
      return recordsByEntryId.get(entryId);
    },
    appendMessage(runId: string, message: CompletedMessage): Promise<MessageRecord> {
      const capturedMessage = snapshot(message);
      return append((seq, parentEntryId) => ({
        type: "message",
        entryId: randomUUID(),
        seq,
        timestamp: new Date().toISOString(),
        parentEntryId,
        runId,
        message: capturedMessage,
      }));
    },
    appendToolExecutionStarted(
      runId: string,
      details: ToolExecutionStartedDetails,
    ): Promise<ToolExecutionStartedRecord> {
      const capturedDetails = snapshot(details);
      return append((seq, parentEntryId) => ({
        type: "tool_execution_started",
        entryId: randomUUID(),
        seq,
        timestamp: new Date().toISOString(),
        parentEntryId,
        runId,
        ...capturedDetails,
      }));
    },
    appendRunFinished(runId: string, details: RunFinishedDetails): Promise<RunFinishedRecord> {
      const capturedDetails = snapshot(details);
      return append((seq, parentEntryId) => ({
        type: "run_finished",
        entryId: randomUUID(),
        seq,
        timestamp: new Date().toISOString(),
        parentEntryId,
        runId,
        ...capturedDetails,
      }));
    },
    appendContextSource: (runId: string | null, details: ContextSourceDetails) =>
      appendFact(runId, details, createContextSourceRecord),
    appendCoordination: (runId: string | null, details: CoordinationDetails) =>
      appendFact(runId, details, createCoordinationRecord),
    appendAgentInput: (runId: string | null, details: AgentInputDetails) =>
      appendFact(runId, details, createAgentInputRecord),
    appendCompaction: (runId: string | null, details: CompactionDetails) =>
      appendFact(runId, details, createCompactionRecord),
    appendRequestUsage: (runId: string | null, details: RequestUsageDetails) =>
      appendFact(runId, details, createRequestUsageRecord),
    appendApprovalDecision: (runId: string | null, details: ApprovalDecisionDetails) =>
      appendFact(runId, details, createApprovalDecisionRecord),
    close(): Promise<void> {
      if (closePromise !== null) return closePromise;
      closed = true;
      closePromise = (async () => {
        try {
          await operationTailPromise;
        } finally {
          try {
            await releaseSessionUsageMarker(options.usageMarker);
          } finally {
            await releaseSessionLock(options.lockOwnership);
          }
        }
      })();
      return closePromise;
    },
  });
}

function snapshot<Value>(value: Value): Value {
  const copy = structuredClone(value);
  function freeze(item: unknown): void {
    if (item === null || typeof item !== "object" || Object.isFrozen(item)) return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  }
  freeze(copy);
  return copy;
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
    previousCompactionEntryId: null,
    nextCompactionEntryId: null,
    entryId: randomUUID(),
    seq: sequence,
    timestamp: new Date().toISOString(),
    parentEntryId,
    ...(runId === undefined ? {} : { runId }),
    summary: details.summary,
    ...(details.projection ? { projection: structuredClone(details.projection) } : {}),
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
    reasoningTokens?: number | null;
    cachedInputTokens: number | null;
    cacheWriteInputTokens?: number | null;
  }>,
): Readonly<{
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens?: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens?: number | null;
}> {
  return Object.freeze({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
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
    sourceId: details.sourceId,
    kind: details.kind,
    label: details.label,
    fingerprint: details.fingerprint,
    content: details.content,
    ...(details.projection ? { projection: structuredClone(details.projection) } : {}),
    ...(runId === undefined ? {} : { runId }),
  });
}
