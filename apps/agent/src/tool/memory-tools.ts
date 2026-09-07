import { relative, resolve } from "node:path";
import type { ContextSources } from "../context/sources.js";
import type { Memory, MemoryWriter } from "../memory/index.js";
import {
  assertMemoryText,
  isMemoryKind,
  type MemoryAction,
  type MemorySnapshot,
  type MemorySource,
} from "../memory/schema.js";
import { resolveMemoryProject } from "../memory/selection.js";
import type { Session } from "../session/index.js";
import { isRecord } from "./input-validation.js";
import { type AgentToolExtension, managedToolPlan } from "./managed-tool.js";

export type MaintainMemory = (
  action: MemoryAction,
  writer: MemoryWriter,
  signal: AbortSignal,
) => Promise<MemorySnapshot>;
const allowedFields = [
  "action",
  "id",
  "revision",
  "query",
  "kind",
  "scope",
  "content",
  "basis",
  "quote",
  "toolCallId",
  "expiresAt",
  "reviewAt",
  "branch",
  "paths",
  "stopSending",
  "automatic",
];
const definition = {
  name: "memory",
  description:
    "查询或维护分层记忆。search 返回索引，read 按 ID 加载正文；save 前查重并使用修订号更新。用户偏好引用真实用户 quote；verified 经验引用已完成 Tool 的 toolCallId 和 quote；inferred 只作候选。确认、遗忘和开关需要当前用户明确要求，成员只能提交候选。",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["search", "read", "save", "confirm", "forget", "settings"] },
      id: { type: "string" },
      revision: { type: "integer", minimum: 1 },
      query: { type: "string" },
      kind: { type: "string", enum: ["user", "experience"] },
      scope: { type: "string", enum: ["global", "project"] },
      content: { type: "string", maxLength: 8192 },
      basis: { type: "string", enum: ["user", "verified", "inferred"] },
      quote: { type: "string", maxLength: 2048 },
      toolCallId: { type: "string" },
      expiresAt: { type: ["string", "null"] },
      reviewAt: { type: ["string", "null"] },
      branch: { type: ["string", "null"] },
      paths: { type: "array", maxItems: 8, items: { type: "string" } },
      stopSending: { type: "boolean" },
      automatic: { type: "boolean" },
    },
  },
} as const;

