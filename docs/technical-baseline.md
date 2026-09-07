# Anthias 技术基线

状态：Feature 003、005 已验收；Feature 006–008 已实现并完成本地验证，开发者体验验收仍待完成；真实外部调用证据按各 Feature Report 区分。

2026-09-06，产品方向调整为在 Coding Agent 基础上，围绕工程问题构造验证并交付证据。当前仍优先补齐 Coding Agent 基本功能；工程验证工具、数据准备与证据交付的具体机制留待后续 Feature。现有两个 package、Agent Interface、模型与 Tool 权限边界继续作为技术基线。

2026-08-31，开发者撤销了此前实现的 Electron Desktop、独立 Utility Process Host、JSON-RPC 协议和跨层状态投影。问题不是 Electron 本身不可用，而是这些选择被过早设为所有运行方式的产品前提，并让基础 Agent Loop 承担了尚未出现的跨进程需求。

## 已撤销的决定

- Java、JDK、Maven、JLine 以及相关 Java 专属约定；
- Anthias 必须以 Desktop + Local Agent Host 运行的产品形态；
- Electron、React 和独立 Host 是首个 Feature 的强制基线；
- JSON-RPC 2.0、MessagePort、Protocol DTO 和双向运行时校验是 Agent 的公共 Interface；
- 为单一内存对话提前建立 ConversationId、TurnId、RunId、快照和五类 Run 通知；
- 旧 Feature 001 的全部代码、Plan、Tasks、Report 和“已实现”状态；
- 以执行分叉作为必须实现的后续目标，并据此安排 Coding Harness 的演进。

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
- 订阅 AgentEvent，并能取消订阅；
- 通过 `sessions.list/create/open` 切换同 Workspace 会话，使用 `compact()` 主动压缩；
- 通过 `memory.query/execute` 查询和维护应用记忆，接收 `memory_changed` 事件；
- 通过 `skills.list/reload/activate` 与 `mcp.list/connect/disconnect/inspect/readResource/getPrompt` 管理外部能力；这些普通函数对象返回安全摘要，不暴露 SDK 或持久化句柄。

Agent 由普通工厂函数创建，不为 Provider、TUI、测试或未来 Desktop 建立抽象类和继承层级。生产启动工厂隐藏模型配置解析与 Adapter 构造；Agent 内部可以拆分实现，但内部 seam 不扩大公共 Interface。

### 模型适配器

Model Adapter 位于 Agent Module 内部，把 Agent 的消息 transcript 和 AbortSignal 转换为一次模型流，并把模型输出转换为 Agent 可消费的增量。生产实现使用 OpenAI-compatible 接口；Agent 内部测试使用确定性本地流。两者形成当前唯一真实可替换 seam，但该 seam 不向 TUI 或未来 Desktop 暴露。

### TUI 适配器

TUI 负责终端输入、输出和用户停止操作。它接收已经创建好的 Agent，直接调用 Agent，并订阅 AgentEvent；它不读取模型配置，不依赖 AI SDK，不构造 Model Stream，也不自行推进 Agent 生命周期或维护第二份业务状态。

当前 TUI 复用 `@earendil-works/pi-tui` 的 `TuiAltScreen`、Editor、ScrollView 与 Markdown。全屏固定 Workspace、输入和状态，正文由应用内滚动；模型事件按顺序更新呈现状态，合并到差量同步帧，未闭合代码块立即显示。用户向上阅读时保留位置，回到末尾才恢复跟随；宽屏详情与正文并列，窄屏覆盖。正文与详情的可见滑块支持点击和拖动。任务结束后，思考、Tool 与中间消息折叠到执行过程，最终回答保持可见；执行过程与单个步骤可鼠标展开/收起，审批仍独立呈现。伸展区域显式声明布局尺寸，正文按宽度和内容版本缓存最终安全行，普通滚动复用已完成的渲染。退出恢复终端模式、光标与监听器。

文件引用继续经过 Workspace 校验；外部文本先安全化，lazy Shiki 失败或延迟不阻塞输入。Unicode 宽度使用 pi TUI 的实现，非 TTY 仍为无控制序列的纯文本路径。CLI 从任意 cwd 或 --workspace 启动，Agent 的 Workspace 与 Anthias data/conversation 分别装配。

### 未来 Desktop 适配器

Feature 001 不创建 Desktop 目录、进程或协议。未来 Desktop 需要跨进程时，可以在 Agent 外增加 Adapter，将界面命令映射为 prompt / abort，并将 AgentEvent 转发给界面。序列化、运行时校验和进程生命周期只存在于该 Adapter，不进入 Agent Module。

## 事件方向

