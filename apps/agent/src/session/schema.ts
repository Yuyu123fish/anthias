import type {
  AssistantContentPart,
  AssistantMessage,
  JsonValue,
  Message,
  ToolResultMessage,
  UserMessage,
} from "../message.js";

/** 描述 Session 创建时固定、重开时必须一致的 Shell。 */
export type SessionShell = Readonly<{
  kind: "powershell" | "posix";
  executable: string;
  arguments: readonly string[];
}>;

/** 描述当前 Run 写入终态记录所需的终态。 */
export type RunFinishedDetails = Readonly<{
  status: "completed" | "aborted" | "failed";
}>;

/** 描述一个已经批准、即将在本地发生副作用的 ToolCall。 */
export type ToolExecutionStartedDetails = Readonly<{
  toolCallId: string;
  toolName: "edit_file" | "write_file" | "execute_command";
  toolApprovalRequestId: string;
}>;

/** Schema 2 不可变首行。可变索引永远不回写到 Header。 */
export type SessionHeader = Readonly<{
  type: "session_header";
  schemaVersion: 2;
  sessionId: string;
  createdAt: string;
  workspaceRoot: string;
  shell: SessionShell;
}>;

/** Schema 1 仅作为一次显式迁移的输入。 */
export type LegacySessionHeader = Readonly<{
  type: "session_header";
  schemaVersion: 1;
  sessionId: string;
  createdAt: string;
  workspaceRoot: string;
  shell: SessionShell;
}>;

export type ParsedSessionHeader = SessionHeader | LegacySessionHeader;

/** 工具原文落盘后的可验证引用；不完整状态必须说明原因。 */
export type ToolArtifactReference = Readonly<{
  artifactId: string;
  toolCallId: string;
  byteLength: number;
  complete: boolean;
  incompleteReason?: ArtifactIncompleteReason;
}>;

export type ArtifactIncompleteReason =
  | "artifact_limit"
  | "session_limit"
  | "write_failed"
  | "source_failed"
  | "aborted"
  | "unknown";

/** 一次有效模型调用归一化后的用量；未知值保持 null，不伪装为零。 */
export type PersistedUsage = Readonly<{
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens?: number | null;
}>;

/** 后续 Context 写入成功压缩所需的已确认事实。 */
export type CompactionDetails = Readonly<{
  summary: string;
  coversThroughEntryId: string;
  firstKeptEntryId: string | null;
  retainedUserEntryIds: readonly string[];
  usageBefore: PersistedUsage;
  inputTokenEstimateAfter: number;
  modelId: string;
  contextVersion: string;
}>;

/** 后续 Model Context 可写入的校准用量事实。 */
export type RequestUsageDetails = Readonly<{
  purpose: "response" | "compaction" | "approval";
  requestEntryId: string | null;
  contextVersion: string;
  usage: PersistedUsage;
}>;

/** 后续审批模块可写入的可追溯决定事实。 */
export type ApprovalDecisionDetails = Readonly<{
  toolCallId: string;
  toolName: string;
  permissionMode: "agent" | "plan" | "auto_allow";
  decisionSource: "user" | "auto_review" | "policy";
  decision: "allowed" | "denied" | "needs_user";
  reason: string;
  authorizationEntryIds: readonly string[];
  actionFingerprint?: string;
  toolApprovalRequestId?: string;
}>;

/** 不能从消息、Run 或 Header 推导的真实使用活动。 */
export type SessionUseDetails = Readonly<{
  activity: "opened" | "browsed";
}>;

type DurableTextPart = Readonly<{
  type: "text";
  text: string;
}>;

type DurableToolCallPart = Readonly<{
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: JsonValue;
  invalid: boolean;
}>;

type DurableMessage =
  | Readonly<{
      type: "user";
      content: readonly DurableTextPart[];
    }>
  | Readonly<{
      type: "assistant";
      content: readonly (DurableTextPart | DurableToolCallPart)[];
      status: "completed" | "aborted" | "failed";
    }>
  | Readonly<{
      type: "tool_result";
      toolCallId: string;
      toolName: string;
      status: "completed" | "failed" | "denied" | "aborted" | "unknown";
      content: string;
      truncated: boolean;
      artifact?: ToolArtifactReference;
    }>;

type SessionEntryBase = Readonly<{
  entryId: string;
  seq: number;
  timestamp: string;
  parentEntryId: string | null;
}>;

/** 将一条完整消息绑定到稳定 Run 与线性父引用。 */
export type MessageRecord = SessionEntryBase &
  Readonly<{
    type: "message";
    runId: string;
    message: DurableMessage;
  }>;

type ToolExecutionStartedRecord = SessionEntryBase &
  Readonly<{
    type: "tool_execution_started";
    runId: string;
    toolCallId: string;
    toolName: string;
    toolApprovalRequestId: string;
  }>;

