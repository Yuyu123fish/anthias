# Feature 002：基础 Tool Loop 与线性 Session 任务

状态：实施中

- 文档类型：Tasks
- 对应 Spec：[spec.md](spec.md)
- 对应 Plan：[plan.md](plan.md)
- 实施授权：已获得，仅限 Stage 01（T001–T003）

本文件是 Feature 002 实施进度的唯一任务事实源。任务按依赖 DAG 推进，每项都必须在一个独立 Agent 上下文内形成可验证增量，不增加 Spec 与 Plan 之外的行为。

## 任务规则

- `Blocked by` 中的任务全部完成后，当前任务才可开始；没有依赖不代表已经获得实施授权。
- 每个任务的交付与验收必须一起完成，不把测试、TUI、持久化或资源收口留给未声明的后续补丁。
- 实施 Agent 只运行当前任务列出的定向验证；Stage 门禁任务负责运行该 Stage 的完整回归，避免在同一代码版本上重复执行相同命令。
- 普通实现缺陷由当前任务内修复。需要改变产品语义、Agent 公开 Interface、JSONL Schema、模块职责、资源预算或 Stage 边界时立即停止并回到讨论。
- T003、T009 和 T012 是 Stage 门禁。对应任务完成并汇报后必须停止，等待开发者审查和下一 Stage 的独立授权。
- 真实 Provider、外部网络、真实凭据、开发者仓库副作用、提交、推送和 PR 均不在任何任务的默认授权内。

## 进度总览

| Stage | Tasks | 当前状态 | 完成门 |
| --- | --- | --- | --- |
| Stage 01：线性 Session 存储 | T001–T003 | 已完成：等待开发者审查 | T003 完成并经开发者审查 |
| Stage 02：Tool 系统接入与 Agent Loop 改造 | T004–T009 | 未开始 | T009 完成并经开发者审查 |
| Stage 03：整体集成与验收准备 | T010–T012 | 未开始 | T012 完成，等待开发者验收 |

## Stage 01：线性 Session 存储

### T001：交付可新建和重开的文本 Session 闭环

状态：已完成

Blocked by：无

交付：

- 在 `apps/agent` 内建立不从 package 入口导出的 Session Module，实现 Schema 1 Header、MessageRecord、RunFinishedRecord、UUID、连续 `seq` 和 UTC 时间戳；
- 按 Plan 解析 workspace root、可配置 Session 目录和固定 Shell，新建 `<sessionId>.jsonl`，并能按 UUID `sessionId` 打开同一 workspace 的已有 Session；生产默认目录迁移与文件 Tool 隔离留在 T005 同步完成；
- 将生产 Agent 工厂改为异步，`AgentState` 增加 `sessionId`，把现有纯文本 UserMessage、最终 AssistantMessage 和 completed / aborted / failed RunFinishedRecord 串行追加并刷新；
- 将 `activeGeneration` 收敛为文本 Run 所有权，把 `agent_start` / `agent_end` 迁移为 `run_start` / `run_end`，保持 activeRun 到终态事件交付完成；
- 让重开后的消息投影同时驱动 AgentState、TUI 历史展示和下一轮模型上下文；
- 在 TUI 入口支持无参数新建和 `--session <sessionId>` 重开，展示 Session 与 workspace，并同步现有 Agent/TUI fake 与测试。

验收：

- [x] 新建 Session 的首行只有合法 SessionHeader，后续记录从 `seq = 1` 连续递增、每行 JSON 完整且以换行结束；
- [x] 一次文本 Run 的 UserMessage、最终 AssistantMessage 和 RunFinishedRecord 顺序与实际事件一致；
- [x] 重新打开后，历史状态、TUI 展示和下一次模型输入来自同一持久投影；
- [x] workspace 不匹配、无效 Session ID 和未知 CLI 参数安全失败并返回非零退出码；
- [x] completed、aborted、failed 的部分文本、唯一终态、busy 和继续对话语义没有回归；
- [x] 本任务没有 Tool 定义、Tool 执行、确认 UI 或多模型请求循环；
- [x] Session 定向测试及受影响的 Agent/TUI 测试通过，未访问真实 Provider、外部网络或真实凭据。

### T002：补齐 Session 损坏恢复与独占写入保护

状态：已完成

Blocked by：T001

交付：

