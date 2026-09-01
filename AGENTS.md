# AGENTS.md

本文件保存 Anthias 中每次工作都需要遵守的高频规则。讨论产品定位、用户、交互或核心术语时读取 [产品定义](docs/product-definition.md)；讨论语言、运行时、构建、界面、并发、模型或 Tool 技术选择时读取 [技术基线](docs/technical-baseline.md)；进入 Spec、Tasks、Plan、实施或验收时读取 [开发流程](docs/development-workflow.md) 和 [Feature 文档约定](specs/README.md)。

## 开始工作

- 先核对当前目录、现有文件、Git 状态和实际运行结果。当前代码与运行事实优先于旧会话、旧报告和历史计划。
- 开发者当前回合的明确决定优先于已有文档。若决定会改变产品语义、公开接口、模块职责或稳定边界，先指出冲突并更新讨论，不静默改写。
- `research/` 保存限时调查和历史材料。只有请求涉及新研究或追溯理由时才读取；研究材料不自动成为产品决定、Feature 或实施授权。
- 工作区已有修改属于开发者；保护无关文件，不重置、不清理、不覆盖。

## 产品边界

- Anthias 是本地优先、交互形态无关的可分叉 Coding Agent；当前先建立可信、可复用的 Coding Harness，复杂分叉由后续 Feature 实现。
- TUI 是首个交互入口，Desktop 是未来可选的 Adapter。两者应使用同一个 Agent Interface，不各自持有业务生命周期。
- Agent 持有消息、模型运行以及后续 Tool 和工作区副作用；交互 Adapter 只负责输入与呈现。
- 执行分支是产品概念，不等同于 Git 分支、只复制消息的对话分支、多 Agent 或 Agent 自我进化；具体实现机制尚未确认。
- Java/JVM/Maven/JLine 路线，以及旧的 Electron Desktop、独立 Host、JSON-RPC 和 Feature 001 实现均已撤销。
- Feature 001 的最小 Agent Loop、TUI Adapter 与 Agent 内部 OpenAI-compatible Model Adapter 已完成本地实现和约定验证，当前等待开发者验收；真实 Provider 验证仍未授权。
- 后续设计先完成模型对话、Tool、本地能力和上下文等 Coding Harness 闭环，再证明从共同检查点分叉、独立推进、比较并选择的核心价值。

## 代码与运行时

- 当前实现使用 Strict TypeScript、Node.js 24 LTS、ESM 和 pnpm workspace；具体依赖版本以 Feature Plan、package manifest 和 lockfile 为准。
- Agent 应形成深 Module；package 入口除生产启动工厂外，只向 TUI、测试和未来 Desktop 暴露 state、prompt、abort、subscribe 等少量行为，不暴露内部循环步骤。
- TUI 与 Agent 首期在同一进程直接协作。Agent 以有序 AgentEvent 发布变化；未来 Desktop Adapter 可以转发同一事件，不要求现在创建 Electron、Host 或协议层。
- Model Stream 是 Agent Module 的内部 seam：生产 Adapter 使用通用 OpenAI-compatible 接口，Agent 内部测试 Adapter 使用确定性本地流；Model Stream、模型消息、AI SDK 和 Provider 类型不得从 Agent package 入口导出。
- TUI 不读取模型配置，不构造 Provider 或 Model Stream，也不依赖 AI SDK；它只接收已创建的 Agent，负责输入、呈现、停止和退出。
- DeepSeek V4 Flash 只是 OpenAI-compatible 日常参考配置，不得产生模型专用 Provider、枚举或条件分支。
- 普通函数和判别联合足以表达的行为不增加类层级、Registry、Manager 或为未来变化预建的 Interface。
- 终端状态、AbortController、模型流以及后续线程、进程、文件句柄和网络请求必须有明确持有者、取消方式和关闭时机。
- 敏感值只进入被忽略的本地配置或环境变量；仓库文件只保留变量名、占位符和安全默认值。

## 命名

