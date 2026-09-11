import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readlink, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { JsonValue } from "../../../message.js";
import { sharedWorkspaceAccess, type WorkspaceAccess } from "../../workspace-access.js";
import { GitCommandAbortedError, GitCommandError, runGit } from "./command.js";
import {
  createGitIntegration,
  readIntegrationCommit,
  type WorkingTreeChangeSet,
} from "./integration.js";

const MAXIMUM_QUERY_OUTPUT_BYTES = 128 * 1024;
const MAXIMUM_INDEX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAXIMUM_APPROVAL_PATHS = 10_000;
const MAXIMUM_APPROVAL_FILE_BYTES = 32 * 1024 * 1024;
const MAXIMUM_APPROVAL_TOTAL_BYTES = 64 * 1024 * 1024;

export type GitWorkspaceOptions = Readonly<{
  workspaceRoot: string;
  workspaceAccess?: WorkspaceAccess;
  worktreeDirectory: string;
  rootSessionId: string;
  readRecords: () => readonly { kind: string; key: string; payload: JsonValue }[];
  appendRecord: (details: {
    kind: "worktree" | "git_operation";
    key: string;
    payload: JsonValue;
  }) => Promise<void>;
}>;

export type GitQueryInput = Readonly<{
  action: "status" | "diff" | "log" | "show" | "branches" | "worktrees";
  worktreeId?: string;
  ref?: string;
}>;

export type GitApprovalStateInput = Readonly<{
  worktreeId?: string;
  paths?: readonly string[];
  ref?: string;
  includeRoot?: boolean;
}>;
export type CreateWorktreeInput = Readonly<{
  memberSessionId?: string;
  ref?: string;
}>;

export type ManagedWorktreeStatus = "creating" | "ready" | "error" | "missing" | "removed";

export type ManagedWorktree = Readonly<{
  id: string;
  rootSessionId: string;
  memberSessionId?: string;
  path: string;
  repositoryRoot: string;
  commonGitDirectory: string;
  branch: string;
  baseCommit: string;
  status: ManagedWorktreeStatus;
  integrated: boolean;
  resultCommit?: string;
  integrationCommit?: string;
  notice?: string;
  error?: string;
}>;

type ManagedWorktreeInput = Omit<
  ManagedWorktree,
  "memberSessionId" | "resultCommit" | "integrationCommit" | "notice" | "error"
> &
  Readonly<{
    memberSessionId?: string | undefined;
    resultCommit?: string | undefined;
    integrationCommit?: string | undefined;
    notice?: string | undefined;
    error?: string | undefined;
  }>;
export type GitCommitInput = Readonly<{
  worktreeId?: string;
  paths: readonly string[];
  message: string;
}>;

export type GitCommitResult = Readonly<{
  commit: string;
  worktreeId?: string;
  paths: readonly string[];
}>;

export type GitIntegrateInput = Readonly<{
  worktreeId: string;
  commit: string;
}>;

export type GitIntegrationResult = Readonly<{
  operationId: string;
  worktreeId: string;
  sourceCommit: string;
  targetHead: string;
  status: "staged" | "conflicted";
  conflicts: readonly string[];
}>;

export type ResolveGitIntegrationInput = Readonly<{
  action: "continue" | "abort";
}>;

export type GitIntegrationResolution = Readonly<{
  operationId: string;
  worktreeId: string;
  status: "committed" | "aborted";
  integrationCommit?: string;
}>;

export type BeforeGitMutation = () => void | Promise<void>;

export type GitWorkspace = Readonly<{
  query(input: GitQueryInput, signal?: AbortSignal): Promise<string>;
  captureApprovalState(input: GitApprovalStateInput, signal?: AbortSignal): Promise<string>;
  createWorktree(
    input: CreateWorktreeInput,
    signal?: AbortSignal,
    beforeMutation?: BeforeGitMutation,
  ): Promise<ManagedWorktree>;
  inspectWorktree(id: string, signal?: AbortSignal): Promise<ManagedWorktree>;
  removeWorktree(
    id: string,
    signal?: AbortSignal,
    discard?: boolean,
    beforeMutation?: BeforeGitMutation,
  ): Promise<ManagedWorktree>;
  commit(
    input: GitCommitInput,
    signal?: AbortSignal,
    beforeMutation?: BeforeGitMutation,
  ): Promise<GitCommitResult>;
  integrate(
    input: GitIntegrateInput,
    signal?: AbortSignal,
    beforeMutation?: BeforeGitMutation,
  ): Promise<GitIntegrationResult>;
  resolveIntegration(
    input: ResolveGitIntegrationInput,
    signal?: AbortSignal,
    beforeMutation?: BeforeGitMutation,
  ): Promise<GitIntegrationResolution>;
  listWorktrees(): readonly ManagedWorktree[];
}>;

type RepositoryIdentity = Readonly<{
  root: string;
  commonGitDirectory: string;
  head: string;
  branch: string | null;
}>;

type ApprovalCaptureBudget = {
  bytes: number;
  files: number;
};

type ApprovalFileSnapshot = Readonly<{
  path: string;
  type: "missing" | "file" | "directory" | "symlink" | "other";
  mode?: number;
  size?: number;
  digest?: string;
  linkTarget?: string;
}>;

type ApprovalControlSnapshot = Readonly<{
  repositoryRoot: string;
  commonGitDirectory: string;
  privateGitDirectory: string;
  head: string;
  branch: string | null;
  indexFile: ApprovalFileSnapshot;
  indexEntriesDigest: string;
  paths: readonly string[];
  resolvedRef?: string;
}>;

type ApprovalRepositorySnapshot = Readonly<{
  control: ApprovalControlSnapshot;
  files: readonly ApprovalFileSnapshot[];
}>;

