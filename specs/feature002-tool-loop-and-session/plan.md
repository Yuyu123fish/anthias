# Feature 002：基础 Tool Loop 与线性 Session 实施方案

状态：已实现

- 文档类型：Plan
- 对应 Spec：[spec.md](spec.md)
- Plan 结构：一个文档、三个线性 Stage
- 授权状态：Plan 与 Tasks 已由开发者确认；Feature 002 全部 Stage 的本地实施、逐 Stage 提交和最终提交已获授权；仅 `diff@9.0.0` 下载已取得并使用网络授权，真实 Provider、其他外部网络、推送和 PR 尚未授权

## 1. 当前基线与范围

- 当前分支为 `main`，Stage 01 已在 `8c34b78` 完成，Stage 02 已在 `996556e` 完成，Stage 03 已完成整体集成与验收准备。
- 当前环境为 Windows、Node.js `v24.13.1`、pnpm `10.33.0`、PowerShell `7.5.4`。
- `apps/agent` 已实现 Schema 1 Session 的新建、追加、按 UUID 重开与持久投影；一次提示词可以在单 activeRun 内发起多次结构化模型请求，串行处理 ToolCall，并统一支持取消、预算和安全失败。
- `apps/tui` 仍只依赖 `@anthias/agent`，现已通过同一公开 Interface 呈现 Tool、处理逐次确认、停止当前 Run 并报告实际预算用量。
- 生产 OpenAI-compatible Adapter 仍位于 Agent Module 内部，使用 AI SDK `7.0.85`，现已转换文本、ToolCall、finish reason 和 usage，但不执行 Tool 或拥有循环。
- Stage 02 完成门的 `pnpm verify` 已通过 Biome、Strict TypeScript、构建和 87 个测试；`pnpm install --frozen-lockfile --offline` 同时通过。
- Stage 03 最终 `pnpm verify` 已通过 Biome 对 33 个文件的检查、Strict TypeScript、构建和 13 个测试文件中的 89 个测试。
- 当前已具备线性 Session 恢复与独占写入、六个固定 Tool、逐次副作用确认、Model → Tool → Model 循环和资源预算；Stage 1 产生的 Schema 1 终态记录仍可重开。

本 Plan 只交付 Spec 已定义的线性 JSONL Session、六个固定 Tool、逐次副作用确认、多模型请求 Agent Loop、TUI 闭环和整体本地验收。不会加入沙箱、可复用授权、PTY、后台命令、动态 Tool Registry、Compaction、分叉、Desktop 或多 Agent。

## 2. 三阶段交付顺序

| Stage | 独立结果 | 本阶段不带入 |
| --- | --- | --- |
| Stage 01：线性 Session 存储 | 新建、追加、重开、校验和恢复 JSONL Session；现有纯文本 Run 已能持久化并继续 | Tool 定义、Tool 执行、人工确认、多模型请求循环 |
| Stage 02：Tool 系统与 Agent Loop | 六个 Tool、逐次确认、Model → Tool → Model、预算、取消和 TUI 呈现形成完整 Coding Harness | 沙箱、PTY、动态插件、分叉及其他 Spec 排除项 |
| Stage 03：整体集成与验收准备 | 在临时工作区中逐项验证 Spec A–N，完成唯一 Report 并形成可供开发者验收的证据 | 新能力、真实 Provider、真实凭据和开发者仓库副作用 |

三个 Stage 必须线性推进。根据开发者本次明确授权，每个 Stage 实施、验证并提交后直接继续下一 Stage；上一 Stage 未通过或边界发生变化时，不得提前实现下一 Stage。Stage 03 的“验收”表示完成验收准备和证据矩阵，只有开发者可以把 Feature 标记为“已验收”。

## 3. 固定技术方案

### 3.1 模块职责

保持现有两个 workspace package，不增加第三个 package：

```text
apps/tui
  └─ 只使用 @anthias/agent 的公开 Interface

apps/agent
  ├─ Agent / Run 协调器       消息、循环、确认、预算、取消与事件
  ├─ Session Module           JSONL、锁、恢复、投影与追加
  ├─ Fixed Tool Module        六个 Tool 的定义、校验、预览与执行
  └─ Model Adapter            Provider 流与内部模型事件互转
```

- Agent 是 Run 行为和资源所有权的唯一权威；Session、Tool 和 Model Adapter 都是 Agent Module 内部 seam。
- TUI 不读取 JSONL、模型配置或 Tool 定义，不计算 Diff、不启动命令，也不维护第二个 Run 状态机。
- Session Module 不知道 TUI 和 Provider；Tool Module 不写 Session；Model Adapter 不执行 Tool、不等待确认、不控制循环。
- package 入口只导出生产启动工厂、Agent Interface 以及 TUI 必需的 state、message、result 和 event 类型；Model Adapter、Tool Schema、Session Record、Writer 和锁类型均不导出。
- 不建立 Tool Registry、Manager、通用插件协议或类层级。六个 Tool 使用一个固定、穷尽的内部映射和判别联合。
- Stage 02 允许在 `apps/agent` 增加唯一一个直接运行时依赖 `diff@9.0.0`，用于不启动 Git 或 Shell 的统一 Diff；该版本自带 TypeScript 类型，不增加 `@types/diff`。其他能力优先使用 Node.js 24 标准库和现有 AI SDK。