/** 记录 Run 的唯一终态。 */
export type RunFinishedRecord = SessionEntryBase &
  Readonly<{
    type: "run_finished";
    runId: string;
    status: "completed" | "aborted" | "failed" | "interrupted";
  }>;

export type SessionUseRecord = SessionEntryBase &
  Readonly<{
    type: "session_use";
    activity: SessionUseDetails["activity"];
  }>;

export type CompactionRecord = SessionEntryBase &
  Readonly<{
    type: "compaction";
    runId?: string;
    summary: string;
    coversThroughEntryId: string;
    firstKeptEntryId: string | null;
    retainedUserEntryIds: readonly string[];
    usageBefore: PersistedUsage;
    inputTokenEstimateAfter: number;
    modelId: string;
    contextVersion: string;
  }>;

export type RequestUsageRecord = SessionEntryBase &
  Readonly<{
    type: "request_usage";
    runId?: string;
    purpose: RequestUsageDetails["purpose"];
    requestEntryId: string | null;
    contextVersion: string;
    usage: PersistedUsage;
  }>;

export type ApprovalDecisionRecord = SessionEntryBase &
  Readonly<{
    type: "approval_decision";
    runId?: string;
    toolCallId: string;
    toolName: string;
    permissionMode: ApprovalDecisionDetails["permissionMode"];
    decisionSource: ApprovalDecisionDetails["decisionSource"];
    decision: ApprovalDecisionDetails["decision"];
    reason: string;
    authorizationEntryIds: readonly string[];
    actionFingerprint?: string;
    toolApprovalRequestId?: string;
  }>;

/** 枚举 Schema 2 允许出现在 Header 之后的持久记录。 */
export type SessionRecord =
  | MessageRecord
  | ToolExecutionStartedRecord
  | RunFinishedRecord
  | SessionUseRecord
  | CompactionRecord
  | RequestUsageRecord
  | ApprovalDecisionRecord;

/** Schema 1 记录保留原字段，迁移时才补齐 parentEntryId。 */
export type LegacySessionRecord =
  | Omit<MessageRecord, "parentEntryId">
  | Omit<ToolExecutionStartedRecord, "parentEntryId">
  | Omit<RunFinishedRecord, "parentEntryId">;

