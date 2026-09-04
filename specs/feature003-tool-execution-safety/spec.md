# Feature 003：Tool 执行调度与安全策略

状态：已验收

## 开发者速览

> **一句话**：让只读 Tool 有界并发，并让每个副作用在执行前经过可解释的安全决策。<br>
> **核心做法**：纯只读批次最多四并发；其他批次串行；统一 `allow | ask | deny`。<br>
> **边界**：Plan 只读，危险命令不可批准；普通命令仍以当前用户权限运行。<br>
> **风险 / 未验证**：没有 OS 沙箱，获批命令可触达当前用户可访问的主机资源。<br>
> **当前 / 请审阅**：开发者已确认验收；后续 TUI 体验改造作为新的 Feature 推进。

- 文档类型：Spec
- Feature 目录：feature003-tool-execution-safety
- 关联基线：[Feature 002](../feature002-tool-loop-and-session/spec.md)、[技术基线](../../docs/technical-baseline.md)
- 取舍依据：[Windows OS sandbox 取舍调研](research.md)

## 1. 问题

Feature 002 已建立六个 Tool、逐次副作用确认和线性 Session，但同一 AssistantMessage 中的 ToolCall 仍全部串行。多个独立读取会累加等待时间，直接并发所有 Tool 又会让修改、命令、预览和确认产生竞态。

当前确认机制还不能表达三种不同结果：无需确认即可执行、需要人判断、无论是否确认都不得执行。命令继承 Anthias 当前用户权限，若只显示命令文本而不说明真实边界，用户容易把工作区 `cwd` 误解为文件或网络隔离。

## 2. 目标

- 同一 AssistantMessage 的纯只读 ToolCall 在固定上限内并发。
- 任何包含副作用、未知或无效 Tool 的批次保持源顺序串行。
- Agent 与 Plan 两种权限模式同时约束模型可见 Tool 和执行入口。
- 每个 ToolCall 形成 `allow | ask | deny` 决策；危险命令在 approval 前硬拒绝。
- 文件副作用绑定一个精确目标与预览；外部绝对文件必须逐次确认。
- 命令确认展示真实主机权限边界，并继续保留超时、取消、输出限制和进程树清理。
- TUI 能清楚展示模式、风险、边界和并发 Tool 的归属。

## 3. 非目标

- 不实现、集成或模拟 OS sandbox、容器、VM、低权限账户、ACL、WFP 或网络隔离。
- 不保证获批命令只能读写工作区；`cwd` 不是安全边界。
- 不允许模型或用户通过 approval 覆盖 hard deny。
- 不把读 Tool 扩展到工作区外，也不允许 command `cwd` 离开工作区。
- 不改变 Session Schema 1，不新增多 Run、多 Agent、依赖图调度或动态并发配置。
- 不调用真实 Provider、外部网络或真实凭据进行验收。

## 4. 权限模式

`PermissionMode` 只有 `agent` 与 `plan`：

- `agent`：模型可见六个既有 Tool。只读 Tool 自动执行；`edit_file`、`write_file`、`execute_command` 仍逐次确认。
- `plan`：模型只看见 `read_file`、`glob`、`grep`。伪造、陈旧或模型自行构造的副作用 ToolCall 在执行入口直接 denied，不产生 approval。

兼容 Feature 002，默认模式为 `agent`。启动方可用 `--mode agent|plan` 选择初始模式；TUI 提供 `/mode`、`/mode agent`、`/mode plan`。模式只属于当前 Agent 运行时，不写入 Session。只有空闲时可切换；活动 Run 中必须返回 busy，当前 Run 使用启动时的模式快照。

## 5. Tool Policy

内部 Policy Decision 是不可变判别联合：

- `allow`：在既有执行边界内直接运行。
- `ask`：展示 `riskSummary` 与 `executionBoundary`，获得一次性批准后运行。
- `deny`：直接形成 denied ToolResult，不创建 approval，不启动 Tool。

决策顺序固定为：输入与能力预检 → Permission Mode → 安全分类 → `allow | ask | deny`。输入无效、目标不存在等预检问题是 failed；Plan 副作用与 hard danger 是 denied。

每个决定带稳定 `ruleId`。最低规则如下：

| 类别 | 结果 | 最低覆盖 |
| --- | --- | --- |
| 工作区只读 Tool | allow | `read_file`、`glob`、`grep` |
| Agent 文件副作用 | ask | 工作区内或一个合格的外部绝对文件 |
| Agent 普通命令 | ask | 明确提示当前用户权限、无 OS 隔离 |
| Plan 副作用 | deny | write、edit、command |
| Unix 高危破坏 | deny | 根目录递归删除、`mkfs`、`dd` 写设备、根目录 `chmod -R 777`、fork bomb、覆盖磁盘设备 |
| 远程脚本直执行 | deny | `curl` 或 `wget` 输出直接管道给 `sh` / `bash` |
| Windows 高危破坏 | deny | 格式化或清空磁盘、根卷递归删除、启动配置破坏、强制删除 HKLM 根路径 |
| 无法审阅的包装 | deny | encoded command、动态求值或超过有限递归深度的 shell wrapper |

分类器只检查字符串，不调用解释器、Shell、系统 API 或网络。字面量 `pwsh` / `powershell -Command`、`cmd /c`、`sh` / `bash -c` 最多递归检查三层。一般未知但可完整展示的命令不能因“无法证明安全”而自动执行：在 Agent 模式进入 `ask`，由 HITL 根据真实副作用边界决定。

