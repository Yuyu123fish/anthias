import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type {
  AssistantContentPart,
  AssistantMessage,
  Message,
  ToolResultMessage,
  UserMessage,
} from "./message.js";

/** 描述 Session 创建时固定、重开时必须一致的 Shell。 */
export type SessionShell = Readonly<{
  kind: "powershell" | "posix";
  executable: string;
  arguments: readonly string[];
}>;

/** 保存 Provider 能够准确报告的累计模型 token 用量。 */
export type RunModelUsageDetails = Readonly<{
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}>;

/** 描述正常终结 Run 能够在进程内准确计算的计量。 */
type CompleteRunMetricsDetails = Readonly<{
  modelRequestCount: number;
  toolCallCount: number;
  processedToolCallCount?: number;
  activeDurationMilliseconds: number;
  modelUsage?: RunModelUsageDetails;
}>;

/** 描述当前 Run 写入终态记录所需的终态与完整计量。 */
export type RunFinishedDetails =
  | (Readonly<{ status: "completed" | "aborted" | "failed" }> & CompleteRunMetricsDetails)
  | (Readonly<{
      status: "budget_exhausted";
      budgetKind: "model_requests" | "tool_calls" | "active_duration";
    }> &
      CompleteRunMetricsDetails);

/** 描述一个已经批准、即将在本地发生副作用的 ToolCall。 */
export type ToolExecutionStartedDetails = Readonly<{
  toolCallId: string;
  toolName: "edit_file" | "write_file" | "execute_command";
  toolApprovalRequestId: string;
}>;

/** 隔离锁实现中唯一需要替换的进程、身份与时钟系统边界。 */
export type SessionLockSystem = Readonly<{
  processId: number;
  createOwnerToken(): string;
  createTimestamp(): string;
  inspectProcess(processId: number): "alive" | "dead" | "unknown";
}>;

/** 持有单个已接受 Run 的 Session 锁与串行追加能力。 */
export type SessionRunLease = Readonly<{
  appendMessage(message: Message): Promise<void>;
  appendToolExecutionStarted(details: ToolExecutionStartedDetails): Promise<void>;
  appendRunFinished(details: RunFinishedDetails): Promise<void>;
  release(): Promise<void>;
}>;

/** 表示 Run 已取得独占 lease，或在任何副作用前被 Session 拒绝。 */
export type SessionRunAcquisition =
  | Readonly<{ status: "acquired"; lease: SessionRunLease }>
  | Readonly<{ status: "rejected"; reason: "session_busy" | "session_changed" }>;

/** 提供线性 Session 的持久消息投影与串行追加行为。 */
export type Session = Readonly<{
  sessionId: string;
  workspaceRoot: string;
  sessionDirectory: string;
  shell: SessionShell;
  readonly messageHistory: readonly Message[];
  acquireRun(runId: string): Promise<SessionRunAcquisition>;
}>;