- 对 Header、Schema、字段、UUID、`seq`、Run 顺序、ToolCall 引用和记录类型执行完整运行时校验；
- 只截断“最后一段没有换行且 JSON 语法不完整”的尾部，完整坏尾行、中间坏行和断裂引用全部拒绝打开；
- 对缺少 RunFinishedRecord 的最后一个 Run 追加恢复事实：未开始 ToolCall 为 aborted、已有 ToolExecutionStartedRecord 无结果为 unknown，最后写入 interrupted；
- interrupted 记录使用不完整计量：无法精确还原的模型请求数和活动执行时长为 `null`，ToolCall 数按持久事实计算，不伪造精确值；
- 用原子 `<sessionId>.lock` 目录、PID、owner token 和文件检查点阻止并发写者；只回收能够确认 PID 已不存在的残留锁；
- 新 prompt 在取得锁后核对文件大小和最后 `seq`，分别以 `session_busy` 或 `session_changed` 拒绝竞争写入和外部尾部变化；
- 确保打开恢复和每个 Run 的句柄、锁及临时状态在成功、失败和停止路径全部释放。

验收：

- [x] 重复 ID、错序 `seq`、跨 Run 错误引用、完整坏行和 workspace 不匹配均硬失败，不跳过后继续；
- [x] 唯一可恢复的残缺尾段被精确截断到上一条完整记录，旧记录字节保持不变；
- [x] requesting_model、awaiting_tool_approval 和副作用开始后中断的夹具分别恢复为 interrupted，并补出正确的 aborted / unknown ToolResult；
- [x] interrupted 的计量明确标记为 incomplete，未知值保持 `null`，正常终态仍保存完整非负整数计量；
- [x] 恢复不发起模型请求、不执行 Tool、不重试文件或命令，只向同一 JSONL 追加事实；
- [x] 活锁阻止第二写者，确定死亡的残留锁可回收，owner token 不匹配时不会误删锁；
- [x] 外部追加使旧 Agent 返回 session_changed，既有消息和文件尾部不被静默合并；
- [x] Session 损坏、恢复和锁定向测试通过，所有夹具只使用测试临时目录。

### T003：完成 Stage 01 门禁与检查点汇报

状态：已完成

Blocked by：T001、T002

交付：

- 运行 Stage 01 Session、Agent、TUI 定向验证和完整 `pnpm verify`；
- 直接检查测试产生的 JSONL、锁目录和重开后的模型上下文，确认实现证据不是只来自 mock 断言；
- 审查 package 公开面和依赖方向，确认 Session Record、Writer、锁与 Model Stream 未从 `@anthias/agent` 入口泄漏；
- 更新本文件中 T001–T003 的真实状态并汇报 Stage 01 已完成行为、未完成范围、验证命令、结果、资源边界和 Git 状态。

验收：

- [x] Plan 约定的 Stage 01 定向测试全部通过；
- [x] `pnpm verify` 通过 Biome、Strict TypeScript、测试和构建；
- [x] 实际 JSONL 证明新建、完成、重开、截尾和中断恢复的顺序与 Schema 1 一致；
- [x] 没有新增六个 Tool、确认 Interface、Tool Loop、`diff` 依赖或 Stage 02 行为；
- [x] 未在 Anthias 或开发者其他仓库写入运行 Session，未调用真实 Provider 或外部网络；
- [x] 汇报完成后按本次授权提交 Stage 01，没有自动开始 T004、推送或创建 PR。

## Stage 02：Tool 系统接入与 Agent Loop 改造

### T004：Expand 为结构化 Model Adapter

状态：待开始

Blocked by：T003

交付：

- 在 Agent Module 内把字符串 Model Stream 扩展为 `text_delta`、完整 `tool_call` 和带 finish reason / usage 的 `finish` 事件；
- 建立 Agent 自有模型请求与消息投影，保持 User、Assistant ToolCall 和 ToolResult 的 `toolCallId` 关联，不让 AI SDK 类型进入持久消息或 package 入口；
- 由 Agent Module 构建 workspace、平台、固定 Shell、Tool 使用规则和真实报告要求组成的系统提示词；
- 使用 AI SDK JSON Schema 描述 Tool，但不提供 `execute`，不启用 ToolLoopAgent、自动多步、Tool approval 或重试；
- 扩展生产 OpenAI-compatible Adapter 对 `fullStream` 的转换，并让现有文本 Run 在尚未接入 Tool 执行时保持兼容。

