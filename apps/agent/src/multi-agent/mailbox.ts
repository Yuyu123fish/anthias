import { randomUUID } from "node:crypto";
import type { AgentInputDetails, Session } from "../session/index.js";
import { isRecord } from "../tool/input-validation.js";

export type MailboxDelivery = AgentInputDetails &
  Readonly<{
    toSessionId: string;
    createdAt: string;
    taskId?: string;
    status: "queued" | "delivered" | "retained";
  }>;

/** 根日志是投递事实的唯一持久来源；落盘和发布串行，避免发送与确认互相覆盖。 */
export function createMailbox(rootSession: Session) {
  const deliveries = new Map<string, MailboxDelivery>();
  let pendingOperation: Promise<unknown> = Promise.resolve();
  for (const record of rootSession.records) {
    if (record.type !== "coordination" || record.kind !== "delivery" || !isRecord(record.payload))
      continue;
    const value = record.payload;
    if (
      typeof value.messageId !== "string" ||
      value.rootSessionId !== rootSession.sessionId ||
      typeof value.fromSessionId !== "string" ||
      typeof value.toSessionId !== "string" ||
      typeof value.content !== "string" ||
      value.kind !== "message" ||
      !["queued", "delivered", "retained"].includes(String(value.status))
    )
      continue;
    deliveries.set(value.messageId, {
      messageId: value.messageId,
      rootSessionId: rootSession.sessionId,
      fromSessionId: value.fromSessionId,
      toSessionId: value.toSessionId,
      content: value.content,
      ...(typeof value.taskId === "string" ? { taskId: value.taskId } : {}),
      kind: "message",
      createdAt: typeof value.createdAt === "string" ? value.createdAt : record.timestamp,
      status: value.status as MailboxDelivery["status"],
    });
  }
  function serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const completion = pendingOperation.then(operation);
    pendingOperation = completion.catch(() => undefined);
    return completion;
  }
  async function save(delivery: MailboxDelivery) {
    await rootSession.appendCoordination(null, {
      kind: "delivery",
      key: delivery.messageId,
      payload: delivery,
    });
    deliveries.set(delivery.messageId, delivery);
    return delivery;
  }
  return {
    send(
      input: Readonly<{
        fromSessionId: string;
        toSessionId: string;
        content: string;
        messageId?: string;
        taskId?: string;
        retained?: boolean;
      }>,
    ) {
      return serialize(async () => {
        const messageId = input.messageId ?? randomUUID();
        const previous = deliveries.get(messageId);
        if (previous) {
          if (
            previous.fromSessionId !== input.fromSessionId ||
            previous.toSessionId !== input.toSessionId ||
            previous.content !== input.content
          )
            throw new Error("消息 ID 已绑定其他内容。");
          return previous;
        }
        if (
          !input.retained &&
          [...deliveries.values()].filter(
            (delivery) =>
              delivery.toSessionId === input.toSessionId && delivery.status === "queued",
          ).length >= 32
        )
          throw new Error("目标消息队列已满，请等待消费后重试。");
        return save({
          messageId,
          rootSessionId: rootSession.sessionId,
          fromSessionId: input.fromSessionId,
          toSessionId: input.toSessionId,
          kind: "message",
          content: input.content,
          ...(input.taskId ? { taskId: input.taskId } : {}),
          createdAt: new Date().toISOString(),
          status: input.retained ? "retained" : "queued",
        });
      });
    },
    pendingInputs(sessionId: string): readonly AgentInputDetails[] {
      return [...deliveries.values()].filter(
        (delivery) => delivery.toSessionId === sessionId && delivery.status === "queued",
      );
    },
    acknowledge(input: AgentInputDetails) {
      return serialize(async () => {
        const delivery = deliveries.get(input.messageId);
        if (!delivery || delivery.status === "delivered") return;
        if (
          delivery.rootSessionId !== input.rootSessionId ||
          delivery.fromSessionId !== input.fromSessionId ||
          delivery.content !== input.content ||
          delivery.kind !== input.kind
        )
          throw new Error("已消费输入与持久投递身份不匹配。");
        await save({ ...delivery, status: "delivered" });
      });
    },
    snapshot() {
      return [...deliveries.values()].map((delivery) => ({ ...delivery }));
    },
    settle: () => pendingOperation,
  };
}
