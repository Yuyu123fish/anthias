# Feature 002：基础 Tool Loop 与线性 Session

状态：已实现

- 文档类型：Spec
- Feature 目录：feature002-tool-loop-and-session
- 关联基线：[产品定义](../../docs/product-definition.md)、[技术基线](../../docs/technical-baseline.md)、[Feature 001](../feature001-basic-agent-loop/spec.md)

## 1. 问题

Feature 001 已经建立一个能够流式对话、停止当前响应并继续使用的内存 Agent，但一次提示词仍然只会发起一次纯文本模型请求。模型不能发现或读取工作区文件，不能修改代码，也不能运行验证命令；生产 Model Adapter 还会丢弃模型流中的 ToolCall 信息。因此当前闭环只能对话，不能完成基本的本地编码任务。

Anthias 需要把这个最小循环推进为可实际使用的 Coding Harness：用户提交一个编码目标后，Agent 可以在同一个 Run 中多次请求模型，执行必要的读取、搜索、编辑、写入和命令 Tool，把 ToolResult 返回模型，直到模型给出最终回答。同时，对话与 Tool 事实需要持久化为线性 JSONL Session，使进程重新启动后能够恢复已经完成的上下文，并能识别中断期间可能产生的未知副作用。

本 Feature 仍不实现 OS 沙箱和通用权限策略。为了避免模型未经用户知情就修改文件或执行任意命令，所有具有副作用能力的 ToolCall 必须在执行前逐次获得人工确认。

## 2. 方案

将一次被接受的用户提示词表示为一个 Run。一个 Run 可以包含多次模型请求、多条 AssistantMessage、多个 ToolCall、对应的 ToolExecution 与 ToolResultMessage，直到进入明确终态。

Agent 继续作为唯一行为权威，负责：

- 持有 Session 消息和当前 Run 状态；
- 组织 Model → Tool → Model 的循环；
- 校验 ToolCall、生成副作用预览并等待人工确认；
- 执行 Tool，传播取消，限制资源并回收进程；
- 按顺序发布 AgentEvent；
- 将完整事实追加到 Session JSONL；
- 从已有 JSONL 重建线性上下文并处理未完成 Run。

Model Adapter 只把 OpenAI-compatible 流转换为 Agent 内部的文本增量、完整 ToolCall 和结束原因，不执行 Tool，也不持有循环。TUI 继续只使用 Agent Interface：提交提示词、响应待确认 ToolCall、停止 Run、读取状态和订阅事件；它不直接调用 Tool、不写 JSONL，也不维护第二套生命周期。

## 3. 术语与生命周期

### 3.1 Session

Session 是绑定一个规范化工作区根目录的、可持久化的线性编码上下文。一个 Session 使用一个 JSONL 文件保存历史事实，默认物理位置为 `<workspaceRoot>/data/conversation/<sessionId>.jsonl`。Feature 002 可以创建新 Session，也可以重新打开同一工作区中已有的 Session；不支持从中间消息分叉。

### 3.2 Run

Run 从 Agent 接受一条 UserMessage 开始，到 completed、aborted 或 failed 之一结束。进程重启发现未终结的旧 Run 时，Session 恢复会把它记录为 interrupted；interrupted 不是当前 `prompt()` 的返回值。一个 Run 可以包含多次模型请求，不等同于单个 AssistantMessage 或单次 ToolExecution。

活动 Run 只处于以下阶段之一：

    requesting_model
      ├─ 无 ToolCall且正常停止 → completed
      └─ 有 ToolCall → awaiting_tool_approval 或 executing_tool

    awaiting_tool_approval
      ├─ 批准 → executing_tool
      ├─ 拒绝 → ToolResultMessage → requesting_model
      └─ 停止 → aborted

    executing_tool
      ├─ ToolResultMessage → requesting_model
      └─ 停止 → aborted

任一活动阶段都可能因模型故障、内部不变量破坏或内部安全保险丝触发而 failed。

### 3.3 Message、ToolCall 与 ToolExecution

- UserMessage：用户提交并进入模型上下文的文本消息。
- AssistantMessage：一次模型请求形成的完整消息，可以按顺序包含文本和 ToolCall。
- ToolResultMessage：与一个 ToolCall 一一对应、会进入后续模型上下文的结果消息。
- ToolCall：模型在 AssistantMessage 中提出的 Tool 名称、调用标识和输入。
- ToolExecution：Anthias 在本地尝试执行一个已校验 ToolCall 的过程，包含确认、开始、取消、输出和终结事实。
- AgentEvent：只用于当前进程内观察的瞬时事件，不是 Session 持久化格式。

