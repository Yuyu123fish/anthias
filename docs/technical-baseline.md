# Anthias 技术基线

状态：Feature 003、005 已验收；Feature 006–008 已实现并完成本地验证；Feature 009 已实现，待开发者验收。本 Feature 未进行真实模型、SearchAPI 调用或 Windows Terminal 主观体验验收；历史真实外部调用证据仍按各 Feature Report 区分。

2026-09-12，[Feature 015](../specs/feature015-execution-recovery/report.md) 已实现执行阻塞恢复、输入中断与预算诊断，并完成本地验证，等待开发者验收；后续修复纠正命令收尾与迟到关闭后的恢复。浏览器专用适配已撤销，外部工具的控制与内部故障仍由外部实现负责。

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

- 通过生产启动工厂从 Anthias 根 `.env` 与进程环境创建 Agent，并返回安全的配置结果；
- 读取当前只读 state；
- 提交一条 prompt；
- 在空闲时查看或切换 请求批准 / AutoAllow / Full Access 权限模式；
- 响应当前待决的 Tool approval；
- 通过 `permissions.snapshot/grant/revoke` 查看、明确授予或撤销工作区授权；
- 取消当前运行，或关闭 Agent 并等待资源释放；
- 订阅 AgentEvent，并能取消订阅；
- 通过 `sessions.list/create/open` 切换同 Workspace 会话，使用 `compact()` 主动压缩；
- 通过 `memory.query/execute` 查询和维护应用记忆，接收 `memory_changed` 事件；
- 通过 `skills.list/reload/activate` 与 `mcp.list/connect/disconnect/inspect/readResource/getPrompt` 管理外部能力；这些普通函数对象返回安全摘要，不暴露 SDK 或持久化句柄。

Agent 由普通工厂函数创建，不为 Provider、TUI、测试或未来 Desktop 建立抽象类和继承层级。生产启动工厂隐藏模型配置解析与 Adapter 构造；Agent 内部可以拆分实现，但内部 seam 不扩大公共 Interface。

### 模型适配器

Model Adapter 位于 Agent Module 内部，把 Agent 的消息 transcript 和 AbortSignal 转换为一次模型流，并把模型输出转换为 Agent 可消费的增量。生产实现使用 OpenAI-compatible 接口；Agent 内部测试使用确定性本地流。Model Stream 是模型交互的内部 seam，不向 TUI 或未来 Desktop 暴露。

### TUI 适配器

TUI 负责终端输入、输出和用户停止操作。它接收已经创建好的 Agent，直接调用 Agent，并订阅 AgentEvent；它不读取模型配置，不依赖 AI SDK，不构造 Model Stream，也不自行推进 Agent 生命周期或维护第二份业务状态。

当前 TUI 复用 `@earendil-works/pi-tui` 的 `TuiAltScreen`、Editor、ScrollView 与 Markdown。全屏固定 Workspace、输入和状态，正文由应用内滚动；模型事件按顺序更新呈现状态，合并到差量同步帧，未闭合代码块立即显示。用户向上阅读时保留位置，回到末尾才恢复跟随；宽屏详情与正文并列，窄屏覆盖。正文与详情的可见滑块支持点击和拖动。任务结束后，思考、Tool 与中间消息折叠到执行过程，最终回答保持可见；执行过程与单个步骤可鼠标展开/收起，审批仍独立呈现。伸展区域显式声明布局尺寸，正文按宽度和内容版本缓存最终安全行，普通滚动复用已完成的渲染。退出恢复终端模式、光标与监听器。

命令结果按实际发生顺序插入正文，后续 Agent 进展继续向下呈现；工具参数准备、待审批、执行和失败分别可见，失败原因默认保留。异步拒绝仅在编辑器未发生新修改时恢复原输入，否则保留当前草稿，并通过 `/draft` 找回未接受的输入。`/diagnostics` 显示 Agent 提供的安全诊断，`/continue` 将明确继续意图提交为新的 Run；TUI 不重放历史工具或自行重试模型。

文件引用继续经过 Workspace 校验；外部文本先安全化，lazy Shiki 失败或延迟不阻塞输入。Unicode 宽度使用 pi TUI 的实现，非 TTY 仍为无控制序列的纯文本路径。CLI 从任意 cwd 或 --workspace 启动，Agent 的 Workspace 与 Anthias data/conversation 分别装配。

