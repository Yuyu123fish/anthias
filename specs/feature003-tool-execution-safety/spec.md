# Feature 003：Tool 执行调度与 Windows 安全边界

状态：已定义

## 开发者速览

> **一句话**：让只读 Tool 安全并发，并把命令与工作区外副作用限制在可强制边界内。<br>
> **核心做法**：纯只读批次有界并行，其余串行；每个调用统一经过 `allow | ask | deny`。<br>
> **边界**：Plan 只读，Agent 副作用逐次确认；危险命令不可批准，命令仅在 Windows sandbox ready 时执行。<br>
> **风险 / 未验证**：Windows sandbox 尚未实证；网络与 Unix 不在范围，宿主回退禁止。<br>
> **当前 / 请审阅**：Spec、Plan 与 Tasks 已确认；本轮已授权连续实施，机器级操作仍单独审批。

- 文档类型：Spec
- Feature 目录：feature003-tool-execution-safety
- 关联基线：[产品定义](../../docs/product-definition.md)、[技术基线](../../docs/technical-baseline.md)、[Feature 002](../feature002-tool-loop-and-session/spec.md)
- 调研依据：[Pi OS sandbox 调研](research.md)

## 1. 问题

Feature 002 已经建立六个基础 Tool、逐次人工确认、线性 Session 和完整的 Model → Tool → Model 循环，但同一 AssistantMessage 中的所有 ToolCall 仍按源顺序串行执行。多个互不依赖的读取与搜索会累加等待时间；直接把全部 ToolCall 改成并行，又会让文件修改、命令、副作用预览和确认产生竞态。

现有安全边界也只覆盖内置文件 Tool 的工作区路径校验与所有副作用 Tool 的人工确认。确认能够让用户知情，却不能约束已经启动的命令：当前 `execute_command` 仍继承 Anthias 宿主用户权限，可以访问工作区外文件、活动 Session 目录、网络和其他系统资源。项目还没有统一的权限模式，也无法在“自动允许、交给人判断、无条件拒绝”之间表达不同安全结果。

Anthias 需要在不牺牲可理解性和确定性的前提下：

- 并行执行确认无副作用的读取 Tool，保留副作用 Tool 的串行语义；
- 引入 Agent 与 Plan 两种权限模式；
- 对每个 ToolCall 形成 `allow | ask | deny` 决策，并把硬危险操作挡在人工确认之前；
- 对 Windows 上的命令及其子进程施加 OS 级资源边界；
- 当系统无法证明或执行所需安全边界时 fail-closed，不静默退回宿主权限执行。

本 Feature 只承诺 Windows 命令沙箱。Pi 的示例没有原生 Windows sandbox，且初始化失败会退回宿主执行；当前 Windows sandbox-runtime 仍是 alpha，因此调研只提供风险与候选机制，不代表 Anthias 已选定依赖或已经获得安装、提权授权。

## 2. 方案

Agent 继续作为 Tool 行为与生命周期的唯一权威，在现有 ToolRunner 内部增加两项协作能力：

1. Tool 调度先把一条 AssistantMessage 中的 ToolCall 视为一个有序批次。只有整个批次都由 `read_file`、`glob`、`grep` 组成时才允许有上限地并行；只要包含副作用 Tool、未知 Tool 或需要人工判断的调用，整个批次按源顺序串行。
2. 每个 ToolCall 在执行前经过权限模式、能力可用性、输入与路径预检、安全策略和人工确认。策略结果只有 `allow`、`ask`、`deny`；硬危险命令始终 `deny`，不能由人工确认改写。

安全边界分为三层，不能互相替代：

1. **权限模式**决定当前 Run 可以向模型提供哪些 Tool，并在执行入口再次校验。
2. **Policy / HITL**判断具体 ToolCall 是否自动允许、需要一次人工确认或必须拒绝。
3. **执行约束**把已经允许的范围落到实际执行：内置文件 Tool 使用规范化路径与目标指纹；`execute_command` 使用 Windows 命令沙箱约束 Shell 及其全部后代进程。

Agent 模式表示当前平台可用的全部 Tool 能力可以被模型请求，不表示副作用自动执行。Feature 002 的兼容安全语义继续保留：`edit_file`、`write_file` 和每一次 `execute_command` 仍逐次请求人工确认。Plan 模式只允许工作区内的只读 Tool，不产生副作用确认。

Windows 命令沙箱只包围 `execute_command` 的固定 Session Shell 和后代进程，不包围 Agent、TUI、Model Adapter 或内置文件 Tool。沙箱必须允许工作区内正常构建和验证，同时限制工作区外写入、活动 Session 目录访问、宿主凭据继承和逃逸型进程委托。沙箱不可用、初始化失败或清理状态不可信时，命令不能启动；本 Feature 不提供无沙箱宿主执行的回退。

## 3. 术语与状态

### 3.1 Permission Mode

Permission Mode 是 Agent 当前运行时的能力边界，取值只有：

- **Agent**：在 Windows 命令沙箱可用时向模型提供 Feature 002 的六个 Tool；工作区内只读 Tool 自动执行，文件写入和命令执行仍按次确认。
- **Plan**：只向模型提供 `read_file`、`glob`、`grep`；任何伪造、陈旧或模型自行构造的副作用 ToolCall 都在 Agent 执行入口被拒绝。