/** 创建一个持有受管 worktree 与本地集成状态的内部 Git Module。 */
export function createGitWorkspace(options: GitWorkspaceOptions): GitWorkspace {
  assertSafeIdentifier(options.rootSessionId, "rootSessionId");
  const workspaceRoot = resolve(options.workspaceRoot);
  const workspaceAccess = options.workspaceAccess ?? sharedWorkspaceAccess;
  const worktreeDirectory = resolve(options.worktreeDirectory);
  const managedDirectory = resolve(worktreeDirectory, options.rootSessionId);
  assertPathWithin(worktreeDirectory, managedDirectory, false);

  const managedWorktrees = new Map<string, ManagedWorktree>();
  const gitOperations = new Map<string, JsonValue>();
  restoreRecords(options.readRecords(), options.rootSessionId, managedWorktrees, gitOperations);

  const appendWorktree = async (worktree: ManagedWorktree) => {
    await options.appendRecord({
      kind: "worktree",
      key: worktree.id,
      payload: toJsonValue(worktree),
    });
    managedWorktrees.set(worktree.id, worktree);
  };

  const appendOperation = async (operationId: string, payload: JsonValue) => {
    await options.appendRecord({ kind: "git_operation", key: operationId, payload });
    gitOperations.set(operationId, payload);
  };

  const integration = createGitIntegration({
    rootSessionId: options.rootSessionId,
    operations: gitOperations,
    appendOperation,
    readWorkingTreeChanges,
    resolveCommit,
    assertNoUntrackedIntegrationCollisions,
    isCoveredByRequests,
  });

  // 一次受管 Git 变更只在最外层取锁；内部命令与回滚沿用同一租约，不能嵌套等待自己。
  async function serializeWorkspaceMutation<T>(
    workspaceRoots: () => readonly string[],
    signal: AbortSignal | undefined,
    beforeMutation: BeforeGitMutation | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    const releaseWrite = await workspaceAccess.acquireExclusiveWrite(workspaceRoots(), signal);
    try {
      if (signal?.aborted) throw new GitCommandAbortedError();
      await beforeMutation?.();
      if (signal?.aborted) throw new GitCommandAbortedError();
      return await operation();
    } finally {
      releaseWrite();
    }
  }

  const findWorktree = (id: string): ManagedWorktree => {
    const worktree = managedWorktrees.get(id);
    if (worktree === undefined) throw new Error("找不到受管 worktree。");
    assertManagedWorktreePath(worktree, managedDirectory);
    return worktree;
  };

  const query = async (input: GitQueryInput, signal?: AbortSignal): Promise<string> => {
    const target = await resolveQueryTarget(input.worktreeId, signal);
    if (input.ref !== undefined && !["diff", "log", "show"].includes(input.action)) {
      throw new Error("该 Git 查询不接受 ref。");
    }
    if (input.action === "diff" && input.ref === undefined) {
      const sectionOutputByteLimit = Math.floor((MAXIMUM_QUERY_OUTPUT_BYTES - 512) / 2);
      const commandOptions = {
        cwd: target.root,
        ...(signal === undefined ? {} : { signal }),
        outputByteLimit: sectionOutputByteLimit,
        readOnly: true,
      } as const;
      const unstagedResult = await runGit({
        ...commandOptions,
        arguments: ["diff", "--no-ext-diff", "--no-textconv", "--"],
      });
      const stagedResult = await runGit({
        ...commandOptions,
        arguments: ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--"],
      });
      const sections = [
        "[未暂存差异]",
        unstagedResult.stdout.trimEnd() || "(无)",
        "",
        "[已暂存差异]",
        stagedResult.stdout.trimEnd() || "(无)",
      ];
      if (unstagedResult.truncated || stagedResult.truncated) {
        sections.push("", "...[Git 输出已截断]");
      }
      return sections.join("\n");
    }
    let commandArguments: readonly string[];
    switch (input.action) {
      case "status":
        commandArguments = ["status", "--short", "--branch", "--untracked-files=all"];
        break;
      case "diff": {
        const commit =
          input.ref === undefined ? undefined : await resolveCommit(target.root, input.ref, signal);
        commandArguments = [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          ...(commit === undefined ? [] : [commit]),
          "--",
        ];
        break;
      }
      case "log": {
        const commit = await resolveCommit(target.root, input.ref ?? "HEAD", signal);
        commandArguments = [
          "log",
          "--max-count=50",
          "--date=iso-strict",
          "--format=%H%x09%ad%x09%an%x09%s",
          commit,
        ];
        break;
      }
      case "show": {
        const commit = await resolveCommit(target.root, input.ref ?? "HEAD", signal);
        commandArguments = [
          "show",
          "--no-ext-diff",
          "--no-textconv",
          "--format=fuller",
          commit,
          "--",
        ];
        break;
      }
      case "branches":
        commandArguments = [
          "for-each-ref",
          "--sort=refname",
          "--format=%(refname:short)%09%(objectname)",
          "refs/heads/",
        ];
        break;
      case "worktrees":
        commandArguments = ["worktree", "list", "--porcelain"];
        break;
    }
    const result = await runGit({
      cwd: target.root,
      arguments: commandArguments,
      ...(signal === undefined ? {} : { signal }),
      outputByteLimit: MAXIMUM_QUERY_OUTPUT_BYTES,
      readOnly: true,
    });
    const output = result.stdout.trimEnd();
    return result.truncated ? `${output}\n...[Git 输出已截断]` : output;
  };

  const captureApprovalState = async (
    input: GitApprovalStateInput,
    signal?: AbortSignal,
  ): Promise<string> => {
    if (input.paths !== undefined && (input.paths.length === 0 || input.paths.length > 100)) {
      throw new Error("审批指纹 paths 必须包含 1 至 100 个明确路径。");
    }
    const target = await resolveQueryTarget(input.worktreeId, signal);
    const paths =
      input.paths === undefined
        ? undefined
        : await normalizeRequestedPaths(target.root, input.paths, signal);
    const budget: ApprovalCaptureBudget = { bytes: 0, files: 0 };
    const targetSnapshot = await captureRepositoryApprovalSnapshot({
      repository: target,
      ...(paths === undefined ? {} : { paths }),
      ...(input.ref === undefined ? {} : { ref: input.ref }),
      includeIgnored:
        input.worktreeId !== undefined &&
        paths === undefined &&
        input.ref === undefined &&
        input.includeRoot !== true,
      budget,
      ...(signal === undefined ? {} : { signal }),
    });
    const fingerprint = createHash("sha256");
    fingerprint.update(JSON.stringify({ label: "target", snapshot: targetSnapshot }));

    if (input.includeRoot === true) {
      const root = await loadRepository(workspaceRoot, signal);
      if (samePath(root.root, target.root)) {
        fingerprint.update(JSON.stringify({ label: "root", sameAsTarget: true }));
      } else {
        let integrationPaths: readonly string[] | undefined;
        if (input.worktreeId !== undefined && targetSnapshot.control.resolvedRef !== undefined) {
          const changedPaths = await changedPathsForCommit(
            target.root,
            targetSnapshot.control.resolvedRef,
            signal,
          );
          const collisions = await findUntrackedIntegrationCollisions(
            root.root,
            changedPaths,
            signal,
          );
          integrationPaths = pathsAndAncestors([...changedPaths, ...collisions]);
        }
        const rootSnapshot = await captureRepositoryApprovalSnapshot({
          repository: root,
          ...(integrationPaths === undefined ? {} : { additionalPaths: integrationPaths }),
          includeIgnored: false,
          budget,
          ...(signal === undefined ? {} : { signal }),
        });
        fingerprint.update(JSON.stringify({ label: "root", snapshot: rootSnapshot }));
      }
    }
    return `sha256:${fingerprint.digest("hex")}`;
  };
  const createWorktree = (
    input: CreateWorktreeInput,
    signal?: AbortSignal,
    beforeMutation?: BeforeGitMutation,
  ): Promise<ManagedWorktree> =>
    serializeWorkspaceMutation(
      () => [workspaceRoot],
      signal,
      beforeMutation,
      async () => {
        if (input.memberSessionId !== undefined) {
          assertNonEmptyText(input.memberSessionId, "memberSessionId", 256);
        }
        await ensureManagedDirectory(worktreeDirectory, managedDirectory);
        const repository = await loadRepository(workspaceRoot, signal);
        await rejectSubmoduleRepository(repository.root, signal);
        const baseCommit = await resolveCommit(repository.root, input.ref ?? "HEAD", signal);
        const dirty = !(await isClean(repository.root, signal));
        const worktreeId = randomUUID();
        const worktreePath = resolve(managedDirectory, worktreeId);
        assertPathWithin(managedDirectory, worktreePath, false);
        await assertPathMissing(worktreePath);
        const rootName = options.rootSessionId.replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 48);
        const branch = `anthias/${rootName}/${worktreeId}`;
        await assertBranchMissing(repository.root, branch, signal);
        const creatingWorktree = freezeWorktree({
          id: worktreeId,
          rootSessionId: options.rootSessionId,
          ...(input.memberSessionId === undefined
            ? {}
            : { memberSessionId: input.memberSessionId }),
          path: worktreePath,
          repositoryRoot: repository.root,
          commonGitDirectory: repository.commonGitDirectory,
          branch,
          baseCommit,
          status: "creating",
          integrated: false,
          ...(dirty
            ? {
                notice: `主工作区存在未提交修改；worktree 从提交 ${baseCommit} 创建，这些修改不会带入。`,
              }
            : {}),
        });
        await appendWorktree(creatingWorktree);
        try {
          await runGit({
            cwd: repository.root,
            arguments: ["worktree", "add", "-b", branch, worktreePath, baseCommit],
            ...(signal === undefined ? {} : { signal }),
          });
          const actualRepository = await loadRepository(worktreePath, signal);
          if (
            !samePath(actualRepository.commonGitDirectory, repository.commonGitDirectory) ||
            actualRepository.branch !== branch ||
            actualRepository.head !== baseCommit
          ) {
            throw new Error("新 worktree 的仓库身份、分支或基线与创建意图不一致。");
          }
          const readyWorktree = freezeWorktree({ ...creatingWorktree, status: "ready" });
          await appendWorktree(readyWorktree);
          return readyWorktree;
        } catch (error) {
          const failedWorktree = freezeWorktree({
            ...creatingWorktree,
            status: "error",
            error: safeErrorMessage(error),
          });
          try {
            await appendWorktree(failedWorktree);
          } catch {
            // 创建意图已持久化；记录失败时保留实际 Git 状态供下次检查。
          }
          throw error;
        }
      },
    );

  const inspectWorktree = (id: string, signal?: AbortSignal): Promise<ManagedWorktree> =>
    serializeWorkspaceMutation(
      () => [findWorktree(id).path],
      signal,
      undefined,
      async () => inspectManagedWorktree(findWorktree(id), signal, appendWorktree),
    );

  const removeWorktree = (
    id: string,
    signal?: AbortSignal,
    discard = false,
    beforeMutation?: BeforeGitMutation,
  ): Promise<ManagedWorktree> =>
    serializeWorkspaceMutation(
      () => [workspaceRoot, findWorktree(id).path],
      signal,
      beforeMutation,
      async () => {
        const inspected = await inspectManagedWorktree(findWorktree(id), signal, appendWorktree);
        if (inspected.status !== "ready") {
          throw new Error("只有状态正常的受管 worktree 可以移除。");
        }
        if (!(await isCleanForRemoval(inspected.path, signal))) {
          throw new Error("worktree 含有未提交或未跟踪修改，不能移除。");
        }
        if (inspected.resultCommit !== undefined && !inspected.integrated && !discard) {
          throw new Error("worktree 成果尚未集成；需要明确 discard 才能放弃。");
        }
        const operationId = randomUUID();
        await appendOperation(
          operationId,
          toJsonValue({
            operationType: "remove_worktree",
            operationId,
            rootSessionId: options.rootSessionId,
            worktreeId: inspected.id,
            phase: "intent",
            discard,
          }),
        );
        let removeCommandCompleted = false;
        try {
          await runGit({
            cwd: inspected.repositoryRoot,
            arguments: ["worktree", "remove", "--", inspected.path],
            ...(signal === undefined ? {} : { signal }),
          });
          removeCommandCompleted = true;
          if (await pathExists(inspected.path)) {
            throw new Error("Git 已返回成功，但 worktree 目录仍然存在。");
          }
          await appendOperation(
            operationId,
            toJsonValue({
              operationType: "remove_worktree",
              operationId,
              rootSessionId: options.rootSessionId,
              worktreeId: inspected.id,
              phase: "removed",
              discard,
            }),
          );
          const removed = freezeWorktree({ ...inspected, status: "removed" });
          await appendWorktree(removed);
          return removed;
        } catch (error) {
          await appendOperation(
            operationId,
            toJsonValue({
              operationType: "remove_worktree",
              operationId,
              rootSessionId: options.rootSessionId,
              worktreeId: inspected.id,
              phase: removeCommandCompleted ? "intent" : "failed",
              discard,
              error: safeErrorMessage(error),
            }),
          );
          throw error;
        }
      },
    );

  const commit = (
    input: GitCommitInput,
    signal?: AbortSignal,
    beforeMutation?: BeforeGitMutation,
  ): Promise<GitCommitResult> =>
    serializeWorkspaceMutation(
      () => [input.worktreeId === undefined ? workspaceRoot : findWorktree(input.worktreeId).path],
      signal,
      beforeMutation,
      async () => {
        assertNonEmptyText(input.message, "message", 16 * 1024);
        const target = await resolveCommitTarget(input.worktreeId, signal);
        const requestedPaths = await normalizeRequestedPaths(target.root, input.paths, signal);
        if (input.worktreeId === undefined && integration.pendingOperation() !== undefined) {
          throw new Error("根工作区存在待处理的集成，不能执行普通提交。");
        }
        if (await hasStagedChanges(target.root, signal)) {
          throw new Error("目标工作区已经含有暂存内容，拒绝夹带到本次提交。");
        }
        const operationId = randomUUID();
        await appendOperation(
          operationId,
          toJsonValue({
            operationType: "commit",
            operationId,
            rootSessionId: options.rootSessionId,
            ...(input.worktreeId === undefined ? {} : { worktreeId: input.worktreeId }),
            phase: "intent",
            targetHead: target.head,
            paths: requestedPaths,
          }),
        );
        let staged = false;
        let commitCommandCompleted = false;
        try {
          await runGit({
            cwd: target.root,
            arguments: ["add", "--all", "--", ...literalPathspecs(requestedPaths)],
            ...(signal === undefined ? {} : { signal }),
          });
          staged = true;
          const stagedPaths = await listGitPaths(
            target.root,
            ["diff", "--cached", "--name-only", "-z", "--"],
            signal,
          );
          if (stagedPaths.length === 0) throw new Error("指定路径没有可提交的修改。");
          if (stagedPaths.some((path) => !isCoveredByRequests(path, requestedPaths))) {
            throw new Error("Git 暂存内容超出了明确路径范围。");
          }
          if ((await resolveCommit(target.root, "HEAD", signal)) !== target.head) {
            throw new Error("目标 HEAD 在暂存后发生变化，拒绝提交。");
          }
          await runGit({
            cwd: target.root,
            arguments: ["-c", "commit.gpgsign=false", "commit", "--no-verify", "-m", input.message],
            ...(signal === undefined ? {} : { signal }),
          });
          commitCommandCompleted = true;
          staged = false;
          const commitId = await resolveCommit(target.root, "HEAD", signal);
          const commitParent = await resolveCommit(target.root, `${commitId}^`, signal);
          if (commitParent !== target.head) {
            throw new Error("提交结果不再直接基于审批时的 HEAD，结果需要人工核对。");
          }
          await appendOperation(
            operationId,
            toJsonValue({
              operationType: "commit",
              operationId,
              rootSessionId: options.rootSessionId,
              ...(input.worktreeId === undefined ? {} : { worktreeId: input.worktreeId }),
              phase: "committed",
              paths: requestedPaths,
              commit: commitId,
            }),
          );
          if (input.worktreeId !== undefined) {
            const worktree = findWorktree(input.worktreeId);
            await appendWorktree(
              freezeWorktree({
                ...worktree,
                status: "ready",
                resultCommit: commitId,
                integrated: false,
                integrationCommit: undefined,
                error: undefined,
              }),
            );
          }
          return Object.freeze({
            commit: commitId,
            ...(input.worktreeId === undefined ? {} : { worktreeId: input.worktreeId }),
            paths: Object.freeze([...requestedPaths]),
          });
        } catch (error) {
          if (staged) await unstageRequestedPaths(target.root, requestedPaths);
          try {
            await appendOperation(
              operationId,
              toJsonValue({
                operationType: "commit",
                operationId,
                rootSessionId: options.rootSessionId,
                ...(input.worktreeId === undefined ? {} : { worktreeId: input.worktreeId }),
                phase: commitCommandCompleted ? "intent" : "failed",
                paths: requestedPaths,
                error: safeErrorMessage(error),
              }),
            );
          } catch {
            // 原始失败优先返回；已有 intent 足以在恢复时阻止盲目重放。
          }
          throw error;
        }
      },
    );

  const integrate = (
    input: GitIntegrateInput,
    signal?: AbortSignal,
    beforeMutation?: BeforeGitMutation,
  ): Promise<GitIntegrationResult> =>
    serializeWorkspaceMutation(
      () => [workspaceRoot, findWorktree(input.worktreeId).path],
      signal,
      beforeMutation,
      async () => {
        if (integration.pendingOperation() !== undefined) {
          throw new Error("已有待处理的 Git 集成，请先继续或中止。");
        }
        const worktree = await inspectManagedWorktree(
          findWorktree(input.worktreeId),
          signal,
          appendWorktree,
        );
        if (worktree.status !== "ready" || worktree.resultCommit === undefined) {
          throw new Error("该 worktree 没有可集成的已提交成果。");
        }
        if (worktree.integrated) throw new Error("该 worktree 的当前成果已经集成。");
        const sourceCommit = await resolveCommit(worktree.path, input.commit, signal);
        if (sourceCommit !== worktree.resultCommit) {
          throw new Error("只能集成该受管 worktree 实际记录的结果提交。");
        }
        const containsResult = await runGit({
          cwd: worktree.path,
          arguments: ["merge-base", "--is-ancestor", sourceCommit, "HEAD"],
          ...(signal === undefined ? {} : { signal }),
          allowedExitCodes: [0, 1],
          readOnly: true,
        });
        if (containsResult.exitCode !== 0)
          throw new Error("结果提交不属于受管 worktree 当前分支。");

        const target = await loadRepository(workspaceRoot, signal);
        await rejectSubmoduleRepository(target.root, signal);
        if (
          !samePath(target.root, worktree.repositoryRoot) ||
          !samePath(target.commonGitDirectory, worktree.commonGitDirectory)
        ) {
          throw new Error("根工作区与受管 worktree 不属于同一仓库。");
        }
        if (!(await isClean(target.root, signal))) {
          throw new Error("根工作区必须保持 clean 才能开始集成。");
        }
        const allowedPaths = await changedPathsForCommit(target.root, sourceCommit, signal);
        if (allowedPaths.length === 0) throw new Error("结果提交没有可集成的文件变化。");
        return integration.stage(
          {
            root: target.root,
            targetHead: target.head,
            worktreeId: worktree.id,
            sourceCommit,
            allowedPaths,
          },
          signal,
        );
      },
    );

  const resolveIntegration = (
    input: ResolveGitIntegrationInput,
    signal?: AbortSignal,
    beforeMutation?: BeforeGitMutation,
  ): Promise<GitIntegrationResolution> =>
    serializeWorkspaceMutation(
      () => [workspaceRoot],
      signal,
      beforeMutation,
      async () => {
        const operation = integration.pendingOperation();
        if (operation === undefined) throw new Error("当前没有待处理的 Git 集成。");
        const worktree = findWorktree(operation.worktreeId);
        const target = await loadRepository(workspaceRoot, signal);
        await rejectSubmoduleRepository(target.root, signal);
        if (
          target.head !== operation.targetHead ||
          !samePath(target.root, worktree.repositoryRoot) ||
          !samePath(target.commonGitDirectory, worktree.commonGitDirectory)
        ) {
          throw new Error("集成目标的 HEAD 或仓库身份已经变化，拒绝继续修改。");
        }
        const resolution = await integration.resolve(target.root, operation, input.action, signal);
        if (resolution.status === "committed") {
          // 集成事实先落盘，worktree 摘要写入失败时仍可在重开后恢复交付状态。
          await appendWorktree(
            freezeWorktree({
              ...worktree,
              status: "ready",
              integrated: true,
              integrationCommit: resolution.integrationCommit,
              error: undefined,
            }),
          );
        }
        return resolution;
      },
    );

  async function resolveQueryTarget(
    worktreeId: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<RepositoryIdentity> {
    if (worktreeId === undefined) return loadRepository(workspaceRoot, signal);
    const worktree = findWorktree(worktreeId);
    if (worktree.status === "removed") throw new Error("该 worktree 已移除。");
    const actual = await loadRepository(worktree.path, signal);
    assertWorktreeIdentity(worktree, actual);
    return actual;
  }

  async function resolveCommitTarget(
    worktreeId: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<RepositoryIdentity> {
    if (worktreeId === undefined) {
      const target = await loadRepository(workspaceRoot, signal);
      await rejectSubmoduleRepository(target.root, signal);
      return target;
    }
    const worktree = await inspectManagedWorktree(findWorktree(worktreeId), signal, appendWorktree);
    if (worktree.status !== "ready") throw new Error("受管 worktree 当前不可提交。");
    if (worktree.resultCommit !== undefined && !worktree.integrated) {
      throw new Error("该 worktree 已有尚未集成的结果提交。");
    }
    const target = await loadRepository(worktree.path, signal);
    await rejectSubmoduleRepository(target.root, signal);
    return target;
  }

  return Object.freeze({
    query,
    captureApprovalState,
    createWorktree,
    inspectWorktree,
    removeWorktree,
    commit,
    integrate,
    resolveIntegration,
    listWorktrees: () =>
      Object.freeze(
        [...managedWorktrees.values()].sort((left, right) => left.id.localeCompare(right.id)),
      ),
  });
}

async function captureRepositoryApprovalSnapshot(options: {
  repository: RepositoryIdentity;
  paths?: readonly string[];
  additionalPaths?: readonly string[];
  ref?: string;
  includeIgnored: boolean;
  budget: ApprovalCaptureBudget;
  signal?: AbortSignal;
}): Promise<ApprovalRepositorySnapshot> {
  const before = await captureApprovalControl(options);
  const paths = new Set(before.paths);
  for (const path of options.paths ?? []) paths.add(path);
  for (const path of options.additionalPaths ?? []) paths.add(path);
  if (paths.size > MAXIMUM_APPROVAL_PATHS) {
    throw new Error("审批指纹涉及的文件数量超过可靠检查上限。");
  }
  const files: ApprovalFileSnapshot[] = [];
  for (const path of [...paths].sort()) {
    files.push(
      await fingerprintRepositoryPath(
        options.repository.root,
        path,
        options.budget,
        options.signal,
      ),
    );
  }
  const after = await captureApprovalControl(options);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("Git 状态在审批指纹采集期间发生变化，请重试。");
  }
  return Object.freeze({ control: before, files: Object.freeze(files) });
}