### 未来 Desktop 适配器

Feature 001 不创建 Desktop 目录、进程或协议。未来 Desktop 需要跨进程时，可以在 Agent 外增加 Adapter，将界面命令映射为 prompt / abort，并将 AgentEvent 转发给界面。序列化、运行时校验和进程生命周期只存在于该 Adapter，不进入 Agent Module。

## 事件方向

AgentEvent 只表达 Agent 已经发生的生命周期、消息、权限和 Tool 变化。当前事件包含 Run 开始与结束、真实 phase 变化、消息开始/更新/结束、Visible Reasoning、权限模式变化、Tool approval 请求与结果，以及带 ToolActivity 与 ToolCall 归属的执行开始、输出和结束。事件按产生顺序同步交给当前订阅者；TUI 按事件顺序维护呈现状态，再合并绘制，不通过事件反向控制 Agent。会话切换和手动能力操作另外发布 session_changed、operation_changed、skills_changed、mcp_changed、memory_changed、permissions_changed；工具参数阶段和 model_retry 表达正在发生的准备及等待，TUI 只呈现这些事件，不自行发起执行。

Session 使用 Schema 4 JSONL（兼容历史 Schema 1/2/3），持久化完整消息、压缩、调用用量、审批、副作用开始事实、context_source 外部来源、使用活动和带可选安全诊断的 Run 终态；流式 delta 与瞬时 AgentEvent 不写入 JSONL。会话按 UTC 创建时间归档，索引为可重建旁路文件。TUI 可以保存输入缓冲、折叠和焦点等呈现状态，但不能成为 Agent 生命周期、Tool Policy 或 Session 事实的权威。

## 模型配置方向

Agent 的生产启动工厂从自身模块所在的安装根目录加载 `.env`；任务 cwd、`--workspace` 与 Session 恢复均不改变配置来源。缺少文件时独占创建无凭据模板，仓库提供 `.env-example`，已有文件不覆盖。文件支持单行字面值、引号与注释，不进行变量展开；格式和读取失败只返回安全位置或变量名。无法创建文件但进程环境足够时通过启动警告继续运行。

同名值以进程环境覆盖文件，显式空值也不会取得文件中的密钥。模式按显式 `--mode` → 进程 `ANTHIAS_PERMISSION_MODE` → 根 `.env` → `agent` 选择，非法模式拒绝启动；`/mode` 只改变当前 Agent，不写回默认值，也不授予权限。

Model Adapter 的必需配置为：

- ANTHIAS_MODEL_BASE_URL
- ANTHIAS_MODEL_ID
- ANTHIAS_MODEL_API_KEY

三项只供 Agent Module 内部的模型 Adapter 使用，TUI 只接收启动成功后的 Agent 或安全错误文本。缺失或无效配置必须在发起请求前给出可理解提示，API Key 不进入事件、TUI 输出、错误详情、测试快照或仓库文件。应用不为 DeepSeek V4 Flash 增加模型枚举或专用条件分支。


已知 deepseek-flash 与兼容调用名使用内置模型能力数据，核验日期与来源见 [Feature 015 Research](../specs/feature015-execution-recovery/research.md)。自定义模型需声明 `ANTHIAS_MODEL_CONTEXT_WINDOW`，可用 `ANTHIAS_MODEL_MAX_OUTPUT_TOKENS` 声明输出能力。普通输出默认 64,000；上下文窗口不超过 84,000 时沿用 16,000，再按模型输出能力收窄。摘要和保留原文目标为 8,000 / 32,000，安全余量为 20,000；`ANTHIAS_RESPONSE_MAX_TOKENS`、`ANTHIAS_COMPACTION_MAX_TOKENS`、`ANTHIAS_CONTEXT_KEEP_TOKENS` 可覆盖，显式超限仍在启动时拒绝。

`ANTHIAS_RESPONSE_REASONING_EFFORT` 与 `ANTHIAS_APPROVAL_REASONING_EFFORT` 分别控制普通生成和审核的可选 `reasoning_effort`，支持 `low` / `medium` / `high`；未配置不传，压缩不采用这两个覆盖值。配置和 Provider 参数装配仍属于 Agent，TUI 不读取。Agent 提供不含凭据与 Endpoint 的最终配置和来源摘要，`/diagnostics` 呈现；Schema 4 的 request_usage 可选保存生产 Adapter 实际采用的 modelId、maxOutputTokens 与 reasoningEffort，旧记录缺少时保持未知。