/** 汇总最后一个未终结 Run 中可由持久事实判定的 Tool 状态。 */
export type UnfinishedRun = Readonly<{
  runId: string;
  toolCalls: readonly Readonly<{
    toolCallId: string;
    toolName: string;
    started: boolean;
    resolved: boolean;
  }>[];
}>;

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 解析 Header，同时将 Schema 1 明确保留在迁移输入分支。 */
export function parseSessionHeader(line: string | undefined): ParsedSessionHeader {
  const value = parseJsonObject(line);
  if (
    !hasExactKeys(value, [
      "type",
      "schemaVersion",
      "sessionId",
      "createdAt",
      "workspaceRoot",
      "shell",
    ]) ||
    value.type !== "session_header" ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    !isUuid(value.sessionId) ||
    !isUtcTimestamp(value.createdAt) ||
    typeof value.workspaceRoot !== "string" ||
    !isSessionShell(value.shell)
  ) {
    throw new Error("Session Header 无效。");
  }
  return value as ParsedSessionHeader;
}
/** 解析 Schema 2 记录，并拒绝断裂的 seq、身份、父引用或未知字段。 */
export function parseSessionRecord(line: string, expectedSequence: number): SessionRecord {
  const value = parseJsonObject(line);
  if (!hasValidEntryIdentity(value, expectedSequence, true)) {
    throw new Error("Session record identity 无效。");
  }
  if (value.type === "message") {
    if (
      !hasExactKeys(value, [
        "type",
        "entryId",
        "seq",
        "timestamp",
        "parentEntryId",
        "runId",
        "message",
      ]) ||
      !isUuid(value.runId) ||
      !isDurableMessage(value.message)
    ) {
      throw new Error("Session MessageRecord 无效。");
    }
    return value as MessageRecord;
  }
  if (value.type === "tool_execution_started") {
    if (
      !hasExactKeys(value, [
        "type",
        "entryId",
        "seq",
        "timestamp",
        "parentEntryId",
        "runId",
        "toolCallId",
        "toolName",
        "toolApprovalRequestId",
      ]) ||
      !isUuid(value.runId) ||
      !isUuid(value.toolCallId) ||
      !isNonEmptyString(value.toolName) ||
      !isUuid(value.toolApprovalRequestId)
    ) {
      throw new Error("Session ToolExecutionStartedRecord 无效。");
    }
    return value as ToolExecutionStartedRecord;
  }
  if (value.type === "run_finished") {
    if (
      !hasExactKeys(value, [
        "type",
        "entryId",
        "seq",
        "timestamp",
        "parentEntryId",
        "runId",
        "status",
      ]) ||
      !isUuid(value.runId) ||
      !isRunFinishedStatus(value.status)
    ) {
      throw new Error("Session RunFinishedRecord 无效。");
    }
    return value as RunFinishedRecord;
  }
  if (value.type === "session_use") {
    if (
      !hasExactKeys(value, ["type", "entryId", "seq", "timestamp", "parentEntryId", "activity"]) ||
      !isSessionUseActivity(value.activity)
    ) {
      throw new Error("SessionUseRecord 无效。");
    }
    return value as SessionUseRecord;
  }
  if (value.type === "compaction") {
    if (
      !hasExactKeysWithOptionalRunId(value, [
        "type",
        "entryId",
        "seq",
        "timestamp",
        "parentEntryId",
        "summary",
        "coversThroughEntryId",
        "firstKeptEntryId",
        "retainedUserEntryIds",
        "usageBefore",
        "inputTokenEstimateAfter",
        "modelId",
        "contextVersion",
      ]) ||
      !(value.runId === undefined || isUuid(value.runId)) ||
      typeof value.summary !== "string" ||
      !isUuid(value.coversThroughEntryId) ||
      !(value.firstKeptEntryId === null || isUuid(value.firstKeptEntryId)) ||
      !isUuidArray(value.retainedUserEntryIds) ||
      !isPersistedUsage(value.usageBefore) ||
      !isNonNegativeSafeInteger(value.inputTokenEstimateAfter) ||
      !isNonEmptyString(value.modelId) ||
      !isNonEmptyString(value.contextVersion)
    ) {
      throw new Error("CompactionRecord 无效。");
    }
    return value as CompactionRecord;
  }
  if (value.type === "request_usage") {
    if (
      !hasExactKeysWithOptionalRunId(value, [
        "type",
        "entryId",
        "seq",
        "timestamp",
        "parentEntryId",
        "purpose",
        "requestEntryId",
        "contextVersion",
        "usage",
      ]) ||
      !(value.runId === undefined || isUuid(value.runId)) ||
      !isRequestUsagePurpose(value.purpose) ||
      !(value.requestEntryId === null || isUuid(value.requestEntryId)) ||
      !isNonEmptyString(value.contextVersion) ||
      !isPersistedUsage(value.usage)
    ) {
      throw new Error("RequestUsageRecord 无效。");
    }
    return value as RequestUsageRecord;
  }
  if (value.type === "approval_decision") {
    if (
      !hasExactKeysWithOptionalApprovalFields(value, [
        "type",
        "entryId",
        "seq",
        "timestamp",
        "parentEntryId",
        "toolCallId",
        "toolName",
        "permissionMode",
        "decisionSource",
        "decision",
        "reason",
        "authorizationEntryIds",
      ]) ||
      !(value.runId === undefined || isUuid(value.runId)) ||
      !(value.actionFingerprint === undefined || isActionFingerprint(value.actionFingerprint)) ||
      !(value.toolApprovalRequestId === undefined || isUuid(value.toolApprovalRequestId)) ||
      !isUuid(value.toolCallId) ||
      !isNonEmptyString(value.toolName) ||
      !isPermissionMode(value.permissionMode) ||
      !isDecisionSource(value.decisionSource) ||
      !isApprovalDecision(value.decision) ||
      typeof value.reason !== "string" ||
      !isUuidArray(value.authorizationEntryIds)
    ) {
      throw new Error("ApprovalDecisionRecord 无效。");
    }
    return value as ApprovalDecisionRecord;
  }
  throw new Error("Session 包含未知记录类型。");
}

/** 解析 Schema 1 记录；此函数只能由迁移路径使用。 */
export function parseLegacySessionRecord(
  line: string,
  expectedSequence: number,
): LegacySessionRecord {
  const value = parseJsonObject(line);
  if (!hasValidEntryIdentity(value, expectedSequence, false) || !isUuid(value.runId)) {
    throw new Error("Legacy Session record identity 无效。");
  }
  if (value.type === "message") {
    if (
      !hasExactKeys(value, ["type", "entryId", "seq", "timestamp", "runId", "message"]) ||
      !isDurableMessage(value.message)
    ) {
      throw new Error("Legacy Session MessageRecord 无效。");
    }
    return value as LegacySessionRecord;
  }
  if (value.type === "tool_execution_started") {
    if (
      !hasExactKeys(value, [
        "type",
        "entryId",
        "seq",
        "timestamp",
        "runId",
        "toolCallId",
        "toolName",
        "toolApprovalRequestId",
      ]) ||
      !isUuid(value.toolCallId) ||
      !isNonEmptyString(value.toolName) ||
      !isUuid(value.toolApprovalRequestId)
    ) {
      throw new Error("Legacy Session ToolExecutionStartedRecord 无效。");
    }
    return value as LegacySessionRecord;
  }
  if (
    value.type === "run_finished" &&
    hasExactKeys(value, ["type", "entryId", "seq", "timestamp", "runId", "status"]) &&
    isRunFinishedStatus(value.status)
  ) {
    return value as LegacySessionRecord;
  }
  throw new Error("Legacy Session 包含未知记录类型。");
}