/** 配置一个新 Session 绑定的工作区、目录与固定 Shell。 */
export type CreateSessionOptions = Readonly<{
  workspaceRoot: string;
  sessionDirectory: string;
  shell: SessionShell;
  lockSystem?: SessionLockSystem;
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

/** 表示 Schema 1 可以无损保存的 JSON 值。 */
type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

/** 表示 Schema 1 可以无损保存的 JSON 对象。 */
type JsonObject = Readonly<{ [key: string]: JsonValue }>;

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
type MessageRecord = Readonly<{
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

/** 记录 Run 的终态以及进程内能够确认的实际计量。 */
type RunFinishedRecord =
  | Readonly<{
      type: "run_finished";
      entryId: string;
      seq: number;
      timestamp: string;
      runId: string;
      status: "completed" | "aborted" | "failed";
      metricsStatus: "complete";
      modelRequestCount: number;
      toolCallCount: number;
      processedToolCallCount: number;
      activeDurationMilliseconds: number;
      modelUsage: RunModelUsageDetails;
    }>
  | Readonly<{
      type: "run_finished";
      entryId: string;
      seq: number;
      timestamp: string;
      runId: string;
      status: "budget_exhausted";
      metricsStatus: "complete";
      modelRequestCount: number;
      toolCallCount: number;
      processedToolCallCount: number;
      activeDurationMilliseconds: number;
      modelUsage: RunModelUsageDetails;
      budgetKind: "model_requests" | "tool_calls" | "active_duration";
    }>
  | Readonly<{
      type: "run_finished";
      entryId: string;
      seq: number;
      timestamp: string;
      runId: string;
      status: "interrupted";
      metricsStatus: "incomplete";
      modelRequestCount: null;
      toolCallCount: number;
      activeDurationMilliseconds: null;
    }>;

/** 枚举 Schema 1 允许出现在 Header 之后的持久记录。 */
type SessionRecord = MessageRecord | ToolExecutionStartedRecord | RunFinishedRecord;

/** 汇总最后一个未终结 Run 中可由持久事实判定的 Tool 状态。 */
type UnfinishedRun = Readonly<{
  runId: string;
  toolCalls: readonly Readonly<{
    toolCallId: string;
    toolName: string;
    started: boolean;
    resolved: boolean;
  }>[];
}>;

/** 保存内存投影对应的文件大小与最后一个线性 seq。 */
type SessionFileCheckpoint = Readonly<{
  fileSize: number;
  lastSequence: number;
}>;

/** 保存一次原子目录锁的释放凭据。 */
type SessionLockOwnership = Readonly<{
  lockDirectory: string;
  ownerToken: string;
}>;

/** 表示锁目录中经过严格校验的所有者元数据。 */
type SessionLockOwner = Readonly<{
  pid: number;
  ownerToken: string;
  acquiredAt: string;
}>;

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNKNOWN_MODEL_USAGE = Object.freeze({
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
} satisfies RunModelUsageDetails);

/** 提供生产环境真实进程探测、UUID 与 UTC 时间。 */
const DEFAULT_SESSION_LOCK_SYSTEM: SessionLockSystem = Object.freeze({
  processId: process.pid,
  createOwnerToken: randomUUID,
  createTimestamp: () => new Date().toISOString(),
  inspectProcess(processId) {
    try {
      process.kill(processId, 0);
      return "alive";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
    }
  },
});

/** 区分可安全展示的 Session 正忙与其他存储错误。 */
class SessionBusyError extends Error {}

/** 按平台约定解析 Agent Module 自有的 Session 目录。 */
export function resolveSessionDirectory(
  workspaceRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const overrideDirectory = environment.ANTHIAS_SESSION_DIR?.trim();
  if (overrideDirectory) {
    return resolve(overrideDirectory);
  }
  return join(resolve(workspaceRoot), "data", "conversation");
}

/** 固定当前平台可复用的非交互 Shell；重开时必须与 Header 完全一致。 */
export async function resolveSessionShell(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<SessionShell> {
  if (platform === "win32") {
    const powerShellExecutable = await resolveExecutableFromPath("pwsh.exe", environment, ";");
    if (powerShellExecutable === null) {
      throw new Error("当前平台没有可用的 pwsh executable。");
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
      // 不可执行的 SHELL 不是稳定运行时，统一回退到 Schema 1 的 POSIX 默认值。
    }
  }
  await access("/bin/sh", constants.X_OK);
  return snapshotSessionShell({
    kind: "posix",
    executable: await realpath("/bin/sh"),
    arguments: ["-lc"],
  });
}

/** 在显式环境 PATH 中解析一个真实存在的可执行文件。 */
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
    const candidatePath = join(directory, executableName);
    try {
      await access(candidatePath, constants.X_OK);
      return await realpath(candidatePath);
    } catch {
      // PATH 中不可访问的候选项不是稳定的 Session Shell，继续检查下一项。
    }
  }
  return null;
}

/** 创建一个绑定规范化工作区的线性 JSONL Session。 */
export async function createSession({
  workspaceRoot,
  sessionDirectory,
  shell,
  lockSystem = DEFAULT_SESSION_LOCK_SYSTEM,
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
  await ensureSessionGitignore(sessionDirectory);
  const normalizedSessionDirectory = await realpath(sessionDirectory);
  const sessionFilePath = join(normalizedSessionDirectory, `${sessionId}.jsonl`);
  await writeNewSessionHeader(sessionFilePath, sessionHeader);
  const checkpoint = await readSessionCheckpoint(sessionFilePath);
  return createSessionRuntime(
    sessionFilePath,
    sessionId,
    normalizedWorkspaceRoot,
    normalizedSessionDirectory,
    sessionShell,
    [],
    checkpoint,
    join(normalizedSessionDirectory, `${sessionId}.lock`),
    lockSystem,
  );
}

/** 创建 Agent 自有目录的本地忽略规则，并拒绝覆盖不一致的已有文件。 */
async function ensureSessionGitignore(sessionDirectory: string): Promise<void> {
  const gitignorePath = join(sessionDirectory, ".gitignore");
  let gitignoreHandle: Awaited<ReturnType<typeof open>>;
  try {
    gitignoreHandle = await open(gitignorePath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const existingContent = await readFile(gitignorePath, "utf8");
    if (existingContent !== "*" && existingContent !== "*\n") {
      throw new Error("Session 目录 .gitignore 内容不符合 Anthias 约定。");
    }
    return;
  }
  try {
    await gitignoreHandle.writeFile("*\n", "utf8");
    await gitignoreHandle.sync();
  } finally {
    await gitignoreHandle.close();
  }
}

/** 打开一个完整的 Schema 1 文件，并从持久消息重建只读投影。 */
export async function openSession({
  sessionId,
  workspaceRoot,
  sessionDirectory,
  shell,
  lockSystem = DEFAULT_SESSION_LOCK_SYSTEM,
}: OpenSessionOptions): Promise<Session> {
  if (!UUID_V4_PATTERN.test(sessionId)) {
    throw new Error("Session ID 无效。");
  }
  const normalizedWorkspaceRoot = await realpath(workspaceRoot);
  const normalizedSessionDirectory = await realpath(sessionDirectory);
  const sessionFilePath = join(normalizedSessionDirectory, `${sessionId}.jsonl`);
  const lockDirectory = join(normalizedSessionDirectory, `${sessionId}.lock`);
  const startupLock = await acquireSessionLock(lockDirectory, lockSystem);
  let sessionText: string;
  let sessionHeader: SessionHeader;
  let records: SessionRecord[];
  let checkpoint: SessionFileCheckpoint;
  try {
    sessionText = await readCompleteSessionText(sessionFilePath);

    const lines = sessionText.slice(0, -1).split("\n");
    sessionHeader = parseSessionHeader(lines[0]);
    if (sessionHeader.sessionId !== sessionId) {
      throw new Error("Session Header 与请求的 Session ID 不匹配。");
    }
    if (!areSameWorkspace(sessionHeader.workspaceRoot, normalizedWorkspaceRoot)) {
      throw new Error("Session workspace root 不匹配。");
    }
    const requestedShell = snapshotSessionShell(shell);
    if (!areSameShell(sessionHeader.shell, requestedShell)) {
      throw new Error("Session Shell 与当前固定 Shell 不匹配。");
    }
    records = lines.slice(1).map((line, recordIndex) => parseSessionRecord(line, recordIndex + 1));
    const unfinishedRun = validateSessionRecords(records);
    if (unfinishedRun !== null) {
      await appendRecoveryRecords(sessionFilePath, records, unfinishedRun);
    }
    checkpoint = await readSessionCheckpoint(sessionFilePath);
  } finally {
    await releaseSessionLock(startupLock);
  }

  const messageHistory = records
    .filter((record): record is MessageRecord => record.type === "message")
    .map((record) => fromDurableMessage(record.message));

  return createSessionRuntime(
    sessionFilePath,
    sessionHeader.sessionId,
    normalizedWorkspaceRoot,
    normalizedSessionDirectory,
    sessionHeader.shell,
    messageHistory,
    checkpoint,
    lockDirectory,
    lockSystem,
  );
}

/** 从已验证的 Header 与记录投影组装 Session 运行时。 */
function createSessionRuntime(
  sessionFilePath: string,
  sessionId: string,
  workspaceRoot: string,
  sessionDirectory: string,
  shell: SessionShell,
  initialMessageHistory: readonly Message[],
  initialCheckpoint: SessionFileCheckpoint,
  lockDirectory: string,
  lockSystem: SessionLockSystem,
): Session {
  const messageHistory = initialMessageHistory.map(snapshotMessage);
  let checkpoint = initialCheckpoint;
  let sessionChanged = false;

  return Object.freeze({
    sessionId,
    workspaceRoot,
    sessionDirectory,
    shell,
    get messageHistory() {
      return Object.freeze([...messageHistory]);
    },
    async acquireRun(runId) {
      if (!isUuid(runId)) {
        throw new Error("Run ID 无效。");
      }
      if (sessionChanged) {
        return Object.freeze({ status: "rejected", reason: "session_changed" });
      }

      let ownership: SessionLockOwnership;
      try {
        ownership = await acquireSessionLock(lockDirectory, lockSystem);
      } catch (error) {
        if (error instanceof SessionBusyError) {
          return Object.freeze({ status: "rejected", reason: "session_busy" });
        }
        throw error;
      }

      const actualCheckpoint = await readSessionCheckpoint(sessionFilePath).catch(() => null);
      if (actualCheckpoint === null || !areSameCheckpoint(checkpoint, actualCheckpoint)) {
        sessionChanged = true;
        await releaseSessionLock(ownership);
        return Object.freeze({ status: "rejected", reason: "session_changed" });
      }

      let nextSequence = checkpoint.lastSequence + 1;
      let appendQueue: Promise<void> = Promise.resolve();
      let released = false;
      let runFinished = false;

      /** 串行刷新一条记录，并在成功后推进内存检查点。 */
      function enqueueRecord(
        createRecord: (sequence: number) => SessionRecord,
        afterAppend?: () => void,
      ): Promise<void> {
        if (released) {
          return Promise.reject(new Error("Session Run lease 已释放。"));
        }
        const appendPromise = appendQueue.then(async () => {
          const record = createRecord(nextSequence);
          await appendJsonLine(sessionFilePath, record);
          nextSequence += 1;
          checkpoint = await readSessionCheckpoint(sessionFilePath);
          afterAppend?.();
        });
        appendQueue = appendPromise.catch(() => undefined);
        return appendPromise;
      }

      const lease: SessionRunLease = Object.freeze({
        appendMessage(message) {
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
        appendToolExecutionStarted(details) {
          if (
            !isUuid(details.toolCallId) ||
            !isSideEffectToolName(details.toolName) ||
            !isUuid(details.toolApprovalRequestId)
          ) {
            return Promise.reject(new Error("ToolExecutionStarted 身份无效。"));
          }
          return enqueueRecord((sequence) =>
            Object.freeze({
              type: "tool_execution_started",
              entryId: randomUUID(),
              seq: sequence,
              timestamp: new Date().toISOString(),
              runId,
              toolCallId: details.toolCallId,
              toolName: details.toolName,
              toolApprovalRequestId: details.toolApprovalRequestId,
            }),
          );
        },
        appendRunFinished(details) {
          const processedToolCallCount = details.processedToolCallCount ?? details.toolCallCount;
          const modelUsage = details.modelUsage ?? UNKNOWN_MODEL_USAGE;
          if (
            !isRunFinishedTerminalStatus(details.status) ||
            !isNonNegativeInteger(details.modelRequestCount) ||
            !isNonNegativeInteger(details.toolCallCount) ||
            !isNonNegativeInteger(processedToolCallCount) ||
            processedToolCallCount > details.toolCallCount ||
            !isNonNegativeInteger(details.activeDurationMilliseconds) ||
            !isRunModelUsage(modelUsage) ||
            (details.status === "budget_exhausted" && !isBudgetKind(details.budgetKind))
          ) {
            return Promise.reject(new Error("RunFinished 计量无效。"));
          }
          return enqueueRecord(
            (sequence) => {
              const baseRecord = {
                type: "run_finished",
                entryId: randomUUID(),
                seq: sequence,
                timestamp: new Date().toISOString(),
                runId,
                status: details.status,
                metricsStatus: "complete",
                modelRequestCount: details.modelRequestCount,
                toolCallCount: details.toolCallCount,
                processedToolCallCount,
                activeDurationMilliseconds: details.activeDurationMilliseconds,
                modelUsage: Object.freeze({ ...modelUsage }),
              } as const;
              return Object.freeze(
                details.status === "budget_exhausted"
                  ? { ...baseRecord, budgetKind: details.budgetKind }
                  : baseRecord,
              ) as RunFinishedRecord;
            },
            () => {
              runFinished = true;
            },
          );
        },
        async release() {
          if (released) {
            return;
          }
          released = true;
          await appendQueue;
          if (!runFinished && checkpoint.lastSequence >= nextSequence - 1) {
            sessionChanged = true;
          }
          await releaseSessionLock(ownership);
        },
      });
      return Object.freeze({ status: "acquired", lease });
    },
  });
}

/** 读取当前文件大小与最后 seq，作为下一次 Run 的并发检查点。 */
async function readSessionCheckpoint(sessionFilePath: string): Promise<SessionFileCheckpoint> {
  const fileStatsBeforeRead = await stat(sessionFilePath);
  const sessionBytes = await readFile(sessionFilePath);
  const fileStatsAfterRead = await stat(sessionFilePath);
  if (
    fileStatsBeforeRead.size !== fileStatsAfterRead.size ||
    sessionBytes.byteLength !== fileStatsAfterRead.size
  ) {
    throw new Error("Session checkpoint 读取期间发生变化。");
  }
  if (sessionBytes.at(-1) !== 0x0a) {
    throw new Error("Session checkpoint 尾部不完整。");
  }
  let sessionText: string;
  try {
    sessionText = new TextDecoder("utf-8", { fatal: true }).decode(sessionBytes);
  } catch {
    throw new Error("Session checkpoint 不是合法 UTF-8。");
  }
  const lines = sessionText.slice(0, -1).split("\n");
  let lastSequence = 0;
  if (lines.length > 1) {
    const lastRecord = parseJsonObject(lines.at(-1));
    if (!isNonNegativeInteger(lastRecord.seq) || lastRecord.seq === 0) {
      throw new Error("Session checkpoint 的最后 seq 无效。");
    }
    lastSequence = lastRecord.seq;
  }
  return Object.freeze({ fileSize: fileStatsAfterRead.size, lastSequence });
}

/** 判断磁盘 checkpoint 是否仍与 Session 内存投影完全一致。 */
function areSameCheckpoint(
  expectedCheckpoint: SessionFileCheckpoint,
  actualCheckpoint: SessionFileCheckpoint,
): boolean {
  return (
    expectedCheckpoint.fileSize === actualCheckpoint.fileSize &&
    expectedCheckpoint.lastSequence === actualCheckpoint.lastSequence
  );
}

/** 原子取得 Session 锁；活着或不确定的所有者一律安全拒绝。 */
async function acquireSessionLock(
  lockDirectory: string,
  lockSystem: SessionLockSystem,
): Promise<SessionLockOwnership> {
  const reclaimGuardDirectory = `${lockDirectory}.reclaim`;
  if (await pathExists(reclaimGuardDirectory)) {
    throw new SessionBusyError("Session 正在被其他进程使用。");
  }

  try {
    await mkdir(lockDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const existingOwner = await readSessionLockOwner(lockDirectory).catch(() => null);
    if (existingOwner === null || lockSystem.inspectProcess(existingOwner.pid) !== "dead") {
      throw new SessionBusyError("Session 正在被其他进程使用。");
    }
    await reclaimDeadSessionLock(lockDirectory, reclaimGuardDirectory, existingOwner, lockSystem);
    return acquireSessionLock(lockDirectory, lockSystem);
  }

  const ownerToken = lockSystem.createOwnerToken();
  if (!isUuid(ownerToken) || !isUtcTimestamp(lockSystem.createTimestamp())) {
    await rmdir(lockDirectory).catch(() => undefined);
    throw new Error("Session 锁系统生成了无效身份。");
  }
  const owner: SessionLockOwner = Object.freeze({
    pid: lockSystem.processId,
    ownerToken,
    acquiredAt: lockSystem.createTimestamp(),
  });
  try {
    await writeSessionLockOwner(lockDirectory, owner);
  } catch (error) {
    await unlink(join(lockDirectory, "owner.json")).catch(() => undefined);
    await rmdir(lockDirectory).catch(() => undefined);
    throw error;
  }
  return Object.freeze({ lockDirectory, ownerToken });
}

/** 在回收门内再次确认死锁身份，再删除已认领的残留目录。 */
async function reclaimDeadSessionLock(
  lockDirectory: string,
  reclaimGuardDirectory: string,
  expectedOwner: SessionLockOwner,
  lockSystem: SessionLockSystem,
): Promise<void> {
  try {
    await mkdir(reclaimGuardDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new SessionBusyError("Session 正在被其他进程使用。");
    }
    throw error;
  }

  const reclaimedDirectory = `${lockDirectory}.dead-${lockSystem.createOwnerToken()}`;
  try {
    const currentOwner = await readSessionLockOwner(lockDirectory).catch(() => null);
    if (
      currentOwner === null ||
      currentOwner.ownerToken !== expectedOwner.ownerToken ||
      lockSystem.inspectProcess(currentOwner.pid) !== "dead"
    ) {
      throw new SessionBusyError("Session 正在被其他进程使用。");
    }
    await rename(lockDirectory, reclaimedDirectory);
    const reclaimedOwner = await readSessionLockOwner(reclaimedDirectory).catch(() => null);
    if (reclaimedOwner?.ownerToken !== expectedOwner.ownerToken) {
      await rename(reclaimedDirectory, lockDirectory).catch(() => undefined);
      throw new SessionBusyError("Session 正在被其他进程使用。");
    }
    await unlink(join(reclaimedDirectory, "owner.json"));
    await rmdir(reclaimedDirectory);
  } finally {
    await rmdir(reclaimGuardDirectory).catch(() => undefined);
  }
}

/** 只有 owner token 仍匹配时才移除本次持有的锁目录。 */
async function releaseSessionLock(ownership: SessionLockOwnership): Promise<void> {
  const currentOwner = await readSessionLockOwner(ownership.lockDirectory).catch(() => null);
  if (currentOwner?.ownerToken !== ownership.ownerToken) {
    throw new Error("Session lock owner token 不匹配。");
  }
  await unlink(join(ownership.lockDirectory, "owner.json"));
  await rmdir(ownership.lockDirectory);
}

/** 以独占文件写入并刷新一次锁所有者元数据。 */
async function writeSessionLockOwner(
  lockDirectory: string,
  owner: SessionLockOwner,
): Promise<void> {
  const ownerFileHandle = await open(join(lockDirectory, "owner.json"), "wx");
  try {
    await ownerFileHandle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await ownerFileHandle.sync();
  } finally {
    await ownerFileHandle.close();
  }
}

/** 严格读取锁元数据，任何未知形状都保持为不可回收状态。 */
async function readSessionLockOwner(lockDirectory: string): Promise<SessionLockOwner> {
  const ownerBytes = await readFile(join(lockDirectory, "owner.json"));
  let ownerText: string;
  try {
    ownerText = new TextDecoder("utf-8", { fatal: true }).decode(ownerBytes);
  } catch {
    throw new Error("Session lock owner 不是合法 UTF-8。");
  }
  if (!ownerText.endsWith("\n")) {
    throw new Error("Session lock owner 不完整。");
  }
  const owner = parseJsonObject(ownerText.slice(0, -1));
  if (
    !hasExactKeys(owner, ["pid", "ownerToken", "acquiredAt"]) ||
    !Number.isSafeInteger(owner.pid) ||
    (owner.pid as number) <= 0 ||
    !isUuid(owner.ownerToken) ||
    !isUtcTimestamp(owner.acquiredAt)
  ) {
    throw new Error("Session lock owner 无效。");
  }
  return owner as SessionLockOwner;
}

/** 仅用于锁竞争前判断回收门是否存在。 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/** 严格解码 Session，并只精确截断无换行的未完成 JSON 尾段。 */
async function readCompleteSessionText(sessionFilePath: string): Promise<string> {
  const sessionBytes = await readFile(sessionFilePath);
  let sessionText: string;
  try {
    sessionText = new TextDecoder("utf-8", { fatal: true }).decode(sessionBytes);
  } catch {
    throw new Error("Session 文件不是合法 UTF-8。");
  }
  if (sessionBytes.at(-1) === 0x0a) {
    return sessionText;
  }

  const finalNewlineByteIndex = sessionBytes.lastIndexOf(0x0a);
  if (finalNewlineByteIndex < 0) {
    throw new Error("Session Header 不完整。");
  }
  const tailText = new TextDecoder("utf-8", { fatal: true }).decode(
    sessionBytes.subarray(finalNewlineByteIndex + 1),
  );
  if (tailText.trim().length === 0 || classifyJsonText(tailText) !== "incomplete") {
    throw new Error("Session 文件包含完整或无效的未换行尾段。");
  }

  const sessionFileHandle = await open(sessionFilePath, "r+");
  try {
    await sessionFileHandle.truncate(finalNewlineByteIndex + 1);
    await sessionFileHandle.sync();
  } finally {
    await sessionFileHandle.close();
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    sessionBytes.subarray(0, finalNewlineByteIndex + 1),
  );
}

/** 按调用顺序补齐未决 ToolResult，再写入唯一 interrupted 终态。 */
async function appendRecoveryRecords(
  sessionFilePath: string,
  records: SessionRecord[],
  unfinishedRun: UnfinishedRun,
): Promise<void> {
  let nextSequence = records.length + 1;
  for (const toolCall of unfinishedRun.toolCalls) {
    if (toolCall.resolved) {
      continue;
    }
    const status = toolCall.started ? "unknown" : "aborted";
    const recoveryRecord: MessageRecord = Object.freeze({
      type: "message",
      entryId: randomUUID(),
      seq: nextSequence,
      timestamp: new Date().toISOString(),
      runId: unfinishedRun.runId,
      message: Object.freeze({
        type: "tool_result",
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        status,
        content:
          status === "unknown"
            ? "Tool 已开始，但 Session 恢复时无法确认执行结果。"
            : "Tool 尚未开始，已在 Session 恢复时终止。",
        truncated: false,
      }),
    });
    await appendJsonLine(sessionFilePath, recoveryRecord);
    records.push(recoveryRecord);
    nextSequence += 1;
  }

  const runFinishedRecord: RunFinishedRecord = Object.freeze({
    type: "run_finished",
    entryId: randomUUID(),
    seq: nextSequence,
    timestamp: new Date().toISOString(),
    runId: unfinishedRun.runId,
    status: "interrupted",
    metricsStatus: "incomplete",
    modelRequestCount: null,
    toolCallCount: unfinishedRun.toolCalls.length,
    activeDurationMilliseconds: null,
  });
  await appendJsonLine(sessionFilePath, runFinishedRecord);
  records.push(runFinishedRecord);
}

/** 区分完整、语法未完成与已经无效的单个 JSON 值。 */
function classifyJsonText(text: string): "complete" | "incomplete" | "invalid" {
  let cursor = 0;

  /** 跳过 JSON 允许的四种空白字符。 */
  function skipWhitespace(): void {
    while (cursor < text.length) {
      const character = text[cursor];
      if (character !== " " && character !== "\t" && character !== "\n" && character !== "\r") {
        return;
      }
      cursor += 1;
    }
  }

  /** 解析当前位置的一个 JSON 值前缀。 */
  function parseValue(): "complete" | "incomplete" | "invalid" {
    skipWhitespace();
    const character = text[cursor];
    if (character === undefined) {
      return "incomplete";
    }
    if (character === '"') {
      return parseString();
    }
    if (character === "{") {
      return parseObject();
    }
    if (character === "[") {
      return parseArray();
    }
    if (character === "t") {
      return parseLiteral("true");
    }
    if (character === "f") {
      return parseLiteral("false");
    }
    if (character === "n") {
      return parseLiteral("null");
    }
    if (character === "-" || /[0-9]/u.test(character)) {
      return parseNumber();
    }
    return "invalid";
  }

  /** 解析一个带转义检查的 JSON 字符串。 */
  function parseString(): "complete" | "incomplete" | "invalid" {
    cursor += 1;
    while (cursor < text.length) {
      const character = text[cursor] ?? "";
      cursor += 1;
      if (character === '"') {
        return "complete";
      }
      if (character.charCodeAt(0) < 0x20) {
        return "invalid";
      }
      if (character !== "\\") {
        continue;
      }
      const escapedCharacter = text[cursor];
      if (escapedCharacter === undefined) {
        return "incomplete";
      }
      cursor += 1;
      if ('"\\/bfnrt'.includes(escapedCharacter)) {
        continue;
      }
      if (escapedCharacter !== "u") {
        return "invalid";
      }
      for (let index = 0; index < 4; index += 1) {
        const hexadecimalCharacter = text[cursor];
        if (hexadecimalCharacter === undefined) {
          return "incomplete";
        }
        if (!/[0-9a-f]/iu.test(hexadecimalCharacter)) {
          return "invalid";
        }
        cursor += 1;
      }
    }
    return "incomplete";
  }

  /** 解析一个固定 JSON 字面量。 */
  function parseLiteral(literal: "true" | "false" | "null"): "complete" | "incomplete" | "invalid" {
    for (const expectedCharacter of literal) {
      const character = text[cursor];
      if (character === undefined) {
        return "incomplete";
      }
      if (character !== expectedCharacter) {
        return "invalid";
      }
      cursor += 1;
    }
    return "complete";
  }

  /** 解析符合 JSON 数字语法的一个前缀。 */
  function parseNumber(): "complete" | "incomplete" | "invalid" {
    if (text[cursor] === "-") {
      cursor += 1;
      if (cursor === text.length) {
        return "incomplete";
      }
    }
    if (text[cursor] === "0") {
      cursor += 1;
      if (/[0-9]/u.test(text[cursor] ?? "")) {
        return "invalid";
      }
    } else if (/[1-9]/u.test(text[cursor] ?? "")) {
      while (/[0-9]/u.test(text[cursor] ?? "")) {
        cursor += 1;
      }
    } else {
      return "invalid";
    }
    if (text[cursor] === ".") {
      cursor += 1;
      if (cursor === text.length) {
        return "incomplete";
      }
      if (!/[0-9]/u.test(text[cursor] ?? "")) {
        return "invalid";
      }
      while (/[0-9]/u.test(text[cursor] ?? "")) {
        cursor += 1;
      }
    }
    if (text[cursor] === "e" || text[cursor] === "E") {
      cursor += 1;
      if (text[cursor] === "+" || text[cursor] === "-") {
        cursor += 1;
      }
      if (cursor === text.length) {
        return "incomplete";
      }
      if (!/[0-9]/u.test(text[cursor] ?? "")) {
        return "invalid";
      }
      while (/[0-9]/u.test(text[cursor] ?? "")) {
        cursor += 1;
      }
    }
    return "complete";
  }

  /** 解析一个 JSON 数组及其分隔符。 */
  function parseArray(): "complete" | "incomplete" | "invalid" {
    cursor += 1;
    skipWhitespace();
    if (cursor === text.length) {
      return "incomplete";
    }
    if (text[cursor] === "]") {
      cursor += 1;
      return "complete";
    }
    while (true) {
      const itemStatus = parseValue();
      if (itemStatus !== "complete") {
        return itemStatus;
      }
      skipWhitespace();
      const character = text[cursor];
      if (character === undefined) {
        return "incomplete";
      }
      cursor += 1;
      if (character === "]") {
        return "complete";
      }
      if (character !== ",") {
        return "invalid";
      }
      skipWhitespace();
      if (cursor === text.length) {
        return "incomplete";
      }
    }
  }

  /** 解析一个 JSON 对象及其键值分隔符。 */
  function parseObject(): "complete" | "incomplete" | "invalid" {
    cursor += 1;
    skipWhitespace();
    if (cursor === text.length) {
      return "incomplete";
    }
    if (text[cursor] === "}") {
      cursor += 1;
      return "complete";
    }
    while (true) {
      if (text[cursor] !== '"') {
        return "invalid";
      }
      const keyStatus = parseString();
      if (keyStatus !== "complete") {
        return keyStatus;
      }
      skipWhitespace();
      if (text[cursor] === undefined) {
        return "incomplete";
      }
      if (text[cursor] !== ":") {
        return "invalid";
      }
      cursor += 1;
      const valueStatus = parseValue();
      if (valueStatus !== "complete") {
        return valueStatus;
      }
      skipWhitespace();
      const character = text[cursor];
      if (character === undefined) {
        return "incomplete";
      }
      cursor += 1;
      if (character === "}") {
        return "complete";
      }
      if (character !== ",") {
        return "invalid";
      }
      skipWhitespace();
      if (cursor === text.length) {
        return "incomplete";
      }
    }
  }

  const valueStatus = parseValue();
  if (valueStatus !== "complete") {
    return valueStatus;
  }
  skipWhitespace();
  return cursor === text.length ? "complete" : "invalid";
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
function parseSessionRecord(line: string, expectedSequence: number): SessionRecord {
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
    const legacyExpectedKeys =
      value.status === "budget_exhausted"
        ? [
            "type",
            "entryId",
            "seq",
            "timestamp",
            "runId",
            "status",
            "metricsStatus",
            "modelRequestCount",
            "toolCallCount",
            "activeDurationMilliseconds",
            "budgetKind",
          ]
        : [
            "type",
            "entryId",
            "seq",
            "timestamp",
            "runId",
            "status",
            "metricsStatus",
            "modelRequestCount",
            "toolCallCount",
            "activeDurationMilliseconds",
          ];
    const currentExpectedKeys = [...legacyExpectedKeys, "processedToolCallCount", "modelUsage"];
    const usesLegacyMetrics = hasExactKeys(value, legacyExpectedKeys);
    const usesCurrentMetrics = hasExactKeys(value, currentExpectedKeys);
    if (
      (!usesLegacyMetrics && !usesCurrentMetrics) ||
      !isRunFinishedMetrics(value, usesCurrentMetrics)
    ) {
      throw new Error("Session RunFinishedRecord 无效。");
    }
    if (usesLegacyMetrics && value.metricsStatus === "complete") {
      return Object.freeze({
        ...value,
        processedToolCallCount: value.toolCallCount,
        modelUsage: UNKNOWN_MODEL_USAGE,
      }) as RunFinishedRecord;
    }
    return value as RunFinishedRecord;
  }
  throw new Error("Session 包含未知记录类型。");
}

/** 以线性 Run 状态机校验全局身份、Tool 引用和唯一终态。 */
function validateSessionRecords(records: readonly SessionRecord[]): UnfinishedRun | null {
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
    if (record.toolCallCount !== activeRunToolCallIds.length) {
      throw new Error("Session RunFinished 的 ToolCall 计量不匹配。");
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
      record.status !== "budget_exhausted" &&
      record.status !== lastAssistantStatus &&
      !runCanEndAfterCompletedToolCalls
    ) {
      throw new Error("Session RunFinished 与最终 AssistantMessage 状态不匹配。");
    }
    if (
      record.metricsStatus === "complete" &&
      record.processedToolCallCount > record.toolCallCount
    ) {
      throw new Error("Session RunFinished 的 ToolCall 处理计量无效。");
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

/** 将公开消息转换为不包含流式状态的 Schema 1 持久形状。 */
function toDurableMessage(message: Message): DurableMessage {
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
    content: Object.freeze(message.parts.map(toDurableAssistantPart)),
    status: message.status,
  });
}

/** 将持久消息恢复为 Agent 与 TUI 共用的消息投影。 */
function fromDurableMessage(message: DurableMessage): Message {
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
  const content = message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  if (message.type === "user") {
    return Object.freeze({ role: "user", content } satisfies UserMessage);
  }
  return Object.freeze({
    role: "assistant",
    content,
    parts: Object.freeze(message.content.map(fromDurableAssistantPart)),
    status: message.status,
  } satisfies AssistantMessage);
}

/** 复制并冻结消息，避免调用者修改 Session 内部投影。 */
function snapshotMessage(message: Message): Message {
  if (message.role === "user") {
    return Object.freeze({ role: "user", content: message.content });
  }
  if (message.role === "tool") {
    return Object.freeze({ ...message });
  }
  return Object.freeze({
    role: "assistant",
    content: message.content,
    parts: Object.freeze(message.parts.map(snapshotAssistantPart)),
    status: message.status,
  });
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

/** 复制并冻结一个公开 Assistant part。 */
function snapshotAssistantPart(part: AssistantContentPart): AssistantContentPart {
  return part.type === "text"
    ? Object.freeze({ type: "text", text: part.text })
    : Object.freeze({
        type: "tool_call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: isJsonValue(part.input) ? snapshotJsonValue(part.input) : part.input,
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

/** 判断 RunFinishedRecord 的终态与新旧计量形状是否一致。 */
function isRunFinishedMetrics(
  value: Record<string, unknown>,
  usesCurrentMetrics: boolean,
): boolean {
  if (isRunFinishedTerminalStatus(value.status) && value.metricsStatus === "complete") {
    return (
      isNonNegativeInteger(value.modelRequestCount) &&
      isNonNegativeInteger(value.toolCallCount) &&
      isNonNegativeInteger(value.activeDurationMilliseconds) &&
      (!usesCurrentMetrics ||
        (isNonNegativeInteger(value.processedToolCallCount) &&
          value.processedToolCallCount <= value.toolCallCount &&
          isRunModelUsage(value.modelUsage))) &&
      (value.status !== "budget_exhausted" || isBudgetKind(value.budgetKind))
    );
  }
  return (
    value.status === "interrupted" &&
    value.metricsStatus === "incomplete" &&
    value.modelRequestCount === null &&
    isNonNegativeInteger(value.toolCallCount) &&
    value.activeDurationMilliseconds === null
  );
}

/** 判断未知值是否为可持久化的标准化累计模型 usage。 */
function isRunModelUsage(value: unknown): value is RunModelUsageDetails {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const usage = value as Record<string, unknown>;
  if (!hasExactKeys(usage, ["inputTokens", "outputTokens", "totalTokens"])) {
    return false;
  }
  return (
    isNullableNonNegativeInteger(usage.inputTokens) &&
    isNullableNonNegativeInteger(usage.outputTokens) &&
    isNullableNonNegativeInteger(usage.totalTokens)
  );
}

/** 判断 token 计量是否未知或为非负整数。 */
function isNullableNonNegativeInteger(value: unknown): boolean {
  return value === null || isNonNegativeInteger(value);
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
function isSideEffectToolName(value: unknown): value is ToolExecutionStartedDetails["toolName"] {
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
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** 判断未知值是否为非空字符串。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** 判断未知值是否为 AssistantMessage 的三个可持久终态。 */
function isAssistantTerminalStatus(value: unknown): boolean {
  return value === "completed" || value === "aborted" || value === "failed";
}

/** 判断未知值是否为当前 Run 可以写入的终态。 */
function isRunFinishedTerminalStatus(value: unknown): value is RunFinishedDetails["status"] {
  return isAssistantTerminalStatus(value) || value === "budget_exhausted";
}

/** 判断未知值是否为三类固定 Run 预算。 */
function isBudgetKind(value: unknown): boolean {
  return value === "model_requests" || value === "tool_calls" || value === "active_duration";
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
