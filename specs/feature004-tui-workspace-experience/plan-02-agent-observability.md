# Feature 004 Plan 02：Agent 可观察生命周期

状态：已实现

## 开发者速览

> **一句话**：让 TUI 从真实 Agent 事件理解 Run 阶段、Visible Reasoning 与每个 Tool 的动作。<br>
> **核心做法**：扩展内部 Model Stream 和少量 AgentEvent，Reasoning 保持瞬时，Tool 摘要由计划层形成。<br>
> **边界**：不改变 Message、Session Schema、Tool Policy，也不展示隐藏 Chain-of-Thought。<br>
> **风险 / 未验证**：Reasoning 收口、Tool continuation、并发归属和取消竞态最易出错。<br>
> **当前 / 请审阅**：已实现并提交为 `11f54c0`；事件、持久化与安全摘要门禁通过。

- 对应 Spec：[spec.md](spec.md)
- 前置 Plan：[Plan 01](plan-01-workspace-and-data-root.md)
- 任务事实源：[tasks.md](tasks.md)

## 1. 当前基线与交付范围

- `RunPhase` 只存在于 Agent 内部，`updatePhase` 只改状态，不发布变化。
- Model Stream 仅保留 text、ToolCall 与 finish，生产 Adapter 丢弃 AI SDK 的 Reasoning part。
- Tool execution start 只有 Tool 名和 ID，TUI 无法说明目标与动作。
- Message 的有序 `content[]` 与 Session Schema 1 已是持久事实源，不能再加入第二份 Assistant 正文。

本 Plan 交付三条端到端 tracer：

1. Agent 阶段变化能够由所有交互 Adapter 准确订阅；
2. Provider 明确提供的文本 Reasoning 能实时显示、正确收口且不持久化；
3. 六个 Tool 在真正执行时都携带安全的一行动作摘要。

## 2. 公开 Interface 的最小变化

- 导出既有三值 `RunPhase`，不新增近义生命周期枚举。
- 新增只读 `ToolActivity`：`toolCallId`、`toolName`、`summary`。
- `AgentEvent` 增加：
  - `run_phase_changed`，携带 `runId` 与新 `phase`；
  - `reasoning_start`、`reasoning_update`、`reasoning_end`，均归属 `runId`；
  - `tool_execution_start` 改为携带 `ToolActivity`。
- `Agent` 的 `state`、`prompt`、`setPermissionMode`、`respondToToolApproval`、`abort` 与 `subscribe` 保持不变。
- Model Stream、AI SDK、Provider、ToolRunner 和临时模型上下文继续是 Agent Module 的内部实现。

## 3. Reasoning 与阶段顺序

- 内部 Model Stream 规范化 `reasoning_start | reasoning_delta | reasoning_end`；空 delta 不发布。
- 每个 span 严格满足 start → update* → end。遇到 text、ToolCall、finish、error 或 abort 时，如仍有活动 span，Agent 在继续前先补发唯一 end。
- `run_start` 建立初始 `requesting_model`，不重复发布同值 phase；后续 phase 只有实际改变才发布一次。
- Reasoning 不进入 `AssistantMessage`、`AgentState`、Session JSONL 或下一个 Run。
- 若 Provider 协议要求 Tool continuation 回传 Reasoning，Agent Loop 持有当前 Run 专用的内部模型上下文；Run 结束即释放。
- Provider 没有 Reasoning 时不生成空 span，也不把等待时间命名为思考。

## 4. ToolActivity

- 摘要在 Tool plan 已完成输入校验后形成，TUI 不解析 ToolCall 原始 JSON。
- 摘要单行、移除控制字符并限制为 160 个可见字符；截断使用省略号。
- 最低语义：
  - `read_file`：路径与可选行范围；
  - `glob`：pattern 与可选起点；
  - `grep`：搜索词、范围与文件模式；
  - `edit_file` / `write_file`：经预检的目标，不含写入正文；
  - `execute_command`：实际命令与可选 cwd，不含环境变量值。
- denied、invalid 或预检失败没有 execution start；现有 ToolResult 继续说明未执行原因。
- 并发只读 Tool 的 start 保持源顺序，update / end 保持实际完成顺序，并按 `toolCallId` 归属。

## 5. 实施顺序

1. 用 Agent 公开 Interface 固定 phase 去重、Reasoning 顺序和不持久化断言。
2. 扩展 Model Stream 与生产 Adapter 的 Reasoning 规范化。
3. 在 Agent Loop 建立 Run 内临时模型上下文，保持 Message 与 Schema 1 不变。
4. 让 Tool plan 形成安全摘要，并贯通 Loop、Run 和 TUI。
5. 更新当前行式 TUI 的事实文案，为 Plan 04 的动态呈现提供稳定输入。
6. 运行定向与全量门禁，更新 Tasks / Report 并提交本 Plan。

## 6. 验证

```text
pnpm exec vitest run apps/agent/test/agent.test.ts apps/agent/test/openai-compatible-model.test.ts apps/agent/test/tool-loop.test.ts apps/agent/test/tool-scheduling.test.ts apps/tui/test/tui.test.ts
pnpm check
```

必须覆盖无 Reasoning、单 span、多模型轮次、Reasoning → text、Reasoning → Tool、Provider error 和 abort；同时证明 Session JSONL 不含 Reasoning，下一 Run 不继承临时内容。

## 7. 风险与停止条件

- 若需要把 Reasoning 写入 Message 或升级 Session Schema，停止并回到 Spec。
- 若 Provider 类型或字段名需要从 `@anthias/agent` 导出，停止并收回内部 seam。
- 若 Tool summary 只能通过暴露写入正文、敏感环境或原始 JSON 才能形成，停止并重新设计计划层摘要。
- 若阶段事件让 TUI 成为第二个生命周期权威，停止并删去推断逻辑。

## 8. 汇报与衔接

- Report 记录事件顺序、持久化边界、Tool 摘要样例与确定性证据。
- 本 Plan 完成后按开发者最新授权独立提交，并连续进入 Plan 03。
- 本 Plan 不运行真实 Provider；推送和 PR 仍需另行授权。
