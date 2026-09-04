# Feature 003：Tool 执行调度与 Windows 安全边界任务

状态：已计划

## 开发者速览

> **一句话**：以 16 个有依赖、可验收的任务连续交付已确认 Plan。<br>
> **核心做法**：四个 Stage 各设门禁；先沙箱 go/no-go，再安全决策、只读并发和生产闭环。<br>
> **边界**：本文件只排任务，不授权代码、下载、UAC、系统修改或 Git 操作。<br>
> **风险 / 未验证**：T001–T003 依赖额外人工授权；沙箱 no-go 会阻断后续全部任务。<br>
> **当前 / 请审阅**：Tasks 已计划；本轮按四个门禁连续实施，外部授权仍单独处理。

- 文档类型：Tasks
- 对应 Spec：[spec.md](spec.md)
- 对应 Plan：[plan.md](plan.md)
- 实施授权：全部 Stage 的代码实施已获得；Stage 01 的依赖下载和 Windows 系统准备还需要分别授权

本文件是 Feature 003 实施进度的唯一任务事实源。任务按依赖 DAG 推进，每项必须能在一个新的 Agent 上下文内完成并验证，不增加 Spec 与 Plan 之外的行为。

## 任务规则

- `Blocked by` 中的任务全部完成后，当前任务才具备技术前置条件；这不替代当前 Stage 的实施授权或标注的外部人工授权。
- T003、T008、T012、T016 是 Stage 门禁。前一门禁通过后才可进入下一 Stage；本轮已有连续实施授权，不在中间门禁重复等待代码授权。
- T004 与 T009 是 Expand 任务：先建立新 seam 并证明旧行为可控，再分别迁移安全决策和并发；Contract 删除旧宿主执行路径在 T014 完成。
- 每个实现任务同时交付行为与定向验证，不把测试、TUI、持久化或资源收口无声明地留给最终门禁。
- 实施 Agent 只运行当前任务列出的定向验证；门禁任务汇总本 Stage 回归。相同代码、环境和命令已有可信结果时不重复运行。
- 危险命令只允许作为纯字符串 fixture 进入 Policy classifier。任何任务都不得把这些文本交给 Shell、系统 API、WSL、容器、VM、服务或计划任务。
- Windows conformance 只使用新建的临时 workspace、Session 目录、外部 sentinel、伪凭据和无害进程；不以系统目录、真实用户数据、Anthias 工作区或其他项目作为攻击目标。
- 需要改变默认 Agent 模式、整批串行规则、公开安全合同、Schema 1、unknown 恢复、模块职责、网络边界或 fail-closed 语义时立即停止，回到 Spec / Plan。
- 下载依赖、UAC、机器级账号 / 组 / ACL / WFP、真实 Provider、外部网络、真实凭据、提交、推送和 PR 都是独立授权，不能从 Tasks 或实施授权推断。
- 工作区已有修改属于开发者；不清理、不重置、不覆盖与当前任务无关的文件。

## 依赖总览

```text
T001 → T002 → T003 [Stage 01 GO]
                     ↓
T004 → T005 → T006 → T007 → T008 [Stage 02]
                                     ↓
T009 → T010 → T011 → T012 [Stage 03]
                              ↓
T013 → T014 → T015 → T016 [Stage 04]
```

| Stage | Tasks | 当前状态 | 完成门 |
| --- | --- | --- | --- |
| Stage 01：Windows 沙箱可行性闸门 | T001–T003 | 待确认与外部授权 | T003 给出 GO，开发者确认后才可进入 Stage 02 |
| Stage 02：Permission Mode、Policy 与路径安全 | T004–T008 | 待开始 | T008 完成并经开发者审查 |
| Stage 03：只读 Tool 有界并发 | T009–T012 | 待开始 | T012 完成并经开发者审查 |
| Stage 04：Windows backend 与整体闭环 | T013–T016 | 待开始 | T016 完成，等待开发者验收 |

## Stage 01：Windows 沙箱可行性闸门

### T001：核对 Windows 前置并取得 Stage 01 外部授权

状态：待开始

Blocked by：无

交付：

