# Feature 002 后续增量

> 本文件记录 Feature 002 完成后的补充调整，只供追溯参考。当前代码、实际运行结果以及 `spec.md`、`plan.md`、`tasks.md`、`report.md` 中的现行合同优先。

## 2026-09-04：收敛 Session 边界与 Run 安全机制

### 为什么仍属于 Feature 002

这次修改没有增加新的用户能力。它整理的是 Feature 002 已有的线性 Session、Agent Loop、Tool 执行和 TUI 终态呈现，因此继续归入 `feature002-tool-loop-and-session`，不单独创建新 Feature。

### 调整结果

- 原先集中的 `session.ts` 拆入 `session/`：`index.ts` 负责公开的 Session 编排，`journal.ts` 负责 JSONL 读写与恢复，`lock.ts` 负责独占锁，`schema.ts` 负责持久类型、解析和投影。
- 删除 Run 级活动时长预算以及它在 Agent Loop、Run、ToolRunner、Session 和 TUI 之间的剩余时间传播。
- `execute_command.timeoutMs` 只约束当前命令；用户停止仍通过 Run 根 AbortSignal 传播，ToolResult 仍遵守 64 KiB / 2,000 行输出边界。
- Agent Loop 只保留两个私有保险丝：一个 Run 最多实际发起 12 次模型请求；单条 AssistantMessage 超过 32 个 ToolCall 时整批不执行。两者都以普通 `failed` 收口，不形成公开预算状态。
- 公开 Run 结果只保留 `completed | aborted | failed`；`activeRun` 只暴露 `runId` 和阶段，`run_end` 不再携带运行计量。
- RunFinishedRecord 只保存记录身份与 `completed | aborted | failed | interrupted` 终态。Model Stream 不再转换或传递没有消费者的 token usage。

### 兼容性

Schema 1 在项目尚未发布的阶段就地收敛。带旧预算或计量字段的本地 JSONL 不再兼容，Session 会按严格字段校验拒绝打开；实现没有保留旧格式分支。

### 验证

- 受影响的 Agent Loop、Session、Tool Loop、Model Adapter 与 TUI 定向测试通过：6 个测试文件、42 个测试。
- `pnpm verify` 通过：Biome 检查 45 个文件，Strict TypeScript 与构建通过，13 个测试文件共 87 个测试通过。
- 本次没有调用真实 Provider、外部网络或真实凭据。
