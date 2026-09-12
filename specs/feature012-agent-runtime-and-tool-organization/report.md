# Report：Agent 运行对象与工具组织

状态：已实现

[Spec](spec.md) · [Plan](plan.md) · [Tasks](tasks.md)

## 开发者速览

> **一句话**：单 Agent 的实际状态与资源已集中，工具定义和执行计划由同一集合生成。<br>
> **核心做法**：保留稳定 Agent 入口，在 SessionAgent 内统一持有；Git 归入基础工具，Session 按编码、查询、清理协议拆分。<br>
> **边界**：公开入口、事件、权限与历史格式保持；写文件和编辑文件仍独立。<br>
> **风险 / 未验证**：未调用真实 Provider、外部 MCP 或 SearchAPI，未进行人工终端体验验收。<br>
> **当前 / 请审阅**：实现、完整本地验证和独立审查完成，等待开发者验收。

## 已形成的结构

[SessionAgent](../../apps/agent/src/session-agent.ts) 内的 runtime 持有 state、Session、ModelStream、Context、基础及扩展工具、权限引用、产物和监听器。SessionAgentExecutionState 是消息、消息身份、活动回复、Run、审批及关闭状态的单一内存来源；原有散落变量已移除。公开 AgentState 继续从持有者生成只读投影，没有暴露执行器或持久化句柄。Session 中的持久记录仍是恢复依据，Context 的模型投影仍由 ContextController 形成。

配置与已创建能力分开表达：CreateAgentWithModelStreamOptions 包含目录配置，SessionAgentOptions 描述已装配的单 Agent 能力。[Runtime](../../apps/agent/src/runtime.ts) 的 commonAgentOptions 被根和成员共同使用；成员只提交记忆候选、引用根授权记录和共享任务时限，既有来源限制保持。

| 改动前的调用路径 | 当前调用路径与实际消费者 |
| --- | --- |
| SessionAgent 在 definitions 和多个 createPlan 入口分别收集能力 | prepareRequest 收集同源工具，同时生成 ModelRequest 和 ToolRunner；当前 Run 持有每个请求身份对应的 Runner，Loop 使用该请求绑定的执行计划 |
| definitions 集中七份 Schema，ToolRunner 再按名称分派 | 基础工具文件各自提供 definition/createPlan；BASE_TOOLS 只装配对象，模型名单和 Runner 都从这里投影 |
| 根与成员分别重复 Model/Skill/MCP/权限/排队装配 | Runtime 的 commonAgentOptions 共享装配规则，各自 Session 与记忆写入约束显式传入 |
| git/ 与 tool/git-tools 分开，成员模块转述 GitWorkspace 类型 | tool/basetool/git/ 持有实现与 Tool；Runtime、Agent Controls 和成员直接消费 Git 自己的类型与行为 |
| schema 同时验证和转换消息；cleanup 同时决定清理对象并管理移动恢复 | schema 保留校验权威，message-codec 持有转换；cleanup 决定对象及锁，cleanup-state 独占 cursor/pending/trash 状态协议 |
| list/history 两个小查询文件，SessionSummary 定义在 Agent Controls | query 合并只读查询并定义摘要；Agent、成员、恢复测试消费同一入口，Agent Controls 保持原类型转出 |

write-file.ts 和 edit-file.ts 保持两个工具入口，继续共用 file-change。入口中的输入解析只校验模型已解码的参数对象，例如 path/content 是否存在、类型和字段是否正确；路径与目标内容复核、文件准备和实际写入仍在各自后续边界。命令输出收集、捕获和渲染集中到 command-output，Shell 启动、取消与关闭仍由 execute-command 持有。

## 权限、取消与持久化

- 工具可见性不赋予执行权限。计划继续经过参数校验、Policy、审批和执行前复核。Plan 隐藏的基础副作用工具、成员隐藏协作工具和未进入请求的 MCP 工具都有仅拒绝的兼容路径，不向该路径提供执行能力。
- 外部工具绑定请求自己的 MCP 快照，执行前仍校验连接 generation/schema。后续请求或其他成员不能覆盖已经返回的模型调用所用 Runner。
- 完成消息先通过 Session lease 刷盘，再更新内存和公开完成事件；Run 终态 Promise 唯一，run_end 同步交付时仍保留活动 Run，随后归还 lease。关闭也等待正在获取 lease 的 prompt。
- 运行对象引用共享权限和 MCP 能力，各自持有 Session、上下文投影和产物。整组关闭仍先成员后根，共享 MCP 仍由稳定 Agent 统一关闭。
- Session Schema 1/2/3、平铺/嵌套/混合布局和只读查询行为保留。清理仍整组取锁后重验，pending 刷盘后才移动；移动或来源不确定时恢复或保留。Git 的进程级 gitMutationTail、执行前复核和根协调记录保持。