一个 Run 可以有多条 AssistantMessage。AssistantMessage 因 ToolCall 结束不表示 Run 结束。每个已经形成的 ToolCall 在 Run 收口前必须获得一个 completed、failed、denied、aborted 或 unknown ToolResultMessage。

## 4. 用户故事

1. 作为 Anthias 用户，我希望 Agent 能够自动发现、搜索和读取当前工作区，从而基于真实代码而不是猜测回答编码请求。
2. 作为 Anthias 用户，我希望 Agent 能在一次请求中多次调用模型和 Tool，从而完成“检查代码、修改、验证、总结”的完整闭环。
3. 作为 Anthias 用户，我希望在 Assistant 文本生成期间继续看到流式内容，从而及时了解 Agent 当前方向。
4. 作为 Anthias 用户，我希望看到 Agent 正在调用哪个 Tool 及其结果，从而理解编码任务的执行过程。
5. 作为 Anthias 用户，我希望只读 Tool 在工作区内自动执行，从而不会因无副作用的检查频繁打断流程。
6. 作为 Anthias 用户，我希望文件修改、文件写入和命令执行在发生前展示准确内容并等待确认，从而保留对本地副作用的最终控制权。
7. 作为 Anthias 用户，我希望可以批准当前这一条副作用 ToolCall，从而让 Agent 继续执行已展示的操作。
8. 作为 Anthias 用户，我希望可以拒绝当前副作用 ToolCall，并让模型看到拒绝结果，从而使 Agent 能选择其他方案或停止相关操作。
9. 作为 Anthias 用户，我希望陈旧、重复或不匹配的确认响应不会触发 Tool，从而避免确认与实际操作错配。
10. 作为 Anthias 用户，我希望能够在模型请求、等待确认或 Tool 执行期间停止当前 Run，从而重新取得控制并释放活动资源。
11. 作为 Anthias 用户，我希望 Tool 参数错误、文件变化、命令失败或未知 Tool 不会直接破坏整个 Session，从而让模型有机会读取失败结果并修正。
12. 作为 Anthias 用户，我希望对话和 Tool 事实自动保存为本地 JSONL，从而在进程退出后保留已经完成的编码上下文。
13. 作为 Anthias 用户，我希望重新打开 Session 时不会自动重放中断的副作用，从而避免重复修改文件或重复运行命令。
14. 作为 Anthias 用户，我希望 Agent 在异常连续请求模型或一次产生过多 ToolCall 时安全失败，从而避免失控循环和过大调用批次。
15. 作为 Anthias 用户，我希望退出 TUI 时当前模型流、确认等待、命令进程和文件句柄都被收口，从而不遗留后台资源。
16. 作为 Anthias 交互适配器开发者，我希望通过同一个 Agent Interface 观察消息、Tool、确认和 Run 事件，从而无需在 TUI 或未来 Desktop 中复制 Agent Loop。

## 5. 用户流程

### 5.1 创建或打开 Session

1. 用户从 TUI 启动 Anthias，并创建新 Session 或打开当前工作区已有的 Session。
2. Agent 校验模型配置、工作区身份和 Session JSONL；TUI 不读取模型凭据或 JSONL。
3. 打开已有 Session 时，Agent 从持久记录重建消息历史。先前未完成的 Run 按恢复规则收口，不自动继续模型请求或 Tool 副作用。
4. TUI 订阅 AgentEvent，展示 Session 已经完成的线性消息并等待输入。

具体的 Session 文件选择参数和 TUI 命令语法由 Plan 决定，但必须支持创建与重新打开，且不得让 TUI 成为持久化权威。

### 5.2 只读 Tool Loop

1. 用户提交非空提示词。
2. Agent 创建 Run，追加 UserMessage，并向模型发送系统提示词、当前线性消息上下文和 Tool 定义。
3. 模型输出 Assistant 文本和一个或多个只读 ToolCall。
4. Agent 完成并持久化 AssistantMessage，然后按出现顺序自动执行 `read_file`、`glob` 或 `grep`。
5. 每个执行结果形成 ToolResultMessage 并进入下一次模型请求。
6. 循环持续到模型正常结束且不再请求 Tool，或者 Run 进入其他终态。

