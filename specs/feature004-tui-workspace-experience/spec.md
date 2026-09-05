# Feature 004：TUI 交互与工作区启动体验

状态：实施中

## 开发者速览

> **一句话**：从任意项目启动 Anthias，呈现文件、代码、Reasoning 与 Tool 周期。<br>
> **核心做法**：Session 归 Anthias `data`；TUI 常驻路径，Shiki 高亮代码并收起思考。<br>
> **边界**：只显示 Provider 给出的 Reasoning；不含完整 Markdown、Session 管理器或 OS 沙箱。<br>
> **风险 / 未验证**：真实 DeepSeek Provider 与 Windows Terminal 主观视觉仍待授权或人工验收。<br>
> **当前 / 请审阅**：四个 Plan 的本地实现、自动门禁与 Windows ConPTY loopback 已完成；外部验收未齐，暂不标为“已实现”。

- 文档类型：Spec
- Feature 目录：`feature004-tui-workspace-experience`
- 关联基线：[产品定义](../../docs/product-definition.md)、[技术基线](../../docs/technical-baseline.md)、[Feature 003](../feature003-tool-execution-safety/spec.md)
- 技术调查：[终端内容渲染 Research](research-terminal-rendering.md)
- 实施计划：[Plan 01](plan-01-workspace-and-data-root.md)、[Plan 02](plan-02-agent-observability.md)、[Plan 03](plan-03-terminal-content-rendering.md)、[Plan 04](plan-04-interactive-tui-and-closeout.md)
- 任务事实源：[tasks.md](tasks.md)

## 1. 问题

当前 TUI 使用 Node.js `readline` 把 AgentEvent 逐行追加为 `You:`、`Assistant:` 和 `Tool:` 文本。它能够完成输入、流式输出、Tool approval、停止与退出，但没有稳定的视觉层次，也不能让用户持续看见 Agent 正处于请求模型、生成、运行 Tool、等待确认还是已经结束。

Assistant 正文目前也被当作不带语义的字符串直接写出：文件路径没有可靠标识，Markdown fenced code 没有语言配色，`tool_execution_start` 只有 Tool 名称与 ID，不能说明正在读取、搜索、修改或执行什么。当前 Model Adapter 还会丢弃底层 AI SDK 已经形成的 Reasoning 事件，因此界面既不能如实显示模型明确提供的思考文本，也不能区分“等待首个响应”和“正在思考”。

工作路径与对话数据路径也没有形成两个独立概念。Agent 默认把启动进程的当前目录作为 Workspace Root，同时又从 Workspace Root 推导 `data/conversation`。结果是从 `apps/tui` 启动时，Session 会落入 `apps/tui/data/conversation`；从其他项目启动时，又可能在目标项目中产生 Anthias 自有数据。

Anthias 需要一个能够长期承载 Coding Harness 的终端入口：用户从哪个项目启动，Agent 就明确操作哪个项目；Anthias 自己的数据始终归 Anthias 所有；整个 Run 的变化在界面上可理解、可追踪，但 TUI 不复制 Agent 的业务状态。

## 2. 目标

- 提供以对话正文为中心的现代 TUI，保留终端 scrollback，不做拥挤的全屏 Dashboard。
- 使用分叉尾 Anthias 图形与 `><°>` 终端标识建立项目自己的视觉身份。
- 在输入区下方常驻显示完整 Workspace Root，并同时显示权限模式、Session 与当前 Run 状态。
- 清楚区分用户消息、Assistant 流式正文、Tool 生命周期、approval、完成、失败和停止。
- 对经过 Workspace 校验的本地文件引用增加稳定标识与高亮，并在终端支持时提供不会自动打开的链接。
- 对带已知语言标记的 fenced code block 使用 Shiki 提供可复制、可降级的终端语法配色；未知语言保持原文。
- 在 Provider 明确返回文本 Reasoning 时实时展示有界思考窗口，结束后自动收起；没有 Reasoning 时不伪造内容。
- 每个活动 Tool 同时显示原始 Tool 名、用户可读动作与安全目标摘要，而不要求 TUI 解析 Tool 输入。
- 从任意已有目录运行 `anthias` 时，默认把该目录作为 Workspace Root；允许通过 `--workspace <path>` 显式选择。
- 把默认 Session Directory 固定到 Anthias Project Root 下的 `data/conversation`，不再由 Workspace Root 推导。
- 保持 Session 与规范化 Workspace Root 的绑定；从错误工作区重开时明确拒绝。
- 保持 Agent Interface 是消息、Run、Tool、权限和 Session 的唯一行为权威。
- 为交互式 TTY、窄终端、无颜色环境和非 TTY 管道提供明确降级行为。

## 3. 核心术语与所有权

### 3.1 Anthias Project Root