- 只读核对当前 Windows、PowerShell 7、Node、pnpm 的版本与真实可执行路径，以及 `srt-sandbox` 账号 / 组、候选安装和 WFP 前置是否已经存在；
- 固定候选为 `@anthropic-ai/sandbox-runtime@0.0.75`，展示包来源、校验信息、临时 spike 位置和实际准备命令；
- 分开描述并申请两项授权：下载精确候选包，以及候选官方 Windows setup 所需的 UAC、账号 / 组和机器级 WFP 变化；
- 展示官方清理 / 卸载能力、测试临时资源清理方式，以及 setup 完成后“保留还是卸载”由开发者决定的边界；
- 明确 T002 只会使用临时 workspace、临时 Session、临时外部 sentinel、伪凭据与无害子进程。

验收：

- [ ] 任何下载、安装、UAC、账号 / 组、ACL 或 WFP 变化发生前，开发者都看到了精确动作和副作用；
- [ ] 下载授权与 Windows 系统准备授权被分别记录，不用一次笼统的实施授权替代；
- [ ] PowerShell、Node 和 pnpm 的候选可读根来自真实路径，不预先决定开放整个用户目录；
- [ ] 未经授权只做只读核对，没有创建临时 spike、修改仓库或改变机器状态；
- [ ] 若任一必要授权未获得，T001 明确标为 BLOCKED 并停止，不开始 T002。

### T002：执行隔离 Windows Sandbox conformance spike

状态：待开始

Blocked by：T001；且精确依赖下载与 Windows 系统准备均已单独授权

交付：

- 在新建系统临时目录中使用候选精确版本，按 Plan 生成 workspace、Session、运行时只读根、私有临时目录、环境 allowlist 和 `allowedDomains: ["*"]` 配置；
- 执行 Plan W01–W10：初始化、自检、workspace 写入、外部 sentinel 拒写、Session 拒绝读写、PowerShell / Node / pnpm、Shell 等价性、子进程、timeout、abort、reset、环境隔离和配置装配；
- 对空格、单双引号、换行、美元符号与中文使用无害文本证明 wrapper 没有改变批准命令语义；
- 对失败路径使用缺失 / 无效前置和受控 fake，不运行任何危险命令，也不尝试逃逸到真实系统资源；
- 清理本次临时目录、进程、代理监听器与 Session 级权限，检查机器级 setup 是否按 T001 的开发者选择保留。

验收：

- [ ] W01–W09 分别得到 PASS / FAIL，不使用未经开发者确认的 WAIVED；W10 至少证明最宽网络配置可以初始化且没有发起外网请求；
- [ ] workspace 内无害文件可创建，临时外部 sentinel 与临时 Session 内容保持不可写 / 不可读；
- [ ] 固定 PowerShell 7、Node 与 pnpm 离线版本命令在不开放整个宿主用户目录时可运行；
- [ ] timeout 与 abort 后无害子进程树完全退出，reset 可重复调用并允许重新初始化；
- [ ] 子进程看不到伪 `ANTHIAS_MODEL_API_KEY`、伪 Provider Token 或未列入 allowlist 的环境变量；
- [ ] 危险 fixture 从未进入 Shell / 系统 API，真实 Provider、真实凭据、外网和开发者业务文件均未访问；
- [ ] 仓库没有新增依赖、源码、临时脚本或日志，本次临时资源全部收口。

### T003：完成 Stage 01 GO / NO-GO 门禁

状态：待开始

Blocked by：T002

交付：

- 汇总 W01–W10 的环境、精确命令、结果和证据限制，并再次检查临时进程、目录、权限与监听器；
- 将结论归约为 `GO` 或 `NO-GO`：只有 W01–W09 全部 PASS、W10 可装配且没有弱化边界时才能 GO；
- 更新 T001–T003 和 Stage 01 的真实状态，说明候选机器级 setup 最终保留或卸载的事实；
- 形成可追溯的 GO / NO-GO 结论；只有 GO 才按本轮授权继续 Stage 02，且不因此自动创建生产依赖。

验收：

