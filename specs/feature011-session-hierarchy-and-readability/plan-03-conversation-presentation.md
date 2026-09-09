# Plan 03：根会话浏览与 TUI 阅读路径

状态：已实现

## 开发者速览

> **一句话**：让用户辨认根会话、成员过程及结果，并收拢 TUI 状态更新。<br>
> **核心做法**：集中呈现状态、共享文案与命令声明，通过现有控制面读取成员。<br>
> **边界**：查看成员保持根输入，不增加运行生命周期或分享权限。<br>
> **风险 / 未验证**：流式更新、取消后的详情一致性和实际终端体验。<br>
> **当前 / 请审阅**：实现、68 项 TUI 定向验证及最终审查完成，按授权提交。

## 基线与范围

接续 Plan 02 审查后的工作区，完成 Spec A04、A13 及最终 A14–A15。核对全屏和纯文本的真实事件消费者及 Agent 只读状态。若缺少展示字段，仅补现有事实的只读摘要，在开始实施前列明具体字段与消费者，不暴露模型、Provider 或内部循环步骤。

本 Plan 直接消费现有 AgentState.sessionId、CollaborationSnapshot.rootSessionId 和 MemberSummary 的名称、ID、kind、task、status、result/error；不新增公开字段。成员结果/产物标题使用请求开始时同一根的摘要，读取仍走 collaboration.execute(result)。presentation 接管正文及关联详情更新；view 保留布局和审批阅读门禁。

定向分工：呈现执行者负责 `pnpm exec vitest run apps/tui/test/tui.test.ts apps/tui/test/multi-agent-view.test.ts`（后者补结果标题/归属测试）；命令执行者负责 `pnpm exec vitest run apps/tui/test/command.test.ts apps/tui/test/autocomplete.test.ts`。统筹完成 event-text 与纯文本接线后通知前者验证，不重复同一组测试。最终统一运行 pnpm verify。

## 实施步骤

1. presentation.ts 持有 Run、Assistant、成员和详情的更新，view.ts 保留组件装配与交互。一次操作同步正文、详情索引及归属，消除多处赋值维持一致性的路径。
2. 根显示身份与成员概览；成员按名称/ID、种类、任务及状态归组，默认收拢过程。成员损坏时保留根摘要并明确诊断，不显示为空成功。
3. /agents、/agent result、/agent artifact 继续调用 Agent 控制面，详情显示根归属；查看不切换输入、不启动模型或恢复资源。
4. event-text.ts 共用状态、来源、失败和通知含义，两种入口保留各自布局。command-definitions.ts 统一顶层/子命令名称、提示与帮助，解析执行保持显式，不引入通用命令执行框架。
5. 核对全部验收项、命名及中文原因注释；说明合并低价值拆分时的职责去向，删除旧转发壳和重复事实来源，保持两个 package。

## 验证

通过公开 Agent Interface 和 TUI 输入/事件覆盖新建/恢复根、多成员并行、结束/释放后查看、缺损历史、产物拒绝、取消后继续及命令发现一致性。使用确定性流、临时数据及现有终端测试。

最终运行一次 pnpm verify，复用前两 Plan 的可信故障/兼容证据；作一次最终 Spec 遗漏及衔接审查，不重复逐行审查既有增量。人工终端体验、真实 Provider 分别标注，未完成不得声称已验证。

## 停止与报告

需要扩大结果分享权限、改变根输入生命周期或新增事件体系时返回讨论。Report 汇总行为、调用链、所有权、失败边界与验证；只标已实现，等待开发者验收。验收后同步稳定使用说明与技术基线；本 Feature 逐 Plan 审查后提交已授权，推送和 PR 仍分别授权。

最终验证结果与唯一旧 CLI 标签断言的定向修正见 [Report](report.md#plan-03-验证与最终门禁)。完整 pnpm verify 运行一次，其他通过结果复用；共 577 个不同测试最终通过，1 项原有 Windows 条件跳过。