### 5.3 副作用 ToolCall 确认

1. 模型请求 `edit_file`、`write_file` 或 `execute_command`。
2. Agent 在不产生副作用的前提下校验参数并准备确认内容。
3. 参数无效时不请求确认，直接生成 failed ToolResultMessage。
4. 参数有效时，Agent 进入 awaiting_tool_approval，发布确认请求并暂停该 ToolCall。
5. TUI 展示 Tool 名、目标和完整的有界预览，并提示用户批准或拒绝。
6. 用户批准后，Agent 先持久化 ToolExecutionStartedRecord，再执行已经展示的 ToolCall。
7. 用户拒绝后，Agent 不执行 Tool，生成 denied ToolResultMessage。
8. ToolResultMessage 返回模型，模型可以继续、改用其他方案或给出最终回答。

确认只适用于当前 ToolCall 的准确输入和预览，不产生后续调用授权。

## 6. 行为与失败

### 6.1 消息与模型上下文

- Session 的模型可见消息只有 UserMessage、AssistantMessage 和 ToolResultMessage。
- AssistantMessage 内容按模型产生顺序保存文本和完整 ToolCall；ToolCall 至少包含稳定的 toolCallId、toolName 和最终输入。
- ToolResultMessage 必须引用原 ToolCall 的 toolCallId 和 toolName，并包含结果状态、有界文本内容及截断标记。
- Provider、AI SDK 和原始流事件类型不得进入持久消息、Agent 外部 Interface 或 TUI。
- Assistant 文本增量只更新当前活动 AssistantMessage，不为每个增量创建消息或 JSONL 记录。
- 模型输入由当前系统提示词和已经完成的线性消息投影形成；AgentEvent、TUI 渲染状态、原始异常和 ToolExecutionStartedRecord 不直接进入模型上下文。
- 模型正常停止且没有 ToolCall 时，当前 Run completed。
- 模型因长度、内容过滤、流错误或无法解释的结束原因停止时，保留已经形成的 Assistant 内容，并使当前 Run failed；不得把不完整输出表述为成功完成。
- Feature 002 不持久化或展示模型隐藏推理，也不新增 ReasoningMessage。

### 6.2 Model → Tool → Model 循环

- 一条被接受的 UserMessage 只追加一次，但可以触发多次模型请求。
- Agent 每次模型请求都传入当前消息投影和同一组 Tool 说明。
- Model Adapter 只转换文本增量、完整 ToolCall 和结束原因；它不提供 Tool 的 execute 回调，不使用 Provider 或 AI SDK 的自动多步循环。
- 一条 AssistantMessage 可以同时包含文本和多个 ToolCall。
- 多个 ToolCall 按 AssistantMessage 中的出现顺序串行处理，不在本 Feature 中并行执行。
- 单个 Tool 失败或被拒绝通常不终止 Run。Agent 补齐对应 ToolResultMessage后继续处理同一 AssistantMessage 中尚未处理的 ToolCall，再发起下一次模型请求。
- 未知 Tool、无法解析的输入或 Schema 校验失败生成 failed ToolResultMessage，使模型可以修正调用。
- Agent 不通过异常表示预期的 Tool 失败、拒绝或非零命令退出；内部安全保险丝也返回普通 failed 结果。只有内部不变量破坏和无法安全收口的基础设施故障通过异常进入安全失败路径。

### 6.3 首批 Tool

Feature 002 只向模型提供以下六个 Tool：

#### `read_file`

- 读取工作区内的 UTF-8 文本文件；支持从指定行开始和限制读取行数。
- 返回实际覆盖范围、总行数（可确定时）、是否截断以及继续读取的位置。
- 二进制或不支持的编码返回 failed ToolResult，不把原始字节注入模型上下文。

#### `glob`

- 在工作区内按 Glob 模式发现文件。
- 结果使用规范化的工作区相对路径并稳定排序。
- 结果达到输出边界时明确标记截断，模型必须缩小目录或模式后继续查找。

#### `grep`

- 在工作区内按正则搜索文本内容，可限定目录和文件模式。
- 每个匹配至少返回工作区相对路径、行号和匹配文本。
- 结果达到输出边界时明确标记截断，不能据此宣称整个工作区不存在其他匹配。

#### `edit_file`