当前本地 Anthias 发行或源码检出的根目录，即持有根 `package.json`、`apps/`、`docs/` 与 `specs/` 的目录。它由 Anthias 启动装配从自身安装位置确定，不能从用户的 Workspace Root 向上搜索，也不能随当前工作目录变化。

### 3.2 Workspace Root

本次 Session 允许只读 Tool、相对文件修改和 command `cwd` 使用的规范化真实目录。默认值是用户执行 `anthias` 时的当前目录；`--workspace <path>` 可以显式覆盖。

### 3.3 Anthias Data Root

Anthias Project Root 下的 `data` 目录。它属于 Anthias 应用，不属于 TUI package，也不属于当前 Workspace。

### 3.4 Session Directory

默认值为 `<Anthias Data Root>/conversation`。每个 Session 仍使用一个 `<sessionId>.jsonl` 和运行期间的独占锁；Session Header 继续记录其 Workspace Root。

### 3.5 TUI Presentation State

输入缓冲、焦点、终端宽度、Tool 详情展开状态、瞬时 Reasoning 缓冲与计时、颜色能力和当前可见区域属于 TUI Presentation State。它可以由 TUI 持有，但不能决定 Run 阶段、Tool Policy、approval 是否有效或哪些消息已经持久化。

### 3.6 Visible Reasoning

Provider 通过 Model Adapter 明确交付的文本 Reasoning。它是可选的瞬时模型输出，不等于 Agent 的隐藏推理、系统 Prompt、内部日志或由 TUI 猜测出的步骤。只有这一类文本可以进入“思考中”区域。

| 对象 | 权威持有者 | TUI 可以做什么 |
| --- | --- | --- |
| Workspace Root 与 Session Directory | 启动装配与 Agent Session | 显示，不自行重新解析 |
| 消息、Run、Tool、approval、Permission Mode | Agent | 通过 state 和 AgentEvent 呈现与调用公开命令 |
| Visible Reasoning 生命周期 | Model Adapter 与 Agent | 通过瞬时 AgentEvent 显示、计时和收起，不伪造 |
| JSONL 与锁 | Agent Session | 不读取、不写入 |
| 输入、折叠、颜色、内容样式、布局 | TUI | 独立维护呈现状态 |

## 4. 用户故事

以下用户故事统一采用“作为……我希望……以便……”结构。

1. 作为在本地代码库中工作的开发者，我希望在当前目录直接运行 `anthias`，以便无需先切回 Anthias 仓库。
2. 作为需要操作另一个目录的开发者，我希望通过 `--workspace <path>` 明确选择工作区，以便启动位置不限制目标项目。
3. 作为关注文件安全的开发者，我希望始终看见完整工作路径，以便在输入或批准副作用前确认 Agent 正在操作哪里。
4. 作为使用多个项目的开发者，我希望 Anthias 的对话数据集中保存在 Anthias 自己的 `data` 目录，以便目标项目不被应用数据污染。
5. 作为重开历史工作的开发者，我希望 Session 仍与创建时的 Workspace 绑定，以便不会在错误项目中继续执行旧上下文。
6. 作为首次进入 TUI 的开发者，我希望立即看见 Anthias 身份、Session、模式和工作路径，以便理解当前运行上下文。
7. 作为正在交谈的开发者，我希望用户消息和 Anthias 回复具有稳定层次，以便快速区分输入、正文和系统状态。
8. 作为等待响应的开发者，我希望看见真实的请求模型、流式生成、Tool 执行和等待确认状态，以便判断 Agent 是否仍在工作。
9. 作为审查 Agent 行为的开发者，我希望每个 Tool 显示名称、目标、状态和可追踪归属，以便理解并发完成顺序。
10. 作为审批副作用的开发者，我希望在独立确认区看见目标、预览、风险和真实执行边界，以便作出一次性决定。
11. 作为需要更多证据的开发者，我希望能够展开或收起 Tool 详情，以便在简洁视图和完整输出之间切换。
12. 作为需要中断任务的开发者，我希望运行时 `Ctrl+C` 停止当前 Run、空闲时退出，以便控制资源而不破坏 Session。
13. 作为遇到失败的开发者，我希望错误说明发生了什么以及下一步怎么做，以便恢复输入而不是停留在损坏界面。
14. 作为使用窄窗口或调整终端尺寸的开发者，我希望布局保持可读且工作路径仍可见，以便不因重排误解当前状态。
15. 作为在不支持颜色或 Unicode 的终端中工作的开发者，我希望得到等价的 ASCII 与文本状态，以便功能不依赖特定字体。
16. 作为通过管道或自动化启动 CLI 的开发者，我希望非 TTY 输出保持确定、无 ANSI 控制序列，以便日志可以稳定读取。
17. 作为阅读 Agent 结论的开发者，我希望本地文件引用具有统一标识和高亮，以便快速定位它正在讨论的源码。
18. 作为阅读代码建议的开发者，我希望已标记语言的代码块具有克制的语法配色，以便结构清楚且仍能直接复制。
19. 作为等待 Reasoning 模型的开发者，我希望生成时看见模型明确返回的思考文本、结束后自动收起，以便理解进度又不淹没答案。
20. 作为观察 Tool 执行的开发者，我希望看见“哪个 Tool 正在对什么目标做什么”，以便不用从原始参数猜测当前动作。