上下文检查位于每次普通请求发送前。有效 usage 对完全相同的请求前缀进行校准，否则保守估算；摘要不修改完整对话历史，JSONL 是事实源。摘要成功刷盘后自动继续，失败或取消不丢原文。AutoAllow 审核为同一模型的独立请求，最多 8,000 输入 / 2,000 输出。授权来源按顺序保留全部真实用户消息，历史单次批准只留作审计，不携带整份工具输入占据新审核预算；摘要、工具结果和外部内容不成为用户授权。动作或完整用户来源超预算时明确转人工，不静默丢弃原始任务或后续约束。

## 失败、重试与继续

Agent 保存 `RunDiagnostic` 的固定分类、已知结束原因、HTTP 状态、用量、重试次数与中止来源；可选保存白名单错误码、标准参数路径和无正文的请求结构计数。`reasoningTokens` 同时保留在请求用量和运行诊断中，属于输出用量分项，不重复汇总。Session Schema 3 无需迁移，旧记录缺失字段保持未知。原始请求、响应体、带凭据 URL、任意错误字符串与堆栈均不进入诊断。

一次未完成的普通生成最多恢复两次。未交付正文、Reasoning、工具参数片段或完整 ToolCall 时，对明确的暂时网络、限流或服务失败重试原请求；已交付内容时先封存失败 AssistantMessage，为未执行的完整 ToolCall 补齐 aborted 结果，再依据实际历史发起新生成。输出截断同样续跑，并提示缩小单次输出和写入范围。原请求重试与新生成续跑共用两次预算，正常完成生成后才为下一轮生成重置；等待至少为 500 ms、1000 ms，服从已知 Retry-After，服务要求超过 30 秒或剩余任务时间不足时停止。全过程保持同一 Run、取消信号、权限和共享任务截止。

认证、配置、无效请求、未知错误、内容过滤、存储失败和用户停止不自动续跑；Tool 副作用不自动重试，结果不明先检查。上下文溢出沿用有界压缩恢复，普通生成及其压缩恢复共享尝试预算。续跑提示只进入当前请求的系统上下文，不写成真实 UserMessage，也不构成新授权。自动恢复不适用或耗尽后保留已完成事实，再提供 /continue；用户手动继续才开始新的 Run，历史回放不触发工具、审批或 Git 副作用。

AutoAllow 对相同动作的新 ToolCall 重新核验授权，同时向审核模型提供本 Run 中该动作的实际开始次数和最近结果；已开始但结果未知仍占用执行次数，过去单次 allow 不变成无限授权。用户拒绝、工作区授权撤销与执行前权限版本检查继续生效。真实 deny 或 needs_user 按原有人工决策流程处理；网络、限流、服务故障、审核输出截断或格式异常最多恢复一次，耗尽后 Run 失败，不转成人工批准。认证、配置和无效请求等直接失败，每个实际审核请求分别记录用量。

主模型提示词要求持续完成用户已授权的必要修改、验证和修正，只有关键输入、新授权或无法自行解决的阻塞才提问；任务完成直接汇报结果，不默认追加是否继续优化。此行为依靠模型遵守提示词，运行时不通过额外完成审核模型或文本匹配强迫续跑。

## 工作区授权

授权由 Agent 持有，生产记录保存在 Anthias 根 `data/permissions/`，与 Session、模型可维护记忆和项目规则分离。只有用户通过独立交互才能新增或扩大授权；AGENTS.md、搜索结果、MCP 内容和其他 Agent 消息不成为授权入口。记录绑定规范化工作区，不按父目录或仓库名称扩展。

`/permissions grant [--remember] [--members]` 展示文件及默认 17 项精确命令范围，完整浏览后输入 `grant` 才授予。`/permissions command [--remember] [--members] [--prefix] [--cwd <相对目录>] -- <命令>` 合并登记新命令，继承当前记住/成员选项，并同样先展示后确认。Agent 接受可选 `commands`，每项包含 `command`、`cwd` 和可选 `allowArguments`；省略时沿用原默认列表，磁盘版本 1 的旧记录不扩大。最多 49 项、记录 192,000 字节，校验失败保留原授权。

