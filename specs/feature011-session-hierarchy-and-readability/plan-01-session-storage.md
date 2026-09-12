# Plan 01：会话层级、产物定位与组清理

状态：已实现

## 开发者速览

> **一句话**：先让新成员归入根目录，并可靠读回和清理新旧历史。<br>
> **核心做法**：集中位置规则，保持 Session 产物边界，以整组执行可恢复清理。<br>
> **边界**：保持日志 Schema 与公开 Agent 接口，TUI 归组留到 Plan 03。<br>
> **风险 / 未验证**：本地定向验证通过，真实 Provider 与人工终端体验未验证。<br>
> **当前 / 请审阅**：实现、定向验证及审查完成，已提交 1da57ba；完整交付见 Report。

## 基线与范围

基线为 main @ 75450a0，原有修改仅为 Feature 011 Spec 和 Windows 沙箱 Research。locations.ts 只识别平铺目录，list.ts、groups.ts、cleanup.ts 各自枚举；组清理逐 Session 移动，直接套用到嵌套目录会重复移动父子路径。

本 Plan 完成 Spec A01–A03、A05–A08 及这些路径对应的 A14–A15；A04 的浏览呈现交给 Plan 03。允许修改 session/ 中定位、列表、分组、创建、历史、清理与必要兼容调用点及定向测试。产物仍由执行 Session 持有；仅在适配路径必需时改 multi-agent/ 的产物读取，不扩张分享权限。

## 实施步骤与合同

1. locations.ts 集中两种目录布局与旧单文件的枚举、路径验证和 ID 候选解析。目录布局使用准确名称，日志 Schema 仍由 Header 表达。缓存支持嵌套相对路径，完整枚举负责发现身份冲突；枚举返回完整性及诊断，不能将忽略损坏候选当作完整。
2. 根创建沿用原目录；成员创建先严格定位、验证根，再建立 members/<id>。成员 Header 保留实际创建日期。已有成员恢复原位；旧根显式升级后新成员嵌套。不自动迁移旧成员。
3. 列表与分组复用枚举：列表容忍个别不可读历史，严格打开拒绝歧义，组完整性结合 Header 归属、重复 ID、根及协作事实。路径与 Header 双重验证，拒绝越界、链接逃逸、归属错误。已有迁移备份权威判定保留。
4. 清理保留所有 Session ID 的锁、使用检查、协调终态和缓存失效，物理移动仅选择互不包含的源目录。pending 仍记录所有 Session，从源路径推导实际移动集合与 trash 中嵌套位置，兼容已有平铺 pending 记录。未知内容、冲突、活动资源或扫描边界使整组保留；不触碰 Workspace/worktree。
5. artifacts/ 相对所属 Session 解析。根回读验证成员归属与已落盘引用；各 Session 额度、取消和临时文件释放合同不变。根可读而成员损坏时保留摘要并在查询失败处诊断，不能以空成功掩盖失败。

## 验证与协作

测试只使用临时目录和确定性本地流，不迁移或清理实际 data/conversation，不调用真实 Provider。覆盖跨日 SubAgent/teammate、旧平铺与嵌套混用、缓存损坏与定位冲突、成员产物、损坏成员、清理中断与在用恢复。

统筹执行一次 pnpm check 和 pnpm build；定向命令为 pnpm exec vitest run apps/agent/test/session.test.ts apps/agent/test/session-recovery.test.ts apps/agent/test/session-cleanup.test.ts apps/agent/test/session-locations.test.ts apps/agent/test/multi-agent.test.ts apps/agent/test/tool-artifacts.test.ts apps/agent/test/startup.test.ts。文件名以仓库现存测试为准。仅在失败、代码变化或新证据缺口时重跑相关部分。

位置/枚举与清理按文件分工，先固定接口；不并行运行共享构建。存储恢复完成后进行一次独立定向审查，后续最终审查复用证据。文档校验链接、速览、状态与 Research 移动后的引用。

## 停止与汇报

需要改变 Schema、跨 Session 产物权限、成员执行/授权或清理资源语义时停止返回讨论。完成后更新唯一 Tasks/Report，说明调用链、公共入口变化、故障保护与验证边界。本 Plan 已按开发者授权审查并提交；后续核心与 TUI 的最终交付见统一 Report。

Windows 沙箱 Research 是项目级调查，移入 research/archive/ 并同步引用；保留候选执行器未实现的事实，不属于代码范围。本 Feature 逐 Plan 审查后提交已授权，推送和 PR 仍分别授权。

结果见 [Report](report.md)：108 个不同定向用例通过；核对发现的两个清理缺口已修复。后续 Plan 02、03 已完成，证据汇总在统一 Report。