/** 将 Schema 1 的已验证事实无损升级为线性父引用记录。 */
export function migrateLegacySessionRecords(
  legacyRecords: readonly LegacySessionRecord[],
): readonly SessionRecord[] {
  let parentEntryId: string | null = null;
  const migratedRecords = legacyRecords.map((legacyRecord) => {
    const migratedRecord = Object.freeze({ ...legacyRecord, parentEntryId }) as SessionRecord;
    parentEntryId = migratedRecord.entryId;
    return migratedRecord;
  });
  validateSessionRecords(migratedRecords);
  return Object.freeze(migratedRecords);
}
/** 以线性父引用和 Run 状态机校验全局身份、Tool 引用和唯一终态。 */
export function validateSessionRecords(records: readonly SessionRecord[]): UnfinishedRun | null {
  const entryIds = new Set<string>();

  const runIds = new Set<string>();
  const toolApprovalRequestIds = new Set<string>();
  const approvalDecisionsByToolCall = new Map<string, ApprovalDecisionRecord[]>();
  const previousRecordsByEntryId = new Map<string, SessionRecord>();
  const toolCalls = new Map<
    string,
    { runId: string; toolName: string; started: boolean; resolved: boolean }
  >();
  let expectedParentEntryId: string | null = null;
  let activeRunId: string | null = null;
  let activeRunToolCallIds: string[] = [];
  let lastAssistantStatus: "completed" | "aborted" | "failed" | null = null;
  let lastAssistantHasToolCall = false;

  for (const record of records) {
    if (entryIds.has(record.entryId) || record.parentEntryId !== expectedParentEntryId) {
      throw new Error("Session entryId 或 parentEntryId 无效。");
    }
    validateFactReferences(record, previousRecordsByEntryId, toolCalls);
    if (isRunAssociatedFact(record) && record.runId !== undefined && record.runId !== activeRunId) {
      throw new Error("Session 事实的 runId 不属于当前打开的 Run。");
    }
    entryIds.add(record.entryId);
    previousRecordsByEntryId.set(record.entryId, record);
    if (record.type === "approval_decision") {
      const decisions = approvalDecisionsByToolCall.get(record.toolCallId) ?? [];
      decisions.push(record);
      approvalDecisionsByToolCall.set(record.toolCallId, decisions);
    }
    expectedParentEntryId = record.entryId;

    if (!isRunRecord(record)) {
      continue;
    }
    if (activeRunId === null) {
      if (record.type !== "message" || record.message.type !== "user") {
        throw new Error("Session Run 必须由 UserMessage 开始。");
      }
      if (runIds.has(record.runId)) {
        throw new Error("Session runId 重复。");
      }
      runIds.add(record.runId);
      activeRunId = record.runId;
      activeRunToolCallIds = [];
      lastAssistantStatus = null;
      lastAssistantHasToolCall = false;
      continue;
    }
    if (record.runId !== activeRunId) {
      throw new Error("Session Run 不能交错。");
    }
    if (record.type === "message") {
      if (record.message.type === "user") {
        throw new Error("Session Run 只能包含一个起始 UserMessage。");
      }
      if (record.message.type === "assistant") {
        if (activeRunToolCallIds.some((toolCallId) => !toolCalls.get(toolCallId)?.resolved)) {
          throw new Error("Session AssistantMessage 不能越过未决 ToolCall。");
        }
        lastAssistantStatus = record.message.status;
        lastAssistantHasToolCall = record.message.content.some((part) => part.type === "tool_call");
        for (const part of record.message.content) {
          if (part.type !== "tool_call") {
            continue;
          }
          if (toolCalls.has(part.toolCallId)) {
            throw new Error("Session toolCallId 重复。");
          }
          toolCalls.set(part.toolCallId, {
            runId: record.runId,
            toolName: part.toolName,
            started: false,
            resolved: false,
          });
          activeRunToolCallIds.push(part.toolCallId);
        }
        continue;
      }
      const referencedToolCall = toolCalls.get(record.message.toolCallId);
      const firstUnresolvedToolCallId = activeRunToolCallIds.find(
        (toolCallId) => !toolCalls.get(toolCallId)?.resolved,
      );
      if (
        referencedToolCall === undefined ||
        referencedToolCall.runId !== record.runId ||
        referencedToolCall.toolName !== record.message.toolName ||
        referencedToolCall.resolved ||
        firstUnresolvedToolCallId !== record.message.toolCallId
      ) {
        throw new Error("Session ToolResult 引用无效或错序。");
      }
      referencedToolCall.resolved = true;
      continue;
    }
    if (record.type === "tool_execution_started") {
      validateToolExecutionApproval(
        record,
        approvalDecisionsByToolCall.get(record.toolCallId) ?? [],
      );
      const referencedToolCall = toolCalls.get(record.toolCallId);
      const firstUnresolvedToolCallId = activeRunToolCallIds.find(
        (toolCallId) => !toolCalls.get(toolCallId)?.resolved,
      );
      if (
        referencedToolCall === undefined ||
        referencedToolCall.runId !== record.runId ||
        referencedToolCall.toolName !== record.toolName ||
        referencedToolCall.started ||
        referencedToolCall.resolved ||
        firstUnresolvedToolCallId !== record.toolCallId ||
        toolApprovalRequestIds.has(record.toolApprovalRequestId)
      ) {
        throw new Error("Session ToolExecutionStarted 引用无效或重复。");
      }
      referencedToolCall.started = true;
      toolApprovalRequestIds.add(record.toolApprovalRequestId);
      continue;
    }
    if (activeRunToolCallIds.some((toolCallId) => !toolCalls.get(toolCallId)?.resolved)) {
      throw new Error("Session RunFinished 不能越过未决 ToolCall。");
    }
    if (
      record.status === "completed" &&
      (lastAssistantStatus === null || lastAssistantHasToolCall)
    ) {
      throw new Error("Session completed Run 缺少不含 ToolCall 的最终 AssistantMessage。");
    }
    const runCanEndAfterCompletedToolCalls =
      lastAssistantStatus === "completed" &&
      lastAssistantHasToolCall &&
      (record.status === "aborted" || record.status === "failed");
    if (
      record.status !== "interrupted" &&
      record.status !== lastAssistantStatus &&
      !runCanEndAfterCompletedToolCalls
    ) {
      throw new Error("Session RunFinished 与最终 AssistantMessage 状态不匹配。");
    }
    activeRunId = null;
  }

  if (activeRunId === null) {
    return null;
  }
  return Object.freeze({
    runId: activeRunId,
    toolCalls: Object.freeze(
      activeRunToolCallIds.map((toolCallId) => {
        const toolCall = toolCalls.get(toolCallId);
        if (toolCall === undefined) {
          throw new Error("Session ToolCall 状态缺失。");
        }
        return Object.freeze({ toolCallId, ...toolCall });
      }),
    ),
  });
}