AgentEvent 只表达 Agent 已经发生的生命周期、消息、权限和 Tool 变化。当前事件包含 Run 开始与结束、真实 phase 变化、消息开始/更新/结束、Visible Reasoning、权限模式变化、Tool approval 请求与结果，以及带 ToolActivity 与 ToolCall 归属的执行开始、输出和结束。事件按产生顺序同步交给当前订阅者；TUI 按事件顺序维护呈现状态，再合并绘制，不通过事件反向控制 Agent。会话切换和手动能力操作另外发布 session_changed、operation_changed、skills_changed、mcp_changed、memory_changed。

Session 使用 Schema 3 JSONL（兼容 Schema 1/2），持久化完整消息、压缩、调用用量、审批、副作用开始事实、context_source 外部来源、使用活动和 Run 终态；流式 delta 与瞬时 AgentEvent 不写入 JSONL。会话按 UTC 创建时间归档，索引为可重建旁路文件。TUI 可以保存输入缓冲、折叠和焦点等呈现状态，但不能成为 Agent 生命周期、Tool Policy 或 Session 事实的权威。

## 模型配置方向

Agent 的生产启动工厂为首个真实 Model Adapter 从本地环境读取以下配置：

- ANTHIAS_MODEL_BASE_URL
- ANTHIAS_MODEL_ID
- ANTHIAS_MODEL_API_KEY

三项只供 Agent Module 内部的模型 Adapter 使用，TUI 只接收启动成功后的 Agent 或安全错误文本。缺失或无效配置必须在发起请求前给出可理解提示，API Key 不进入事件、TUI 输出、错误详情、测试快照或仓库文件。应用不为 DeepSeek V4 Flash 增加模型枚举或专用条件分支。


已知 deepseek-v4-flash 使用内置模型能力数据，不需要手工配置安全余量。自定义模型还必须声明 ANTHIAS_MODEL_CONTEXT_WINDOW；ANTHIAS_MODEL_MAX_OUTPUT_TOKENS 可声明输出能力。ANTHIAS_RESPONSE_MAX_TOKENS、ANTHIAS_COMPACTION_MAX_TOKENS、ANTHIAS_CONTEXT_KEEP_TOKENS 分别控制普通输出、摘要输出和保留原文目标，默认 16,000 / 8,000 / 32,000；安全余量固定 20,000。所有数值在 Agent 启动时校验，TUI 不读取这些配置。

上下文检查位于每次普通请求发送前。有效 usage 对完全相同的请求前缀进行校准，否则保守估算；摘要不修改完整对话历史。恢复索引与 JSONL 分开，JSONL 是事实源。摘要成功刷盘后自动继续，失败或取消不丢原文。AutoAllow 的审核是同一模型的独立请求，最多 8,000 输入 / 2,000 输出，不能调用工具或把摘要、工具结果当成授权。

## 外部能力

Skill 使用用户和项目 `.agents/skills`，扩展路径通过 `ANTHIAS_SKILL_DIRS` 传入。目录只保留有界元数据，正文与引用分别按需读取；实际内容作为 Session 来源事实保存，恢复保留已保存版本，文件变化给出诊断。外部指令和参考资料始终计入后续请求预算，压缩不把它们变为真实用户授权。

MCP 使用官方 TypeScript 客户端。配置发现与连接分开，`/mcp connect` 才启动 stdio 进程或 HTTP 连接。工具经 schema 与连接版本校验、现有权限/AutoAllow、开始事实和产物链执行；Plan 拒绝未知外部工具。资源按 URI 读取，模板由用户选择，其内容保持外部来源。配置格式及环境变量引用见 [Quick Start](../quick-start.md)，协议验证范围见 [Feature 006 Report](../specs/feature006-command-skill-mcp-tui/report.md)。

## 记忆与提示词编排

Feature 008 已实现主动记忆和 `/memory` 管理。应用根目录的 `memory/user/`、`memory/experience/<project-id>/` 与 `memory/state/` 分别保存用户条目、项目经验及本地设置。当前 Workspace 与应用数据根分别装配；同仓库工作树按共同 Git 目录归组，各自读取自己的项目根 AGENTS.md，未提交仓库与非 Git Workspace 也可使用记忆。

`memory/` Module 持有存储、修订校验、范围和时效；`tool/memory-tools.ts` 绑定真实用户或已完成 Tool 证据，根校验成员候选，成员条件以自己的工作树取证。人工确认保留原证据来源，后续自动维护不能覆盖用户确认的内容。候选不默认采用，文件或分支条件变化进入待复核，读取不会刷新确认时间。自动开关控制自动维护，Plan 仍允许受管应用记忆维护，Workspace 权限独立检查。