为兼容 Feature 002，新建或重新打开 Session 时默认使用 Agent 模式，除非启动方明确选择 Plan。Permission Mode 属于当前 Agent 运行时，不写入线性消息历史，也不从旧 Session 自动恢复。用户只能在 Agent 空闲时切换模式；活动 Run 期间的切换请求必须被拒绝，不改变该 Run 已经看到的 Tool 定义和安全边界。

### 3.2 Tool Batch 与执行方式

Tool Batch 是同一条已完成 AssistantMessage 中按内容顺序出现的全部 ToolCall。每个批次只选择一种执行方式：

- **parallel_read_only**：批次中的 Tool 名全部是 `read_file`、`glob` 或 `grep`，在固定并发上限内执行。
- **source_order_serial**：批次中出现其他任意 Tool 名时，所有调用按源顺序逐个完成，包括前后夹杂的只读 Tool。

并发上限属于 Plan 中可调整的运行参数，不成为公开 API，但必须是大于一的有限值。一个批次不能因队列压力无限创建 Promise、文件句柄或搜索进程。

### 3.3 Policy Decision

对已经通过基本 Schema 与能力预检的 ToolCall，Policy Decision 只有：

- **allow**：无需人工确认，可以在既定执行边界内运行。
- **ask**：必须向人展示准确副作用、风险原因和实际执行边界；一次性批准后仍受路径约束或 Windows 命令沙箱限制。
- **deny**：不得请求批准、不得启动 Tool，直接形成可解释的 denied ToolResult。

输入无法解析、目标不存在、沙箱不可用等能力或预检失败形成 failed ToolResult，不伪装成策略拒绝。安全性暂时无法静态判断，但既定路径或 OS 沙箱仍能约束其最大副作用时使用 `ask`；连最大副作用也无法约束时使用 `deny`。HITL 可以在可描述边界内作出决定，不能越过硬拒绝或缺失的执行约束。

### 3.4 Windows Command Sandbox

Windows Command Sandbox 是 Agent 内部持有的命令执行边界。它负责：

- 在受限 Windows 身份或等价受限 Token 下启动固定 Session Shell；
- 给工作区、必要只读运行时目录和沙箱私有临时目录配置最小文件权限；
- 把 Shell 与全部后代进程纳入可统一终止的进程树；
- 在命令结束、超时、取消和 Agent 关闭时回收临时授权与运行资源；
- 在初始化、执行或清理无法确认时返回安全失败，不调用现有宿主 executor。

本 Feature 不承诺完整网络隔离。除明确硬拒绝的远程脚本管道外，命令是否联网仍属于人工确认需要说明的风险；后续网络 deny/allowlist 需要独立 Feature。

## 4. 用户故事

1. 作为 Anthias 用户，我希望互不依赖的读取和搜索可以并行执行，从而减少大型工作区检查的累计等待时间。
2. 作为 Anthias 用户，我希望并行调用的 ToolResult 仍按模型原始调用顺序进入上下文，从而获得可复现的对话和 Session。
3. 作为 Anthias 用户，我希望包含文件修改、命令或人工确认的批次保持串行，从而避免预览、文件状态和副作用相互竞争。
4. 作为 Anthias 用户，我希望一个并行只读 Tool 失败时其他读取仍能完成，从而让模型获得完整而有界的批次结果。
5. 作为 Anthias 用户，我希望 Agent 模式可以使用当前平台的全部基础 Tool，从而完成检查、修改和验证闭环。
6. 作为 Anthias 用户，我希望 Plan 模式只允许读取、搜索和分析，从而保证当前 Run 不会修改文件或启动命令。
7. 作为 Anthias 用户，我希望清楚看到当前权限模式并且只能在空闲时切换，从而不会让运行中的安全边界悄然变化。
8. 作为 Anthias 用户，我希望灾难性命令在任何模式下都被无条件拒绝，从而不会因模型请求或误批准造成不可恢复的系统破坏。
9. 作为 Anthias 用户，我希望安全性不确定但仍可被强制边界限制的操作交给我判断，从而由人承担最终授权而不是由 AI 猜测。
10. 作为 Anthias 用户，我希望确认请求展示准确命令、Shell、目标、工作目录、风险和沙箱边界，从而知道自己实际批准了什么。
11. 作为 Anthias 用户，我希望陈旧、重复、不匹配或执行边界已变化的批准失效，从而避免批准内容与真实副作用错配。
12. 作为 Anthias 用户，我希望结构化文件 Tool 在请求写入工作区外单个绝对路径时必须逐次确认，从而保留对明确外部文件副作用的控制。
13. 作为 Anthias 用户，我希望命令只能在 Windows OS 沙箱内运行并限制工作区外写入，从而缩小错误命令的影响范围。
14. 作为 Anthias 用户，我希望沙箱缺失或初始化失败时命令直接失败，从而不会在我不知情时退回宿主权限运行。
15. 作为 Anthias 用户，我希望在非 Windows 系统上仍能对话和使用文件 Tool，但不能启动无沙箱命令，从而让平台限制清楚而安全。
16. 作为 Anthias 用户，我希望停止 Run 或退出 TUI 时并行任务、命令子进程树和沙箱资源都被收口，从而不遗留后台进程或临时权限。
17. 作为 Anthias 用户，我希望命令无法读取或破坏活动 Session 目录，也不会继承模型凭据，从而保护 Agent 自身状态和敏感配置。
18. 作为 Anthias 用户，我希望 TUI 能区分自动允许、等待确认、硬拒绝、沙箱失败和普通 Tool 失败，从而准确理解当前状态。
19. 作为 Anthias 用户，我希望进程中断后不会自动重放已开始的副作用，并且并行结果顺序仍可恢复，从而避免重复执行和历史漂移。
20. 作为 Anthias 交互适配器开发者，我希望通过同一个 Agent Interface 观察模式、策略、并发 Tool 和沙箱状态，从而无需在 TUI 或未来 Desktop 中复制安全判断。

