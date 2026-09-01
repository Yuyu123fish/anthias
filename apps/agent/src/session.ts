import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { AssistantMessage, Message, UserMessage } from "./agent.js";

/** 描述 Session 创建时固定、重开时必须一致的 Shell。 */
export type SessionShell = Readonly<{
  kind: "powershell" | "posix";
  executable: string;
  arguments: readonly string[];
}>;

/** 描述当前 Run 写入终态记录所需的已知计量。 */
export type RunFinishedDetails = Readonly<{
  status: "completed" | "aborted" | "failed";
  modelRequestCount: number;
  toolCallCount: number;
  activeDurationMilliseconds: number;
}>;

/** 提供线性 Session 的持久消息投影与串行追加行为。 */
export type Session = Readonly<{
  sessionId: string;
  workspaceRoot: string;
  shell: SessionShell;
  readonly messageHistory: readonly Message[];
  appendMessage(runId: string, message: Message): Promise<void>;
  appendRunFinished(runId: string, details: RunFinishedDetails): Promise<void>;
}>;

/** 配置一个新 Session 绑定的工作区、目录与固定 Shell。 */
export type CreateSessionOptions = Readonly<{
  workspaceRoot: string;
  sessionDirectory: string;
  shell: SessionShell;
}>;

/** 配置要在同一工作区中重新打开的 Session。 */
export type OpenSessionOptions = CreateSessionOptions &
  Readonly<{
    sessionId: string;
  }>;

/** 表示 Schema 1 JSONL 文件中唯一且无 seq 的首行。 */
type SessionHeader = Readonly<{
  type: "session_header";
  schemaVersion: 1;
  sessionId: string;
  createdAt: string;
  workspaceRoot: string;
  shell: SessionShell;
}>;

/** 表示 Stage 01 可持久化的完整文本消息。 */
type DurableMessage =
  | Readonly<{
      type: "user";
      content: readonly Readonly<{ type: "text"; text: string }>[];
    }>
  | Readonly<{
      type: "assistant";
      content: readonly Readonly<{ type: "text"; text: string }>[];
      status: "completed" | "aborted" | "failed";
    }>;

/** 将一条完整消息绑定到稳定的 Run 与线性 seq。 */
type MessageRecord = Readonly<{
  type: "message";
  entryId: string;
  seq: number;
  timestamp: string;
  runId: string;
  message: DurableMessage;
}>;

/** 记录 Run 的终态以及进程内能够确认的实际计量。 */
type RunFinishedRecord = Readonly<{
  type: "run_finished";
  entryId: string;
  seq: number;
  timestamp: string;
  runId: string;
  status: "completed" | "aborted" | "failed";
  modelRequestCount: number;
  toolCallCount: number;
  activeDurationMilliseconds: number;
}>;

/** 枚举 Stage 01 允许出现在 Header 之后的记录。 */
type SessionRecord = MessageRecord | RunFinishedRecord;

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 按平台约定解析 Agent Module 自有的 Session 目录。 */
export function resolveSessionDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const overrideDirectory = environment.ANTHIAS_SESSION_DIR?.trim();
  if (overrideDirectory) {
    return resolve(overrideDirectory);
  }
  if (platform === "win32") {
    const localApplicationDataDirectory = environment.LOCALAPPDATA?.trim();
    return localApplicationDataDirectory
      ? join(localApplicationDataDirectory, "Anthias", "sessions")
      : join(homedir(), ".anthias", "sessions");
  }
  const xdgStateHome = environment.XDG_STATE_HOME?.trim();
  return xdgStateHome
    ? join(xdgStateHome, "anthias", "sessions")
    : join(homedir(), ".local", "state", "anthias", "sessions");
}

