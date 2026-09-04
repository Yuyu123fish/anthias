# Feature 003：Tool 执行调度与 Windows 安全边界实施方案

状态：已计划

## 开发者速览

> **一句话**：以 Windows 沙箱闸门开路，再交付 Policy、只读并发和 TUI 闭环。<br>
> **核心做法**：固定候选版本，使用纯 Policy、四 worker 队列和 Agent 统一关闭。<br>
> **边界**：仅 Windows 命令；不执行危险命令，不自动安装，不增加 Unix、网络策略或插件。<br>
> **风险 / 未验证**：候选为 Windows alpha；核心 conformance 失败即停在 Stage 01。<br>
> **当前 / 请审阅**：Plan 与 Tasks 已确认；本轮连续实施，Stage 01 外部授权门保持独立。

- 文档类型：Plan
- 对应 Spec：[spec.md](spec.md)
- 调研依据：[research.md](research.md)
- Plan 结构：一个文档、四个线性 Stage
- 授权状态：全部 Stage 的代码实施已授权；依赖下载、UAC / 系统修改、真实 Provider、外网、后续提交、推送和 PR 仍未授权

## 1. 当前基线与交付范围

### 1.1 当前代码事实

- 编写本 Plan 时仓库位于 `main`，Feature 003 及文档流程存在未提交修改；这些修改属于开发者，本 Plan 不整理、不重置也不提交它们。
- 根工程使用 Node.js `>=24 <25`、pnpm `10.33.0`、Strict TypeScript 与 ESM；`apps/agent` 当前只有 AI SDK、OpenAI-compatible Adapter 和 `diff` 三项运行时依赖。
- Agent Loop 已把一条 AssistantMessage 中的 ToolCall 按源顺序逐个 `await`；ToolResult 在单次执行结束后立即追加到内存和 Session，因此当前不存在并发结果重排层。
- `FIXED_TOOL_DEFINITIONS` 每次都向模型提供六个 Tool；AgentState、系统 Prompt 和 TUI 尚不知道 Permission Mode 或命令沙箱状态。
- ToolRunner 当前只区分“无需确认”与“需要确认”，`execute_command` 在批准后直接 `spawn` 固定 Session Shell。它能移除模型 API Key、限制 cwd、处理超时和尽力结束进程树，但不能限制宿主文件、网络或系统权限。
- 文件 Tool 只接受工作区相对路径，并已具备真实路径检查、活动 Session 目录保护、预览指纹和同目录原子写入；Feature 003 需要在这条调用链上增加受控的外部单文件目标，不能另建第二套写入实现。
- Session 只在一个已接受 Run 中持有 lease 和串行追加队列，空闲时没有需要统一关闭的 Session 句柄；新增长期资源只有 Windows Command Sandbox。
- 生产入口当前只支持 `--session <UUID>`。TUI 退出时会停止并等待当前 Prompt，但 Agent Interface 还没有幂等异步 `close()`。

### 1.2 本 Plan 交付什么

本 Plan 只实现 [Spec](spec.md) 已定义的一个闭环：Agent / Plan 两种模式、统一 `allow | ask | deny`、危险命令硬拒绝、结构化外部单文件写入、只读 Tool 有界并发、Windows 命令 OS 沙箱、TUI 呈现，以及取消和关闭时的资源收口。

以下边界不因实现方便而改变：

- 只有整批纯 `read_file` / `glob` / `grep` 才并行；出现副作用、未知或无法识别的 Tool 时整批串行。
- 文件写入与命令在 Agent 模式中仍逐次确认；Plan 模式不提供也不执行副作用 Tool。
- 硬危险命令不可确认，测试只把命令文本当数据，不把任何危险 fixture 交给 Shell 或系统 API。
- 命令只有在 Windows sandbox ready 时才能执行；无沙箱、非 Windows、初始化失败和清理不可信都没有宿主回退。
- Schema 1、线性 Session、unknown 恢复语义、六个基础 Tool 名称和单 activeRun 保持兼容。
- 不增加 Unix backend、动态 Registry、AI approval、永久授权、PTY、后台任务、网络策略 UI 或第二个 Agent 生命周期。

## 2. 四阶段交付顺序

| Stage | 独立结果 | 完成前不能带入 |
| --- | --- | --- |
| Stage 01：Windows 沙箱可行性闸门 | 用无害临时资源证明固定候选能满足 Windows 文件、工具链、进程树与 fail-closed 合同，给出 go / no-go | 生产依赖、ToolRunner 改造、危险命令试运行、自动 UAC |
| Stage 02：权限与安全决策 | 交付 Permission Mode、Tool 可见性、纯 Policy、硬拒绝和外部单文件 approval；同时切断现有宿主命令路径 | 只读并发、真实 Windows backend、TUI 完整集成 |
| Stage 03：只读有界并发 | 并发上限 4，执行事件按事实发布，ToolResult / JSONL / 模型上下文按源顺序稳定收口 | 副作用并发、并发 Session 写入、Windows backend |
| Stage 04：Windows backend 与整体闭环 | 接入通过闸门的沙箱、补齐 Agent close、CLI / TUI、真实 Windows conformance 和最终回归 | 网络能力承诺、Unix backend、真实 Provider、范围外能力 |

四个 Stage 线性推进，前一 Stage 未通过时不得提前进入下一 Stage。开发者已明确授权本轮在门禁通过后连续完成全部 Stage，因此中间门禁不再等待新的代码实施授权；Stage 01 的依赖下载和 Windows 系统准备仍需独立授权，普通实施授权不包含这类权限。