async function captureApprovalControl(options: {
  repository: RepositoryIdentity;
  paths?: readonly string[];
  ref?: string;
  includeIgnored: boolean;
  budget: ApprovalCaptureBudget;
  signal?: AbortSignal;
}): Promise<ApprovalControlSnapshot> {
  const repository = await loadRepository(options.repository.root, options.signal);
  if (!samePath(repository.commonGitDirectory, options.repository.commonGitDirectory)) {
    throw new Error("审批指纹采集期间仓库身份发生变化。");
  }
  const privateGitDirectoryResult = await runGit({
    cwd: repository.root,
    arguments: ["rev-parse", "--path-format=absolute", "--git-dir"],
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    readOnly: true,
  });
  const privateGitDirectory = await realpath(privateGitDirectoryResult.stdout.trim());
  const indexPathResult = await runGit({
    cwd: repository.root,
    arguments: ["rev-parse", "--path-format=absolute", "--git-path", "index"],
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    readOnly: true,
  });
  const indexPath = resolve(repository.root, indexPathResult.stdout.trim());
  const indexEntries = await runGit({
    cwd: repository.root,
    arguments: ["ls-files", "--stage", "-z"],
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    outputByteLimit: MAXIMUM_INDEX_OUTPUT_BYTES,
    readOnly: true,
  });
  if (indexEntries.truncated) throw new Error("Git index 超过审批可靠检查上限。");

  let paths: readonly string[];
  if (options.paths !== undefined) {
    paths = await listGitPaths(
      repository.root,
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ...literalPathspecs(options.paths),
      ],
      options.signal,
    );
  } else {
    const workingTreeChanges = await readWorkingTreeChanges(repository.root, options.signal);
    const changedPaths = new Set([
      ...workingTreeChanges.staged,
      ...workingTreeChanges.unstaged,
      ...workingTreeChanges.unmerged,
      ...workingTreeChanges.untracked,
    ]);
    if (options.includeIgnored) {
      for (const path of await listGitPaths(
        repository.root,
        ["ls-files", "--others", "-z"],
        options.signal,
      )) {
        changedPaths.add(path);
      }
    }
    paths = Object.freeze([...changedPaths].sort());
  }
  if (paths.length > MAXIMUM_APPROVAL_PATHS) {
    throw new Error("审批指纹涉及的文件数量超过可靠检查上限。");
  }
  const resolvedRef =
    options.ref === undefined
      ? undefined
      : await resolveCommit(repository.root, options.ref, options.signal);
  // status/diff 可能刷新 Git index 的 stat cache；所有 Git 读取结束后再取内容指纹。
  const indexFile = await fingerprintAbsoluteFile(
    indexPath,
    indexPath,
    options.budget,
    options.signal,
  );
  return Object.freeze({
    repositoryRoot: repository.root,
    commonGitDirectory: repository.commonGitDirectory,
    privateGitDirectory,
    head: repository.head,
    branch: repository.branch,
    indexFile,
    indexEntriesDigest: createHash("sha256").update(indexEntries.stdout).digest("hex"),
    paths: Object.freeze([...paths]),
    ...(resolvedRef === undefined ? {} : { resolvedRef }),
  });
}

