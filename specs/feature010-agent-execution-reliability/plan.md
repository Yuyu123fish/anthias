# Feature 010 Plan：执行与交互可靠性

状态：已实现

## 开发者速览

> **一句话**：在一个 Plan 内完成已确认的可靠性修复和验证。<br>
> **核心做法**：协议、权限和 TUI 独立推进，工具结果与调度统一接线，再做集成验证。<br>
> **边界**：开发者明确授权整个 Feature，按行为增量推进，不增加中途人工等待 Stage。<br>
> **风险 / 未验证**：保护 members.ts 的既有修改，真实终端主观体验单列。<br>
> **当前 / 请审阅**：本 Plan 已完成，验证结果与独立审查结论见 Report，等待验收。

## 基线与范围

依据 [Spec](spec.md)，起点 `main @ 3ced8ac`。已有用户修改仅 `apps/agent/src/multi-agent/members.ts`；不重置、不覆盖、不纳入无关重命名。基线 `pnpm check` 通过，已有 127 条 info 级样式提示，不把这些旧提示扩大为本 Feature 的全库格式修改。复用此前相同源码的定向诊断及 Feature 009 全量证据，修改后统一跑全量。

## 实施步骤

1. 保留 Model Stream 的 reasoning，修复兼容 Adapter 空值回传；本地 HTTP 夹具验证实际请求，检查连续工具轮、新 Run、压缩及恢复。不得通过模型 ID 分支实现。
2. 明确 Full Access 决策、外部路径、成员与保留限制；AutoAllow 分离用户授权和解释指代的上下文。同步配置、历史校验和提示词。
3. 从基础工具移除 ArtifactWriter 参数。Session 产物存储以完成结果保存为主要接口，流式临时收集限定在命令执行内部；结果预算统一收敛，分页保留可继续位置和完整性事实。
4. 调度以已知资源访问和顺序屏障表达，保持四并发。冲突动作在前驱完成后准备；有副作用动作仍复核并记录开始。完成事件与源顺序结果分别处理。
5. 修复 TUI 实际 Editor 的补全触发与路径候选，接入新模式显示；避免改 node_modules 或无证据升级依赖。
6. 对生产代码完成语义命名扫描，修正已确认名称及真实消费者。按行为增量验证，不为机械命名增加镜像测试。
7. 统一运行 `pnpm verify` 与 `git diff --check`，做一次独立 Spec/高风险审查；修复发现后只补相关验证。更新唯一 Tasks 和 Report，待开发者验收，不提交或推送。

## 分工与文件所有权

- 统筹持有 agent-loop、工具执行/结果/产物、调度、文档和最终集成。共享文件的修改由持有者接线，避免并行覆盖。
- 权限执行者持有 permission、session-agent、local-config、session/schema、workspace-path 与审批/编码提示词；基础工具的路径校验接线交统筹。
- Model 执行者持有 model 下相关文件及生产 Adapter 定向测试；不改 agent-loop。
- TUI 执行者持有 apps/tui 与对应测试，模式联合由权限执行者提供。命名扫描在相应文件持有者完成后进行。
- 各执行者只运行自己的定向测试并报告命令、环境和结果；全量门禁由统筹一次执行，不并发运行相同构建或全量测试。

## 验证

| 范围 | 验证入口 |
| --- | --- |
| 模型 | openai-compatible-model、model-recovery/context 现有本地夹具，必要时添加针对协议的回归 |
| 权限 | permission-policy、auto-review、auto-allow-integration、外部文件、local-config、session-recovery、multi-agent |
| 工具 | tool-artifacts、read-only-tool、command-tool-loop、tool-scheduling、tool-loop/safety |
| TUI | command、tui、main 现有测试与真实 Editor 按键，不只检查候选数组 |
| 集成 | pnpm verify；git diff --check；独立审查 Spec 完整性和权限/并发/保存失败 |

## 风险与停止条件

普通实现选择在合同内推进；若必须改变公开行为、持久化兼容、成员权限或任务范围，先说明冲突。已有修改保持原意。取消不能回滚已完成副作用；产物写入失败不能把工具已执行伪装成未执行。不得保存凭据、原始模型请求或完整错误体。没有新增真实外部调用需要时不重复调用。

## 汇报

Report 记录完成行为、实际调用链、接口收窄证据、定向及全量验证、独立审查结果、已知限制与 Git 状态。最终状态至多为已实现，只有开发者可以标记已验收。