## 5. 启动与路径合同

### 5.1 CLI

本 Feature 的用户入口为：

```text
anthias [--workspace <path>] [--session <UUID>] [--mode <agent|plan>]
```

- `anthias` 必须能够在任意已有本地目录中启动。项目需要提供一次性、可重复的本地安装或 link 方式，但不能在运行时静默修改用户 `PATH`。
- 未提供 `--workspace` 时，Workspace Root 是 CLI 被调用时的当前目录经过 `realpath` 后的结果。
- `--workspace` 接受绝对路径，或相对于 CLI 调用目录的相对路径；最终必须解析为一个真实存在且可访问的目录。
- `--workspace` 不改变进程查找 Anthias Project Root 或 Data Root 的方式。
- 未知参数、缺失参数值、目标不存在、目标不是目录或真实路径解析失败时，CLI 在创建 Session 和请求模型前失败，并返回非零退出码。

### 5.2 路径常驻呈现

- 交互式 TUI 的最底部必须持续显示 `cwd: <完整 Workspace Root>`。
- 正常宽度下不只显示目录 basename，也不使用可能混淆两个项目的无说明省略。
- 窄终端中允许让路径独占一行并自然换行，不能优先隐藏路径来保留装饰信息。
- approval 区继续显示当前副作用的精确目标；底栏 Workspace 不能替代 approval 目标。

## 6. Session 存储与兼容

- 默认 Session Directory 改为 `<Anthias Project Root>/data/conversation`。
- 禁止继续把 Workspace Root、`apps/tui` package 目录或进程偶然的 package-manager `cwd` 当作默认 Session Directory。
- 现有 `ANTHIAS_SESSION_DIR` 保留为显式测试或运维覆盖；正式默认路径不依赖该环境变量。覆盖值必须是绝对目录，相对值无效，不能相对于 Workspace Root 或 CLI 调用目录解析。仓库内示例不得把真实用户路径写死。
- Session Schema 1、JSONL 记录、锁、恢复、checkpoint 和消息顺序保持不变；Session 层在本 Feature 中只改变默认物理位置和启动装配。
- Visible Reasoning 与其 start / update / end 事件不写入 JSONL。Agent 只可在当前 Model → Tool → Model continuation 内保留 Provider 回传所需的 Reasoning；Run 结束后不把它作为后续 Session 上下文，TUI 也不得声称在重开 Session 时恢复了思考内容。
- 创建新 Session 时，应按需创建 `data/conversation` 及其本地忽略规则；目录或文件不可写时，在模型请求和 Tool 副作用前安全失败。
- `--session <UUID>` 从当前有效 Session Directory 打开 Session，并继续校验 Header 中的 Workspace Root。
- 当前 Workspace 与 Session Header 不匹配时拒绝重开，错误需要同时说明当前工作区、Session 所属工作区和修复方式，不自动切换工作区。
- 旧的 `<workspace>/data/conversation` 与 `apps/tui/data/conversation` 不自动扫描、移动、合并或删除。需要时可以显式设置 `ANTHIAS_SESSION_DIR` 访问；自动迁移不属于本 Feature。
- 无论 Session Directory 是否位于当前 Workspace 内，全部文件 Tool 和 command `cwd` 都继续避开活动 Session Directory。

## 7. 视觉身份

### 7.1 图标

正式图形概念是一条向右游动的 Lyretail Anthias 侧影：

- 修长鱼身和上扬背鳍表达 Anthias，而不是通用胖鱼或小丑鱼；
- 尾鳍明确分为上下两支，对应从共同位置产生候选执行方向；
- 身体负形可以轻微形成字母 `A`，但不能牺牲鱼的识别度；
- 完整图形用于未来品牌资产；本 Feature 只要求终端文字标识。

终端主标识固定为 `><°>`，无 Unicode 能力时降级为 `><o>`。启动标题可以显示 `><°> Anthias`；单条 Assistant 消息只显示紧凑标识，不重复大型 Logo。不得使用显示宽度不稳定的彩色 Emoji 作为唯一图标。

### 7.2 色彩

主要参考色如下；终端实现选择最接近且具有足够对比度的 True Color 或 ANSI 色：