async function fingerprintRepositoryPath(
  root: string,
  path: string,
  budget: ApprovalCaptureBudget,
  signal?: AbortSignal,
): Promise<ApprovalFileSnapshot> {
  const segments = path.replaceAll("\\", "/").split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
    segments[0]?.toLocaleLowerCase("en-US") === ".git"
  ) {
    throw new Error("Git 返回了无法安全检查的工作区路径。");
  }
  const absolutePath = resolve(root, ...segments);
  assertPathWithin(root, absolutePath, false);
  let pathStats: Awaited<ReturnType<typeof lstat>>;
  try {
    pathStats = await lstat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      countApprovalFile(budget, 0);
      return Object.freeze({ path, type: "missing" });
    }
    throw error;
  }
  if (pathStats.isSymbolicLink()) {
    const linkTarget = await readlink(absolutePath);
    countApprovalFile(budget, Buffer.byteLength(linkTarget));
    return Object.freeze({
      path,
      type: "symlink",
      mode: pathStats.mode,
      linkTarget,
    });
  }
  if (pathStats.isDirectory()) {
    countApprovalFile(budget, 0);
    return Object.freeze({ path, type: "directory", mode: pathStats.mode });
  }
  if (!pathStats.isFile()) {
    countApprovalFile(budget, 0);
    return Object.freeze({ path, type: "other", mode: pathStats.mode });
  }
  const actualPath = await realpath(absolutePath);
  assertPathWithin(root, actualPath, false);
  return fingerprintAbsoluteFile(path, actualPath, budget, signal);
}

