# Plan 02：运行核心的状态与顺序归属

状态：已实现

## 开发者速览

> **一句话**：降低从公开行为追到执行、持久化和失败收口的阅读成本。<br>
> **核心做法**：集中已有协议和事实投影，消除隐含装配、重复分组与可变请求快照。<br>
> **边界**：保持执行、权限、事件、持久化及 Git 语义。<br>
> **风险 / 未验证**：取消竞争、写锁交接与执行前复核必须保持原顺序。<br>
> **当前 / 请审阅**：实现、163 项定向验证及独立审查通过，已提交 c94f08f。

## 基线与范围

接续 Plan 01 审查后的工作区，重新核对真实消费者与现有验证。覆盖 Spec A09–A12 及对应 A14–A15：Runtime、协作控制、Tool 批次、Session writer、Context 投影、MCP 请求快照与 Git 集成判断。TUI 留在 Plan 03。

## 实施步骤

1. 根/成员实质装配收进 runtime.ts，列明共享资源、独占资源、可用时点及关闭次序，消除依赖未初始化循环捕获的构造路径。
2. 集中协作动作分类；agent-loop.ts 调用 tool/tool-batch.ts 的完整批次行为。tool-scheduling.ts 保留冲突计算；准备、审批、执行前复核、四并发、源序提交与取消补齐由批次持有，实时事件顺序保持。
3. session/writer.ts 集中追加入队、刷盘、Run lease 与写锁交接。追加接受和落盘成功明确区分，运行与空闲追加复用同一规则，不留只转发的旧壳。
4. context/projection.ts 统一记录身份、来源与完整 Tool 组，原 assembly 职责并入并删除旧壳。selection.ts 仅负责压缩覆盖及保留选择，复用分组。保持来源撤销、内部输入身份、Reasoning 和先落盘后采用。
5. mcp/tool-snapshot.ts 绑定本次可见工具与 connection generation，执行计划消费对应请求快照，执行前仍复核权限与连接。git/integration.ts 集中已有阶段、副作用及继续/中止判断，不改变持久化事实。
6. 按链删除机械注释与失实承诺，在真正保证点解释简短中文原因；名称表达对象、所有权与阶段，不为减少行数创建接口层。

## 验证

开始和结束对比 package 导出、真实消费者、状态持有者、调用链及提交/失败点；目录或接口数量只作辅助。使用已有 runtime、concurrency、session、context、MCP、Git 本地测试，只补能区分缺陷的必要竞态/快照隔离测试。开始本 Plan 时按实际文件补齐定向命令，不调用真实 Provider 或网络。

本 Plan 的分区命令（Windows、Node v24.13.1、pnpm 10.33.0）：

- Session：`pnpm exec vitest run apps/agent/test/session.test.ts apps/agent/test/session-recovery.test.ts`。
- Context/MCP：`pnpm exec vitest run apps/agent/test/context-selection.test.ts apps/agent/test/context-integration.test.ts apps/agent/test/context-compaction.test.ts apps/agent/test/memory-context.test.ts apps/agent/test/mcp.test.ts apps/agent/test/mcp-tool-snapshot.test.ts`。
- Git：`pnpm exec vitest run apps/agent/test/git-workspace.test.ts apps/agent/test/git-integration-ignored-collision.test.ts apps/agent/test/git-approval-state.test.ts`。
- Runtime/Tool：`pnpm exec vitest run apps/agent/test/tool-loop.test.ts apps/agent/test/agent-loop-safety.test.ts apps/agent/test/agent-controls.test.ts apps/agent/test/agent-capability-boundaries.test.ts apps/agent/test/automatic-continuation.test.ts apps/agent/test/auto-review.test.ts apps/agent/test/complete-tool-loop.test.ts apps/agent/test/multi-agent.test.ts`。
- 统筹：`pnpm check`、`pnpm build`；最终全量 `pnpm verify` 留到 Plan 03。

请求快照接线：Context 保留进入包装器时的 ModelRequest 身份，准备后的请求和 MCP 工具快照一起返回；SessionAgent 在本 Run 的 WeakMap 中将该身份绑定到 ToolRunner，Loop 收齐该响应后取得对应 Runner。手动压缩只消费准备后的请求，不产生执行计划。ModelRequest 与 package 入口均不加入执行器字段。

统筹执行一次 check/build，子 Agent 负责自己的定向验证，可信结果不重复。高风险判断作一次独立审查。若需改变公共行为、权限、事件、Schema 或职责合同，停止返回讨论。

## 停止与报告

完成后补充统一 Tasks/Report，展示真实阅读路径如何简化及关键顺序的证据；独立审查通过后提交并继续 Plan 03。开发者已明确授权连续完成整个 Feature。
