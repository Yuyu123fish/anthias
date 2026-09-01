# Feature 001：基础 Agent Loop 与 TUI 对话任务

状态：已实现

- 文档类型：Tasks
- 对应 Spec：[spec.md](spec.md)
- 对应 Plan：[plan.md](plan.md)
- 实施授权：已获得

本文件是 Feature 001 的实施进度事实源。任务按依赖顺序推进，不增加 Spec 与 Plan 之外的产品行为。

## T001：建立确定性单轮流式闭环

状态：已完成

Blocked by：无

交付：

- 建立 Strict TypeScript、Node.js 24、ESM 与 pnpm workspace 工程基线；
- 只创建 `apps/agent` 和 `apps/tui` 两个 workspace package，并保持 `apps/tui → apps/agent` 单向依赖；
- 通过公开 Agent Interface 和确定性 Model Stream 完成一次非空提示词的流式 Assistant 响应；
- 行式 TUI 能展示用户消息、增量文本并在完成后恢复输入。

验收：

- [x] 根目录脚本、TypeScript、Biome、Vitest 和 lockfile 可以工作；
- [x] 多个文本增量形成一条 completed Assistant 消息；
- [x] AgentEvent 顺序和只读消息快照符合 Plan；
- [x] TUI 可以通过确定性模型流完成单轮对话。

## T002：补齐多轮上下文与拒绝语义

状态：已完成

Blocked by：T001

交付：

- 已结束消息按顺序进入下一次模型请求；
- 空白提示词返回 empty 拒绝；
- 运行期间的第二个提示词返回 busy 拒绝；
- 两类拒绝均不追加消息、不发布执行事件且不调用第二次模型请求。

验收：

- [x] 第二轮模型输入包含第一轮完整消息与当前用户消息；
- [x] empty 与 busy 结果可明确区分；
- [x] 拒绝不会改变正在运行的第一次请求。

## T003：补齐停止、失败与资源终结

状态：已完成

Blocked by：T002

交付：

- `abort()` 能停止当前生成，保留部分 Assistant 正文并允许继续；
- 模型失败保留部分正文，安全错误与 Assistant 正文分离；
- 完成、失败与中止遵循第一次终态生效，只发布一次 message_end 和 agent_end；
- TUI 在运行时处理停止，在空闲时处理退出，并释放订阅、终端监听器和活动模型资源。

验收：

- [x] 晚到增量不能修改已经终结的消息；
- [x] completed、aborted、failed 结果与 agent_end 一致；
- [x] 未完成的订阅者 Promise 不阻塞 Agent，取消订阅后不再收到事件；
- [x] 停止或失败后可以继续提交提示词；
- [x] TUI 退出后不遗留监听器或活动 Agent 请求。

## T004：接入生产配置与 OpenAI-compatible Adapter

状态：已完成

Blocked by：T003

交付：

- 在 `apps/agent` 中读取并校验三项 ANTHIAS 模型环境变量；
- 通过 AI SDK Core 与 `@ai-sdk/openai-compatible` 实现生产 Model Adapter；
- 显式关闭重试、传递 AbortSignal，并阻止 Provider、模型消息和 Model Stream 类型与敏感错误进入 Agent 的外部 Interface；
- 提供可构建、可启动的终端入口。

验收：

- [x] 缺失或本地格式错误的配置在请求前安全失败并返回非零退出码；
- [x] 生产 Adapter 一次提示词只建立一次模型流且 `maxRetries` 为 0；
- [x] DeepSeek V4 Flash 仅由通用配置表达，没有专用分支；
- [x] 默认验证不访问外部网络、真实 Provider 或凭据。

## T005：完成本地门禁、审查与实施报告

状态：已完成

Blocked by：T001、T002、T003、T004

交付：

- 运行 Plan 约定的版本、检查、测试、构建和总验证命令；
- 按 Spec、Plan、代码约定和敏感信息边界审查完整变更；
- 创建唯一 `report.md`，记录已实现行为、调用关系、验证证据和未验证边界；
- 将已完成任务与 Feature 状态更新为等待开发者验收的真实状态。

验收：

- [x] `pnpm check`、`pnpm test`、`pnpm build`、`pnpm verify` 全部通过；
- [x] 没有 Tool、Session、Desktop、协议层或其他范围外实现；
- [x] 未运行真实 DeepSeek V4 Flash 冒烟测试；
- [x] 实施阶段未越权提交、推送或创建 PR；本地提交随后由开发者单独授权。

## T006：修正 Model Adapter 归属与测试 seam

状态：已完成

Blocked by：T005

交付：

- 将模型配置、OpenAI-compatible Adapter 和 AI SDK 依赖从 `apps/tui` 迁入 `apps/agent`；
- Agent package 入口只暴露生产启动工厂、Agent 实例 Interface 及必要公共类型，不暴露 Model Stream 或模型输入类型；
- TUI 只接收已创建的 Agent，并通过 Agent Interface 输入、呈现、停止和退出；
- Agent 内部测试使用确定性 Model Stream，TUI 测试使用 Agent Interface fake，不再构造模型请求。

验收：

- [x] `apps/tui` 不导入或依赖 AI SDK、Provider、模型配置、模型消息或 Model Stream；
- [x] 删除 TUI 不会删除 Agent 的生产模型接入实现；
- [x] 原有消息、事件、多轮、拒绝、取消、失败和退出行为保持兼容；
- [x] 本地 loopback Adapter 验证仍证明单请求、流式增量与禁用重试；
- [x] 完整门禁和最终差异审查通过，Report 与稳定文档同步当前事实；
- [x] 未调用真实 Provider，未提交、推送或创建 PR。