## 规模与公开边界

生产 Agent 从 83 个 TypeScript 文件 / 27,090 行变为 85 个 / 27,378 行。Session 从 14 个文件变为 15 个；Tool 连同迁入的 Git 从原来的 26 个变为 27 个。增加的文件用于消息转换、清理协议和工具计划的真实职责分离，查询聚合与 Git 迁移抵消部分数量变化。

这些数字只描述规模。结构收益是删除重复工具业务分派、状态只保留一个写入来源，以及减少为新增工具或追踪 Session 恢复所需跨越的职责。SessionAgent 从 1,334 行变为 1,434 行，本次没有宣称整体代码缩短。

package 入口经 TypeScript AST 对比，改动前后均为 **47 项导出：1 个生产工厂、46 个类型**，名称与类型/运行时分类相同。TUI 源码未修改。Agent Loop、Tool Batch、Context 压缩算法、Session writer 队列及 Schema 版本没有重写。

## 验证证据

环境：Windows、Node.js 24.13.1、pnpm 10.33.0、Vitest 4.1.11；基线 main @ c7b8853。全部验证使用本地确定性模型、本地模拟服务和临时工作区，没有真实外部请求。

| 验证范围与命令 | 结果 |
| --- | --- |
| pnpm exec tsc -p tsconfig.test.json --noEmit | 集成类型检查通过 |
| pnpm exec vitest run 后接 session、session-recovery、session-locations、session-cleanup 四个完整测试路径 | 4 文件、75 测试通过，4.21 秒 |
| pnpm exec vitest run 后接 read-only-tool、file-tool-loop、command-tool-loop、command-output、complete-tool-loop、external-file-tool、tool-loop、tool-scheduling、tool-artifacts、permission-policy、git-workspace、git-approval-state、git-integration-ignored-collision、mcp-tool-snapshot、mcp、web-search 的完整测试路径 | 16 文件通过，140 测试通过、1 个既有平台条件跳过，77.55 秒 |
| pnpm exec vitest run 后接 agent、agent-controls、agent-capability-boundaries、agent-loop-safety、context-integration、context-compaction、context-selection、multi-agent、auto-allow-integration、memory-context、model-recovery 的完整测试路径 | 初次 121 通过、1 失败；定位为隐藏协作工具拒绝提示回归，已修复实现，未改断言 |
| pnpm exec vitest run apps/agent/test/multi-agent.test.ts -t 'persists delegation as sourced input and rejects recursive creation even when forged' | 原失败用例通过，10 个用例因名称筛选未执行，1.54 秒 |
| pnpm verify | 格式、类型和生产构建通过；默认 4 worker 测试首轮 47 文件通过，576 测试通过、1 超时、1 平台条件跳过，169.91 秒；该命令首轮 exit 1，未记为全绿 |
| pnpm exec vitest run apps/agent/test/tool-loop.test.ts | 相同代码的原超时文件 2 测试通过，2.68 秒 |
| pnpm exec vitest run --maxWorkers=2 | 相同代码完整复验：48 文件通过，577 测试通过、1 个既有平台条件跳过，194.66 秒，exit 0 |

表中省略路径的测试名均位于 apps/agent/test/，后缀为 .test.ts。各执行 Agent 只运行自己负责的定向组；最终集成门禁由统筹统一执行。测试结束后的死代码删除及名称分类去重由完整复验覆盖。默认并行首轮的 5 秒超时伴随临时目录清理 EBUSY；单文件及限并发全量复验均通过，未改断言、测试超时或仓库 worker 配置。这些证据没有定位超时的系统级根因，不宣称默认并行首轮通过。

## 独立审查与未验证边界

一位非作者已对照 A01–A09 完成一次独立只读审查，无剩余 finding；审查未重复运行测试。状态权威、请求身份、审批来源、写入顺序、共享关闭、Session 清理与 Git 迁移均已核对。git diff --check 与本 Feature 文档相对链接检查通过。格式、类型和构建通过，完整测试以限并发复验的通过结果收口，默认并行首轮超时记录如上保留。

本 Feature 不证明真实模型表现、真实远端 MCP/SearchAPI 兼容性或人工终端体验。实现与验证完成后，开发者单独授权做一次本地提交；不推送或创建 PR。开发者验收前保持“已实现”边界，稳定产品文档不提前标为已验收。