## 3. 固定技术方案

### 3.1 模块职责与依赖方向

继续保持 `apps/agent` 与 `apps/tui` 两个 package，不增加 Host 或 Sandbox package：

```text
apps/tui
  └─ 只使用 @anthias/agent 的 state、event、prompt、approval、mode、abort、close

apps/agent
  ├─ Run / Agent Interface        模式快照、单 activeRun、approval、关闭与公开投影
  ├─ Agent Loop / Batch Scheduler 模型循环、批次分类、有界执行和有序结果提交
  ├─ Tool Policy                  allow | ask | deny、规则原因和执行边界
  ├─ Fixed Tool Runner            Schema、路径预检、预览、执行与有界结果
  ├─ Windows Command Sandbox      唯一平台模块；装配、执行、进程树与 reset
  ├─ Session                      现有 Schema 1、Run lease、串行 JSONL 与恢复
  └─ Model Stream / Adapter       现有 Provider 隔离与 ToolCall 组装
```

- Agent 仍是 Permission Mode、Tool 能力、Policy、沙箱状态和生命周期的唯一权威；TUI 只选择、展示和响应。
- Batch Scheduler 只协调执行与提交顺序，不解析路径或命令；Tool Policy 只给决策和理由，不执行 Tool；Windows 模块只执行已经通过 Policy 与 approval 的准备结果。
- ToolRunner 的内部计划从“可选 approval”收敛为显式的预检结果、Policy Decision 与可执行闭包，但不导出到 package 入口。
- 不建立通用 `SandboxBackend`、Registry、Manager 或空 Unix 实现。Windows 模块使用窄的内部对象即可，测试 fake 也只实现该对象形状。
- Session 不接收 Permission Mode 或 sandbox-runtime 类型，不增加持久记录。并行任务完成后仍由 Run Module 使用现有 lease 串行追加。
- `@anthropic-ai/sandbox-runtime` 只允许存在于 Agent package 的生产装配边界；其类型、配置和异常不得泄漏到 Agent Interface、TUI 或 Session。

### 3.2 Agent Interface、模式与 Tool 可见性

公开面只增加交互 Adapter 真正需要的少量事实：

- `PermissionMode = "agent" | "plan"`。
- AgentState 增加 `permissionMode` 与 `commandSandboxStatus`；后者固定为 `ready | unavailable | cleanup_uncertain | closed`，不暴露 ACL、账号、代理端口或候选库内部状态。
- Agent 增加 `setPermissionMode(mode)`，同步返回 `accepted`，或以 `busy | closed` 拒绝。非 Windows 上仍可选择 Agent 模式，只是命令能力 unavailable，因此不需要额外的 unsupported 状态。
- Agent 增加幂等 `close(): Promise<void>`。第一次关闭会 abort 并等待 activeRun 收口，再 reset Windows sandbox；重复调用等待同一个 Promise。关闭后 prompt 以 `closed` 拒绝，模式切换也以 `closed` 拒绝。
- AgentEvent 增加 `permission_mode_changed` 与 `command_sandbox_status_changed`。事件只携带公开字面量状态，TUI 不从平台或错误文案推断能力。
- ToolApprovalRequest 在现有标识、Tool 名、目标和预览之外，增加 `permissionMode`、`riskSummary` 与 `executionBoundary`。绑定指纹仍是 Agent 内部事实，不暴露可复用授权 token。

生产入口新增 `--mode agent|plan`，可与 `--session <UUID>` 组合；未提供时默认 Agent。无效值继续安全退出。`createAgentFromEnvironment` 接收同名模式选项；测试用 `createAgentWithModelStream` 可以接收内部 ToolRunner / sandbox fake，但这些 seam 不从 package 入口导出。

Run 接受 UserMessage 时固定 Permission Mode 与命令能力快照。后续每次模型请求都从该快照选择 Tool 定义并生成一致的系统 Prompt：

| 快照 | 模型可见 Tool | 执行入口二次校验 |
| --- | --- | --- |
| Plan | `read_file`、`glob`、`grep` | 伪造副作用调用得到 denied，不产生 approval |
| Agent + sandbox ready | 六个基础 Tool | 读取 allow，文件副作用与一般命令 ask，硬危险命令 deny |
| Agent + command unavailable | 五个文件 Tool | `execute_command` 不可见；伪造调用得到 failed，不触发宿主执行 |

模式只在 Agent 空闲时改变，改变后刷新 state 并发布一次事件；不写入 Message、JSONL 或旧 Session。`FIXED_TOOL_DEFINITIONS` 改为按这三个固定集合选择的普通函数，不引入动态 Registry。

### 3.3 Policy Decision 与危险命令分类

Agent 内部使用一个不可变的 `PolicyDecision`：`decision: allow | ask | deny`、稳定 `ruleId`、可安全展示的 `riskSummary` 和实际 `executionBoundary`。决策顺序固定为：

1. Tool 名、Schema、平台能力和输入上限预检；失败形成 failed ToolResult。
2. Permission Mode 校验；Plan 中的副作用调用形成 deny。
3. 路径或命令安全分类；硬规则形成 deny，不能进入 approval。
4. Agent 模式下读取形成 allow，结构化文件副作用和非硬拒绝命令形成 ask。
5. approve 只授权当前准备结果；执行前仍重验目标、模式快照与 sandbox 状态。

命令分类器是纯函数，只接收字符串与固定 Shell 描述，不启动解释器。实现使用一个保守扫描器而不是完整 PowerShell AST 或新解析依赖：

