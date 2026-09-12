# Feature 006 调研：命令、Skills 与 MCP

状态：草稿

## 开发者速览

> **一句话**：先建立可发现的命令入口，再把外部 Skills 与 MCP 接入同一套上下文、权限和生命周期。<br>
> **核心做法**：参考 pi 的克制命令面与 Skills 加载方式，并按当前正式 MCP 规范划定接入范围。<br>
> **边界**：研究外部能力接入，不包含生成 Skill、执行分叉、市场或插件运行框架。<br>
> **风险 / 未验证**：MCP 已有新旧协议差异，外部服务与模型兼容性尚未运行验证。<br>
> **当前 / 请审阅**：当前是调研讨论，请确认命令、Skill 来源与 MCP 首版支持范围。

核验日期：2026-09-05。以下“事实”来自当日打开的官方文档、规范和只读源码；“建议”是供讨论的 Anthias 取舍，不是已确认 Spec 或实施授权。

## 问题、来源与范围

需要回答三个问题：哪些命令能让现有能力更容易使用；怎样直接使用外部 Skill 而不把全文常驻上下文；MCP 接入除了连接成功，还必须承担哪些实际行为。

本轮只读取公开资料和现有源码，没有安装 Skill、启动 MCP Server、读取凭据或调用真实模型。TUI 的全屏布局、固定面板、应用内滚动和闪屏原因由同目录另一份调查负责；本文只涉及命令入口需要的选择、提示与状态。

本地 Anthias 基线是 `main`、`8a829b4`。本地 pi 快照为 `581d75a89cea21e50d6a26df840352f94427f633`，不是最新上游；本文的当前 pi 行为另以当日上游文档核验。旧官方仓库地址已重定向到 [earendil-works/pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)。Codex 先读本地 `C:\reference\codex-main\docs\slash_commands.md` 和 `docs\skills.md`，两份文件指向官方文档，再在线核验；没有把未核对版本的本地枚举当作发布能力清单。

## 事实：Anthias 已有的基础

当前输入分发仅识别 `/exit`、`/details [prev|next]`、`/context` 和 `/mode`。未知 `/...` 没有统一错误分支，空闲时会成为普通 prompt。现有命令没有统一目录、参数说明或完成状态策略。[输入分发](../../apps/tui/src/terminal-conversation.ts)

Session 创建和按 ID 恢复已经存在于生产启动工厂，CLI 通过 `--session` 使用；交互中的 `/new`、`/resume` 以及手动 `/compact` 尚不存在。自动压缩是 Agent 内部行为，不能为了添加命令让 TUI 直接操作 Session 文件或内部 Context Controller。[生产启动](../../apps/agent/src/startup.ts)、[CLI](../../apps/tui/src/main.ts)、[Agent 行为入口](../../apps/agent/src/agent.ts)、[package 入口](../../apps/agent/src/index.ts)

现有 Tool 集合固定，权限模式和只读调度基于已知本地 Tool 的行为。外部 Skill 加载与动态 MCP Tool 不能自动获得这些本地 Tool 的可信分类。[Tool 定义](../../apps/agent/src/tool/definitions.ts)、[技术基线](../../docs/technical-baseline.md)

## 事实：主流命令解决哪些问题

以下是具有代表性的类别，不是完整清单；某些参考命令受版本、账户或运行形态限制。

| 类别 | pi | Claude Code | Codex CLI | OpenCode |
| --- | --- | --- | --- | --- |
| 发现与状态 | `/hotkeys`、`/session` | `/help`、`/status` | `/status`、`/mcp` | `/help`、`/details` |
| 会话 | `/new`、`/resume`、`/name` | `/new`、`/resume`、`/rename` | `/new`、`/resume`、`/rename` | `/new`、`/sessions` |
| 上下文 | `/compact` | `/context`、`/compact` | `/compact` | `/compact` |
| 模型与偏好 | `/model`、`/thinking`、`/settings` | `/model`、`/config` | `/model`、`/theme` | `/models`、`/themes` |
| 扩展能力 | `/skill:name`、`/reload` | `/skills`、`/mcp`、`/skill-name` | `/skills`、`$skill`、`/mcp` | 自定义 `/name` 命令、`skill` Tool |
| 结果与分支 | `/copy`、`/export`、`/fork`、`/tree` | `/diff`、`/rewind` | `/copy`、`/diff`、`/fork` | `/export`、`/undo`、`/redo` |