- 对一个已有 UTF-8 文本文件执行一组精确文本替换。
- 每个旧文本必须在确认预览所基于的文件内容中唯一匹配；同一调用中的替换不得重叠。
- 整个调用要么全部应用，要么不修改文件，并向用户展示统一 Diff。
- 准备预览后如果目标文件发生变化，已批准调用必须以 stale target 失败，不得把旧预览应用到新内容。

#### `write_file`

- 创建 UTF-8 文本文件，或完整替换已有 UTF-8 文本文件。
- 确认内容必须明确区分创建与覆盖，并展示目标路径以及有界内容或 Diff 预览。
- 准备预览后如果已有目标发生变化，已批准调用必须以 stale target 失败。
- 修改已有文件时，系统提示词应优先引导模型使用 `edit_file`；`write_file` 仍保留完整重写能力。

#### `execute_command`

- 在当前 Session 已确定且明确告知模型的 Shell 中执行一次性、非交互命令。
- 输入包含命令文本、可选工作目录和可选超时；工作目录默认 workspace root，并且自身必须位于工作区内。
- 确认内容展示实际 Shell、规范化工作目录、完整命令和有效超时。
- 每次调用启动一个新进程；`cd`、别名、变量和进程状态不跨 ToolCall 保留。
- 返回退出码、按观察顺序形成的有界输出、执行时长、终止原因和截断状态。
- 非零退出码生成 failed ToolResult，但不等同于 Agent Loop 基础设施失败。
- Tool 名不绑定 Bash 或 PowerShell。当前 Windows 环境优先使用 PowerShell 7；实际 Shell 在 Session 运行期间固定，并在模型说明和确认内容中保持一致。
- `execute_command` 不是 OS 沙箱。限制工作目录不能阻止命令访问工作区外文件、网络或其他进程。

### 6.4 人工确认

- `read_file`、`glob` 和 `grep` 是只读 Tool，在工作区合同内自动执行。
- `edit_file`、`write_file` 和 `execute_command` 是副作用能力 Tool，每个 ToolCall 都必须逐次确认。
- Feature 002 不尝试静态判断某条命令是否“只读”；所有 `execute_command` 调用均等待确认。
- 确认前只允许完成输入 Schema 校验、路径解析、文件读取、Diff 计算、目标指纹计算和命令展示，不得写文件或启动命令。
- Agent Interface 使用 `respondToToolApproval(toolApprovalRequestId, decision)` 响应当前 Tool 确认，其中 `decision` 只允许 `approve` 或 `deny`；该行为不能暴露 Tool 的直接执行入口。
- AgentState 保存当前唯一待确认请求；TUI 只能从 AgentState 和 AgentEvent 观察它，不能自行构造或替换确认请求。
- 过期、重复、错误标识或当前阶段不匹配的确认响应作为预期拒绝返回，不执行 Tool，也不改变 Run。
- 用户批准后，Agent 必须在副作用发生前追加并刷新 ToolExecutionStartedRecord；该记录表明此 ToolCall 已经人工批准并开始执行。
- 用户拒绝后不创建 ToolExecutionStartedRecord，直接追加 denied ToolResultMessage。
- 用户等待确认直到响应或当前 Run 被停止；确认层不维护独立时钟。
- 本 Feature 只有 approve once 和 deny，不提供永久允许、Session 允许、模式匹配、命令前缀授权或自动批准。

### 6.5 AgentState、AgentEvent 与 TUI

- AgentState 包含 sessionId、已结束消息、活动 AssistantMessage、activeRun、最近一次安全错误和当前待确认请求。
- `running` 如继续保留，只能由 activeRun 是否存在派生，不能成为第二个生命周期权威。
- activeRun 阶段只有 requesting_model、awaiting_tool_approval 和 executing_tool。
- Agent 公开 Interface 继续提供 state、prompt、abort 和 subscribe，并增加 `respondToToolApproval(toolApprovalRequestId, decision)`；其中 `decision` 仅允许 `approve` 或 `deny`。该行为只响应当前有效的确认请求，过期、重复或不匹配的响应必须被拒绝且不能改变 Run 状态。Interface 不暴露内部循环步骤、Tool 集合、JSONL Writer 或 Model Stream。
- Feature 001 的 agent_start 和 agent_end 更名为 run_start 和 run_end，因为它们表示 Run，而不是 Agent 实例生命周期。
- AgentEvent 至少覆盖 run_start、消息开始/文本更新/结束、Tool 确认请求/解决、Tool 执行开始/输出更新/结束和 run_end。
- Tool 输入参数增量不要求进入 AgentEvent；确认和执行只使用已经完成并校验的 ToolCall。
- `execute_command` 的有界实时输出通过瞬时 Tool 执行更新事件展示；JSONL 不逐块保存输出。
- TUI 在 awaiting_tool_approval 阶段把用户输入解释为当前确认响应，不把它作为新提示词提交。
- `/exit` 和终端关闭始终优先触发退出收口；Ctrl+C 在 activeRun 存在时停止当前 Run，包括正在等待确认的阶段。
- Agent 处于任一 activeRun 阶段时，新提示词仍以 busy 预期结果拒绝，不进入队列。
- TUI 不根据 Tool 名自行判断是否确认，也不直接启动进程或修改文件。

