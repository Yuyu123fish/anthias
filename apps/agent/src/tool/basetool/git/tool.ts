import type { JSONSchema7 } from "ai";
import type { JsonValue } from "../../../message.js";
import { hasOnlyKeys, isRecord } from "../../input-validation.js";
import type { AgentToolExtension } from "../../managed-tool.js";
import { managedToolPlan } from "../../managed-tool.js";
import type { BeforeGitMutation, GitWorkspace } from "./index.js";

export type GitAction = Readonly<{
  action:
    | "status"
    | "diff"
    | "log"
    | "show"
    | "branches"
    | "worktrees"
    | "create"
    | "inspect"
    | "remove"
    | "commit"
    | "integrate"
    | "continue"
    | "abort";
  worktreeId?: string;
  ref?: string;
  paths?: readonly string[];
  message?: string;
  commit?: string;
  discard?: boolean;
}>;
export type GitControls = Readonly<{
  execute(
    action: GitAction,
  ): Promise<Readonly<{ ok: true; value: string } | { ok: false; error: string }>>;
}>;
const queries = new Set(["status", "diff", "log", "show", "branches", "worktrees", "inspect"]);
export const isGitQuery = (action: GitAction) => queries.has(action.action);
const propertyText = { type: "string", minLength: 1, maxLength: 2048 } satisfies JSONSchema7;

export function createGitTools(options: {
  git: GitWorkspace;
  primary: boolean;
  memberWorktreeId?: string;
  assertIdle(id: string): void;
  assertWriteAllowed?: (toolCallId: string) => void;
  resourceState?: (toolCallId: string, state: "waiting" | "acquired" | "released") => void;
}): AgentToolExtension {
  const properties: Record<string, JSONSchema7> = {
    action: {
      type: "string",
      enum: options.primary
        ? [
            "status",
            "diff",
            "log",
            "show",
            "branches",
            "worktrees",
            "create",
            "inspect",
            "remove",
            "commit",
            "integrate",
            "continue",
            "abort",
          ]
        : ["status", "diff", "log", "show"],
    },
    ref: propertyText,
    ...(options.primary
      ? {
          worktreeId: propertyText,
          paths: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: propertyText,
          } satisfies JSONSchema7,
          message: propertyText,
          commit: propertyText,
          discard: { type: "boolean" } satisfies JSONSchema7,
        }
      : {}),
  };
  return {
    tools: () => [
      {
        definition: {
          name: "git",
          description:
            "查询本地仓库或执行受管 Git 操作。创建 worktree 仅带入明确提交。提交与集成需单独授权；成员仅能查询自己的工作区。",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["action"],
            properties,
          },
        },
        createPlan(call, mode) {
          return managedToolPlan(call, mode, async (signal) => {
            const parsed = parseGitAction(call.input);
            if (
              !options.primary &&
              (!["status", "diff", "log", "show"].includes(parsed.action) ||
                parsed.worktreeId !== undefined)
            )
              throw new Error("成员只能查询自己的工作区，不能创建 worktree、提交或集成。");
            const action: GitAction =
              !options.primary && options.memberWorktreeId
                ? { ...parsed, worktreeId: options.memberWorktreeId }
                : parsed;
            const mutation = !isGitQuery(action);
            if (mutation && action.worktreeId) options.assertIdle(action.worktreeId);
            const approvalInput = {
              ...(action.worktreeId ? { worktreeId: action.worktreeId } : {}),
              ...(action.action === "commit" && action.paths ? { paths: action.paths } : {}),
              ...(action.action === "integrate"
                ? { ref: required(action.commit, "commit"), includeRoot: true }
                : action.ref
                  ? { ref: action.ref }
                  : {}),
            };
            const fingerprint = mutation
              ? await options.git.captureApprovalState(approvalInput, signal)
              : "";
            const state = mutation ? await describeGitState(options.git, action, signal) : "";
            return {
              target:
                "Git " +
                action.action +
                (action.worktreeId ? " · " + action.worktreeId : " · 主工作区"),
              preview:
                JSON.stringify(action, null, 2) +
                (action.action === "create" ? "\n仅包含已提交版本；未提交修改不会带入。" : "") +
                (mutation ? "\n" + state + "\n状态指纹: " + fingerprint : ""),
              approval: mutation,
              async execute(signal) {
                if (!mutation) return executeGitAction(options.git, action, signal);
                options.resourceState?.(call.toolCallId, "waiting");
                try {
                  return await executeGitAction(options.git, action, signal, async () => {
                    options.resourceState?.(call.toolCallId, "acquired");
                    options.assertWriteAllowed?.(call.toolCallId);
                    if (action.worktreeId) options.assertIdle(action.worktreeId);
                    if (
                      fingerprint !==
                      (await options.git.captureApprovalState(approvalInput, signal))
                    ) {
                      throw new Error(
                        "审批期间或等待写入期间 Git 状态已经变化，请重新检查并发起操作。",
                      );
                    }
                    options.assertWriteAllowed?.(call.toolCallId);
                  });
                } finally {
                  options.resourceState?.(call.toolCallId, "released");
                }
              },
            };
          });
        },
      },
    ],
  };
}