### 3.2 Session 选择与本地位置

- workspace root 默认为启动 Anthias 时的 `process.cwd()`，由 Agent 启动工厂通过真实路径规范化；Windows 比较同时规范盘符大小写和分隔符。
- 新建 Session 时生成 UUID `sessionId`，文件名固定为 `<sessionId>.jsonl`。
- Feature 002 完成后的默认 Session 目录固定为 `<workspaceRoot>/data/conversation`。Stage 01 保留 T001 已完成的目录 seam 和过渡默认值；Stage 02 在接入文件 Tool 时同步迁移生产默认值，避免出现“Session 已进入 workspace、文件 Tool 尚未隔离”的中间状态。
- Anthias 在 `data/conversation` 内创建内容为 `*` 的本地 `.gitignore`，使运行 JSONL 和该忽略文件自身都不进入 Git；运行时不修改项目根 `.gitignore`。
- 默认 Session 目录是 Agent 自有保留路径。Stage 02 的 `read_file`、`glob`、`grep`、`edit_file` 和 `write_file` 必须拒绝读取、修改或遍历该目录；没有 OS 沙箱的 `execute_command` 不能提供同等隔离，因此仍逐次确认并明确保留这一安全边界。
- `ANTHIAS_SESSION_DIR` 只覆盖 Session 目录，主要用于本地部署和测试；目录解析、创建和文件访问仍由 Agent Module 负责。
- CLI 不带 Session 参数时创建新 Session；`--session <sessionId>` 只按 UUID 打开默认 Session 目录中的文件，不接受任意文件路径或路径片段。
- TUI 启动后展示 `sessionId` 和规范化 workspace root；Feature 002 不增加 Session 列表、删除、重命名、复制或分叉命令。
- `createAgentFromEnvironment` 改为异步启动工厂，并接收 workspace root、可选 `sessionId` 和环境对象；配置、Session 或恢复失败都返回安全的启动错误，TUI 不接收 JSONL Writer。

### 3.3 JSONL Schema 1

文件使用 UTF-8，每个完整 JSON 对象占一行并以换行结束。首行为无 `seq` 的 `SessionHeader`，其后记录从 `seq = 1` 开始严格递增。

| 记录 | 固定内容 |
| --- | --- |
| `SessionHeader` | `type: "session_header"`、`schemaVersion: 1`、`sessionId`、`createdAt`、`workspaceRoot`、固定 Shell 描述 |
| `MessageRecord` | `type: "message"`、`entryId`、`seq`、`timestamp`、`runId`、一个完整 UserMessage、AssistantMessage 或 ToolResultMessage |
| `ToolExecutionStartedRecord` | `type: "tool_execution_started"`、`entryId`、`seq`、`timestamp`、`runId`、`toolCallId`、`toolName`、`toolApprovalRequestId` |
| `RunFinishedRecord` | `type: "run_finished"`、`entryId`、`seq`、`timestamp`、`runId`、终态、计量完整性、模型请求数、ToolCall 数、活动执行毫秒数、可选预算种类和可用的累计模型 usage |

消息持久形状固定为：

- UserMessage：`type: "user"` 与文本；
- AssistantMessage：`type: "assistant"`、终态和按模型产生顺序排列的文本 part 与 ToolCall part；
- ToolCall part：`toolCallId`、`toolName`、最终输入和输入是否由 Adapter 标为无效；
- ToolResultMessage：`type: "tool_result"`、原 `toolCallId`、`toolName`、`completed | failed | denied | aborted | unknown`、有界文本和 `truncated`；
- 不保存文本 delta、Tool 输入 delta、AgentEvent、Provider 元数据、原始错误或隐藏推理。

`entryId`、`runId`、`toolCallId` 和 `toolApprovalRequestId` 使用 UUID；`timestamp` 使用 UTC ISO 8601。Schema 1 不包含 `parentId`、Branch、Checkpoint 或 Active Path，也不为未来分叉预写空字段。

每次追加都经过同一个串行写入队列，执行“打开追加句柄 → 写入完整行与换行 → `sync` → 关闭”。`ToolExecutionStartedRecord` 的追加 Promise 成功返回后才允许文件修改或子进程启动。写入失败使当前 Run 安全失败，不能先做副作用再补记录。

### 3.4 独占写入、重载与恢复