精确匹配使用字面参数边界；只有显式 `--prefix` 才允许后续参数，cwd 必须为工作区内确切的现存目录，执行前重新核对真实路径。组合命令逐段匹配，CR、LF、CRLF 都作为命令边界；不确定语法、动态展开、重定向及可直接识别的 Git、清理或发布入口交回审核。解释器前缀可运行后续字面脚本，不限制脚本运行时的系统用户能力。授权预览与工具待批准不能并存，撤销或范围变化使旧预览失效。

只有 `auto_allow` 消费授权：先应用硬禁止和当前限制，再核对最终文件路径、命令和有效授权，未命中时独立审核。`agent` 保留逐动作确认，`full_access` 跳过人工与模型批准；成员只读限制独立生效。命中来源随审批事实保存，但历史事实不能恢复旧权限。文件与命令仍以当前系统用户权限运行，cwd 和 worktree 不构成 OS 隔离。

`--members` 明确包含同根工作区的成员，以及从该根登记的成员工作树；记住后可用于后续从同一根工作区发起的成员任务。不选择则不继承。`/permissions revoke` 先使根与成员尚未开始的动作和待审批失效，再保存撤销；已开始动作需要停止，已产生副作用不能回滚。授权或撤销保存失败时分别呈现当前会话与跨启动的实际结果，不宣称已经记住。

## 外部能力

Anthias 负责外部能力的接入和执行约束；具体工具的业务能力由外部实现。责任按实际持有的资源划分：

| Anthias 项目内 | 外部工具或服务 |
| --- | --- |
| 通用 CLI 的 Shell、cwd、权限、工作区协调、输出、超时、取消，以及本命令进程和输出流的有界恢复。 | CLI 的业务语义、参数解析、工具内部的进程组织与平台兼容。 |
| MCP 客户端、连接与传输资源的生命周期、协议调用、输入和结果校验、既有权限与事件。 | MCP Server 的具体能力、服务内部协议实现与服务管理的资源。 |
| 按需读取 Skill、保存来源并将操作纳入现有权限。 | Skill 描述的外部工具及其使用方法；文档不会授予额外权限。 |

浏览器的 daemon、session、namespace、profile、CDP、页面与截图归外部工具。Anthias 不按命令名增加浏览器专用分派，不改写 agent-browser 命令，也不在 Session 中持有浏览器配置或自动关闭能力。命令资源无法确认结束时保持显式阻塞；外部工具自身的故障不能由无条件解锁掩盖。

内建 `web_search` 固定使用 SearchAPI Google 的 `https://www.searchapi.io/api/v1/search`，凭据来自可选 `SEARCHAPI_API_KEY`，仅通过 Bearer Header 发送，模型不能替换端点。它以内部工具扩展接入根与成员，只读成员可用，并沿用只读有界并发、生命周期事件和取消。缺少搜索配置仅使此工具不可用，不阻断其他 Coding 能力启动。

输入为最多 2000 字符的非空 query 和可选正整数 page；不自动翻页或读取全文。响应最多 1 MiB，保留最多 20 条、总计 60 KiB 的标题、URL、摘要和来源，单次请求超时 15 秒。服务错误只映射为安全结果，响应中的凭据回显被移除；结果作为带来源的不可信摘要进入上下文，不提升权限，最终主张需引用相应链接。

Skill 使用用户和项目 `.agents/skills`，扩展路径通过 `ANTHIAS_SKILL_DIRS` 传入。目录只保留有界元数据，正文与引用分别按需读取；实际内容作为 Session 来源事实保存，恢复保留已保存版本，文件变化给出诊断。外部指令和参考资料始终计入后续请求预算，压缩不把它们变为真实用户授权。

MCP 使用官方 TypeScript 客户端。配置发现与连接分开，`/mcp connect` 才启动 stdio 进程或 HTTP 连接。工具经 schema 与连接版本校验、现有权限/AutoAllow、开始事实和产物链执行；只读成员拒绝未知外部工具。资源按 URI 读取，模板由用户选择，其内容保持外部来源。配置格式及环境变量引用见 [Quick Start](../quick-start.md)，协议验证范围见 [Feature 006 Report](../specs/feature006-command-skill-mcp-tui/report.md)。

## 记忆与提示词编排