- [ ] 每个 conformance 项都有可复核结果，没有用“看起来可用”代替文件、进程和环境证据；
- [ ] GO 结论不依赖 unsandboxed fallback、宽读用户目录、per-command Session ACL 扩权或危险命令试运行；
- [ ] 任一核心项 FAIL 时结论为 NO-GO，T004–T016 保持阻塞并回到 Spec / Plan；
- [ ] Stage 报告包含系统准备保留状态、未验证网络边界和当前 Git 状态；
- [ ] 已形成 GO 并记录证据，才按本轮连续实施授权进入 Stage 02。

## Stage 02：Permission Mode、Policy 与路径安全

### T004：Expand 命令能力 seam 并切断宿主执行回退

状态：待开始

Blocked by：T003；且开发者已确认 Stage 01 GO 并明确授权 Stage 02 实施

交付：

- 在 Agent Module 内建立一个窄的 command sandbox 能力对象，表达 ready / unavailable、执行和关闭所需的最小内部行为；不建立多平台 backend、Registry 或公共 Interface；
- 让 ToolRunner 只通过注入的能力对象执行已准备命令；生产装配在 Stage 04 前固定使用 unavailable，实现安全失败；
- 将现有命令闭环测试迁移到确定性 fake，使批准、输出、失败、timeout 与 cleanup uncertain 可以不启动宿主进程地验证；
- 断开 ToolRunner 到现有 `executePreparedCommand` / host `spawn` 的生产可达路径，同时保留文件 Tool、Session 顺序与 ToolResult 形状；
- 为后续 Contract 删除旧 executor 标注精确调用点，不新增“临时允许无沙箱执行”开关。

验收：

- [ ] command capability unavailable 时，即使调用输入有效也不会出现宿主进程、命令输出或文件副作用；
- [ ] ready fake 只在准确批准后收到一次 prepared command，拒绝与取消时调用次数为零；
- [ ] cleanup uncertain fake 能形成安全结果并阻止同一 fake 生命周期中的后续命令；
- [ ] 从 ToolRunner 生产入口无法到达无沙箱 host `spawn`，且没有环境变量或测试选项能恢复该路径；
- [ ] 现有文件 Tool、Session 与 Agent Loop 定向回归通过，本任务不增加 sandbox-runtime 依赖或公开类型。

### T005：交付 Permission Mode 与动态 Tool 可见性闭环

状态：待开始

Blocked by：T004

交付：

- 增加 `PermissionMode`、AgentState 的 `permissionMode` / `commandSandboxStatus`、模式与沙箱状态事件，以及同步 `setPermissionMode()`；
- 在 Run 接受 UserMessage 时固定模式与命令能力快照，使同一 Run 的所有模型请求使用相同 Tool definitions 和系统 Prompt；
- 用普通函数形成 Plan 三 Tool、Agent + unavailable 五 Tool、Agent + ready 六 Tool 三个固定集合，替换无条件 `FIXED_TOOL_DEFINITIONS`；
- 在 `createAgentFromEnvironment` 和 CLI 增加可组合的 `--mode agent|plan`，保持未指定时默认 Agent 和现有 `--session` 语义；
- 先交付无真实 sandbox 资源时的幂等 `close()`：关闭标记拒绝新 prompt / 模式切换，abort 并等待 activeRun 与 Session lease；Stage 04 再接入 sandbox reset；
- 从 `@anthias/agent` 只导出交互 Adapter 需要的模式、状态和返回类型，不导出 Tool definitions 或测试 fake。

验收：

- [ ] 默认 Agent、显式 Agent / Plan、新建 / 重开 Session 的模式均正确，Permission Mode 不进入 JSONL；
- [ ] 空闲切换成功并只发布一次模式事件；activeRun 中以 busy 拒绝，当前 Run 的 Tool 集合不变化；
- [ ] Plan 模型请求只有三个只读 Tool；Agent + unavailable 没有 `execute_command`；ready fake 下正好六个 Tool；
- [ ] Plan 模式伪造三个副作用 Tool 全部 denied，无 approval、文件执行或 command fake 调用；
- [ ] `--mode` 与 `--session` 可组合，非法模式安全退出；TUI 不自行计算 Tool 可见性；
- [ ] `close()` 可重复等待同一收口，关闭后 prompt 和模式切换以 closed 拒绝，不新增 Session 常驻 close 资源；
- [ ] Permission、启动、Agent 和系统 Prompt 定向测试通过，package 公开面保持最小。