### 6.6 JSONL Session

- 一个 Session 对应一个追加写入的 JSONL 文件，并绑定一个规范化 workspace root。
- 默认 Session 目录是 `<workspaceRoot>/data/conversation`。该目录由 Anthias 持有，并在目录内部使用内容为 `*` 的本地 `.gitignore` 隐藏全部运行数据；Anthias 不自动修改项目根 `.gitignore`。
- `ANTHIAS_SESSION_DIR` 可以覆盖默认 Session 目录，主要供测试和特殊部署使用；无论目录来自默认值还是覆盖值，路径解析、创建和文件访问都由 Agent Module 负责。
- Agent 内置文件 Tool 不得读取、修改或遍历活动 Session 目录，避免模型把自身持久上下文再次读入或破坏正在追加的 JSONL。未来的 `execute_command` 在本 Feature 中没有 OS 沙箱，不能承诺无法访问该目录；每次命令仍必须经过人工确认。
- 第一行是 SessionHeader，至少包含 schemaVersion、sessionId、createdAt 和 workspaceRoot。
- 后续每条记录都有稳定 entryId、单调递增 seq 和 timestamp；属于 Run 的记录还包含 runId。
- 除首行 SessionHeader 外，Feature 002 的持久记录只有 MessageRecord、ToolExecutionStartedRecord 和 RunFinishedRecord，不保存流式 delta 或 AgentEvent。
- 第一条 UserMessage 隐式表示 Run 开始，不额外写入只重复同一事实的 RunStartedRecord。
- AssistantMessage 必须在执行其 ToolCall 之前完成追加。
- ToolExecutionStartedRecord 必须在对应本地副作用之前完成追加和刷新。
- ToolResultMessage 只在结果已终结后追加；结果文本遵守统一输出边界。
- RunFinishedRecord 只保存 completed、aborted、failed 或 interrupted 终态以及记录身份，不保存请求次数、ToolCall 数、活动时长或 token usage。
- Session 写入在 Agent 内串行化。Feature 002 不支持两个 Agent 进程同时写同一个 Session；不得把并发写入静默合并。
- 打开 Session 时，workspaceRoot 不匹配必须拒绝继续，不能把历史上下文绑定到另一个工作区执行 Tool。
- 只允许丢弃或截断文件末尾一条“没有换行结尾且 JSON 语法不完整”的残缺记录。任何位于文件中间的非法记录，以及已经换行结束但无法验证的最后一条记录，都视为 Session 损坏并停止加载，不能跳过损坏后继续恢复。
- 加载时从持久记录投影模型上下文、对话展示和 AgentState，TUI 与 Model Adapter 不直接读取 JSONL。
- 进程重启不恢复活动 Run。没有 RunFinishedRecord 的最后一个 Run 必须先被收口为 interrupted，之后用户才能提交新提示词。
- 已有 ToolExecutionStartedRecord 但没有 ToolResultMessage 的 ToolCall 追加 unknown ToolResultMessage，表示外部效果未知，绝不自动重试。
- 没有 ToolExecutionStartedRecord 且没有 ToolResultMessage 的 ToolCall 追加 aborted ToolResultMessage，表示它未在本次进程中开始执行。
- 恢复产生的补充记录继续追加到同一 JSONL，不重写或删除既有历史。
- Feature 002 不增加 parentId、Branch、Checkpoint 或 Active Path。schemaVersion、sessionId、entryId、runId、toolCallId、seq 和 workspaceRoot 为未来引用历史位置保留稳定身份。

### 6.7 取消、终态与安全边界