- 名称必须说明值实际代表的对象，不能只写角色、状态或类型判别值；一条 Assistant 消息使用 `assistantMessage`，不能简写为 `assistant`。
- 长生命周期或异步状态使用完整名词表达所有权、阶段和值类型，例如 `activeGeneration`、`responseIterator`、`pendingPromptResultPromise`；避免脱离小局部后含义不明的 `run`、`context`、`done`、`next`。
- 不为了穷举生命周期而扩张一组近义公开类型。一个判别联合或状态字段足以表达时，优先保留少量领域类型，再用明确变量名说明当前阶段。
- 方法、变量和类型名称首先服务于代码阅读；不能因为 TypeScript 能推断类型就省略 `Message`、`Result`、`Iterator` 等决定语义的名词。

## 代码注释

- 注释和 JSDoc 统一使用中文，`Conversation`、`Turn`、`Run`、`Host`、`MessagePort`、`AbortSignal` 等正式术语保留英文。
- 注释解释代码本身无法清楚表达的设计原因、不变量、顺序约束、安全边界和失败后果；删除注释会让后续修改者可能破坏这些约束时才保留。
- 状态机与终态竞争、异步事件顺序、取消与资源释放、跨进程信任边界、敏感信息脱敏、反直觉的上下文筛选及平台兼容方案必须有精简注释。
- 普通控制流依靠准确命名和拆分表达，不用注释翻译赋值、循环、条件或返回值，也不为注释覆盖率机械添加说明。
- 模块或导出函数存在隐藏前提、副作用或生命周期合同时使用简短 JSDoc；局部约束使用紧贴代码的 `//`，通常一至三行且一条只解释一个原因。
- 长控制流只在真实阶段边界使用短阶段注释；行为变化时同步修改或删除相关注释，过期注释按代码缺陷处理。
- 测试使用英文行为名；只有竞态编排、同步信号或不直观断言使用简洁中文注释，不添加机械的 Arrange / Act / Assert 分区。
- `TODO` 必须关联明确 Feature 或任务，并写出未立即处理的原因与触发条件；未确认的未来设想不进入源码注释。

## 授权与实施

- 先明确问题、原因、范围和验收结果，再选择讨论、Research、Spec、Plan 或实施路径。
- “方案可以”“Spec 没问题”“Tasks 没问题”“Plan 没问题”只确认当前内容。只有开发者明确要求开始实现，才修改代码。
- 实施、Git 初始化、提交、推送和创建 PR 是独立动作，分别取得授权。
- 一个 Stage 完成并汇报后停止，等待开发者审查；不自动进入下一 Stage。
- 遇到产品语义、公开接口、模块职责或范围变化时停止实施，回到讨论并重新确认。
- 真实模型、外部网络、付费 API、敏感凭据或外部状态变更的验证需要单独授权。

## 验证与 Agent 配合

- 验证与风险相称，优先通过 Agent Interface 和实际 TUI 行为覆盖事件顺序、取消、资源释放与失败恢复。
- 不为简单代码堆叠重复测试，也不把目录移动或接口数量当作架构改善证据。
- 交给执行 Agent 的任务必须包含检查点、精确范围、允许修改区域、验证命令、报告格式和停止条件。
- 执行 Agent 负责运行约定验证并报告命令、结果和环境。相同代码版本与环境已有可信结果时，接手 Agent 不重复运行相同测试，只补证据缺口。
- 子 Agent 只用于边界清晰、能独立完成的工作，不为流程形式增加额外文档、测试或检查点。

## Git 与文档

- 项目文档正文统一使用中文；Agent、TUI、Spec、Plan、AgentEvent 等正式技术术语，以及代码标识符、文件名和命令保留原文。
- `README.md` 和稳定 `docs/` 必须区分“已确认决定”和“已实现能力”；未实现的 Feature 行为只进入带状态的 Spec / Plan。
- 中小更新保持一个清晰增量；大型更新只在存在独立验收价值时分 Stage。
- 提交前向开发者展示变更范围和验证边界；未经明确允许不提交。推送和 PR 继续分别确认。
- 长期保存最终确认的产品文档、Spec、Tasks、Plan、Report 和可复用规则。临时提示词、Agent 草稿、工作日志和测试输出不进入提交。