### T006：交付纯 Tool Policy、硬危险拒绝与一次性确认绑定

状态：待开始

Blocked by：T005

交付：

- 在 Agent 内建立不可变 `allow | ask | deny` Policy Decision，携带稳定 ruleId、安全 riskSummary 与真实 executionBoundary；
- 按“Schema / 能力预检 → Permission Mode → 安全分类 → allow / ask”的顺序接入 ToolRunner，区分 failed 与 denied；
- 实现不启动解释器的保守命令扫描器，覆盖 Spec 八条最低规则、Shell wrapper、Windows 系统破坏、远程脚本执行、混淆和逃逸委托类别；
- 对字面量 `pwsh/powershell -Command`、`cmd /c`、`bash/sh -c` 最多递归三层；EncodedCommand、动态求值、超深或无法还原的高风险包装使用 `danger.opaque_command`；
- 扩展 ToolApprovalRequest 的 permissionMode、riskSummary、executionBoundary，并把模式、命令能力和完整准备结果纳入内部 approval 指纹；
- 保持普通 Agent 命令为 ask；hard deny 不创建 pending request，不允许响应接口把 deny 改成执行。

验收：

- [ ] Spec 八条最低规则及大小写、空白、组合参数、绝对 executable 和字面量 wrapper 变体全部返回稳定 hard deny；
- [ ] Windows 磁盘 / 系统破坏、提权、服务、计划任务、WSL、Docker / 容器、VM 和 opaque 类别分别有纯字符串覆盖；
- [ ] 所有危险 fixture 只进入纯 classifier；spy 证明 approval、sandbox fake、host spawn 和系统 API 调用均为零；
- [ ] 普通命令进入 ask，批准只调用当前 fake 一次；拒绝、重复、旧 Run、错误 requestId、模式或能力变化均不执行；
- [ ] 无效 Schema、未知 Tool 和 command unavailable 分别形成约定 failed，Plan 副作用和 hard danger 形成约定 denied；
- [ ] Policy、approval、Agent Loop 与 Session 顺序定向测试通过，规则表和 classifier 不从 package 入口导出。

### T007：交付外部单文件写入的路径与 approval 闭环

状态：待开始

Blocked by：T006

交付：

- 扩展现有 workspace resolver：相对路径与 workspace 内绝对路径保持原语义，只为 `edit_file` / `write_file` 增加本地盘符外部单文件分支；
- 拒绝 UNC、设备命名空间、ADS、卷根、目录、Glob、空 basename、系统保护目录和活动 Session 目录；
- 对已有目标记录真实目标 / 父目录、类型与 SHA-256，对新目标记录最近已有父目录与“不存在”状态，并识别 Reparse Point；
- 在 approval 中展示规范化绝对目标、创建 / 覆盖语义、Diff 或完整有界内容和“一次只批准一个文件”的边界；
- 执行前重验父目录、目标身份、链接和指纹，继续复用现有精确编辑与同目录原子写入；
- 保持 Plan 模式拒绝、只读 Tool 不出 workspace、command cwd 不出 workspace，命令 approval 不形成外部写扩权。

验收：

- [ ] 规范化后位于 workspace 的绝对路径按普通 workspace 目标处理，原有相对路径、Session 保护与 stale target 测试无回归；
- [ ] 临时普通外部文件在 Agent 模式形成 ask：拒绝不变化，批准只创建或修改一个精确目标；
- [ ] 预览后替换内容、父目录、目标类型或 Reparse Point 会以 stale target 失败，不留下部分写入；
- [ ] UNC、设备路径、ADS、根、系统保护目录、目录与 Glob 目标不能进入可批准执行；
- [ ] Plan 模式的外部文件请求 denied，只读 Tool 与 command cwd 仍拒绝 workspace 外路径；
- [ ] file Tool、路径、approval、原子写入与 Session JSONL 定向测试全部使用临时目录并通过。

### T008：完成 Stage 02 安全决策门禁

状态：待开始

Blocked by：T004、T005、T006、T007

交付：