请求文本按固定基础规则、少量通用用户记忆、初始环境、项目规则、Skill 目录、经验索引与少量正文、会话历史及动态来源排列。`tools` 保持独立字段并按名称稳定排序；系统模板不重新拼入变化的正文。来源首次采用形成有界快照，后续真实变化追加新版本；按需正文位于对应完整 Tool 组后，Tool 结果只确认采用或引用，不重复携带正文。语义优先级为真实用户要求、项目规则、有效经验、用户记忆，传输角色不会改变来源身份或授予权限。

Session 保存实际消息与采用事实，memory 保存当前跨会话状态，Context 通过持久 entryId / seq 选择模型投影。Schema 3 的来源与压缩记录增加可选的版本 1 投影元数据，包含触发身份、保留消息身份、来源版本及折叠边界；新实现兼容没有这些字段的旧记录。完整候选校验并写入后才切换投影，不按正文相等猜测消息身份。只读历史保持原事实，显式继续才检查当前来源。

遗忘保留不含正文的抑制标记，后续采用移除相关记忆与受影响摘要；明确停止发送时还过滤相关原始消息的模型投影。已经发送的请求无法撤回，执行未开始的 Tool 前会重新核对撤销状态。存储提交与 Session 采用分别处理，采用失败会如实说明“记忆已保存”，封口当前 Run，恢复时重新对齐。取消不能将已经提交的写入报告为未保存。

来源正文继续计入请求预算，缓存用量只使用 Provider 返回值，未知保持未知。已移除每 Run 12 次和整组 60 次调用截止；30 分钟共享任务时限、32 个 ToolCall / 批、只读四并发和三个成员的限制保持。实现与本地验证范围见 [Feature 008 Report](../specs/feature008-memory-and-prompt-orchestration/report.md)。

## 设计约束

- 优先形成深 Module：TUI、测试和未来 Desktop 使用同一个小 Interface，不穿透 Agent 内部步骤。
- 只有真实变化才建立 seam；当前只保留 Agent Module 内部的生产 Model Adapter 与确定性测试 Adapter。
- Agent 状态只有一份。交互层可以保存渲染数据，但不能成为生命周期权威。
- 普通函数和判别联合足以表达的行为，不增加类层级、Registry、Manager 或通用框架。
- 取消、进程信号、终端状态、模型流和后续 Tool 资源必须有明确持有者与释放时机。
- 敏感值只进入被忽略的本地配置或环境变量；仓库只保存变量名、占位符和安全默认值。

## 仍待后续 Feature 决定

- 旧 Workspace 内 Session 的可选迁移能力；当前实现明确不自动扫描或迁移；
- 长历史检索与 Session 持久化扩展；
- 可复用授权、OS 沙箱、低权限执行和网络隔离；
- 多 Provider、模型切换、重试和 Provider 专属能力；
- Desktop 框架、进程模型和传输协议；
- Coding Agent 基础功能的具体使用场景与系统提示词；
- 工程验证所需的工具接入、场景数据准备、验证程序与证据关联机制；具体接口、存储格式和工具选型尚未确认。

这些未决项必须由对应 Feature 的真实用户结果证明，不以空接口、预留层或通用基础设施提前实现。

## 多 Agent 协作

Feature 007 已完成实现与本地验证，待开发者验收。在现有 Agent Module 内复用 SessionAgent，每个成员持有独立线性 Session 和取消资源；根持有三个成员名额、一个活动 Team、任务和消息队列。公开入口增加 `collaboration.snapshot/execute` 与 `git.execute`，TUI 只构造语义操作；没有新增 package、Host 或数据库。

`multi-agent/` 负责成员运行、Team 与投递；`git/` 负责固定 argv 的本地仓库操作、受管 worktree、成果提交及集成。Tool 层承接参数、权限和审批，Session 层继续负责记录、兼容、只读历史和组清理。成员不能继续创建 Agent，内部委派和消息不成为用户授权，AutoAllow 核对真实根 Session 记录。

Schema 3 Header 明确 `sessionKind`、`rootSessionId`；根和成员分别在原日期平铺目录保存 JSONL。根的 `coordination` 记录保存成员、任务、消息和 Git 事实，成员的 `agent_input` 保存带发送方与稳定消息 ID 的内部输入。旧 Schema 1/2 可读，显式执行采用兼容升级；只读历史不会触发迁移或要求 Workspace 存在。索引是可重建缓存，不承担跨 Session 事务。

创建和 Git 写入先记录意图，再保存结果；跨日志投递先持久化收件输入，再确认送达，依靠稳定 ID 去重。重开只恢复历史状态，显式继续才创建新 Run。清理按根关系成组保护未交付资源，永远不删除 Git 目录或分支。`ANTHIAS_WORKTREE_DIR` 与 `ANTHIAS_SESSION_DIR` 分别配置代码和历史路径。具体限制与验证见 [Feature 007 Report](../specs/feature007-multi-agent/report.md)。