async function fingerprintAbsoluteFile(
  label: string,
  absolutePath: string,
  budget: ApprovalCaptureBudget,
  signal?: AbortSignal,
): Promise<ApprovalFileSnapshot> {
  let fileHandle: Awaited<ReturnType<typeof open>>;
  try {
    fileHandle = await open(absolutePath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      countApprovalFile(budget, 0);
      return Object.freeze({ path: label, type: "missing" });
    }
    throw error;
  }
  try {
    const before = await fileHandle.stat();
    if (!before.isFile()) throw new Error("审批指纹只能读取普通文件内容。");
    if (before.size > MAXIMUM_APPROVAL_FILE_BYTES) {
      throw new Error("审批指纹遇到超过单文件可靠检查上限的内容。");
    }
    countApprovalFile(budget, before.size);
    const contentHash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytesReadTotal = 0;
    while (true) {
      if (signal?.aborted) throw new GitCommandAbortedError();
      const { bytesRead } = await fileHandle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      bytesReadTotal += bytesRead;
      if (bytesReadTotal > MAXIMUM_APPROVAL_FILE_BYTES) {
        throw new Error("审批指纹采集期间文件超过可靠检查上限。");
      }
      contentHash.update(buffer.subarray(0, bytesRead));
    }
    const after = await fileHandle.stat();
    if (
      bytesReadTotal !== before.size ||
      after.size !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mtimeMs !== before.mtimeMs
    ) {
      throw new Error("文件在审批指纹采集期间发生变化，请重试。");
    }
    return Object.freeze({
      path: label,
      type: "file",
      mode: before.mode,
      size: before.size,
      digest: contentHash.digest("hex"),
    });
  } finally {
    await fileHandle.close();
  }
}