- 保存原始命令用于 approval，同时生成大小写、换行和空白规范化视图；不对引号内文本做会改变语义的盲目替换。
- 在引号与转义边界外识别命令段、管道、重定向、`;`、换行、`&&` 和 `||`，再按 executable basename 判断危险类别。
- 对字面量形式的 `pwsh/powershell -Command`、`cmd /c`、`bash/sh -c` 递归检查，最大深度为 3；超深、无法还原的包装、EncodedCommand、动态求值或混淆输入直接使用 `danger.opaque_command` 拒绝。
- 用户给出的八条规则同时应用于原始文本、规范化文本和已还原包装内容，保持它们是最低集合而非完整安全证明。
- Windows 补充类别至少覆盖磁盘格式化或原始设备写入、系统或卷根递归破坏、引导配置破坏，以及通过提权、服务、计划任务、WSL、Docker / 容器或 VM 把执行委托到沙箱外。
- 远程内容直接管道或传给 `iex`、PowerShell、cmd、bash / sh 的等价形式使用同一 hard deny；普通下载但不执行仍进入 ask 并受 OS sandbox 限制。

稳定 ruleId 至少包括 `danger.root_recursive_delete`、`danger.disk_format`、`danger.raw_device_write`、`danger.root_permission_open`、`danger.fork_bomb`、`danger.remote_script_execute`、`danger.windows_system_destructive`、`danger.sandbox_escape` 和 `danger.opaque_command`。ruleId 只用于内部测试和安全文案映射，不成为用户可编辑 DSL。

所有危险规则验证只调用纯分类器，并用 fake / spy 证明 approval、sandbox 和宿主 spawn 均未发生。测试 fixture 不参与字符串拼接执行，也不进入任何 Shell 参数。

### 3.4 工作区与外部单文件路径

现有 workspace resolver 继续是唯一文件路径入口，并增加只供 `edit_file` / `write_file` 使用的 side-effect 解析分支：

- 相对路径仍按 workspace 解析；绝对路径规范化后若位于 workspace 内，仍作为普通 workspace 目标处理。
- 真正的外部目标只接受本地盘符下一个确定的文件路径。UNC、设备命名空间、ADS、文件系统根、目录、Glob、空 basename 和无法找到真实已有父目录的输入直接失败或拒绝。
- 保护范围至少包含活动 Session 目录、`SystemRoot`、`Program Files`、`Program Files (x86)`、`ProgramData`、卷根、`System Volume Information` 和回收站系统目录；比较使用真实路径与 Windows 大小写语义。
- 已有文件解析目标真实路径、父目录真实路径、类型与内容 SHA-256；新文件解析最近已有父目录并记录“不存在”。任何 Reparse Point、父目录、类型、内容或存在性变化都使批准成为 stale target。
- approval 指纹绑定 runId、toolCallId、完整输入、规范化目标、父目录身份、预览指纹、模式快照和执行边界；不保存目录级许可。
- 执行仍复用现有精确编辑和同目录临时文件 + sync + rename。外部目标不会另建“简化写入”路径，也不会自动创建父目录。
- `read_file`、`glob`、`grep` 仍只读 workspace；`execute_command.cwd` 仍只能是 workspace 内目录，命令 approval 不产生外部路径白名单。

保护路径和路径归类由纯函数形成规则原因；实际文件身份与指纹检查保持异步。这样可以单独覆盖 Windows 路径语义，同时让最终副作用仍由文件 Tool 的一个实现完成。

### 3.5 Tool Batch Scheduler

固定 `READ_ONLY_TOOL_CONCURRENCY_LIMIT = 4`，不从 CLI、环境或模型输入开放。批次先只按 Tool 名选择路径：全部属于三个只读 Tool 时进入并发队列，其他任何名称进入现有源顺序串行路径。无效只读输入在并发任务内失败，不会把整批改成串行；未知 Tool 名本身会让整批串行。

并发路径分成“执行事实”和“有序提交”两个阶段：

1. AssistantMessage 先完成并刷新到 Session，再建立与 ToolCall 数量相同的结果槽位。
2. 最多四个 worker 从递增索引队列取任务，不为整批一次性创建无上限的执行 Promise、文件句柄或搜索进程。
3. 每个任务完成无副作用预检后进入一个轻量的 source-order start gate：更靠后的调用可以先准备完成，但只有所有更早索引已经发布 start 或确定为不执行后，才发布自己的 `tool_execution_start`。
4. start 发布后任务立即执行；`tool_execution_end` 按真实完成顺序发布，并把 ToolResult 放入原索引槽位。单个 failed 不取消同批其他读取。
5. 全部任务完成、失败或取消后，Run Module 从索引 0 开始串行追加 ToolResultMessage，并按相同顺序发布对应 message 事件；下一次模型请求只读取这组有序完成消息。

串行路径保持 just-in-time：当前调用轮到后才创建预览、Policy Decision 和 approval，ToolResult 刷新后才开始下一个调用。同一时刻最多一个 approval，文件写入和命令不会因调度器重构而重叠。

abort 后队列停止领取新任务。已运行任务共享 Run 根 AbortSignal；已经完成的结果不改写，正在运行与尚未开始的调用分别收口为真实终态或 aborted。start gate 必须被取消唤醒，不能让 Run 因等待前序索引而悬挂。所有结果槽位形成后才允许 run_end，Session JSONL 始终由现有 lease 串行写入。

`tool_execution_update` 当前只会由串行命令产生，但事件合同仍要求携带 toolCallId。TUI 必须按 toolCallId / Tool 名标注，不保留“最近启动 Tool 就是输出归属”的隐式假设。