| 名称 | 参考值 | 用途 |
| --- | --- | --- |
| Anthias Coral | `#FF7A59` | 主鱼标识、活动状态、代码数字与常量 |
| Reef Rose | `#E85D9E` | Anthias 回复、Reasoning 焦点与代码类型名 |
| Fin Violet | `#8B6FF2` | Permission Mode、approval 与代码关键字 |
| Lagoon | `#46BFC3` | 文件引用、成功、只读 Tool 与代码字符串 |
| Pearl | `#F2EDF6` | 深色终端上的正文与代码普通标识符参考 |
| Reef Slate | `#8E8796` | 次要信息、耗时、Session 短 ID 与代码注释 |

Anthias 不修改用户终端背景与字体。颜色只能增强层级，不能成为区分 completed、failed、denied 或 aborted 的唯一手段；无颜色模式必须保留文字和符号。

颜色能力与 hyperlink 能力分别探测、分别降级。非空 `NO_COLOR` 关闭颜色但不移除文件标识；非 TTY 同时关闭颜色、动态帧与 OSC 8。

### 7.3 布局原则

- 借鉴 Claude Code 的对话优先信息组织：历史进入 scrollback，Tool 就近呈现，输入与运行上下文位于底部；不复制其名称、图标、配色、文案或逐字符布局。
- 主轴左对齐，对话正文优先，装饰保持克制。
- 只在 approval、错误和输入区等真实边界使用框线，不把每条消息切成相同卡片。
- 历史消息进入稳定 scrollback；只有当前流式消息、活动 Tool、approval、输入区和底栏动态刷新。
- 不进入 alternate screen，不牺牲终端复制、搜索和历史回看。
- 唯一持续活动效果可以是低频的鱼尾或状态标识变化；退出、无动画或非 TTY 模式使用静态符号。

### 7.4 文件引用与代码

- 本 Feature 只解释明确的 Markdown inline code、Markdown 本地链接以及 fenced code block，不从普通自然语言中猜测任意路径或语言。
- inline code 或 Markdown 目标只有在去除可选行列号后能够规范化到 Workspace Root 内一个真实普通文件时，才显示为 `▧ <相对路径>:<行>`；无 Unicode 时使用 `[file]`。目录、不存在路径、Workspace 外路径和解析失败内容保持原文且不可点击。
- 支持 OSC 8 时，可以把已验证文件标识链接到对应本地文件；显示文本始终保留路径，链接不自动打开，也不能携带模型提供的控制序列。终端不支持时只保留标识与颜色。
- 行号与列号属于始终可见的 label；点击后能否在某个编辑器精确跳转不是本 Feature 承诺。UNC、WSL UNC、SSH 和远程 Workspace 首期不生成文件链接。
- fenced code block 的 info string 命中受支持语言或别名时执行语法高亮；未标语言、未知语言、未闭合或超过安全上限的代码块使用无配色代码样式，不做自动语言猜测。
- 代码块使用独立语言标题和收尾线形成边界，不给每行添加装饰字符，不修改终端背景、不默认添加行号，也不让 renderer 自己生成的 ANSI 进入 plain 输出。
- 高亮只基于语法 grammar，不引入 LSP 或语义分析。语法高亮库固定为 Shiki，不再比较或引入其他 highlighter；首批语言至少覆盖 TypeScript、JavaScript、JSON、Markdown、Bash、PowerShell、Java、Python、YAML 与 SQL。Plan 可以根据本地测量确定 Shiki 的 package 入口、按需加载方式与缓存生命周期，但不能替换库。

| 代码类别 | 终端语义 |
| --- | --- |
| 关键字与控制结构 | Fin Violet |
| 类型名、函数声明 | Reef Rose |
| 字符串与已识别路径 | Lagoon |
| 数字、布尔值与常量 | Anthias Coral |
| 注释 | Reef Slate，并在支持时 dim |
| 普通标识符与标点 | 终端默认前景色；深色参考为 Pearl |

## 8. 效果稿

以下为约 76 列终端中的结构效果。Markdown 无法直接表现 ANSI 颜色，因此路径标识与代码 token 的实际颜色遵守上一节；框线不是要求逐字符照抄的测试快照。

```text
><°> Anthias
Session 7b4c2a91                                          Agent

 You
 请检查 Run 阶段为什么显示不准确，并给出修改方案。

 ><°> Anthias
 我先查看 ▧ apps/agent/src/run.ts:423 和事件定义。

   ╭─ 思考中 · 2.8 s ─────────────────────────────────────╮
   │ 当前 phase 只在内存中改变，Tool 结束后没有事件说明    │
   │ Agent 已重新请求模型，需要补一个明确的阶段事件……      │
   ╰───────────────────────────────────────────────────────╯

   ◌ read_file        读取 ▧ apps/agent/src/run.ts:423
   ✓ read_file        读取完成                              18 ms
   ◌ execute_command  运行 pnpm test                    等待确认

 ╭─ 需要确认 ───────────────────────────────────────────╮
 │ pnpm test                                             │
 │ 将以当前用户权限运行；没有 OS 沙箱。                  │
 │ [y] 允许一次                       [n] 拒绝            │
 ╰───────────────────────────────────────────────────────╯

 ─────────────────────────────────────────────────────────
 > 输入消息……
 cwd: C:\projects\example
 Agent │ 等待确认 │ Session 7b4c2a91 │ Ctrl+C 停止
```