- 一个 Run 使用同一个根 AbortSignal 传播到当前 Model Adapter 或 ToolExecution。
- 模型请求中止时，保留已经形成的 Assistant 文本并以 aborted 结束；不持久化未完成的 ToolCall 参数。
- 等待确认时中止，当前及尚未处理的 ToolCall 形成 aborted ToolResultMessage，不执行副作用。
- Tool 执行中止时，当前 ToolResultMessage 记录 aborted；尚未处理的 ToolCall 也补齐 aborted 结果。
- `execute_command` 中止或超时时必须尽力终止整个进程树、停止接收输出并关闭相关句柄。无法确认全部后代进程已经结束时，结果必须明确标记资源清理不确定。
- 正常完成、失败、拒绝和中止最终都必须释放模型迭代器、AbortController、确认等待、命令计时器、文件句柄和子进程所有权。
- activeRun 保持到 run_end 已同步发布后再清除，避免订阅者重入 prompt 打断事件顺序。

Agent Loop 只保留两个内部安全保险丝：

- 同一个 Run 发起 12 次模型请求后仍未结束时，不再发起第 13 次请求，Run 以普通 failed 结束；
- 单条 AssistantMessage 包含超过 32 个 ToolCall 时，整批调用都不执行、不请求确认，逐个形成 failed ToolResultMessage 后让 Run failed。

这两个值不形成公开 Run 预算，不进入 `AgentState`、`run_end`、RunFinishedRecord 或 TUI，也不累计跨消息 ToolCall 数。Anthias 不设置 Run 活动时长；`execute_command.timeoutMs` 仍是单次命令自身的超时合同。单个模型可见 ToolResult 仍最多 64 KiB 或 2,000 行，以先达到者为准，达到边界只截断该结果，不终止 Run。

### 6.8 系统提示词、安全与敏感信息

- Agent 内部提供 Coding Agent 系统提示词，至少说明 workspace root、当前平台与 Shell、可用 Tool、先检查再修改、优先使用专用文件 Tool、修改后执行相关验证以及真实报告失败。
- 系统提示词和 Tool 描述由 Agent Module 持有，不由 TUI 拼装。
- 生产 Model Adapter 继续只从 Agent 内部取得 Provider 配置，TUI 和 Tool 不接触 API Key。
- `execute_command` 的子进程环境不得包含 ANTHIAS_MODEL_API_KEY；模型凭据不得进入命令、ToolResult、AgentEvent、JSONL、TUI 输出或测试快照。
- Feature 002 不承诺识别工作区文件中的秘密，也不承诺过滤宿主环境中除 Anthias 模型凭据以外的全部敏感值。
- Tool 确认只能证明用户看过并批准当前调用，不表示命令安全，也不形成 OS 隔离。

## 7. 已确认决定

- Feature 002 同时交付多次模型请求的 Tool Loop、六个本地 Tool、逐次副作用确认、线性 JSONL Session 和 TUI 可观察闭环。
- Agent 持有消息、Run、确认、ToolExecution、JSONL、取消和资源释放；TUI 只负责输入、确认响应与呈现。
- Model Adapter 不执行 Tool，不使用 AI SDK 自动循环，也不把 AI SDK 类型传播到 Agent 外部 Interface。
- 首批 Tool 固定为 `read_file`、`glob`、`grep`、`edit_file`、`write_file` 和 `execute_command`。
- `read_file`、`glob`、`grep` 自动执行；`edit_file`、`write_file` 和所有 `execute_command` 逐次等待人工确认。
- 确认只有当前调用批准和拒绝，不实现可复用授权规则。
- 同一 AssistantMessage 中的 ToolCall 串行处理。
- Agent Interface 只为确认增加一个必要的响应行为，不增加 Tool Manager、Registry、内部 Loop 控制或持久化入口。
- Session 使用一个 JSONL 文件保存线性事实；最终消息与副作用开始事实持久化，流式 delta 不持久化。
- Session 最终默认保存在所属 workspace 的 `data/conversation`，目录内部自行忽略运行文件且不改项目根 `.gitignore`；文件 Tool 把该位置作为 Agent 自有保留目录。
- 进程重启只恢复已完成的线性上下文，不继续活动 Run，也不自动重试可能有副作用的 ToolCall。
- 当前不实现对话分叉，但保留可由未来记录引用的稳定身份和 schemaVersion；不预建空 Branch 或 parent graph。
- Run 资源限制按模型请求数、ToolCall 数、活动执行时长和单结果输出分别表达，不使用单一 step 概念。

## 8. 不在范围内

