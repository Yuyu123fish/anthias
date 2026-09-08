import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ActionResult } from "../agent-controls.js";
import type { AssistantToolCallPart } from "../message.js";
import { isRecord } from "../tool/input-validation.js";
import type { ToolApprovalPlan } from "../tool/tool-runner.js";
import { arePathsEqual, isPathSameOrInside } from "../tool/workspace-path.js";
import { isCommandGrant, matchesCommandGrants, normalizeCommandGrants } from "./command-grants.js";

export type WorkspaceCommand = Readonly<{ command: string; cwd: string; allowArguments?: boolean }>;
export type WorkspaceGrant = Readonly<{
  remember: boolean;
  includeMembers: boolean;
  files: boolean;
  commands: readonly WorkspaceCommand[];
}>;
export type WorkspacePermissionSnapshot = Readonly<{
  workspaceRoot: string;
  grant: WorkspaceGrant | null;
  availableCommands: readonly WorkspaceCommand[];
  revoked: boolean;
  error?: string;
}>;
export type WorkspacePermissionControls = Readonly<{
  snapshot(): WorkspacePermissionSnapshot;
  grant(
    options: Readonly<{
      remember: boolean;
      includeMembers: boolean;
      commands?: readonly WorkspaceCommand[];
    }>,
  ): Promise<ActionResult<WorkspacePermissionSnapshot>>;
  revoke(): Promise<ActionResult<WorkspacePermissionSnapshot>>;
}>;

const CHECK_COMMANDS = Object.freeze([
  "pnpm build",
  "pnpm test",
  "pnpm check",
  "pnpm lint",
  "pnpm run build",
  "pnpm run test",
  "pnpm run check",
  "pnpm run lint",
  "npm run build",
  "npm test",
  "npm run test",
  "npm run check",
  "npm run lint",
  "yarn build",
  "yarn test",
  "yarn check",
  "yarn lint",
]);
const AVAILABLE_COMMANDS = Object.freeze(
  CHECK_COMMANDS.map((command) => Object.freeze({ command, cwd: "." })),
);
type StoredPermission = {
  version: 1;
  workspaceRoot: string;
  revision: string;
  revoked: boolean;
  grant: WorkspaceGrant | null;
};