- Session 在打开恢复和每个已接受 Run 期间，通过原子创建 `<sessionId>.lock` 目录取得独占写权限；锁元数据包含 PID、随机 owner token 和取得时间。
- Agent 空闲时不长期持有 JSONL 文件句柄或 Session 锁。提交新提示词前先取得锁，并核对文件大小、最后 `seq` 与内存检查点；发生变化时返回 `session_changed` 拒绝，要求重新打开 Session，绝不把旧投影接到新尾部。
- 活着或无法确认已经退出的锁所有者导致启动或提示词返回 `session_busy`；只有能够确认 PID 已不存在时才移除残留锁。释放锁时必须匹配 owner token，不能删除其他进程后来取得的锁。
- Run 从 UserMessage 追加成功后才算被接受；锁保持到 `RunFinishedRecord` 已刷新、`run_end` 已同步发布且活动资源已收口，之后释放。
- 加载时逐行校验 Header、Schema、字段、UUID、`seq`、引用顺序、ToolCall 唯一性和 Run 线性关系；未知记录类型、工作区不匹配、完整坏行、中间坏行或断裂引用直接拒绝打开。
- 仅“文件末尾没有换行且 JSON 语法不完整”的最后一段可以截断到前一个完整换行；已经换行结束的无效尾行仍然是损坏。
- 最后一个 Run 缺少 `RunFinishedRecord` 时，在同一独占锁内按 ToolCall 顺序追加恢复记录：已有开始记录但无结果者补 `unknown`，没有开始记录且无结果者补 `aborted`，最后追加 `interrupted` RunFinishedRecord。
- 恢复生成的 `interrupted` RunFinishedRecord 使用 `metricsStatus: "incomplete"`；无法从持久记录精确还原的 `modelRequestCount` 与 `activeDurationMilliseconds` 为 `null`，`toolCallCount` 从已持久化 Assistant ToolCall 准确计算。正常终结使用 `metricsStatus: "complete"` 和非负整数计量。
- 恢复只追加事实，不重写旧记录、不恢复模型流、不执行 Tool，也不自动重试文件或命令。

### 3.5 Agent Interface 与生命周期

Agent 的公开行为固定为：

- 只读 `state`；
- `prompt(promptText)`；
- `abort()`；
- `respondToToolApproval(toolApprovalRequestId, decision)`；
- `subscribe(listener)`。

`respondToToolApproval` 同步返回：

- `{ status: "accepted" }`：当前请求标识匹配，并已接受 `approve` 或 `deny`；
- `{ status: "rejected", reason: "not_pending" | "request_mismatch" }`：当前没有待确认请求，或标识不匹配。

该行为只解决当前等待，不直接调用 Tool。重复响应在请求清除后返回 `not_pending`；另一个请求活动时提交旧标识返回 `request_mismatch`。

`AgentState` 包含 `sessionId`、已结束消息、活动 AssistantMessage、`activeRun`、`lastError` 和 `pendingToolApproval`。`activeRun` 保存 `runId`、`requesting_model | awaiting_tool_approval | executing_tool`、预算用量和开始时间；如保留 `running`，只能由 `activeRun !== null` 派生。

Feature 001 的 `agent_start` / `agent_end` 更名为 `run_start` / `run_end`。最终事件集合为：

- `run_start`、`run_end`；
- `message_start`、`message_update`、`message_end`；
- `tool_approval_requested`、`tool_approval_resolved`；
- `tool_execution_start`、`tool_execution_update`、`tool_execution_end`。

所有事件同步有序发布。`activeRun` 必须保持到 `run_end` 已交付，监听器异常继续被隔离；TUI 只按事件呈现。

Prompt 拒绝原因在原有 `empty | busy` 基础上增加 `session_busy | session_changed`。已接受 Run 的最终结果为 `completed | aborted | failed | budget_exhausted`；`interrupted` 只由重启恢复写入历史，不作为当前 `prompt()` 的返回值。

## 4. Stage 01：线性 Session 存储

### 4.1 目标

在不引入 Tool 执行的前提下，把 Feature 001 的内存纯文本 Run 接到真实 JSONL Session，使新建、重开、中断恢复、独占写入和继续对话先成为一个可独立验证的闭环。

### 4.2 实施内容