### 3.6 Windows Command Sandbox 候选与生产装配

#### 固定候选与采用门槛

Stage 01 唯一候选固定为 `@anthropic-ai/sandbox-runtime@0.0.75`。选择原因与限制以 [research.md](research.md) 为依据：它提供 Windows 专用受限账号、WFP egress fence、Session 级 ACE 和进程包装能力，但仍是 research preview / Windows alpha，并需要一次人工提升权限的系统准备。

该版本先在系统临时目录做隔离 spike，不先写入 Anthias manifest 或 lockfile。只有全部 Stage 01 核心项通过，Stage 04 才把完全相同的精确版本加入 `apps/agent`；版本变化必须重新做 conformance，不能用范围版本静默升级。

系统准备必须在执行前另行展示并取得授权，至少说明会创建或使用 `srt-sandbox` 本地账号 / 组、写入机器级 WFP 规则，以及官方卸载动作能清理什么。Anthias 自身永不调用安装、卸载或 UAC；开发者不授权时 Stage 01 记为 BLOCKED，而不是改回宿主执行。

#### Sandbox 配置

生产配置只由 Agent 根据已规范化的运行事实生成，不读取项目内 sandbox 配置：

- 文件读取采用 deny-then-allow：拒绝宿主用户目录和活动 Session 目录，再只为 workspace、固定 Shell、当前 Node / pnpm 与已验证的机器级运行时根恢复必要读取；不把整个用户目录作为工具链兼容方案。
- 文件写入只允许 workspace 和 Agent 为该 sandbox 创建的私有临时目录，并对位于 workspace 内的活动 Session 目录施加更具体的 denyWrite。候选不支持 per-exec allowWrite，因此所有命令继续串行，approval 也不扩大 Session 级 ACL。
- 网络配置使用候选支持的最宽 `allowedDomains: ["*"]` 与空 deny 列表，只为避免把网络 allowlist 作为 Feature 003 产品能力；网络仍经过候选代理 / WFP，具体协议与可达性不进入验收，也不对用户承诺。若固定版本不能明确接受该配置，必须回到 Spec，而不是自行改成网络 denylist。
- 不启用 weaker nested sandbox、excluded command、unsandboxed fallback 或运行时 ask callback；项目文件和模型输出不能修改 sandbox 配置。
- 每次命令使用原 toolCallId 作为候选库的 `commandId`，原始命令作为 `commandText`，避免并行或重复文本的 violation 归属错位。

子进程环境从空白 allowlist 组装，只复制 `SystemRoot`、`WINDIR`、`ComSpec`、受验证的 `PATH`、`PATHEXT`、`TEMP`、`TMP`、`OS`、`PROCESSOR_ARCHITECTURE` 和 `NUMBER_OF_PROCESSORS`，再接受候选为受限身份注入的必要变量。宿主 `USERPROFILE`、`APPDATA`、代理凭据、`ANTHIAS_*`、Provider Token、`NODE_OPTIONS` 和其他任意环境变量都不继承；若 Node / pnpm 依赖宿主用户私有目录才能运行，Stage 01 失败，不以扩大整个用户目录读取作为修复。

#### 命令执行与资源所有权

`createAgentFromEnvironment` 在 Session 打开后尝试初始化 Windows sandbox。非 Windows、未准备、版本不兼容或自检失败不会阻止对话和文件 Tool 创建 Agent，但将 commandSandboxStatus 置为 unavailable，并从模型定义中移除 `execute_command`。

Windows 模块只接受已经准备并批准的固定 Session Shell、规范化 cwd、完整命令、timeout 和 toolCallId。它集中处理候选包装所需的 Windows 参数转义，保证实际 Shell 语义、cwd 和命令字节与 approval 一致；raw command 不能被单独传给宿主 `spawn`。候选返回的包装命令是唯一可启动入口，任何包装或启动异常都直接失败。

Stage 01 与 Stage 04 必须用含空格、引号、换行、美元符号和非 ASCII 文本的无害命令验证包装等价性。若只能通过改变固定 Shell 语义、把原始命令写到不受保护位置或启用宿主 fallback 才能运行，则候选不合格。

一个生产 Agent 持有一个 sandbox 生命周期；命令仍一次一个。命令成功、非零退出、timeout 与 abort 都先等待完整进程树终结和命令级资源释放，再形成 ToolResult。候选或进程检查无法确认清理时：

1. 当前结果标记 `cleanupUncertain`；
2. AgentState 进入 `cleanup_uncertain` 并发布状态事件；
3. 当前进程内所有后续命令失败，文件和对话仍可用；
4. `close()` 仍尝试唯一一次共享 reset，TUI 等待该尝试并以非成功退出状态报告未确认清理。

`close()` 先设置内部 closing 标记，拒绝新 prompt / 模式切换，再 abort 并等待 activeRun；只有 Run 的 Session lease 已释放后才 reset sandbox 和清理私有临时目录。清理成功后状态为 closed，失败则保持 cleanup_uncertain。Session 本身不新增常驻 close 方法，因为现有资源只属于 Run lease。

## 4. Stage 01：Windows 沙箱可行性闸门

### 4.1 目标

在不触碰 Anthias 生产调用链的前提下，验证固定候选是否真的能承载 Spec 的 Windows 安全合同。这个 Stage 的产物是可复核的 go / no-go 结论，不是“先集成再看看”。

### 4.2 前置授权与实施方式