- 运行 Permission Mode、Policy、file Tool、Agent、startup 与受影响 Session 定向测试，以及 `pnpm check`；
- 从公开 Agent prompt 追踪 Tool definitions、Policy Decision、approval、prepared execution 与 ToolResult，确认测试不是绕过闭环直调内部函数；
- 搜索生产调用链与 package exports，确认没有无沙箱 host command 可达路径，也没有 Policy、ToolRunner、classifier 或 fake 类型泄漏；
- 更新 T004–T008 和 Stage 02 的真实状态，汇报公开面、决策顺序、路径边界、验证结果、未完成 backend 与 Git 状态。

验收：

- [ ] Plan 规定的 Stage 02 定向验证和 `pnpm check` 全部通过，失败不是靠重跑或放宽断言掩盖；
- [ ] Spec A、E、F、G 与 I 中属于本 Stage 的行为有公开 Interface 证据；
- [ ] 生产 `execute_command` 在 backend 尚未接入时 fail-closed，文件和对话能力继续可用；
- [ ] Schema 1、unknown / interrupted 恢复、六个 Tool 名称和单 activeRun 均未改变；
- [ ] 未加入 sandbox-runtime、未运行真实命令、危险 fixture、真实 Provider、外网或真实凭据；
- [ ] Stage 02 门禁通过并记录证据，才按本轮连续实施授权进入 Stage 03。

## Stage 03：只读 Tool 有界并发

### T009：Expand Tool 结果形成与有序提交 seam

状态：待开始

Blocked by：T008；且开发者已明确授权 Stage 03 实施

交付：

- 将 Agent Loop 中 `processToolCall` 的“执行并立即追加”拆成两个内部阶段：形成带原索引的 Tool outcome，以及由 Run Module 串行提交 ToolResult；
- 让准备失败、Policy deny、用户拒绝、执行完成 / 失败 / 取消都归约为恰好一个 outcome，不在各分支直接写 Session；
- 先保持全部 ToolCall 源顺序串行：每形成一个 outcome 就立即按当前索引提交，以证明重构不依赖并发才成立；
- 把 `tool_execution_start` / `end` 作为执行事实与 ToolResult message 事件分离，预检失败和 deny 不伪造 start；
- 保持 ToolExecutionStartedRecord 仍在已批准副作用之前刷新，Session lease 仍是唯一 JSONL writer。

验收：

- [ ] 当前六个 Tool 的成功、failed、denied、aborted 与 unknown 恢复结果都恰好提交一次；
- [ ] AssistantMessage 先于所有 Tool outcome，副作用开始记录先于本地效果，ToolResult 仍按源顺序进入 JSONL 和下一次模型请求；
- [ ] 全部调用仍最大重叠数为 1，最多一个 approval，预览仍在串行调用轮到时生成；
- [ ] start / end 与 ToolResult message 各自顺序有明确断言，preflight / deny 的 start 数量为零；
- [ ] 现有 Tool Loop、命令 fake、Session、保险丝和 abort 定向测试通过，本任务没有 worker queue 或并发执行。

### T010：交付四 worker 只读并发与源顺序提交

状态：待开始

Blocked by：T009

交付：

- 在 AssistantMessage 持久化后按全部 Tool 名一次性选择 `parallel_read_only` 或 `source_order_serial`，批次执行中不改变策略；
- 实现固定上限 4 的递增索引 worker queue，不用无上限 `Promise.all(toolCalls.map(...))` 创建整批活动任务；
- 为只读准备结果增加 source-order start gate，使更靠后的 ready 调用等待前序发布 start 或确定不执行，再开始自己的执行；
- 允许实际执行重叠和 end 乱序，把每个 outcome 写入原索引槽位；全批收口后再由 Run Module 源顺序提交；
- 下一次模型请求只读取已经按源顺序提交的 ToolResult，Session Module 不接收并发概念。

验收：

- [ ] 确定性模型一次返回至少六个只读 ToolCall，受控 executor 的实测最大并发数等于 4 且从不超过 4；
- [ ] 受控 executor 可以让调用逆序完成，start 仍按源顺序，end 按真实完成顺序；
- [ ] ToolResult message、JSONL 记录和第二次模型请求全部与 ToolCall 源顺序一致；
- [ ] 调用数超过上限时只存在四个活动执行，其余留在递增队列，不预先打开文件、搜索进程或无界 Promise；
- [ ] 包含 write、command 或未知 Tool 的批次仍走 T009 串行路径，最大重叠数为 1；
- [ ] 公开 Agent Interface、实际 Session 和模型请求共同证明行为，不以直接调用 scheduler 代替闭环测试。