## 5. 用户流程

### 5.1 选择权限模式

1. Anthias 创建或打开 Session，并以启动方明确指定的模式或默认 Agent 模式创建 Agent。
2. AgentState 和 TUI 明确显示当前 Permission Mode，以及当前平台的命令沙箱是否可用。
3. 用户可以在没有 activeRun 时切换 Agent / Plan；Agent 更新后续模型请求可见的 Tool 定义。
4. activeRun 存在时切换被拒绝，当前 Run 继续使用开始时固定的模式快照。

### 5.2 并行只读批次

1. 模型形成一条包含多个只读 ToolCall 的 AssistantMessage。
2. Agent 先完成并持久化整条 AssistantMessage，再确认批次只包含只读 Tool 名。
3. Agent 在固定并发上限内启动读取和搜索；每个调用使用同一个 Run 的根 AbortSignal。
4. TUI 可以按实际完成时间看到各调用结束，但每个事件始终带有原 toolCallId。
5. Agent 等待批次收口，把每个 ToolResultMessage 按 AssistantMessage 中的源顺序持久化并传给下一次模型请求。

### 5.3 含副作用的串行批次

1. 模型形成一条同时包含只读 Tool 与副作用 Tool 的 AssistantMessage。
2. Agent 将整个批次选择为 source_order_serial，不提前并行准备会受文件变化影响的预览。
3. 每个调用在轮到自己时完成预检、策略判断、必要确认、执行和 ToolResult 持久化。
4. 当前调用未终结前，下一个调用不得开始预检后的本地执行，也不得产生第二个待确认请求。
5. 全部 ToolResult 就绪后，Agent 才发起下一次模型请求。

### 5.4 Windows 命令执行

1. Agent 在固定 Session Shell 和工作区内规范化 `cwd`，解析命令并执行安全策略。
2. 命中硬危险规则时，Agent 直接生成 denied ToolResult；不发布确认请求，也不调用沙箱或宿主 executor。
3. 其他有效命令在 Agent 模式下一律进入 `ask`，确认内容包含完整命令、Shell、规范化 `cwd`、超时、风险说明和“仅在 Windows 命令沙箱内执行”的边界。
4. 用户拒绝时命令不启动；批准时 Agent 先刷新 ToolExecutionStartedRecord，再通过已经就绪的 Windows Command Sandbox 启动命令。
5. 沙箱不可用、执行约束无法建立或清理状态不可信时返回 failed ToolResult，不尝试宿主执行。

### 5.5 工作区外文件副作用

1. `edit_file` 或 `write_file` 请求一个工作区外的绝对文件路径。
2. Agent 解析真实父目录和最终目标，拒绝设备路径、文件系统根、系统保护目录、活动 Session 目录、目录目标、Glob 和无法收敛到单个文件的输入。
3. 可安全定位的普通文件进入 `ask`，TUI 明确展示规范化绝对路径、创建或覆盖语义、Diff 或有界内容，以及工作区外副作用警告。
4. 批准只允许本次调用操作该单个目标；执行前再次验证父目录、目标身份和预览指纹。任何变化都以 stale target 失败。
5. 自由形式命令不获得工作区外写权限；需要外部副作用的命令在沙箱内失败，不能借一次确认退回宿主执行。

### 5.6 停止与退出

1. 用户停止 Run 时，Agent 取消当前模型请求、全部正在运行的只读 Tool、当前串行 Tool 或等待中的确认。
2. 尚未启动的 ToolCall 不再开始，并按源顺序获得 aborted ToolResult，使当前 AssistantMessage 的 ToolCall 可以完整收口。
3. 已经完成的只读结果不被改写；正在执行的命令必须先结束完整进程树并回收命令级资源。
4. TUI 退出时调用 Agent 的统一关闭行为，等待 activeRun 与 Windows Command Sandbox 关闭后再释放监听器和进程。

## 6. 行为与失败

### 6.1 批次调度

- AssistantMessage 必须在其任何 ToolCall 开始前完成并持久化。
- Agent 先对整个批次做无副作用的轻量分类；副作用预览、目标指纹和命令启动准备只在对应串行调用轮到时完成，避免长时间持有陈旧状态。
- 只有全部 Tool 名都属于只读集合时才使用 parallel_read_only；只读输入错误可以在并行任务内形成 failed ToolResult，不会把批次变成副作用批次。
- 只要出现 `edit_file`、`write_file`、`execute_command`、未知 Tool 或无法识别的 Tool 名，整个批次使用 source_order_serial。
- parallel_read_only 使用显式并发上限和有界队列。调度器不得一次性无上限地打开文件、遍历目录或创建搜索任务。
- source_order_serial 中只有前一个 ToolResult 完成并持久化后，后一个调用才进入可执行阶段。
- 单个 Tool 的 failed 或 denied 结果通常不终止批次；其他调用继续收口，随后由模型决定是否修正。
- Agent 只有在批次全部 ToolCall 都拥有 completed、failed、denied、aborted 或 unknown ToolResult 后，才允许发起下一次模型请求。
- Permission Mode 在 Run 接受提示词时形成快照；同一 Run 的后续模型请求和 Tool 批次始终使用该快照。

