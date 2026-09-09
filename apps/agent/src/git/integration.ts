import { randomUUID } from "node:crypto";
import type { JsonValue } from "../message.js";
import { GitCommandAbortedError, runGit } from "./command.js";
import type { GitIntegrationResult, ResolveGitIntegrationInput } from "./index.js";

type IntegrationPhase = "intent" | "staged" | "conflicted" | "committed" | "aborted" | "failed";

type IntegrationOperation = Readonly<{
  operationType: "integration";
  operationId: string;
  rootSessionId: string;
  worktreeId: string;
  sourceCommit: string;
  targetHead: string;
  allowedPaths: readonly string[];
  phase: IntegrationPhase;
  stagedTree?: string;
  integrationCommit?: string;
  error?: string;
}>;

type IntegrationOperationInput = Omit<
  IntegrationOperation,
  "stagedTree" | "integrationCommit" | "error"
> &
  Readonly<{
    stagedTree?: string | undefined;
    integrationCommit?: string | undefined;
    error?: string | undefined;
  }>;
export type WorkingTreeChangeSet = Readonly<{
  staged: readonly string[];
  unstaged: readonly string[];
  unmerged: readonly string[];
  untracked: readonly string[];
}>;

type GitIntegrationOptions = Readonly<{
  rootSessionId: string;
  operations: ReadonlyMap<string, JsonValue>;
  appendOperation: (operationId: string, payload: JsonValue) => Promise<void>;
  readWorkingTreeChanges: (root: string, signal?: AbortSignal) => Promise<WorkingTreeChangeSet>;
  resolveCommit: (root: string, ref: string, signal?: AbortSignal) => Promise<string>;
  assertNoUntrackedIntegrationCollisions: (
    root: string,
    allowedPaths: readonly string[],
    signal?: AbortSignal,
  ) => Promise<void>;
  isCoveredByRequests: (path: string, requestedPaths: readonly string[]) => boolean;
}>;