1. 先只读核对当前 Windows 版本、PowerShell 7、Node、pnpm 的真实可执行路径，以及机器上是否已经存在候选所需账号、组和 WFP 状态。
2. 向开发者展示精确版本、下载来源、一次性系统变化、保留或卸载方案；分别取得依赖下载与管理员系统准备授权。
3. 在新建的系统临时目录中安装和运行 `0.0.75` spike，不在 Anthias manifest、lockfile、源码或开发者其他项目写临时脚本和日志。
4. 只使用临时 workspace、临时 Session 目录、临时外部 sentinel、伪凭据和无害短命进程。测试结束后清理本次临时资源；候选的机器级安装是否保留由开发者决定，不自动卸载。

### 4.3 Conformance 项

| 编号 | 必须证明的事实 | 通过证据 |
| --- | --- | --- |
| W01 | 初始化与配置自检 | 已准备环境进入 ready；缺失或损坏前置条件返回失败且没有命令启动 |
| W02 | workspace 写边界 | 受限命令可在临时 workspace 创建和修改文件，不能写临时外部 sentinel |
| W03 | Session 与读取边界 | workspace 位于被广泛 deny 的父目录时仍可读取项目，但更具体的临时 Session 目录不可读、不可写 |
| W04 | 工具链 | 固定 PowerShell 7、Node 与 pnpm 的离线版本命令可运行；不依赖宿主用户私有配置或凭据 |
| W05 | Shell 等价性 | 空格、单双引号、换行、美元符号和中文等无害输入与批准文本一致，不发生二次解释偏移 |
| W06 | 子进程与 timeout | 无害 Node 子进程处于同一约束内，timeout 后完整结束且无残留进程 |
| W07 | abort 与 reset | 主动取消可以结束进程树；reset 幂等并收回本次 Session 级资源，随后可重新初始化 |
| W08 | 环境隔离 | 子进程看不到测试注入的 `ANTHIAS_MODEL_API_KEY`、伪 Provider Token 与任意未列入 allowlist 的变量 |
| W09 | 写规则粒度 | Session 级 allowWrite 不能被单次命令扩大；更具体 denyWrite 在 workspace allow 内仍生效 |
| W10 | 网络配置可装配 | `allowedDomains: ["*"]` 配置可初始化；不发送真实网络请求，也不把可达性写成通过结论 |

W01–W09 都是核心项，不允许由执行 Agent 自行 WAIVE。所有拒绝测试只针对专门创建的临时 sentinel 和目录，不把 Windows 系统目录、真实用户文件或其他项目作为攻击目标。

### 4.4 Stage 01 完成门

- W01–W09 全部 PASS，W10 至少证明配置可装配；没有遗留测试进程、临时 ACL、代理监听器或临时文件。
- 记录候选精确版本、Windows / PowerShell / Node / pnpm 环境、实际命令、结果、系统准备保留状态和证据边界。
- 没有执行任何危险命令 fixture，没有访问真实 Provider、外网、真实凭据或开发者业务文件。
- 任一核心项 FAIL、候选需要宽读整个用户目录、无法保护 workspace 内 Session、无法确认进程树结束，或只能使用 unsandboxed fallback 时，Feature 立即 no-go：不创建 Tasks 的后续实施假象、不添加生产依赖，回到 Spec / Plan 重新选择范围。
- Stage 01 形成明确 go 后才进入 Stage 02；本轮已有连续实施授权，无需再次等待代码实施确认。

## 5. Stage 02：Permission Mode、Policy 与路径安全

### 5.1 目标

先把每个 ToolCall 的能力、决策、确认与目标绑定做成一个可测试闭环，并在真实 backend 接入前移除现有宿主命令执行可能。Stage 结束时，文件能力完整，命令只能通过 fake 验证策略，生产状态明确 unavailable。

### 5.2 实施内容

1. 在最先落地的安全改动中切断 `executePreparedCommand` 的生产直连路径；Agent 没有 ready sandbox 时不得调用现有 host `spawn`，后续 Stage 也不保留可恢复的 fallback 分支。
2. 增加 PermissionMode、commandSandboxStatus、模式快照、`setPermissionMode()`、模式事件和按模式 / 能力选择 Tool definitions 的普通函数；系统 Prompt 与 Tool definitions 来自同一快照。
3. 给 `createAgentFromEnvironment` 和 CLI 参数解析增加 `--mode agent|plan`，但 TUI 的完整交互呈现留到 Stage 04；默认 Agent 与 `--session` 行为保持兼容。
4. 将 ToolRunner 计划改为显式预检 + Policy Decision + prepared execution；输入失败、deny、ask、执行不可用使用不同路径和安全文案。
5. 实现纯危险命令分类器与固定 ruleId；先于 approval 和 sandbox 调用运行。补充 Windows 系统破坏、远程脚本执行、混淆与逃逸委托类别。
6. 扩展文件路径 resolver 和现有文件 Tool，支持 Agent 模式下外部单文件 ask；加入保护路径、真实父目录、目标身份、指纹和执行前重验。
7. 扩展 ToolApprovalRequest 与内部 approval 指纹，使模式、风险和执行边界变化都会拒绝陈旧批准；deny 不产生 pending request。
8. 给 `createAgentWithModelStream` 增加仅源码测试可见的 ToolRunner / command sandbox fake seam，替换现有依赖真实宿主命令的测试，不把 seam 从 package 入口导出。

### 5.3 定向验证

