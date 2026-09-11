import { randomUUID } from "node:crypto";
import type { Session } from "../session/index.js";
import { isRecord } from "../tool/input-validation.js";

export type TeamSummary = Readonly<{
  id: string;
  name: string;
  status: "active" | "closed";
  pausedBy?: "user" | "root";
}>;
export type TeamTask = Readonly<{
  id: string;
  teamId: string;
  memberSessionId: string;
  description: string;
  status: "pending" | "running" | "completed" | "blocked";
  result?: string;
}>;

/** 一个根 Session 的任务共享同一群组；旧 Team 标识只用于读取原任务关联。 */
export function createTasks(session: Session) {
  let group: TeamSummary = { id: session.sessionId, name: "协作群组", status: "closed" };
  const tasks = new Map<string, TeamTask>();
  for (const record of session.records) {
    if (record.type !== "coordination" || !isRecord(record.payload)) continue;
    const payload = record.payload;
    if (record.kind === "team" && typeof payload.name === "string")
      group = {
        id: session.sessionId,
        name: payload.name,
        status: "closed",
        ...(payload.pausedBy === "user" || payload.pausedBy === "root"
          ? { pausedBy: payload.pausedBy }
          : {}),
      };
    if (
      record.kind === "task" &&
      typeof payload.id === "string" &&
      typeof payload.memberSessionId === "string" &&
      typeof payload.description === "string" &&
      ["pending", "running", "completed", "blocked"].includes(String(payload.status))
    )
      tasks.set(payload.id, {
        id: payload.id,
        teamId: session.sessionId,
        memberSessionId: payload.memberSessionId,
        description: payload.description,
        status: payload.status === "running" ? "blocked" : (payload.status as TeamTask["status"]),
        ...(typeof payload.result === "string" ? { result: payload.result } : {}),
      });
  }
  async function saveTask(task: TeamTask) {
    await session.appendCoordination(null, { kind: "task", key: task.id, payload: task });
    tasks.set(task.id, task);
    return task;
  }
  return {
    snapshot: () => ({
      team: { ...group },
      tasks: [...tasks.values()].map((task) => ({ ...task })),
    }),
    async activate(name = group.name) {
      if (group.status === "active" && name === group.name) return group;
      const nextGroup: TeamSummary = { id: session.sessionId, name, status: "active" };
      await session.appendCoordination(null, {
        kind: "team",
        key: session.sessionId,
        payload: nextGroup,
      });
      group = nextGroup;
      return group;
    },
    async pause(pausedBy: "user" | "root") {
      const pausedGroup: TeamSummary = { ...group, status: "closed", pausedBy };
      await session.appendCoordination(null, {
        kind: "team",
        key: session.sessionId,
        payload: pausedGroup,
      });
      group = pausedGroup;
      return pausedGroup;
    },
    async close() {
      const nextGroup: TeamSummary = { ...group, status: "closed" };
      await session.appendCoordination(null, {
        kind: "team",
        key: session.sessionId,
        payload: nextGroup,
      });
      group = nextGroup;
      return group;
    },
    assign(memberSessionId: string, description: string) {
      return saveTask({
        id: randomUUID(),
        teamId: session.sessionId,
        memberSessionId,
        description,
        status: "pending",
      });
    },
    update(id: string, status: TeamTask["status"], result?: string) {
      const previous = tasks.get(id);
      if (!previous) throw new Error("任务不属于当前群组。");
      return saveTask({ ...previous, status, ...(result === undefined ? {} : { result }) });
    },
    task: (id: string) => tasks.get(id),
  };
}