Reasoning 结束后收为一行，代码块保留独立层级，输入区重新可用：

```text
   ▸ 思考了 3.4 s
   ✓ execute_command  pnpm test                   125 tests passed

 ><°> Anthias
 问题在 ▧ apps/agent/src/run.ts:423。建议让 Agent 发布明确事件：

   ─ TypeScript · apps/agent/src/run.ts
   export type ToolActivity = Readonly<{
     toolName: string;
     summary: string;
   }>;
   ────────────────────────────────────────────────────────

 ─────────────────────────────────────────────────────────
 > 继续输入……
 cwd: C:\projects\example
 Agent │ 等待输入 │ Session 7b4c2a91 │ Ctrl+C 退出
```

窄终端优先保留正文、输入和完整路径，次要信息可以换到下一行：

```text
> 继续输入……
cwd: C:\projects\example
Agent │ 等待输入
Session 7b4c2a91 │ Ctrl+C 退出
```

## 9. 对话与 Run 呈现

### 9.1 稳定状态

| Agent 事实 | TUI 表现 |
| --- | --- |
| 没有 activeRun | 等待输入 |
| `requesting_model`，尚无 Reasoning 或正文事件 | 正在请求模型 |
| `reasoning_start` / `reasoning_update` | 思考中，并显示有界实时 Reasoning |
| Assistant 文本正在更新 | Anthias 正在回答 |
| `executing_tool` | 正在运行 Tool，并显示动作、目标与活动 Tool |
| `awaiting_tool_approval` | 等待确认，并把 approval 区设为当前焦点 |
| completed | 显示完成摘要并恢复输入 |
| failed | 显示安全错误与可执行的下一步并恢复输入 |
| aborted | 显示已停止并恢复输入 |

- TUI 只显示 AgentState、AgentEvent 和本地 UI 操作能够证明的状态，不把普通等待伪装成“深度思考”，也不展示模型未提供的隐藏 reasoning。
- `run_start` 建立初始 `requesting_model` 状态；此后每次公开 Run 阶段实际变化，Agent 都发布一次带 `runId` 与新 `phase` 的 `run_phase_changed`，使 TUI 不必从 Tool 事件猜测阶段。
- 一个 Run 可以经历多次“模型 → Tool → 模型”；界面必须在同一个 Anthias 回复周期下连续呈现，不能伪装成彼此无关的多轮对话。
- 用户消息只在 Agent 接受并持久化后进入稳定 transcript，TUI 不因本地键盘回显再复制一份。
- 重开 Session 时，历史 Message 采用与新消息相同的视觉语言；未持久化的流式 delta 不伪造恢复。

### 9.2 Reasoning

- Agent 只转发 Provider 明确给出的文本 Reasoning；不得通过 Prompt 要求模型吐出隐藏 Chain-of-Thought，也不得把等待时间、普通正文、Tool 参数或 Agent 日志包装成思考过程。
- 每个 Reasoning span 必须按 `reasoning_start` → 零到多个 `reasoning_update` → `reasoning_end` 成对出现；文本、ToolCall、模型完成、失败或 abort 到来前都必须收口当前 span。
- 活动时默认展开最近四个可见行，较早内容用一行省略提示表示，并持续显示由 TUI 单调时钟计算的经过时间；不得让长 Reasoning 无限推高动态区域。
- `reasoning_end` 后自动收为 `▸ 思考了 <耗时>`。当前 TUI 进程内可以通过与 Tool 共用的详情操作重新查看完整瞬时文本；具体按键与详情区域交互在 Plan 固定。
- Run 中可以因多次模型请求产生多个 Reasoning span，各自按出现位置归属于同一 Anthias 回复周期，不能合并到错误的模型轮次。
- Provider 未交付文本 Reasoning 时不显示空思考卡片；界面只保留“正在请求模型”或“正在回答”等有事实支持的状态。
- Reasoning 不持久化。重开 Session 时不显示旧思考内容、耗时或“已恢复”占位，也不影响已持久化答案与 Tool 事实。

### 9.3 Tool

