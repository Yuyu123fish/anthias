# Feature 011 Report

状态：实施中

## 开发者速览

> **一句话**：Plan 01、02 已完成实现和本地验证，核心独立审查通过。<br>
> **核心做法**：会话归属、完整 Tool 批次、写入队列和请求投影各有明确持有者。<br>
> **边界**：核心保持既有权限与持久化语义，TUI 尚未实施。<br>
> **风险 / 未验证**：真实 Provider、人工终端体验与最终全量验证尚未完成。<br>
> **当前 / 请审阅**：Plan 01 已提交 aea8813；Plan 02 审查通过，提交后继续 Plan 03。

## Plan 01 的结果

基线为 main @ 865baac。根沿用创建日期/时间戳/ID 目录；新 SubAgent 与 teammate 使用根目录的 members/<memberSessionId>，Header 保留成员真实时间。根与成员各自保存 JSONL、恢复索引与 artifacts；没有共享写入器、额度或新日志 Schema。

旧 Schema 1/2/3 和旧平铺成员继续兼容。只读历史不迁移日志，旧成员继续原位置；旧根显式打开并开始协作时，经原有协调事实追加路径升级为 Schema 3，新成员随后嵌套。一个根下可以同时保留旧平铺和新嵌套成员。

根的现有 collaboration result 接口继续核对成员归属、该成员日志中的 Tool 产物引用，再读取该成员 artifacts。公开接口测试覆盖一根、两个 SubAgent 和一个 teammate，换成员 ID 或未引用产物均拒绝。项目输出仍保存在工具实际指定的 Workspace/worktree 等成果路径，历史清理不负责这些工作成果。

项目级 Windows 沙箱 Research 已移到 [归档目录](../../research/archive/2026-09-09-windows-sandbox-autoallow/README.md)，同步 [Research 索引](../../research/README.md)。移动保留结论，只修正 16 个向仓库上级引用；20 个本地链接通过检查。执行器仍为候选，未安装或实施。

## 阅读路径与职责变化

| 入口与消费者 | 改造前 | 当前持有者及保证 |
| --- | --- | --- |
| Session create/open、只读 history、migration、成员 result | locations 识别平铺目录，其他消费者另写布局规则 | locations 集中平铺/嵌套/旧单文件的语法、Header、真实路径和 ID 冲突校验；目录来源改称 directory/legacy，日志 Schema 单独表达 |
| Agent sessions.list → listSessions | list 自行扫描日期目录并读 Header | list 消费统一枚举，只筛选当前 Workspace 的 primary 摘要；扫描达到边界明确失败，个别坏日志不会抹去其他根摘要 |
| cleanup → locateSessionGroup | groups 再扫描全库，损坏候选可能被无声跳过 | groups 消费同一份位置事实与诊断，读取本组日志并校验归属与完整性；无法核验则保留 |
| cleanupExpiredSessions | cleanup 自行枚举日期/旧文件，逐 Session rename | cleanup 复用位置枚举；全部 Session 的锁与使用事实仍逐个核验，物理移动通过 pendingMoveRoots 去掉父子重复 |
| pending 恢复 | 平铺源和 trash 目录逐项对应 | pending 仍记录全体身份，恢复从源包含关系推导同一移动集合；混合组部分移动时先恢复再重验，全部移走后可继续中断的递归删除 |

生产 package 仍为 Agent 与 TUI 两个，公开新增/删除项均为 0；apps/agent/src/index.ts 与 AgentControls 未改变，公开生产工厂及现有控制行为均保持。新增的枚举结果、物理父目录与路径语法函数只在 session 内部被 list/groups/cleanup 使用，未从 package 入口导出。此次没有新增源码层级或转发模块。

改造后的主要调用链：

- members.spawn 先追加 preparing 协调事实 → createSession → createSessionStorageDirectory 验证根并建成员目录 → Session 写自身 Header/索引并取得使用标记；创建中断沿用已有失败事实，不在重开时自动重试。
- readSessionHistory → locateSessionStorage → enumerateSessionStorage → Header/位置校验 → readSessionJournal；不取得运行权、不读取 Workspace，也不重放模型或工具。
- cleanupExpiredSessions → 枚举/组识别 → 按 ID 顺序取得全组 Session 锁 → 再验组成员集合、日志、终态、使用标记和安全目录树 → 刷盘完整 pending → 按物理源移动 → 清理 trash 并失效所有成员缓存。

位置缓存可重建，不能证明没有另一份同 ID 日志。严格定位始终完整枚举受管布局，缓存只作可重建位置记录；这是明确的完整性取舍，没有宣称查找性能提升。

## 失败与资源边界

