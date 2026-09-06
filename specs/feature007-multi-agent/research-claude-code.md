# Claude Code Subagents 与 Agent teams：有界比较研究

状态：调研完成；来源合同作为历史参照，最终决定以 Spec 为准。

## 开发者速览

> **一句话**：Claude Code 将独立委派与团队持续协作分为两种公开能力。<br>
> **核心做法**：对照官方文档核对上下文、权限、消息、任务和恢复合同。<br>
> **边界**：只研究公开文档，没有验证闭源核心实现或真实运行。<br>
> **风险 / 未验证**：文档合同不能证明内部持久化与并发实现。<br>
> **当前 / 请审阅**：研究已归入 Feature 007，项目决定见同目录 Spec。

> 调研日期：2026-09-06 <br>
> 范围：只考察 Claude Code 官方文档中 `Subagents` 与 `Agent teams` 的公开行为合同；未运行 Claude Code、未调用模型、未阅读或推断其完整核心源码。 <br>
> 用途：为 Anthias 后续讨论提供跨项目参照，不构成产品决定、Spec、Plan 或实施授权。

## 资料来源与证据边界

| 编号 | 一手来源 | 访问日期 | 本文使用范围 |
| --- | --- | --- | --- |
| S1 | [Create custom subagents — Claude Code Docs](https://code.claude.com/docs/en/sub-agents) | 2026-09-06 | Subagent 的上下文、返回、后台、恢复、工具、权限、Skills 与 MCP 合同。 |
| S2 | [Orchestrate teams of Claude Code sessions — Claude Code Docs](https://code.claude.com/docs/en/agent-teams) | 2026-09-06 | Agent teams 的会话、消息、任务、生命周期、持久化与限制。 |

两份页面是 Claude Code CLI 产品文档，不是完整源码或内部架构说明。页面偶尔提及 Agent SDK 在非交互模式、fork mode、`agents` 配置上的差异；本文没有另行调研 SDK API，也不把 CLI 合同泛化为 Anthias 的 SDK 合同。下文标记为“官方事实”的内容可直接回溯到 S1/S2；“设计启发”是基于这些事实的有限推断。

## 核心区别

| 维度 | Subagent | Agent team teammate | 证据 |
| --- | --- | --- | --- |
| 基本定位 | 单个会话内的专门工作者，隔离处理支线工作，完成后把结果交回调用者。 | 由 lead 发起的多个独立 Claude Code session；teammate 之间可直接通信和协作。 | S1 “Create custom subagents”；S2 “Compare with subagents” 与 “Architecture” |
| 初始上下文 | 非 fork 实例从新的隔离 context window 启动；看不到父对话历史、已调用 Skill 或已读文件，只获得委派消息及规定的启动内容。fork 是继承父对话的例外。 | 每个 teammate 也有自己的 context window，载入项目 `CLAUDE.md`、MCP servers、Skills 和 lead 的 spawn prompt，但不继承 lead 的对话历史。 | S1 “What loads at startup”；S2 “Context and communication” |
| 信息回流 | 默认是结果回给调用者；命名且可返回 agent ID 的实例可继续被消息或恢复。 | 直接按 teammate 名称消息互通；完成或 API 失败时会通知 lead，包含最终答案或错误文本。 | S1 “Resume subagents”；S2 “Context and communication” |
| 协调模型 | 调用方管理委派；适合“只需要结果”的聚焦工作。 | team lead、共享 task list、mailbox 三部分协作；适合需要讨论、相互质疑或跨任务协调的工作。 | S2 “Compare with subagents”“Architecture” |
| 成本与复杂度 | 主对话只吸收返回摘要，文档将其描述为较低成本。 | 每个 teammate 有独立上下文，token 使用随活跃 teammate 数增长；还会带来协调与冲突成本。 | S2 “Compare with subagents”“Token usage”“Choose an appropriate team size” |

## Subagent：可确认的公开合同

1. **隔离与返回。** 非 fork Subagent 的 context 是新建且隔离的。它得到自己的 system prompt、委派任务、`CLAUDE.md` 层级、启动时的 Git status 快照，以及显式预加载的 Skills；它不自动继承父对话的历史、父方已调用的 Skills 或已读取的文件。委派完成后，调用方得到结果；fork 才会继承父对话。 <br>
   来源：S1 “What loads at startup”“Create custom subagents”。

2. **后台不是无主运行。** 前台 Subagent 阻塞主对话；后台 Subagent 与主对话并发，但需要权限的工具调用会回到主 session，由用户批准或拒绝。后台实例的 built-in tool 集合也会比前台更窄，虽然 MCP tools 保留。 <br>
   来源：S1 “Run subagents in foreground or background”“Available tools”。

3. **恢复以实例身份为边界。** 每次普通调用都会创建新实例；明确恢复已有实例时，它保留此前完整对话、工具调用、结果和 reasoning。内置 Explore、Plan 是 one-shot，不能恢复；用户在 `/tasks` 或 SDK `stop_task` 取消的实例，不会因 agent 消息而自动恢复。 <br>
   来源：S1 “Resume subagents”。

4. **工具和权限可按实例定义，但仍受会话边界约束。** Subagent 默认继承主会话可用的 built-in tools 和 MCP tools，再经工具过滤；定义可以用 `tools`、`disallowedTools` 和 `permissionMode` 缩小或改变其能力。未设 `permissionMode` 时继承主会话模式；后台的权限提示仍由主 session 呈现。 <br>
   来源：S1 “Available tools”“Permission modes”。

5. **Skills 与 MCP 不是同一种继承。** `skills` 可在启动时把指定 Skill 的全文注入 Subagent context；它并不等同于继承父方已经调用过的 Skill。`mcpServers` 的名字引用复用父 session 已连接的 server；内联 MCP server 在 Subagent 启动时连接、完成时断开，并受信任与 MCP 策略限制。 <br>
   来源：S1 “Preload skills into subagents”“Scope MCP servers to a subagent”。

## Agent teams：可确认的公开合同

1. **实验特性且默认关闭。** Agent teams 需要 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`；未开启时不会建立 team、写入 team 目录或派生 teammate。开启后，一个被命名的普通 Subagent 也可能被启动为 teammate，因此“命名委派”的运行语义会发生变化。 <br>
   来源：S2 “Orchestrate teams of Claude Code sessions”“How Claude starts agent teams”。

2. **lead 与 teammate 的边界。** 主 Claude Code session 是 team lead，负责派生、协调和汇总；teammate 是单独实例。任一 teammate 可直接给另一 teammate 发送消息，用户也能直接给指定 teammate 追加指令或调整方向。lead 在其生命周期内固定，不能把 lead 身份转让给 teammate。 <br>
   来源：S2 “Architecture”“Talk to teammates directly”“Limitations”。

3. **共享任务是可见的协调状态，不是聊天的替代品。** task list 中任务有 pending、in progress、completed 三态；未完成依赖会阻止 claim。lead 可以指派，teammate 可以自领；claim 使用文件锁避免多个 teammate 同时拿到同一任务。依赖任务在前置任务完成时由 Claude Code 自动解除阻塞。没有 Task tools 的 agent 只能通过消息协调。 <br>
   来源：S2 “Assign and claim tasks”“Architecture”。

4. **消息有投递成功与失败的边界。** 每个 agent 有本地 JSON mailbox。发送方只有在写入收件人 mailbox 成功后才得到“已发送”；磁盘满或目录不可写时发送方收到错误且消息不会投递。agent 间消息不能代替用户授权或绕过权限检查。 <br>
   来源：S2 “Architecture”“Messages between agents”。

5. **能力继承与 Subagent 有差异。** teammate 从 lead 的 permission settings 起步，权限提示汇集到 lead；但不能在 spawn 时直接设定单个 teammate 的 permission mode。Subagent definition 可以复用为 teammate 角色，不过 definition 的 `skills` 在两种 display mode 都不应用给 teammate；`mcpServers` 仅在 split-pane teammate 生效，in-process teammate 忽略该字段，改从项目和用户 settings 加载 MCP。 <br>
   来源：S2 “Use subagent definitions for teammates”“Permissions”。

6. **关闭、清理与恢复不是同一件事。** lead 可向命名 teammate 发 shutdown 请求，teammate 可以接受并优雅退出，或拒绝并说明原因。session 结束时 team config 目录会被删除；task list 本地保留并可被 resumed session 继续使用。可是 in-process teammate 不会被 `/resume` 或 `/rewind` 恢复，恢复后的 lead 可能仍尝试联系已不存在的 teammate。 <br>
   来源：S2 “Shut down teammates”“Architecture”“Limitations”。

7. **并行编辑有明确冲突风险。** 官方文档直接警告两个 teammate 编辑同一文件会造成 overwrite，建议将不同文件集的所有权分给不同 teammate。task claim 的文件锁只保证 claim 竞争，不等于为代码文件提供并发写保护。后半句是由这两条官方事实得出的推断。 <br>
   来源：S2 “Assign and claim tasks”“Avoid file conflicts”。

8. **限制直接影响是否应作为基础能力。** 文档明确列出：task 状态可能滞后；shutdown 可能要等当前请求或工具调用结束；一 session 只能有一个 team，不能跨 session 共享 team；不支持 nested teams；in-process teammate 不能派生后台 Subagent。 <br>
   来源：S2 “Limitations”。

## 对 Anthias 讨论有用的设计启发（推断，不是决定）

1. **不要把两类协作压成一个泛化对象。** Subagent 的核心合同是“隔离委派 → 有界结果/可选恢复”；team 的核心合同是“独立 session → 可寻址通信 + 协调状态”。如果产品同时支持二者，至少应把返回结果、成员身份、消息投递和共享任务视为不同的语义，而不是仅给同一个 `Agent` 多加几个可选字段。

2. **先保留最小的单向委派闭环。** 只有任务确实需要多个独立参与者彼此沟通、等待依赖或相互挑战时，才有理由进入 team 语义。S2 自己也把研究、review、竞争性假设列为合适起点，并提醒更多 teammate 会线性增加成本与协调负担。

3. **把权限的来源固定在用户/持有者，而不是 agent 消息。** Claude Code 对后台 Subagent 的提示回流、team 消息不能代替用户授权、teammate 权限提示回到 lead，这三项都指向同一条可借鉴原则：消息的发送者不自动获得批准他人副作用的权力。

4. **把实时成员和可恢复协调记录拆开。** S2 的 task list 可以本地保留，但 in-process teammate 不会随 session 恢复。这说明“恢复任务清单”不能被表述成“恢复原来的运行中成员”。Anthias 若未来需要恢复，应先定义哪些是 durable coordination facts，哪些只是已经失效的运行时句柄。

5. **在并行写入前先给出所有权边界。** 文件所有权、工作目录隔离或显式串行化至少要有一种。仅靠 task 的 claim lock 不能防止两个执行者写同一文件。这里不预设 Anthias 必须使用 worktree；S2 只明确证明同文件编辑会覆盖，并未给出所有 team display mode 的完整工作目录实现合同。

6. **避免把实验机制偷偷变成默认行为。** S2 显示，开启 team 后“命名 Subagent”本身可能改变为 teammate。对 Anthias 来说，委派模式、并发上限、后台运行、恢复与清理都应由明确的产品合同触发，不能让名称或 UI 偶然改变资源与权限语义。

7. **不要照搬本地文件路径或把公开文档当源码。** S2 公开了其 team config、task list 和 mailbox 的本地存储位置，这只能证明 Claude Code 当前暴露的产品行为；不能推出其内部并发、调度、崩溃一致性或安全实现细节，更不能作为 Anthias 的直接实现蓝图。

## 本轮没有验证、也不应据此声称的内容

- 没有运行 Claude Code，因此没有验证某一具体版本、操作系统、display mode 或 provider 下的实际行为。
- 没有调研 Claude Code 核心源码，不主张了解其完整进程模型、队列、锁实现、消息轮询、错误恢复或安全边界。
- 没有单独调研 Agent SDK API；本文只在 S1/S2 明确说明 SDK 差异时保留其存在，不推导 SDK 行为。
- S2 已明确将 Agent teams 标为 experimental，并列出恢复、任务状态、关闭和嵌套等限制；这些事实不足以证明它适合作为 Anthias 当前基础能力的完整实现依据。