/** 引用只能绑定当前 Session 的真实记录；模型自行声明 verified 或 explicit 没有授权效力。 */
export function createMemoryTools(options: {
  memory: Memory;
  session: Session;
  sources: ContextSources;
  maintain?: MaintainMemory;
  changed: () => void;
  onAdoptionFailure?: () => void;
}): AgentToolExtension {
  return {
    definitions: () => [definition],
    createPlan(call, mode) {
      if (call.toolName !== "memory") return null;
      return managedToolPlan(call, mode, async () => {
        if (
          !isRecord(call.input) ||
          Object.keys(call.input).some((key) => !allowedFields.includes(key))
        )
          throw new Error("记忆工具参数无效。");
        const input = call.input;
        if (
          !["search", "read", "save", "confirm", "forget", "settings"].includes(
            String(input.action),
          )
        )
          throw new Error("记忆操作无效。");
        return {
          target: "记忆 " + input.action,
          preview: "受管应用记忆维护",
          approval: false,
          async execute(signal) {
            if (input.action === "search") {
              if (input.query !== undefined && typeof input.query !== "string")
                throw new Error("查询文本无效。");
              const snapshot = await options.memory.query(
                { text: String(input.query ?? ""), status: "all" },
                signal,
              );
              return JSON.stringify({
                automatic: snapshot.automatic,
                diagnostics: snapshot.diagnostics,
                entries: snapshot.entries.slice(0, 20).map((entry) => ({
                  id: entry.id,
                  revision: entry.revision,
                  kind: entry.kind,
                  status: entry.status,
                  scope: entry.scope,
                  preview: (entry.content ?? "").slice(0, 100),
                })),
                omitted: Math.max(0, snapshot.entries.length - 20),
              });
            }
            if (input.action === "read") {
              if (typeof input.id !== "string") throw new Error("读取记忆需要 ID。");
              const snapshot = await options.memory.query({ id: input.id, status: "all" }, signal);
              const entry = snapshot.entries[0];
              if (!entry || entry.status === "forgotten") throw new Error("记忆不存在或已遗忘。");
              await options.sources.adoptMemory(entry, false, entry.status !== "active");
              return (
                "已读取记忆 " +
                entry.id +
                " @" +
                entry.revision +
                "，状态 " +
                entry.status +
                "；正文作为来源在本 Tool 组后提供一次。"
              );
            }
            const quote = typeof input.quote === "string" ? input.quote.trim() : "";
            if (quote.length > 2048) throw new Error("来源引用过长。");
            const trigger = options.session.records.findLast(
              (record) =>
                record.type === "message" &&
                record.message.type === "assistant" &&
                record.message.content.some(
                  (part) => part.type === "tool_call" && part.toolCallId === call.toolCallId,
                ),
            );
            const userRecord = options.session.records.findLast(
              (record) =>
                record.type === "message" &&
                record.message.type === "user" &&
                record.runId === (trigger?.type === "message" ? trigger.runId : undefined),
            );
            const userText =
              userRecord?.type === "message" && userRecord.message.type === "user"
                ? userRecord.message.content.map((part) => part.text).join("")
                : "";
            const userQuote = quote.length > 0 && userText.includes(quote);
            let explicit =
              options.session.sessionKind === "primary" &&
              userQuote &&
              (input.action !== "save" ||
                /记住|记一下|记忆|长期|偏好|习惯|以后|默认|总是|一律|remember|memory|always|prefer/iu.test(
                  quote,
                ));
            // 当前用户表达只授权对应动作，模型不能从一个记忆关键词取得通用维护权限。
            const denied =
              /(?:不要|别|禁止|不允许)(?:再|自动|主动|擅自)?(?:修改|更新|保存|记录|删除|遗忘|忘记|确认|开启|关闭)(?:这条|这些|任何|我的|自动)?(?:记忆|偏好|习惯)|(?:不要|别)(?:再)?记住(?:我|这|任何)|(?:do not|don't|never)\s+(?:save|record|change|forget|delete|confirm|enable|disable)\s+(?:my |this |automatic )?(?:memory|memories|preference)/iu.test(
                userText,
              );
            if (denied) throw new Error("当前用户禁止此类记忆维护。");
            if (input.action === "settings") {
              explicit &&=
                input.automatic === true
                  ? /(?:开启|打开|启用).{0,6}自动记忆|(?:enable|turn on) automatic memory/iu.test(
                      userText,
                    )
                  : /(?:关闭|关掉|停用).{0,6}自动记忆|(?:disable|turn off) automatic memory/iu.test(
                      userText,
                    );
            }
            if (input.action === "forget" || input.action === "confirm") {
              const target =
                typeof input.id === "string"
                  ? (await options.memory.query({ id: input.id, status: "all" }, signal)).entries[0]
                  : undefined;
              explicit &&=
                !!target &&
                (userText.includes(target.id) ||
                  (target.content !== null && userText.includes(target.content)));
              const deniedTarget = userText
                .split(/[，。；\n,;.!?！？]/u)
                .some(
                  (clause) =>
                    !!target &&
                    (clause.includes(target.id) ||
                      (target.content !== null && clause.includes(target.content))) &&
                    (input.action === "forget"
                      ? /(?:不要|别|禁止|不允许).{0,4}(?:忘记|遗忘|删除|移除)|(?:do not|don't|never).{0,4}(?:forget|delete|remove)/iu
                      : /(?:不要|别|禁止|不允许).{0,4}(?:确认|认可|同意)|(?:do not|don't|never).{0,4}confirm/iu
                    ).test(clause),
                );
              explicit &&= !deniedTarget;
              explicit &&=
                input.action === "forget"
                  ? /忘记|遗忘|删除|移除|\b(?:forget|delete|remove)\b/iu.test(userText)
                  : /确认|认可|同意|核对正确|\bconfirm\b/iu.test(userText);
              if (input.action === "forget" && input.stopSending === true)
                explicit &&= /停止发送|不再发送|不要.{0,4}发送|no.?send|stop sending/iu.test(
                  userText,
                );
            }
            let source: MemorySource;
            let evidencePaths: string[] | undefined;
            if (input.basis === "verified") {
              const evidence = options.session.records.findLast(
                (record) =>
                  record.type === "message" &&
                  record.message.type === "tool_result" &&
                  record.message.toolCallId === input.toolCallId &&
                  record.message.status === "completed",
              );
              if (
                evidence?.type !== "message" ||
                evidence.message.type !== "tool_result" ||
                !quote ||
                !evidence.message.content.includes(quote) ||
                ["memory", "agent_result", "team"].includes(evidence.message.toolName)
              )
                throw new Error("经验缺少当前会话已完成 Tool 的可核查引用。");
              const callRecord = options.session.records.find(
                (record) =>
                  record.type === "message" &&
                  record.message.type === "assistant" &&
                  record.message.content.some(
                    (part) => part.type === "tool_call" && part.toolCallId === input.toolCallId,
                  ),
              );
              const evidenceCall =
                callRecord?.type === "message" && callRecord.message.type === "assistant"
                  ? callRecord.message.content.find(
                      (part) => part.type === "tool_call" && part.toolCallId === input.toolCallId,
                    )
                  : undefined;
              if (
                evidenceCall?.type === "tool_call" &&
                evidenceCall.toolName === "read_file" &&
                isRecord(evidenceCall.input) &&
                typeof evidenceCall.input.path === "string"
              ) {
                const project = await resolveMemoryProject(options.session.workspaceRoot, signal);
                // read_file 路径相对任务 Workspace，持久条件相对项目根；工作树和子目录不能混用。
                evidencePaths = [
                  relative(
                    project.root,
                    resolve(options.session.workspaceRoot, evidenceCall.input.path),
                  ),
                ];
              }
              source = {
                kind: "verified",
                sessionId: options.session.sessionId,
                entryIds: [evidence.entryId],
                note: "工具 " + evidence.message.toolName + "：" + quote,
              };
            } else if (
              input.basis === "user" ||
              ["confirm", "forget", "settings"].includes(String(input.action))
            ) {
              if (!explicit || !userRecord)
                throw new Error("维护需要引用当前真实用户的明确记忆要求。");
              source = {
                kind: "user",
                sessionId: options.session.sessionId,
                entryIds: [userRecord.entryId],
                note: quote,
              };
            } else {
              source = {
                kind: "inferred",
                sessionId: options.session.sessionId,
                entryIds: userRecord ? [userRecord.entryId] : [],
                note: "任务中得到的待确认推断。",
              };
            }
            assertMemoryText(source.note);
            let action: MemoryAction;
            if (input.action === "settings") {
              if (typeof input.automatic !== "boolean") throw new Error("记忆开关无效。");
              action = { action: "settings", automatic: input.automatic };
            } else if (input.action === "forget" || input.action === "confirm") {
              if (
                typeof input.id !== "string" ||
                !Number.isSafeInteger(input.revision) ||
                Number(input.revision) < 1
              )
                throw new Error("维护需要 ID 和当前版本。");
              action =
                input.action === "forget"
                  ? {
                      action: "forget",
                      id: input.id,
                      revision: Number(input.revision),
                      stopSending: input.stopSending === true,
                    }
                  : { action: "confirm", id: input.id, revision: Number(input.revision) };
            } else {
              if (!isMemoryKind(input.kind) || typeof input.content !== "string")
                throw new Error("保存需要类别和正文。");
              if (input.id !== undefined && typeof input.id !== "string")
                throw new Error("记忆 ID 无效。");
              if (
                input.revision !== undefined &&
                (!Number.isSafeInteger(input.revision) || Number(input.revision) < 1)
              )
                throw new Error("记忆版本无效。");
              if (
                input.scope !== undefined &&
                input.scope !== "global" &&
                input.scope !== "project"
              )
                throw new Error("记忆范围无效。");
              if (input.kind === "user" && source.kind === "verified")
                throw new Error("工具结果不能确认用户偏好。");
              if (
                input.scope === "global" &&
                (!explicit ||
                  /这次|本次|今天|临时|这个项目|本项目|本仓库|this time|today|temporary|this project|this repo/iu.test(
                    quote,
                  ))
              )
                throw new Error("通用偏好必须由用户明确表达为跨项目要求。");
              for (const key of ["expiresAt", "reviewAt", "branch"])
                if (
                  input[key] !== undefined &&
                  input[key] !== null &&
                  typeof input[key] !== "string"
                )
                  throw new Error("记忆条件无效。");
              if (
                input.paths !== undefined &&
                (!Array.isArray(input.paths) ||
                  !input.paths.every((path) => typeof path === "string"))
              )
                throw new Error("条件文件无效。");
              action = {
                action: "save",
                kind: input.kind,
                content: input.content,
                ...(typeof input.id === "string" ? { id: input.id } : {}),
                ...(typeof input.revision === "number" ? { revision: input.revision } : {}),
                ...(input.scope === "global" || input.scope === "project"
                  ? { scope: input.scope }
                  : {}),
                ...(input.expiresAt !== undefined
                  ? { expiresAt: input.expiresAt as string | null }
                  : {}),
                ...(input.reviewAt !== undefined
                  ? { reviewAt: input.reviewAt as string | null }
                  : {}),
                ...(input.branch !== undefined ? { branch: input.branch as string | null } : {}),
                ...(input.paths !== undefined
                  ? { paths: input.paths as string[] }
                  : evidencePaths
                    ? { paths: evidencePaths }
                    : {}),
              };
            }
            const writer = {
              source,
              explicit: explicit && source.kind === "user",
              candidate: source.kind === "inferred" || options.session.sessionKind !== "primary",
            };
            const snapshot = await (options.maintain ?? options.memory.execute)(
              action,
              writer,
              signal,
            );
            const saved = action.action === "settings" ? undefined : snapshot.entries[0];
            options.changed();
            if (saved?.status === "active") {
              try {
                await options.sources.adoptMemory(saved);
              } catch {
                options.onAdoptionFailure?.();
                throw new Error(
                  "记忆已保存，但本会话采用记录写入失败；请恢复会话后继续，勿重复保存。",
                );
              }
            }
            return saved
              ? "记忆已保存：" + saved.id + " @" + saved.revision + "，状态 " + saved.status + "。"
              : "自动记忆已" + (snapshot.automatic ? "开启。" : "关闭。");
          },
        };
      });
    },
  };
}