1. 在 `apps/agent` 内建立一个深 Session Module，集中持有 Schema 1 解析、语义校验、路径解析、独占锁、追加刷新、投影和恢复；不从 package 入口导出 Record 或 Writer。
2. 把生产 Agent 启动改为异步：规范化 workspace root，解析本地 Session 目录，新建或按 `sessionId` 打开文件，完成恢复后再返回 Agent。
3. 将当前纯文本 Message 改为能够稳定序列化的消息形状，为 Assistant content part 和 ToolResultMessage 保留已由 Spec 定义的真实类型；Stage 01 的模型响应仍只产生文本 part，不提供 Tool 定义。
4. 将当前 `activeGeneration` 收敛为 Run 所有权，并完成 `run_start` / `run_end` 更名；本阶段活动阶段只实际进入 `requesting_model`。
5. 每次已接受提示词依序刷新 UserMessage、最终 AssistantMessage 和 RunFinishedRecord；completed、aborted、failed 都使用同一终结路径，保留既有部分文本语义。
6. 在打开 Session 时执行尾部截断、未完成 Run 补齐和线性投影；恢复结束前不允许提交新提示词。
7. 使用每 Run 独占锁和文件检查点防止并发进程静默合并；正常、失败和停止都关闭追加句柄并释放本 Run 的锁。
8. 在 `apps/tui` 使用 Node `parseArgs` 支持无参数新建和 `--session <sessionId>` 重开，展示 Session 与 workspace；配置或 Session 错误继续以安全文本和非零退出码结束。
9. 更新既有 Agent/TUI 测试到新事件名和异步工厂，但不借 Stage 01 提前加入 Tool fake、确认 UI 或多次模型请求。

### 4.3 验证

Stage 01 只增加高价值边界测试：

1. 新建文件只有一个 Header，随后记录具有连续 `seq`、稳定 ID 和换行终止；
2. 完成、失败和停止的纯文本 Run 以正确顺序落盘，重开后状态与模型上下文来自同一投影；
3. workspace 不匹配、重复 ID、错序引用、中间坏行和完整坏尾行拒绝打开；仅未完成 JSON 尾段被精确截断；
4. 三种未完成 Run 分别恢复为 interrupted，并正确补齐 aborted 或 unknown ToolResult，不执行任何本地副作用；
5. 活锁拒绝第二个写者，死锁可安全回收，外部追加导致既有 Agent 返回 session_changed；
6. CLI 可以创建并按 ID 重开，未知参数、无效 ID、损坏 Session 和配置错误使用安全退出；
7. Feature 001 的流式、多轮、busy、取消、失败恢复、订阅和退出行为没有回归。

### 4.4 Stage 01 完成门

- 通过 Session 定向测试、现有 Agent/TUI 回归和 `pnpm verify`；
- 在测试临时目录中检查实际 JSONL 文本，不在 Anthias 仓库或开发者其他仓库创建 Session；
- 汇报 Schema、恢复结果、锁行为、命令与结果、未验证项和 Git 状态；
- 不创建 Tool 实现，不调用真实 Provider；Stage 01 已完成、汇报并提交，后续按本次整项授权进入 Stage 02。

## 5. Stage 02：Tool 系统接入与 Agent Loop 改造

### 5.1 目标

在 Stage 01 已验证的 Session 事实上建立六个固定 Tool、逐次人工确认和多模型请求循环，使一条用户提示词能够完成“检查 → 修改 → 验证 → 总结”，同时保持 Agent、TUI、Model Adapter 与 Session 的职责边界。

### 5.2 内部 Model Adapter

用结构化 Model Adapter 取代字符串 Model Stream。一次 Adapter 调用严格对应一次远端模型请求，输入包含系统提示词、完成消息投影、六个 Tool 定义和 Run 根 AbortSignal；输出只包含 Agent 自有的内部事件：

- `text_delta`：Assistant 文本增量；
- `tool_call`：完整 `toolCallId`、`toolName`、最终输入和 `invalid` 标记；
- `finish`：规范化 finish reason 与本次 usage。

生产 Adapter 继续使用 `streamText`，但 Tool 定义不提供 `execute`，不使用 AI SDK ToolLoopAgent、多步循环或 Tool approval。Adapter 从 `fullStream` 转换 `text-delta`、完整 `tool-call`、`finish` 和 `error`，并保持 `maxRetries: 0`。AI SDK 的无效或未知 ToolCall 只要已经包含调用标识，就转换成 `invalid` ToolCall 交给 Agent 生成 failed ToolResult；原始 SDK 异常不得进入公开消息或终端。

工具说明使用现有 AI SDK 的 JSON Schema 能力提供给模型；Agent 仍用项目自己的运行时解析器验证最终 `unknown` 输入。Provider、AI SDK Tool、ModelMessage、LanguageModelUsage 和流 part 类型不从 package 入口导出。

Agent Module 在每次模型请求前重建 Coding Agent 系统提示词，至少写明规范化 workspace root、当前平台、Session 固定 Shell、六个 Tool 及其确认规则、先检查再修改、优先使用文件 Tool、修改后执行相关验证和如实报告失败。系统提示词与 Tool 定义不写入 JSONL，也不由 TUI 拼装。

Session 消息投影在 Model Adapter 边界内转换为 Provider 所需的 user、assistant 和 tool message；Assistant ToolCall 与 ToolResult 必须保留原 `toolCallId`。完成消息是唯一上下文来源，不把 AgentEvent、ToolExecutionStartedRecord、确认 UI 或安全错误发送给模型。