### 6.2 事件、结果与持久顺序

- 对实际进入执行阶段的 ToolCall，`tool_execution_start` 按源顺序发布；parallel_read_only 可以在前一个调用结束前发布后续开始事件。预检即失败或被 Policy 拒绝的调用不伪造执行开始。
- `tool_execution_update` 和 `tool_execution_end` 按真实发生时间发布，因此并行批次的结束事件可以乱序；事件必须携带 toolCallId，TUI 不依赖“上一个 Tool”归属输出。
- ToolResultMessage 的 `message_start`、`message_end`、JSONL 追加顺序和下一次模型请求中的顺序必须与原 ToolCall 源顺序一致，不受完成先后影响。
- Session 写入继续由 Agent 串行持有；并行只发生在只读 Tool 的执行阶段，不允许并发追加 JSONL。
- ToolExecutionStartedRecord 继续只表示已经批准并即将发生的副作用。只读并行任务不新增“可能发生副作用”的持久记录。
- TUI 可以先看到某个靠后的只读 Tool 已结束，再看到按源顺序发布的 ToolResultMessage；二者是执行观察与模型事实的不同顺序，不得混成第二套状态。
- Agent 仍只维护一个 activeRun。并行批次期间阶段保持 `executing_tool`，不为每个 Tool 建立公开 Run 生命周期。

### 6.3 权限与策略矩阵

| 调用条件 | Agent 模式 | Plan 模式 | 强制执行边界 |
| --- | --- | --- | --- |
| 工作区内 `read_file`、`glob`、`grep` | allow | allow | 工作区真实路径、Session 保留目录与输出边界 |
| 工作区内 `edit_file`、`write_file` | ask | deny | 真实路径、准确预览、目标指纹、一次性批准 |
| 工作区外单个绝对文件的 `edit_file`、`write_file` | ask | deny | 保护路径拒绝、单目标限制、真实路径和目标指纹 |
| Windows 沙箱可用时的一般 `execute_command` | ask | deny | 工作区内 cwd、Windows Command Sandbox、超时和进程树回收 |
| 命中硬危险规则的命令 | deny | deny | 不请求确认，不进入任何 executor |
| 安全性不确定但最大副作用仍可被强制边界约束 | ask | deny | 人工决定后仍保持既定路径或 OS 边界 |
| 无法描述或强制限制最大副作用 | deny | deny | 提示用户改成可收敛操作或在 Anthias 外手动处理 |

- Agent 模式中的“全部”只表示可请求全部已支持 Tool，不表示 auto-approve。
- Plan 模式从模型 Tool 定义中移除副作用 Tool，同时在 ToolRunner 入口再次拒绝，防止仅靠提示词形成安全边界。
- 未知 Tool、无效 Schema、目标不存在、路径无法规范化或沙箱能力不可用属于 failed ToolResult；它们不进入 approval。
- 非 Windows 平台与 Windows 沙箱未就绪时，`execute_command` 不提供给模型；伪造调用形成安全失败，其他文件 Tool 和对话能力仍可使用。

### 6.4 硬危险命令

硬危险规则是 Policy 层的最低拒绝集合。以下内容只允许作为纯文本匹配合同和测试 fixture，任何验证都不得把它们交给 Shell、命令解释器、任务调度器或系统 API：

```text
rm\s+-(([a-z]*r[a-z]*f|[a-z]*f[a-z]*r)[a-z]*)\s+/\s*$
mkfs\.
dd\s+if=.*of=/dev/
chmod\s+-R\s+777\s+/
:()\{ :|:& \};:
curl\s+.*\|\s*(ba)?sh
wget\s+.*\|\s*(ba)?sh
>\s*/dev/sd
```

这些规则表达的稳定语义分别是：递归删除根目录、格式化磁盘、直接写磁盘设备、递归开放根目录权限、fork bomb、把远程响应直接交给 Shell，以及覆盖磁盘设备。实现不能只对整个原始字符串做一次正则搜索：

- 必须按当前固定 Shell 的语义识别可执行命令段、管道、重定向以及常见的 `powershell -Command`、`pwsh -Command`、`cmd /c`、`bash -c`、`sh -c` 包装。
- 匹配需要遵守平台相应的大小写和空白规则，并覆盖短参数组合、绝对可执行文件路径和被包装后的等价形式。
- 只要同一命令链中任一可执行段命中硬拒绝，整次 `execute_command` 都是 `deny`。
- 能够被解析器明确证明只是普通字符串参数、文档内容或搜索模式的文本不必误判为执行；如果类似硬危险语义且无法可靠区分，按 `deny` 收口。

Windows 首期还必须硬拒绝以下类别：

- 格式化、分区、擦除卷，或通过设备命名空间直接读写物理磁盘；
- 对盘符根、Windows 系统目录或用户配置根执行递归删除、所有权接管或宽泛 ACL 放开；
- 修改启动配置、恢复环境或系统安全边界的破坏性命令；
- 把网络下载结果直接交给 PowerShell、cmd 或其他脚本解释器，以及无法展开检查的编码或混淆命令；
- 通过提权进程、计划任务、系统服务、WSL、容器或虚拟机宿主执行器，把命令委托到 Windows Command Sandbox 之外。

具体规则表、规则 ID 和 Shell 解析方案在 Plan 中确定，但不能缩小上述语义集合。硬拒绝结果必须向用户说明命中的风险类别，不能包含堆栈、宿主秘密或未经边界处理的系统输出。