验收：

- [ ] 一次 Adapter 调用只建立一次 loopback HTTP 请求，`maxRetries` 仍为 0；
- [ ] 文本、有效 ToolCall、无效/未知 ToolCall、finish reason、usage、error 和取消都被转换为 Agent 内部事件；
- [ ] 已包含调用标识的无效 ToolCall 保留 `toolCallId`，原始 SDK 错误不进入公开消息、TUI 或 JSONL；
- [ ] 系统提示词和 Tool Schema 不写入 Session，不由 TUI 拼装；
- [ ] Provider、AI SDK Tool、ModelMessage、Model Adapter 和内部 usage 类型没有从 `@anthias/agent` 导出；
- [ ] Adapter 定向测试与既有文本 Run 回归通过，本任务未执行任何 Tool。

### T005：交付只读 Tool Loop 垂直切片

状态：待开始

Blocked by：T004

交付：

- 将生产 Session 默认目录迁移为 `<workspaceRoot>/data/conversation`，创建目录内本地 `.gitignore` 且不修改项目根 `.gitignore`；把实际 Session 目录作为文件 Tool 的统一保留路径；
- 以固定映射实现 `read_file`、`glob` 和 `grep` 的 Schema、运行时校验、工作区路径约束、严格 UTF-8 行为、稳定输出和统一 ToolResult 截断；
- 在 Agent 中实现 UserMessage 只追加一次、AssistantMessage 完成持久化、ToolCall 串行处理、ToolResult 持久化并回到下一次模型请求的循环；
- 将 Assistant text / ToolCall part 与 ToolResultMessage 纳入 AgentState、Session 投影和模型上下文，未知 Tool 或无效输入产生 failed ToolResult；
- 加入 `tool_execution_start` / `update` / `end` 和 ToolResult 消息事件，让 TUI 能呈现只读 Tool 及有界结果；
- 从循环建立时就启用 12 次模型请求、32 个 ToolCall、30 分钟活动时长和单结果 64 KiB / 2,000 行预算，避免出现无界中间实现；
- 保持 Tool 串行、单 activeRun、根 AbortSignal 和统一 Run 终结，不暴露 Tool 直接执行入口。

验收：

- [ ] 默认 Session 只写入当前 workspace 的 `data/conversation/<sessionId>.jsonl`，运行目录不进入 Git，项目根 `.gitignore` 不被修改；
- [ ] 三个只读文件 Tool 均不能读取或遍历实际 Session 目录，Glob 与 Grep 的默认结果也不包含该目录；统一保留路径判断可由后续文件修改 Tool 复用，命令 Tool 的无沙箱边界保持明确；
- [ ] 确定性模型按 `glob → grep → read_file → final` 完成一个 Run，三个 Tool 无人工确认且顺序正确；
- [ ] 每条 AssistantMessage 在 Tool 处理前刷新，每个 ToolCall 都有同 ID、同 Tool 名的 ToolResult 并进入下一次模型请求；
- [ ] 二进制/非法 UTF-8、错误正则、越界路径、未知 Tool 和 Schema 错误不产生本地副作用，并允许模型修正；
- [ ] Glob 路径稳定排序，Grep 匹配包含相对路径和行号，所有截断都明确报告未穷尽；
- [ ] 完整循环结束后 Run completed、预算用量正确、Agent 回到 idle 并能接受下一条提示词；
- [ ] TUI 只从 AgentEvent 呈现 Tool，不导入 Tool Schema、执行函数或 Session Record；
- [ ] 只读 Tool、Agent Loop、JSONL 和 TUI 定向测试通过，未加入副作用 Tool。

### T006：交付需确认的文件修改闭环

状态：待开始

Blocked by：T005

交付：