### T011：收口并发失败、取消与 TUI 事件归属

状态：待开始

Blocked by：T010

交付：

- 一个只读任务 failed 时保留其他任务继续执行，并在全批收口后提交包含全部源索引的结果；
- abort 时关闭队列领取入口、唤醒 source-order start gate、向运行任务传播根 AbortSignal，并为未开始项形成 aborted outcome；
- 统一“准备中、等待 start gate、执行中、排队中”四种取消位置，确保 run_end 晚于所有任务和资源释放；
- 验证混合批次中的确认拒绝、文件 stale、command failed 和未知 Tool 后，后续调用仍按源顺序串行；
- 调整 TUI 事件呈现 seam，以 Tool 名和 toolCallId 归属并发 start / end / update，不使用“最近启动 Tool”状态。

验收：

- [ ] 单个只读 failed 不取消同批其他调用，模型收到源顺序排列的完整结果集合；
- [ ] 四种取消位置都在有限时间内收口，不再启动新任务、不悬挂 gate、不重复 end 或 run_end；
- [ ] 已完成结果保持原终态，运行中和排队项分别得到实际终态或 aborted，所有 ToolCall 恰有一个结果；
- [ ] 混合批次没有两个执行或两个 approval 重叠，just-in-time 预览与指纹语义无回归；
- [ ] TUI fake 在 end 逆序时把状态和输出归给正确 toolCallId，且只调用 Agent Interface；
- [ ] 并发失败、abort、混合串行、Session 顺序和 TUI 定向测试通过，无后台任务或残留句柄。

### T012：完成 Stage 03 并发与确定性门禁

状态：待开始

Blocked by：T009、T010、T011

交付：

- 运行调度、Tool Loop、Agent 安全保险丝、Session、abort 与 TUI 定向测试，以及 `pnpm check`；
- 检查真实 JSONL 和第二次模型请求，记录实测最大并发、start / end 顺序与持久顺序；
- 审查调用链，确认 Batch Scheduler 不解析 Policy / 路径、不写 Session，Session 与公开 ActiveRun 也没有吸收并发内部状态；
- 更新 T009–T012 和 Stage 03 的真实状态，汇报并发、失败、取消、资源释放、验证结果和 Git 状态。

验收：

- [ ] Plan 规定的 Stage 03 定向验证和 `pnpm check` 全部通过；
- [ ] Spec B–D 与 K 中属于本 Stage 的行为同时有 AgentEvent、JSONL 和模型上下文证据；
- [ ] 实测只读并发大于 1 且不超过 4，副作用、approval、Session append 和命令仍没有并发；
- [ ] Run 终态只在所有任务、gate 和句柄收口后发布，完成后 Agent 可以接受下一条 prompt；
- [ ] 没有新增 Session Schema、公开 Run 生命周期、动态并发配置或 Stage 04 backend；
- [ ] Stage 03 门禁通过并记录证据，才按本轮连续实施授权进入 Stage 04。

## Stage 04：Windows backend 与整体闭环

### T013：接入精确依赖并交付 Windows sandbox 生命周期

状态：待开始

Blocked by：T012；且 Stage 01 结论仍为 GO、开发者已明确授权 Stage 04 实施

交付：

- 复核 `@anthropic-ai/sandbox-runtime@0.0.75` 的许可证、发布内容、Node 24 / ESM 入口和安装脚本；精确加入 `apps/agent` 并更新 lockfile，不使用范围版本；
- 若本地 pnpm store 不具备已授权的精确包，停止并单独申请网络下载授权，不替换版本或来源；
- 实现唯一内部 `windows-command-sandbox` 模块，集中生成 workspace / Session / runtime roots、私有临时目录、网络与最小环境配置；
- 封装初始化、自检、ready / unavailable 状态、commandId / commandText 归属、候选包装、reset 与安全错误，不暴露候选类型；
- 在生产 Agent 创建时尝试装配：非 Windows、缺失 setup、版本不兼容、Shell 不可读或初始化失败仍返回文件 / 对话可用的 Agent，但命令 unavailable；
- 将 T005 的 `close()` 接到内部 sandbox cleanup hook；本任务只用候选 fake 验证生命周期，不提前迁移真实 command Tool。