/** 固定当前平台可复用的非交互 Shell；重开时必须与 Header 完全一致。 */
export async function resolveSessionShell(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<SessionShell> {
  if (platform === "win32") {
    return snapshotSessionShell({
      kind: "powershell",
      executable: "pwsh",
      arguments: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
    });
  }

  const configuredShell = environment.SHELL?.trim();
  if (configuredShell && isAbsolute(configuredShell)) {
    try {
      await access(configuredShell, constants.X_OK);
      return snapshotSessionShell({
        kind: "posix",
        executable: configuredShell,
        arguments: ["-lc"],
      });
    } catch {
      // 不可执行的 SHELL 不是稳定运行时，统一回退到 Schema 1 的 POSIX 默认值。
    }
  }
  return snapshotSessionShell({ kind: "posix", executable: "/bin/sh", arguments: ["-lc"] });
}

/** 创建一个绑定规范化工作区的线性 JSONL Session。 */
export async function createSession({
  workspaceRoot,
  sessionDirectory,
  shell,
}: CreateSessionOptions): Promise<Session> {
  const normalizedWorkspaceRoot = await realpath(workspaceRoot);
  const sessionId = randomUUID();
  const sessionShell = snapshotSessionShell(shell);
  const sessionHeader: SessionHeader = Object.freeze({
    type: "session_header",
    schemaVersion: 1,
    sessionId,
    createdAt: new Date().toISOString(),
    workspaceRoot: normalizedWorkspaceRoot,
    shell: sessionShell,
  });

  await mkdir(sessionDirectory, { recursive: true });
  const sessionFilePath = join(sessionDirectory, `${sessionId}.jsonl`);
  await writeNewSessionHeader(sessionFilePath, sessionHeader);
  return createSessionRuntime(
    sessionFilePath,
    sessionId,
    normalizedWorkspaceRoot,
    sessionShell,
    [],
    1,
  );
}

/** 打开一个完整的 Schema 1 文件，并从持久消息重建只读投影。 */
export async function openSession({
  sessionId,
  workspaceRoot,
  sessionDirectory,
  shell,
}: OpenSessionOptions): Promise<Session> {
  if (!UUID_V4_PATTERN.test(sessionId)) {
    throw new Error("Session ID 无效。");
  }
  const normalizedWorkspaceRoot = await realpath(workspaceRoot);
  const sessionFilePath = join(sessionDirectory, `${sessionId}.jsonl`);
  const sessionText = await readFile(sessionFilePath, "utf8");
  if (!sessionText.endsWith("\n")) {
    throw new Error("Session 文件不是完整的换行终止 JSONL。");
  }

  const lines = sessionText.slice(0, -1).split("\n");
  const sessionHeader = parseSessionHeader(lines[0]);
  if (sessionHeader.sessionId !== sessionId) {
    throw new Error("Session Header 与请求的 Session ID 不匹配。");
  }
  if (!areSameWorkspace(sessionHeader.workspaceRoot, normalizedWorkspaceRoot)) {
    throw new Error("Session workspace root 不匹配。");
  }
  const sessionShell = snapshotSessionShell(shell);
  if (!areSameShell(sessionHeader.shell, sessionShell)) {
    throw new Error("Session Shell 与当前固定 Shell 不匹配。");
  }
  const records = lines
    .slice(1)
    .map((line, recordIndex) => parseSessionRecord(line, recordIndex + 1));
  const messageHistory = records
    .filter((record): record is MessageRecord => record.type === "message")
    .map((record) => fromDurableMessage(record.message));

  return createSessionRuntime(
    sessionFilePath,
    sessionHeader.sessionId,
    normalizedWorkspaceRoot,
    sessionShell,
    messageHistory,
    records.length + 1,
  );
}

/** 从已验证的 Header 与记录投影组装 Session 运行时。 */
function createSessionRuntime(
  sessionFilePath: string,
  sessionId: string,
  workspaceRoot: string,
  shell: SessionShell,
  initialMessageHistory: readonly Message[],
  initialNextSequence: number,
): Session {
  const messageHistory = initialMessageHistory.map(snapshotMessage);
  let nextSequence = initialNextSequence;
  let appendQueue: Promise<void> = Promise.resolve();

  /** 串行追加一条完整记录，并只在刷新成功后推进内存投影。 */
  function enqueueRecord(
    createRecord: (sequence: number) => SessionRecord,
    afterAppend?: () => void,
  ): Promise<void> {
    const appendPromise = appendQueue.then(async () => {
      const record = createRecord(nextSequence);
      await appendJsonLine(sessionFilePath, record);
      nextSequence += 1;
      afterAppend?.();
    });
    // 单次失败交给当前 Run；队列本身恢复可用，避免后续记录永远跳过写入尝试。
    appendQueue = appendPromise.catch(() => undefined);
    return appendPromise;
  }

  return Object.freeze({
    sessionId,
    workspaceRoot,
    shell,
    get messageHistory() {
      return Object.freeze([...messageHistory]);
    },
    appendMessage(runId, message) {
      const messageSnapshot = snapshotMessage(message);
      return enqueueRecord(
        (sequence) =>
          Object.freeze({
            type: "message",
            entryId: randomUUID(),
            seq: sequence,
            timestamp: new Date().toISOString(),
            runId,
            message: toDurableMessage(messageSnapshot),
          }),
        () => messageHistory.push(messageSnapshot),
      );
    },
    appendRunFinished(runId, details) {
      return enqueueRecord((sequence) =>
        Object.freeze({
          type: "run_finished",
          entryId: randomUUID(),
          seq: sequence,
          timestamp: new Date().toISOString(),
          runId,
          status: details.status,
          modelRequestCount: details.modelRequestCount,
          toolCallCount: details.toolCallCount,
          activeDurationMilliseconds: details.activeDurationMilliseconds,
        }),
      );
    },
  });
}

/** 以独占创建方式写入并刷新一个新 Session Header。 */
async function writeNewSessionHeader(
  sessionFilePath: string,
  sessionHeader: SessionHeader,
): Promise<void> {
  const sessionFileHandle = await open(sessionFilePath, "wx");
  try {
    await sessionFileHandle.writeFile(`${JSON.stringify(sessionHeader)}\n`, "utf8");
    await sessionFileHandle.sync();
  } finally {
    await sessionFileHandle.close();
  }
}

/** 追加、刷新并关闭单条换行终止的 JSONL 记录。 */
async function appendJsonLine(sessionFilePath: string, record: SessionRecord): Promise<void> {
  const sessionFileHandle = await open(sessionFilePath, "a");
  try {
    await sessionFileHandle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await sessionFileHandle.sync();
  } finally {
    await sessionFileHandle.close();
  }
}

/** 将首行解析为经过 Schema 1 基本校验的 SessionHeader。 */
function parseSessionHeader(line: string | undefined): SessionHeader {
  const value = parseJsonObject(line);
  if (
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
function parseSessionRecord(line: string, expectedSequence: number): SessionRecord {
  const value = parseJsonObject(line);
  if (value.seq !== expectedSequence) {
    throw new Error("Session record seq 不连续。");
  }
  if (!isUuid(value.entryId) || !isUuid(value.runId) || !isUtcTimestamp(value.timestamp)) {
    throw new Error("Session record identity 无效。");
  }
  if (value.type === "message") {
    if (!isDurableMessage(value.message)) {
      throw new Error("Session MessageRecord 无效。");
    }
    return value as MessageRecord;
  }
  if (value.type === "run_finished") {
    if (
      !isRunTerminalStatus(value.status) ||
      !isNonNegativeInteger(value.modelRequestCount) ||
      !isNonNegativeInteger(value.toolCallCount) ||
      !isNonNegativeNumber(value.activeDurationMilliseconds)
    ) {
      throw new Error("Session RunFinishedRecord 无效。");
    }
    return value as RunFinishedRecord;
  }
  throw new Error("Session 包含未知记录类型。");
}

/** 将一行 JSON 收窄为对象，拒绝空文件与非对象值。 */
function parseJsonObject(line: string | undefined): Record<string, unknown> {
  if (line === undefined) {
    throw new Error("Session 文件为空。");
  }
  const value: unknown = JSON.parse(line);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Session 行必须是 JSON 对象。");
  }
  return value as Record<string, unknown>;
}

/** 将公开文本消息转换为不包含流式状态的持久形状。 */
function toDurableMessage(message: Message): DurableMessage {
  const content = Object.freeze([Object.freeze({ type: "text" as const, text: message.content })]);
  if (message.role === "user") {
    return Object.freeze({ type: "user", content });
  }
  if (message.status === "streaming") {
    throw new Error("Session 只能持久化最终 AssistantMessage。");
  }
  return Object.freeze({ type: "assistant", content, status: message.status });
}

/** 将持久消息恢复为 Agent 与 TUI 共用的消息投影。 */
function fromDurableMessage(message: DurableMessage): Message {
  const content = message.content.map((part) => part.text).join("");
  if (message.type === "user") {
    return Object.freeze({ role: "user", content } satisfies UserMessage);
  }
  return Object.freeze({
    role: "assistant",
    content,
    status: message.status,
  } satisfies AssistantMessage);
}

/** 复制并冻结消息，避免调用者修改 Session 内部投影。 */
function snapshotMessage(message: Message): Message {
  if (message.role === "user") {
    return Object.freeze({ role: "user", content: message.content });
  }
  return Object.freeze({
    role: "assistant",
    content: message.content,
    status: message.status,
  });
}

/** 复制并冻结 Shell 描述及其参数列表。 */
function snapshotSessionShell(shell: SessionShell): SessionShell {
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
    (shell.kind === "powershell" || shell.kind === "posix") &&
    typeof shell.executable === "string" &&
    Array.isArray(shell.arguments) &&
    shell.arguments.every((argument) => typeof argument === "string")
  );
}

/** 判断未知值是否为 Stage 01 支持的完整持久消息。 */
function isDurableMessage(value: unknown): value is DurableMessage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const message = value as Record<string, unknown>;
  if (!Array.isArray(message.content) || !message.content.every(isTextPart)) {
    return false;
  }
  if (message.type === "user") {
    return true;
  }
  return message.type === "assistant" && isRunTerminalStatus(message.status);
}