function countApprovalFile(budget: ApprovalCaptureBudget, bytes: number): void {
  budget.files += 1;
  budget.bytes += bytes;
  if (budget.files > MAXIMUM_APPROVAL_PATHS || budget.bytes > MAXIMUM_APPROVAL_TOTAL_BYTES) {
    throw new Error("审批指纹超过可靠检查上限。");
  }
}
async function loadRepository(cwd: string, signal?: AbortSignal): Promise<RepositoryIdentity> {
  let actualCwd: string;
  try {
    actualCwd = await realpath(cwd);
    if (!(await stat(actualCwd)).isDirectory()) throw new Error("目标不是目录。");
  } catch {
    throw new Error("Git 工作目录不存在或无法读取。");
  }
  const inside = await runGit({
    cwd: actualCwd,
    arguments: ["rev-parse", "--is-inside-work-tree"],
    ...(signal === undefined ? {} : { signal }),
    readOnly: true,
  });
  if (inside.stdout.trim() !== "true") throw new Error("目标不是普通 Git 工作树。");
  const bare = await runGit({
    cwd: actualCwd,
    arguments: ["rev-parse", "--is-bare-repository"],
    ...(signal === undefined ? {} : { signal }),
    readOnly: true,
  });
  if (bare.stdout.trim() !== "false") throw new Error("暂不支持裸仓库。");
  const rootResult = await runGit({
    cwd: actualCwd,
    arguments: ["rev-parse", "--path-format=absolute", "--show-toplevel"],
    ...(signal === undefined ? {} : { signal }),
    readOnly: true,
  });
  const commonResult = await runGit({
    cwd: actualCwd,
    arguments: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ...(signal === undefined ? {} : { signal }),
    readOnly: true,
  });
  const root = await realpath(rootResult.stdout.trim());
  const commonGitDirectory = await realpath(commonResult.stdout.trim());
  const head = await resolveCommit(root, "HEAD", signal);
  const branchResult = await runGit({
    cwd: root,
    arguments: ["symbolic-ref", "--quiet", "--short", "HEAD"],
    ...(signal === undefined ? {} : { signal }),
    allowedExitCodes: [0, 1],
    readOnly: true,
  });
  return Object.freeze({
    root,
    commonGitDirectory,
    head,
    branch: branchResult.exitCode === 0 ? branchResult.stdout.trim() : null,
  });
}

async function rejectSubmoduleRepository(root: string, signal?: AbortSignal): Promise<void> {
  const result = await runGit({
    cwd: root,
    arguments: ["ls-files", "--stage", "-z"],
    ...(signal === undefined ? {} : { signal }),
    outputByteLimit: MAXIMUM_INDEX_OUTPUT_BYTES,
    readOnly: true,
  });
  if (result.truncated) throw new Error("仓库索引过大，无法可靠检查 submodule。");
  if (splitNull(result.stdout).some((entry) => entry.startsWith("160000 "))) {
    throw new Error("暂不支持含 submodule 的可写仓库。");
  }
}

async function resolveCommit(root: string, ref: string, signal?: AbortSignal): Promise<string> {
  assertNonEmptyText(ref, "ref", 512);
  if (ref.startsWith("-") || /[\0\r\n]/u.test(ref)) throw new Error("ref 格式不安全。");
  const result = await runGit({
    cwd: root,
    arguments: ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    ...(signal === undefined ? {} : { signal }),
    readOnly: true,
  });
  const commit = result.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/u.test(commit)) throw new Error("ref 未解析为唯一提交。");
  return commit;
}

async function inspectManagedWorktree(
  worktree: ManagedWorktree,
  signal: AbortSignal | undefined,
  append: (worktree: ManagedWorktree) => Promise<void>,
): Promise<ManagedWorktree> {
  if (worktree.status === "removed") return worktree;
  try {
    const actual = await loadRepository(worktree.path, signal);
    assertWorktreeIdentity(worktree, actual);
    const containsBase = await runGit({
      cwd: actual.root,
      arguments: ["merge-base", "--is-ancestor", worktree.baseCommit, "HEAD"],
      ...(signal === undefined ? {} : { signal }),
      allowedExitCodes: [0, 1],
      readOnly: true,
    });
    if (containsBase.exitCode !== 0) throw new Error("worktree 当前提交不再包含记录的创建基线。");
    if (worktree.status === "ready" && worktree.error === undefined) return worktree;
    const ready = freezeWorktree({ ...worktree, status: "ready", error: undefined });
    await append(ready);
    return ready;
  } catch (error) {
    const missing = !(await pathExists(worktree.path));
    const updated = freezeWorktree({
      ...worktree,
      status: missing ? "missing" : "error",
      error: safeErrorMessage(error),
    });
    if (updated.status !== worktree.status || updated.error !== worktree.error)
      await append(updated);
    return updated;
  }
}