- 默认 Agent、显式 Plan、空闲切换、Run 中 busy、关闭后拒绝，以及每次模型请求 Tool 定义与模式快照一致。
- Plan 模式伪造三个副作用 Tool，均得到 deny；command unavailable 得到 failed；两类都无 approval、无文件执行、无 sandbox / spawn 调用。
- 八条最低危险规则及其大小写、空白、绝对 executable、参数组合和三类字面量 wrapper 变体全部 hard deny；混淆和逃逸类别也不进入 approval。
- Agent 模式普通命令得到 ask，fake sandbox 只有准确批准后被调用一次；陈旧、重复和错误 requestId 不执行。
- 临时外部普通文件拒绝时不变化、批准时只改变一个目标；UNC、设备路径、根目录、保护目录、目录、Glob 和 Reparse Point 逃逸均不可批准。
- 工作区内既有读写、stale target、Session 保护、Schema 1 重开和未知副作用恢复无回归。

### 5.4 Stage 02 完成门

- `pnpm check` 和 Permission / Policy / file Tool / Agent 定向测试通过；测试均使用临时目录与 fake command sandbox。
- 搜索生产调用链确认不存在从 ToolRunner 到无沙箱 `spawn` 的可达路径；package 入口没有导出规则、runner 或候选类型。
- 不添加 sandbox-runtime 依赖，不调用真实 Windows backend，不执行危险命令或真实外部命令。
- 汇报公开面变化、决策顺序、路径保护、测试命令与结果、未验证项和 Git 状态后停止，等待 Stage 03 审查。

## 6. Stage 03：只读 Tool 有界并发与确定提交

### 6.1 目标

把并发限制在只读 Tool 的执行窗口内，并证明“运行可以乱序、历史不能乱序”。不改变副作用、approval、Session lease 或单 activeRun 语义。

### 6.2 实施内容

1. 在 Agent Loop 中先对整条 AssistantMessage 的 Tool 名做批次分类；选择 parallel_read_only 或 source_order_serial 后，本批次不再动态切换。
2. 将当前“执行并立即 append ToolResult”拆为“形成独立结果”和“按源顺序提交结果”两个内部步骤；串行路径仍逐个完成这两个步骤。
3. 实现固定四 worker 的递增索引队列与 source-order start gate；不使用无上限 `Promise.all(toolCalls.map(...))`。
4. 并行任务使用同一个 Run 根 AbortSignal，但各自持有独立结果收集器；ToolRunner、事件和错误映射始终携带原 toolCallId。
5. 批次完成后由 Run Module 按索引串行追加 ToolResult 与 JSONL，再进入下一次模型请求；Session Module 不感知并发。
6. abort 时关闭领任务入口、唤醒 start gate、取消运行项并为队列项补 aborted；资源全部收口后才发布唯一 run_end。
7. TUI fake 测试先验证乱序 end 仍有正确归属；真实模式展示放到 Stage 04。

### 6.3 定向验证

通过公开 Agent Interface 构造确定性 Model Stream 和受控 ToolRunner：

- 至少六个只读 ToolCall 在并发上限 4 下运行，最大重叠数正好为 4，并按逆序完成。
- `tool_execution_start` 仍按源顺序，`tool_execution_end` 可以逆序；ToolResult message、JSONL 和第二次模型请求全部严格按源顺序。
- 一个调用 failed 时其余读取继续；所有结果都存在且顺序稳定。
- 混合只读、write、command、未知 Tool 的批次最大重叠数为 1，预览和 approval 都按轮到时才产生。
- 并发准备中、执行中和仍在队列时分别 abort，不再开始新任务，不悬挂 gate，run_end 晚于全部任务与资源释放。
- 超过单响应 ToolCall 保险丝的现有行为不变，不能为创建并发队列绕过 32 调用上限。

### 6.4 Stage 03 完成门

- `pnpm check`、调度定向测试、现有 Tool Loop / Session / abort 回归通过；不重复运行 Stage 02 中未受影响的纯分类 fixture。
- 代码审查能从公开 prompt 调用追踪到 batch classification、worker queue、result slots、Session append 和下一次 model request，证明不是只测内部调度器。
- 没有并发 JSONL 追加、并发 approval、并发文件写入或并发命令；没有新增公开 Run 状态或 Session Schema 字段。
- 汇报并发峰值、事件顺序、持久顺序、取消证据、测试结果和 Git 状态后停止，等待 Stage 04 审查。

## 7. Stage 04：Windows backend、TUI 与最终闭环

### 7.1 目标

把 Stage 01 已证明的候选接入生产 Agent，完成真实 Windows 命令执行、模式交互和统一关闭，再按 Spec 验收矩阵做一次完整本地收口。

### 7.2 实施内容

1. 仅在 Stage 01 go 后，将 `@anthropic-ai/sandbox-runtime@0.0.75` 精确加入 `apps/agent` 并更新 lockfile；先检查许可证、发布内容、Node 24 / ESM 入口和安装脚本，禁止范围版本。
2. 实现唯一 `windows-command-sandbox` 内部模块，生成固定配置、初始化、自检、包装命令、归属 violation、结束进程树、reset 和安全错误；删除不再使用的 host command executor。
3. 在生产 Agent 异步创建中装配 backend；失败时仍返回可对话 / 文件操作的 Agent，但 commandSandboxStatus 为 unavailable，且模型看不到命令 Tool。
4. 把命令 Policy、一次性 approval、ToolExecutionStartedRecord、sandbox execute、ToolResult 和 cleanup uncertain 串成唯一因果链；批准内容与实际 Shell / cwd / command / timeout / sandbox 快照逐项一致。
5. 实现 Agent 的幂等 `close()` 和 closing 状态，补齐 prompt、approval、abort、Run lease、sandbox reset 与临时目录清理的终态竞争。
6. TUI 启动时展示 Permission Mode 与 command sandbox 状态；增加 `/mode agent`、`/mode plan` 和 `/mode` 查看命令。活动 Run 中切换显示 busy，不排队。
7. TUI 按 Tool 名与短 toolCallId 标注并发 start / end / update，分别呈现 ask、deny、sandbox unavailable、普通 failed、aborted 和 cleanup uncertain。
8. `/exit`、EOF 与空闲 Ctrl+C 都调用并等待 `agent.close()`；activeRun Ctrl+C 先 abort，同一退出路径继续等待 close。清理不可信时返回非零退出状态。
9. 使用真实已准备 Windows sandbox 重跑 W01–W10 中与生产 Adapter 相关的项目，并完成 Spec A–L；随后创建唯一 `report.md`，只写已经成立的能力和证据边界。

