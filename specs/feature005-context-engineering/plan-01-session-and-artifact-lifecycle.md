# Feature 005 Plan 01：Session 与工具产物生命周期

状态：已实现

## 开发者速览

> **一句话**：先让会话和大工具输出能够按时间归档、可靠重开，并在过期后共同清理。<br>
> **核心做法**：Schema 2、双索引、使用标记与有界产物贯通 Agent 和 TUI 的真实调用链。<br>
> **边界**：提供压缩所需存储合同，本阶段不生成模型摘要、不启用 AutoAllow。<br>
> **风险 / 未验证**：迁移中断、文件系统竞态和输出限额必须通过本地故障场景验证。<br>
> **当前 / 请审阅**：本阶段实现与门禁完成；随实现提交后继续 Plan 02。

- 对应 Spec：[spec.md](spec.md)
- 统一任务：[tasks.md](tasks.md)
- 基线：`main` / `2eb5ab9f8100d9d9349b231fe61ee2a4f5cf52b8`。
- 授权：2026-09-05，开发者要求依次编写各 Plan 与 Tasks、文档提交、实施验证、实施提交，连续完成 Feature；各阶段通过约定门禁后继续，不重复等待确认。
- 真实模型：开发者允许通过环境变量 `DEEPSEEK_API_KEY` 使用 `deepseek-v4-flash`，官方 Base URL 为 `https://api.deepseek.com`。本阶段无模型行为变化，使用确定性验证，真实调用额度留给 Plan 02/03。

## 1. 当前基线与范围

当前 Session 为 Schema 1、根目录下的 UUID JSONL，Run 期间持锁，打开后空闲不受保护；Tool 结果只有 64 KiB / 2,000 行截断，TUI 在本进程保存工具预览。Model / Tool / Model 与只读四并发已经存在。

本阶段覆盖 Spec AC-09、AC-12–15、AC-20–22，以及 AC-10/11/19/23/24 中的存储、资源和目录部分。自动压缩及其真实恢复入口在 Plan 02 完成，自动审核在 Plan 03 完成，阶段报告必须区分这一边界。

完成后用户能够：

- 通过原有 Session ID 打开按 UTC 日期与创建时间归档的会话，并显式迁移旧会话。
- 保存和读取超大工具结果；输出不完整时看到明确原因。
- 保持当前打开会话不被清理；启动时清理超过 14 天未使用的数据。
- 退出时释放 Session 使用标记，取消或失败不遗留无人持有的进程或文件句柄。

## 2. 目录与内部合同

按 Spec 第 9 节执行目录迁移。首先将现有 `run.ts` 迁为 `agent.ts`，现有 `agent.ts` 迁为 `agent-loop.ts`；生产装配移入 `startup.ts`。受影响导入一次更新，禁止留下转发旧实现或空目录。`model/` 的实际迁移随 Plan 02 的模型改动完成，`permission/` 随 Plan 03 完成。

### 2.1 Session

- `sessionDirectory` 继续表示配置的会话数据根，新增明确的单会话存储目录，不能混淆两者。
- `locations.ts` 管理 `YYYY-MM-DD/YYYYMMDDTHHmmssSSSZ-<UUID>/session.jsonl` 与可重建的 `session-locations.json`。
- `schema.ts` 定义 Schema 2、父引用、会话使用、CompactionEntry、用量、审批及产物引用记录；Schema 1 只作为迁移输入。
- `journal.ts` 继续承担合法记录验证、尾部恢复与 fsync 顺序；未来用途记录必须有完整校验，不用任意 JSON 绕过 Schema。
- `resume-index.ts` 实现基于 UTF-8 字节偏移的恢复索引读写和重建；有效压缩之前的尾部与稀疏用户引用都必须可恢复。
- Session 提供已验证记录或等价的内部读取能力，供后续 Context 和审核读取事实；这些合同不从 package 出口导出。
- Run lease 仍串行写入；仅增加会话使用记录时刷新存储进度，新增业务事实仍拒绝旧上下文。
- Session 打开期间持有独立使用标记，提供幂等关闭；Agent 关闭负责取消运行、收敛结果后释放它。

### 2.2 工具产物

- 产物由 `session/artifacts.ts` 保存到当前会话的 `artifacts/`，引用以产物 ID、ToolCall ID、实际字节量、完整性及必要的不完整原因为合同。
- ToolRunner 从 Agent 获得当前 Session 的产物能力；工具不自行猜数据根，也不读取其他会话。
- 命令及可大量输出的文件/搜索 Tool 流式收集原文并形成有界预览；在整批预算分配前，不丢失可能需要落盘的原文。
- 首期单个结果 4,000 token、同批合计 8,000 token，字节/行数限制继续作辅助保护。必要的基础文本估算放入 `context/budget.ts`，用量校准和完整模型请求预算在 Plan 02 扩展。
- 同批预算按实际调用数预分为 `min(4,000, floor(8,000 / 调用数))`，再按照 ToolCall 顺序形成结果，包括状态和访问说明；最多 32 个结果必须都得到合法、可理解的终态。
- 单产物 32 MiB、Session 合计 256 MiB，包括并发在写产物；达到限额或写入失败仍排空命令输出。
- 增加 `read_artifact`，使用产物 ID，支持按行分页及字面搜索；超长单行以可前进的 UTF-8 安全游标继续，返回结果不递归形成产物。
- 对未引用、其他 Session 或路径逃逸产物拒绝访问。Plan 模式可以使用此只读 Tool，现有 Workspace 权限不扩大。

### 2.3 清理与关闭