/** 判断结构有效的 CompactionEntry 是否能作为恢复 checkpoint。 */
export function isValidCompactionRecord(
  record: CompactionRecord,
  previousRecordsByEntryId: ReadonlyMap<string, SessionRecord>,
): boolean {
  return (
    previousRecordsByEntryId.has(record.coversThroughEntryId) &&
    (record.firstKeptEntryId === null || previousRecordsByEntryId.has(record.firstKeptEntryId)) &&
    new Set(record.retainedUserEntryIds).size === record.retainedUserEntryIds.length &&
    record.retainedUserEntryIds.every((entryId) => {
      const retainedRecord = previousRecordsByEntryId.get(entryId);
      return retainedRecord?.type === "message" && retainedRecord.message.type === "user";
    })
  );
}

/** 从可验证使用事实推导清理使用的最后活动时间，不读取 mtime 或索引。 */
export function deriveLastActivityAt(
  header: ParsedSessionHeader,
  records: readonly SessionRecord[],
): string {
  let lastActivityAt = header.createdAt;
  for (const record of records) {
    if (
      record.type === "session_use" ||
      record.type === "message" ||
      record.type === "tool_execution_started" ||
      record.type === "run_finished"
    ) {
      if (record.timestamp > lastActivityAt) {
        lastActivityAt = record.timestamp;
      }
    }
  }
  return lastActivityAt;
}

/** 将一行 JSON 收窄为对象，拒绝空文件与非对象值。 */
export function parseJsonObject(line: string | undefined): Record<string, unknown> {
  if (line === undefined) {
    throw new Error("Session 文件为空。");
  }
  const value: unknown = JSON.parse(line);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Session 行必须是 JSON 对象。");
  }
  return value as Record<string, unknown>;
}

