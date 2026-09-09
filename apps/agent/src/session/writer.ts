import { randomUUID } from "node:crypto";
import type { Message } from "../message.js";
import {
  appendJsonLine,
  readCompleteSessionJournal,
  readSessionCheckpoint,
  readSessionJournal,
  SessionChangedError,
  type SessionFileCheckpoint,
} from "./journal.js";
import {
  acquireSessionLock,
  releaseSessionLock,
  releaseSessionUsageMarker,
  SessionBusyError,
  type SessionLockOwnership,
  type SessionLockSystem,
  type SessionUsageMarkerOwnership,
} from "./lock.js";
import { upgradeSessionToSchema3 } from "./migration.js";
import { readOrRebuildResumeIndex } from "./resume-index.js";
import {
  type AgentInputDetails,
  type AgentInputRecord,
  type ApprovalDecisionDetails,
  type ApprovalDecisionRecord,
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
  type SessionRecord,
  snapshotJsonValue,
  type ToolExecutionStartedDetails,
  toDurableMessage,
  validateSessionRecords,
} from "./schema.js";

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

/** 返回独占 Run lease，或在开始 Run 的业务写入前拒绝请求。 */
export type SessionRunAcquisition =
  | Readonly<{ status: "acquired"; lease: SessionRunLease }>
  | Readonly<{ status: "rejected"; reason: "session_busy" | "session_changed" }>;

type RecordFactory = (sequence: number, parentEntryId: string | null) => SessionRecord;

type RunWriteState = {
  readonly runId: string;
  readonly lockOwnership: SessionLockOwnership;
  readonly releaseCompletionPromise: Promise<void>;
  readonly completeRelease: () => void;
  phase: "accepting" | "releasing";
  initialInputScheduled: boolean;
  finishScheduled: boolean;
  finishPersisted: boolean;
  appendFailure: unknown;
  appendTailPromise: Promise<void>;
};

