import type { JSONSchema7 } from "ai";
import type { AssistantToolCallPart, JsonValue } from "../message.js";
import type { CollaborationAction, MultiAgent } from "../multi-agent/index.js";
import type { ModelToolDefinition } from "./definitions.js";
import { hasOnlyKeys, isRecord } from "./input-validation.js";
import { type AgentToolExtension, managedToolPlan } from "./managed-tool.js";

const text = { type: "string", minLength: 1, maxLength: 16_384 } satisfies JSONSchema7;
const identity = { type: "string", minLength: 1, maxLength: 100 } satisfies JSONSchema7;
function define(
  name: string,
  description: string,
  properties: Record<string, JSONSchema7>,
  required: string[],
): ModelToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: "object", additionalProperties: false, properties, required },
  };
}
const definitions: readonly ModelToolDefinition[] = [
  define(
    "agent_recover_workspace",
    "根对本执行器持有的原命令进程与输出流做有界清理和重新检查，成功后解除对应工作区阻塞；不重放工具。限时清理未完成可稍后重试本工具，不要重试普通命令。无法核验归属或持续失败时，由用户外部清理后直接输入 /agent recover <blockId> confirm-cleanup；普通对话不能代替确认。",
    { blockId: identity },
    ["blockId"],
  ),
  define(
    "agent_spawn",
    "创建持续成员并分配任务，立即返回成员 ID。默认可写并共享根工作区；可写与工作树独立，需要隔离时根显式提供已创建的 worktreeId。只有根可创建成员。",
    { task: text, name: identity, writable: { type: "boolean" }, worktreeId: identity },
    ["task"],
  ),
  define("agent_list", "查看同组成员、正式任务与运行时状态；不启动模型。", {}, []),
  define(
    "agent_wait",
    "有界等待任一成员完成或需要处理；超时返回状态，可取消。",
    {
      memberIds: { type: "array", items: identity, minItems: 1, maxItems: 9 },
      timeoutMs: { type: "integer", minimum: 1, maximum: 60_000 },
    },
    ["memberIds"],
  ),
  define(
    "agent_stop",
    "暂停指定成员；release=true 关闭成员。等待执行资源收口，保留代码、邮箱与历史，只有根可调用。",
    { memberId: identity, release: { type: "boolean" } },
    ["memberId"],
  ),
  define(
    "agent_result",
    "读取成员公开结果；根还可读取分页历史与引用产物，普通成员不能读取同伴私有历史。",
    {
      memberId: identity,
      offset: { type: "integer", minimum: 0 },
      artifactId: identity,
      cursor: text,
    },
    ["memberId"],
  ),
  define(
    "agent_resume",
    "核对原 Session 与工作区后继续暂停成员；用户暂停只能由用户继续，不重放历史副作用。",
    { memberId: identity, task: text },
    ["memberId"],
  ),
  define(
    "agent_reopen",
    "根显式重新打开已关闭成员，核对原 Session 与工作区；普通消息不能重新打开。",
    { memberId: identity },
    ["memberId"],
  ),
  define(
    "agent_task",
    "根分配正式任务；成员只能更新自己的任务完成或阻塞结果，消息不能替代根任务。",
    {
      action: { type: "string", enum: ["assign", "update"] },
      memberId: identity,
      task: text,
      taskId: identity,
      status: { type: "string", enum: ["completed", "blocked"] },
      result: text,
    },
    ["action"],
  ),
  define(
    "agent_message",
    "向根或同组成员发送持久消息。运行中在工具批次后的安全点消费，空闲成员可自动唤醒，暂停成员只收件，关闭成员拒收。不要求逐条回复确认。",
    { memberId: identity, content: text },
    ["memberId", "content"],
  ),
  define(
    "agent_notes",
    "读取或追加本组受管共享笔记；只有根可携带 expectedVersion 重整全文。笔记不是授权或控制文件，修改不会唤醒成员。",
    {
      action: { type: "string", enum: ["read", "append", "replace"] },
      content: { type: "string", maxLength: 16_384 },
      expectedVersion: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    },
    ["action"],
  ),
  define(
    "agent_workspace",
    "根为已停止的成员绑定已创建的受管工作树；省略 worktreeId 回到根工作区。不复制未提交修改或搭建运行环境。",
    { memberId: identity, worktreeId: identity },
    ["memberId"],
  ),
  define(
    "agent_group",
    "根暂停或明确继续整个协作群组；成员不能控制群组，用户暂停不能由根自行解除。",
    { action: { type: "string", enum: ["stop", "continue"] } },
    ["action"],
  ),
];
const memberToolNames = new Set([
  "agent_list",
  "agent_result",
  "agent_task",
  "agent_message",
  "agent_notes",
]);
const memberActions = new Set([
  "list",
  "result",
  "task_update",
  "message",
  "notes_read",
  "notes_append",
]);

