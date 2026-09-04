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

/** 表示 Schema 1 JSONL 文件中唯一且无 seq 的首行。 */
export type SessionHeader = Readonly<{
  type: "session_header";
  schemaVersion: 1;
  sessionId: string;
  createdAt: string;
  workspaceRoot: string;
  shell: SessionShell;
}>;

/** 表示 AssistantMessage 中已经完成的文本 part。 */
type DurableTextPart = Readonly<{
  type: "text";
  text: string;
}>;

/** 表示 AssistantMessage 中一个已经收敛的 ToolCall part。 */
type DurableToolCallPart = Readonly<{
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: JsonValue;
  invalid: boolean;
}>;

/** 表示 Schema 1 可持久化的完整消息。 */
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
    }>;

/** 将一条完整消息绑定到稳定的 Run 与线性 seq。 */
export type MessageRecord = Readonly<{
  type: "message";
  entryId: string;
  seq: number;
  timestamp: string;
  runId: string;
  message: DurableMessage;
}>;

/** 证明经批准的副作用 Tool 已在本地效果发生前刷新开始事实。 */
type ToolExecutionStartedRecord = Readonly<{
  type: "tool_execution_started";
  entryId: string;
  seq: number;
  timestamp: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  toolApprovalRequestId: string;
}>;

/** 记录 Run 的唯一终态。 */
export type RunFinishedRecord = Readonly<{
  type: "run_finished";
  entryId: string;
  seq: number;
  timestamp: string;
  runId: string;
  status: "completed" | "aborted" | "failed" | "interrupted";
}>;

/** 枚举 Schema 1 允许出现在 Header 之后的持久记录。 */
export type SessionRecord = MessageRecord | ToolExecutionStartedRecord | RunFinishedRecord;

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

/** 将首行解析为经过 Schema 1 基本校验的 SessionHeader。 */
export function parseSessionHeader(line: string | undefined): SessionHeader {
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
    value.schemaVersion !== 1 ||
    !isUuid(value.sessionId) ||
    !isUtcTimestamp(value.createdAt) ||
    typeof value.workspaceRoot !== "string" ||
    !isSessionShell(value.shell)
  ) {
    throw new Error("Session Header 无效。");
  }
  return value as SessionHeader;
}

/** 解析一条记录，并拒绝断裂的 seq、身份或基本字段。 */
export function parseSessionRecord(line: string, expectedSequence: number): SessionRecord {
  const value = parseJsonObject(line);
  if (value.seq !== expectedSequence) {
    throw new Error("Session record seq 不连续。");
  }
  if (!isUuid(value.entryId) || !isUuid(value.runId) || !isUtcTimestamp(value.timestamp)) {
    throw new Error("Session record identity 无效。");
  }
  if (value.type === "message") {
    if (
      !hasExactKeys(value, ["type", "entryId", "seq", "timestamp", "runId", "message"]) ||
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
        "runId",
        "toolCallId",
        "toolName",
        "toolApprovalRequestId",
      ]) ||
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
      !hasExactKeys(value, ["type", "entryId", "seq", "timestamp", "runId", "status"]) ||
      !isRunFinishedStatus(value.status)
    ) {
      throw new Error("Session RunFinishedRecord 无效。");
    }
    return value as RunFinishedRecord;
  }
  throw new Error("Session 包含未知记录类型。");
}

/** 以线性 Run 状态机校验全局身份、Tool 引用和唯一终态。 */
export function validateSessionRecords(records: readonly SessionRecord[]): UnfinishedRun | null {
  const entryIds = new Set<string>();
  const runIds = new Set<string>();
  const toolApprovalRequestIds = new Set<string>();
  const toolCalls = new Map<
    string,
    { runId: string; toolName: string; started: boolean; resolved: boolean }
  >();
  let activeRunId: string | null = null;
  let activeRunToolCallIds: string[] = [];
  let lastAssistantStatus: "completed" | "aborted" | "failed" | null = null;
  let lastAssistantHasToolCall = false;

  for (const record of records) {
    if (entryIds.has(record.entryId)) {
      throw new Error("Session entryId 重复。");
    }
    entryIds.add(record.entryId);

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

/** 将公开消息转换为不包含流式状态的 Schema 1 持久形状。 */
export function toDurableMessage(message: Message): DurableMessage {
  if (message.role === "user") {
    return Object.freeze({
      type: "user",
      content: Object.freeze([Object.freeze({ type: "text" as const, text: message.content })]),
    });
  }
  if (message.role === "tool") {
    return Object.freeze({
      type: "tool_result",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      status: message.status,
      content: message.content,
      truncated: message.truncated,
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
    } satisfies ToolResultMessage);
  }
  if (message.type === "user") {
    const content = message.content.map((part) => part.text).join("");
    return Object.freeze({ role: "user", content } satisfies UserMessage);
  }
  return Object.freeze({
    role: "assistant",
    content: Object.freeze(message.content.map(fromDurableAssistantPart)),
    status: message.status,
  } satisfies AssistantMessage);
}

/** 将公开 Assistant part 转换为可持久化的 Schema 1 part。 */
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

/** 将持久 Assistant part 恢复为 Agent 消息 part。 */
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

/** 深复制并冻结一个已经验证的 JSON 值。 */
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

/** 判断未知值是否满足 SessionHeader 的 Shell 基本形状。 */
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

/** 判断未知值是否为 Schema 1 支持的完整持久消息。 */
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
  return (
    message.type === "tool_result" &&
    hasExactKeys(message, ["type", "toolCallId", "toolName", "status", "content", "truncated"]) &&
    isUuid(message.toolCallId) &&
    isNonEmptyString(message.toolName) &&
    isToolResultStatus(message.status) &&
    typeof message.content === "string" &&
    typeof message.truncated === "boolean"
  );
}

/** 判断未知值是否为完整文本 part。 */
function isTextPart(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const part = value as Record<string, unknown>;
  return (
    hasExactKeys(part, ["type", "text"]) && part.type === "text" && typeof part.text === "string"
  );
}

/** 判断未知值是否为带稳定身份的完整 ToolCall part。 */
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

/** 判断 ToolResult 是否使用 Schema 1 已确认的五种结果状态。 */
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

/** 判断未知值能否由 JSON 无损表示。 */
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
  if (typeof value !== "object") {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

/** 判断对象是否恰好包含声明字段，拒绝缺失和 Schema 外扩展。 */
export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** 判断未知值是否为非空字符串。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** 判断未知值是否为 AssistantMessage 的三个可持久终态。 */
function isAssistantTerminalStatus(value: unknown): value is RunFinishedDetails["status"] {
  return value === "completed" || value === "aborted" || value === "failed";
}

/** 判断未知值是否为可持久化的 Run 终态。 */
export function isRunFinishedStatus(value: unknown): value is RunFinishedRecord["status"] {
  return isAssistantTerminalStatus(value) || value === "interrupted";
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

/** 判断未知值是否为非负整数。 */
export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
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

/** 按当前平台规则比较两个已规范化工作区根目录。 */
export function areSameWorkspace(recordedWorkspaceRoot: string, workspaceRoot: string): boolean {
  if (process.platform === "win32") {
    return (
      recordedWorkspaceRoot.toLocaleLowerCase("en-US") === workspaceRoot.toLocaleLowerCase("en-US")
    );
  }
  return recordedWorkspaceRoot === workspaceRoot;
}