### 6.5 路径边界

- `read_file`、`glob` 和 `grep` 继续只接受工作区相对路径，不增加工作区外读取能力。
- 所有相对路径仍按 workspace root 解析，并拒绝 `..` 逃逸、指向工作区外的符号链接或 Junction，以及活动 Session 目录。
- Feature 003 只为 `edit_file` 和 `write_file` 增加绝对路径输入：规范化后位于工作区内时按普通工作区目标处理，位于工作区外时进入单文件外部副作用规则。
- 工作区外目标必须是本机文件系统上的单个普通文件。UNC、设备路径、Named Pipe、Alternate Data Stream、文件系统根、目录目标和包含 Glob 的目标一律拒绝。
- Windows 路径比较必须处理盘符、大小写、分隔符、长路径形式、符号链接、Junction 和 Reparse Point，不能只做字符串前缀判断。
- `edit_file` 的外部目标必须已经存在且是受支持的 UTF-8 文本文件；`write_file` 可以在真实存在的普通父目录中创建单个文件，不能顺带创建工作区外目录树。
- Windows 安装目录、启动与恢复目录、程序安装目录、设备命名空间和活动 Session 目录属于保护路径，不能通过 approval 写入。其他保护路径由 Plan 基于 Windows 事实补齐。
- 确认预览形成后，执行前必须重新检查真实父目录、目标类型、链接关系和内容指纹。检查结果变化时返回 stale target，不发生部分写入。
- 外部文件批准只绑定一个规范化绝对目标和一次 ToolCall，不形成目录授权、Session 授权或未来调用授权。
- `execute_command.cwd` 仍必须位于工作区。自由形式命令不能申请工作区外写入扩权；Windows Command Sandbox 对这类写入直接阻止。

### 6.6 Windows Command Sandbox

#### 文件与进程边界

- 每个生产 Agent 至多持有一个 Windows Command Sandbox 生命周期；所有命令保持串行，不在共享 Session 级授权存在时并发执行。
- 沙箱默认允许读取和写入规范化 workspace root，但必须对活动 Session 目录施加更具体的拒绝规则。
- Shell、Node.js、pnpm、项目本地依赖及确有必要的系统运行时目录可以只读开放；具体只读根必须由已验证配置产生，不能把整个用户目录当作方便的默认读权限。
- 沙箱可以持有独立临时目录用于命令自身临时文件；临时目录不能成为访问宿主其他路径的跳板，并在 Agent 关闭时清理。
- 工作区和沙箱私有临时目录之外不提供写权限。Feature 003 不支持通过命令 approval 临时扩大 Session 级 ACL。
- 固定 Session Shell 与它启动的所有后代进程必须继承同一限制，并纳入统一的超时、取消和强制终止边界。
- 计划任务、系统服务、提权、WSL、容器和虚拟机等无法继承当前进程边界的委托通道由 Policy 层硬拒绝。

#### 环境与敏感信息

- 命令进程使用最小环境变量集合，只传递 Shell、基础系统路径、终端编码、工作区与工具链运行所需的非敏感值。
- `ANTHIAS_MODEL_API_KEY`、未来 Model Provider 凭据以及 Anthias 持有的认证 Token 不得进入沙箱进程环境、命令预览、ToolResult、事件或错误。
- 用户把秘密直接写进命令文本不属于 Anthias 能自动修复的情况；TUI 必须提醒命令和 ToolCall 会进入当前 Session 历史，不能把命令参数当作安全秘密输入通道。

#### 初始化、关闭与失败

- Agent 可以在创建时或第一次命令前初始化沙箱，具体时机由 Plan 决定；无论采用哪种方式，命令只有在沙箱完成自检并处于 ready 时才能启动。
- Anthias 不自动触发 UAC、不自动创建本地用户或组、不自动修改机器级 ACL / WFP，也不在首次运行时静默安装 sandbox 依赖。所需的人工安装或系统准备必须另行说明并单独授权。
- 沙箱缺失、版本不兼容、自检失败、Shell 不可读、权限规则无法应用或初始化异常都形成安全失败；现有直接 `spawn` 的宿主命令路径不得作为回退。
- 命令完成后必须等待进程树退出并收回命令级资源。Agent 关闭时必须执行 sandbox reset，收回 Session 级 ACL、代理、监控和临时目录等由所选实现持有的资源。
- 如果进程树或沙箱权限的清理无法确认，ToolResult 必须标记 `cleanupUncertain`，Agent 将命令能力置为不可用，并拒绝当前进程中的后续命令，直到安全关闭并重新创建 Agent。
- 非 Windows 平台不创建占位 Unix backend；`execute_command` 保持不可用，且不得调用 Feature 002 的无沙箱执行路径。

Windows sandbox-runtime 可以作为 Plan 的 spike 候选，但不能因其 API 形状提前成为公开 Interface。Plan 必须先用无害临时目录证明文件边界、Shell/Node/pnpm 可用性、子进程回收和 fail-closed；候选无法满足稳定合同就停止，不通过弱化 Spec 来“适配依赖”。

### 6.7 HITL 与一次性确认

