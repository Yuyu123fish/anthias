# Anthias 技术基线

状态：Feature 003 已验收；Feature 004 的主观终端视觉仍待验收；Feature 005 已实现，有限真实模型证据见其 Report。

2026-08-31，开发者撤销了此前实现的 Electron Desktop、独立 Utility Process Host、JSON-RPC 协议和跨层状态投影。问题不是 Electron 本身不可用，而是这些选择被过早设为所有运行方式的产品前提，并让基础 Agent Loop 承担了尚未出现的跨进程需求。

## 已撤销的决定

- Java、JDK、Maven、JLine 以及相关 Java 专属约定；
- Anthias 必须以 Desktop + Local Agent Host 运行的产品形态；
- Electron、React 和独立 Host 是首个 Feature 的强制基线；
- JSON-RPC 2.0、MessagePort、Protocol DTO 和双向运行时校验是 Agent 的公共 Interface；
- 为单一内存对话提前建立 ConversationId、TurnId、RunId、快照和五类 Run 通知；
- 旧 Feature 001 的全部代码、Plan、Tasks、Report 和“已实现”状态。

这些内容不再构成当前实现起点。未来 Desktop Feature 可以重新评估 Electron、进程隔离和传输协议，但必须由当时的真实需求证明其复杂度。

## 已确认的技术方向

- 语言与运行时：Strict TypeScript、Node.js 24 LTS、ESM；
- 依赖与工作区：pnpm workspace；
- 核心形态：Agent 是与界面无关的深模块，通过小而稳定的接口隐藏消息、模型流、取消和后续 Tool Loop；
- 首个入口：TUI 与 Agent 在同一进程直接协作，不经过 RPC；
- 可观察性：Agent 以类似 pi 的 emit / subscribe 方式发布有序 AgentEvent；
- Desktop 兼容：未来 Desktop 适配器可以转发相同命令与事件，Agent 不依赖 Electron、React、MessagePort 或序列化协议；
- 模型：AI SDK Core 只允许留在 `apps/agent` 的内部 Model Adapter，不把 Model Stream、模型消息、AI SDK 或 Provider 类型传播到 Agent 的外部 Interface；
- 首个模型接入：单一 OpenAI-compatible Provider，不建设 Provider Registry；
- 参考模型：DeepSeek V4 Flash，通过 OpenAI-compatible Chat Completions 使用；它只是一组配置，不产生专用实现；
- 自动验证：在 Agent Module 内部通过注入的确定性 Model Stream 验证 Agent 行为；TUI 测试只使用 Agent Interface，不默认访问真实模型、外部网络或付费 API。

Feature 001 已根据 Node.js 24 环境固定 TypeScript、Vitest、Biome 与 AI SDK 依赖版本，并生成 pnpm lockfile；package manifest 与 lockfile 是具体版本事实源。Feature 002 在 Agent Module 内加入 Schema 1 线性 JSONL Session、六个固定 Tool、Model → Tool → Model 循环和逐次副作用确认。Feature 003 进一步加入 Agent / Plan 权限模式、`allow | ask | deny` Tool Policy、外部单文件确认、命令环境收敛和固定四 worker 的纯只读并发，并已由开发者验收。

## 模块与接口

### Agent 模块

Agent 持有消息 transcript、当前流式消息、是否正在运行以及取消所需的资源。对调用者只提供以下行为：

- 通过生产启动工厂从本地环境创建 Agent，并返回安全的配置结果；
- 读取当前只读 state；
- 提交一条 prompt；
- 在空闲时查看或切换 Agent / Plan / AutoAllow 权限模式；
- 响应当前待决的 Tool approval；
- 取消当前运行，或关闭 Agent 并等待资源释放；
- 订阅 AgentEvent，并能取消订阅。

Agent 由普通工厂函数创建，不为 Provider、TUI、测试或未来 Desktop 建立抽象类和继承层级。生产启动工厂隐藏模型配置解析与 Adapter 构造；Agent 内部可以拆分实现，但内部 seam 不扩大公共 Interface。

### 模型适配器

Model Adapter 位于 Agent Module 内部，把 Agent 的消息 transcript 和 AbortSignal 转换为一次模型流，并把模型输出转换为 Agent 可消费的增量。生产实现使用 OpenAI-compatible 接口；Agent 内部测试使用确定性本地流。两者形成当前唯一真实可替换 seam，但该 seam 不向 TUI 或未来 Desktop 暴露。

### TUI 适配器

TUI 负责终端输入、输出和用户停止操作。它接收已经创建好的 Agent，直接调用 Agent，并订阅 AgentEvent；它不读取模型配置，不依赖 AI SDK，不构造 Model Stream，也不自行推进 Agent 生命周期或维护第二份业务状态。

当前 TUI 继续复用 Node.js `readline` 的单行编辑能力，但输出由内部 Terminal Conversation Module 管理：interactive Terminal Driver 提交稳定 scrollback 并原位替换底部动态区，plain Driver 只做无控制序列的确定性追加。动态区持续显示输入、完整 Workspace、模式、Session 与 Run 状态；Visible Reasoning 默认保留最近四行并在结束后折叠，`/details` 可查看本进程内的完整 Reasoning 和按 `toolCallId` 归属的 Tool 输出，内容超过可用高度时用 `/details prev|next` 分页。resize 不重写历史；运行中低于安全尺寸或无法容纳完整底栏时，把完整上下文提交到稳定区并暂停 prompt / approval，放大后恢复。关闭路径恢复 raw mode、光标与监听器。