命令依据：[pi 当前命令源码](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/slash-commands.ts)、[Claude Code 命令](https://code.claude.com/docs/en/commands)、[Codex CLI 命令](https://learn.chatgpt.com/docs/developer-commands?surface=cli)、[OpenCode TUI 命令](https://opencode.ai/docs/tui/)。OpenCode 自定义命令是可配置的提示模板，另见其[命令文档](https://opencode.ai/docs/commands/)；不能据此认为所有 slash 命令都会执行本地固定逻辑。

pi 区分内置命令、扩展命令、Prompt Template 与 `/skill:name`。它的 `/tree` 在 Session 树中选点继续，`/fork` 从既有用户消息创建另一 Session；这不证明工作区副作用隔离，更不构成 Anthias 的执行分叉合同。pi 官方同时明确核心不内置 MCP，需要扩展或外部包实现。[pi README](https://github.com/earendil-works/pi/tree/main/packages/coding-agent#commands)

同名命令也不一定同义。Claude Code 的 `/clear` 会开始新对话；Codex 的 `/clear` 同时清空终端视图并开始新对话，而 `Ctrl+L` 仅清视图。Anthias 必须先定义自己的行为，不能只复制名称。[Claude Code 命令](https://code.claude.com/docs/en/commands)、[Codex CLI 的 clear](https://learn.chatgpt.com/docs/developer-commands?surface=cli)

## 建议：首版命令应形成可发现的闭环

| 候选 | 用户得到的结果 | 范围说明 |
| --- | --- | --- |
| `/help` | 查看、筛选命令和参数 | `/` 触发列表，Tab 补全，Esc 返回输入；详情显示是否会调用模型 |
| `/new` | 在同一 Workspace 开始新 Session | 保留旧 Session；完成旧资源关闭再切换；运行中先给出明确限制 |
| `/resume` | 选择并恢复本地 Session | 展示时间和可识别信息；失败保留当前 Session；不让 TUI 读取 JSONL |
| `/context` | 查看当前上下文占用 | 增加 Skill 目录、激活正文、MCP schema 的可解释占用 |
| `/compact` | 主动压缩当前模型上下文 | 调用已有压缩语义，保留完整历史；空闲执行、可取消，不捏造用户消息 |
| `/mode` | 查看或切换现有权限模式 | 保留 `agent / plan / auto_allow`，不新增同义权限体系 |
| `/skills` | 查看可用、禁用、冲突、加载失败的 Skills | 展示来源和诊断；可在此重新扫描，不必增加通用 `/reload` |
| `/skill:name [任务]` | 明确选择并加载某个 Skill | 命名空间避免覆盖内置命令；任务才是本次真实用户输入 |
| `/mcp` | 查看服务器状态、能力与失败原因 | 在同一入口选择连接、重连、禁用；敏感配置不展示原值 |
| `/details` | 进入当前 Tool / Reasoning 详情 | 保留现有能力，具体呈现跟随全屏方案 |
| `/exit` | 取消并关闭本次应用 | 等待 Agent 与其拥有的 MCP 资源释放 |
| `/clear`，可选 | 仅清当前视图 | 必须明确不改 Session 和模型上下文；全屏内若无实际用途可延期 |

解析建议：只把输入首个位置的 `/` 当命令；未知命令或参数错误在本地返回用法，不提交模型。内置控制命令不消耗模型请求；Skill 是上下文材料和工作流程，其后续执行可能调用模型与 Tool。普通文本中的路径和反引号内 `/...` 不按命令解释。还需定义输入以绝对 POSIX 路径开头时的字面发送方式。

运行状态建议：只读查看命令可在运行中使用；会话切换、压缩和会改变可调用工具的操作仅空闲执行。待审批时只有用户对当前审批的真实答复能授权，命令帮助或外部内容不能变成默认同意。不因追赶其他产品而在本轮加入复杂命令队列。

延期：`/model`、`/login`、`/thinking` 等需要新的模型配置合同；`/fork`、`/tree`、`/rewind`、`/undo` 涉及尚未确认的分支或回滚；`/share` 涉及外发；生成型 `/init`、`/review`、Skill 创建和扩展包市场不是当前接入必需。`/copy`、`/export` 可在主要闭环稳定后作为独立小增量。

## 事实：Skills 有共同格式，客户端行为并不完全相同

Agent Skills 定义一个至少含 `SKILL.md` 的目录。文件采用 YAML frontmatter 与 Markdown 正文；核心字段是 `name`、`description`，可选 `license`、`compatibility`、`metadata` 和实验性的 `allowed-tools`。规范对名称、描述长度和父目录一致性有约束，`scripts/`、`references/`、`assets/` 是可选组织惯例。渐进加载分为名称/描述目录、激活后的正文、按需引用文件；正文建议小于 5,000 tokens、500 行，这些是编写建议，不是安全上限。[Agent Skills 格式规范](https://agentskills.io/specification)

发现根目录并非格式规范强制项。官方接入指南介绍项目级、用户级以及 `.agents/skills` 的互操作惯例，支持显式调用和模型自主选择；后者通常由模型根据目录判断并调用文件读取或专门加载 Tool，不要求 Harness 自建关键词路由器。[官方接入指南](https://agentskills.io/client-implementation/adding-skills-support)

| 实现 | 发现与激活的已核验差异 |
| --- | --- |
| pi | 用户级 `.pi/agent/skills`、`.agents/skills`，项目级 `.pi/skills`、祖先 `.agents/skills`，并支持显式路径；项目来源受其信任机制约束；模型按需读取，用户可用 `/skill:name` 强制加载；重名告警并保留先发现项 |
| Claude Code | `.claude/skills`、插件等来源；`/skill-name` 可直接调用；同名时企业、个人、项目具有其产品特定优先级，插件有命名空间；`disable-model-invocation` 等是扩展字段 |
| Codex | 从 cwd 到仓库根的 `.agents/skills`，以及用户、管理、系统范围；`/skills` 或 `$skill` 显式选择；同名条目不合并，可同时出现在选择器；`agents/openai.yaml` 可声明隐式调用策略 |
| OpenCode | 发现 `.opencode`、`.claude`、`.agents` 等来源；在 `skill` Tool 描述中提供目录，再按名称读取；未知 frontmatter 字段忽略，Skill 自身还有 `allow / ask / deny` 控制 |

依据：[pi Skills](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/skills.md)、[Claude Code Skills](https://code.claude.com/docs/en/slash-commands)、[Codex Skills](https://learn.chatgpt.com/docs/build-skills)、[OpenCode Skills](https://opencode.ai/docs/skills/)。因此不能宣称“项目 Skill 覆盖用户 Skill”是所有客户端统一行为，也不能把格式兼容宣传为完整运行语义兼容。

官方接入指南建议压缩时保留激活的 Skill 内容、重复激活时去重；同时建议对来源与解析问题提供诊断，容忍部分外观性格式问题。Codex 对初始目录另外设置上下文预算，当前文档给出最多模型上下文的 2%，未知窗口时 8,000 字符；先缩短描述，仍过大时可省略并告警。这说明元数据本身也需要预算。[Skills 接入中的上下文管理](https://agentskills.io/client-implementation/adding-skills-support#step-5-manage-skill-context-over-time)、[Codex Skills 目录预算](https://learn.chatgpt.com/docs/build-skills)

## 建议：Anthias 的外部 Skill 接入

1. **先接本地目录。** 首版支持 Workspace 的 `.agents/skills`、用户的 `~/.agents/skills` 和用户显式配置的路径。按需兼容 `.claude/skills`、`.pi/agent/skills` 等时，通过额外路径接入；不默认扫描机器上所有 Agent 的私有目录。用户可以把外部 Skill 下载或复制到支持目录，本轮不建设下载器、市场和自动更新。
2. **加载元数据，不注入全文。** 目录保留名称、用途、来源标识；只在显式 `/skill:name` 或模型请求时读取完整正文。引用文件按 Skill 根解析，逐个读取，脚本按需调用，不递归读满目录。为文件大小、目录数量、目录总预算分别设上限；超限返回可理解诊断，不能无声截断成看似完整的指令。
3. **倾向专门的 Skill 加载行为。** 原有 `read_file` 面向 Workspace/外部单文件，直接给任意 Skill 全目录放行会改变文件权限。内部加载行为可按已启用来源定位正文和引用，记录激活来源与内容版本；其是否表现为一个模型 Tool，进入 Spec 时再确定。选择这个 seam 的理由是权限和压缩状态，而非模仿别人的类型结构。
4. **定义冲突规则。** 建议显式路径优先，再项目、用户；同级冲突显示来源并要求选择，不能依赖文件系统遍历顺序。内置命令不能被 Skill 覆盖，同一真实路径去重；名称、内部身份与真实路径分开。此规则是 Anthias 建议，不是 Agent Skills 规范要求。
5. **兼容字段只读识别。** 接受标准核心字段；未知字段不阻断普通说明型 Skill，同时在详情列出不支持的执行扩展。建议兼容 `disable-model-invocation` 的隐藏自动触发语义；`context: fork`、`agent`、hooks、命令插值和其他客户端的 Tool 名不能静默模拟。对需要这些能力的 Skill 标记“不完整兼容”，不宣称可原样完成整个流程。
6. **加载不等于授权。** 项目 Skill、MCP 提示和工具结果都是外部内容。`allowed-tools`、脚本中的“直接执行”、正文中的“用户已同意”不能扩大现有 Tool Policy。读取已选 Skill 的必要材料与执行其脚本要分开；脚本仍经过现有命令 Tool、参数检查和当前权限模式。真实用户选中 Skill 只提供当前任务意图，不是对未来未知副作用的总授权。
7. **来源与路径有实际边界。** 项目来源启用/信任方式需要明确；允许读取已启用 Skill 目录也不等于允许通过 `..`、绝对路径或符号链接读取任意文件。正文、引用和脚本分别做真实路径检查，外部引用继续走原权限规则。不能为兼容 Skills 静默取消外部单文件限制。
8. **压缩必须记住加载状态。** 建议记录激活身份、来源、内容摘要标识、是否仍在有效模型上下文中；同一版本已在上下文时去重。压缩后继续使用的 Skill 需重新保留完整正文或先重新加载，不能只保留“已经读过”然后跳过读取。也不能永久固定每个历史 Skill 导致不可压缩；应有总预算、失活/重新加载策略。恢复 Session 时文件变化或失踪要显式诊断，不能把新文件静默当成历史版本。持久化合同需在 Spec 明确。

## 事实：MCP 的当前版本和接入边界

**当前正式发布的协议版本是 `2026-07-28`。** 官方 `latest` 重定向到此版本，官方维护者发布公告明确它已经发布；TypeScript SDK `main` 对应 v2 稳定线，包拆分为 `@modelcontextprotocol/client`、`@modelcontextprotocol/server` 等。v1 是旧协议维护线，不能再把旧教程中的单一包名和 API 当作当前默认。[正式发布公告](https://blog.modelcontextprotocol.io/posts/2026-07-28/)、[当前规范](https://modelcontextprotocol.io/specification/2026-07-28)、[TypeScript SDK 官方说明](https://github.com/modelcontextprotocol/typescript-sdk)

新版移除了 `initialize` 握手和协议 Session，使用请求元数据携带协议版本与能力，并提供 `server/discover`。Streamable HTTP 不再使用 `Mcp-Session-Id`，也移除了 SSE 断流恢复；旧版仍有不同语义。新版列表响应增加缓存信息，并引入 `subscriptions/listen`。因此连接生命周期、协议 Session 与 Anthias Session 不能混为一谈。[2026-07-28 变更](https://modelcontextprotocol.io/specification/2026-07-28/changelog)

| 能力 | 规范事实 | 对首版范围的影响 |
| --- | --- | --- |
| `stdio` | 客户端启动子进程，通过标准输入输出传输 JSON-RPC；日志走 stderr；新版取消使用通知，关闭先结束 stdin，再有界等待并终止残留进程 | 必须拥有进程、请求和关闭时机，Windows 也要实际验证 |
| Streamable HTTP | 服务独立运行，每个请求 POST，可返回 JSON 或 SSE；新版关闭请求 SSE 即取消，协议无 Session | 本地应用关闭自己的请求/订阅，不关闭远端服务；旧协议取消行为不能照搬 |
| Tools | 模型可选调用的功能，有输入 schema、结果及可选行为提示 | 经 Agent Tool 权限和执行链，不直接交给模型绕开策略 |
| Resources | URI 标识的上下文数据，由应用决定如何提供给模型 | 发现不等于全部读取，内容按用户或模型需要接入 |
| Prompts | 服务端提供的带参数提示模板，设计为用户选择 | 可在 `/mcp` 内选择或以后映射命名空间命令，不自动执行服务端提示 |

依据：[stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)、[Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)、[Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)、[Resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)、[Prompts](https://modelcontextprotocol.io/specification/2026-07-28/server/prompts)。stdio 规范也给出新旧协议探测与回退方式，具体 SDK 是否自动覆盖，需要在实施前验证；本文没有运行连接实验。

授权规范针对 HTTP，授权能力本身是可选的；stdio 应从环境获得凭据。HTTP OAuth 涉及发现、注册、令牌受众、刷新及作用域，新版还进一步收紧发行方绑定，不能简化为保存一条 Bearer Token 就宣称支持完整 OAuth。[授权规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

MCP 的 Tool annotations 必须按来源判断可信性；`readOnlyHint` 一类服务端自述不能替代 Anthias 自己的执行权限或纯只读判断。Tools 的发现结果本来就包含 schema，把 `tools/list` 原样注入每轮请求会产生上下文开销。Claude Code 已有 Tool Search 延迟装入 schema，但其当前实现依赖特定模型/协议块；OpenCode 也明确提示 MCP 数量带来的上下文成本。[Tools 信任要求](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)、[Claude Code Tool Search](https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search)、[OpenCode MCP](https://opencode.ai/docs/mcp-servers/)

## 建议：MCP 首版做完整的基础接入，限制可选层

- **传输与范围：** 建议 stdio 和 Streamable HTTP 都纳入基础接入。按声明能力支持 Tools 列表/调用、Resources 列表/按需读取、Prompts 列表/用户选择；可以线性分步实现，但报告要准确说明支持哪种能力。首版不做 MCP Apps、Tasks、服务器要求的模型 Sampling 或交互式 Elicitation，也不宣称“兼容所有 MCP”。
- **协议与 SDK：** 以官方 TypeScript v2 client 评估新版；明确是否还支持 `2025-11-25` 服务器，单列兼容测试。依赖版本进入 Plan 前核对 manifest/API。现有 AI SDK Model Adapter 负责模型请求，MCP client 负责服务协议，两者不互相取代；SDK 类型留在 Agent 内部。
- **认证取舍：** 建议首版支持无认证及用户通过环境提供的静态凭据，OAuth 浏览器登录、刷新和凭据存储延期。遇到需要 OAuth 的服务显示“当前不支持该认证方式”，不能循环重试，也不收集明文凭据到 Session。若开发者最需要的服务只接受 OAuth，再扩大该范围。
- **配置和启用：** 支持用户级配置与显式项目来源。配置包含稳定 server ID、transport、启动参数或 URL、环境变量引用、是否启用；新增项目配置不会自动执行命令或连接外网。安全状态可在 `/mcp` 说明，不在模型目录或错误中泄露真实凭据。
- **调用与权限：** 使用稳定的 server/tool 身份映射，避免重名和标准化后的碰撞。初始对未知 MCP Tool 采用保守审批；Plan 模式不能只凭 `readOnlyHint` 开放，外部 Tool 也不能直接进入现有四 worker 纯只读并发。AutoAllow 的外部授权证据规则保持不变；远端服务返回的“允许”不是用户审批。
- **发现不等于模型装载：** 第一层把服务器目录和 schema 缓存在进程内，处理分页、数量/字节上限和失效；第二层只把已启用且预算允许的工具定义发给模型。可先用用户选择 server/tool 子集和明确超限诊断形成闭环，再增加模型可用的搜索/激活工具。不要照搬依赖特定 Provider 的 `tool_reference`，也不要把所有 Tool 包成一个没有真实 schema 校验的万能调用器。
- **schema 与内容：** 新版 JSON Schema 能力比通用模型工具参数支持范围更宽。需验证 SDK 与当前 OpenAI-compatible Adapter 能表示的 schema；不支持时给出单工具诊断，不能静默删字段。Tool 结果的文本、结构化内容、Resource 链接和错误需保留语义；首版不支持的二进制呈现要明示，长输出复用有界产物策略。
- **生命周期和失败：** Agent 持有 MCP client、子进程、请求、订阅与超时；TUI 展示连接中、可用、失败、禁用等状态。停止当前任务应取消在途 MCP 请求；退出/切 Session 关闭归属资源。服务器崩溃只隔离该服务器，核心本地能力仍可用。断连后的未知副作用结果不能盲目自动重放；重连与业务调用重试是两件事。

## 当前待决定点

1. 是否接受首版命令候选，以及 `/clear` 是否有必要、其含义是否只限视图。
2. Skills 首版是否限定本地已安装目录；项目来源的启用方式、目录优先级和同名冲突规则如何确定。
3. 是否采用专门的 Skill 加载行为，并允许对已启用目录进行有界读取；这会改变当前外部单文件读取合同，需要明确确认。
4. Skill 激活状态的持久化、压缩后保留/重载和文件变更语义；哪些非标准字段需要真正兼容。
5. MCP 是否同批交付两种传输和三类基本能力，OAuth 是否延期；最先需要兼容哪一至两个具体服务类型。
6. MCP 首版是否采用显式启用子集加预算限制，后续再加模型搜索/激活层；Plan 与 AutoAllow 如何对待未知外部 Tool。
7. `2026-07-28` 与旧服务器的兼容范围，以实际 SDK 行为和确定性协议夹具决定，不根据旧教程推定。

## 证据与验证边界

本文主要外部链接均在 2026-09-05 通过网页读取工具打开，MCP 正式发布与 SDK v2 稳定状态另有官方发布公告和仓库 README 交叉证据。文中引用的本地源码与文档均已只读查看；没有拉取或改动 pi/Codex 仓库。

完成文档后检查 Markdown 空白、固定速览字段、本地引用存在性与 Git diff 空白错误；这是文档验证，不证明 Skill 执行、MCP 互操作、OAuth、模型自动选择准确率或性能。未运行 `pnpm` 测试，没有业务代码变更、Git 提交或推送。