### 5.3 固定 Tool 合同

Stage 02 建立文件 Tool 前，先把生产 Session 默认目录迁移到 `<workspaceRoot>/data/conversation`，创建目录内本地 `.gitignore`，并把解析后的 Session 目录加入文件 Tool 的统一保留路径判断。路径比较必须覆盖规范化路径、真实路径和平台大小写语义；默认 Glob 与 Grep 也不能把保留目录纳入候选集合。

| Tool | 输入 | 准备与执行 |
| --- | --- | --- |
| `read_file` | `path`、可选 `startLine`、可选 `lineCount` | 默认从第 1 行读取 200 行，单次最多 2,000 行；严格 UTF-8，返回范围、总行数或继续位置 |
| `glob` | `pattern`、可选 `path` | 使用 Node.js 24 `fs.promises.glob` 从工作区内发现路径，规范化为相对路径并稳定排序 |
| `grep` | `pattern`、可选 `path`、可选 `filePattern`、可选 `contextLines` | 使用 JavaScript Unicode 正则流式搜索 UTF-8 文本；上下文默认 0、最多 10 行，返回路径、行号和文本 |
| `edit_file` | `path`、`replacements[{ oldText, newText }]` | 在同一原始快照中验证每个 `oldText` 唯一且替换范围不重叠，计算统一 Diff，批准后原子替换 |
| `write_file` | `path`、`content` | 区分创建与覆盖，展示完整内容或统一 Diff，批准后以同目录临时文件、刷新和原子 rename 生效 |
| `execute_command` | `command`、可选 `cwd`、可选 `timeoutMs` | 展示固定 Shell、规范化 cwd、完整命令和有效超时，批准后启动一次性非交互子进程 |

共同约束：

- 所有路径参数使用 workspace 相对路径。已有目标通过真实路径校验仍在 workspace 内；创建目标通过最近已有父目录的真实路径校验，拒绝绝对路径、`..` 逃逸和指向工作区外的符号链接或 reparse point。
- `read_file` 遇到二进制或非法 UTF-8 失败；`grep` 跳过这类文件并在结果中报告跳过数量，不把“有跳过”表述为全量搜索结论。
- `glob` 和 `grep` 不擅自实现 `.gitignore`、隐藏文件或第三方 ignore 语义；模型必须通过输入模式限定范围，结果达到预算后停止并标记截断。
- `edit_file` 与覆盖型 `write_file` 的预览保存目标内容 SHA-256；新建型 `write_file` 保存“不存在”状态。批准后重新校验，状态变化返回 stale target，不写文件。
- `edit_file` 的每个 `oldText` 必须非空；`write_file` 只创建或替换目标文件，父目录必须已经存在，不隐式创建目录或其他文件。
- 确认预览使用与 ToolResult 相同的 64 KiB / 2,000 行上限，但预览不允许截断后继续批准；超限直接产生 failed ToolResult，要求模型缩小修改。命令文本也必须完整落入该确认上限。
- 文件写入先在目标真实父目录创建唯一临时文件，写入 UTF-8、`sync`、关闭后 rename；失败时清理自己的临时文件，不删除或回滚开发者的其他文件。
- ToolResult 使用统一有界文本收集器，按 UTF-8 字节数和行数先到者截断，不拆分字符；结果明确包含实际范围、退出或失败原因以及 `truncated`。

### 5.4 Shell 与命令进程

- SessionHeader 在创建时固定 Shell 描述。Windows 使用 `pwsh -NoLogo -NoProfile -NonInteractive -Command`；非 Windows 优先使用可执行的绝对 `$SHELL`，否则使用 `/bin/sh -lc`。重开时当前平台无法提供已记录 Shell，则拒绝启用该 Session，不能静默换 Shell。
- `cwd` 默认为 workspace root，只能解析到 workspace 内的目录；这只是起始目录限制，不把命令描述为沙箱。
- `timeoutMs` 默认 120,000，最小 1,000，最大 1,800,000；Run 剩余活动时长更短时，以 Run 剩余预算为有效上限，并在确认中显示最终数值。
- 使用 `spawn` 直接启动固定 Shell，不使用 Node 的隐式 `shell: true`；Windows 设置隐藏窗口。每个 ToolCall 新建进程，不继承上一次 Shell 状态。
- 子进程环境从宿主环境复制后，按大小写不敏感方式移除 `ANTHIAS_MODEL_API_KEY`；命令、事件、结果和 JSONL 都不得补写该值。
- stdout 与 stderr 分别读取，并按 Node 观察到的 chunk 顺序形成带来源的有界输出；达到展示预算后继续排空管道但不继续积累内存。
- 用户停止、命令超时或 Run 活动时长耗尽时：Windows 使用 `taskkill /PID <pid> /T /F` 尽力结束进程树，POSIX 使用独立进程组信号并在宽限后升级；所有流、计时器和监听器随后关闭。
- 如果无法证明后代进程已经结束，ToolResult 和 `tool_execution_end` 必须标记 `cleanupUncertain: true`，不能把“已经发出终止请求”写成“全部进程已释放”。