Feature 008 已实现主动记忆和 `/memory` 管理。应用根目录的 `memory/user/`、`memory/experience/<project-id>/` 与 `memory/state/` 分别保存用户条目、项目经验及本地设置。当前 Workspace 与应用数据根分别装配；同仓库工作树按共同 Git 目录归组，各自读取自己的项目根 AGENTS.md，未提交仓库与非 Git Workspace 也可使用记忆。

`memory/` Module 持有存储、修订校验、范围和时效；`tool/memory-tools.ts` 绑定真实用户或已完成 Tool 证据，根校验成员候选，成员条件以自己的工作树取证。人工确认保留原证据来源，后续自动维护不能覆盖用户确认的内容。候选不默认采用，文件或分支条件变化进入待复核，读取不会刷新确认时间。自动开关控制自动维护，受管应用记忆维护不授予工作区写入权，Workspace 权限独立检查。

请求文本按固定基础规则、少量通用用户记忆、初始环境、项目规则、Skill 目录、经验索引与少量正文、会话历史及动态来源排列。`tools` 保持独立字段并按名称稳定排序；系统模板不重新拼入变化的正文。来源首次采用形成有界快照，后续真实变化追加新版本；按需正文位于对应完整 Tool 组后，Tool 结果只确认采用或引用，不重复携带正文。语义优先级为真实用户要求、项目规则、有效经验、用户记忆，传输角色不会改变来源身份或授予权限。

Session 保存实际消息与采用事实，memory 保存当前跨会话状态，Context 通过持久 entryId / seq 选择模型投影。Schema 3 的来源与压缩记录增加可选的版本 1 投影元数据，包含触发身份、保留消息身份、来源版本及折叠边界；新实现兼容没有这些字段的旧记录。完整候选校验并写入后才切换投影，不按正文相等猜测消息身份。只读历史保持原事实，显式继续才检查当前来源。

遗忘保留不含正文的抑制标记，后续采用移除相关记忆与受影响摘要；明确停止发送时还过滤相关原始消息的模型投影。已经发送的请求无法撤回，执行未开始的 Tool 前会重新核对撤销状态。存储提交与 Session 采用分别处理，采用失败会如实说明“记忆已保存”，封口当前 Run，恢复时重新对齐。取消不能将已经提交的写入报告为未保存。

来源正文继续计入请求预算，缓存用量只使用 Provider 返回值，未知保持未知。已移除每 Run 12 次和整组 60 次调用截止；30 分钟共享任务时限、32 个 ToolCall / 批、只读四并发保持，成员执行限制已由 Feature 014 调整为九个（加根共十个）。实现与本地验证范围见 [Feature 008 Report](../specs/feature008-memory-and-prompt-orchestration/report.md)。

## 设计约束

- 优先形成深 Module：TUI、测试和未来 Desktop 使用同一个小 Interface，不穿透 Agent 内部步骤。
- 只有真实变化才建立 seam；Model Stream 和搜索请求的测试注入留在 Agent Module 内部，不扩张 Provider 体系或公开配置入口。
- Agent 状态只有一份。交互层可以保存渲染数据，但不能成为生命周期权威。
- 普通函数和判别联合足以表达的行为，不增加类层级、Registry、Manager 或通用框架。
- 取消、进程信号、终端状态、模型流和后续 Tool 资源必须有明确持有者与释放时机。
- 敏感值只进入被忽略的本地配置或环境变量；仓库只保存变量名、占位符和安全默认值。

## 仍待后续 Feature 决定

- 旧 Workspace 内 Session 的可选迁移能力；当前实现明确不自动扫描或迁移；
- 长历史检索与 Session 持久化扩展；
- OS 沙箱、低权限执行和网络隔离；
- 多 Provider、模型切换和 Provider 专属能力；
- Desktop 框架、进程模型和传输协议；
- Coding Agent 基础功能的具体使用场景与系统提示词；
- 工程验证所需的工具接入、场景数据准备、验证程序与证据关联机制；具体接口、存储格式和工具选型尚未确认。

这些未决项必须由对应 Feature 的真实用户结果证明，不以空接口、预留层或通用基础设施提前实现。

## 多 Agent 协作