/** 根 Git Workspace 持有记录与串行执行权；此处只解释集成阶段并按落盘顺序执行副作用。 */
export function createGitIntegration(options: GitIntegrationOptions) {
  const {
    appendOperation,
    readWorkingTreeChanges,
    resolveCommit,
    assertNoUntrackedIntegrationCollisions,
  } = options;

  const stage = async (
    input: Readonly<{
      root: string;
      targetHead: string;
      worktreeId: string;
      sourceCommit: string;
      allowedPaths: readonly string[];
    }>,
    signal?: AbortSignal,
  ): Promise<GitIntegrationResult> => {
    const { root: targetRoot, targetHead, worktreeId, sourceCommit, allowedPaths } = input;
    await assertNoUntrackedIntegrationCollisions(targetRoot, allowedPaths, signal);
    const operationId = randomUUID();
    const intent: IntegrationOperation = Object.freeze({
      operationType: "integration",
      operationId,
      rootSessionId: options.rootSessionId,
      worktreeId,
      sourceCommit,
      targetHead,
      allowedPaths: Object.freeze([...allowedPaths]),
      phase: "intent",
    });
    // intent 必须先落盘；后续取消或记录失败都不能让可能已发生的 Git 副作用失去依据。
    await appendOperation(operationId, toJsonValue(intent));
    try {
      await assertNoUntrackedIntegrationCollisions(targetRoot, allowedPaths, signal);
      await runGit({
        cwd: targetRoot,
        arguments: ["cherry-pick", "--no-commit", sourceCommit],
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      // 取消只结束命令；这里不传已取消的 signal，仍要核对它是否留下冲突或其他修改。
      const workingTreeChanges = await readWorkingTreeChanges(targetRoot);
      assertIntegrationOwnsWorkingTreeChanges(workingTreeChanges, allowedPaths);
      if (workingTreeChanges.unmerged.length > 0) {
        const conflicted: IntegrationOperation = Object.freeze({
          ...intent,
          phase: "conflicted",
          error: safeErrorMessage(error),
        });
        await appendOperation(operationId, toJsonValue(conflicted));
        if (error instanceof GitCommandAbortedError) throw error;
        return integrationResult(conflicted, workingTreeChanges.unmerged);
      }
      if (hasWorkingTreeChanges(workingTreeChanges)) {
        const uncertain: IntegrationOperation = Object.freeze({
          ...intent,
          error: `操作结果需要核对：${safeErrorMessage(error)}`,
        });
        await appendOperation(operationId, toJsonValue(uncertain));
      } else {
        await appendOperation(
          operationId,
          toJsonValue({ ...intent, phase: "failed", error: safeErrorMessage(error) }),
        );
      }
      throw error;
    }

    if ((await resolveCommit(targetRoot, "HEAD", signal)) !== targetHead) {
      throw new Error("集成期间目标 HEAD 已变化，结果需要人工核对。");
    }
    const workingTreeChanges = await readWorkingTreeChanges(targetRoot, signal);
    assertIntegrationOwnsWorkingTreeChanges(workingTreeChanges, allowedPaths);
    if (workingTreeChanges.unmerged.length > 0) {
      const conflicted: IntegrationOperation = Object.freeze({ ...intent, phase: "conflicted" });
      await appendOperation(operationId, toJsonValue(conflicted));
      return integrationResult(conflicted, workingTreeChanges.unmerged);
    }
    if (
      workingTreeChanges.staged.length === 0 ||
      workingTreeChanges.unstaged.length > 0 ||
      workingTreeChanges.untracked.length > 0
    ) {
      throw new Error("集成没有形成可独立核对的暂存结果。");
    }
    const stagedTree = await writeTree(targetRoot, signal);
    const staged: IntegrationOperation = Object.freeze({
      ...intent,
      phase: "staged",
      stagedTree,
    });
    await appendOperation(operationId, toJsonValue(staged));
    return integrationResult(staged, []);
  };

  const resolve = async (
    root: string,
    operation: IntegrationOperation,
    action: ResolveGitIntegrationInput["action"],
    signal?: AbortSignal,
  ) => {
    const workingTreeChanges = await readWorkingTreeChanges(root, signal);
    assertIntegrationOwnsWorkingTreeChanges(workingTreeChanges, operation.allowedPaths);
    const resolutionCommand = await planIntegrationResolution(
      root,
      operation,
      workingTreeChanges,
      action,
      signal,
    );

    if (resolutionCommand.action === "abort") {
      if (resolutionCommand.arguments !== undefined) {
        await runGit({
          cwd: root,
          arguments: resolutionCommand.arguments,
          ...(signal === undefined ? {} : { signal }),
        });
        if (hasWorkingTreeChanges(await readWorkingTreeChanges(root, signal))) {
          throw new Error("Git 中止后根工作区未恢复 clean 状态。");
        }
      }
      const aborted: IntegrationOperation = Object.freeze({ ...operation, phase: "aborted" });
      await appendOperation(operation.operationId, toJsonValue(aborted));
      return Object.freeze({
        operationId: operation.operationId,
        worktreeId: operation.worktreeId,
        status: "aborted" as const,
      });
    }

    try {
      await runGit({
        cwd: root,
        arguments: resolutionCommand.arguments,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      // 命令失败不代表提交未发生；保留原阶段，下一次显式处理仍须重查实际 HEAD。
      const retained: IntegrationOperation = Object.freeze({
        ...operation,
        error: safeErrorMessage(error),
      });
      await appendOperation(operation.operationId, toJsonValue(retained));
      throw error;
    }
    const integrationCommit = await resolveCommit(root, "HEAD", signal);
    if (integrationCommit === operation.targetHead) {
      throw new Error("Git 未产生新的集成提交。");
    }
    const integrationParent = await resolveCommit(root, `${integrationCommit}^`, signal);
    if (integrationParent !== operation.targetHead) {
      throw new Error("集成提交不再直接基于记录的目标 HEAD，结果需要人工核对。");
    }
    const committed = freezeIntegrationOperation({
      ...operation,
      phase: "committed",
      integrationCommit,
      error: undefined,
    });
    await appendOperation(operation.operationId, toJsonValue(committed));
    return Object.freeze({
      operationId: operation.operationId,
      worktreeId: operation.worktreeId,
      status: "committed" as const,
      integrationCommit,
    });
  };

  function assertIntegrationOwnsWorkingTreeChanges(
    workingTreeChanges: WorkingTreeChangeSet,
    allowedPaths: readonly string[],
  ): void {
    const paths = new Set([
      ...workingTreeChanges.staged,
      ...workingTreeChanges.unstaged,
      ...workingTreeChanges.unmerged,
      ...workingTreeChanges.untracked,
    ]);
    if ([...paths].some((path) => !options.isCoveredByRequests(path, allowedPaths))) {
      throw new Error("根工作区出现不属于当前成果的修改，拒绝继续集成。");
    }
  }

  return Object.freeze({
    pendingOperation: () => findPendingIntegration(options.operations),
    stage,
    resolve,
  });
}

/** worktree 摘要可能尚未写入；已落盘的 committed 事实仍足以恢复其交付状态。 */
export function readIntegrationCommit(payload: JsonValue): string | undefined {
  return isObject(payload) &&
    payload.operationType === "integration" &&
    payload.phase === "committed" &&
    typeof payload.integrationCommit === "string"
    ? payload.integrationCommit
    : undefined;
}

async function planIntegrationResolution(
  root: string,
  operation: IntegrationOperation,
  workingTreeChanges: WorkingTreeChangeSet,
  action: ResolveGitIntegrationInput["action"],
  signal?: AbortSignal,
) {
  if (action === "abort") {
    if (!hasWorkingTreeChanges(workingTreeChanges)) {
      return Object.freeze({ action, arguments: undefined });
    }
    if (workingTreeChanges.untracked.length > 0) {
      throw new Error("集成期间出现未跟踪文件，需先人工核对，不能自动中止。");
    }
  } else {
    if (workingTreeChanges.unmerged.length > 0) {
      throw new Error("仍有未解决的冲突，不能继续集成。");
    }
    if (workingTreeChanges.staged.length === 0) throw new Error("没有待提交的集成结果。");
    if (workingTreeChanges.unstaged.length > 0 || workingTreeChanges.untracked.length > 0) {
      throw new Error("集成路径仍含未暂存或未跟踪内容，不能继续。");
    }
  }

  // staged 固定了可核对的树；intent 与 conflicted 尚无此事实，继续沿用人工核对后的路径边界。
  if (operation.phase === "staged" && operation.stagedTree !== undefined) {
    const currentTree = await writeTree(root, signal);
    if (action === "abort") {
      if (currentTree !== operation.stagedTree || workingTreeChanges.unstaged.length > 0) {
        throw new Error("集成暂存结果已经变化，不能自动中止。");
      }
    } else if (currentTree !== operation.stagedTree) {
      throw new Error("暂存结果在审批后已经变化，拒绝继续集成。");
    }
  }

  const cherryPickHead = await hasCherryPickHead(root, signal);
  if (action === "abort") {
    return Object.freeze({
      action,
      arguments: cherryPickHead
        ? ["cherry-pick", "--abort"]
        : [
            "restore",
            `--source=${operation.targetHead}`,
            "--staged",
            "--worktree",
            "--",
            ...operation.allowedPaths.map((path) => `:(literal)${path}`),
          ],
    });
  }
  return Object.freeze({
    action,
    arguments: cherryPickHead
      ? ["cherry-pick", "--continue"]
      : ["-c", "commit.gpgsign=false", "commit", "--no-verify", "-C", operation.sourceCommit],
  });
}

async function hasCherryPickHead(root: string, signal?: AbortSignal): Promise<boolean> {
  const result = await runGit({
    cwd: root,
    arguments: ["rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD"],
    ...(signal === undefined ? {} : { signal }),
    allowedExitCodes: [0, 1],
    readOnly: true,
  });
  return result.exitCode === 0;
}

async function writeTree(root: string, signal?: AbortSignal): Promise<string> {
  const result = await runGit({
    cwd: root,
    arguments: ["write-tree"],
    ...(signal === undefined ? {} : { signal }),
  });
  return result.stdout.trim();
}

function hasWorkingTreeChanges(workingTreeChanges: WorkingTreeChangeSet): boolean {
  return (
    workingTreeChanges.staged.length > 0 ||
    workingTreeChanges.unstaged.length > 0 ||
    workingTreeChanges.unmerged.length > 0 ||
    workingTreeChanges.untracked.length > 0
  );
}

function integrationResult(
  operation: IntegrationOperation,
  conflicts: readonly string[],
): GitIntegrationResult {
  if (operation.phase !== "staged" && operation.phase !== "conflicted") {
    throw new Error("集成尚未形成可返回的状态。");
  }
  return Object.freeze({
    operationId: operation.operationId,
    worktreeId: operation.worktreeId,
    sourceCommit: operation.sourceCommit,
    targetHead: operation.targetHead,
    status: operation.phase,
    conflicts: Object.freeze([...conflicts]),
  });
}

function findPendingIntegration(
  operations: ReadonlyMap<string, JsonValue>,
): IntegrationOperation | undefined {
  const pending = [...operations.values()]
    .map(parseIntegrationOperation)
    .filter(
      (operation): operation is IntegrationOperation =>
        operation !== undefined && ["intent", "staged", "conflicted"].includes(operation.phase),
    );
  if (pending.length > 1) throw new Error("存在多个未收口的 Git 集成记录，需要人工核对。");
  return pending[0];
}

function parseIntegrationOperation(value: JsonValue): IntegrationOperation | undefined {
  if (
    !isObject(value) ||
    value.operationType !== "integration" ||
    typeof value.operationId !== "string" ||
    typeof value.rootSessionId !== "string" ||
    typeof value.worktreeId !== "string" ||
    typeof value.sourceCommit !== "string" ||
    typeof value.targetHead !== "string" ||
    !Array.isArray(value.allowedPaths) ||
    !value.allowedPaths.every((path) => typeof path === "string") ||
    !["intent", "staged", "conflicted", "committed", "aborted", "failed"].includes(
      String(value.phase),
    )
  ) {
    return undefined;
  }
  return Object.freeze({
    operationType: "integration",
    operationId: value.operationId,
    rootSessionId: value.rootSessionId,
    worktreeId: value.worktreeId,
    sourceCommit: value.sourceCommit,
    targetHead: value.targetHead,
    allowedPaths: Object.freeze([...value.allowedPaths] as string[]),
    phase: value.phase as IntegrationPhase,
    ...(typeof value.stagedTree === "string" ? { stagedTree: value.stagedTree } : {}),
    ...(typeof value.integrationCommit === "string"
      ? { integrationCommit: value.integrationCommit }
      : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  });
}

function freezeIntegrationOperation(operation: IntegrationOperationInput): IntegrationOperation {
  const defined = Object.fromEntries(
    Object.entries(operation).filter(([, value]) => value !== undefined),
  ) as IntegrationOperation;
  return Object.freeze(defined);
}
function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function isObject(value: JsonValue): value is Readonly<{ [key: string]: JsonValue }> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Git 操作失败。";
}