### 5.5 Agent Loop 顺序

一次已接受 Run 使用以下唯一循环：

1. 取得 Session 锁、核对文件检查点、创建 `runId`，追加 UserMessage，发布 `run_start` 和 User 消息事件；
2. 检查模型请求与活动时长预算，进入 `requesting_model`，累计一次模型请求；
3. 流式形成一个 AssistantMessage，只发布文本 delta；收到完整 ToolCall 和 finish 后完成 AssistantMessage，并在任何 Tool 处理前追加刷新；
4. finish reason 为 `stop` 且没有 ToolCall 时 completed；`tool_calls` 却没有完整 ToolCall、`length`、`content_filter`、`error`、无法解释的 reason 或不完整 Tool 输入使 Run failed，已形成但不再执行的 ToolCall 补 aborted ToolResult；
5. 按 AssistantMessage 中的顺序逐个处理完整 ToolCall。未知名称、无效输入和预览失败直接追加 failed ToolResult，不请求确认；
6. `read_file`、`glob`、`grep` 进入 `executing_tool` 并自动执行；发布 Tool 执行事件，终结后追加 ToolResult；
7. `edit_file`、`write_file`、`execute_command` 完成无副作用预检后进入 `awaiting_tool_approval`，发布唯一确认请求并暂停活动时长计时；
8. deny 只发布确认解决事件并追加 denied ToolResult；approve 先追加刷新 ToolExecutionStartedRecord，再进入 `executing_tool` 执行已经展示的准确调用；
9. 同一 AssistantMessage 的全部 ToolCall 都得到 ToolResult 后，回到步骤 2 发起下一次模型请求；
10. completed、aborted、failed 或 budget_exhausted 通过同一个终结归约器补齐未决 ToolResult、追加 RunFinishedRecord、发布一次 `run_end`、释放锁和资源，再恢复 idle。

确认等待使用 Agent 内部的单个待决 Promise，由 `activeRun` 持有。批准、拒绝、用户停止、退出和内部失败竞争时只允许第一个终态生效；晚到确认、模型 part、Tool 输出或进程事件全部忽略。

事件顺序与持久事实保持同一因果方向：最终 AssistantMessage 先持久化再发布 `message_end`；副作用开始记录先刷新再发布 `tool_execution_start` 和执行本地效果；ToolResult 先终结并持久化，再发布 `tool_execution_end` 和对应的消息结束事件。AgentEvent 本身不落盘，命令实时输出更新是唯一允许先于最终 ToolResult 持久化的观察事件。

### 5.6 资源预算

Run 在接受 UserMessage 时固定四个独立预算，不创建统一 step 变量：

- 最多 12 次模型请求；
- 最多执行或处理 32 个 ToolCall，无效、未知、失败和拒绝同样占用；
- 最多 30 分钟活动执行时间，只累计 `requesting_model` 与 `executing_tool`；
- 单个模型可见 ToolResult 最多 64 KiB 或 2,000 行。

第 13 次模型请求永远不会发起。第 33 个及其后的已形成 ToolCall 不执行，逐个补 failed ToolResult 并使 Run 以 `budget_exhausted` 收口；RunFinishedRecord 同时保存模型实际产生的 ToolCall 数和实际处理数，避免模型一次返回超额调用时丢失事实。活动时长在进入确认等待时暂停，在离开时恢复，并用当前阶段 AbortController 的预算计时器中止超时操作。

`budget_exhausted` 必须携带 `model_requests | tool_calls | active_duration` 和实际用量。ToolResult 自身的 64 KiB / 2,000 行只是结果截断，不单独终止 Run；模型可以缩小请求继续。

### 5.7 TUI 交互

- TUI 从 AgentEvent 展示 Run、Assistant 文本、Tool 名、执行状态、有界输出和最终结果，不读取 Tool 内部对象。
- 收到 `tool_approval_requested` 后展示目标、完整有界预览和 `允许执行？[y/N]`。等待期间，`y` / `yes` 解释为 approve，`n` / `no` 或空行解释为 deny；其他输入提示重新选择，不作为新 prompt。
- `/exit`、EOF 始终优先进入退出收口；activeRun 中的 Ctrl+C 调用 `abort()`，包括等待确认和命令执行阶段。空闲 Ctrl+C 退出。
- 等待确认、模型请求或 Tool 执行期间的普通新提示词仍返回或显示 busy，不排队。
- `session_busy`、`session_changed`、stale target、Tool 失败、非零命令退出、预算耗尽和清理不确定都使用明确、可安全展示的不同文案。