function validateFactReferences(
  record: SessionRecord,
  previousRecordsByEntryId: ReadonlyMap<string, SessionRecord>,
  previousToolCalls: ReadonlyMap<
    string,
    { runId: string; toolName: string; started: boolean; resolved: boolean }
  >,
): void {
  if (record.type === "compaction") {
    return;
  }
  if (
    record.type === "request_usage" &&
    record.requestEntryId !== null &&
    !previousRecordsByEntryId.has(record.requestEntryId)
  ) {
    throw new Error("RequestUsageRecord 引用无效。");
  }
  if (record.type === "approval_decision") {
    const toolCall = previousToolCalls.get(record.toolCallId);
    if (
      toolCall === undefined ||
      toolCall.toolName !== record.toolName ||
      new Set(record.authorizationEntryIds).size !== record.authorizationEntryIds.length ||
      record.authorizationEntryIds.some((entryId) => {
        const authorizationRecord = previousRecordsByEntryId.get(entryId);
        return (
          authorizationRecord === undefined || !isTrustedAuthorizationSource(authorizationRecord)
        );
      })
    ) {
      throw new Error("ApprovalDecisionRecord 授权引用无效。");
    }
  }
}
function isTrustedAuthorizationSource(record: SessionRecord): boolean {
  return (
    (record.type === "message" && record.message.type === "user") ||
    (record.type === "approval_decision" &&
      record.decisionSource === "user" &&
      record.decision === "allowed")
  );
}

function validateToolExecutionApproval(
  record: ToolExecutionStartedRecord,
  approvalDecisions: readonly ApprovalDecisionRecord[],
): void {
  const boundApprovalDecisions = approvalDecisions.filter(
    (approvalDecision) =>
      approvalDecision.actionFingerprint !== undefined ||
      approvalDecision.toolApprovalRequestId !== undefined,
  );
  if (boundApprovalDecisions.length === 0) {
    return;
  }
  if (
    !boundApprovalDecisions.some(
      (approvalDecision) =>
        approvalDecision.toolApprovalRequestId === record.toolApprovalRequestId &&
        approvalDecision.toolName === record.toolName &&
        approvalDecision.decision === "allowed",
    )
  ) {
    throw new Error("Session ToolExecutionStarted 缺少匹配的允许审批。");
  }
}

function isRunAssociatedFact(
  record: SessionRecord,
): record is CompactionRecord | RequestUsageRecord | ApprovalDecisionRecord {
  return (
    record.type === "compaction" ||
    record.type === "request_usage" ||
    record.type === "approval_decision"
  );
}

function isRunRecord(
  record: SessionRecord,
): record is MessageRecord | ToolExecutionStartedRecord | RunFinishedRecord {
  return (
    record.type === "message" ||
    record.type === "tool_execution_started" ||
    record.type === "run_finished"
  );
}
/** 将公开消息转换为不包含流式状态的 Schema 2 持久形状。 */
export function toDurableMessage(message: Message): DurableMessage {
  if (message.role === "user") {
    return Object.freeze({
      type: "user",
      content: Object.freeze([Object.freeze({ type: "text" as const, text: message.content })]),
    });
  }
  if (message.role === "tool") {
    const artifact = getToolResultArtifact(message);
    return Object.freeze({
      type: "tool_result",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      status: message.status,
      content: message.content,
      truncated: message.truncated,
      ...(artifact === undefined ? {} : { artifact: snapshotArtifactReference(artifact) }),
    });
  }
  if (message.status === "streaming") {
    throw new Error("Session 只能持久化最终 AssistantMessage。");
  }
  return Object.freeze({
    type: "assistant",
    content: Object.freeze(message.content.map(toDurableAssistantPart)),
    status: message.status,
  });
}

/** 将持久消息恢复为 Agent 与 TUI 共用的消息投影。 */
export function fromDurableMessage(message: DurableMessage): Message {
  if (message.type === "tool_result") {
    return Object.freeze({
      role: "tool",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      status: message.status,
      content: message.content,
      truncated: message.truncated,
      ...(message.artifact === undefined
        ? {}
        : { artifact: snapshotArtifactReference(message.artifact) }),
    } as ToolResultMessage);
  }
  if (message.type === "user") {
    return Object.freeze({
      role: "user",
      content: message.content.map((part) => part.text).join(""),
    } satisfies UserMessage);
  }
  return Object.freeze({
    role: "assistant",
    content: Object.freeze(message.content.map(fromDurableAssistantPart)),
    status: message.status,
  } satisfies AssistantMessage);
}

function toDurableAssistantPart(part: AssistantContentPart): DurableTextPart | DurableToolCallPart {
  if (part.type === "text") {
    return Object.freeze({ type: "text", text: part.text });
  }
  if (!isJsonValue(part.input)) {
    throw new Error("ToolCall 输入不是可持久化 JSON 值。");
  }
  return Object.freeze({
    type: "tool_call",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    input: snapshotJsonValue(part.input),
    invalid: part.invalid,
  });
}

function fromDurableAssistantPart(
  part: DurableTextPart | DurableToolCallPart,
): AssistantContentPart {
  return part.type === "text"
    ? Object.freeze({ type: "text", text: part.text })
    : Object.freeze({
        type: "tool_call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: snapshotJsonValue(part.input),
        invalid: part.invalid,
      });
}

