# Feature 文档约定

`specs/` 保存 Anthias 中大型 Feature 已确认的产品合同、实施方案和验收报告。小型修改可以在对话中明确后实施，不强制创建文档。

## 目录

```text
specs/
  features/
    NNN-feature-name/
      spec.md
      plan.md
      plan-01-stage-name.md
      report.md
```

- `NNN` 从 `001` 开始，使用三位序号；目录名使用稳定的英文短名。
- 中型 Feature 使用 `spec.md` 和一个 `plan.md`。
- 大型 Feature 使用 `spec.md` 和多个 `plan-NN-stage-name.md`。
- Feature 形成可验收增量后维护一个 `report.md`。
- 只创建当前需要的文件，不预建空 Plan、空 Stage 或未来 Feature 目录。

## 状态

每份 Spec、Plan 和 Report 顶部使用一个状态：

```text
Status: Draft | Specified | Planned | Implementing | Implemented | Accepted
```

- 新建文档默认为 `Draft`。
- Spec 由开发者确认后进入 `Specified`。
- Plan 由开发者确认后进入 `Planned`。
- `Specified` 和 `Planned` 不代表允许修改代码。
- `Implemented` 表示实现和约定验证完成，正在等待验收。
- `Accepted` 只由开发者确认。

## Spec

Spec 回答“要做成什么”，默认包含：

1. Problem
2. User Flow
3. Behavior and Failures
4. Decisions
5. Out of Scope
6. Acceptance Criteria

只有 Feature 确实引入新术语、持久状态、权限或复杂生命周期时，才增加对应章节。优先复用 [产品定义](../docs/product-definition.md) 中已经确认的“编码任务”“检查点”“执行分支”和“候选结果”；不预设 `Model`、`Agent Loop`、`Tool` 或其他旧概念。

Spec 记录稳定合同，不保存实施流水账，也不以具体文件清单代替产品行为。开发者确认后，执行者应能判断 Feature 做成和没做成的区别。

## Plan

Plan 回答“怎样完成并证明它”，默认包含：

1. Current Baseline and Scope
2. Implementation Steps
3. Verification
4. Risks and Stop Conditions
5. Report Requirements

需要迁移、兼容或恢复设计时再增加相应章节。Plan 可以为低风险实现细节留出调整空间，但不能让执行 Agent 自行改变产品语义、公开合同、模块职责或 Feature 范围。

大型 Feature 的 Stage 线性推进。每个 Stage 形成可独立运行或验证的增量，实施并汇报后停止，等待开发者审查。

## Report

Report 记录已经成立的能力与证据边界，至少说明：

1. 已完成的用户行为和未完成范围。
2. 入口、主要调用链和关键职责。
3. 取消、并发、失败和资源释放中的重要边界。
4. 验证命令、结果、环境和验证层级。
5. 未验证项和已知限制。

Report 不是文件 Diff、测试清单或按时间排列的工作日志。尚未实现或尚未验收的行为必须明确标注，不能写成当前事实。

## 文档边界

- [产品定义](../docs/product-definition.md) 保存已经确认的产品路线、核心术语和稳定边界，以及仍待确认的产品问题。
- [技术基线](../docs/technical-baseline.md) 保存当前基线状态；重新确认后再承载跨 Feature 的工程选择。
- `specs/` 可以描述尚未实现但已经确认的 Feature，必须用状态区分计划与事实。
- `README.md` 和稳定 `docs/` 必须区分已确认决定和已实现能力。
- 难以逆转、跨多个 Feature 且经过真实取舍的架构决定才考虑 ADR。
- Research、临时提示词、检查点、Agent 草稿和测试日志不进入 `specs/`。