function assertWorktreeIdentity(worktree: ManagedWorktree, actual: RepositoryIdentity): void {
  if (
    !samePath(actual.root, worktree.path) ||
    !samePath(actual.commonGitDirectory, worktree.commonGitDirectory) ||
    actual.branch !== worktree.branch
  ) {
    throw new Error("worktree 路径、仓库身份或分支已经变化。");
  }
}

async function normalizeRequestedPaths(
  root: string,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<string[]> {
  if (paths.length === 0) throw new Error("至少需要一个明确提交路径。");
  const rootIdentity = await realpath(root);
  const normalizedPaths = new Set<string>();
  for (const inputPath of paths) {
    assertNonEmptyText(inputPath, "path", 4096);
    if (isAbsolute(inputPath) || /[\0\r\n]/u.test(inputPath))
      throw new Error("提交路径必须是相对路径。");
    const normalized = inputPath.replaceAll("\\", "/").replace(/^\.\//u, "");
    const segments = normalized.split("/");
    if (
      normalized === "." ||
      normalized.length === 0 ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
      segments[0]?.toLocaleLowerCase("en-US") === ".git"
    ) {
      throw new Error("提交路径越界或指向 Git 元数据。");
    }
    const absolutePath = resolve(rootIdentity, ...segments);
    assertPathWithin(rootIdentity, absolutePath, false);
    let current = rootIdentity;
    for (const segment of segments) {
      current = resolve(current, segment);
      try {
        const currentStats = await lstat(current);
        if (currentStats.isSymbolicLink()) throw new Error("提交路径不能穿过符号链接或 junction。");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
    normalizedPaths.add(segments.join("/"));
  }
  const result = [...normalizedPaths].sort();
  await rejectTrackedLinks(rootIdentity, result, signal);
  return result;
}

async function rejectTrackedLinks(
  root: string,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  const result = await runGit({
    cwd: root,
    arguments: ["ls-files", "--stage", "-z", "--", ...literalPathspecs(paths)],
    ...(signal === undefined ? {} : { signal }),
    outputByteLimit: MAXIMUM_INDEX_OUTPUT_BYTES,
    readOnly: true,
  });
  if (result.truncated) throw new Error("Git 路径结果超过安全边界。");
  if (splitNull(result.stdout).some((entry) => /^(120000|160000) /u.test(entry))) {
    throw new Error("提交路径不能包含符号链接或 submodule。");
  }
}

function literalPathspecs(paths: readonly string[]): string[] {
  return paths.map((path) => `:(literal)${path}`);
}

async function changedPathsForCommit(
  root: string,
  commit: string,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  return listGitPaths(
    root,
    ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", commit],
    signal,
  );
}

async function findUntrackedIntegrationCollisions(
  root: string,
  allowedPaths: readonly string[],
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const relatedPathspecs = literalPathspecs(pathsAndAncestors(allowedPaths));
  const untrackedPaths = await listGitPaths(
    root,
    ["ls-files", "--others", "-z", "--", ...relatedPathspecs],
    signal,
  );
  return Object.freeze(
    untrackedPaths.filter((untrackedPath) =>
      allowedPaths.some((allowedPath) => pathsOverlap(untrackedPath, allowedPath)),
    ),
  );
}

async function assertNoUntrackedIntegrationCollisions(
  root: string,
  allowedPaths: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  const collisions = await findUntrackedIntegrationCollisions(root, allowedPaths, signal);
  if (collisions.length > 0) {
    throw new Error(
      `根工作区存在会被集成覆盖的未跟踪或 ignored 路径：${collisions[0] ?? "未知路径"}`,
    );
  }
}

async function readWorkingTreeChanges(
  root: string,
  signal?: AbortSignal,
): Promise<WorkingTreeChangeSet> {
  const [staged, unstaged, unmerged, untracked] = await Promise.all([
    listGitPaths(root, ["diff", "--cached", "--name-only", "-z", "--"], signal),
    listGitPaths(root, ["diff", "--name-only", "-z", "--"], signal),
    listGitPaths(root, ["diff", "--name-only", "--diff-filter=U", "-z", "--"], signal),
    listGitPaths(root, ["ls-files", "--others", "--exclude-standard", "-z"], signal),
  ]);
  return Object.freeze({ staged, unstaged, unmerged, untracked });
}

async function listGitPaths(
  root: string,
  commandArguments: readonly string[],
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const result = await runGit({
    cwd: root,
    arguments: commandArguments,
    ...(signal === undefined ? {} : { signal }),
    outputByteLimit: MAXIMUM_INDEX_OUTPUT_BYTES,
    readOnly: true,
  });
  if (result.truncated) throw new Error("Git 路径结果超过安全边界。");
  return Object.freeze(splitNull(result.stdout).map((path) => path.replaceAll("\\", "/")));
}

async function isClean(root: string, signal?: AbortSignal): Promise<boolean> {
  const workingTreeChanges = await readWorkingTreeChanges(root, signal);
  return !hasWorkingTreeChanges(workingTreeChanges);
}

async function isCleanForRemoval(root: string, signal?: AbortSignal): Promise<boolean> {
  if (!(await isClean(root, signal))) return false;
  return (await listGitPaths(root, ["ls-files", "--others", "-z"], signal)).length === 0;
}
async function hasStagedChanges(root: string, signal?: AbortSignal): Promise<boolean> {
  const result = await runGit({
    cwd: root,
    arguments: ["diff", "--cached", "--quiet", "--exit-code", "--"],
    ...(signal === undefined ? {} : { signal }),
    allowedExitCodes: [0, 1],
    readOnly: true,
  });
  return result.exitCode === 1;
}

async function unstageRequestedPaths(root: string, paths: readonly string[]): Promise<void> {
  try {
    await runGit({
      cwd: root,
      arguments: ["restore", "--source=HEAD", "--staged", "--", ...literalPathspecs(paths)],
    });
  } catch {
    // 保留原始错误；调用方的 intent 记录会把可能残留的暂存状态暴露给恢复流程。
  }
}

async function assertBranchMissing(
  root: string,
  branch: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await runGit({
    cwd: root,
    arguments: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    ...(signal === undefined ? {} : { signal }),
    allowedExitCodes: [0, 1],
    readOnly: true,
  });
  if (result.exitCode === 0) throw new Error("目标 worktree 分支已存在。");
}

async function ensureManagedDirectory(base: string, managed: string): Promise<void> {
  await mkdir(managed, { recursive: true });
  const [actualBase, actualManaged] = await Promise.all([realpath(base), realpath(managed)]);
  if (!samePath(actualBase, base) || !samePath(actualManaged, managed)) {
    throw new Error("worktree 管理目录不能经过符号链接或 junction。");
  }
  assertPathWithin(actualBase, actualManaged, false);
}

async function assertPathMissing(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error("目标 worktree 路径已存在，拒绝覆盖。");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertManagedWorktreePath(worktree: ManagedWorktree, managedDirectory: string): void {
  if (worktree.rootSessionId === "" || !samePath(resolve(worktree.path), worktree.path)) {
    throw new Error("持久化的 worktree 路径无效。");
  }
  assertPathWithin(managedDirectory, worktree.path, false);
}

function assertPathWithin(parent: string, child: string, allowEqual: boolean): void {
  const pathDifference = relative(parent, child);
  if (
    (!allowEqual && pathDifference.length === 0) ||
    pathDifference === ".." ||
    pathDifference.startsWith(`..${sep}`) ||
    isAbsolute(pathDifference)
  ) {
    throw new Error("路径超出受管目录。");
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

function pathsAndAncestors(paths: readonly string[]): readonly string[] {
  const relatedPaths = new Set<string>();
  for (const path of paths) {
    const segments = path.replaceAll("\\", "/").split("/");
    for (let segmentCount = 1; segmentCount <= segments.length; segmentCount += 1) {
      relatedPaths.add(segments.slice(0, segmentCount).join("/"));
    }
  }
  return Object.freeze([...relatedPaths].sort());
}

function pathsOverlap(left: string, right: string): boolean {
  const normalizeForComparison = (path: string) => {
    const normalized = path.replaceAll("\\", "/");
    return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
  };
  const normalizedLeft = normalizeForComparison(left);
  const normalizedRight = normalizeForComparison(right);
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`)
  );
}

function isCoveredByRequests(path: string, requestedPaths: readonly string[]): boolean {
  const normalized = path.replaceAll("\\", "/");
  return requestedPaths.some(
    (requested) => normalized === requested || normalized.startsWith(`${requested}/`),
  );
}

function splitNull(value: string): string[] {
  return value.split("\0").filter((entry) => entry.length > 0);
}

function hasWorkingTreeChanges(workingTreeChanges: WorkingTreeChangeSet): boolean {
  return (
    workingTreeChanges.staged.length > 0 ||
    workingTreeChanges.unstaged.length > 0 ||
    workingTreeChanges.unmerged.length > 0 ||
    workingTreeChanges.untracked.length > 0
  );
}

function restoreRecords(
  records: readonly { kind: string; key: string; payload: JsonValue }[],
  rootSessionId: string,
  managedWorktrees: Map<string, ManagedWorktree>,
  gitOperations: Map<string, JsonValue>,
): void {
  for (const record of records) {
    if (record.kind === "worktree") {
      const worktree = parseManagedWorktree(record.payload);
      if (worktree?.rootSessionId === rootSessionId && worktree.id === record.key) {
        managedWorktrees.set(worktree.id, worktree);
      }
    } else if (record.kind === "git_operation" && isObject(record.payload)) {
      if (record.payload.rootSessionId === rootSessionId)
        gitOperations.set(record.key, record.payload);
    }
  }
  for (const payload of gitOperations.values()) {
    if (!isObject(payload) || typeof payload.worktreeId !== "string") continue;
    const worktree = managedWorktrees.get(payload.worktreeId);
    if (worktree === undefined) continue;
    if (
      payload.operationType === "commit" &&
      payload.phase === "committed" &&
      typeof payload.commit === "string"
    ) {
      managedWorktrees.set(
        worktree.id,
        freezeWorktree({ ...worktree, resultCommit: payload.commit, integrated: false }),
      );
    }
    const integrationCommit = readIntegrationCommit(payload);
    if (integrationCommit !== undefined) {
      managedWorktrees.set(
        worktree.id,
        freezeWorktree({
          ...worktree,
          integrated: true,
          integrationCommit,
        }),
      );
    }
    if (payload.operationType === "remove_worktree" && payload.phase === "removed") {
      managedWorktrees.set(worktree.id, freezeWorktree({ ...worktree, status: "removed" }));
    }
  }
}

function parseManagedWorktree(value: JsonValue): ManagedWorktree | undefined {
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    typeof value.rootSessionId !== "string" ||
    typeof value.path !== "string" ||
    typeof value.repositoryRoot !== "string" ||
    typeof value.commonGitDirectory !== "string" ||
    typeof value.branch !== "string" ||
    typeof value.baseCommit !== "string" ||
    typeof value.integrated !== "boolean" ||
    !["creating", "ready", "error", "missing", "removed"].includes(String(value.status))
  ) {
    return undefined;
  }
  return freezeWorktree({
    id: value.id,
    rootSessionId: value.rootSessionId,
    ...(typeof value.memberSessionId === "string"
      ? { memberSessionId: value.memberSessionId }
      : {}),
    path: value.path,
    repositoryRoot: value.repositoryRoot,
    commonGitDirectory: value.commonGitDirectory,
    branch: value.branch,
    baseCommit: value.baseCommit,
    status: value.status as ManagedWorktreeStatus,
    integrated: value.integrated,
    ...(typeof value.resultCommit === "string" ? { resultCommit: value.resultCommit } : {}),
    ...(typeof value.integrationCommit === "string"
      ? { integrationCommit: value.integrationCommit }
      : {}),
    ...(typeof value.notice === "string" ? { notice: value.notice } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  });
}

function freezeWorktree(worktree: ManagedWorktreeInput): ManagedWorktree {
  const defined = Object.fromEntries(
    Object.entries(worktree).filter(([, value]) => value !== undefined),
  ) as ManagedWorktree;
  return Object.freeze(defined);
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function isObject(value: JsonValue): value is Readonly<{ [key: string]: JsonValue }> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSafeIdentifier(value: string, name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value)) {
    throw new Error(`${name} 不是安全的目录标识。`);
  }
}

function assertNonEmptyText(value: string, name: string, maximumLength: number): void {
  if (value.trim().length === 0 || value.length > maximumLength || value.includes("\0")) {
    throw new Error(`${name} 为空或超过允许边界。`);
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof GitCommandError || error instanceof GitCommandAbortedError) {
    return error.message;
  }
  return error instanceof Error ? error.message : "Git 操作失败。";
}
