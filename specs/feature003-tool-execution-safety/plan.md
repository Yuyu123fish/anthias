# Feature 003：Tool 执行调度与安全策略实施计划

状态：已验收

## 开发者速览

> **一句话**：用三个可验证 Stage 完成权限、安全决策、只读并发与 TUI 闭环。<br>
> **核心做法**：先收紧执行入口，再重构有序 outcome，最后接入 TUI 并全量回归。<br>
> **边界**：不安装依赖、不做 OS 沙箱，不调用真实 Provider 或危险命令。<br>
> **风险 / 未验证**：并发取消、外部路径 TOCTOU 和 Windows 命令分类最易出错。<br>
> **当前 / 请审阅**：三个 Stage 均已实现、通过完整验证并由开发者验收。

- 对应 Spec：[spec.md](spec.md)
- 任务事实源：[tasks.md](tasks.md)
- 调研结论：[research.md](research.md)

## 1. 当前基线

- Feature 002 已提供六个 Tool、线性 Model → Tool → Model 循环、逐次 approval、Session Schema 1、命令 timeout / abort / 输出限制和进程树清理。
- ToolCall 目前逐个准备、执行并立即提交；没有 Permission Mode、统一 Policy 或批次并发。
- 文件 Tool 只接受 workspace 相对路径；命令固定使用 Session Shell 和 workspace `cwd`，但继承过多宿主环境且仍拥有当前用户权限。
- TUI 能显示 Tool 事件和 approval，但没有模式命令，也没有完整安全边界说明。

## 2. 实施原则

- Agent 是权限、Policy、调度、approval 与结果顺序的唯一权威；TUI 只调用公开 Interface。
- 先通过测试固定公开行为，再完成最小实现；不增加 Registry、Manager 或未来 sandbox seam。
- Policy 与危险 classifier 保持纯函数；危险 fixture 只作为字符串数据，不交给任何执行器。
- Session 保持串行 writer；并发只存在于 Agent 内部的只读执行阶段。
- 每个 Stage 完成定向验证后直接进入下一 Stage，这是本轮“实现整个 Plan 与 Tasks”的明确授权；Git 提交仍需单独授权。

## 3. Stage 01：权限与安全决策闭环

### 目标

让模型可见能力和执行入口服从同一个 Permission Mode，并把全部 ToolCall 收敛到可解释的 `allow | ask | deny`。同时完成命令真实边界、环境收敛和外部单文件 approval。

### 实施顺序

1. 添加 `PermissionMode`、AgentState 与空闲切换方法；启动配置和 TUI CLI 接受 `--mode`。
2. 从固定 Tool definitions 改为按 Run 模式快照生成，执行入口再次拒绝 Plan 副作用。
3. 添加内部 Policy Decision 和纯命令 classifier；hard deny 在 approval 与执行器之前结束。
4. 扩展 approval 元数据与一次性绑定；命令说明当前用户权限和无 OS 隔离。
5. 收紧 command `cwd` 与环境 allowlist；保留 Feature 002 的 timeout、abort 与进程树清理。
6. 扩展文件准备层，支持一个合格的外部绝对文件，并在执行前重验目标身份与指纹。

### 验证门

- Permission、Policy、command、file、approval、startup 与 Agent Loop 定向测试通过。
- spy 证明 hard danger 和 Plan 副作用的 approval / command / file 执行次数均为零。
- 原有 workspace 路径、Session 保护、stale target 和命令资源清理测试无回归。
- `pnpm check` 通过。

## 4. Stage 02：只读有界并发与有序提交

### 目标

把“执行结果形成”和“消息持久化”分离，交付固定四 worker 的纯只读并发，同时保持对模型与 Session 的确定性顺序。

### 实施顺序

1. 将单个 ToolCall 归约为带源索引的 outcome；success、failed、denied、rejected、aborted 都只产生一次结果。
2. 先用新的 outcome seam 保持串行，证明既有事件、approval 和 JSONL 顺序不变。
3. 对完整 Tool Batch 选择一次调度方式；实现四 worker 递增索引队列和 source-order start gate。
4. 允许执行与 end 乱序，在所有 outcome 收口后按源索引提交 ToolResult。
5. 完成单项失败、准备中 / gate 中 / 执行中 / 排队中 abort，以及混合批次串行保险丝。

### 验证门

- 受控执行器证明纯只读实测并发大于 1 且不超过 4，混合批次最大并发为 1。
- start 源顺序、end 完成顺序、ToolResult / JSONL / 下一模型请求源顺序均有断言。
- 单项失败不取消兄弟调用；abort 有限收口，不再领取新任务且每个 ToolCall 有一个结果。
- Tool Loop、Session、abort 与 `pnpm check` 通过。

## 5. Stage 03：TUI 与整体闭环

### 目标

让开发者能在终端准确看见和控制权限模式、安全边界与并发调用归属，并完成 Feature 报告和全量回归。

### 实施顺序

1. TUI 展示初始模式，实现 `/mode` 查询与空闲切换，活动 Run 显示 busy。
2. approval 展示 `permissionMode`、`riskSummary`、`executionBoundary`、完整目标与预览。
3. start / update / end 全部以 Tool 名和短 toolCallId 标注，不依赖“最近启动 Tool”。
4. 校对错误、拒绝、取消和 cleanup uncertain 文案，明确命令没有 OS 隔离。
5. 运行定向与全量验证，完成安全审计、公开面检查和唯一 `report.md`。

### 验证门

- TUI fake 覆盖模式、busy、approval、denied / failed / aborted 和并发 end 逆序。
- 搜索生产调用链，确认不存在 sandbox 依赖、伪隔离状态或 hard deny 绕过路径。
- `pnpm verify` 通过，无后台进程、真实 Provider、外网、危险命令或敏感值。
- Spec、Plan、Tasks、Report 只在全部门禁通过后标为“已实现”。

## 6. 风险与停止条件

- 若外部路径无法在 Node / Windows 现有 API 下可靠重验，不放宽到目录或 Glob，只保留能证明的精确文件能力。
- 若并发要求改变 Session Schema、公开 Run 生命周期或 approval 并发语义，停止并回到 Spec。
- 若命令分类需要执行、解析脚本 AST 或访问网络才能判断，保持保守 deny / ask，不引入隐式求值。
- 若发现命令仍能通过模型控制 executable、shell 参数或 `cwd`，先修复该入口再继续。
- 若已有用户修改与实现范围重叠，保护现场并停止，不重置或覆盖。

## 7. 汇报要求

最终报告必须说明：

- Permission Mode、Policy、路径、命令真实边界和并发的成立行为；
- 入口、关键调用链、事件与 Session 顺序；
- 取消、失败、TOCTOU、进程树与资源释放边界；
- 实际验证命令、数量、结果与未验证项；
- “无 OS 沙箱”限制和当前 Git 状态；
- 未经授权不提交、不推送、不创建 PR。