- `cleanup.ts` / `cleanup-worker.ts` 位于 Session 内，生产装配每次启动触发；同一数据根只允许一个清理工作者。
- 首期单次最长 30 秒，最多检查 200 个候选 Session；超过 64 MiB 的日志跳过并报告维护读取预算限制；保存继续位置，下次启动从未完成位置推进。一个已经开始的删除保留中断标记并可继续。
- 清理和打开/迁移/写入共用 Session ID 的互斥规则。删除前重新检查真实使用时间和全部使用标记，存活状态不明时跳过。
- 删除在受管根内完成，拒绝 symlink / junction 逃逸。旧平铺会话可按旧格式判断过期，但清理不迁移它；发现旧写锁或归属不明时跳过。
- 清理工作者不阻塞 TUI 启动、Windows 隐藏窗口，完成或到达限额即退出；Agent 关闭收敛其拥有的后台资源。
- TUI 通过 Agent 的状态/事件展示必要产物和清理结果，退出调用 Agent 关闭，不直接操作锁或产物文件。

## 3. 迁移与失败合同

旧会话必须经用户显式打开，在写入会话使用事实前迁移。原 Header 创建时间决定新目录；原消息、Entry ID、序号、时间戳、Workspace 和 Shell 保持。父引用按既有顺序补齐。

迁移在必要锁内保存原始备份、写临时新日志并完整校验，然后发布新位置。进程中断不能产生两个各自接受写入的同 ID 会话；未完成迁移可回到旧来源或继续完成，不能猜测最近文件作为权威。备份位于新会话目录内，随会话共同清理。

索引是缓存：JSONL 已提交而索引失败时保留已提交事实；缓存丢失、损坏、被旧副本覆盖、指向错误 Header 或尾部增长时都应能校验重建。任何恢复不执行旧工具。

产物写入失败与工具执行失败分开：命令可以成功但原文未完整保存，ToolResult 必须如实表达两者。只有已持久化、归属可验证的产物才有可读引用。首期可大输出 Tool 的非空原文统一保留，避免在批次预算确定前丢失可回读内容；分页按实际结果额度推进游标。

## 4. 实施顺序与协作

1. T001：核心文件迁移与 Agent 关闭入口，保持现有生产调用链可构建。
2. T002：按时间创建/定位、Schema 2 与旧会话迁移；会话使用标记贯通打开和关闭。
3. T003：有效记录、恢复索引与存储进度刷新；为后续模型上下文读取准备事实合同。
4. T004：工具原文存储与有界预览，连接工具执行和消息持久化。
5. T005：专用产物读取与 TUI 引用呈现，覆盖长行、搜索和访问范围。
6. T006：过期清理工作者与生产启动/关闭接入。
7. T007：联合验证、一次文档和代码审阅、更新唯一 Report 与 Tasks，提交实现。

可以并行实现 Session 存储与工具产物两条明确路径。Session 执行 Agent 持有 `session/` 中除 `artifacts.ts`、`cleanup.ts`、`cleanup-worker.ts` 外的实现与对应 Session 测试；工具执行 Agent 持有产物、Tool 与 Message/Loop 的结果连接。主 Agent 负责目录迁移、Agent 生命周期、TUI、清理和集成。共享合同先沟通，不交叉覆盖文件。

执行 Agent 自己运行约定定向测试并报告结果；主 Agent 只补集成及证据缺口，不在相同代码版本重复定向测试。

## 5. 验证与阶段验收

修改代码前运行一次 `pnpm verify` 建立基线。开发中按完整小步运行相应定向测试，最终阶段执行一次 `pnpm verify`；失败后只重跑受修复影响的检查，必要时补全门禁。

Session 路径的定向命令：

```text
pnpm exec vitest run apps/agent/test/session.test.ts apps/agent/test/startup.test.ts apps/agent/test/session-recovery.test.ts
```

工具产物路径的定向命令：

```text
pnpm exec vitest run apps/agent/test/tool-artifacts.test.ts apps/agent/test/read-only-tool.test.ts apps/agent/test/command-tool-loop.test.ts apps/agent/test/tool-scheduling.test.ts
```

主 Agent 的新增集成验证：

```text
pnpm exec vitest run apps/agent/test/session-cleanup.test.ts apps/tui/test/main.test.ts apps/tui/test/tui.test.ts
pnpm verify
```

必须覆盖：日期与同毫秒目录；定位缓存损坏；真实旧 Schema 1 日志迁移及中断；UTF-8 恢复位置；第二进程仅打开不会误报历史变化；大结果与批次输出；原文缺失/限额/写失败；长行游标；跨会话拒绝；空闲会话保护；清理与打开竞争；退出释放资源。

测试使用临时数据根与确定性流，不读取或清理用户真实 Session。清理验证限定到已创建的测试目录，并校验绝对归属。生产启动的清理采用可替换时间/进程存活依赖验证，不需要对真实过期会话做演示删除。

## 6. 提交与继续条件

- 本 Plan 与 Tasks、已接受 Spec 先做一次文档提交；此时不夹带业务代码。
- 阶段门禁和一次标准/Spec 审阅通过后，更新 Tasks、唯一 `report.md` 和本 Plan 的实施结果，做一次实现提交。
- 提交采用中文说明问题、办法和效果；不推送、不创建 PR。
- 通过阶段验收后直接编写 Plan 02 与 Tasks 增量，并按同样顺序推进。只有真实阻塞、不可由既有授权解决的产品变化或用户主动暂停才中断。
- 未通过门禁时定位并修复，不把未完成范围移到下一阶段伪称通过。
