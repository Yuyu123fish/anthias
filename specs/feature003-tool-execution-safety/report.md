# Feature 003：Tool 执行调度与安全策略实施报告

状态：已实现
报告日期：2026-09-04

## 开发者速览

> **一句话**：Agent 已具备双权限模式、三态安全决策、只读四并发和精确文件确认。<br>
> **核心做法**：统一执行入口先预检和决策，再确认与执行，结果按模型源顺序提交。<br>
> **边界**：没有 OS 沙箱，也未调用真实 Provider、外网或凭据。<br>
> **风险 / 未验证**：获批命令仍拥有当前用户权限，静态规则不能证明命令完全安全。<br>
> **当前 / 请审阅**：完整验证为 16 个文件、124 个测试通过，等待开发者验收。

- 对应 Spec：[spec.md](spec.md)
- 对应 Plan：[plan.md](plan.md)
- 任务事实源：[tasks.md](tasks.md)
- 取舍依据：[research.md](research.md)

## 1. 已成立的行为

- 默认 Agent 模式向模型提供六个既有 Tool；Plan 模式只提供 read_file、glob、grep。活动 Run 使用启动时的模式快照，空闲时可通过 Agent Interface 或 TUI 的 /mode 命令切换。
- 执行入口统一形成 allow、ask 或 deny。Plan 副作用和 hard danger 在 approval 与执行器之前结束；普通 Agent 命令和文件修改继续逐次确认。
- 命令确认展示当前权限模式、风险摘要和真实执行边界。用户会明确看到命令以 Anthias 当前用户权限运行，没有 OS 隔离。
- 文件修改继续支持工作区相对路径，同时兼容工作区内绝对路径；Agent 模式可以为一个合格的工作区外绝对文件请求一次性确认。
- 完整纯只读 Tool Batch 使用固定四 worker；含副作用、未知或无效调用的批次整体保持串行。
- TUI 展示初始模式、模式切换结果、approval 安全信息，以及带 Tool 名和短 toolCallId 的 start、update、end 事件。

## 2. 入口、调用链与职责

主要调用链为：

TUI 或启动配置 → Agent 创建与模式状态 → Run 快照模式和 Tool definitions → Agent Loop 规划整个 Tool Batch → ToolRunner 预检与 Policy → 必要时 approval → 具体 Tool executor → Tool outcome → 按源顺序写入 Session 并进入下一次模型请求。

职责边界如下：

- run.ts 持有 Agent 的公开状态、模式切换、单 activeRun 和 approval 生命周期。
- agent.ts 持有批次调度、并发上限、事件时序、outcome 收集和提交顺序。
- tool-policy.ts 是无 I/O 的纯决策模块，只返回稳定 ruleId、风险和执行边界。
- tool-runner.ts 是预检、Policy、approval 计划和执行器之间的唯一内部入口。
- read-only-tool.ts、file-tool.ts、command-tool.ts 分别持有具体读取、文件副作用和命令生命周期。
- TUI 只调用 Agent Interface 并呈现 AgentEvent，不复制安全判断或业务生命周期。
- package 公开面只增加 PermissionMode、AgentState.permissionMode 和模式切换结果；Policy、scheduler 与 ToolRunner 仍为内部实现。

## 3. 调度、取消与结果顺序

- 六个受控只读调用实测最大并发为 4；混合批次实测最大并发为 1。
- tool_execution_start 按 ToolCall 源顺序发布，tool_execution_end 按真实完成顺序发布。
- ToolResult、Session JSONL 和下一次模型请求始终按 ToolCall 源顺序排列。
- 单个只读调用失败不会取消兄弟调用。abort 后 worker 不再领取新任务，执行中调用接收 AbortSignal，未开始调用得到唯一 aborted 结果。
- 预检阶段不再无限等待 abort；晚到的预检结果不会进入执行。
- 若执行器已经完成副作用再收到 abort，结果保持 completed；只有取消期间真实失败的执行映射为 aborted。
- run_end 在调用结果和已知资源生命周期收口后发布。命令超时和取消继续终止进程树，并通过 cleanupUncertain 表达无法确认的清理结果。

## 4. 安全边界

- 危险命令 classifier 只检查文本，不调用 Shell、解释器、网络或系统 API。测试中的危险命令仅作为纯函数输入，从未交给命令执行器。
- hard deny 覆盖已约定的 Unix 根目录破坏、磁盘格式化和设备写入、fork bomb、远程脚本管道执行，以及 Windows 磁盘、启动、根卷和机器注册表破坏类别。
- 普通且可完整展示的未知命令进入 HITL，不会因静态检查未命中而自动执行。
- command cwd 必须位于工作区并避开活动 Session；固定 Shell 不接受模型提供的 executable 或参数。子进程环境使用允许列表，不转发约定的 Provider Token、代理凭据、ANTHIAS_ 变量或 NODE_OPTIONS。
- 外部文件拒绝 UNC、设备命名空间、ADS、卷根、目录、Glob、系统保护目录、Session 和不可信 Reparse Point。确认绑定父目录身份、目标身份和 SHA-256，执行前再次核对，并通过同目录临时文件与 rename 提交。
- 文件复核是应用层防护，不是操作系统 capability。没有 OS 沙箱时，获批命令仍可访问当前用户有权访问的工作区外文件、网络和系统资源。

## 5. 验证证据

验证环境：

- Microsoft Windows 11 家庭版 中文版，build 26100
- Node.js v24.13.1
- pnpm 10.33.0
- PowerShell 7.5.4

最终执行 pnpm verify，结果为：

- Biome 检查 50 个文件，无错误、无格式修改。
- TypeScript 测试类型检查通过。
- TypeScript project build 通过。
- Vitest 共 16 个测试文件、124 个测试全部通过。

额外只读审计确认：

- package.json 与 pnpm-lock.yaml 没有变化，没有新增 sandbox 依赖。
- 生产目录没有 sandbox-runtime、AppContainer、restricted token、ACL/WFP 或伪隔离实现。
- 进程启动点仍只有受控 command executor 和 Windows 进程树清理；Policy 中的正则 exec 不是系统进程。
- Session 源码与 Schema 1 没有修改。
- Spec 与仓库规范双轴代码审查提出的问题均已修复，并由定向测试与完整验证覆盖。

## 6. 未验证项与 Git 状态

- 未使用真实 Provider、外部网络、付费 API 或真实凭据。
- 未把自动化 TUI 测试扩大为真实 Provider 下的长期人工交互验收。
- 未实现 OS 沙箱、低权限账户、文件系统 capability 或网络隔离；这些能力若未来需要，应另开 Feature。
- 报告生成时 HEAD 为 7832b76，Feature 实现仍是未提交工作区变更；没有推送或创建 PR。
- 状态“已实现”只表示实现与约定验证完成，最终“已验收”仍由开发者确认。