- OS 沙箱、容器、虚拟机、Windows Job Object 或强隔离执行环境；
- 命令静态安全分析、只读命令识别、危险命令分类或路径级授权策略；
- allow for session、always allow、命令前缀规则、持久授权、角色权限或权限配置文件；
- 无人值守自动批准副作用 ToolCall；
- 持久 Terminal、PTY、`write_stdin`、REPL、后台服务或跨 Run 进程；
- `delete_file`、`move_file`、`mkdir`、Git 专用 Tool、Web、LSP、MCP、Skill、Task、Todo 或多 Agent Tool；
- 二进制文件读取、图片理解、Blob Tool 或完整大输出归档；
- Tool 插件系统、Tool Registry、动态发现或第三方扩展合同；
- Provider 自动 Tool 执行、模型重试、模型切换、多 Provider 或 Provider Registry；
- follow-up 队列、steering、并发 Run 或并行 ToolExecution；
- Compaction、摘要、上下文裁剪策略或长期 Memory；
- parentId、Active Path、检查点、对话分叉、执行分支或候选比较；
- 多进程同时写一个 Session、远程 Session、数据库索引或 Session 云同步；
- Desktop、跨进程 Host、IPC、JSON-RPC 或传输 DTO；
- 默认自动化验证中的真实 Provider、外部网络、付费 API 或真实开发者仓库副作用。

## 9. 验收标准

### A. 只读编码检查

确定性 Model Adapter 依次请求 `glob`、`grep` 和 `read_file` 后给出最终文本时：

- 一个 UserMessage 只追加一次；
- 三个只读 Tool 无需人工确认并按模型给出的顺序执行；
- 每个 ToolCall 都有对应 ToolResultMessage；
- 后续模型请求按顺序收到 AssistantMessage 和 ToolResultMessage；
- 最终 Run completed，并报告实际模型请求数和 ToolCall 数。

### B. 批准精确编辑

模型请求一次有效 `edit_file` 时：

- Agent 在修改前展示目标路径和统一 Diff；
- 用户批准前文件不发生变化；
- 批准响应只匹配当前 toolApprovalRequestId；
- ToolExecutionStartedRecord 在文件修改前完成持久化；
- 修改全部成功或完全不发生；
- ToolResultMessage 记录成功结果并进入下一次模型请求；
- TUI 不直接读取或写入目标文件。

### C. 陈旧编辑预览

`edit_file` 预览产生后、用户批准前，目标文件被外部修改：

- 用户批准不会把旧预览应用到新文件；
- ToolExecution 以 stale target 失败；
- 当前文件内容保持外部修改后的状态；
- 模型收到 failed ToolResult，可以重新读取并生成新 ToolCall。

### D. 创建与覆盖文件

模型分别请求创建新文件和覆盖已有文件时：

- `write_file` 确认内容明确区分创建与覆盖；
- 两次调用分别等待人工确认；
- 拒绝不会创建或修改文件；
- 批准只应用已经展示且目标状态未变化的内容；
- 最终 ToolResult 与实际文件状态一致。

### E. 命令确认与失败

模型请求 `execute_command` 时：

- 即使命令看起来只读，也必须等待人工确认；
- 确认内容展示实际 Shell、工作目录、完整命令和超时；
- 用户批准前不启动子进程；
- 非零退出码形成 failed ToolResult，保留有界输出，Run 可以继续；
- ANTHIAS_MODEL_API_KEY 不出现在子进程环境、输出或持久记录中。

### F. 拒绝副作用

用户拒绝 `edit_file`、`write_file` 或 `execute_command`：

- 不产生对应文件或进程副作用；
- 不创建 ToolExecutionStartedRecord；
- 追加 denied ToolResultMessage；
- 模型能够看到拒绝并继续当前 Run；
- 重复或陈旧确认响应不能再次改变状态。

### G. 多 Tool 多模型循环

确定性模型依次请求读取文件、编辑文件、执行验证命令，然后给出最终回答：

- Run 中存在多条 AssistantMessage；
- 只读 Tool 自动执行，两个副作用 Tool 分别等待确认；
- ToolCall、确认、ToolExecution、ToolResult 和模型请求顺序符合合同；
- 最终回答只在最后一次没有 ToolCall 的正常模型响应后使 Run completed；
- Agent 回到 idle，并能接受下一条提示词。

### H. 参数错误与未知 Tool

模型产生无效参数、未知 Tool 或无法解析的 ToolCall：