- 在 `apps/agent` 增加唯一直接运行时依赖 `diff@9.0.0` 并同步 lockfile；若本地 pnpm store 不具备该包，停止并单独申请外部网络授权；
- 在 Agent Interface 增加 `respondToToolApproval`，在 AgentState、AgentEvent 与 TUI 中表达唯一待确认请求和批准 / 拒绝输入；
- 实现 `edit_file` 与 `write_file` 的固定 Schema、运行时校验、无副作用预检、统一 Diff 或完整内容预览、目标 SHA-256 / 不存在状态指纹和确认内容上限；
- 复用 T005 的保留路径判断，拒绝对实际 Session 目录执行预检、预览、创建、覆盖或编辑；
- `edit_file` 在同一原始快照中验证非空 `oldText` 唯一且替换范围不重叠；`write_file` 只创建或覆盖目标文件，父目录必须已存在；
- 批准后再次验证目标状态，以同目录临时文件、刷新和原子 rename 生效；状态变化返回 stale target，不隐式建目录；
- 在任何实际文件副作用前持久化并刷新 ToolExecutionStartedRecord；拒绝时只记录 denied ToolResult，不写开始记录。

验收：

- [ ] 确认请求发出后、批准前，目标文件及其父目录没有变化；
- [ ] `edit_file` 与 `write_file` 不能以任何规范化路径或真实路径命中实际 Session 目录；
- [ ] 批准的精确编辑、新建文件和覆盖文件只产生确认内容对应的变化，JSONL 中开始记录先于实际副作用、结果记录晚于副作用；
- [ ] 拒绝不会产生 ToolExecutionStartedRecord 或本地副作用，denied ToolResult 能进入下一次模型请求并允许模型继续；
- [ ] 预览后目标变更会返回 stale target，旧预览不能覆盖外部变化；
- [ ] 超过 64 KiB 或 2,000 行的确认预览直接失败且不进入确认，不能用截断预览取得批准；
- [ ] 过期、重复、ID 不匹配或当前 Run 不匹配的确认响应均被拒绝；
- [ ] 等待确认时停止当前 Run 会产生 aborted ToolResult 和唯一 aborted Run 终态；
- [ ] 文件 Tool、确认、原子写入、Session 顺序和 TUI 定向测试通过，除 `diff@9.0.0` 外未增加运行时依赖。

### T007：交付需确认的一次性命令闭环

状态：待开始

Blocked by：T006

交付：

- 实现 `execute_command` 固定 Schema、工作区内 cwd 规范化、默认 / 最小 / 最大超时和基于 Run 剩余活动预算的有效超时；
- 确认请求完整展示固定 Session Shell、规范化 cwd、完整命令和有效超时，任何命令都逐次等待确认；
- 批准后使用固定 Shell 启动一次性非交互子进程，不使用 `shell: true`，Windows 进程隐藏窗口，并从子进程环境中大小写不敏感地移除 `ANTHIAS_MODEL_API_KEY`；
- 通过有界瞬时事件呈现 stdout / stderr，到 ToolResult 时保留顺序、退出码、执行时长和明确截断信息；JSONL 不逐块保存输出；
- 超时或停止时尽力终止整个进程树、停止接收输出并关闭句柄；不能确认全部后代已结束时标记资源清理不确定；
- 命令完成后不保留 cwd、环境变量、Shell 状态或后台会话，不提供直接命令执行入口。

验收：

- [ ] 包括看似只读的命令在内，每个 `execute_command` 都先进入人工确认；批准前没有创建子进程；
- [ ] 批准后的成功命令和非零退出命令都产生包含退出码、stdout、stderr、时长及截断状态的正确 ToolResult；
- [ ] 子进程环境、ToolResult、事件、JSONL、TUI 与测试快照中均不包含 `ANTHIAS_MODEL_API_KEY`；
- [ ] 超时与用户停止都会终止整棵进程树并关闭相关资源；不能证明清理完成时结果明确标记 cleanup uncertain；
- [ ] 拒绝命令不启动子进程，denied ToolResult 返回模型；
- [ ] 前一命令改变 cwd、环境或 Shell 状态不会影响后一命令，Feature 002 不提供持久 Shell 和后台任务；
- [ ] 命令确认、输出、超时、停止、进程树回收和 TUI 定向测试只在临时 workspace 中通过。

### T008：收口多 Tool、预算、取消与终态竞争

状态：待开始

Blocked by：T007

交付：

