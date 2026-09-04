# Feature 文档约定

`specs/` 保存 Anthias 每个编号 Feature 的产品合同、任务清单、实施方案和验收报告。不作为 Feature 管理的局部小修改，可以在对话中明确后实施，不强制创建目录。

## 目录

```text
specs/
  featurexxx-xxxxx/
    research.md  # 可选
    spec.md
    tasks.md
    plan.md
    report.md
    increment.md  # 可选
```

- Feature 目录直接放在 `specs/` 下，不增加 `features/` 中间层。
- `featurexxx-xxxxx` 中的 `xxx` 从 `001` 开始，使用三位序号；`xxxxx` 使用稳定的小写英文短名和连字符。
- 属于某个编号 Feature 的 Research 必须放在该 Feature 目录。一个主题默认使用 `research.md`；确有多个相互独立的调查时使用 `research-xxxxx.md`，不放回根 `research/`。
- 中小型 Feature 只维护一个 `spec.md`、一个 `tasks.md`、一个 `plan.md` 和一个 `report.md`。
- 大型 Feature 仍只维护一个 `spec.md`、一个 `tasks.md` 和一个 `report.md`，允许出现多个 `plan-NN-xxxxx.md`。
- 文档在流程进入对应阶段时创建，不预建空 Plan、空 Report 或未来 Feature 目录。

## 状态

每份 Spec、Plan 和 Report 顶部使用一个状态：

```text
状态：草稿 | 已定义 | 已计划 | 实施中 | 已实现 | 已验收
```

- 新建文档默认为 `草稿`。
- Spec 由开发者确认后进入 `已定义`。
- Plan 由开发者确认后进入 `已计划`。
- `已定义` 和 `已计划` 不代表允许修改代码。
- `已实现` 表示实现和约定验证完成，正在等待验收。
- `已验收` 只由开发者确认。

## 开发者速览

每份 Feature Research、Spec、Plan、Tasks、Report 和 Increment 都要在标题与状态之后、其他元信息和正文之前放置 `## 开发者速览`。它是固定的首屏信息卡，让开发者不滚动正文也能判断文档目的、方案、边界和待审内容；正文继续保存 Agent 执行所需的完整合同。

```markdown
## 开发者速览
> **一句话**：这份文档最终要解决、证明或改变什么。<br>
> **核心做法**：准备怎样完成，或已有结论由什么关键证据支撑。<br>
> **边界**：明确包含什么，以及最容易被误解的不包含项。<br>
> **风险 / 未验证**：当前最可能改变结论的风险或证据缺口。<br>
> **当前 / 请审阅**：所处阶段，以及开发者现在需要确认的决定。
```

- 固定使用以上五个字段，每个字段只写一个短句，整张信息卡不超过三百个中文字符；不放表格、嵌套列表、代码、文件清单和完整验收项。
- “一句话”按文档类型表达最重要的结果：Research 写结论，Spec 写目标能力，Plan 写交付路径，Tasks 写当前进度，Report 写已成立结果，Increment 写实际变化。
- 速览只索引正文已经成立的内容，不能引入正文没有的新决定。正文发生实质变化时同步更新；不一致按文档缺陷处理。
- 新建文档必须包含速览。存量文档在下一次实质更新时补齐，不为纯格式统一批量改写已经完成的 Feature。

## Spec

Spec 回答“要做成什么”，默认包含：

1. 问题
2. 用户流程
3. 行为与失败
4. 已确认决定
5. 不在范围内
6. 验收标准

只有 Feature 确实引入新术语、持久状态、权限或复杂生命周期时，才增加对应章节。优先复用 [产品定义](../docs/product-definition.md) 中已经确认的产品术语。

已经确认的 Agent、AgentEvent、TUI Adapter 和 Model Adapter 可以在相关 Feature 中直接使用；除此之外，不为尚未出现的状态对象、传输协议、Adapter 或未来框架预建合同。