- 人工确认仍只由 TUI 或未来交互 Adapter 响应；模型、系统提示词、Tool 实现和安全策略不能代替人批准。
- ToolApprovalRequest 除 Feature 002 已有的调用标识、Tool 名、目标和预览外，还必须表达 Permission Mode 快照、Policy 风险原因和实际执行边界。
- 命令确认必须显示完整命令、固定 Shell、规范化工作目录、有效超时、沙箱状态、工作区写边界以及网络隔离不在本 Feature 保证内。
- 工作区外文件确认必须显示规范化绝对目标、创建或覆盖语义、Diff 或有界内容，以及“只批准当前单个文件”的范围。
- approval 绑定当前 runId、toolCallId、准确输入、规范化目标、预览指纹、Permission Mode 和执行边界。任何一项变化都使旧响应失效。
- 用户批准只把 `ask` 变成一次可执行许可，不把它升级为 `allow`，也不改变后续同类调用。
- 用户拒绝、取消等待或提供不匹配响应时不得产生副作用；Agent 形成 denied 或 aborted ToolResult 后继续安全收口。
- 同一时刻最多存在一个 pendingToolApproval。Feature 003 不提供“本 Session 始终允许”“允许此前缀”“记住我的选择”或 AI approval。
- `deny` 不发布 approval 请求。TUI 可以解释拒绝原因，但不能提供“仍然执行”入口。

### 6.8 取消、持久化与恢复

- 一个 Run 的根 AbortSignal 同时传播到模型请求、全部并行只读 Tool、当前串行 Tool、approval 等待和 Windows 命令进程树。
- parallel_read_only 被停止后，已经完成的结果保持原终态；正在运行和尚未调度的调用都必须获得 aborted ToolResult，最终仍按源顺序收口。
- source_order_serial 被停止后，当前调用先完成取消与资源回收，后续未启动调用形成 aborted ToolResult，不再准备预览或请求 approval。
- Run 终态只能在全部活动执行和资源回收完成后发布。命令清理不可信时，不能仅因用户请求 abort 就把风险隐藏在普通 aborted 终态中。
- AssistantMessage 仍先于 Tool 执行持久化；每个经批准的副作用仍在本地效果前刷新 ToolExecutionStartedRecord；ToolResultMessage 按源顺序追加。
- 崩溃恢复发现 ToolExecutionStartedRecord 没有对应 ToolResult 时，继续产生 unknown ToolResult 和 interrupted Run，不自动重放命令或文件修改。
- 只读并行任务在崩溃前已经完成但尚未按序持久化的结果可以丢失，因为它们没有副作用；恢复时不虚构完成事实。
- Permission Mode 是当前运行时配置，不写入 Message，也不改变旧 Session 的语义。Feature 003 不要求新增 JSONL 记录类型；现有 Schema 1 Session 必须继续打开。
- 如果实现发现必须迁移 Session Schema、改变 unknown 恢复语义或持久化新的安全事实，必须停止 Plan 并回到 Spec 确认，不能由执行者临场决定。

### 6.9 Agent Interface、TUI 与模块职责

- AgentState 增加当前 Permission Mode 和命令沙箱能力状态；状态由 Agent 持有，TUI 不自行推断平台或安全性。
- Agent Interface 增加空闲时切换 Permission Mode 的行为，返回 accepted 或明确的 busy / unsupported 拒绝；具体交互命令由 Plan 决定。
- Agent Interface 增加异步、幂等的统一关闭行为。关闭会停止 activeRun、解决 approval 等待、释放 Session 资源并 reset Windows Command Sandbox；关闭完成后不再接受 prompt 或模式切换。
- AgentEvent 增加足够的模式变化与沙箱状态变化事实，使 TUI 和未来 Desktop 能从同一事件源更新呈现；不把 Windows API、ACL、Token 或依赖类型暴露到公开事件。
- 现有 Tool 事件继续使用 toolCallId。TUI 渲染并行输出时必须明确归属，不能依赖串行时代的“当前 Tool”隐式状态。
- approval、硬拒绝、沙箱不可用、普通 Tool 失败和用户取消使用不同且可操作的文案；安全错误不暴露堆栈、绝对内部目录或宿主环境变量。
- TUI 只选择模式、提交 prompt、响应 approval、停止和关闭 Agent；它不解析危险命令、不计算路径授权、不初始化沙箱，也不直接执行 Tool。
- 调度、Policy、路径规则和 Windows Command Sandbox 保持 Agent Module 内部实现。package 入口只暴露交互 Adapter 所需的状态与行为，不导出规则表、ToolRunner、Shell parser、sandbox-runtime 或 Windows API 类型。
- 本 Feature 只实现一个 Windows 内部模块，不建立多平台 Sandbox Registry、通用 backend 层级或空的 Unix 实现。

## 7. 已确认决定