- 每个 Tool 至少显示原始 Tool 名、目标或命令摘要、状态和可区分的 ToolCall 归属。
- Agent 必须从已经验证的 Tool plan 形成单行 `ToolActivity.summary`：`read_file` 表达读取文件与行区间，`glob` 表达匹配模式，`grep` 表达搜索词与范围，`edit_file` / `write_file` 表达目标文件，`execute_command` 表达实际命令。summary 不包含完整写入内容、未脱敏环境变量或 TUI 需要理解的原始 JSON。
- `tool_execution_start` 携带同一个 ToolCall 的 `ToolActivity`；TUI 同时显示 `toolName` 与 summary，update 和 end 继续按 `toolCallId` 更新该条目，不能只显示“正在使用工具”。
- 并发只读 Tool 的 start 按源顺序出现，end 可以按真实完成顺序更新各自条目；TUI 不能把后完成结果写到错误 Tool 下。
- 默认紧凑显示完成结果；用户可以通过统一详情操作展开或收起 Tool 输出与当前进程内的 Reasoning。具体按键在 Plan 中固定，但行为必须在运行中和完成后都可用。
- failed、denied、aborted 与 cleanup uncertain 使用不同文字和符号；cleanup uncertain 不能显示为 completed。
- 超长输出遵守 Agent 已有截断事实，TUI 不静默二次改写为“完整输出”。

### 9.4 Approval

- approval 是当前输入焦点，展示 Tool、精确目标、预览、Permission Mode、风险和 execution boundary。
- `y` / `yes` 只批准当前请求；`n` / `no` / 空输入拒绝；其他输入给出有效选项提示。
- approval 等待期间不能把普通文本提交为新 prompt，也不能切换 Permission Mode。
- approval 解决后，卡片保留最终决定并退出焦点，防止用户误以为仍可响应。

## 10. 输入、停止与退出

- 底部输入区在 idle 时接受 prompt，Enter 提交；空输入不创建 Run。
- activeRun 期间输入区显示当前不可提交状态，不缓存一条可能在错误上下文中自动发送的 prompt。
- `/mode`、`/mode agent`、`/mode plan` 与 `/exit` 保持现有语义。
- activeRun 时 `Ctrl+C` 请求 Agent abort；必须等待 Run 与已知资源收口后恢复 idle。
- idle 时 `Ctrl+C` 或 `/exit` 退出。
- EOF 期间若有 activeRun，先请求 abort，再取消订阅、恢复终端状态并退出。
- 多行编辑器、历史搜索、自动补全和命令面板不属于本 Feature；普通粘贴不能破坏终端状态或绕过 approval 输入。

## 11. 降级与失败表现

- stdout 或 stdin 不是交互式 TTY 时使用确定性的 plain renderer：不移动光标、不隐藏光标、不输出 ANSI 颜色或动态帧。
- 终端不支持 Unicode 时使用 ASCII 标识、边框与状态文本；功能和信息量保持一致。
- 模型正文、Reasoning、Tool 输出、路径和命令中的 ESC、OSC 及其他可执行终端控制序列必须在测量与渲染前移除或转义；只有 TUI renderer 可以产生 ANSI 样式与 OSC 8。
- 语法高亮器不支持语言、输入超过安全上限或自身失败时，代码块原样降级为无配色文本，不能导致 Assistant 消息或整个 TUI 失败。
- 调整终端宽度时只重排当前动态区域，不重复历史消息、不覆盖 prompt、不破坏正在输入的文本。
- 运行中窗口小到无法安全容纳完整上下文时，必须重新显示完整 Workspace、模式、Session 与状态并暂停 prompt / approval；不能隐藏决策上下文后继续执行，放大后自动恢复。
- TUI 初始化或渲染失败时必须恢复 raw mode、光标、监听器和订阅；不得留下无法输入的终端。
- 模型配置、Workspace、Session Directory 或 Session Header 失败时，显示具体可操作原因，返回非零退出码，并且不发起模型请求或 Tool 副作用。
- Session busy、Session changed 和 Workspace mismatch 保持不同错误，不合并成无法判断原因的“启动失败”。

## 12. 接口与模块边界

