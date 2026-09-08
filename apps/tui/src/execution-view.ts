import { type Component, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { createTheme } from "./theme.js";

export type ExecutionStep = {
  kind: "message" | "detail";
  title: string;
  text: string;
  content: Component;
  expanded: boolean;
  hasToolCalls?: boolean;
  messageStatus?: "streaming" | "completed" | "failed" | "aborted";
  summary?: string;
  attention?: boolean;
};

export type ExecutionControl = Readonly<{
  row: number;
  column: number;
  width: number;
  activate(): void;
}>;

export type ExecutionTurn = Component & {
  steps: ExecutionStep[];
  answer: ExecutionStep | undefined;
  expanded: boolean;
  status: "running" | "completed" | "failed" | "aborted";
  controls: ExecutionControl[];
  finish(status?: "completed" | "failed" | "aborted"): void;
};

/** 只保存当前界面的展开状态；历史恢复由公开消息重建，不参与 Run 生命周期。 */
export function createExecutionTurn(
  theme: ReturnType<typeof createTheme>,
  unicode: boolean,
  changed: () => void,
): ExecutionTurn {
  const stepToggles = new WeakMap<ExecutionStep, () => void>();
  const toggleTurn = () => {
    turn.expanded = !turn.expanded;
    changed();
  };
  const marker = (expanded: boolean) => (unicode ? (expanded ? "▾" : "▸") : expanded ? "v" : ">");
  const turn: ExecutionTurn = {
    steps: [],
    answer: undefined,
    expanded: true,
    status: "running",
    controls: [],
    invalidate() {
      for (const step of turn.steps) step.content.invalidate();
    },
    finish(status) {
      if (status === undefined && turn.status !== "running") return;
      const lastMessage = turn.steps.findLast((step) => step.kind === "message");
      turn.status =
        status ??
        (lastMessage?.messageStatus === "failed" || lastMessage?.messageStatus === "aborted"
          ? lastMessage.messageStatus
          : "completed");
      turn.expanded = false;
      for (const step of turn.steps) step.expanded = false;
    },
    render(width) {
      const lines: string[] = [];
      turn.controls = [];
      const steps = turn.steps.filter(
        (step) => step !== turn.answer && (step.kind !== "message" || step.text.trim().length > 0),
      );
      function heading(text: string, column: number, activate: () => void): void {
        const label = truncateToWidth(text, Math.max(1, width - column), "");
        turn.controls.push({ row: lines.length, column, width: visibleWidth(label), activate });
        lines.push(" ".repeat(column) + label);
      }
      if (steps.length > 0) {
        lines.push("");
        const status = {
          running: "运行中",
          completed: "已完成",
          failed: "失败",
          aborted: "已停止",
        }[turn.status];
        heading(
          theme.muted(`${marker(turn.expanded)} 执行过程 · ${steps.length} 步 · ${status}`),
          1,
          toggleTurn,
        );
        for (const step of steps.filter((candidate) => turn.expanded || candidate.summary)) {
          let toggle = stepToggles.get(step);
          if (toggle === undefined) {
            toggle = () => {
              step.expanded = !step.expanded;
              changed();
            };
            stepToggles.set(step, toggle);
          }
          heading(
            (step.attention ? theme.coral : theme.lagoon)(`${marker(step.expanded)} ${step.title}`),
            3,
            toggle,
          );
          if (!step.expanded && step.summary) {
            for (const line of new Text(step.summary, 0, 0).render(Math.max(1, width - 4)))
              lines.push(`    ${line}`);
          }
          if (step.expanded) {
            for (const line of step.content.render(Math.max(1, width - 4)))
              lines.push(`    ${line}`);
          }
        }
      }
      if (turn.answer !== undefined && turn.answer.text.trim().length > 0) {
        lines.push("", theme.coral(" ><> Anthias"));
        for (const line of turn.answer.content.render(width)) lines.push(line);
      }
      return lines;
    },
  };
  return turn;
}
