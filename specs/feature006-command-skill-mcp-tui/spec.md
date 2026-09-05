# Feature 006：命令、外部能力与全屏 TUI

状态：已实现，待开发者验收

## 开发者速览

> **一句话**：在全屏终端里发现和使用常用命令、外部 Skill 与 MCP，并保持流式正文稳定可读。<br>
> **核心做法**：复用独立 TUI 与官方 MCP 客户端，外部内容进入既有上下文和权限执行链。<br>
> **边界**：保持两个 package；外部 Skill 只读取，MCP 使用显式连接与静态凭据引用。<br>
> **风险 / 未验证**：真实终端主观体验和外部服务互操作仍需区分本地验证证据。<br>
> **当前 / 请审阅**：开发者授权的三个 Plan 已全部完成；实现、验证和剩余验收边界见 [Report](report.md)。

- 日期：2026-09-05；代码基线：`main / 4855892`。
- 前置：[命令、Skills、MCP 研究](research-commands-skills-mcp.md)、[TUI 研究](research-tui.md)。
- 本轮授权覆盖 Spec、三个 Plan、统一 Tasks、实现、必要本地验证和 Report，连续完成三个增量；不在阶段间重复等待。Git 提交、推送、PR 和真实 Provider/MCP 服务验证不在本轮授权中。
- 已有 Feature 005 验收文档修改属于当前讨论结果，保护并保留；Feature 004 的历史视觉验收不改写为已通过。

## 1. 用户结果

1. 启动后进入全屏终端，Workspace、输入与状态区域稳定；正文独立滚动，向上阅读时不被新回复拖走。
2. 输入 `/` 发现命令、选择并补全；未知命令和参数错误在本地解释，不发送模型。
3. 在同一 Agent 中新建或恢复 Session、手动压缩；失败保留当前会话，运行中明确拒绝不兼容操作。
4. 从本地用户/项目目录发现外部 Skill，显式或由模型按需加载；加载后能继续使用引用资料且保持权限约束。
5. 查看并手动连接 MCP Server，使用 Tools、按需读取 Resources、选用 Prompts，查看错误并取消和安全退出。

## 2. 命令合同

| 命令 | 行为 |
| --- | --- |
| `/help` | 命令列表、参数和快捷键；`/` 菜单同源 |
| `/new` | 新建同 Workspace Session，保留旧会话 |
| `/resume [id]` | 列出并选择 Session，或按 ID 打开；失败不丢当前会话 |
| `/context` | 当前窗口与调用用量，显示外部上下文和工具定义的占用 |
| `/compact` | 空闲时主动压缩，保存完整历史，无额外普通回复，可取消 |
| `/mode [agent|plan|auto_allow]` | 沿用当前权限语义 |
| `/skills [reload|clear]` | 列出来源、错误和激活状态，重新发现或清除当前激活内容 |
| `/skill:name [任务]` | 按名称或稳定 ID 激活 Skill；有任务时再发送原始用户任务 |
| `/mcp [操作]` | 列出状态；支持 connect、disconnect、inspect、read、prompt，完整参数见帮助 |
| `/details [prev|next]` | 打开/关闭或浏览当前详情；全屏直接滚动 |
| `/exit` | 停止并等待 Agent 和终端资源关闭 |

普通文本中间的 `/` 不解析；以 `//` 开头的输入去掉一个 `/` 后作为字面 prompt。菜单与多行输入不把粘贴中的换行当成多次提交。查看命令可在运行中使用；会话、压缩、连接及 Skill 集合变更需空闲。模型在当前 Run 内通过受管 Skill Tool 激活内容是例外，由 Agent 的当前 lease 保存事实。

## 3. 全屏和流式内容

全屏使用 alternate screen，退出恢复 Shell。正文、输入、完整 Workspace 和状态分区；详情宽屏使用固定区域，窄屏可覆盖。Markdown 覆盖标题、强调、行内代码、列表、引用、链接、表格和代码块；未闭合代码持续显示，不缓存到整块完成。外部文本不能注入终端控制序列，文件链接继续校验 Workspace，Shiki 高亮延迟和失败不得卡住输入或模型事件。

保留按事件顺序更新的呈现状态，按可见变化合并绘制。读历史时保持阅读位置；回到末尾恢复跟随。复制、中文输入、宽字符、resize、粘贴、Ctrl+C 和 EOF 均有明确处理；审批依据完整呈现，无法安全显示时阻断确认。非 TTY 保留无控制序列的纯文本路径。

2026-09-05 的验收反馈补充：正文和详情显示可见滑块，支持滚轮、点击轨道和拖动。内容未变化的滚动不重新解析和格式化全部历史。每个任务的思考、Tool 与中间消息归入执行过程；运行中当前步骤可读，结束后默认折叠，最终回答和失败/停止结果保留在外部。用户可点击执行过程及单个步骤标题展开、收起，键盘详情入口继续可用。折叠只影响显示，不删除消息或改写 Session；恢复会话使用已有持久消息，Reasoning 仍只保留当前 TUI 收到的内容。

鼠标命中基于当前可见位置，滚动、resize 与窄屏覆盖后仍准确；正文拖选、链接和输入框不触发折叠。审批属于待决操作，不能被普通步骤收起或绕过完整阅读。

## 4. Skill