- 不请求人工确认，不产生本地副作用；
- 生成与原 toolCallId 对应的 failed ToolResultMessage；
- 模型可以在后续请求中修正调用。

### I. 分阶段停止

分别在模型流、等待确认和命令执行期间停止 Run：

- 根 AbortSignal 只使 Run 进入一次终态；
- 已经形成的文本和消息保持可见；
- 当前及未处理 ToolCall 获得适当的 aborted ToolResultMessage；
- 等待确认时停止不会执行 Tool；
- 命令执行时停止会尽力终止进程树并报告清理是否确定；
- run_end 发布后 Agent 回到 idle，能够继续使用。

### J. 安全保险丝与结果边界

分别触发连续模型请求保险丝、过大 ToolCall 批次、命令自身超时和 ToolResult 输出边界：

- 第 13 次模型请求不发出，Run 以带安全错误文本的 failed 收口；
- 单条 AssistantMessage 超过 32 个 ToolCall 时不执行或确认其中任何一个，并为全部调用形成 failed ToolResultMessage；
- 命令只遵守该次 ToolCall 的 `timeoutMs`，不存在额外 Run 活动时长计时器；
- ToolResult 达到输出边界时明确截断，命令输出管道仍被排空并完成资源清理。

### K. JSONL 保存与重载

完成一个包含 Tool 的 Run 后重新打开 Session：

- SessionHeader、seq、entryId、runId、toolCallId 和 workspaceRoot 保持一致；
- 消息、ToolExecutionStartedRecord 和 RunFinishedRecord 顺序符合实际发生顺序；
- 流式 delta 和 AgentEvent 不出现在 JSONL；
- 模型上下文和 TUI 对话从同一持久事实投影；
- 后续提示词可以沿已完成的线性上下文继续。

### L. 中断恢复

分别模拟模型请求期间中断、等待确认期间中断，以及副作用开始后但 ToolResult 写入前中断：

- 重启后不自动继续旧 Run；
- 旧 Run 追加 interrupted 终态；
- 未开始执行的 ToolCall 追加 aborted ToolResultMessage；
- 已记录开始但结果缺失的 ToolCall 追加 unknown ToolResultMessage；
- 不自动重试文件修改或命令；
- 用户可以提交新提示词继续 Session。

### M. 接口与职责

- Agent Module 不依赖 TUI，TUI 单向依赖 Agent 的公开 Interface；
- TUI 不读取 JSONL、模型配置、模型消息或 Tool 实现；
- Model Adapter 不执行 Tool，也不拥有 Run 循环；
- AI SDK、Provider、Model Stream、Tool 内部 Schema 和 JSONL Writer 不从 Agent package 入口导出；
- 确定性非 TUI 调用者可以通过同一 Agent Interface 完成提示词、确认、停止和事件观察；
- 不需要 Tool Registry、协议包或第二个生命周期归约器。

### N. 干净退出

Agent 分别在 idle、requesting_model、awaiting_tool_approval 和 executing_tool 阶段退出：

- 当前 Run 按合同中止或恢复标记；
- 释放模型迭代器、确认等待、JSONL 文件句柄、命令计时器和子进程；
- TUI 取消订阅并移除信号监听器；
- 不遗留由 Anthias 持有的活动后台资源。

## 10. 验证边界

自动化验证优先通过 Agent 的公开 Interface 覆盖完整 Model → Tool → Model 行为。Agent Module 使用确定性 Model Adapter、受控 Tool 实现和临时 Session 存储验证事件顺序、确认暂停与恢复、消息上下文、JSONL 记录、内部保险丝、结果边界、取消和中断恢复；不通过调用内部 Loop 步骤验证行为。

内置文件 Tool 只在测试创建的临时工作区中验证路径、精确编辑、原子写入、陈旧预览和截断。命令 Tool 只运行确定、短时、无外部网络的本地子进程，验证输出、非零退出、超时、取消和进程回收。TUI 测试通过公开 Agent Interface 模拟批准、拒绝、停止和退出，不构造 Model Stream、ToolExecution 或 JSONL Record。

生产 OpenAI-compatible Adapter 可以通过确定性本地 HTTP 流验证 ToolCall 转换，但默认验证不访问真实 Provider、不使用真实凭据，也不在开发者仓库执行真实副作用。真实模型 Tool Calling、人工 PowerShell 体验和任何外部网络验证需要单独授权，并在实施报告中明确证据边界。
