import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { Message } from "../message.js";
import {
  appendJsonLine,
  appendRecoveryRecords,
  areSameCheckpoint,
  ensureSessionGitignore,
  readCompleteSessionText,
  readSessionCheckpoint,
  type SessionFileCheckpoint,
  writeNewSessionHeader,
} from "./journal.js";
import {
  acquireSessionLock,
  DEFAULT_SESSION_LOCK_SYSTEM,
  releaseSessionLock,
  SessionBusyError,
  type SessionLockOwnership,
  type SessionLockSystem,
} from "./lock.js";
import {
  areSameShell,
  areSameWorkspace,
  fromDurableMessage,
  isSideEffectToolName,
  isUuid,
  type MessageRecord,
  parseSessionHeader,
  parseSessionRecord,
  type RunFinishedDetails,
  type SessionHeader,
  type SessionRecord,
  type SessionShell,
  snapshotSessionShell,
  type ToolExecutionStartedDetails,
  toDurableMessage,
  validateSessionRecords,
} from "./schema.js";

export type { SessionLockSystem } from "./lock.js";
export type {
  RunFinishedDetails,
  SessionShell,
  ToolExecutionStartedDetails,
} from "./schema.js";

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

/** 按环境覆盖或工作区默认值解析 Session 数据目录。 */
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

/** 打开一个完整的 Schema 1 文件，并从持久消息重建只读投影。 */
export async function openSession({
  sessionId,
  workspaceRoot,
  sessionDirectory,
  shell,
  lockSystem = DEFAULT_SESSION_LOCK_SYSTEM,
}: OpenSessionOptions): Promise<Session> {
  if (!isUuid(sessionId)) {
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
  const messageHistory = [...initialMessageHistory];
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
          const durableMessage = toDurableMessage(message);
          const historyMessage = fromDurableMessage(durableMessage);
          return enqueueRecord(
            (sequence) =>
              Object.freeze({
                type: "message",
                entryId: randomUUID(),
                seq: sequence,
                timestamp: new Date().toISOString(),
                runId,
                message: durableMessage,
              }),
            () => messageHistory.push(historyMessage),
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
          return enqueueRecord(
            (sequence) =>
              Object.freeze({
                type: "run_finished",
                entryId: randomUUID(),
                seq: sequence,
                timestamp: new Date().toISOString(),
                runId,
                status: details.status,
              }),
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
