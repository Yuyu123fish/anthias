# 主流 Coding Agent 的主动长期记忆调研

状态：调研完成；Anthias 已确认的方案见 [Spec](spec.md)，实现结果见 [Report](report.md)。

## 开发者速览

> **一句话**：三家的主动维护路径不同；Claude 默认自动写入，Codex 需启用，Gemini 的自动提取仍须人工采纳。<br>
> **核心做法**：以官方文档和固定公开源码提交核验采集、范围、注入、时效、纠错与隐私边界。<br>
> **边界**：只调研本地 Coding Agent 的长期记忆，不决定 Anthias 产品合同、缓存方案或实现。<br>
> **风险 / 未验证**：未操作真实模型或不同账户策略；开源实现默认值可能随版本改变。<br>
> **当前 / 请审阅**：本文保留 2026-09-06 的外部事实，后续取舍与实现分别记录在 Spec 和 Report。

## 问题与核验范围

本调查回答：主流 Coding Agent 怎样主动积累用户偏好、工作习惯和项目事实；这些内容何时写入、何时进入新 Session，以及如何由用户纠错或撤回。这里的“长期记忆”不等同于 `CLAUDE.md`、`AGENTS.md` 或 `GEMINI.md` 等固定规则文件：后者是用户或团队维护的显式上下文，前者才是由历史对话提取、索引或整理出的可变事实。

核验日期：2026-09-06。

资料只使用官方文档和官方 GitHub 源码。为避免把运行中的开发分支当作稳定产品承诺，本文将“官方文档已说明”与“固定源码提交可见”分开标注。未读取任何本机用户记忆、Session 或环境变量，也未调用真实模型。