/** 接管已验证日志的写入与使用标记；close 等待调用方释放 Run lease 后才释放标记。 */
export function createSessionWriter(
  options: Readonly<{
    sessionFilePath: string;
    storageDirectory: string;
    initialHeader: SessionHeader | Schema2SessionHeader;
    initialRecords: readonly SessionRecord[];
    initialCheckpoint: SessionFileCheckpoint;
    lockDirectory: string;
    lockSystem: SessionLockSystem;
    usageMarker: SessionUsageMarkerOwnership;
  }>,
): Readonly<{
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
}> {
  const sessionOwnership = getSessionOwnership(options.initialHeader);
  const messageHistory = options.initialRecords
    .filter((record): record is MessageRecord => record.type === "message")
    .map((record) => fromDurableMessage(record.message));
  let currentHeader = options.initialHeader;
  let records = [...options.initialRecords];
  let checkpoint = options.initialCheckpoint;
  let sessionChanged = false;
  let closed = false;
  let closePromise: Promise<void> | null = null;
  let activeRunWriter: RunWriteState | null = null;
  let sessionOperationTailPromise: Promise<void> = Promise.resolve();

  function acceptSessionOperation<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (closed) {
      return Promise.reject(new Error("Session 已关闭，不能追加持久事实。"));
    }
    // 入队只承诺处理次序；调用方仍须等待返回的 Promise，才能把持久事实用于后续副作用。
    const operationPromise = sessionOperationTailPromise.then(operation);
    sessionOperationTailPromise = operationPromise.then(
      () => undefined,
      () => undefined,
    );
    return operationPromise;
  }

  async function refreshAfterUsageOnlyAppend(): Promise<boolean> {
    const journal = await readSessionJournal(options.sessionFilePath).catch(() => null);
    if (
      journal === null ||
      journal.header.schemaVersion === 1 ||
      journal.header.sessionId !== currentHeader.sessionId ||
      JSON.stringify(journal.header) !== JSON.stringify(currentHeader)
    ) {
      sessionChanged = true;
      return false;
    }
    const diskRecords = journal.records;
    const knownPrefixIsUnchanged =
      records.length <= diskRecords.length &&
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
    checkpoint = refreshedCheckpoint;
    if (appendedRecords.length > 0) {
      records = [...diskRecords];
      await refreshResumeIndex().catch(() => undefined);
    }
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
      sessionId: currentHeader.sessionId,
      ...sessionOwnership,
    });
    checkpoint = await readSessionCheckpoint(options.sessionFilePath);
  }

  async function persistRecord(
    createRecord: RecordFactory,
    requiresSchema3 = false,
  ): Promise<SessionRecord | null> {
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
          return null;
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
    // appendJsonLine 完成写入、sync 和句柄关闭后，日志才成为事实；可重建索引失败不撤销它。
    await appendJsonLine(options.sessionFilePath, record);
    records.push(record);
    checkpoint = await readSessionCheckpoint(options.sessionFilePath);
    if (record.type === "message") {
      messageHistory.push(fromDurableMessage(record.message));
    }
    await refreshResumeIndex().catch(() => undefined);
    return record;
  }

  async function appendWithStandaloneLock(
    createRecord: RecordFactory,
    requiresSchema3 = false,
  ): Promise<void> {
    let lockOwnership: SessionLockOwnership;
    try {
      lockOwnership = await acquireSessionLock(options.lockDirectory, options.lockSystem);
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
      await persistRecord(createRecord, requiresSchema3);
    } finally {
      await releaseSessionLock(lockOwnership);
    }
  }

  function enqueueRunRecord(
    runWriter: RunWriteState,
    createRecord: RecordFactory,
    requiresSchema3 = false,
    acceptedBeforeClose = false,
  ): Promise<void> {
    if (runWriter.phase !== "accepting" || (closed && !acceptedBeforeClose)) {
      return Promise.reject(new Error("Session Run lease 已释放或 Session 已关闭。"));
    }
    if (runWriter.appendFailure !== null) {
      return Promise.reject(new Error("Session Run 先前的持久写入已经失败。"));
    }
    const appendPromise = runWriter.appendTailPromise.then(async () => {
      if (runWriter.appendFailure !== null) {
        throw new Error("Session Run 先前的持久写入已经失败。");
      }
      try {
        const persistedRecord = await persistRecord(createRecord, requiresSchema3);
        if (persistedRecord?.type === "run_finished") {
          runWriter.finishPersisted = true;
        }
      } catch (error) {
        // 持锁期间写入失败后不能继续沿用内存上下文；释放锁只收口资源，恢复由重新打开处理。
        runWriter.appendFailure = error;
        sessionChanged = true;
        throw error;
      }
    });
    runWriter.appendTailPromise = appendPromise.catch(() => undefined);
    return appendPromise;
  }

  async function appendUsingCurrentRunOrLock(
    appendToRun: (runWriter: RunWriteState) => Promise<void>,
    appendWithLock: () => Promise<void>,
  ): Promise<void> {
    const runWriter = activeRunWriter;
    if (runWriter?.phase === "releasing") {
      await runWriter.releaseCompletionPromise;
    } else if (runWriter !== null) {
      // 取得 lease 后立即入队，不能在 release 切断接受之后再用旧引用追加。
      return appendToRun(runWriter);
    }
    // Run 获取与此操作共用 Session 队列；等待旧锁释放期间不会有新的获取操作越过这里。
    return appendWithLock();
  }

  function appendCoordinationToRun(
    details: CoordinationDetails,
    runWriter: RunWriteState,
    acceptedBeforeClose = false,
  ): Promise<void> {
    const associatedRunId =
      runWriter.initialInputScheduled && !runWriter.finishScheduled ? runWriter.runId : undefined;
    return enqueueRunRecord(
      runWriter,
      (sequence, parentEntryId) =>
        createCoordinationRecord(sequence, parentEntryId, details, associatedRunId),
      true,
      acceptedBeforeClose,
    );
  }

  function appendAgentInputToRun(
    details: AgentInputDetails,
    runWriter: RunWriteState,
    acceptedBeforeClose = false,
  ): Promise<void> {
    if (!runWriter.finishScheduled) {
      runWriter.initialInputScheduled = true;
    }
    const associatedRunId = runWriter.finishScheduled ? undefined : runWriter.runId;
    return enqueueRunRecord(
      runWriter,
      (sequence, parentEntryId) =>
        createAgentInputRecord(sequence, parentEntryId, details, associatedRunId),
      true,
      acceptedBeforeClose,
    );
  }

  async function releaseRun(runWriter: RunWriteState): Promise<void> {
    if (runWriter.phase === "releasing") {
      return;
    }
    // 先停止接受，再等待所有已入队写入；封口记录刷盘成功也不等于锁已交还。
    runWriter.phase = "releasing";
    try {
      await runWriter.appendTailPromise;
      if (!runWriter.finishPersisted || runWriter.appendFailure !== null) {
        sessionChanged = true;
      }
    } finally {
      try {
        await releaseSessionLock(runWriter.lockOwnership);
      } finally {
        activeRunWriter = null;
        runWriter.completeRelease();
      }
    }
  }

  function createRunLease(runWriter: RunWriteState): SessionRunLease {
    const { runId } = runWriter;
    return Object.freeze({
      appendMessage(message) {
        const durableMessage = toDurableMessage(message);
        if (durableMessage.type === "user") {
          runWriter.initialInputScheduled = true;
        }
        return enqueueRunRecord(runWriter, (sequence, parentEntryId) =>
          Object.freeze({
            type: "message",
            entryId: randomUUID(),
            seq: sequence,
            timestamp: new Date().toISOString(),
            parentEntryId,
            runId,
            message: durableMessage,
          }),
        );
      },
      appendCoordination(details) {
        return appendCoordinationToRun(details, runWriter);
      },
      appendAgentInput(details) {
        return appendAgentInputToRun(details, runWriter);
      },
      appendToolExecutionStarted(details) {
        if (
          !isUuid(details.toolCallId) ||
          !isSideEffectToolName(details.toolName) ||
          !isUuid(details.toolApprovalRequestId)
        ) {
          return Promise.reject(new Error("ToolExecutionStarted 身份无效。"));
        }
        return enqueueRunRecord(runWriter, (sequence, parentEntryId) =>
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
        if (runWriter.finishScheduled) {
          return Promise.reject(new Error("Session Run 终态已经安排写入。"));
        }
        // 封口在接受终态时确定：随后协调或成员输入可以落盘，但不能再归入这个 Run。
        runWriter.finishScheduled = true;
        return enqueueRunRecord(runWriter, (sequence, parentEntryId) =>
          Object.freeze({
            type: "run_finished",
            entryId: randomUUID(),
            seq: sequence,
            timestamp: new Date().toISOString(),
            parentEntryId,
            runId,
            status: details.status,
            ...(details.diagnostic === undefined ? {} : { diagnostic: details.diagnostic }),
          }),
        );
      },
      appendContextSource(details) {
        return enqueueRunRecord(runWriter, (sequence, parentEntryId) =>
          createContextSourceRecord(sequence, parentEntryId, details, runId),
        );
      },
      appendCompaction(details) {
        return enqueueRunRecord(runWriter, (sequence, parentEntryId) =>
          createCompactionRecord(sequence, parentEntryId, details, runId),
        );
      },
      appendRequestUsage(details) {
        return enqueueRunRecord(runWriter, (sequence, parentEntryId) =>
          createRequestUsageRecord(sequence, parentEntryId, details, runId),
        );
      },
      appendApprovalDecision(details) {
        return enqueueRunRecord(runWriter, (sequence, parentEntryId) =>
          createApprovalDecisionRecord(sequence, parentEntryId, details, runId),
        );
      },
      release: () => releaseRun(runWriter),
    });
  }

  async function acquireRun(runId: string): Promise<SessionRunAcquisition> {
    if (!isUuid(runId)) {
      throw new Error("Run ID 无效。");
    }
    if (closed) {
      throw new Error("Session 已关闭，不能开始新的 Run。");
    }
    return acceptSessionOperation<SessionRunAcquisition>(async () => {
      if (activeRunWriter?.phase === "releasing") {
        await activeRunWriter.releaseCompletionPromise;
      }
      if (closed) {
        return Object.freeze({ status: "rejected", reason: "session_busy" });
      }
      if (sessionChanged) {
        return Object.freeze({ status: "rejected", reason: "session_changed" });
      }
      let lockOwnership: SessionLockOwnership | null = null;
      try {
        try {
          lockOwnership = await acquireSessionLock(options.lockDirectory, options.lockSystem);
        } catch (error) {
          if (error instanceof SessionBusyError) {
            return Object.freeze({ status: "rejected", reason: "session_busy" });
          }
          throw error;
        }
        if (closed || !(await refreshAfterUsageOnlyAppend())) {
          const rejectedOwnership = lockOwnership;
          lockOwnership = null;
          await releaseSessionLock(rejectedOwnership);
          return Object.freeze({
            status: "rejected",
            reason: closed ? "session_busy" : "session_changed",
          });
        }
        const releaseCompletion = Promise.withResolvers<void>();
        const runWriter: RunWriteState = {
          runId,
          lockOwnership,
          releaseCompletionPromise: releaseCompletion.promise,
          completeRelease: releaseCompletion.resolve,
          phase: "accepting",
          initialInputScheduled: false,
          finishScheduled: false,
          finishPersisted: false,
          appendFailure: null,
          appendTailPromise: Promise.resolve(),
        };
        const lease = createRunLease(runWriter);
        activeRunWriter = runWriter;
        lockOwnership = null;
        return Object.freeze({ status: "acquired", lease });
      } finally {
        if (lockOwnership !== null) {
          await releaseSessionLock(lockOwnership);
        }
      }
    });
  }

  return Object.freeze({
    get messageHistory() {
      return Object.freeze([...messageHistory]);
    },
    get records() {
      return Object.freeze([...records]);
    },
    acquireRun,
    appendContextSource(details) {
      return acceptSessionOperation(() =>
        appendWithStandaloneLock((sequence, parentEntryId) =>
          createContextSourceRecord(sequence, parentEntryId, details),
        ),
      );
    },
    appendCoordination(details) {
      return acceptSessionOperation(() =>
        appendUsingCurrentRunOrLock(
          (runWriter) => appendCoordinationToRun(details, runWriter, true),
          () =>
            appendWithStandaloneLock(
              (sequence, parentEntryId) =>
                createCoordinationRecord(sequence, parentEntryId, details),
              true,
            ),
        ),
      );
    },
    appendAgentInput(details) {
      return acceptSessionOperation(() =>
        appendUsingCurrentRunOrLock(
          (runWriter) => appendAgentInputToRun(details, runWriter, true),
          () =>
            appendWithStandaloneLock(
              (sequence, parentEntryId) => createAgentInputRecord(sequence, parentEntryId, details),
              true,
            ),
        ),
      );
    },
    appendCompaction(details) {
      return acceptSessionOperation(() =>
        appendWithStandaloneLock((sequence, parentEntryId) =>
          createCompactionRecord(sequence, parentEntryId, details),
        ),
      );
    },
    appendRequestUsage(details) {
      return acceptSessionOperation(() =>
        appendWithStandaloneLock((sequence, parentEntryId) =>
          createRequestUsageRecord(sequence, parentEntryId, details),
        ),
      );
    },
    appendApprovalDecision(details) {
      return acceptSessionOperation(() =>
        appendWithStandaloneLock((sequence, parentEntryId) =>
          createApprovalDecisionRecord(sequence, parentEntryId, details),
        ),
      );
    },
    close() {
      if (closePromise !== null) {
        return closePromise;
      }
      closed = true;
      closePromise = (async () => {
        try {
          // 同一队列已覆盖获取中的 Run 与关闭前接受的追加；lease 归还后才能撤掉使用标记。
          await sessionOperationTailPromise;
          await activeRunWriter?.releaseCompletionPromise;
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
