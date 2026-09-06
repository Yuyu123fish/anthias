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
    "agent_spawn",
    "委派有界任务并立即返回成员 ID。用 agent_wait 等待，再用 agent_result 核对结果。默认只读；可写成员从明确提交创建 worktree，未提交修改不会带入。只有主 Agent 能调用。",
    { task: text, name: identity, writable: { type: "boolean" }, ref: identity },
    ["task"],
  ),
  define("agent_list", "查看成员、活动 Team 与共享任务；不启动模型。", {}, []),
  define(
    "agent_wait",
    "有界等待任一成员完成或需要处理；超时返回当前状态，可取消。",
    {
      memberIds: { type: "array", items: identity, minItems: 1, maxItems: 3 },
      timeoutMs: { type: "integer", minimum: 1, maximum: 60_000 },
    },
    ["memberIds"],
  ),
  define(
    "agent_stop",
    "停止指定成员；release 可释放其运行资源，代码与历史仍保留。",
    { memberId: identity, release: { type: "boolean" } },
    ["memberId"],
  ),
  define(
    "agent_result",
    "读取带来源的成员结果、分页历史或已引用产物。成员仅能读取同队交付摘要。",
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
    "核对原工作区后显式继续成员，创建新 Run；不重放旧工具。",
    { memberId: identity, task: text },
    ["memberId"],
  ),
  define(
    "team",
    "建立团队、加入成员、分派任务、更新自己的任务或同队发送消息。消息只入队，不唤醒空闲成员。",
    {
      action: { type: "string", enum: ["create", "close", "add", "assign", "update", "message"] },
      name: identity,
      task: text,
      writable: { type: "boolean" },
      ref: identity,
      memberId: identity,
      taskId: identity,
      status: { type: "string", enum: ["completed", "blocked"] },
      result: text,
      content: text,
    },
    ["action"],
  ),
];

export function createMultiAgentTools(options: {
  callerSessionId: string;
  rootSessionId: string;
  coordinator: MultiAgent;
}): AgentToolExtension {
  const primary = options.callerSessionId === options.rootSessionId;
  return {
    definitions: (mode) =>
      definitions
        .filter(
          (definition) =>
            primary ||
            definition.name === "agent_list" ||
            definition.name === "agent_result" ||
            definition.name === "team",
        )
        .map((definition) => {
          if (primary || definition.name !== "team") return definition;
          return define(
            "team",
            "仅可更新自己的任务，或向当前 Team 发送消息；不能创建 Agent、Team 或分派其他成员。",
            {
              action: { type: "string", enum: ["update", "message"] },
              memberId: identity,
              taskId: identity,
              status: { type: "string", enum: ["completed", "blocked"] },
              result: text,
              content: text,
            },
            ["action"],
          );
        })
        .map((definition) =>
          mode === "plan" && definition.inputSchema.properties?.writable
            ? {
                ...definition,
                inputSchema: {
                  ...definition.inputSchema,
                  properties: {
                    ...definition.inputSchema.properties,
                    writable: { type: "boolean" as const, const: false },
                  },
                },
              }
            : definition,
        ),
    createPlan(call, mode) {
      if (!definitions.some((definition) => definition.name === call.toolName)) return null;
      return managedToolPlan(call, mode, async () => {
        const action = parseCollaborationCall(call);
        if (!primary && !["list", "result", "task_update", "message"].includes(action.action))
          throw new Error("成员不能创建 Agent、管理团队、等待其他成员或分派任务。");
        const writable =
          action.action === "spawn" || action.action === "team_add"
            ? action.writable === true
            : action.action === "resume" || action.action === "task_assign"
              ? options.coordinator.member(action.memberId).writable
              : false;
        return {
          target: call.toolName + " · " + options.callerSessionId,
          preview:
            JSON.stringify(action, null, 2) +
            (writable ? "\n可写成员使用独立 worktree；主目录未提交修改不会带入。" : ""),
          approval: writable,
          execute: (signal) => options.coordinator.execute(options.callerSessionId, action, signal),
        };
      });
    },
  };
}

export function collaborationToolCall(
  action: CollaborationAction,
): Readonly<{ toolName: string; input: JsonValue }> {
  const { action: operation, ...input } = action;
  const names: Record<string, string> = {
    spawn: "agent_spawn",
    list: "agent_list",
    wait: "agent_wait",
    stop: "agent_stop",
    result: "agent_result",
    resume: "agent_resume",
  };
  if (names[operation]) return { toolName: names[operation] ?? operation, input };
  const teamActions: Record<string, string> = {
    team_create: "create",
    team_close: "close",
    team_add: "add",
    task_assign: "assign",
    task_update: "update",
    message: "message",
  };
  return { toolName: "team", input: { ...input, action: teamActions[operation] ?? operation } };
}

function parseCollaborationCall(call: AssistantToolCallPart): CollaborationAction {
  if (!isRecord(call.input)) throw new Error("协作参数必须为对象。");
  const input = call.input;
  function keys(allowed: string[]) {
    if (!hasOnlyKeys(input, allowed)) throw new Error("协作参数包含未知字段。");
  }
  function string(name: string, optional = false): string | undefined {
    const value = input[name];
    if (value === undefined && optional) return undefined;
    if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 16 * 1024)
      throw new Error(name + " 必须是非空文本，且不超过 16 KiB。");
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
  const taskDetails = () => {
    const name = string("name", true);
    const writable = boolean("writable");
    const ref = string("ref", true);
    return {
      task: required("task"),
      ...(name === undefined ? {} : { name }),
      ...(writable === undefined ? {} : { writable }),
      ...(ref === undefined ? {} : { ref }),
    };
  };
  switch (call.toolName) {
    case "agent_spawn":
      keys(["task", "name", "writable", "ref"]);
      return { action: "spawn", ...taskDetails() };
    case "agent_list":
      keys([]);
      return { action: "list" };
    case "agent_wait": {
      keys(["memberIds", "timeoutMs"]);
      if (
        !Array.isArray(input.memberIds) ||
        input.memberIds.length < 1 ||
        input.memberIds.length > 3 ||
        !input.memberIds.every((id) => typeof id === "string" && id.length > 0)
      )
        throw new Error("memberIds 需要一至三个成员 ID。");
      const timeoutMs = number("timeoutMs", 60_000);
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
    case "team": {
      const operation = required("action");
      if (operation === "create") {
        keys(["action", "name"]);
        return { action: "team_create", name: required("name") };
      }
      if (operation === "close") {
        keys(["action"]);
        return { action: "team_close" };
      }
      if (operation === "add") {
        keys(["action", "task", "name", "writable", "ref"]);
        return { action: "team_add", ...taskDetails() };
      }
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
      if (operation === "message") {
        keys(["action", "memberId", "content"]);
        return {
          action: "message",
          memberId: required("memberId"),
          content: required("content"),
          messageId: call.toolCallId,
        };
      }
      throw new Error("未知 Team 操作。");
    }
    default:
      throw new Error("未知协作工具。");
  }
}