- `apps/agent` 继续拥有 Model Adapter、Session、Run、ToolRunner、Policy、approval 和 AgentEvent；`apps/tui` 只依赖 `@anthias/agent` 的公开入口。
- 启动装配必须把 Workspace Root 与 Session Directory 作为两个独立值交给 Agent，不再让 Session Directory 从 Workspace Root 隐式推导。
- Anthias Project Root 的解析属于应用启动边界；TUI 渲染组件不得通过 `__dirname`、`import.meta.url` 或向上搜索自行决定数据位置。
- 继续使用现有 `Agent.state`、`prompt`、`setPermissionMode`、`respondToToolApproval`、`abort` 与 `subscribe`；`RunPhase` 作为交互 Adapter 可导入的公开类型，仍只包含 `requesting_model`、`awaiting_tool_approval` 与 `executing_tool`。
- `AgentEvent` 新增 `run_phase_changed`，携带所属 `runId` 和新 `phase`。它只在阶段值实际变化时发布，是不进入 Session JSONL 的瞬时呈现事实；不得暴露模型内部轮次、隐藏 reasoning 或 Provider 类型。
- `AgentEvent` 新增 `reasoning_start`、`reasoning_update` 和 `reasoning_end`。三者都携带 `runId`，update 额外携带非空 `delta`；它们只代表 Model Adapter 已规范化的文本 Visible Reasoning，不进入 `Message` 或 Session。
- Agent 内部 Model Stream 必须保留当前 Provider 已经交付的 Reasoning 生命周期，并在同一 Run 的 Tool continuation 确有协议需要时回传；Provider 字段名、AI SDK 类型和这份临时模型上下文不得从 `@anthias/agent` 导出。
- `ToolActivity` 是交互 Adapter 可见的只读值，只包含 `toolCallId`、`toolName` 与单行安全 `summary`；`tool_execution_start` 携带它，summary 的形成归 Tool plan / Agent 所有。
- TUI 不得读取 Agent 内部对象，也不能根据 spinner、计时器或某个 Tool 是否刚结束自行推断 Run 阶段。
- Shiki 只能作为 `apps/tui` 内容 renderer 后的实现依赖；不得进入 `apps/agent`，也不得迫使 Agent 暴露 Shiki、React、终端或 Provider 类型。具体 package 入口、grammar / theme 按需加载和缓存生命周期由 Plan 固定。
- Session Schema 1 和六个 Tool 名称保持兼容。

## 13. 非目标

- 不实现 Session 列表、搜索、重命名、删除、自动续接或图形化管理器。
- 不自动迁移、复制或删除旧 Workspace 与 `apps/tui` 下的 Session。
- 不实现 Compaction、Checkpoint、执行分叉、候选比较或多 Agent。
- 不新增模型专用 Provider、凭据格式、系统 Prompt 指令、Tool 能力或 Permission Policy；只规范化通用 Model Stream 已明确给出的 Reasoning。
- 不实现 OS 沙箱、容器、低权限账户、网络隔离或可复用授权。
- 不实现 Desktop、Web UI、鼠标交互或完整品牌资产包。
- 不承诺完整 CommonMark、HTML、表格、图片或富媒体渲染；只实现本 Spec 明确列出的 inline code、本地文件引用和 fenced code block。
- 不实现 LSP 语义高亮、自动语言猜测、用户主题市场或所有语言 grammar；语法着色失败不能影响原文。
- 不展示、请求或推断隐藏 Chain-of-Thought，不持久化 Visible Reasoning，也不把它作为 Session 恢复能力。
- 不自动打开文件或外部 URL，不创建 Workspace 外文件链接，也不要求 OSC 8 才能识别文件引用。
- 不加入多行编辑器、输入历史搜索、自动补全或插件命令系统。
- 不自动修改用户 PATH，不发布 npm package，也不增加 DeepSeek 专用 Provider、模型枚举或配置分支；一次经开发者授权的真实 DeepSeek V4 Flash 冒烟只属于验证，不扩张产品能力。

## 14. 验收标准

1. 在两个不同临时目录调用同一个 `anthias` 入口时，各自 Workspace Root 等于对应真实目录，底栏持续显示准确完整路径。
2. `--workspace` 的绝对路径与相对路径行为一致；无效目标在 Session 创建和模型请求前失败。
3. 两个 Workspace 创建的 Session 都进入 Anthias Project Root 下同一个 `data/conversation`，目标项目和 `apps/tui` 不产生新的默认 Session。
4. 新 Session Header 记录正确 Workspace；匹配工作区可以重开，不匹配工作区明确失败且没有模型或 Tool 副作用。
5. 旧 Session 目录保持原样且不会被自动扫描；显式绝对 `ANTHIAS_SESSION_DIR` 仍可作为受控覆盖。
6. 交互式正常宽度效果包含 `><°> Anthias`、分层 transcript、文件标识、代码块、动态 Run 区、输入区和常驻路径底栏。
7. 请求模型、流式回答、串行或并发 Tool、approval、completed、failed 和 aborted 都由真实 Agent 事实驱动；每次公开阶段实际变化恰好产生一次归属正确的 `run_phase_changed`。
8. 确定性 Model Stream 交付两个 Reasoning span 时，每个 span 都严格形成 start / update / end，活动窗口最多显示最近四个可见行，结束后自动收为各自的耗时行。
9. Provider 没有交付 Reasoning 时不出现思考卡片；Reasoning 不进入 Session JSONL，重开后也不显示伪恢复内容，但持久答案和 Tool 事实不受影响。
10. Assistant 中指向 Workspace 内真实文件的明确引用显示 `▧` 或 `[file]` 与相对路径；不存在、目录、Workspace 外和解析失败目标保留原文且不可点击。
11. 支持 OSC 8 时，经过验证的文件引用可以点击且不会自动打开；不支持时仍有等价文字标识。模型提供的控制序列不能形成终端指令或链接。
12. 已支持语言的完整 fenced code block 由 Shiki 按 Anthias 代码色彩呈现；未知、未标、未闭合、超限和 Shiki 失败输入原样降级，无自动猜测且代码仍可复制。
13. 每个实际执行的 Tool 都同时显示 `toolName` 与 `ToolActivity.summary`；文件写入正文、环境敏感值和原始 Tool JSON 不进入 summary。
14. 并发 Tool 乱序结束时，每个 update、end 与 ToolResult 仍显示在正确 Tool 下，Reasoning 或正文刷新也不能覆盖其他条目。
15. approval 完整展示 Feature 003 已有模式、目标、预览、风险与执行边界；无效、重复或过期响应不能执行 Tool。
16. activeRun 与 idle 下的 `Ctrl+C`、`/exit`、EOF 和模式命令保持既有行为，退出后没有监听器、隐藏光标、raw mode 或活动资源残留。
17. 调整到窄终端再恢复宽度时，不重复历史、不丢输入，完整 Workspace 路径仍然可见，活动 Reasoning 仍受高度上限约束；低于安全尺寸时暂停提交 / approval，放大后恢复。
18. 无颜色、无 Unicode 和非 TTY 三种降级模式都保留等价状态；非 TTY 输出不含 ANSI 或 OSC 控制序列。
19. TUI 仍只依赖 Agent 公共 Interface；Session Schema 1 保持兼容，Model Stream、Provider、Policy 和 ToolRunner 不从 package 入口泄漏。
20. `pnpm verify` 通过；人工 Windows Terminal 验收先使用确定性本地 Agent 或 loopback，再以 Plan 模式运行一次已授权的 DeepSeek V4 Flash 冒烟。真实凭据只从 `DEEPSEEK_API_KEY` 临时映射给通用 Adapter，不进入输出、日志、Session 或仓库。