- Header 与目录归属不符、同 ID 多位置、受管路径链接或扫描未完成时，严格定位拒绝选择权威来源。
- 成员日志损坏时根仍可只读；成员详情明确失败。已知物理根的损坏成员只保护所属组，归属未知的候选保守保护所有可能受影响组。未知文件或目录不作为 Agent 产物删除。
- 清理保留既有十四天活动时间、Run 终态、活跃/未知进程、Team/任务/交付、worktree 回收与 Git 操作终态检查。锁取得后再核对组集合，目录消失或新增成员不冒充原验证结果。
- pending 的每项 ID 继续用于锁与缓存；嵌套成员的物理父必须是清单中的根。部分移动后存在原源时先恢复，新的使用标记会阻止重新删除。
- 所有原源都已移动后，trash 只允许清单推导出的移动根。递归删除中断形成的预期子集可继续清理；发现额外内容或不安全路径则保留。
- 产物预算、引用发布、取消和临时文件释放未重新实现，沿用单 Session store 与现有结果持久化顺序。没有迁移或删除实际 data/conversation 日志，没有启动真实模型或保留演示进程。

## 验证与证据范围

环境：Windows、Node v24.13.1、pnpm 10.33.0、TypeScript 7.0.2、Vitest 4.1.11。测试使用临时目录、临时 Git 仓库和确定性 Model Stream。

| 验证 | 结果及覆盖 |
| --- | --- |
| pnpm check | 最终修复版本通过：格式与全仓测试类型检查；Biome 的 useTemplate 信息提示仍存在，不是失败，不借此全仓格式化 |
| pnpm build | 最终修复版本通过：Agent 与 TUI 构建 |
| pnpm exec vitest run apps/agent/test/session.test.ts apps/agent/test/session-recovery.test.ts apps/agent/test/session-cleanup.test.ts apps/agent/test/session-locations.test.ts apps/agent/test/multi-agent.test.ts apps/agent/test/tool-artifacts.test.ts apps/agent/test/startup.test.ts | 首轮 7 文件、100 用例通过；覆盖 Session、旧格式、锁、清理、嵌套布局、协作与产物失败收口 |
| pnpm exec vitest run apps/agent/test/session-locations.test.ts apps/agent/test/session-cleanup.test.ts apps/agent/test/multi-agent.test.ts | 补充修复及新用例后 3 文件、42 用例通过；包含 4 个新增的旧根升级、公开产物回读与部分删除恢复用例 |
| pnpm exec tsc -p tsconfig.test.json --noEmit | 补充变更后通过；格式定向检查通过 |
| pnpm exec vitest run apps/agent/test/session-cleanup.test.ts apps/agent/test/session-locations.test.ts | 定向核对修复后 2 文件、35 用例通过，补充 4 个未知内容保留与无关组清理用例 |
| 文档与独立定向核对 | 独立有界源码核对完成；确认的两处问题已修复并有回归证据，6 份 Feature 文档、10 个本地链接及状态检查通过，git diff --check 通过 |

共 108 个不同用例获得通过证据，不把多轮重叠用例相加。补充变更后只复跑受影响的定位、组清理与公开协作套件；其他可信结果复用。Feature 最终 pnpm verify 与完整 Spec 独立审查保留在 Plan 03，不以本增量替代。

本增量完成一次独立有界源码核对，统筹复核关键清理判断。核对发现未知目录内容删除与已知坏成员影响无关组两处缺口，修复后只复验定位/清理套件。关于旧 Windows pending 分隔符的疑点，经 HEAD 基线确认 groups 与 cleanup 持久化始终写入正斜杠，未确认实际兼容回退；没有借此扩大状态迁移范围。完整 Feature 的最终独立审查仍在 Plan 03。


## Plan 02 的结果

接续 aea8813。运行核心保持现有公开行为、日志 Schema、权限及并发语义，集中原来散在装配、循环和转换闭包中的协议。Agent package 入口与 AgentControls 改动均为 0，仍为两个生产 package；新文件均为内部实现。