function getToolResultArtifact(message: ToolResultMessage): ToolArtifactReference | undefined {
  const artifact = (message as ToolResultMessage & { artifact?: unknown }).artifact;
  if (artifact === undefined) {
    return undefined;
  }
  if (!isToolArtifactReference(artifact) || artifact.toolCallId !== message.toolCallId) {
    throw new Error("ToolResult artifact 引用无效。");
  }
  return artifact;
}

function snapshotArtifactReference(artifact: ToolArtifactReference): ToolArtifactReference {
  if (artifact.complete) {
    return Object.freeze({
      artifactId: artifact.artifactId,
      toolCallId: artifact.toolCallId,
      byteLength: artifact.byteLength,
      complete: true,
    });
  }
  if (artifact.incompleteReason === undefined) {
    throw new Error("ToolResult artifact 不完整时必须说明原因。");
  }
  return Object.freeze({
    artifactId: artifact.artifactId,
    toolCallId: artifact.toolCallId,
    byteLength: artifact.byteLength,
    complete: false,
    incompleteReason: artifact.incompleteReason,
  });
}
function hasExactKeysWithOptionalApprovalFields(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
): boolean {
  const optionalKeys = new Set(["runId", "actionFingerprint", "toolApprovalRequestId"]);
  return (
    requiredKeys.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => requiredKeys.includes(key) || optionalKeys.has(key))
  );
}

function hasExactKeysWithOptionalRunId(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
): boolean {
  return hasExactKeys(value, requiredKeys) || hasExactKeys(value, [...requiredKeys, "runId"]);
}

function hasValidEntryIdentity(
  value: Record<string, unknown>,
  expectedSequence: number,
  requiresParentEntryId: boolean,
): boolean {
  return (
    value.seq === expectedSequence &&
    isUuid(value.entryId) &&
    isUtcTimestamp(value.timestamp) &&
    (!requiresParentEntryId || value.parentEntryId === null || isUuid(value.parentEntryId))
  );
}

function isDurableMessage(value: unknown): value is DurableMessage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const message = value as Record<string, unknown>;
  if (message.type === "user") {
    return (
      hasExactKeys(message, ["type", "content"]) &&
      Array.isArray(message.content) &&
      message.content.every(isTextPart)
    );
  }
  if (message.type === "assistant") {
    return (
      hasExactKeys(message, ["type", "content", "status"]) &&
      Array.isArray(message.content) &&
      message.content.every((part) => isTextPart(part) || isToolCallPart(part)) &&
      isAssistantTerminalStatus(message.status)
    );
  }
  const allowedKeys = Object.hasOwn(message, "artifact")
    ? ["type", "toolCallId", "toolName", "status", "content", "truncated", "artifact"]
    : ["type", "toolCallId", "toolName", "status", "content", "truncated"];
  return (
    message.type === "tool_result" &&
    hasExactKeys(message, allowedKeys) &&
    isUuid(message.toolCallId) &&
    isNonEmptyString(message.toolName) &&
    isToolResultStatus(message.status) &&
    typeof message.content === "string" &&
    typeof message.truncated === "boolean" &&
    (message.artifact === undefined ||
      (isToolArtifactReference(message.artifact) &&
        message.artifact.toolCallId === message.toolCallId))
  );
}

function isToolArtifactReference(value: unknown): value is ToolArtifactReference {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const artifact = value as Record<string, unknown>;
  const expectedKeys =
    artifact.complete === true
      ? ["artifactId", "toolCallId", "byteLength", "complete"]
      : ["artifactId", "toolCallId", "byteLength", "complete", "incompleteReason"];
  return (
    hasExactKeys(artifact, expectedKeys) &&
    isUuid(artifact.artifactId) &&
    isUuid(artifact.toolCallId) &&
    isNonNegativeSafeInteger(artifact.byteLength) &&
    typeof artifact.complete === "boolean" &&
    (artifact.complete || isArtifactIncompleteReason(artifact.incompleteReason))
  );
}

function isTextPart(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const part = value as Record<string, unknown>;
  return (
    hasExactKeys(part, ["type", "text"]) && part.type === "text" && typeof part.text === "string"
  );
}