- 支持单条 AssistantMessage 中多个 ToolCall 按出现顺序串行处理，并在全部 ToolResult 持久化后发起下一次模型请求；
- 收口“有 ToolCall 则继续、无 ToolCall 则 completed”的循环终止规则，以及未知 Tool、无效参数、拒绝、失败和模型错误的后续行为；
- 精确实施 12 次模型请求、32 个 ToolCall 和 30 分钟活动执行时长三类 Run 预算；活动时长只累计 `requesting_model` 与 `executing_tool`，等待确认不计时；
- 让 `budget_exhausted` 明确携带 `model_requests | tool_calls | active_duration` 和实际用量；单个 ToolResult 的 64 KiB / 2,000 行截断不单独终止 Run；
- 用同一根 AbortSignal 覆盖模型请求、等待确认和 Tool 执行，在停止、预算耗尽、失败和自然完成竞争时只交付一个 RunFinishedRecord 与一个 `run_end`；
- 对终态前尚未产生结果的 ToolCall 补齐 aborted / failed ToolResult，冻结事件与 JSONL 先后，并处理 TUI 退出、确认输入和迟到异步结果的竞争。

验收：

- [ ] 多 Tool、多模型请求循环中 ToolCall 严格串行，每个调用恰有一个同 ID、同 Tool 名的 ToolResult，下一次模型输入完整；
- [ ] 未知、无效、拒绝和失败的 ToolCall 均占用 ToolCall 预算，并按合同允许模型继续；
- [ ] 第 13 次模型请求不会发出，第 33 个 ToolCall 不会执行或请求确认，Run 以对应 budget_exhausted 事实结束；
- [ ] 可控时钟证明 30 分钟只累计模型请求与 Tool 执行时间，等待人工确认不消耗活动预算；
- [ ] 模型停止、确认等待停止、Tool 执行停止、预算耗尽和失败竞态均只有一个终态，迟到确认、输出和模型事件被忽略；
- [ ] JSONL 中 AssistantMessage、ToolExecutionStartedRecord、ToolResultMessage 和 RunFinishedRecord 的顺序符合实际事实；
- [ ] 每条终止路径都回到 idle，释放锁、文件句柄、计时器、模型迭代器和子进程资源；
- [ ] 多 Tool、预算、取消、终态竞争、Session 恢复和 TUI 退出定向测试通过。

### T009：完成 Stage 02 门禁与检查点汇报

状态：待开始

Blocked by：T004、T005、T006、T007、T008

交付：

- 运行 Stage 01 回归、Stage 02 全部定向验证、完整 `pnpm verify` 和离线 frozen-lockfile 安装验证；
- 在全新临时 workspace 中检查文件修改、命令进程、确认边界、预算终止、JSONL 顺序和重开上下文的实际结果；
- 审查 package 公开面、依赖方向、运行时依赖和敏感信息路径，确认首批 Tool 正好六个且 Tool 执行仍由 Agent Module 独占；
- 更新本文件中 T004–T009 的真实状态并汇报 Stage 02 已完成行为、失败边界、验证命令、结果、资源回收和 Git 状态。

验收：

- [ ] Stage 01 回归、Stage 02 定向测试和 `pnpm verify` 全部通过；
- [ ] 现有 lockfile 可执行离线 frozen-lockfile 安装，manifest 只增加已批准的 `diff@9.0.0` 运行时依赖；
- [ ] 实际证据覆盖三个只读 Tool、两个文件 Tool 和一个命令 Tool，确认前无副作用且预算、取消和持久化顺序准确；
- [ ] 真实凭据未进入子进程、ToolResult、AgentEvent、JSONL、TUI、测试快照或报告；
- [ ] 未增加 OS 沙箱、权限策略、会话分叉、多 Agent、后台任务、持久 Shell、自动重试或第二 Model Adapter；
- [ ] 未调用真实 Provider、外部网络或开发者真实仓库副作用；
- [ ] 汇报完成后停止，没有自动开始 T010、提交、推送或创建 PR。

## Stage 03：整体集成与验收准备

### T010：验收 Session 与文件 Tool 矩阵

状态：待开始

Blocked by：T009

交付：

- 冻结 Stage 02 已确认合同，在全新临时 workspace 和 Session 目录中组合真实 Session Module、Agent Loop、固定 Tool、确定性 Model Adapter 与 TUI 入口；
- 逐项执行 Spec 验收矩阵 A、B、C、D、F、H、K、L，保存 JSONL 字节、目标文件快照、确认事件和恢复记录等可复核证据；
- 只修复已确认合同内暴露的缺陷；一旦需要改变产品语义、公开接口、Schema、模块职责、预算或范围，停止并回到讨论；
- 将每一项结果记为 PASS、FAIL 或 BLOCKED，并把失败定位到对应任务和最小修复范围。

