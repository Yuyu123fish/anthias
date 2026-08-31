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

Anthias 先建立一个可复用的 Coding Harness，再逐步加入 Tool、工作区操作、上下文管理和执行分叉。Coding Harness 与具体界面分离：

    Anthias Agent（运行核心）
      ├─ TUI 适配器（首个交互入口）
      └─ Desktop 适配器（未来能力）

TUI 直接调用 Agent，并订阅 Agent 发布的事件。未来 Desktop 可以通过适配器转发同一组命令和事件，不要求 Agent 理解 Electron、MessagePort 或其他界面技术。

## 当前状态

- 旧的 Desktop、Local Agent Host、JSON-RPC 和 Protocol 实现已经撤销。
- Feature 001 的“TUI 优先、事件驱动的最小 Agent Loop”已完成本地实现和约定验证，当前等待开发者验收。
- 仓库已有可构建、可启动的内存 Agent 与行式 TUI；真实 Provider 和人工 Windows 终端体验尚未验证。
- 已确认的基础方向是 Strict TypeScript、Node.js 24 LTS、ESM 和 pnpm workspace。
- 首个模型接入继续使用通用 OpenAI-compatible 接口；DeepSeek V4 Flash 只是日常使用与联调的参考模型。
- Electron 不再是产品前提；Desktop 的框架、进程模型和传输方式留给未来 Feature 决定。
- Tool、文件与命令、持久化、Compaction 和执行分叉均未实现。

## 文档入口

- [产品定义](docs/product-definition.md)：产品路线、交互形态、核心术语与当前边界。
- [技术基线](docs/technical-baseline.md)：当前 TypeScript、Agent、TUI、事件和模型方向。
- [开发流程](docs/development-workflow.md)：讨论、Spec、Plan、实施与验收的协作方式。
- [Feature 文档约定](specs/README.md)：编号 Feature 的目录、文档结构和状态。
- [Research](research/README.md)：调查规则和历史研究归档。
