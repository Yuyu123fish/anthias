import { randomUUID } from "node:crypto";
import type { Session } from "../session/index.js";
import { isRecord } from "../tool/input-validation.js";

export type TeamSummary = Readonly<{ id: string; name: string; status: "active" | "closed" }>;
export type TeamTask = Readonly<{
  id: string;
  teamId: string;
  memberSessionId: string;
  description: string;
  status: "pending" | "running" | "completed" | "blocked";
  result?: string;
}>;

/** Team 只持有任务语义；落盘成功后才发布状态，消息执行由成员持有。 */
export function createAgentTeam(session: Session) {
  let team: TeamSummary | null = null;
  const tasks = new Map<string, TeamTask>();
  for (const record of session.records) {
    if (record.type !== "coordination" || !isRecord(record.payload)) continue;
    const payload = record.payload;
    if (
      record.kind === "team" &&
      typeof payload.id === "string" &&
      typeof payload.name === "string" &&
      (payload.status === "active" || payload.status === "closed")
    )
      team = { id: payload.id, name: payload.name, status: payload.status };
    if (
      record.kind === "task" &&
      typeof payload.id === "string" &&
      typeof payload.teamId === "string" &&
      typeof payload.memberSessionId === "string" &&
      typeof payload.description === "string" &&
      ["pending", "running", "completed", "blocked"].includes(String(payload.status))
    ) {
      tasks.set(payload.id, {
        id: payload.id,
        teamId: payload.teamId,
        memberSessionId: payload.memberSessionId,
        description: payload.description,
        status: payload.status === "running" ? "blocked" : (payload.status as TeamTask["status"]),
        ...(typeof payload.result === "string" ? { result: payload.result } : {}),
      });
    }
  }
  async function saveTask(task: TeamTask) {
    await session.appendCoordination(null, { kind: "task", key: task.id, payload: task });
    tasks.set(task.id, task);
    return task;
  }
  return {
    snapshot: () => ({
      team: team ? { ...team } : null,
      tasks: [...tasks.values()]
        .filter((task) => task.teamId === team?.id)
        .map((task) => ({ ...task })),
    }),
    async create(name: string) {
      if (team?.status === "active") throw new Error("已有活动 Team，请先结束。");
      const created: TeamSummary = { id: randomUUID(), name, status: "active" };
      await session.appendCoordination(null, { kind: "team", key: created.id, payload: created });
      team = created;
      return created;
    },
    async close() {
      if (team?.status !== "active") throw new Error("没有活动 Team。");
      const closed: TeamSummary = { ...team, status: "closed" };
      await session.appendCoordination(null, { kind: "team", key: closed.id, payload: closed });
      team = closed;
      return closed;
    },
    async assign(memberSessionId: string, description: string) {
      if (team?.status !== "active") throw new Error("没有活动 Team。");
      return saveTask({
        id: randomUUID(),
        teamId: team.id,
        memberSessionId,
        description,
        status: "pending",
      });
    },
    async update(id: string, status: TeamTask["status"], result?: string) {
      const previous = tasks.get(id);
      if (!previous || previous.teamId !== team?.id) throw new Error("任务不属于当前 Team。");
      return saveTask({ ...previous, status, ...(result === undefined ? {} : { result }) });
    },
    task: (id: string) => tasks.get(id),
  };
}