验收：

- [ ] A 只读编码检查、B 批准精确编辑、C 陈旧编辑预览、D 创建与覆盖文件均有独立 PASS 证据；
- [ ] F 拒绝副作用、H 参数错误与未知 Tool、K JSONL 保存与重载、L 中断恢复均有独立 PASS 证据；
- [ ] 文件与 Session 证据来自全新临时目录，未依赖 Anthias 工作区中的预置运行数据；
- [ ] 发现的合同内缺陷完成最小修复并通过对应定向回归，没有新增行为或扩大公开接口；
- [ ] T010 涉及的组合测试和定向测试全部通过，无真实 Provider、外部网络或真实凭据。

### T011：验收命令、完整循环、预算与退出矩阵

状态：待开始

Blocked by：T010

交付：

- 使用生产 OpenAI-compatible Adapter 的本地 HTTP 替身、假凭据、真实本地 `pwsh.exe` 和临时 workspace 执行 Spec 验收矩阵 E、G、I、J、N；
- 用受控模型响应与可控时钟覆盖多 Tool、多模型请求、三类预算、确认等待不计时、阶段停止和终态竞争；
- 检查命令成功、非零退出、截断、超时、停止、进程树回收、Session 锁、文件句柄、计时器、HTTP 替身和 TUI 进程的关闭结果；
- 只修复已确认合同内缺陷；需要改变语义、接口、Schema、模块职责、预算或范围时停止并回到讨论。

验收：

- [ ] E 命令确认与失败、G 多 Tool 多模型循环、I 分阶段停止、J 执行预算和 N 干净退出均有独立 PASS 证据；
- [ ] 本地 HTTP 替身证明生产 Adapter 未自动执行 Tool、未自动重试且模型请求次数与循环一致；
- [ ] 真实本地命令只作用于临时 workspace，假凭据不出现在子进程环境或任何持久 / 展示载体；
- [ ] 验证结束后没有遗留子进程、监听端口、Session 锁、临时写入句柄、计时器或后台服务；
- [ ] T011 涉及的组合测试和定向测试全部通过，未访问真实 Provider 或外部网络。

### T012：完成职责审查、全量门禁与实施报告

状态：待开始

Blocked by：T010、T011

交付：

- 执行 Spec 验收矩阵 M，审查 TUI、Agent、Session、Model Adapter 与 Tool 的真实依赖方向、公开面和资源所有权；
- 运行完整 `pnpm verify`，汇总 A–N 为唯一验收矩阵；每项只允许 PASS、FAIL、BLOCKED，WAIVED 必须取得开发者逐项明确授权；
- 新建本 Feature 唯一 `report.md`，记录实现范围、未实现边界、验证环境、命令、结果、JSONL 与文件 / 进程证据、资源回收、敏感信息检查和 Git 状态；
- 只有 A–N 全部通过、门禁通过且文档与代码一致时，才把 Spec、Plan、Tasks、Report 状态更新为“已实现”；“已验收”继续由开发者决定；
- 汇报 Stage 03 后停止，不提交、不推送、不创建 PR。

验收：

- [ ] M 接口与职责有独立 PASS 证据，TUI 只依赖 Agent 公开 Interface，内部类型与执行函数未泄漏；
- [ ] Spec A–N 全部有可复核结果，未留下 FAIL、BLOCKED 或未经开发者授权的 WAIVED；
- [ ] `pnpm verify` 通过，Report 中的验证命令、结果和证明边界与实际一致；
- [ ] `report.md` 是本 Feature 唯一实施报告，没有保存临时日志、测试输出或 Agent 草稿；
- [ ] Feature 文档在满足条件后统一标记为“已实现”，没有擅自标记“已验收”；
- [ ] 最终汇报说明未实现范围、真实 Provider 未验证、未提交状态和后续开发者验收入口。

## 授权与下一步

- 本 Tasks 已由开发者确认，Stage 01（T001–T003）已经实施并完成门禁，当前等待开发者审查；
- T001–T003 均已完成；最终 Session 位置的生产迁移仍按计划留在 Stage 02；
- T003 汇报和本次授权提交后停止，Stage 02 仍需开发者单独授权；
- 外部网络、真实 Provider 验证、Stage 02、推送和创建 PR 继续分别取得授权。
