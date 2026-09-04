# Anthias

Anthias 是一个本地优先、交互形态无关的可分叉 Coding Agent。

它把一次编码任务表示为一棵可以产生不同候选方向的执行树：用户可以从共同检查点创建互不覆盖的执行分支，让不同方案分别继续，再比较并选择后续采用的方向。

    编码任务
      └─ 共同检查点
           ├─ 执行分支 A → 候选结果 A
           └─ 执行分支 B → 候选结果 B
                             ↓
                        用户比较和选择

执行分支是产品概念，不等同于 Git 分支、对话分支或多 Agent。当前路线也不包含 Agent 自我进化。

## 当前重点

Anthias 先建立一个可复用的 Coding Harness，再逐步完善交互体验、上下文管理和执行分叉。当前 Coding Harness 已形成模型对话、线性 Session、基础 Tool、工作区操作、权限与安全策略的本地闭环，并继续与具体界面分离：

    Anthias Agent（运行核心）
      ├─ TUI 适配器（首个交互入口）
      └─ Desktop 适配器（未来能力）

TUI 直接调用 Agent，并订阅 Agent 发布的事件。未来 Desktop 可以通过适配器转发同一组命令和事件，不要求 Agent 理解 Electron、MessagePort 或其他界面技术。

## 当前状态

- 旧的 Desktop、Local Agent Host、JSON-RPC 和 Protocol 实现已经撤销。
- Feature 001–003 已累计实现事件驱动的 Agent Loop、线性 JSONL Session、六个固定 Tool、逐次副作用确认、Agent / Plan 权限模式、`allow | ask | deny` 安全决策和只读 Tool 四并发；Feature 003 已由开发者验收。
- 仓库已有可构建、可启动的 Agent 与行式 TUI；生产 OpenAI-compatible Model Adapter、Session、Tool 和运行生命周期均由 Agent Module 持有，TUI 只通过公开 Agent Interface 输入和呈现。
- 当前命令仍以 Anthias 所在用户权限运行，没有 OS 沙箱；真实 Provider、外部网络与长期人工终端体验不在现有自动验证证据内。
- 已确认的基础方向是 Strict TypeScript、Node.js 24 LTS、ESM 和 pnpm workspace。
- 首个模型接入继续使用通用 OpenAI-compatible 接口；DeepSeek V4 Flash 只是日常使用与联调的参考模型。
- Electron 不再是产品前提；Desktop 的框架、进程模型和传输方式留给未来 Feature 决定。
- [Feature 004](specs/feature004-tui-workspace-experience/spec.md) 正在实施。Plan 01 已完成任意工作目录启动、`--workspace`、Workspace Root 与 Anthias Data Root 分离，以及输入旁完整工作路径呈现，并通过本地约定验证、等待开发者审查；新的视觉层级、Reasoning、Tool 活动、文件标识和 Shiki 高亮仍在后续 Plan。
- Compaction、执行分叉、候选比较和 Desktop 尚未实现。

## 文档入口

- [产品定义](docs/product-definition.md)：产品路线、交互形态、核心术语与当前边界。
- [技术基线](docs/technical-baseline.md)：当前 TypeScript、Agent、TUI、事件和模型方向。
- [开发流程](docs/development-workflow.md)：讨论、Spec、Plan、实施与验收的协作方式。
- [Feature 文档约定](specs/README.md)：编号 Feature 的目录、文档结构和状态。
- [Research](research/README.md)：项目级或跨 Feature 的调查规则和历史归档；Feature 专属 Research 见对应 Feature 目录。