[Feature 014](../specs/feature014-unified-multi-agent/spec.md) 将 SubAgent 与 Team 合并为根 Session 的一个隐式群组；实现与验证状态见 [Report](../specs/feature014-unified-multi-agent/report.md)。每名成员持有独立 Session、上下文和 Run，完成后保留为 idle。总执行并发十个，其中根保留一个位置，九个成员位置饱和时排队；空闲、暂停、关闭不占执行位置。

`multi-agent/members.ts` 持有成员、执行位置和取消，`tasks.ts` 持有正式任务，`mailbox.ts` 持有稳定 ID 投递与消费确认，`shared-notes.ts` 串行维护根目录下唯一笔记。`index.ts` 绑定根权力、群组暂停来源和三十分钟共享时限。SessionAgent 继续持有模型和输入安全点，协调器不复制 Agent Loop。TUI 统一使用 `/agent` 与 `collaboration.snapshot/execute`；旧 Team 动作仅在内部兼容，不再暴露两套模型工具。

用户高于根，根高于成员。根可以创建、分派、停止、重开和绑定成员工作区；成员可以通信、更新自身任务、查看公开快照和追加笔记。根可读成员完整历史，普通成员只能查看同伴公开结果。组内内容保留来源，不能变成真实用户授权。用户直接通过协作入口提交正式任务时，先保存根 `coordination/user_request` 事实；AutoAllow 与压缩校验使用该真实用户原文，模型发消息不能产生这种授权。用户暂停群组同时停止根和成员，根不能借新建成员解除；用户明确继续后才恢复调度。

消息先写根 `coordination`，在成员 `agent_input` 持久化后确认消费。运行中在整个工具批次完成后的安全点插入，空闲成员由调度唤醒；暂停保持队列，关闭拒绝新消息，重开需要根明确调用。每个收件者最多三十二条待处理消息，每条十六 KiB。根正常完成关闭新唤醒，已启动 Run 在原期限内收尾，迟到消息保留历史；根失败或用户停止收束成员；Esc 输入中断只取消根当前 Run，后续存储失败仍收束成员。重启只恢复状态，用户明确继续群组后才执行，消息不能重置时限。

成员默认共享根工作区且可写，根可独立限制为只读；可写不创建工作树。需要隔离时先显式创建或选取受管 worktree，再绑定停止中的成员。绑定事实保存在根日志，执行打开核对成员所属根与当前绑定，保留原 Header。工作树只带入明确提交，不复制未提交文件、依赖或凭据。

文件工具读取返回完整原始字节 SHA-256，编辑和覆盖携带 `expectedVersion`，新建使用 `missing`，成功原子替换返回实际提交字节的 `newVersion`。批准期间不持锁，取得写入权后再次核对内容、文件/父目录身份、授权与取消，然后原子替换。同一真实路径或文件身份串行，不同文件可以并行；命令独占所属工作区写入阶段，Git 变更在同一协调器内对相关工作区排他并重新核对批准指纹。取锁等待可取消，并独立使用命令 timeoutMs 作为上限；执行另行计时。清理不明时，用取锁时冻结的真实资源键建立显式阻塞，拒绝受影响的排队与后续写入，再结束普通租约。阻塞保存到 Session 数据目录的 workspace-blocks；仅根可请求检查，外部清理确认只从直接用户入口接受。保存或恢复失败保留保护，恢复不重放命令，也不凭裸 PID 接管资源。以上只协调本进程的受管操作，不约束外部编辑器或其他进程，不构成 OS 沙箱。

运行中 Enter 默认 followUp；Esc 提升两个队列中最早、尚未领取的用户输入，沿用 inputId，立即取消并等待旧 Run 自己的必要清理。清理不明时输入绑定该 Run 的具体 blockId；旧 Run 的阻塞不拦住纯模型对话。停止撤销后续自动继续，迟到清理不能覆盖新的停止。成员状态保留简短故障，agent_wait 按新故障序号提前返回；模型列表与等待不再携带完整任务。

当前 Session 仍使用 Schema 4，根位于 `data/conversation/<UTC日期>/<时间戳>-<根ID>/`，成员位于根目录下 `members/<成员ID>/`，唯一笔记为根目录的 `shared-notes.md`。历史 `plan`、`subagent`、`teammate` 记录继续可读；存储标签不决定运行时两套行为。未消费消息、未完成任务和受管工作树等阻止整组清理，关闭成员不删除源码或历史。
