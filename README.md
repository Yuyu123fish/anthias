# Anthias

Anthias 是一个可分叉的 Coding Agent。

它把一次编码任务表示为一棵可以产生不同候选方向的执行树：用户可以从共同检查点创建互不覆盖的执行分支，让不同方案分别继续，再比较并选择后续采用的方向。

```text
编码任务
  └─ 共同检查点
       ├─ 执行分支 A → 候选结果 A
       └─ 执行分支 B → 候选结果 B
                         ↓
                    用户比较和选择
```

执行分支是产品概念，不等同于 Git 分支、对话分支或多 Agent。当前路线也不包含 Agent 自我进化。

## 当前状态

- 可分叉的 Coding Agent 产品路线已经确认，尚未形成首个 Feature。
- 目标用户、首要任务、分叉触发方式、候选结果比较方式和交互入口仍待确认。
- 编程语言、运行时、构建系统、模块布局、并发模型、模型协议和测试技术全部待定。
- TypeScript 当前是优先候选，不是已经确认的技术基线。
- 仓库当前没有可运行产品代码或已实现产品能力。
- 2026-08-30 撤销的 Java/JVM 路线以及 Feature 001/002 只保留在 Git 历史和 `research/archive/` 中，不代表当前决定。
- 首个产品闭环和技术基线确认前，不进入 Spec、Plan 或实现。

## 文档入口

- [产品定义](docs/product-definition.md)：已经确认的产品路线、核心术语、边界与待确认问题。
- [技术基线](docs/technical-baseline.md)：旧基线撤销状态和等待重新选择的技术项。
- [开发流程](docs/development-workflow.md)：讨论、Spec、Plan、实施与验收的协作方式。
- [Feature 文档约定](specs/README.md)：中大型 Feature 的文档结构和状态。
- [Research](research/README.md)：调查规则和历史研究归档。