### 5.8 验证

Stage 02 的自动化验证以 Agent 公共 Interface 为主，使用确定性 Model Adapter、临时 workspace、临时 Session 目录和短时本地子进程：

1. `glob → grep → read_file → final` 无确认完成，模型上下文与消息顺序正确；
2. `edit_file`、新建/覆盖 `write_file` 在批准前不改变文件，批准后准确生效，拒绝和陈旧预览不生效；
3. 每次 `execute_command` 都确认，成功、非零退出、stdout/stderr 截断、超时、停止和进程树回收结果准确；
4. 未知 Tool、非法 JSON、Schema 错误和超限预览形成 failed ToolResult，模型可在下一次请求修正；
5. 多 Tool 串行、多次模型请求、逐次确认和最终回答形成一个 Run，第二条 prompt 仍被 busy 拒绝；
6. 分别从请求模型、等待确认和执行 Tool 阶段停止，只产生一个 aborted 终态并补齐所有 ToolResult；
7. 三类 Run 预算和 ToolResult 截断按各自单位触发，确认等待不计入活动时长；
8. 本地 loopback OpenAI-compatible 流证明文本、有效/无效 ToolCall、finish reason、usage、取消和一次 Adapter 调用一次 HTTP 请求；
9. TUI fake 只通过 Agent Interface 完成批准、拒绝、停止、错误呈现和退出，不导入内部 Model Adapter、Tool 或 Session 类型。

### 5.9 Stage 02 完成门

- Stage 01 全部验证继续通过；
- 六个 Tool 和完整 Tool Loop 的定向验证、TUI 验证及 `pnpm verify` 通过；
- 依赖只有必要的 `diff@9.0.0` 增量，lockfile 与 manifest 一致；若本地 pnpm store 没有该包，安装前单独取得外部网络授权；
- 不调用真实 Provider、不读取真实凭据、不在开发者仓库执行 Tool；
- 汇报事件顺序、确认边界、持久化先后、取消与进程回收证据并提交 Stage 02 后，按本次整项授权进入 Stage 03。

## 6. Stage 03：整体集成与验收准备

### 6.1 目标与方法

Stage 03 不再增加产品能力。它冻结 Stage 02 的公开合同，在全新临时 workspace 和 Session 目录中组合真实 Session Module、固定 Tool、Agent Loop、生产 Adapter 的本地 HTTP 替身以及 TUI 进程入口，逐项执行 Spec 验收标准 A–N。发现缺陷时只修复已经确认的合同；需要改变语义、接口、Schema 或范围则停止并回到讨论。

### 6.2 验收矩阵

| Spec | 整体证据 |
| --- | --- |
| A 只读编码检查 | 确定性模型连续调用 `glob`、`grep`、`read_file` 后给出最终回答 |
| B–D 文件副作用 | 精确编辑、陈旧预览、创建、覆盖、批准前后文件快照与 JSONL 顺序 |
| E 命令 | 每次确认、真实 PowerShell 7 子进程、非零退出、输出边界与凭据环境隔离 |
| F 人工拒绝 | 无开始记录、无本地副作用、denied ToolResult、陈旧响应拒绝 |
| G 完整循环 | 读取、编辑、命令验证、最终总结在一个 Run 内串行完成 |
| H 无效调用 | 未知 Tool、非法输入与 Schema 错误无副作用并可由模型修正 |
| I 分阶段停止 | 模型、确认、命令三个阶段分别停止，终态唯一且资源收口 |
| J 预算 | 12 次模型请求、32 个 ToolCall、30 分钟活动时长的可控时钟测试及结果截断 |
| K 保存重载 | 完整 JSONL、稳定 ID、消息投影一致并能继续下一 Run |
| L 中断恢复 | 未开始副作用为 aborted，已开始无结果为 unknown，旧 Run interrupted 且不重放 |
| M 职责 | package 公开面、依赖方向和真实 TUI fake 证明内部 seam 未泄漏 |
| N 干净退出 | idle、模型、确认、命令四种退出均无 Agent 持有的句柄、计时器、锁或子进程 |

所有项目使用 `PASS | FAIL | BLOCKED | WAIVED` 记录；`WAIVED` 必须由开发者明确接受，不能由执行 Agent 用“环境原因”自行跳过。任一核心项 FAIL 时 Feature 不得标记已实现。

### 6.3 最终验证