export function createMultiAgentTools(options: {
  callerSessionId: string;
  rootSessionId: string;
  coordinator: Pick<MultiAgent, "execute">;
}): AgentToolExtension {
  const primary = options.callerSessionId === options.rootSessionId;
  const restriction = "普通成员只能查询公开状态与结果、更新自己的任务、发送消息和追加共享笔记。";
  const visible = (definition: ModelToolDefinition) =>
    primary || memberToolNames.has(definition.name);
  function definitionForCaller(definition: ModelToolDefinition): ModelToolDefinition {
    if (primary) return definition;
    if (definition.name === "agent_task")
      return define(
        "agent_task",
        "更新自己任务的完成或阻塞结果。",
        {
          action: { type: "string", const: "update" },
          taskId: identity,
          status: { type: "string", enum: ["completed", "blocked"] },
          result: text,
        },
        ["action", "taskId", "status", "result"],
      );
    if (definition.name === "agent_notes")
      return define(
        "agent_notes",
        "读取或追加同组受管共享笔记，不修改任务、权限或成员状态。",
        { action: { type: "string", enum: ["read", "append"] }, content: text },
        ["action"],
      );
    if (definition.name === "agent_result")
      return define(
        "agent_result",
        "读取同组成员公开结果摘要，不读取完整历史或私有产物。",
        { memberId: identity },
        ["memberId"],
      );
    return definition;
  }
  return {
    tools: () =>
      definitions
        .filter(visible)
        .map(definitionForCaller)
        .map((definition) => ({
          definition,
          createPlan(call, mode) {
            return managedToolPlan(call, mode, async () => {
              const action = parseCollaborationCall(call);
              if (
                !primary &&
                (!memberActions.has(action.action) ||
                  (action.action === "result" &&
                    (action.offset !== undefined ||
                      action.artifactId !== undefined ||
                      action.cursor !== undefined)))
              )
                throw new Error(restriction);
              return {
                target: call.toolName + " · " + options.callerSessionId,
                preview: JSON.stringify(action, null, 2),
                // 这里只管理组内协作；代码、命令和 Git 副作用仍由各自工具审批。
                approval: false,
                execute: (signal) =>
                  options.coordinator.execute(options.callerSessionId, action, signal),
              };
            });
          },
        })),
    rejectUnavailableTool(call, mode) {
      if (
        !definitions.some((definition) => definition.name === call.toolName && !visible(definition))
      )
        return null;
      return managedToolPlan(call, mode, async () => {
        parseCollaborationCall(call);
        throw new Error(restriction);
      });
    },
  };
}

export function collaborationToolCall(
  action: CollaborationAction,
): Readonly<{ toolName: string; input: JsonValue }> {
  const { action: operation, ...input } = action;
  const simpleNames: Record<string, string> = {
    spawn: "agent_spawn",
    list: "agent_list",
    wait: "agent_wait",
    stop: "agent_stop",
    result: "agent_result",
    resume: "agent_resume",
    reopen: "agent_reopen",
    message: "agent_message",
    workspace_bind: "agent_workspace",
    workspace_recover: "agent_recover_workspace",
  };
  const simpleName = simpleNames[operation];
  if (simpleName) return { toolName: simpleName, input };
  if (operation === "task_assign" || operation === "task_update")
    return {
      toolName: "agent_task",
      input: { ...input, action: operation === "task_assign" ? "assign" : "update" },
    };
  if (operation === "notes_read" || operation === "notes_append" || operation === "notes_replace")
    return { toolName: "agent_notes", input: { ...input, action: operation.slice(6) } };
  if (operation === "group_stop" || operation === "group_continue")
    return { toolName: "agent_group", input: { action: operation.slice(6) } };
  throw new Error("未知协作操作。");
}