1. Feature 003 同时交付 Tool 执行调度、权限模式、Policy / HITL 和 Windows 命令沙箱，仍属于一个完整的 Tool 执行安全闭环。
2. 只有整批只读 Tool 可以有界并行；只要批次含有副作用、未知或无法识别的 Tool，整批按源顺序串行。
3. 文件写入、命令、approval 和任何 Session 级权限变化都不并行。
4. 并行完成顺序可以不同，但 ToolResult、JSONL 和模型上下文始终使用 ToolCall 源顺序。
5. Permission Mode 只有 Agent 与 Plan；默认 Agent，且一个 Run 内模式不可改变。
6. Agent 模式表示全部可用能力，不表示全部自动批准；`edit_file`、`write_file` 和所有命令继续逐次确认。
7. Plan 模式只提供工作区内只读 Tool，副作用调用在执行入口二次拒绝。
8. Policy Decision 只有 `allow | ask | deny`；人工确认不能覆盖硬拒绝或缺失的执行边界。
9. 用户列出的八类灾难性命令是硬拒绝最低集合，并补充 Windows 磁盘、系统根破坏和沙箱逃逸委托类别。
10. 工作区外写入只通过结构化 `edit_file` / `write_file` 支持单个绝对文件和一次性 approval；自由形式命令没有外部写扩权。
11. OS sandbox 首期只覆盖 Windows `execute_command` 及其后代进程；Agent、TUI 和内置文件 Tool 不放入 OS sandbox。
12. Windows Command Sandbox 必须 fail-closed；缺失、初始化失败或清理不可信时不回退宿主执行。
13. 非 Windows 平台仍可对话和使用文件 Tool，但不能执行命令；本 Feature 不预建 Unix backend。
14. Anthias 不自动进行 UAC 安装、创建系统账号或修改机器级规则，相关准备需要独立授权。
15. 本 Feature 不承诺网络隔离；远程响应直接管道执行由硬规则拒绝，其他联网风险继续在命令确认中说明。
16. Windows sandbox 的具体依赖尚未选定；Pi 示例不能复制，sandbox-runtime Windows alpha 只能先作为 Plan spike 候选。
17. Feature 003 不新增基础 Tool，不建立动态 Registry、Manager 或第二套 Agent 生命周期。

## 8. 不在范围内

- Linux、macOS、WSL 内部或统称“Unix”的 OS sandbox 实现；
- 把整个 Agent、TUI、Model Adapter 或内置文件 Tool 放入容器、VM、AppContainer 或独立 Host；
- 网络 deny/allowlist、域名代理、下载源治理和数据外泄防护；
- AI approval、永久授权、Session 级“始终允许”、命令前缀白名单或自动学习策略；
- 通过 `execute_command` 对工作区外路径做临时扩权或无沙箱宿主执行；
- 两个命令、两个文件写入、两个 approval 或其他副作用并行；
- PTY、交互程序、持久 Shell、后台任务和跨 ToolCall 保留进程状态；
- 动态 Tool Registry、插件 Tool、自定义 Policy DSL 或用户可编辑危险规则；
- 自动安装 sandbox 依赖、自动请求管理员权限或静默修改 Windows 系统配置；
- 杀毒、恶意代码检测、完整 PowerShell / cmd / Bash 语义证明和对全部命令意图的正确判断；
- Session 分叉、Compaction、多 Agent、Desktop、跨进程协议和执行分支；
- 真实 Provider、外部网络、付费 API 或包含真实凭据的安全验证。

## 9. 验收标准

### A. Permission Mode

1. 新 Agent 在未显式指定时以 Agent 模式启动，AgentState 与 TUI 能看到该模式。
2. Agent 空闲时可以在 Agent / Plan 间切换；activeRun 期间切换返回明确拒绝，当前 Run 的 Tool 定义不变化。
3. Plan 模式的模型请求只包含 `read_file`、`glob`、`grep`。
4. 确定性 Model Stream 在 Plan 模式伪造 `edit_file`、`write_file` 或 `execute_command` 时，Agent 返回 denied ToolResult，不发布 approval，不调用文件或命令 executor。

### B. 只读并行与确定顺序

1. 确定性 Model Stream 返回至少三个只读 ToolCall，受控测试 executor 让它们重叠运行并按逆序完成。
2. 实际同时运行数大于一且不超过配置上限；调用数量超过上限时，其余调用留在有界队列。
3. `tool_execution_end` 可以按逆序出现，但 ToolResultMessage、JSONL 记录和下一次模型请求中的结果仍严格按源顺序。
4. 测试通过公开 Agent Interface 观察行为，不直接调用调度器来代替闭环证明。

### C. 混合批次保持串行

1. 同一 AssistantMessage 依次包含只读、文件写入、命令和只读 ToolCall 时，任何两个调用都不重叠。
2. 文件预览只在轮到该 ToolCall 时形成；批准并完成当前副作用前不准备或执行后续调用。
3. 同一时刻最多出现一个 pendingToolApproval；拒绝当前调用后，后续调用仍按源顺序继续。

### D. 并行失败与取消

1. 一个只读 Tool 返回 failed 时，其他已运行的读取继续完成，模型收到源顺序排列的全部结果。
2. 并行批次运行中调用 abort，正在运行与排队调用都在有限时间内收口为已完成或 aborted，不再启动新任务。
3. run_end 只在所有活动任务和有界资源释放后出现；完成后可以提交下一条 prompt。

### E. 硬危险命令

1. 6.4 中八条最低规则分别作为 inert string 输入纯 Policy classifier，全部得到 `deny`。
2. 大小写、额外空白、绝对 executable 路径、组合参数和常见 Shell wrapper 的等价危险形式仍被拒绝。
3. Windows 磁盘格式化或原始设备写入、系统根递归破坏以及 WSL / 容器 / 服务 / 计划任务逃逸类别被拒绝。
4. 每个硬拒绝场景都断言没有 approval、没有 Windows sandbox 调用、没有宿主 spawn。
5. 验证不得执行、拼接后执行或以任何方式试运行危险命令；测试只把文本当作数据。

### F. HITL 与确认绑定

1. Agent 模式中的普通文件副作用和非硬拒绝命令都形成 `ask`，并展示准确风险与执行边界。
2. 用户拒绝后没有副作用；用户批准后只执行当前准确 ToolCall。
3. 错误 requestId、重复响应、旧 Run 响应、目标指纹变化、模式或沙箱边界变化都不能触发执行。
4. 安全性不确定但能被既定边界限制的调用可以请求人判断；无法强制限制最大副作用的调用直接 `deny`。