/** 判断未知值是否为完整文本 part。 */
function isTextPart(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const part = value as Record<string, unknown>;
  return part.type === "text" && typeof part.text === "string";
}

/** 判断未知值是否为 Stage 01 可产生的 Run 终态。 */
function isRunTerminalStatus(value: unknown): value is RunFinishedDetails["status"] {
  return value === "completed" || value === "aborted" || value === "failed";
}

/** 判断未知值是否为 Anthias 当前生成的 UUID v4。 */
function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

/** 判断未知值是否为规范 UTC ISO 8601 时间戳。 */
function isUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

/** 判断未知值是否为非负整数计量。 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** 判断未知值是否为有限非负数值。 */
function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** 比较当前 Shell 是否与 SessionHeader 中的固定描述完全一致。 */
function areSameShell(recordedShell: SessionShell, shell: SessionShell): boolean {
  return (
    recordedShell.kind === shell.kind &&
    recordedShell.executable === shell.executable &&
    recordedShell.arguments.length === shell.arguments.length &&
    recordedShell.arguments.every((argument, index) => argument === shell.arguments[index])
  );
}

/** 按当前平台规则比较两个已规范化工作区根目录。 */
function areSameWorkspace(recordedWorkspaceRoot: string, workspaceRoot: string): boolean {
  if (process.platform === "win32") {
    return (
      recordedWorkspaceRoot.toLocaleLowerCase("en-US") === workspaceRoot.toLocaleLowerCase("en-US")
    );
  }
  return recordedWorkspaceRoot === workspaceRoot;
}