| 主体 | 官方记忆页面 | 固定源码 / 版本边界 |
| --- | --- | --- |
| Claude Code | [How Claude remembers your project](https://code.claude.com/docs/en/memory) | 本次以官方文档为准；未把公开仓库 HEAD 当作其完整产品实现。 |
| OpenAI Codex | [Memories](https://developers.openai.com/codex/memories/) | [openai/codex `ac192cd`](https://github.com/openai/codex/tree/ac192cd7937b0d73edc6dffe009940ae53782dd4)，2026-09-06 取得 HEAD。 |
| Gemini CLI | [Auto Memory](https://geminicli.com/docs/cli/auto-memory/) | [google-gemini/gemini-cli `85aca16`](https://github.com/google-gemini/gemini-cli/tree/85aca163f6c73ac6ce380b5447359146b8adcae4)，2026-09-06 取得 HEAD。 |

## 对比结论

| 维度 | Claude Code | OpenAI Codex | Gemini CLI |
| --- | --- | --- | --- |
| 默认状态 | Auto memory 默认开启。 | 本地记忆默认关闭，须在 Desktop 设置或 `[features] memories = true` 启用。 | Auto Memory 是实验功能，默认关闭，须设 `experimental.autoMemory = true` 并重启。 |
| 自动采集 | 由 Claude 判断未来是否有用；不必每个 Session 都写。 | 启用后从符合条件的既有 chat 后台提取，避开活动或短时 Session。 | 启动时后台扫描已空闲的本地 Session，生成候选而非直接生效。 |
| 用户入口 | 说“记住……”可写入 auto memory；`/memory` 可浏览、编辑、删除和开关。 | `/memories` 控制当前 chat 是否读取既有记忆、是否作为未来生成输入；官方页面未承诺逐条审核收件箱。 | 直接编辑/让 Agent 写 Markdown 是显式路径；`/memory inbox` 审阅、应用或驳回自动候选，`/memory show`/`reload` 用于查看和重载。 |
| 范围 | 每个 Git repository 一个机器本地目录，所有 worktree 和子目录共享。 | 文档公开的是一个位于 `~/.codex/memories/` 的本地根目录；当前源码以 `cwd`、rollout 路径等来源字段分组，不能把它说成文档承诺的硬项目隔离。 | 候选收件箱按项目保存；私有 patch 指向项目记忆目录，全球 patch 只允许写个人 `~/.gemini/GEMINI.md`。 |
| 检索和注入 | 启动加载 `MEMORY.md` 前 200 行或 25KB，主题文件按需读取。 | 当前源码向 developer prompt 注入记忆使用指令，并让 Agent 先看摘要、再检索具体文件；这是源码行为。 | `GEMINI.md` 层级内容随每个 prompt 拼接；子目录上下文在工具访问相应路径时按需发现。应用的记忆 patch 会重载当前 Session。 |
| 时效与纠错 | 有 `modified` 时间戳和长度压缩提醒；没有官方自动 TTL，记忆保留到用户或 Claude 改/删。 | 当前源码有空闲、来源年龄和“未使用”筛选/清理参数，但它们不是事实真伪的自动判断。 | 3 小时空闲和至少 10 条用户消息是候选资格；官方文档未声明已生效记忆的自动 TTL。 |
| 写入保护 | plain Markdown，可审计和手工删除；外部 `CLAUDE.md` 导入另有首次审批。 | 生成字段会脱敏，但官方仍要求不要存 secret、分享前审阅；可禁止含 MCP/Web 等外部上下文的 chat 参与生成。 | 候选 patch 不能直接改活跃记忆、设置、凭据或项目 `GEMINI.md`；目标白名单校验后仍须用户批准。 |

## Claude Code：默认启用的本地 Auto memory

### 采集、写入与删除

- [官方文档](https://code.claude.com/docs/en/memory#auto-memory)将 Auto memory 说明为默认开启。Claude 会把未来会话可能有用的内容分成 `user`、`feedback`、`project`、`reference` 四类；可从代码或 Git 历史推得的架构、路径、调试修复，以及已在 `CLAUDE.md` 说明的内容会被跳过。它不会在每个 Session 都写入。
- 用户可直接说“remember …”，也可通过 [`/memory`](https://code.claude.com/docs/en/memory#view-and-edit-with-memory) 打开目录、编辑和开关 Auto memory。自动记忆是 plain Markdown，用户可以随时编辑或删除；官方例子也明确区分“请记住”写入 Auto memory 与“写入 `CLAUDE.md`”的显式请求。
- 存储位置为 `~/.claude/projects/<project>/memory/`；其中 `MEMORY.md` 是索引，主题文件保存单条或单组记忆。项目标识按 Git repository 派生，因此同一仓库的 worktree 和子目录共用；文件只在当前机器本地，不在机器或云环境之间自动共享。[官方存储说明](https://code.claude.com/docs/en/memory#storage-location)

### 检索、时效与来源

- 每个新会话只启动注入 `MEMORY.md` 的前 200 行或前 25KB，以先到者为准；更具体的主题文件由 Claude 以标准文件工具按需读。[官方加载规则](https://code.claude.com/docs/en/memory#how-it-works)显示出“短索引 + 延迟展开”的两层检索，而不是把全部历史塞进 prompt。
- 写入带 YAML frontmatter 的记忆文件时，Claude Code 会记录 ISO 8601 的 `modified` 时间戳；接近索引上限时会提醒 Claude 合并、移出细节或删除陈旧条目。该时间戳是“上次写入时间”和审计线索，不是已验证事实的有效期。
- 旧 Session transcript 可按 `cleanupPeriodDays` 清理，但 memory 目录被排除；`MEMORY.md` 和主题文件会留存到用户或 Claude 编辑/删除。因此“Claude 有时间戳”不能被误解为“Claude 自动 TTL 过期”。[官方保留边界](https://code.claude.com/docs/en/memory#storage-location)
- `/memory` 和 `/context` 分别提供文件审阅与当前实际加载检查；这给纠错提供了可见入口。文档没有把模型自己的判断说成事实验证机制，因此来自一次对话的项目陈述仍应能被用户撤回或改正。

### 权限与隐私边界

- Auto memory 是机器本地 Markdown，便于审阅，但官方页面没有给出“自动提取时哪些内容会发给哪一端”的完整数据流承诺，不能据此断言其不会离开进程或设备。
- `CLAUDE.md` 从项目外部导入文件时会首次弹出批准对话框；这是共享项目文本引用的保护机制，不应混同为 Auto memory 的逐条写入审批。[外部导入规则](https://code.claude.com/docs/en/memory#write-effective-instructions)
- 这套功能在官方文档中是已默认开启的产品行为；本文没有本地运行 Claude Code 验证不同版本、管理策略或账户设置下的实际开关结果。

## OpenAI Codex：显式开启、后台提取和本地来源链

### 官方文档已说明的行为

- [Codex Memories](https://developers.openai.com/codex/memories/)明确写明 local Codex memories 默认关闭。启用后，Codex 会从符合条件的既有 chat 中后台生成本地记忆，跳过仍活动或短时会话，并等待会话空闲以避免把未完成工作过早总结。
- 文件位于 Codex home 下，默认根为 `~/.codex/memories/`，包含 summary、durable entries、recent inputs 和 supporting evidence。文档建议将其视为 generated state：可在排障或分享 Codex home 前检查，但不要把手改文件当作主要控制面。
- Desktop 与 Codex TUI 的 `/memories` 为当前 chat 分别控制“可否使用已有记忆”和“可否作为未来记忆生成输入”；它不改变全局设置。全局还可分别关掉 `generate_memories` 和 `use_memories`，并设置 `disable_on_external_context`，使调用过 MCP、Web search 或 tool search 的 chat 不参与生成。
- 文档说生成字段会脱敏，同时仍要求不要把 secret 放进 memory、分享生成文件前检查。它没有描述 Gemini 那种逐条候选收件箱或对每条自动记忆的批准流程，不能补写成已有能力。

### 固定源码提交可见的时效、来源和注入机制

以下事实来自 [当前开源提交的配置定义](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/config/src/types.rs)与 [memory pipeline 说明](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/memories/README.md)，因此仅说明该提交的实现，不能替代上面的公开产品合同。

- Pipeline 只在根 Session 启动且非 ephemeral、Memory feature 已启用、不是 sub-agent、state DB 可用时异步运行。第一阶段从允许的交互 Session 选取 rollout，第二阶段再把原始条目整合为文件系统记忆。每个阶段都有锁、失败退避和有界扫描。
- 该提交的默认值是：每次启动最多处理 2 个 rollout，来源 rollout 最多 10 天、最少空闲 6 小时；`max_unused_days` 默认 30 天，且配置可限制在 0–365 天。阶段一的 prune 只清理长时间未使用的**原始 stage-1 output**；阶段二也用“最后使用时间或生成时间”筛选整合输入。
- 因而“30 天”不是“事实 30 天后失真”也不是已经写入的 `MEMORY.md` 的自动 TTL。源码的 consolidation prompt 仍要求根据保留的来源、`updated_at` 和冲突证据手术式更新或删除陈旧内容。这是存储成本/选择策略与事实有效性分离的直接例子。
- stage-1 记录 `rollout_path`、`cwd`、`git_branch`、`source_updated_at` 与生成时间；其提取提示词要求把用户消息作为偏好和约束的强证据，把 tool output/验证作为项目事实的强证据，并把 assistant 文本降级处理。整合提示词要求在记忆块中保留 `cwd`、rollout 来源和不确定性。[阶段一提示词](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/memories/write/templates/memories/stage_one_system.md)与[整合提示词](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/memories/write/templates/memories/consolidation.md)可追溯这些规则。
- `use_memories` 开启时，[memory extension](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/ext/memories/src/extension.rs)会向 developer prompt 注入读取指导；当前模板让 Agent 先看 `memory_summary.md`，再按关键词查 `MEMORY.md`，必要时才打开关联 rollout。这是渐进检索，而非完整历史注入。
- 当前源码另有一个 `dedicated_tools` 门控，默认 `false`。开启时，`add_ad_hoc_note` 工具可在用户明确要求“记住、忘记或更新”时创建一条只追加的 note；它不是官方文档承诺的默认交互，也不会直接等同于对 canonical memory 的删除或覆盖。[工具实现](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/ext/memories/src/tools/ad_hoc_note.rs)

### 项目范围的证据边界

官方文档只确认一个本地 Codex home 记忆根；固定源码的整合模板要求按 `cwd`/项目保留适用范围，且默认把不同 `cwd` 的相似任务分开。前者不足以证明“每个项目物理隔离”，后者也不足以承诺未来版本的产品范围。因此 Anthias 不应仅模仿文件位置，而应明确决定个人跨项目偏好、仓库事实和工作区临时知识能否互相读取。

## Gemini CLI：实验性候选收件箱

### 自动采集与显式写入

- [Auto Memory 官方文档](https://geminicli.com/docs/cli/auto-memory/)将其标为实验功能，默认关闭。启用后会在 Session 启动时后台扫描本地 transcript，从重复出现的事实、偏好、工作流约束和过程模式中草拟 memory patch 或 `SKILL.md`，不占用交互轮次。
- 自动提取只考虑至少空闲 3 小时、含至少 10 条用户消息的项目 Session；忽略活动、琐碎和 sub-agent Session。官方文档未给已应用记忆设定自动 TTL。
- 直接维护 `GEMINI.md` 或在对话中要求 Agent 记住某事，是另一条显式路径。`GEMINI.md` 可提供项目规则、persona 与代码规范；[memory management 教程](https://geminicli.com/docs/cli/tutorials/memory-management/)说明自然语言“remember”可让 Agent 编辑相应 Markdown 文件。

### 候选、范围与注入

- 自动提取只把 unified diff `.patch` 放入按项目保存的 inbox。用户通过 `/memory inbox` 可审阅 memory diff、应用或 dismiss 私有与全局 patch；已应用 patch 才更新底层文件并重载当前 Session。草稿不自动注入任何 Session。
- private patch 目标是项目记忆目录；global patch 只能目标个人 `~/.gemini/GEMINI.md`。当前源码的[路径白名单](https://github.com/google-gemini/gemini-cli/blob/85aca163f6c73ac6ce380b5447359146b8adcae4/packages/core/src/services/memoryPatchUtils.ts)明确排除 settings、credentials、OAuth、keybindings 等其他 `~/.gemini/` 内容。这是“提取 Agent 能提出，但用户才允许生效”的安全分层。
- 已生效的 `GEMINI.md` 会按 global、workspace/父目录和 JIT 子目录层级拼接，并随每个 prompt 传给模型；工具访问文件或目录时会发现对应路径的 JIT context。`/memory show` 可显示实际拼接结果，`/memory reload` 可强制重扫。[官方层级与检查入口](https://geminicli.com/docs/cli/gemini-md/)
- inbox、lock 和已处理状态使并发实例最多有一个提取服务运行，避免短时间反复扫同一历史；当前源码还把两次提取限制在至少 30 分钟间隔。[服务实现](https://github.com/google-gemini/gemini-cli/blob/85aca163f6c73ac6ce380b5447359146b8adcae4/packages/core/src/services/memoryService.ts)可核对该实现细节。

### 隐私、纠错与成熟度

- 自动提取只读取机器上已有 Session 文件，但会用模型调用分析选中的 transcript 片段；官方明确提醒这些片段可能被发送给已配置模型。提取 Agent 被要求脱敏 secret、token 与 credential，且不要原样复制大 tool output。
- 候选不会自动落入 active memory，用户可审阅、应用、驳回或 dismiss；禁用功能后已有 inbox 仍在磁盘。这种“人工采纳 + 可见 diff”是三家中最明确的纠错和权限入口。
- 它仍是实验功能，且提取依赖 preview Gemini Flash；不能将其候选质量、路径规则或 3 小时门槛表述为稳定默认产品能力。源码 `85aca16` 只证明本次核验时的实现。

## 对 Anthias Feature 008 的设计启示（不是产品决定）

1. **把四类状态拆开讨论。** 团队规则、用户个人偏好、仓库/工作区事实、一次会话的压缩摘要有不同的作者、范围、共享方式和撤销需求。把它们都塞进一个“memory.md”会同时损失审计性和上下文控制。
2. **来源应先于置信度。** 至少区分用户明确陈述、用户纠正、工具/验证证据、assistant 提议和外部文本；记忆条目应保留适用范围、来源指针、最后确认时间及不确定性。Codex 的 rollout provenance 与 Gemini 的可审 diff 都表明，后续纠错不能只靠一句压缩结论。
3. **分别讨论采集、保留与事实有效性。** 空闲窗口、最少对话量决定何时抽取；Codex 的 30 天参数涉及已提取原始产物的保留和整合输入选择；Claude 的 `modified` 表示最后写入。事实何时需要复核或不再注入，还需要独立的适用条件，不能从这些时间字段推出通用 TTL。
4. **默认自动写入与候选审核是独立选择。** Claude 偏向本地自动积累，Gemini 偏向先生成 diff 再由用户采纳，Codex 的官方页面提供 chat 级 read/generate 开关。Anthias 需要单独确定哪些类别可自动进入候选、哪些必须显式确认，以及如何显示“已记住/已忽略/已撤回”。
5. **限制常驻内容，其余按需展开。** Claude 的索引和主题文件、Codex 当前的 `memory_summary.md`/检索路径提供了直接例子；Gemini 的 JIT context 主要说明规则可以按路径加载，不能把它等同于长期记忆检索。Anthias 可讨论短启动索引、条目检索和可观测的“本轮实际注入内容”。
6. **共享边界必须先定。** 个人习惯可以跨项目，仓库事实通常不能；共享项目规则更不应被自动提取流程静默改写。无论采用文件还是数据库，项目/工作区归属、跨机器同步和导出前审阅都应进入 Feature 的显式决定。

## 证据边界与待讨论项

- 本文是外部事实调研，不是 Anthias 的 Spec、Plan、Tasks 或实施授权。
- Claude Code 的结论来自官方当前文档，没有在本地运行以验证管理策略、版本差异或模型调用数据流。
- Codex 的默认关闭、开关、文件根、脱敏与 chat 级控制来自官方文档；6 小时、10 天、30 天、来源字段和 dedicated tool 来自固定开源提交。源码参数可变，且 30 天不是事实自动失效。
- Gemini CLI 的“实验、默认关闭、3 小时、10 条用户消息、收件箱需批准、可能发送 transcript 片段”来自官方文档；path allowlist 与 30 分钟节流来自固定源码提交。没有据此推断其他版本或 Gemini 产品的默认行为。
- 三家都未证明“模型提取的偏好一定正确”。后续讨论应先决定：错误记忆的用户可见性、撤回后的再生成规则、需要复核的时间敏感事实类别，以及外部上下文是否可进入记忆候选。