export async function executeGitAction(
  git: GitWorkspace,
  action: GitAction,
  signal?: AbortSignal,
  beforeMutation?: BeforeGitMutation,
): Promise<string> {
  const target = action.worktreeId ? { worktreeId: action.worktreeId } : {};
  switch (action.action) {
    case "status":
    case "diff":
    case "log":
    case "show":
    case "branches":
    case "worktrees":
      return git.query(
        { action: action.action, ...target, ...(action.ref ? { ref: action.ref } : {}) },
        signal,
      );
    case "create":
      return JSON.stringify(
        await git.createWorktree(action.ref ? { ref: action.ref } : {}, signal, beforeMutation),
      );
    case "inspect":
      return JSON.stringify(
        await git.inspectWorktree(required(action.worktreeId, "worktreeId"), signal),
      );
    case "remove":
      return JSON.stringify(
        await git.removeWorktree(
          required(action.worktreeId, "worktreeId"),
          signal,
          action.discard,
          beforeMutation,
        ),
      );
    case "commit":
      if (!action.paths?.length) throw new Error("提交必须明确 paths。");
      return JSON.stringify(
        await git.commit(
          { ...target, paths: action.paths, message: required(action.message, "message") },
          signal,
          beforeMutation,
        ),
      );
    case "integrate":
      return JSON.stringify(
        await git.integrate(
          {
            worktreeId: required(action.worktreeId, "worktreeId"),
            commit: required(action.commit, "commit"),
          },
          signal,
          beforeMutation,
        ),
      );
    case "continue":
    case "abort":
      return JSON.stringify(
        await git.resolveIntegration({ action: action.action }, signal, beforeMutation),
      );
  }
}

async function describeGitState(git: GitWorkspace, action: GitAction, signal?: AbortSignal) {
  const target = action.worktreeId ? { worktreeId: action.worktreeId } : {};
  const inputs = [
    { action: "status" as const, ...target },
    { action: "diff" as const, ...target },
    { action: "show" as const, ref: "HEAD", ...target },
    ...(action.action === "integrate"
      ? [
          { action: "status" as const },
          { action: "diff" as const },
          { action: "show" as const, ref: "HEAD" },
        ]
      : []),
  ];
  const results = await Promise.allSettled(inputs.map((input) => git.query(input, signal)));
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return results.map((result) => (result.status === "fulfilled" ? result.value : "")).join("\n");
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(name + " 不能为空。");
  return value;
}
export function parseGitAction(value: JsonValue): GitAction {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["action", "worktreeId", "ref", "paths", "message", "commit", "discard"]) ||
    ![
      "status",
      "diff",
      "log",
      "show",
      "branches",
      "worktrees",
      "create",
      "inspect",
      "remove",
      "commit",
      "integrate",
      "continue",
      "abort",
    ].includes(String(value.action))
  )
    throw new Error("Git 参数无效。");
  for (const key of ["worktreeId", "ref", "message", "commit"]) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "string" ||
        !(value[key] as string).trim() ||
        (value[key] as string).length > 2048)
    )
      throw new Error(key + " 参数无效。");
  }
  if (
    value.paths !== undefined &&
    (!Array.isArray(value.paths) ||
      !value.paths.length ||
      value.paths.length > 100 ||
      !value.paths.every(
        (path) => typeof path === "string" && path.length > 0 && path.length <= 2048,
      ))
  )
    throw new Error("paths 必须是明确的文件列表。");
  if (value.discard !== undefined && typeof value.discard !== "boolean")
    throw new Error("discard 必须为布尔值。");
  return value as GitAction;
}