Feature 004 同时让 CLI 从任意 `cwd` 或 `--workspace` 启动，把 Workspace Root 和默认 Anthias `data/conversation` 分别装配给 Agent；生产工厂不再从 Workspace 推导 Session Directory。单一 Content Renderer 会安全化模型文本，经 Workspace 校验的文件引用使用可降级标识与 OSC 8，已标记 fenced code 由 lazy Shiki Core 着色。Unicode 显示宽度由 `string-width@8.2.2` 处理；终端能力在 TUI 边界显式探测或注入，非 TTY 强制关闭颜色与 hyperlink。

### 未来 Desktop 适配器

Feature 001 不创建 Desktop 目录、进程或协议。未来 Desktop 需要跨进程时，可以在 Agent 外增加 Adapter，将界面命令映射为 prompt / abort，并将 AgentEvent 转发给界面。序列化、运行时校验和进程生命周期只存在于该 Adapter，不进入 Agent Module。

## 事件方向

AgentEvent 只表达 Agent 已经发生的生命周期、消息、权限和 Tool 变化。当前事件包含 Run 开始与结束、真实 phase 变化、消息开始/更新/结束、Visible Reasoning、权限模式变化、Tool approval 请求与结果，以及带 ToolActivity 与 ToolCall 归属的执行开始、输出和结束。事件按产生顺序同步交给当前订阅者；TUI 通过自己的串行 render queue 保留该顺序，不通过事件反向控制 Agent。

Session 使用 Schema 2 JSONL，持久化完整消息、压缩、调用用量、审批、副作用开始事实、使用活动和 Run 终态；流式 delta 与瞬时 AgentEvent 不写入 JSONL。会话按 UTC 创建时间归档，索引为可重建旁路文件。TUI 可以保存输入缓冲、折叠和焦点等呈现状态，但不能成为 Agent 生命周期、Tool Policy 或 Session 事实的权威。

## 模型配置方向

Agent 的生产启动工厂为首个真实 Model Adapter 从本地环境读取以下配置：

- ANTHIAS_MODEL_BASE_URL
- ANTHIAS_MODEL_ID
- ANTHIAS_MODEL_API_KEY

三项只供 Agent Module 内部的模型 Adapter 使用，TUI 只接收启动成功后的 Agent 或安全错误文本。缺失或无效配置必须在发起请求前给出可理解提示，API Key 不进入事件、TUI 输出、错误详情、测试快照或仓库文件。应用不为 DeepSeek V4 Flash 增加模型枚举或专用条件分支。


已知 deepseek-v4-flash 使用内置模型能力数据，不需要手工配置安全余量。自定义模型还必须声明 ANTHIAS_MODEL_CONTEXT_WINDOW；ANTHIAS_MODEL_MAX_OUTPUT_TOKENS 可声明输出能力。ANTHIAS_RESPONSE_MAX_TOKENS、ANTHIAS_COMPACTION_MAX_TOKENS、ANTHIAS_CONTEXT_KEEP_TOKENS 分别控制普通输出、摘要输出和保留原文目标，默认 16,000 / 8,000 / 32,000；安全余量固定 20,000。所有数值在 Agent 启动时校验，TUI 不读取这些配置。

上下文检查位于每次普通请求发送前。有效 usage 对完全相同的请求前缀进行校准，否则保守估算；摘要不修改完整对话历史。恢复索引与 JSONL 分开，JSONL 是事实源。摘要成功刷盘后自动继续，失败或取消不丢原文。AutoAllow 的审核是同一模型的独立请求，最多 8,000 输入 / 2,000 输出，不能调用工具或把摘要、工具结果当成授权。

## 设计约束

- 优先形成深 Module：TUI、测试和未来 Desktop 使用同一个小 Interface，不穿透 Agent 内部步骤。
- 只有真实变化才建立 seam；当前只保留 Agent Module 内部的生产 Model Adapter 与确定性测试 Adapter。
- Agent 状态只有一份。交互层可以保存渲染数据，但不能成为生命周期权威。
- 普通函数和判别联合足以表达的行为，不增加类层级、Registry、Manager 或通用框架。
- 取消、进程信号、终端状态、模型流和后续 Tool 资源必须有明确持有者与释放时机。
- 敏感值只进入被忽略的本地配置或环境变量；仓库只保存变量名、占位符和安全默认值。

## 仍待后续 Feature 决定

- 旧 Workspace 内 Session 的可选迁移能力；当前实现明确不自动扫描或迁移；
- 长历史检索和后续执行分叉所需的持久化扩展；
- 可复用授权、OS 沙箱、低权限执行和网络隔离；
- 多 Provider、模型切换、重试和 Provider 专属能力；
- Desktop 框架、进程模型和传输协议；
- 检查点、执行分支和候选结果的存储与隔离机制；
- Coding Agent 的具体用户场景与系统提示词。

这些未决项必须由对应 Feature 的真实用户结果证明，不以空接口、预留层或通用基础设施提前实现。