approval 只绑定当前 Run、requestId、ToolCall、模式、完整准备结果与 Policy 元数据。拒绝、重复响应、旧 Run、错误 requestId 或准备结果变化都不能执行。

## 6. 路径与命令边界

### 6.1 文件 Tool

- 相对路径和规范化后位于 workspace 的绝对路径按既有 workspace 规则处理。
- `read_file`、`glob`、`grep` 始终限制在 workspace，且不能访问活动 Session 目录。
- Agent 模式的 `edit_file` / `write_file` 可以请求一个本地绝对外部文件；每次 approval 只授权该精确目标。
- UNC、设备命名空间、Alternate Data Stream、卷根、目录、Glob、空 basename、系统保护目录、活动 Session 目录以及不可信 Reparse Point 不可批准。
- approval 前记录目标真实路径、父目录、类型和已有内容 SHA-256；执行前重验。发生替换、链接变化、父目录变化或内容变化时 failed，不留下部分写入。
- 文件仍使用同目录临时文件和原子 rename；`edit_file` 仍是精确一次替换。

### 6.2 命令 Tool

- command `cwd` 必须位于 workspace，且不能是活动 Session 目录。
- 只使用 Session 已解析的固定非交互 Shell，不接受模型提供 executable 或 shell 参数。
- Anthias 传给子进程的环境由允许列表构造，不转发 `ANTHIAS_*`、Provider Token、代理凭据、`NODE_OPTIONS` 等敏感或可注入变量；Windows 与 Shell 仍可能自行生成标准身份变量。
- 所有普通命令在 Agent 模式逐次 `ask`。界面必须展示：命令以 Anthias 当前用户权限执行、没有 OS 沙箱、可以访问工作区外文件和网络。
- timeout、abort、输出上限、进程树终止和 `cleanupUncertain` 沿用 Feature 002；cleanup 不可信时不得显示为成功。

## 7. 调度与确定性

Tool Batch 是同一条完整 AssistantMessage 中按内容顺序出现的全部 ToolCall：

- 只有全部调用都是已识别且输入有效的只读 Tool 时，使用 `parallel_read_only`。
- 只要含副作用、未知或无效 Tool，整个批次使用 `source_order_serial`。
- 并发实现使用固定四 worker 的递增索引队列，不为整批创建无界活动任务。
- `tool_execution_start` 按源顺序发布；`tool_execution_end` 按真实完成顺序发布。
- 每个调用无论 success、failed、denied 或 aborted，都恰好形成一个 outcome。
- ToolResult message、Session JSONL 与下一次模型请求始终按 ToolCall 源顺序提交。
- 一个只读调用失败不取消兄弟调用。abort 停止领取新任务、取消正在运行的调用，并为未开始项形成 aborted 结果；`run_end` 必须晚于全部任务与资源收口。
- 串行批次最多一个执行和一个 approval；副作用预览只在轮到该调用时生成。

## 8. 用户流程

1. 用户以默认 Agent 模式或 `--mode` 启动 TUI，也可在空闲时用 `/mode` 查看或切换。
2. Run 启动时快照当前模式，并向模型只提供该模式允许的 Tool definitions。
3. 模型给出 Tool Batch；Agent 选择一种批次调度方式。
4. 只读调用自动执行。副作用调用先准备和分类：deny 直接返回；ask 展示目标、预览、风险和执行边界。
5. 用户批准或拒绝；批准只对当前请求生效。
6. Agent 按源顺序持久化所有 ToolResult，再继续模型循环。
7. 用户可随时取消；Agent 收口运行中与排队任务后恢复空闲。

## 9. 公开 Interface 与事件

- AgentState 新增 `permissionMode`，不公开 Policy、classifier、scheduler 或 ToolRunner 类型。
- Agent 新增空闲切换模式的方法，明确返回 accepted 或 busy。
- ToolApprovalRequest 新增 `permissionMode`、`riskSummary`、`executionBoundary`。
- AgentEvent 新增模式变更事件；Tool 事件继续携带 `toolCallId` 和 `toolName`，支持并发归属。
- Session Schema、消息角色、六个 Tool 名称和单 activeRun 合同保持不变。

## 10. 验收标准

1. Agent / Plan 的 Tool 可见性、执行入口保险丝、默认值、CLI 与空闲切换行为一致。
2. 八类最低危险规则及常见大小写、空白、wrapper 变体稳定 hard deny；fixture 从不进入 shell 或 host API。
3. 普通命令 ask 的风险说明准确；批准后只执行一次，拒绝、旧响应和重复响应均不执行。
4. command `cwd` 不出 workspace / Session，子进程不继承约定敏感环境；文档和 TUI 不声称有 OS 隔离。
5. 外部单文件写入仅在 Agent 模式、合格绝对目标和一次 approval 下成立，TOCTOU 或链接变化 fail-closed。
6. 至少六个受控只读调用实测最大并发为 4；混合批次实测最大并发为 1。
7. 并发 start 源顺序、end 完成顺序、ToolResult / JSONL / 下一模型请求源顺序均有确定性证据。
8. 单项失败与四种取消位置都能有限收口；每个 ToolCall 恰有一个结果，无残留任务或句柄。
9. TUI 正确显示模式、busy、风险边界、denied / failed / aborted，以及乱序完成调用的归属。
10. Session Schema 1、unknown / interrupted 恢复、Feature 002 行为和 package 公开面无回归。
11. `pnpm verify` 通过；不运行危险命令、真实 Provider、外网或凭据验证。