### 7.3 Stage 04 完成门

- 精确依赖与 lockfile 一致，`pnpm install --frozen-lockfile --offline` 在依赖已经获准下载后通过。
- 真实 Windows conformance 通过：workspace 写入可用、外部 sentinel 与 Session 受保护、Node / pnpm 可用、伪凭据不可见、进程树可回收、reset 无遗留。
- 非 Windows fake、缺失安装、初始化异常、Shell 不可读和 cleanup uncertain 全部 fail-closed，且文件 / 对话能力仍可用。
- TUI 的 mode、approval、并发归属与退出测试通过；`pnpm verify` 最终通过，没有保留后台进程或测试目录。
- Report 记录实际环境、命令、结果、系统准备状态、未验证网络 / Provider 边界与 Git 状态。Spec 和 Plan 只有在实现与全部约定验证完成后才改为“已实现”。
- 完成汇报后停止，等待开发者验收；不自动提交、推送或创建 PR。

## 8. 兼容、恢复与失败表现

- Schema 1 和现有 JSONL 记录形状不变，旧 Session 无迁移即可打开；Permission Mode 与 sandbox 状态只存在于当前 Agent 运行时。
- 默认 Agent 模式保持 Feature 002 的交互预期，但命令能力从“逐次批准后宿主执行”升级为“sandbox ready 才可见和执行”。未安装 sandbox 时命令消失属于有意的 fail-closed，不回退兼容旧风险。
- `--session` 继续有效，`--mode` 只是正交新增参数。未指定模式时新建与重开都默认 Agent；重开不会从历史推导模式或批准。
- 并发只改变只读执行时间，不改变 AssistantMessage、ToolResultMessage、JSONL 或下一次模型请求的顺序；旧恢复逻辑仍把未完成副作用标为 unknown / interrupted，不重放。
- 外部单文件写入不形成持久权限，Agent 重启后没有可恢复许可；崩溃前已批准但未完成的副作用仍遵守现有 unknown 语义。
- sandbox 初始化失败后，当前 Agent 可以继续对话和使用允许的文件 Tool；修复机器前置条件后必须重新创建 Agent，不在活动实例中循环重试或半热更新 ACL。
- cleanup uncertain 后不恢复命令能力。即使后续看起来没有进程，也要关闭当前 Agent、完成人工检查并创建新实例，不能由计时器自动改回 ready。
- 候选机器级准备不由仓库回滚。Stage 01 和 Stage 04 汇报必须说明安装是否保留；只有开发者明确要求时才调用候选的官方卸载动作。

## 9. 验证矩阵与命令

### 9.1 Spec 验收映射

| Spec 验收组 | 主要 Stage | 证据层级 |
| --- | --- | --- |
| A Permission Mode | Stage 02、04 | 公开 Agent Interface + CLI / TUI |
| B–D 并发、串行、取消 | Stage 03、04 | 受控 executor + 真实 Session JSONL |
| E 硬危险命令 | Stage 02 | 纯 classifier + executor 未调用 spy |
| F HITL 与确认绑定 | Stage 02、04 | 公开 Agent Interface + fake / real sandbox 边界 |
| G 外部文件路径 | Stage 02 | 临时本地文件、Reparse Point 与 stale target |
| H Windows sandbox | Stage 01、04 | 隔离 spike + 生产 Adapter conformance |
| I fail-closed / 平台 | Stage 02、04 | 平台 fake、初始化故障注入和生产启动 |
| J 进程树与关闭 | Stage 01、04 | 无害子进程、timeout / abort / close / reset |
| K Session 与恢复 | Stage 03、04 | JSONL 原文、Schema 1 重开与 interrupted 恢复 |
| L TUI 与职责 | Stage 04 | TUI fake、CLI 子进程与 package 公开面 |

### 9.2 仓库验证命令

测试文件名允许按现有目录约定做小幅调整，但验证层级和断言不得降低：

```powershell
# Stage 02：权限、Policy、路径和 Agent 行为
pnpm exec vitest run apps/agent/test/permission-mode.test.ts apps/agent/test/tool-policy.test.ts apps/agent/test/file-tool-loop.test.ts apps/agent/test/agent.test.ts apps/agent/test/startup.test.ts
pnpm check

# Stage 03：公开闭环中的并发、顺序、取消和 Session
pnpm exec vitest run apps/agent/test/tool-scheduling.test.ts apps/agent/test/tool-loop.test.ts apps/agent/test/agent-loop-safety.test.ts apps/agent/test/session.test.ts apps/tui/test/tui.test.ts
pnpm check

# Stage 04：真实 backend seam、TUI、生产启动与完整回归
pnpm exec vitest run apps/agent/test/windows-command-sandbox.test.ts apps/agent/test/command-tool-loop.test.ts apps/agent/test/startup.test.ts apps/tui/test/main.test.ts apps/tui/test/tui.test.ts
pnpm install --frozen-lockfile --offline
pnpm verify
```

