import { randomBytes } from "node:crypto";
import type { ActionResult } from "../agent-controls.js";
import {
  assertMemoryText,
  assertMemoryTime,
  isMemoryIdentity,
  isMemoryKind,
  type MemoryAction,
  type MemoryEntry,
  type MemoryQuery,
  type MemorySnapshot,
  type MemorySource,
  memoryHash,
} from "./schema.js";
import { memoryFileFingerprint, resolveMemoryProject, selectMemories } from "./selection.js";
import { createMemoryStore } from "./store.js";

export type { MemoryAction, MemoryEntry, MemoryQuery, MemorySnapshot } from "./schema.js";

export type MemoryControls = Readonly<{
  query(query?: MemoryQuery): Promise<ActionResult<MemorySnapshot>>;
  execute(action: MemoryAction): Promise<ActionResult<MemorySnapshot>>;
}>;
export type MemoryWriter = Readonly<{
  source: MemorySource;
  explicit: boolean;
  candidate?: boolean;
}>;

/** 记忆的业务规则由一个入口持有，人工命令和受管 Tool 共享同一写入合同。 */
export function createMemory(options: {
  directory: string;
  workspaceRoot: string;
  now?: () => number;
}) {
  const store = createMemoryStore(options.directory);
  const now = options.now ?? Date.now;
  async function query(query: MemoryQuery = {}, signal?: AbortSignal): Promise<MemorySnapshot> {
    const project = await resolveMemoryProject(options.workspaceRoot, signal);
    const snapshot = await store.read(signal);
    return {
      automatic: snapshot.automatic,
      projectId: project.id,
      entries: await selectMemories(snapshot.entries, project, query, now()),
      diagnostics: snapshot.diagnostics,
    };
  }
  async function execute(
    action: MemoryAction,
    writer: MemoryWriter,
    signal?: AbortSignal,
  ): Promise<MemorySnapshot> {
    if (action.action === "settings") {
      if (!writer.explicit) throw new Error("只有用户可以切换自动记忆。");
      await store.setAutomatic(action.automatic, signal);
      return query({});
    }
    assertMemoryText(writer.source.note);
    const project = await resolveMemoryProject(options.workspaceRoot, signal);
    const timestamp = new Date(now()).toISOString();
    let fileConditions: Array<{ path: string; fingerprint: string }> | undefined;
    if (action.action === "save") {
      if (!isMemoryKind(action.kind)) throw new Error("记忆类别无效。");
      assertMemoryText(action.content);
      assertMemoryTime(action.expiresAt);
      assertMemoryTime(action.reviewAt);
      if (action.scope !== undefined && action.scope !== "global" && action.scope !== "project")
        throw new Error("记忆范围无效。");
      if (action.kind === "experience" && action.scope === "global")
        throw new Error("经验记忆必须归属当前项目。");
      if (action.paths !== undefined) {
        if (!Array.isArray(action.paths) || action.paths.length > 8)
          throw new Error("经验条件最多引用 8 个文件。");
        fileConditions = [];
        for (const path of action.paths) {
          if (typeof path !== "string") throw new Error("经验条件路径无效。");
          fileConditions.push({ path, fingerprint: await memoryFileFingerprint(project, path) });
        }
      }
    }
    let automatic = true;
    const updated = await store.update((snapshot) => {
      automatic = snapshot.automatic;
      if (!snapshot.automatic && !writer.explicit)
        throw new Error("自动记忆已关闭；仅接受用户明确的维护要求。");
      const requestedId = "id" in action ? action.id : undefined;
      if (requestedId !== undefined && !isMemoryIdentity(requestedId))
        throw new Error("记忆 ID 无效。");
      let previous = requestedId
        ? snapshot.entries.find((entry) => entry.id === requestedId)
        : undefined;
      if (requestedId && !previous) throw new Error("记忆不存在。");
      if (previous && previous.scope !== "global" && previous.scope !== project.id)
        throw new Error("只能维护当前项目或通用用户记忆。");
      if (previous && ("revision" in action ? action.revision : undefined) !== previous.revision)
        throw new Error("记忆版本已变化，请重新查看后重试。");
      if (action.action === "forget" || action.action === "confirm") {
        if (!previous) throw new Error("记忆不存在。");
        if (!writer.explicit) throw new Error("确认和遗忘必须来自用户明确要求。");
        if (action.action === "confirm") {
          if (previous.status === "forgotten") throw new Error("已遗忘记忆需要用户重新提供正文。");
          return {
            ...previous,
            revision: previous.revision + 1,
            status: "active",
            source: previous.source,
            userConfirmed: true,
            confirmedAt: timestamp,
            updatedAt: timestamp,
          };
        }
        return {
          ...previous,
          revision: previous.revision + 1,
          content: null,
          status: "forgotten",
          updatedAt: timestamp,
          source: { ...writer.source, note: "用户已遗忘该记忆。" },
          suppressedSources: [
            ...new Set([...previous.suppressedSources, ...previous.source.entryIds]),
          ],
          suppressedHashes: [...new Set([...previous.suppressedHashes, previous.contentHash])],
          stopSending: action.stopSending ?? previous.stopSending,
        };
      }
      const content = action.content.trim();
      const contentHash = memoryHash(content);
      const scope = action.scope === "global" ? "global" : project.id;
      if (!previous) {
        previous = snapshot.entries.find(
          (entry) =>
            entry.kind === action.kind &&
            entry.scope === scope &&
            entry.contentHash === contentHash,
        );
        if (previous?.status !== "forgotten" && previous) return previous;
      }
      const suppressed = snapshot.entries.some(
        (entry) =>
          entry.scope === scope &&
          (entry.suppressedHashes.includes(contentHash) ||
            writer.source.entryIds.some((id) => entry.suppressedSources.includes(id))),
      );
      if (
        (!writer.explicit && suppressed) ||
        (previous?.status === "forgotten" && !writer.explicit)
      )
        throw new Error("该内容或来源已被遗忘，旧候选不能恢复它。");
      if (previous && (previous.kind !== action.kind || previous.scope !== scope))
        throw new Error("更新不能改变记忆类别或适用范围。");
      if (
        previous?.status === "active" &&
        !writer.explicit &&
        (writer.candidate ||
          writer.source.kind === "inferred" ||
          previous.source.kind === "user" ||
          previous.userConfirmed === true)
      )
        throw new Error("新证据与已确认记忆冲突，请保留独立候选供用户复核。");
      const corrected = previous && writer.explicit && previous.contentHash !== contentHash;
      const status = writer.candidate || writer.source.kind === "inferred" ? "candidate" : "active";
      const entry: MemoryEntry = {
        formatVersion: 1,
        id: previous?.id ?? randomBytes(16).toString("hex"),
        revision: (previous?.revision ?? 0) + 1,
        kind: action.kind,
        scope,
        content,
        contentHash,
        status,
        source: writer.source,
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: timestamp,
        confirmedAt: status === "active" ? timestamp : null,
        userConfirmed: writer.explicit && status === "active",
        expiresAt:
          action.expiresAt === undefined ? (previous?.expiresAt ?? null) : action.expiresAt,
        reviewAt: action.reviewAt === undefined ? (previous?.reviewAt ?? null) : action.reviewAt,
        conditions: {
          branch:
            action.branch === undefined ? (previous?.conditions.branch ?? null) : action.branch,
          files: fileConditions ?? previous?.conditions.files ?? [],
        },
        suppressedSources: [
          ...new Set([
            ...(previous?.suppressedSources ?? []),
            ...(corrected ? (previous?.source.entryIds ?? []) : []),
          ]),
        ],
        suppressedHashes: [
          ...new Set([
            ...(previous?.suppressedHashes ?? []),
            ...(corrected && previous ? [previous.contentHash] : []),
          ]),
        ],
        stopSending: false,
      };
      return entry;
    }, signal);
    // 原子替换已提交，随后发生的取消不能把保存成功误报成未保存。
    return {
      automatic,
      projectId: project.id,
      entries: await selectMemories([updated], project, { status: "all" }, now()),
      diagnostics: [],
    };
  }
  return {
    query,
    execute,
    project: (signal?: AbortSignal) => resolveMemoryProject(options.workspaceRoot, signal),
    read: store.read,
  };
}
export type Memory = ReturnType<typeof createMemory>;