function parseCollaborationCall(call: AssistantToolCallPart): CollaborationAction {
  if (!isRecord(call.input)) throw new Error("协作参数必须为对象。");
  const input = call.input;
  function keys(allowed: string[]) {
    if (!hasOnlyKeys(input, allowed)) throw new Error("协作参数包含未知字段。");
  }
  function string(name: string, optional = false, allowEmpty = false): string | undefined {
    const value = input[name];
    if (value === undefined && optional) return undefined;
    if (
      typeof value !== "string" ||
      (!allowEmpty && !value.trim()) ||
      Buffer.byteLength(value) > 16 * 1024
    )
      throw new Error(name + " 必须是文本，且不超过 16 KiB。");
    return value;
  }
  function required(name: string): string {
    return string(name) ?? "";
  }
  function boolean(name: string): boolean | undefined {
    if (input[name] !== undefined && typeof input[name] !== "boolean")
      throw new Error(name + " 必须为布尔值。");
    return input[name] as boolean | undefined;
  }
  function number(name: string, maximum: number) {
    const value = input[name];
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum)
      throw new Error(name + " 超出范围。");
    return value;
  }
  switch (call.toolName) {
    case "agent_recover_workspace":
      keys(["blockId"]);
      return { action: "workspace_recover", blockId: required("blockId") };
    case "agent_spawn": {
      keys(["task", "name", "writable", "worktreeId"]);
      const name = string("name", true);
      const writable = boolean("writable");
      const worktreeId = string("worktreeId", true);
      return {
        action: "spawn",
        task: required("task"),
        ...(name === undefined ? {} : { name }),
        ...(writable === undefined ? {} : { writable }),
        ...(worktreeId === undefined ? {} : { worktreeId }),
      };
    }
    case "agent_list":
      keys([]);
      return { action: "list" };
    case "agent_wait": {
      keys(["memberIds", "timeoutMs"]);
      if (
        !Array.isArray(input.memberIds) ||
        input.memberIds.length < 1 ||
        input.memberIds.length > 9 ||
        !input.memberIds.every((id) => typeof id === "string" && id.trim().length > 0)
      )
        throw new Error("memberIds 需要一至九个成员 ID。");
      const timeoutMs = number("timeoutMs", 60_000);
      if (timeoutMs === 0) throw new Error("timeoutMs 必须大于零。");
      return {
        action: "wait",
        memberIds: input.memberIds,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      };
    }
    case "agent_stop": {
      keys(["memberId", "release"]);
      const release = boolean("release");
      return {
        action: "stop",
        memberId: required("memberId"),
        ...(release === undefined ? {} : { release }),
      };
    }
    case "agent_result": {
      keys(["memberId", "offset", "artifactId", "cursor"]);
      const offset = number("offset", Number.MAX_SAFE_INTEGER);
      const artifactId = string("artifactId", true);
      const cursor = string("cursor", true);
      return {
        action: "result",
        memberId: required("memberId"),
        ...(offset === undefined ? {} : { offset }),
        ...(artifactId === undefined ? {} : { artifactId }),
        ...(cursor === undefined ? {} : { cursor }),
      };
    }
    case "agent_resume": {
      keys(["memberId", "task"]);
      const task = string("task", true);
      return {
        action: "resume",
        memberId: required("memberId"),
        ...(task === undefined ? {} : { task }),
      };
    }
    case "agent_reopen":
      keys(["memberId"]);
      return { action: "reopen", memberId: required("memberId") };
    case "agent_task": {
      const operation = required("action");
      if (operation === "assign") {
        keys(["action", "memberId", "task"]);
        return { action: "task_assign", memberId: required("memberId"), task: required("task") };
      }
      if (operation === "update") {
        keys(["action", "taskId", "status", "result"]);
        if (input.status !== "completed" && input.status !== "blocked")
          throw new Error("任务状态只能为 completed 或 blocked。");
        return {
          action: "task_update",
          taskId: required("taskId"),
          status: input.status,
          result: required("result"),
        };
      }
      throw new Error("未知任务操作。");
    }
    case "agent_message":
      keys(["memberId", "content"]);
      return {
        action: "message",
        memberId: required("memberId"),
        content: required("content"),
        messageId: call.toolCallId,
      };
    case "agent_notes": {
      const operation = required("action");
      if (operation === "read") {
        keys(["action"]);
        return { action: "notes_read" };
      }
      if (operation === "append") {
        keys(["action", "content"]);
        return { action: "notes_append", content: required("content") };
      }
      if (operation === "replace") {
        keys(["action", "content", "expectedVersion"]);
        const expectedVersion = required("expectedVersion");
        if (!/^sha256:[a-f0-9]{64}$/u.test(expectedVersion))
          throw new Error("重整共享笔记需要读取结果中的 expectedVersion。");
        return {
          action: "notes_replace",
          content: string("content", false, true) ?? "",
          expectedVersion,
        };
      }
      throw new Error("未知共享笔记操作。");
    }
    case "agent_workspace": {
      keys(["memberId", "worktreeId"]);
      const worktreeId = string("worktreeId", true);
      return {
        action: "workspace_bind",
        memberId: required("memberId"),
        ...(worktreeId === undefined ? {} : { worktreeId }),
      };
    }
    case "agent_group": {
      keys(["action"]);
      const operation = required("action");
      if (operation === "stop") return { action: "group_stop" };
      if (operation === "continue") return { action: "group_continue" };
      throw new Error("未知群组操作。");
    }
    default:
      throw new Error("未知协作工具。");
  }
}