/** 授权只从独立交互入口写入；模型可维护的来源和记忆不参与该记录。 */
export function createWorkspacePermissions(options: { workspaceRoot: string; directory: string }) {
  const workspaceRoot = resolve(options.workspaceRoot);
  const directory = resolve(options.directory);
  const workspaceIdentity =
    process.platform === "win32" ? workspaceRoot.toLowerCase() : workspaceRoot;
  const filePath = join(
    directory,
    `${createHash("sha256").update(workspaceIdentity).digest("hex")}.json`,
  );
  let state: StoredPermission = {
    version: 1,
    workspaceRoot,
    revision: randomUUID(),
    revoked: false,
    grant: null,
  };
  let diskRevision: string | undefined;
  let error: string | undefined;
  let localOverride = false;
  let pendingWrites = 0;
  let persistence: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();

  function changed() {
    for (const listener of [...listeners]) listener();
  }
  function refresh() {
    if (pendingWrites > 0) return;
    try {
      if (statSync(filePath).size > 192_000) throw new Error("invalid permission record");
      const loaded: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      if (!validStoredPermission(loaded, workspaceRoot))
        throw new Error("invalid permission record");
      if (loaded.revision !== diskRevision) {
        diskRevision = loaded.revision;
        state = loaded;
        localOverride = false;
        error = undefined;
        changed();
      }
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === "ENOENT" && diskRevision === undefined)
        return;
      if (localOverride) return;
      if (!state.revoked || state.grant !== null) {
        state = { ...state, revision: randomUUID(), grant: null, revoked: true };
        changed();
      }
      error = "工作区授权记录不可读取，自动放行已暂停；请重新明确授权。";
    }
  }
  function snapshot(): WorkspacePermissionSnapshot {
    refresh();
    return Object.freeze({
      workspaceRoot,
      grant:
        state.grant === null
          ? null
          : Object.freeze({
              ...state.grant,
              commands: Object.freeze(
                state.grant.commands.map((command) => Object.freeze({ ...command })),
              ),
            }),
      availableCommands: AVAILABLE_COMMANDS,
      revoked: state.revoked,
      ...(error === undefined ? {} : { error }),
    });
  }
  async function persist(stored: StoredPermission) {
    const temporaryPath = join(directory, `${randomUUID()}.tmp`);
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temporaryPath, JSON.stringify(stored), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, filePath);
      diskRevision = stored.revision;
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
  function save(stored: StoredPermission) {
    pendingWrites++;
    const completion = persistence.then(() => persist(stored));
    persistence = completion.catch(() => undefined);
    return completion.finally(() => {
      pendingWrites--;
    });
  }
  async function grant(
    input: Readonly<{
      remember: boolean;
      includeMembers: boolean;
      commands?: readonly WorkspaceCommand[];
    }>,
  ): Promise<ActionResult<WorkspacePermissionSnapshot>> {
    if (typeof input.remember !== "boolean" || typeof input.includeMembers !== "boolean")
      return { ok: false, error: "授权选项必须明确选择是否记住和是否包含成员。" };
    if (pendingWrites > 0) return { ok: false, error: "授权变更正在保存，请稍后重试。" };
    let commands: readonly WorkspaceCommand[];
    try {
      commands = normalizeCommandGrants(input.commands ?? AVAILABLE_COMMANDS, workspaceRoot);
    } catch (failure) {
      return { ok: false, error: failure instanceof Error ? failure.message : "命令授权无效。" };
    }
    error = undefined;
    const candidate: StoredPermission = {
      version: 1,
      workspaceRoot,
      revision: randomUUID(),
      revoked: false,
      grant: {
        remember: input.remember,
        includeMembers: input.includeMembers,
        files: true,
        commands,
      },
    };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > 192_000)
      return { ok: false, error: "命令授权记录过大，请缩短命令或减少入口。" };
    error = undefined;
    state = candidate;
    localOverride = !input.remember;
    const grantedRevision = state.revision;
    changed();
    try {
      // 会话授权也清除旧的跨启动允许，避免新的缩小范围在重启后被旧记录抵消。
      await save({ ...state, grant: input.remember ? state.grant : null });
      return { ok: true, value: snapshot() };
    } catch {
      if (state.revision !== grantedRevision)
        return { ok: false, error: "授权保存失败，期间发生的撤销仍有效。" };
      localOverride = true;
      if (state.grant) state = { ...state, grant: { ...state.grant, remember: false } };
      error = "本次会话授权已生效，但跨启动设置未保存；请检查授权目录权限。";
      return { ok: false, error };
    }
  }
  async function revoke(): Promise<ActionResult<WorkspacePermissionSnapshot>> {
    error = undefined;
    // 先让同一 Agent 树失效，再等待磁盘；待审批回调不能穿过保存窗口执行。
    state = { version: 1, workspaceRoot, revision: randomUUID(), revoked: true, grant: null };
    localOverride = true;
    changed();
    try {
      await save(state);
      return { ok: true, value: snapshot() };
    } catch {
      error = "本次已撤销，跨启动撤销未保存；旧记录可能仍存在，请检查授权目录权限。";
      return { ok: false, error };
    }
  }
  function matches(
    call: AssistantToolCallPart,
    approval: ToolApprovalPlan,
    actualWorkspace: string,
    member: boolean,
  ) {
    refresh();
    const currentGrant = state.grant;
    if (!currentGrant || state.revoked || (member && !currentGrant.includeMembers)) return false;
    if (!member && !arePathsEqual(actualWorkspace, workspaceRoot)) return false;
    if (call.invalid || call.toolName !== approval.toolName) return false;
    if (
      (call.toolName === "write_file" || call.toolName === "edit_file") &&
      approval.ruleId === "file.workspace_exact_review"
    ) {
      return (
        currentGrant.files &&
        isPathSameOrInside(actualWorkspace, resolve(actualWorkspace, approval.target))
      );
    }
    if (
      call.toolName !== "execute_command" ||
      approval.ruleId !== "command.current_user_review" ||
      !isRecord(call.input)
    )
      return false;
    if (
      !isPathSameOrInside(actualWorkspace, resolve(actualWorkspace, approval.target)) ||
      typeof call.input.command !== "string"
    )
      return false;
    return matchesCommandGrants(
      call.input.command,
      resolve(actualWorkspace, approval.target),
      actualWorkspace,
      currentGrant.commands,
    );
  }
  refresh();
  return {
    directory,
    snapshot,
    grant,
    revoke,
    matches,
    revision() {
      refresh();
      return state.revision;
    },
    isRevoked() {
      refresh();
      return state.revoked;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type WorkspacePermissions = ReturnType<typeof createWorkspacePermissions>;

function validStoredPermission(value: unknown, workspaceRoot: string): value is StoredPermission {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.workspaceRoot !== "string" ||
    !arePathsEqual(value.workspaceRoot, workspaceRoot) ||
    typeof value.revision !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(value.revision) ||
    typeof value.revoked !== "boolean"
  )
    return false;
  if (value.grant === null) return true;
  if (
    !isRecord(value.grant) ||
    value.revoked ||
    value.grant.remember !== true ||
    typeof value.grant.includeMembers !== "boolean" ||
    value.grant.files !== true ||
    !Array.isArray(value.grant.commands)
  )
    return false;
  return value.grant.commands.length <= 49 && value.grant.commands.every(isCommandGrant);
}