1. 在干净临时目录创建小型 Git 无关工作区，使用固定 UTF-8 文件和确定性命令完成 A–N；
2. 使用本机 loopback HTTP 服务驱动生产 OpenAI-compatible Adapter，不访问外网；服务只在测试生命周期内启动并由测试关闭，不保留后台进程；
3. 使用伪 API Key 验证子进程环境和所有输出均不包含 `ANTHIAS_MODEL_API_KEY`；不读取开发者真实环境值；
4. 运行格式、Strict TypeScript、全部测试和构建门禁；
5. 检查 JSONL 原文、Session 锁目录、临时文件、子进程和监听器在测试结束后均已收口；
6. 创建唯一 `report.md`，按已经成立的用户行为、调用链、资源边界、验证矩阵、未验证项和 Git 状态汇报；
7. 将 Spec 与 Plan 标记为“已实现”只能发生在实现和全部约定验证完成后；Report 保持“已实现”等待开发者最终验收。

### 6.4 Stage 03 完成门

- Spec A–N 没有未解释的 FAIL；任何 BLOCKED 或 WAIVED 都有明确证据和开发者决定；
- `pnpm verify` 与定向进程/恢复测试通过，临时资源检查通过；
- 未调用真实 Provider、外部网络或付费 API，未触碰开发者真实项目文件；
- 完成 Report、变更范围汇报和最终提交后停止，等待开发者验收；推送和 PR 仍需独立授权。

## 7. 验证命令

实际文件名可以在不改变测试层级的前提下由实现调整；每个 Stage 至少运行对应命令：

```powershell
# Stage 01
pnpm exec vitest run apps/agent/test/session.test.ts apps/agent/test/agent.test.ts apps/tui/test/main.test.ts apps/tui/test/tui.test.ts
pnpm verify

# Stage 02
pnpm exec vitest run apps/agent/test/tools.test.ts apps/agent/test/tool-loop.test.ts apps/agent/test/openai-compatible-model.test.ts apps/tui/test/tui.test.ts
pnpm verify

# Stage 03
pnpm verify
```

Stage 02 首次加入依赖时由实施 Agent 更新 manifest 与 lockfile；之后必须以 `pnpm install --frozen-lockfile --offline` 证明锁文件可复现。测试不得依赖联网、真实 Provider、真实凭据、Git 命令或长驻后台服务。

## 8. 主要风险与停止条件

主要风险：

- JSONL 写入、恢复补录和 Run 终结顺序不一致，可能导致重启后重复副作用；
- Windows PID 复用或无法判断进程存活时，安全策略可能阻止打开 Session；此时宁可明确失败，也不能猜测锁已失效；
- 文件符号链接、reparse point 或外部改写可能使预览与目标错位；必须使用真实路径、指纹和执行前复核；
- Windows 命令进程树不一定能被完全确认终止，必须保留 cleanup uncertain 结果；
- AI SDK 或 Provider 可能以不同 finish reason 表达 ToolCall；本地 Adapter 测试只能证明已锁定 SDK 与测试 Provider 的转换，不代表所有真实 Provider；
- TUI 行输入与待确认 Promise 可能发生退出、Ctrl+C 和批准竞争，必须保持 Agent 唯一终态；
- Diff 计算和大输出可能消耗过多内存；确认预览超限失败，ToolResult 统一截断，不引入 Blob 存储；
- `diff@9.0.0` 已在开发者单独授权后完成下载和锁定；任何其他新依赖或外部网络访问仍需重新授权。

出现以下情况时当前 Stage 立即停止：

- 需要改变 Spec 的确认范围、Session 恢复语义、公开 Agent Interface、JSONL Schema 或资源预算；
- 无法在副作用发生前可靠刷新 ToolExecutionStartedRecord；
- 无法阻止两个进程在同一历史检查点静默追加；
- 文件 Tool 无法在当前 Node 能力内保持工作区边界、原子写入或 stale target 保护；
- 命令取消只能留下无法表达或无法回收的 Agent 自有资源；
- 需要把 AI SDK 自动 Tool Loop、Tool execute callback 或 Provider 类型暴露给 Agent/TUI；
- 需要新增沙箱、PTY、后台服务、Tool Registry、分叉、Compaction 或其他范围外能力；
- 需要真实模型、外部网络、敏感凭据或开发者仓库副作用才能完成默认验证；
- 与开发者现有修改发生无法安全解决的重叠。

## 9. 汇报与授权边界

每个 Stage 的实施报告必须说明：完成的用户行为、主要调用链、JSONL 与副作用顺序、确认/取消/资源释放边界、实际验证命令和结果、未验证项以及 Git 状态。相同代码版本和环境已有可信结果时不重复验证，只补当前 Stage 新增的证据缺口。

- 本 Plan 已由开发者确认；实现与 A–N 本地门禁完成后状态已更新为“已实现”，继续等待开发者验收。
- 开发者已确认唯一 Tasks，并明确授权 Feature 002 全部 Stage 的本地实施、逐 Stage 提交和最终提交。
- Stage 01 与 Stage 02 已完成并分别提交；Stage 03 完成后创建最终提交。除已授权的 `diff@9.0.0` 下载外，其他外部网络、真实 Provider、真实凭据、推送和 PR 继续分别取得授权。