### G. 工作区与外部文件路径

1. 工作区内文件 Tool 继续拒绝 `..`、绝对路径冒充相对路径、符号链接和 Junction 逃逸以及活动 Session 目录；规范化后仍位于工作区的绝对写入目标按普通工作区目标处理。
2. Agent 模式下，指向临时普通目录中单个文件的绝对 `edit_file` / `write_file` 形成外部路径确认；拒绝不写入，批准只修改该目标。
3. 预览后替换目标、父目录、Reparse Point 或文件内容会使批准以 stale target 失败。
4. UNC、设备路径、文件系统根、系统保护目录、目录和 Glob 目标硬拒绝，不能通过批准绕过。
5. 只读 Tool 仍不能读取工作区外路径；`execute_command.cwd` 仍不能离开工作区。

### H. Windows 命令沙箱

1. 在已由用户准备且通过自检的 Windows 环境中，无害命令可以在临时工作区创建文件、读取项目本地依赖并运行 Node / pnpm。
2. 同一命令及其子进程对工作区外临时 sentinel 的写入失败，sentinel 内容保持不变；测试不得以真实系统目录或用户数据作为目标。
3. 命令无法读取或修改活动 Session 目录，且子进程环境不包含 `ANTHIAS_MODEL_API_KEY` 或测试注入的 Anthias 凭据。
4. 实际 Shell、cwd、超时和 sandbox 状态与用户批准的预览一致；非零退出和 sandbox violation 形成有界 failed ToolResult。
5. 该验收只证明本 Spec 的文件、进程与环境边界，不宣称已经实现网络隔离。

### I. Fail-closed 与平台边界

1. sandbox 缺失、初始化异常、自检失败、Shell 不可读和权限规则应用失败时，`execute_command` 不发布可执行 approval 或在批准后返回安全失败，且不调用宿主 executor。
2. 将平台能力替换为非 Windows 后，Agent 仍能对话并执行工作区文件 Tool，但模型看不到 `execute_command`，伪造调用安全失败。
3. Anthias 不自动触发 UAC、创建系统账户、改变机器级规则或下载依赖。
4. sandbox 候选无法通过 Windows conformance test 时，Feature 不能标记为已实现。

### J. 进程树与资源关闭

1. 无害的测试命令启动可识别子进程后，abort 与 timeout 都能结束完整进程树，不留下后台进程。
2. Agent 的统一关闭行为是幂等的，会停止 activeRun、解决 approval、关闭 Session 与 reset sandbox；TUI 等待它完成后退出。
3. 注入进程树或 ACL 清理不确定结果时，ToolResult 显示 `cleanupUncertain`，后续命令被拒绝，文件和对话能力不被误报为命令安全。

### K. Session 顺序与恢复

1. 并行读取逆序完成时，JSONL 中 AssistantMessage 先于全部 ToolResult，ToolResult 按 ToolCall 源顺序追加。
2. 副作用继续在本地效果前刷新 ToolExecutionStartedRecord；崩溃恢复不会重放已开始但未结束的副作用。
3. 现有 Schema 1 Session 可以原样重新打开；Permission Mode 不污染 Message 历史。
4. 恢复后的 Agent 使用当前启动模式和当前平台能力，不把历史批准当作新权限。

### L. TUI 与职责

1. TUI 初始界面与模式变化能显示 Agent / Plan 和命令 sandbox 的 ready / unavailable 状态。
2. 并行 Tool 输出和结束信息始终显示可区分的 Tool 名或 toolCallId；乱序结束不会串到错误调用。
3. TUI 能区分 approval、硬拒绝、sandbox 失败、普通 Tool 失败、取消和 cleanup uncertain。
4. TUI 测试证明它只调用 Agent Interface，不直接解析命令、访问 ToolRunner、写 Session 或启动 sandbox。
5. Agent package 入口不导出内部规则表、Tool scheduler、Shell parser、Windows API 或 sandbox 依赖类型。

## 10. 验证边界

- 调度、模式和 Policy 的主要验收从公开 Agent Interface 进入，使用确定性 Model Stream、受控只读 executor、假 Windows sandbox 和临时 workspace；只在需要证明真实 Windows 内核边界时进入集成 seam。
- 危险命令测试只调用纯分类函数，并用 spy 证明 executor 没有被调用。禁止为了验证规则而执行任何危险命令，包括在容器、VM、WSL 或所谓“测试盘”中尝试。
- Windows conformance test 只使用专门创建的临时工作区、临时外部 sentinel、无害子进程和测试凭据；测试完成后检查进程、临时权限和文件均已收口。
- 如果真实 Windows sandbox 前置条件需要 UAC、创建本地账号、修改 ACL / WFP 或安装依赖，先停下并取得开发者对该系统变更与清理方式的单独授权。
- 不调用真实 Model Provider，不访问付费 API，不读取真实凭据，不依赖公网，也不把本地绝对路径、环境变量或原始异常写入持久错误。
- Plan 可以确定并发上限、规则 ID、Shell 解析实现和 Windows backend 候选，但不能改变纯只读批次才并行、硬拒绝不可批准、命令必须 fail-closed 等产品语义。
- 当前 Spec、Plan 与 Tasks 已确认，且开发者已授权本轮连续实施全部 Stage；依赖下载、UAC / 机器级系统修改、真实 Provider、外网、后续提交、推送和 PR 仍需分别授权。