| 真实调用者 | 之前的阅读负担 | 当前入口与保证 |
| --- | --- | --- |
| Agent 创建、切换与关闭 | 根/成员装配嵌在公开控制里，primary/coordinator 通过未初始化捕获互访 | runtime.createAgentRuntime 按共享资源 → coordinator → primary → 发布绑定装配；运行回调须在绑定后使用；close 先收齐成员再关根，MCP 连接和清理任务仍由稳定 Agent 关闭 |
| collaboration.execute | 直接控制动作在公开路由逐项拼条件 | multi-agent.isDirectCollaborationControl 集中 list/result/wait/stop 分类，其余继续以 Tool Run 进入审批、持久化与取消协议 |
| runAgentLoop | 模型生成和四并发 worker、审批门、结果预算互相穿插 | tool-batch.runToolBatch 完整推进一个响应的准备/屏障/审批/执行/提交；下游工具仍持有执行前复核，批次仍等待 worker 收齐，结果刷盘后才进入下一请求 |
| SessionAgent、Context、协调层追加 | index 同时持有打开、恢复、多套追加状态及 activeRunAppend accessor 包 | writer 统一持有持久投影、Session 接受队列和 RunWriteState；运行/空闲复用 persistRecord，封口接受和持久终态明确区分，等待已接受写入后交还锁 |
| Context 请求与摘要选择 | assembly、selection 和 includeAgentInputs 重复补位置，以小数 seq 约定插入点 | projection 对同一记录快照计算身份、完整 Tool 组与来源位置；selection 复用分组选择覆盖范围；真实用户边界、来源撤销和先持久化摘要再采用继续保持 |
| SessionAgent 模型请求到 MCP Tool | 最近一次投影覆盖闭包里的可见集合 | prepareRequest 同时返回请求和不可变快照；本 Run 按原 ModelRequest 身份绑定 Runner，执行只消费该快照，mcp/index 的连接 generation/schema 执行前校验继续保持 |
| Git 继续/中止与恢复 | 两条操作各自解释集成阶段和实际状态 | integration.planIntegrationResolution 共用恢复判断；intent → cherry-pick → staged/conflicted，Git commit → committed 事实 → worktree 摘要顺序保持 |

Context 的 assembly.ts 已删除，历史装配实质归入 projection.ts；mcp/index.ts 不增加一层转发，继续持有原连接生命周期。Session index 保留创建/打开、恢复和身份绑定，writer 持有可变写入状态；原 Session 的 17 个成员及 lease 的 10 个行为保持兼容。

本次还删除了 Runtime/Loop/SessionAgent 和 artifacts 触及链中复述类型、字段、循环或函数名的注释。保留或重写构造可用时点、成员候选记忆限制、持久化前后、取消收齐与执行来源的中文原因；没有按注释覆盖率批量补说明。

独立审查分两组完成：Session writer 由非作者核对；Runtime、Tool、Context/MCP 和 Git 由另一位非作者核对，未发现阻塞问题。审查没有重复已执行的测试。

### Plan 02 验证

| 验证 | 结果 |
| --- | --- |
| Runtime/Tool 分区（Plan 所列 8 文件） | 70/70 通过，覆盖直接控制、忙闲、审批、取消、续轮、完整工具循环及多 Agent 衔接 |
| Session 分区（2 文件） | 40/40 通过，新增关闭前已接受追加、关闭后拒绝新请求、锁凭据创建期间关闭三个场景 |
| Context/MCP 分区（6 文件，含新增 mcp-tool-snapshot.test.ts） | 最终 41/41 通过；旧预算夹具补持久 entryId 后只复跑 selection 的 6 项，其余 5 文件结果复用 |
| Git 分区（3 文件） | 12/12 通过，新增 staged 树变化时恢复拒绝及 committed 已落盘但摘要失败后的恢复 |
| pnpm check / pnpm build | 集成版本通过；首次 check 在协作文件尚未格式化时失败，格式完成后通过，旧 useTemplate 仅信息提示 |

合计 163 项不同测试通过。Context 回归同时覆盖完整双 ToolResult、穿插的 agent_input、来源更新/撤销、持久切点与恢复；MCP 回归验证连续请求的可见性隔离、预算省略与执行时 generation 复核。测试均在 Windows、Node v24.13.1、pnpm 10.33.0 下使用本地确定性流或本地 MCP/Git 夹具。没有真实 Provider 或远端 Git 调用。

Session 审查对新增关闭测试作了明确限定：它覆盖锁凭据创建期间关闭；既有 refreshAfterUsageOnlyAppend 等待期间仍可能交付 lease，close 随后等待持有者释放。该判断与 aea8813 相同，本次未扩张为新的取消语义，也不宣称测试覆盖获取锁全过程。

## 未完成范围与验收

- Plan 02：实现、定向验证与独立衔接审查已完成。
- Plan 03：根会话概览、成员过程收拢、TUI 呈现状态、共享文案与命令声明尚未实施；当前 TUI 行为不作为归组呈现已完成的证据。
- Spec A01–A03、A05–A12 已有分区证据；A04、A13 及完整 A14–A15 留到 Plan 03。
- 未做真实 Provider、OS 沙箱、真实用户数据迁移/删除或人工终端验收。已完成 Research 归档不表示沙箱能力已实现。
- 分支仍为 main，Plan 01 已提交 aea8813，未推送、未创建 PR。开发者于 2026-09-09 明确授权连续完成 Feature，每个 Plan 审查通过后提交；本 Feature 不再逐阶段等待用户确认。