验收：

- [ ] manifest 与 lockfile 只增加精确 `0.0.75` 及其必要传递依赖，许可证和发布内容检查有记录；
- [ ] 生产配置不读取项目内 sandbox 配置，不启用 weaker nested、excluded command、host fallback 或运行时 ask callback；
- [ ] 环境从 allowlist 组装，宿主 `USERPROFILE`、`APPDATA`、`ANTHIAS_*`、Provider Token、代理凭据和 `NODE_OPTIONS` 不被复制；
- [ ] fake 初始化成功进入 ready；缺失、异常和非 Windows 进入 unavailable，且其他五个文件 Tool 与对话仍可用；
- [ ] reset 只被一个 Agent 生命周期持有并可幂等等待，候选异常被映射为安全文本，不泄漏内部路径、环境或堆栈；
- [ ] `@anthropic-ai/sandbox-runtime` 的类型、配置、Manager 和测试 fake 均未从 `@anthias/agent` 导出；
- [ ] Windows sandbox、startup、Agent close 与 package 公开面定向测试通过，本任务没有真实命令执行。

### T014：Contract 迁移 execute_command 并删除宿主 executor

状态：待开始

Blocked by：T013

交付：

- 把已经通过 Policy 与一次性 approval 的 prepared command 迁移到 T013 Windows sandbox，使用原 toolCallId / commandText 做 violation 归属；
- 在候选包装边界集中处理 Windows 参数转义，保证固定 Session Shell、规范化 cwd、完整命令和 timeout 与批准内容一致；raw command 不独立进入 host `spawn`；
- 保持 ToolExecutionStartedRecord 在 sandbox 启动前刷新，随后收集有界 stdout / stderr、退出码、timeout、abort 和 violation，形成一个 ToolResult；
- 完整进程树和命令资源收口后才结束 Tool；清理不可信时标记 cleanupUncertain、把 Agent 状态置为 cleanup_uncertain 并拒绝后续命令；
- 删除旧 `executePreparedCommand` 及其 host 进程树 fallback，清理不再需要的直接 `taskkill` 路径和环境继承代码；
- 迁移命令测试到 sandbox fake；真实已准备 Windows 执行与 conformance 留给 T016。

验收：

- [ ] 普通命令在 Agent + ready 中逐次 ask，拒绝不启动；批准后唯一调用是 Windows sandbox，调用参数与 approval 完全一致；
- [ ] 空格、引号、换行、美元符号和中文的无害命令在 wrapper fake 中保持字节 / 语义一致，不发生二次拼接；
- [ ] 成功、非零退出、输出截断、timeout、abort 与 violation 形成准确有界结果，Session 顺序符合 Spec；
- [ ] cleanup uncertain 后当前命令明确失败，后续 command fake 调用为零，文件与对话能力没有被误报为不可用；
- [ ] 搜索生产代码确认不存在从 ToolRunner 到旧 host executor、raw shell 或 unsandboxed fallback 的可达路径；
- [ ] 危险 classifier 测试仍只处理文本，任何 hard deny 都在 sandbox 调用前结束；
- [ ] command Tool、Policy、approval、Session 与 Agent 生命周期定向测试通过，没有调用真实 Provider 或真实 Windows 命令。

### T015：交付 TUI 模式、并发归属与统一关闭

状态：待开始

Blocked by：T014

交付：

- TUI 启动时从 AgentState 展示 Agent / Plan 与 command sandbox 的 ready / unavailable / cleanup_uncertain 状态；
- 实现 `/mode` 查看、`/mode agent` 和 `/mode plan` 切换；activeRun 中显示 busy，关闭后不接受输入，不在 TUI 复制权限判断；
- approval 展示 permissionMode、riskSummary、executionBoundary、完整目标 / 命令和一次性边界，并区分 ask、hard deny、sandbox unavailable、普通 failed、aborted 与 cleanup uncertain；
- 以 Tool 名和短 toolCallId 标注 start / end / update，使并发 end 乱序时输出仍归属正确调用；
- 统一 `/exit`、EOF 和 Ctrl+C：activeRun 先 abort，随后等待 `agent.close()`；sandbox reset、Session lease 与订阅器收口后才退出；
- 清理不可信时输出安全提示并返回非零退出码，不静默把 cleanup uncertain 显示为正常关闭。

