# Feature 003：Tool 执行调度与安全策略任务

状态：已实现

## 开发者速览

> **一句话**：十二项任务已全部完成，覆盖权限、安全策略、外部文件、并发与 TUI。<br>
> **核心做法**：三个 Stage 均通过定向门禁，并以完整 pnpm verify 收口。<br>
> **边界**：不做 OS 沙箱；危险 fixture 只进入纯 classifier，未执行。<br>
> **风险 / 未验证**：真实 Provider、外网和长期人工 TUI 体验未验证。<br>
> **当前 / 请审阅**：实现与约定验证已完成，工作区变更等待开发者验收。

- 对应 Spec：[spec.md](spec.md)
- 对应 Plan：[plan.md](plan.md)

任务状态使用：`待开始`、`进行中`、`已完成`、`阻塞`。

## Stage 01：权限与安全决策

### T001：Permission Mode 与 Tool 可见性

状态：已完成

- [x] 定义 `agent | plan`，默认 Agent；AgentState 暴露当前模式。
- [x] Run 启动时快照模式并提供对应 Tool definitions。
- [x] 执行入口拒绝 Plan 副作用，不产生 approval。
- [x] Agent 空闲切换返回 accepted，活动 Run 返回 busy。
- [x] 启动配置与 CLI 支持 `--mode agent|plan`。

### T002：Policy 与危险命令 classifier

状态：已完成

依赖：T001

- [x] 实现内部 `allow | ask | deny` 与稳定 ruleId。
- [x] 覆盖 Spec 最低 Unix、远程脚本、Windows 破坏和 opaque wrapper 规则。
- [x] 最多三层解析字面量 Shell wrapper，不执行任何 fixture。
- [x] 证明 hard deny 不进入 approval、command executor 或系统 API。

### T003：Approval 与命令真实边界

状态：已完成

依赖：T002

- [x] approval 增加模式、风险摘要与执行边界，并绑定完整准备结果。
- [x] 普通 Agent 命令逐次 ask；界面数据明确“当前用户权限、无 OS 隔离”。
- [x] command `cwd` 仅限 workspace 且排除 Session 目录。
- [x] 子进程环境使用 allowlist，保留超时、取消、输出限制和进程树清理。

### T004：外部单文件写入

状态：已完成

依赖：T003

- [x] workspace 内绝对路径兼容既有语义。
- [x] Agent 可为一个合格的外部绝对文件创建 ask。
- [x] 拒绝 UNC、设备路径、ADS、根、目录、Glob、系统目录、Session 和 Reparse Point。
- [x] 执行前重验父目录、身份和 SHA-256；stale 时不写入。

### T005：Stage 01 门禁

状态：已完成

依赖：T001–T004

- [x] Permission、Policy、file、command、approval、startup、Agent Loop 定向测试通过。
- [x] `pnpm check` 通过；Session Schema 1 与 Feature 002 行为无回归。

## Stage 02：只读有界并发

### T006：Tool outcome 与串行提交 seam

状态：已完成

依赖：T005

- [x] 每个 ToolCall 形成带源索引且唯一的 outcome。
- [x] 执行事件与 ToolResult 提交分离，先保持源顺序串行。
- [x] denied / failed 不伪造 execution start，approval 仍逐次 just-in-time。

### T007：固定四 worker 的纯只读并发

状态：已完成

依赖：T006

- [x] 整批只读才并发；混合、未知或无效批次整体串行。
- [x] 递增索引队列最多四个活动执行，start 按源顺序。
- [x] end 按实际完成，outcome 按源索引收集并提交。

### T008：失败、取消与顺序保证

状态：已完成

依赖：T007

- [x] 单个只读 failed 不取消兄弟调用。
- [x] abort 覆盖准备中、start gate、执行中与排队中，不再领取新任务。
- [x] 每个调用恰有一个结果，run_end 晚于全部任务和资源收口。
- [x] ToolResult、JSONL 与下一模型请求保持源顺序。

### T009：Stage 02 门禁

状态：已完成

依赖：T006–T008

- [x] 受控测试证明只读最大并发为 4、混合批次为 1。
- [x] 调度、Tool Loop、Session、abort 定向测试和 `pnpm check` 通过。

## Stage 03：TUI 与整体闭环

### T010：TUI 模式与安全呈现

状态：已完成

依赖：T009

- [x] 展示初始模式；实现 `/mode` 查询、切换与 busy。
- [x] approval 展示模式、风险、真实执行边界、目标和预览。
- [x] start / update / end 使用 Tool 名和短 toolCallId 归属并发输出。

### T011：端到端回归与安全审计

状态：已完成

依赖：T010

- [x] 验证公开 Agent Interface、实际 Session JSONL 与第二次模型请求。
- [x] 检查 hard deny、Plan 保险丝、外部路径 TOCTOU、命令环境与资源清理。
- [x] 搜索并确认无 sandbox 依赖、伪隔离 API、敏感值或 host command 绕过。
- [x] 运行完整 `pnpm verify`，确认无后台进程和残留句柄。

### T012：Report 与 Feature 收口

状态：已完成

依赖：T011

- [x] 创建唯一 `report.md`，记录能力、调用链、验证和“无 OS 沙箱”边界。
- [x] 仅在全部验证通过后把 Spec、Plan、Tasks、Report 标为“已实现”。
- [x] 汇报工作区与 Git 状态；不提交、不推送、不创建 PR。

## 授权

- 开发者已授权连续实施本文件全部任务。
- 删除 OS sandbox 后，不需要下载依赖、UAC 或机器级状态变更。
- 仓库代码修改与安全本地验证已授权；真实 Provider、外网、凭据、提交、推送和 PR 未授权。