默认发现 Workspace 的 `.agents/skills` 和用户的 `.agents/skills`，可用 `ANTHIAS_SKILL_DIRS` 添加按平台路径分隔符分隔的本地目录。只读扫描，不下载或生成 Skill，不运行安装脚本。每个根目录发现直接子目录的 `SKILL.md`，也支持显式根自身包含该文件；不遍历任意祖先和整盘目录。

YAML frontmatter 按 Agent Skills 的 name/description 核心格式校验，未知扩展字段不赋予行为或权限。稳定 ID 包含来源；重名保留并诊断，模糊名称拒绝，用户可按 ID 选择。单目录最多 128 项；元数据和正文有字节限制，正文最多 64 KiB，引用资料单次最多 32 KiB。引用路径必须解析在已启用 Skill 的真实目录内，不能借链接逃逸。

模型默认只看到有界目录，通过 `load_skill` 和 `read_skill` 按需加载。激活正文与引用内容作为有来源的上下文事实保存，不能被解释成真实用户授权；当前会话外部内容总量最多 128 KiB。重复加载同一版本不重复注入。新会话清空激活；恢复使用原记录并诊断文件失踪/改变，不能静默换成另一版本；清除或显式重载才改变激活事实。压缩只缩减历史投影，仍需提供的活跃指令继续纳入每次预算。

## 5. MCP

使用官方客户端，支持 stdio、Streamable HTTP 和协议协商范围内的新旧服务；具体版本证据在 Report 准确记录。配置读取用户 `~/.anthias/mcp.json` 与项目 `.anthias/mcp.json`，也可由 `ANTHIAS_MCP_CONFIG` 显式指定文件；显示来源，同 ID 的歧义不能静默覆盖。配置不等于授权启动：连接默认关闭，只有用户显式 `/mcp connect <id>` 启用。

配置包含 ID、transport、command/args 或 URL、环境变量或 header 的变量名引用。凭据只在目标进程或 HTTP 请求中解析，不能进入 Session、菜单或原始错误输出。首版不实现浏览器 OAuth、自动安装、Sampling、Elicitation、MCP Apps、长期任务或服务市场。

连接后发现 Tools、Resources、Prompts；列表处理分页、数量和字节上限。Tools 以稳定 server/tool 身份映射，schema 与当前连接版本绑定，进入已有 Tool 执行链。Plan 不凭 readOnlyHint 开放未知外部 Tool；需要副作用授权的调用继续走人工或 AutoAllow，未知执行结果不自动重试。模型只获得已连接、预算容纳的工具定义；超限显式诊断。

Resources 由用户显式选择或模型受管工具按需读取；Prompts 由用户显式选择。其返回内容是外部上下文，不能伪造成用户原文。大内容有截断和产物语义，二进制等不支持的内容明确说明。Agent 持有客户端、进程、请求和取消；连接失败隔离到单个服务器，退出关闭自己拥有的资源，不关闭远端服务。

## 6. 代码组织与内部集成合同

保持 `apps/agent`、`apps/tui` 两个 package，沿用已讨论的目录。Agent 新增 `skill/`、`mcp/`，Tool 保留执行权，Context 统一预算，Session 保存事实。TUI 拆为 command、terminal、view、content 与 theme。必要的短 helper 留在调用处，不机械拆文件，不增加类层级、插件框架或 Manager。

Agent 保持 state/prompt/abort/close/subscribe 及现有权限行为。新增实际消费者所需的语义行为：`sessions.list/create/open`、`compact()`、`skills.list/reload/activate`、`mcp.list/connect/disconnect/inspect/readResource/getPrompt`。这些是普通函数对象，不能暴露 SDK、ModelStream、Session 文件句柄或内部循环。`skills.activate(null)` 清除当前激活；MCP 读取/模板选择只增加外部上下文，不自动产生普通模型回复。

统一操作结果为 `{ ok: true, value } | { ok: false, error }`；公开摘要仅包含安全可展示的字段。`AgentState.operation` 为 `compacting | switching_session | updating_capabilities | null`，区别于模型/Tool Run；事件增加 operation_changed、session_changed、skills_changed、mcp_changed。Agent 自己检查占用状态，TUI 的禁用提示不是权限权威。

`agent.ts` 负责稳定对外对象和当前 Session 切换；绑定单个 Session 的既有 Run 实现可保存在内部 `session-agent.ts`，隔离其上下文和产物所有权。目标 Session 准备失败时保留当前实例，成功后发布一次变更并释放旧资源。

## 7. 验收

- 全屏实际差量更新，未闭合代码可见、无同帧重复擦除；阅读锚点、菜单、输入与退出恢复通过确定性终端验证。
- 命令不会作为普通 prompt 泄漏；新建/恢复/压缩满足占用、失败保护和资源收口。
- Skill 目录小、正文和引用按需、重名可诊断，越界读取被拒绝；恢复、压缩和权限来源符合上述合同。
- 两种 MCP 传输经过本地实际协议夹具；工具经过 schema/权限链，资源和模板按需；取消、断线和退出无残留进程。
- 静态检查、构建及相关行为测试通过。各执行 Agent 运行并报告自己的验证，根 Agent 补集成缺口，避免重跑同版本可信结果。
- Report 明确区分确定性测试、本地协议/终端运行与尚未完成的真实服务、主观 Windows Terminal 验收。