验收：

- [ ] 初始状态、两种模式切换、busy、unavailable 和 cleanup_uncertain 都由 Agent fake 驱动并显示准确；
- [ ] `/mode` 与 approval 输入不会被误当成 prompt，TUI 不导入 ToolRunner、Policy、classifier 或 sandbox-runtime；
- [ ] 并发 start / end 逆序和命令 update 都带正确 Tool 名 / toolCallId，没有依赖“当前 Tool”隐式状态；
- [ ] `/exit`、EOF、空闲 Ctrl+C、模型中 Ctrl+C、approval 中 Ctrl+C 和命令中 Ctrl+C 都只调用统一关闭链一次；
- [ ] clean close 返回成功，cleanup uncertain 返回非零；无残留 readline、订阅、Prompt Promise、计时器或 fake sandbox 资源；
- [ ] TUI 与 CLI 定向测试通过，`apps/tui` 仍只依赖 `@anthias/agent` 公开 Interface。

### T016：完成真实 Windows 验收、全量门禁与 Report

状态：待开始

Blocked by：T013、T014、T015

交付：

- 在已经获得并保留系统准备授权的 Windows 环境中，通过显式 opt-in conformance 入口把 T013 / T014 生产 Adapter 接到临时 workspace，重跑 W01–W10；
- 默认 `pnpm verify` 不把“机器未准备而跳过”记为真实 Windows PASS；T016 必须单独记录 opt-in 命令与结果；
- 逐项汇总 Spec A–L：Permission、并发、串行、取消、Policy、HITL、外部路径、sandbox、fail-closed、进程树、Session 与 TUI；
- 运行受影响定向测试、`pnpm install --frozen-lockfile --offline` 和最终 `pnpm verify`，检查进程、监听器、临时目录、ACL 与 Session 锁；
- 创建唯一 `report.md`，记录成立能力、入口与调用链、验证环境 / 命令 / 结果、机器级 setup 状态、未验证网络 / Provider 边界和 Git 状态；
- 只有全部核心项 PASS 且文档与代码一致时，才把 Spec、Plan、Tasks、Report 标为“已实现”；不标记“已验收”。

验收：

- [ ] 真实生产 Adapter 在临时 workspace 内可运行固定 PowerShell、Node 与 pnpm，并阻止临时外部 sentinel 和活动 Session 读写；
- [ ] timeout、abort、close 与 reset 后没有遗留测试子进程、代理监听器、临时 ACL、目录、句柄或 Session 锁；
- [ ] 非 Windows fake、缺失 setup、初始化异常、Shell 不可读和 cleanup uncertain 全部 fail-closed，无 host fallback；
- [ ] Spec A–L 每项有 PASS / FAIL / BLOCKED 结果；没有未经开发者逐项接受的 WAIVED，也没有把网络可达性当作安全证明；
- [ ] frozen-lockfile 离线安装、`pnpm verify` 和显式 Windows conformance 均通过，实际命令与环境记录完整；
- [ ] `report.md` 是唯一 Report，不保存临时脚本、原始测试日志、危险命令输出、真实凭据或宿主敏感路径；
- [ ] Feature 文档只在完成门成立时统一标为“已实现”，最终汇报后停止并等待开发者验收；
- [ ] 没有提交、推送或创建 PR，除非开发者在此之前分别给出明确授权。

## 授权与下一步

- 当前 Tasks 已确认，开发者已授权本轮连续实施全部 Stage；
- 实施授权允许修改代码和运行仓库内安全验证，但不表示允许下载包、触发 UAC、修改 Windows 系统状态、访问真实 Provider 或外网；
- T001 只读核对完成后，仍需分别取得精确包下载和 Windows 系统准备授权；
- 每个 Stage 门禁必须先通过并记录证据，再按本轮授权继续下一 Stage；
- 提交、推送和 PR 始终分别取得授权，本 Tasks 不预设任何 Git 提交。
