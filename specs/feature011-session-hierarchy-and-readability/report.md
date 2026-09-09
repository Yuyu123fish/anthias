# Feature 011 Report

状态：实施中

## 开发者速览

> **一句话**：Plan 01 已实现新成员归入根目录，并兼容旧历史与整组清理。<br>
> **核心做法**：位置规则集中在 locations，清理记录全部身份、只移动互不包含的物理源。<br>
> **边界**：核心 Runtime 整理与 TUI 呈现尚未实施，未改公开 Agent 接口。<br>
> **风险 / 未验证**：真实 Provider、人工终端体验与后续两个 Plan 尚未验证。<br>
> **当前 / 请审阅**：Plan 01 已实现，等待开发者审查；后续两个 Plan 尚未开始。

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

## 未完成范围与验收

- Plan 02：Runtime、Tool 批次、Session writer、Context 投影、MCP 请求快照、Git 集成及对应命名/注释尚未实施。
- Plan 03：根会话概览、成员过程收拢、TUI 呈现状态、共享文案与命令声明尚未实施；当前 TUI 行为不作为归组呈现已完成的证据。
- Spec A01–A03、A05–A08 对应本增量；A04、A09–A13 及完整 A14–A15 仍待后续 Plan。当前源码与注释整改仅覆盖本次存储链。
- 未做真实 Provider、OS 沙箱、真实用户数据迁移/删除或人工终端验收。已完成 Research 归档不表示沙箱能力已实现。
- 分支仍为 main，未提交、未推送、未创建 PR。开发者于 2026-09-09 明确授权连续完成 Feature，每个 Plan 审查通过后提交；本 Feature 不再逐阶段等待用户确认。