Stage 01 的隔离 spike 不把临时入口保存在仓库。实际使用的精确命令必须在取得下载 / 系统准备授权前展示，并在 Stage 报告中原样记录；不得通过临时脚本绕开 UAC 审查或危险命令禁令。

同一代码版本、环境和命令已有可信 PASS 时，后续 Stage 不机械重复定向测试，只补本 Stage 改动的证据；最终 `pnpm verify` 在 Stage 04 统一运行。所有命令和文件副作用测试使用临时 workspace，不在 Anthias 自身工作区通过 Agent Tool 修改或执行验证。

## 10. 主要风险与停止条件

### 10.1 主要风险

- **候选成熟度**：固定版本仍为 Windows alpha，API、系统准备与清理语义可能不足以作为稳定边界；版本锁定只能防漂移，不能替代 conformance。
- **Windows ACL 组合**：Session 默认位于 workspace 内，必须证明更具体 deny 在 workspace allow 中持续生效；路径规范化、继承 ACL 或 Reparse Point 都可能破坏直觉。
- **工具链位置**：PowerShell、Node 或 pnpm 若只对宿主用户可读，受限账号可能无法运行。为兼容工具链而开放整个用户目录会直接越过安全目标。
- **命令传输**：候选返回包装字符串，而 Anthias 保存固定 Shell 语义；Windows quoting 或二次解析错误可能让实际命令偏离批准文本。
- **分类器证明边界**：保守扫描器不能证明任意 PowerShell 意图，必须以 false positive 和 opaque deny 换取硬规则覆盖；一般命令仍依赖 HITL 与 OS sandbox。
- **并发终态**：start gate、abort 和结果槽位若各自持有终态，容易产生悬挂、重复 end 或 run_end 过早；终态仍必须由 Run Module 统一归约。
- **候选全局状态**：sandbox-runtime 可能使用进程级单例；当前 TUI 单 Agent 可以满足，但测试必须串行隔离，不能把未来多 Agent 需求提前塞入本 Feature。
- **网络副作用**：即使配置为最宽域名规则，WFP / 代理仍可能改变某些协议；Feature 003 既不验证可达性，也不能把“看起来被阻止”宣传成网络安全保证。
- **最小环境**：不继承用户配置可以保护凭据，也可能使部分构建工具不可用；本 Feature 只以固定 Shell、Node、pnpm 和项目本地依赖为完成门。

### 10.2 必须停止并回到讨论的情况

- Stage 01 任一核心 conformance 项失败，或需要 unsandboxed fallback、宽读整个用户目录、per-command Session ACL 扩权才可通过。
- 精确候选版本不可获得、许可证或发布内容不可接受、Node 24 / ESM 不兼容，或只能升级到未经重新验证的版本。
- 候选无法用 `allowedDomains: ["*"]` 装配，导致必须在本 Feature 新增网络 allowlist / denylist 产品决定。
- 无法保证实际 Shell、cwd、命令、timeout 与 approval 一致，或 raw command 存在绕过候选直接进入宿主 executor 的路径。
- 硬危险类别只能通过执行命令、调用 Shell 解析或降低规则范围来测试；任何危险 fixture 被提议试运行时立即停止。
- 外部文件写入无法收敛为一个真实目标，或保护路径、Reparse Point 与 stale target 无法在副作用前重新验证。
- 并发实现需要并行 Session append、多个 pending approval、并发副作用或新的公开 Run 生命周期。
- 需要改变 Schema 1、unknown / interrupted 恢复、默认 Agent 模式、整批串行规则或 fail-closed 语义。
- 需要自动 UAC、创建系统账号、修改机器级规则、调用外网、真实 Provider、付费 API 或真实凭据，而尚未取得对应独立授权。
- 实施与开发者现有修改发生无法安全拆分的重叠，或需要删除、重置、覆盖不属于本 Feature 的内容。

低风险的文件拆分、私有函数命名和测试文件归属可以在不改变上述合同的前提下调整，并在 Stage 汇报中说明；不能借“实现细节”改变公开行为、安全边界或完成门。

## 11. 汇报与授权边界

每个 Stage 的汇报必须先给结论，再给证据：

1. 当前 Stage 交付了哪些用户可观察行为，哪些仍不可用；
2. 公开入口到 Policy、ToolRunner、scheduler、Session 或 Windows sandbox 的真实调用链；
3. approval、危险拒绝、并发顺序、abort、进程树与 close 的关键边界；
4. 实际运行的命令、结果、环境和临时 / 系统资源清理状态；
5. FAIL、BLOCKED、未验证项和不能据此声称的能力；
6. 当前 Git 状态、变更范围，以及是否需要开发者决定下一 Stage。

Stage 01 必须额外报告候选系统准备是否保留；Stage 03 必须报告最大实测并发数和 JSONL 顺序；Stage 04 必须报告真实 Windows conformance 与网络未验证边界。执行 Agent 已在相同代码和环境完成的验证不由接手 Agent 重复运行，除非代码变化或证据缺口要求补测。

当前 Plan 与 Tasks 已确认，并已获准在本轮连续实施全部 Stage。Stage 01 的外部下载与 Windows 系统准备、真实 Provider、外网、后续提交、推送和 PR 仍分别取得明确授权；未获得这些授权时不以替代实现绕过门禁。