## 15. 验证决策

- 路径与 Session 行为优先通过真实 CLI 进程和系统临时目录验证，检查退出码、stdout/stderr、Session Header 与目录副作用。
- TUI 生命周期优先通过公开 Agent Interface 驱动，覆盖历史恢复、流式消息、Tool 并发、approval、停止、失败和再次输入。
- 用确定性 Model Stream 覆盖无 Reasoning、单个 span、多个模型轮次、Reasoning → text、Reasoning → Tool、失败与 abort 的事件顺序；不依赖真实 Provider 证明合同。
- 内容 renderer 分别验证 inline code、Workspace 内外文件、Windows / POSIX 路径、行列号、恶意 OSC / ANSI、完整与未闭合代码 fence、已知与未知语言以及超限降级。
- Shiki 高亮只对首批语言做代表性 token 断言，不为每种 grammar 复制大快照；Shiki 加载或渲染抛错时必须保留无样式原文。
- 交互式布局使用 PTY 或等价真实终端 seam 验证光标、resize、按键与清理；plain renderer 继续使用稳定流测试。
- 不为每个 ANSI 帧建立大面积脆弱快照。只对正常宽度、窄宽度和无能力降级保留少量结构快照，其余断言语义区域、文本和状态归属。
- 自动验证不能证明视觉质量。Report 必须记录一次 Windows Terminal 人工检查，至少覆盖启动、流式回复、Tool、approval、resize、停止与退出。
- 开发者已授权一次真实 DeepSeek V4 Flash 冒烟。它使用通用 OpenAI-compatible 配置、官方 `https://api.deepseek.com` Base URL 与 `deepseek-v4-flash` 模型 ID，只在目标进程环境中把 `DEEPSEEK_API_KEY` 映射为 `ANTHIAS_MODEL_API_KEY`；命令和报告不得读取、回显或持久化 Key。
- 相同代码版本已有可信的 Agent、Session、Tool Policy 与调度测试不重复扩写；只补本 Feature 改变的启动路径和 TUI 证据。

## 16. 确认边界

- 本 Spec 与四个 Plan 已由开发者确认并完成本地实现；Feature 仍等待真实 Provider 与 Windows Terminal 主观视觉验收，当前保持“实施中”。
- Shiki 已经确定为唯一语法高亮库。其 package 入口、首批 grammar 的具体导入、主题映射、缓存生命周期与性能预算，以及内部组件拆分、统一详情快捷键和本地 link 命令，由 Plan 根据 Research 固定，但不能改用其他 highlighter，也不能改变本 Spec 的路径、Reasoning、所有权、用户流程和失败合同。
- 如果实现需要持久化 Reasoning、改变 Session Schema、自动切换 Session Workspace、增加 Session 管理器或扩展 Tool/Permission Policy，必须停止并回到 Spec。
- 开发者最新授权要求连续实施完整 Feature，并在每个 Plan 完成后各做一次本地提交；推送和 PR 仍不在授权范围内。