Spec 记录稳定合同，不保存实施流水账，也不以具体文件清单代替产品行为。开发者确认后，执行者应能判断 Feature 做成和没做成的区别。

## Research

Feature Research 回答“作出 Feature 决定前需要确认哪些外部事实”。它必须说明问题、来源与核验日期、已验证事实、项目推断和证据边界，状态不得伪装成产品合同。

- Research 属于 Feature 时，与 `spec.md` 放在同一目录；即使完成，也不移入根 `research/archive/`。
- 一个 Feature 只有一个主要调查主题时使用 `research.md`；多个独立主题才拆成 `research-xxxxx.md`。
- Research 不能代替 Spec、Plan、Tasks 或 Report，也不代表产品决定、实施授权或已实现能力。
- 没有真实研究问题时不预建 Research 文件。

## Plan

Plan 回答“怎样完成并证明它”，默认包含：

1. 当前基线与范围
2. 实施步骤
3. 验证
4. 风险与停止条件
5. 汇报要求

需要迁移、兼容或恢复设计时再增加相应章节。Plan 可以为低风险实现细节留出调整空间，但不能让执行 Agent 自行改变产品语义、公开合同、模块职责或 Feature 范围。

大型 Feature 的 Stage 线性推进。每个 Stage 形成可独立运行或验证的增量，实施并汇报后停止，等待开发者审查。

## Tasks

`tasks.md` 回答“当前已经完成什么，接下来具体做什么”。它是 Feature 实施进度的唯一任务清单：

- 任务来自已经确认的 Spec 和 Plan，不自行增加产品范围。
- 每项任务必须能够完成、检查并标记状态，不能用长篇过程记录代替任务。
- 中小型 Feature 的任务对应唯一 `plan.md`；大型 Feature 的任务按多个 Plan 分组，但仍只维护一个 `tasks.md`。
- Tasks 获得确认不代表允许实施，代码修改仍需开发者明确授权。

## Report

Report 记录已经成立的能力与证据边界，至少说明：

1. 已完成的用户行为和未完成范围。
2. 入口、主要调用链和关键职责。
3. 取消、并发、失败和资源释放中的重要边界。
4. 验证命令、结果、环境和验证层级。
5. 未验证项和已知限制。

Report 不是文件 Diff、测试清单或按时间排列的工作日志。尚未实现或尚未验收的行为必须明确标注，不能写成当前事实。

每个 Feature 只维护一个 `report.md`。大型 Feature 可以随着各 Plan 完成逐步补充同一份 Report，不为每个 Stage 创建独立 Report。

## Increment

`increment.md` 用于记录未新开 Feature、但直接延续当前最新 Feature 的后续修改。它是可选的历史参考，不要求每次局部调整都创建。

适合记录：

1. 为什么本次修改仍属于原 Feature。
2. 改动后的行为或模块边界。
3. Schema、兼容性和迁移影响。
4. 实际验证结果与未验证边界。

同一 Feature 最多维护一份 `increment.md`；多次后续修改按日期追加小节。Increment 不承担 Feature 状态、实施进度或当前产品事实的权威职责，也不替代 `spec.md`、`plan.md`、`tasks.md` 或 `report.md`。凡是已经改变稳定合同或已实现能力的内容，必须同时更新对应权威文档。

## 文档边界

- [产品定义](../docs/product-definition.md) 保存已经确认的产品路线、核心术语和稳定边界，以及仍待确认的产品问题。
- [技术基线](../docs/technical-baseline.md) 保存当前基线状态；重新确认后再承载跨 Feature 的工程选择。
- `specs/` 可以描述尚未实现但已经确认的 Feature，必须用状态区分计划与事实。
- `README.md` 和稳定 `docs/` 必须区分已确认决定和已实现能力。
- 难以逆转、跨多个 Feature 且经过真实取舍的架构决定才考虑 ADR。
- Feature 专属 Research 可以进入对应 Feature 目录；项目级或跨 Feature Research 仍保存在根 `research/`。临时提示词、检查点、Agent 草稿和测试日志不进入 `specs/`。