function isToolCallPart(value: unknown): value is DurableToolCallPart {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const part = value as Record<string, unknown>;
  return (
    hasExactKeys(part, ["type", "toolCallId", "toolName", "input", "invalid"]) &&
    part.type === "tool_call" &&
    isUuid(part.toolCallId) &&
    isNonEmptyString(part.toolName) &&
    isJsonValue(part.input) &&
    typeof part.invalid === "boolean"
  );
}
function isPersistedUsage(value: unknown): value is PersistedUsage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const usage = value as Record<string, unknown>;
  const expectedKeys = Object.hasOwn(usage, "cacheWriteInputTokens")
    ? ["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteInputTokens"]
    : ["inputTokens", "outputTokens", "cachedInputTokens"];
  return (
    hasExactKeys(usage, expectedKeys) &&
    [
      usage.inputTokens,
      usage.outputTokens,
      usage.cachedInputTokens,
      ...(Object.hasOwn(usage, "cacheWriteInputTokens") ? [usage.cacheWriteInputTokens] : []),
    ].every((tokenCount) => tokenCount === null || isNonNegativeSafeInteger(tokenCount))
  );
}

function isUuidArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isUuid);
}

function isSessionUseActivity(value: unknown): value is SessionUseDetails["activity"] {
  return value === "opened" || value === "browsed";
}

function isRequestUsagePurpose(value: unknown): value is RequestUsageDetails["purpose"] {
  return value === "response" || value === "compaction" || value === "approval";
}

function isPermissionMode(value: unknown): value is ApprovalDecisionDetails["permissionMode"] {
  return value === "agent" || value === "plan" || value === "auto_allow";
}

function isDecisionSource(value: unknown): value is ApprovalDecisionDetails["decisionSource"] {
  return value === "user" || value === "auto_review" || value === "policy";
}

function isApprovalDecision(value: unknown): value is ApprovalDecisionDetails["decision"] {
  return value === "allowed" || value === "denied" || value === "needs_user";
}

function isArtifactIncompleteReason(value: unknown): value is ArtifactIncompleteReason {
  return (
    value === "artifact_limit" ||
    value === "session_limit" ||
    value === "write_failed" ||
    value === "source_failed" ||
    value === "aborted" ||
    value === "unknown"
  );
}

function isToolResultStatus(value: unknown): boolean {
  return (
    value === "completed" ||
    value === "failed" ||
    value === "denied" ||
    value === "aborted" ||
    value === "unknown"
  );
}

/** 判断名称是否属于必须记录开始事实的副作用 Tool。 */
export function isSideEffectToolName(
  value: unknown,
): value is ToolExecutionStartedDetails["toolName"] {
  return value === "edit_file" || value === "write_file" || value === "execute_command";
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return (
    typeof value === "object" && Object.values(value as Record<string, unknown>).every(isJsonValue)
  );
}

function snapshotJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(snapshotJsonValue));
  }
  if (value !== null && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, snapshotJsonValue(item)]),
      ),
    );
  }
  return value;
}

/** 复制并冻结 Shell 描述及其参数列表。 */
export function snapshotSessionShell(shell: SessionShell): SessionShell {
  return Object.freeze({
    kind: shell.kind,
    executable: shell.executable,
    arguments: Object.freeze([...shell.arguments]),
  });
}

function isSessionShell(value: unknown): value is SessionShell {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const shell = value as Record<string, unknown>;
  return (
    hasExactKeys(shell, ["kind", "executable", "arguments"]) &&
    (shell.kind === "powershell" || shell.kind === "posix") &&
    isNonEmptyString(shell.executable) &&
    Array.isArray(shell.arguments) &&
    shell.arguments.every((argument) => typeof argument === "string")
  );
}

/** 判断对象是否恰好包含声明字段，拒绝缺失和 Schema 外扩展。 */
export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isAssistantTerminalStatus(value: unknown): value is RunFinishedDetails["status"] {
  return value === "completed" || value === "aborted" || value === "failed";
}

export function isRunFinishedStatus(value: unknown): value is RunFinishedRecord["status"] {
  return isAssistantTerminalStatus(value) || value === "interrupted";
}

/** 判断动作指纹是否为当前 SHA-256 小写十六进制形状。 */
function isActionFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

/** 判断未知值是否为 Anthias 当前生成的 UUID v4。 */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

/** 判断未知值是否为规范 UTC ISO 8601 时间戳。 */
export function isUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** 按当前平台规则比较两个已规范化工作区根目录。 */
export function areSameWorkspace(recordedWorkspaceRoot: string, workspaceRoot: string): boolean {
  if (process.platform === "win32") {
    return (
      recordedWorkspaceRoot.toLocaleLowerCase("en-US") === workspaceRoot.toLocaleLowerCase("en-US")
    );
  }
  return recordedWorkspaceRoot === workspaceRoot;
}

/** 比较当前 Shell 是否与 SessionHeader 中的固定描述完全一致。 */
export function areSameShell(recordedShell: SessionShell, shell: SessionShell): boolean {
  return (
    recordedShell.kind === shell.kind &&
    recordedShell.executable === shell.executable &&
    recordedShell.arguments.length === shell.arguments.length &&
    recordedShell.arguments.every((argument, index) => argument === shell.arguments[index])
  );
}
