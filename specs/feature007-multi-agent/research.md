# MultiAgent：实现调研与 Anthias 方案建议

状态：调研完成；已归入 Feature 007，最终决定以 Spec 为准。

## 开发者速览

> **一句话**：用同一套 Agent 运行能力，支持独立委派的 SubAgent 和持续协作的 AgentTeam。<br>
> **核心做法**：复用 SessionAgent，加入受控 Git/worktree、不可递归委派和有来源的协作记录。<br>
> **边界**：首版同进程、有限成员；可写成员使用独立 worktree，基于明确提交启动。<br>
> **风险 / 未验证**：Git 整合与回收、Schema 兼容、审批路由和显式恢复需要共同验收。<br>
> **当前 / 请审阅**：相关决定已进入 Feature 007 Spec，研究保留来源事实与当时建议。

核验日期：2026-09-06。本调查已归入 Feature 007；实现和验收状态以同目录 Spec、Tasks 与 Report 为准。

## 研究问题与证据边界

研究对象是 pi、Codex 和 Claude Code 如何委派工作、隔离上下文、传递消息与管理成员生命周期，以及 Anthias 需要增加哪些真实行为。目标是同时覆盖 SubAgent 与 AgentTeam，不建设通用工作流框架。

- Anthias：当前 `main / 596c2cb`，以工作树中的实现和最新产品文档为准。开始时已有 `AGENTS.md`、`README.md`、`docs/product-definition.md`、`docs/technical-baseline.md` 四项未提交修改，本轮保持原样。
- pi：本地参考为 `581d75a89cea21e50d6a26df840352f94427f633`，提交日期 2026-08-13；另实际读取了官方仓库当前 `main` 的 README 与 Subagent 扩展源码，确认下述关键机制。
- Codex：本地 `C:/projects/codex-main` 是没有 `.git` 的源码快照，不能据此断言对应哪个发布版本。当前官方文档和官方 `main` 的通信、等待、控制器与权限代码补充交叉核对。源码 `main` 也不等于用户安装的 Codex 版本。
- Claude Code：依据官方 CLI 文档核对可观察合同，未取得可完整核验的核心实现源码。详见 [Claude Code 专项证据](research-claude-code.md)。
- 研究阶段是源码与文档调查，没有运行 Anthias、pi 或 Claude Code 的真实模型验证，没有重新执行已有自动测试，也未修改实现、提交或推送。

下文“已核实”只说明资料或代码支持该项机制；“建议”属于 Anthias 的待确认设计。

## 三种实现提供了什么参考

### pi：一个工具就能完成有界委派

pi 官方主 README 明确把 Subagents 留给扩展或用户选择的工作流；仓库中的实现位于 `examples/extensions/subagent/`，不能将它描述成 pi 核心自带的 AgentTeam。[官方主 README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)

扩展示例启动独立 `pi` 子进程，使用 JSON 输出，传入任务、模型和工具选择；它提供单任务、最多 8 项的并行批次（4 并发）与串行链。子进程通过 `--no-session` 运行，结果回到父 Tool；这条路径适合一次委派，不直接提供可长期保留的团队会话。[扩展说明](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent)、[扩展源码](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/examples/extensions/subagent/index.ts)

可借鉴的是上下文隔离、有限并发、结果摘要和在工具卡片内展示执行过程。Anthias 已经拥有自己的 Agent 与权限体系，照搬外部 CLI 启动方式会增加模型配置、审批和进程关闭的衔接成本；因此本次不建议复制其进程结构。

### Codex：委派运行具有统一的所有者

当前源码中，一棵根任务树共享 `AgentControl`，各成员保有自己的 Agent 线程；控制器负责成员查找、通信、运行限制和结果通知。这说明可以集中管理协作，同时保留独立消息历史。[控制器源码](https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/agent/control.rs)

MultiAgent V2 特意区分两种操作：`send_message` 使用 `QueueOnly`，`followup_task` 使用 `TriggerTurn`。普通信息投递与要求开始新一轮工作不是同一语义；`wait_agent` 等待输入队列活动，可因新消息、用户输入或超时返回。[发送信息](https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/tools/handlers/multi_agents_v2/send_message.rs)、[后续任务](https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/tools/handlers/multi_agents_v2/followup_task.rs)、[等待](https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs)

子 Agent 创建会重新应用父 Run 当前的工作目录、审批与权限快照，避免角色默认值覆盖实际运行约束。官方文档也说明子 Agent 继承权限，并支持在交互界面中呈现来源线程的审批。[运行时继承源码](https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/tools/handlers/multi_agents_common.rs)、[官方 Subagents 文档](https://learn.chatgpt.com/docs/agent-configuration/subagents)

当前源码还为工作 Agent 提供有界的根会话授权视图，并保留根历史版本信息。这里只借鉴“授权从可信根会话取得”的职责，不照搬 Guardian 的消息选择或截断规则。[根授权视图源码](https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/agent/control/user_authorization.rs)

本地快照同时存在较早的 `multi_agents` 和 `multi_agents_v2` 两套工具表面，研究不能把其中所有操作混成一份稳定公开合同。也没有把 Codex 的任务树直接称为 Claude Code 式共享任务板产品。

### Claude Code：明确区分委派与团队协作

官方文档把 Subagents 描述为独立上下文的任务执行者，结果回到主 Agent；Agent teams 则由独立 Session 组成，成员可以直接通信，并使用共享任务列表协调。团队目前仍标为实验特性。[Subagents](https://code.claude.com/docs/en/sub-agents)、[Agent teams](https://code.claude.com/docs/en/agent-teams)

适合借鉴的是语义：一次任务、一个返回结果，与保留成员上下文、共享任务、持续讨论，确实是两类使用方式。具体继承、后台运行、关停和恢复限制见 [专项证据](research-claude-code.md)。

### 对 Anthias 的取舍

| 参考 | 借鉴 | 本次不直接复制的部分 |
| --- | --- | --- |
| pi | 独立任务、结果摘要、有限并发、工具过程展示 | 每次启动另一个完整 CLI，以及链式工作流预设 |
| Codex | 统一持有子 Agent、消息与任务分离、权限继承、事件等待 | 多层任务树、复杂角色配置、驻留与恢复体系 |
| Claude Code | SubAgent / Team 的区别、直接通信、共享任务与成员保留 | 分屏进程组织、完整任务认领协议与会话恢复功能集 |

## Anthias 的实际起点

目前具备能复用的运行基础：

- [agent.ts](../../apps/agent/src/agent.ts) 持有稳定 Agent 对象、当前会话、外部连接和关闭入口；[session-agent.ts](../../apps/agent/src/session-agent.ts) 已把一个 Session 的 Run、消息、上下文、审批与产物集中起来。
- [agent-loop.ts](../../apps/agent/src/agent-loop.ts) 已实现 Model → Tool → Model，目前每个 Run 最多 12 次普通模型请求，纯只读 Tool 批次最多 4 并发。这是单 Run 限制，尚不是全组限制。
- [Tool Runner](../../apps/agent/src/tool/tool-runner.ts)、[权限审核](../../apps/agent/src/permission/auto-review.ts)、[Session](../../apps/agent/src/session/index.ts) 和 Context 可以复用。固定工具的当前源码实际包括新增的 `read_artifact`，不能只沿用早期“六个 Tool”的历史概括。
- [Feature 006 Report](../../specs/feature006-command-skill-mcp-tui/report.md) 记录了全屏 TUI、Skill 和 MCP 的本地验证；本轮不把这些历史结果当成多 Agent 已验证证据。

现有代码也有四个不能直接沿用的单 Agent 假设：

1. `session-agent.ts` 的 `submitPrompt()` 把输入写成 `UserMessage`；`auto-review.ts` 的 `readAuthorizationSource()` 把这类持久记录识别为真实用户授权。直接用 `child.prompt(parentGeneratedText)` 会混淆来源。
2. 一个 SessionAgent 只有一个 `activeRun` 与 `pendingToolApproval`；稳定 Agent 的审批入口只转发给当前 Agent。多个执行者需要归属明确的审批路由。
3. 稳定 Agent 的 `close()`、会话切换和权限切换目前只围绕当前 SessionAgent 判断忙闲。Team 存在时必须覆盖所有成员。
4. [会话清理](../../apps/agent/src/session/cleanup.ts) 当前按独立 Session 处理；[文件修改](../../apps/agent/src/tool/basetool/file-change.ts) 已校验确认时的目标指纹，但没有跨 Agent 的工作任务所有权。

产品文档目前尚未把多 Agent 编排列为产品前提。本轮用户已提出将它作为新基础功能，并将 worktree 与 Git 工具纳入范围；方案确认后再更新产品描述。这里的 worktree 隔离代码目录，完整会话分叉和运行环境复制不在本次决定之内。

## 本轮已确定的补充与待确认范围

开发者已确定：子 Agent 不能再创建子 Agent；worktree 与 Git 工具纳入本次范围；worktree 从明确的已提交版本创建，并提示未提交修改不会带入。下面的模块划分、存储与交付顺序是据此修订的建议，尚未形成已确认 Spec、Plan 或代码实施授权。

## 两个协作模块与一套 Git 能力

SubAgent 负责一次有界委派，独立执行、返回结果并释放运行资源。完成记录保留；被中断的任务可以由用户明确要求继续。AgentTeam 保留成员上下文和共享任务，由当前主 Agent 担任 Lead，分派任务、处理阻塞并汇总；成员之间可以直接交流。

Team 首版最多一个活动团队，建议最多三名工作成员，与临时 SubAgent 共用名额。任务表只保存说明、负责人、状态、结果或阻塞原因，由 Lead 分派；不加入自主抢单、依赖图调度、嵌套团队或 Lead 接班。

保留 apps/agent 与 apps/tui、同进程运行和当前模型配置。SubAgent 与 AgentTeam 复用内部 SessionAgent、Loop、Context、Tool 和 Permission；稳定 Agent 统一持有成员、Git/worktree、MCP 连接、审批路由和关闭入口。TUI 仍通过同一个 Agent Interface 查看、操作并呈现事实，不持有第二套运行状态。

## 委派必须由运行时限制

| 能力 | 根 Agent / Lead | SubAgent | Team 成员 |
| --- | --- | --- | --- |
| 创建 Agent/Team、增减成员 | 受授权、名额与取消状态限制 | 硬拒绝 | 硬拒绝 |
| 分配其他成员的新任务 | 允许 | 不提供 | 首版由 Lead 负责 |
| 返回结果、报告自己的任务状态 | 允许 | 允许 | 允许 |
| 同 Team 内直接通信 | 允许 | 不提供同级通信 | 允许 |
| Git 查询 | 允许 | 仅自己的受管工作区 | 仅自己的受管工作区 |
| 创建/删除 worktree、提交与整合 | 受授权控制 | 不直接提供 | 不直接提供 |

模型工具表不向成员暴露创建入口；即使模型伪造工具调用，执行端仍根据运行时登记的调用者身份拒绝。角色、根归属与能力集合由创建方确定，不能接受模型参数中自称的 role、parent 或 depth。根 Agent 的并发创建先检查和预留共享名额，失败或取消释放名额。

这保证 Anthias 受管入口不存在递归委派。当前任意 Shell/MCP 仍以用户权限运行，不能据此保证 OS 层面无法启动另一套 Agent 程序。已识别的旁路调用也不能把委派文本当成用户授权放行；若要求对任意脚本都强制阻止派生，需要额外执行隔离。

### 来源、权限和通信

委派、成员消息与成员结果保留发送者、所属根 Session 和稳定消息 ID。内部输入路径与用户 prompt 分开；模型传输层需要映射为某种消息 role，不代表持久化层可以将其视为真实用户授权。

成员权限不超过根用户授权，再按任务能力收紧；Plan 成员不能升为可写模式。AutoAllow 只核对可追溯的根用户记录或真实人工审批，不能采信“用户已同意”的成员自述。审批统一显示来源成员和具体动作，按唯一请求 ID 路由。

普通消息先入队，活动成员在下一次模型请求前消费；明确分配新任务才启动空闲成员。需要已完成成员重新参与讨论时，由 Lead 分配后续任务。等待使用可取消、有界的事件通知，查询状态不调用模型，消息队列和结果长度均有限制。

初始上下文只带任务与必要背景，不复制整个主对话；Skill 正文仍按需加载。成员可使用根 Agent 已连接且明确允许的 MCP 能力，不能自行创建新连接或扩大权限。

## worktree 与 Git 的交付闭环

### 工作目录

可写成员拥有独立 worktree 和本地分支；文件工具、命令默认 cwd 与它的 Session 都绑定该实际目录。不同成员可以并行修改各自目录，同一 worktree 仍只有一个活动写入者。只读调查可以复用主工作区；构建、测试和未知 MCP 调用不能仅凭角色名宣称只读。

不同 worktree 不会实时共享未提交代码。审查或验证另一成员结果时，需要检查明确的结果提交或完成整合的版本，不能验证自己的旧副本。worktree 共享仓库数据，并不隔离端口、数据库、网络、Docker 资源和任意命令的访问能力；环境文件和依赖也不自动复制。[Git worktree 官方文档](https://git-scm.com/docs/git-worktree)

### Git 工具范围

| 行为 | 首版建议 |
| --- | --- |
| 查询 | status、diff、log、show、分支与 worktree 列表；输出有界，禁用非必要的外部 diff/textconv |
| 受管目录 | 创建、核对、移除本次登记的 worktree；不隐式覆盖分支或删除主目录 |
| 形成结果 | 明确文件集合的暂存和本地提交，不夹带其他暂存内容 |
| 整合结果 | 根 Agent 按审阅过的提交 ID 整合，支持冲突后的检查、继续和中止 |

Git 工具使用结构化参数和受管资源 ID，由内部实现解析路径并调用 Git 可执行文件；不接受任意 Shell 片段或无限制的 Git 参数透传。根 Agent 负责修改共享 Git 元数据、提交、整合和回收；成员侧只开放必要的查询。

创建 worktree 不隐含提交授权，成员完成也不隐含整合授权。动作复用现有 allow / ask / deny 与真实用户授权；Git hooks、filters 等可能触发的行为仍属于真实副作用，结构化调用本身不是隔离保证。首版不附带远端 fetch/push、Git 初始化或通用历史改写。

### 执行顺序

1. 根 Agent 将选定 ref 解析成不可变提交 ID，记录基线与目标分支；默认是创建时的 HEAD。主目录存在未提交修改时明确提示不带入，不 stash、不自动提交、不复制脏目录。任务依赖这些修改时应先处理基线，不能用旧版本宣称覆盖当前工作树。
2. 在受管目录创建专用分支和 worktree，记录仓库公共 Git 目录、实际路径、分支、基线、资源 ID 与所属 Session。调用者不能传入另一个目录来扩大能力。
3. 成员报告变更和验证，根 Agent 核对后在相应授权范围内形成本地结果提交。未获提交授权时保留修改，标明待处理。
4. 根 Agent 串行整合已经审阅的结果提交。建议用 cherry-pick --no-commit 汇集结果，集成验证后形成一个清晰的最终提交。开始前检查目标分支、HEAD、暂存区和工作区，存在额外修改或在途 Git 操作就先处理；不自动 stash、强行覆盖或改写用户历史。冲突根据双方任务意图处理，涉及未确认取舍时暂停。[cherry-pick 官方文档](https://git-scm.com/docs/git-cherry-pick)
5. 区分成员完成、结果已整合与 worktree 已回收。结果已整合或用户明确放弃，且资源和文件状态满足条件后，由 Git 入口移除 worktree；分支删除另行核对，不随着目录回收直接丢弃。

Git 调用之前持久化意图，调用后核对真实状态并记录结果。Git 与 JSONL 不能原子提交：中间崩溃后检查资源路径、仓库标识、分支、提交和冲突状态，无法确定时显示待处理，不因缺少成功记录就自动重试。

没有有效仓库或 HEAD 时，可用明确允许的只读委派；需要 worktree 的写任务返回不可用原因，不暗中初始化或退回共享目录并行写。submodule、裸仓库等特殊布局在 Plan 中明确支持边界。

### 并发与生命周期

共享名额之外，对一次用户任务限制全组请求次数、运行时限、消息量和结果大小；不能只靠单个 Run 的 12 次请求限制成员反复唤醒。Tool 并发也在全组有界，具体数值在 Plan 中收敛。

全局停止取消本次用户任务的全部活动成员、审批和等待；定向停止只影响指定成员。根 Agent 等待命令、模型和其他资源收口后再关闭成员或回收 worktree。有活动工作时，会话切换和权限切换沿用忙时拒绝。等待成员期间不能占住成员所需的执行或 Git 修改许可。

## 与当前存储对齐

### 保留现有平铺目录

[locations.ts](../../apps/agent/src/session/locations.ts) 按 UTC 日期、创建时间及 Session ID 定位；[list.ts](../../apps/agent/src/session/list.ts) 扫描两层布局。[openSession](../../apps/agent/src/session/index.ts) 会先核对实际 Workspace，当前 [cleanup.ts](../../apps/agent/src/session/cleanup.ts) 则按独立 Session 判定两周期限。

建议保持物理目录形状，父子关系写入可核对记录，不让定位器新增递归扫描。下列 ID 和目录为方案示意，本轮没有创建运行数据：

    Anthias Data Root/
      conversation/
        session-locations.json
        2026-09-06/
          <创建时间>-<root-session-id>/
            session.jsonl
            session.index.json
            artifacts/
          <创建时间>-<member-a-session-id>/
            session.jsonl
            session.index.json
            artifacts/
          <创建时间>-<member-b-session-id>/
            session.jsonl
            session.index.json
            artifacts/
      worktrees/
        <root-session-id>/
          <worktree-id>/

conversation 保存历史，worktrees 保存可回收代码；成员日志不放在 worktree 中。当前已支持 ANTHIAS_SESSION_DIR，建议 worktree 默认使用 Anthias 的 data/worktrees，由启动装配独立传入；需要覆盖时用 ANTHIAS_WORKTREE_DIR。不能把任意 Session Directory 的父目录猜成 Data Root。

### 最少身份与事实来源

- 每个成员一个 Session，首版以 Session ID 直接标识成员，不另建生命周期相同的 AgentId。
- 新 Header 建议保存 rootSessionId 和 sessionKind（primary / subagent / teammate）。主会话根 ID 指向自己，成员直接指向根，结构只有一层。
- workspaceRoot 继续表示这个 Session 实际执行的位置；成员可以指向 worktree，根 Session 保留用户项目位置，两者不混用。
- 根 session.jsonl 保存成员、任务、消息投递和 Git/worktree 操作事实；成员 session.jsonl 保存实际收到的有来源输入、模型消息、Tool、审批、压缩和用量。
- Team 任务表、成员列表从根记录派生，不另建可独立改写的任务数据库。位置与恢复索引仍是可重建缓存。
- worktree 记录关联资源 ID、根/成员 Session、仓库公共 Git 目录、实际路径、分支、基线提交、结果提交与整合目标。仓库公共目录通过 Git 查询，不能假定每个 worktree 内的 .git 都是目录。[rev-parse 官方文档](https://git-scm.com/docs/git-rev-parse)
- 审批引用携带来源 Session 与 entry 标识；Git 事实、成员消息和模型输入分别投影，不把所有日志机械送进上下文。
- 跨成员结果引用携带 Session ID 与 entry/artifact ID，读取时核对所属根和被分享范围；成员只能读取自己的历史与明确分享的结果。当前 read_artifact 只面向当前 Session，不能直接把成员 artifact ID 当成根 Session 的产物使用。

消息或资源创建跨越多份日志时，用稳定 ID 关联意图和结果；按合同落盘后才开始执行，成员根据消息 ID 去重。可核对与避免无依据重放不等于模型和文件副作用拥有恰好一次执行保证。

### 格式演进

当前 Header/记录校验严格，定位、索引和清理也显式依赖 Schema 2。建议明确升级 Schema 3：新会话使用新格式，旧 Schema 1/2 保持可读；旧 Session 要使用新协作或 Git 持久行为时，才按既有迁移思路升级，不在启动时全库改写。

迁移保留 Session ID、创建时间、Workspace 绑定和目录位置。旧 Session 视为独立主会话；会话列表默认显示主会话，成员历史从主会话展开。解析器、位置缓存、恢复索引和清理一起适配。

位置缓存当前是读取后整体写回，并发创建成员时需要串行发布或沿用维护锁，避免条目相互覆盖；缓存损坏仍通过日志扫描恢复，不能影响已写入事实的有效性。

### 明确区分三种恢复

| 行为 | 恢复内容 | 工作区条件 | 会不会执行 |
| --- | --- | --- | --- |
| 查看历史 | 已保存对话、任务、结果与最后资源状态 | 不要求 worktree 存在；核对根归属和日志 | 不启动模型或工具 |
| 重开主会话 | 主上下文和成员/任务记录；原活动成员显示中断或离线 | 主 Workspace 有效；子 worktree 不可用可单独显示 | 不自动启动成员 |
| 用户明确继续未完成任务 | 核对后的成员上下文、任务和资源，创建新的 Run | 仓库身份、实际路径、分支与 Git 状态吻合 | 可以执行新 Run，不重放结果不明的旧工具 |

建议显式继续未完成任务纳入首版，自动热恢复不纳入。worktree 被删除、替换、移动或有未处理冲突时，历史仍可读，执行恢复给出具体原因。不能按原 HEAD 重建目录就宣称恢复了丢失的未提交内容，也不静默修改旧 Header 的 Workspace。

当前 openSession 会先 realpath(workspaceRoot)，历史读取需要独立的只读行为，不能通过启动 SessionAgent 来实现。日志最后为 running 只表示最后已知事实；重启应检查有效所有者，不能直接投影为仍在运行。

### 历史与 worktree 分别回收

会话延续两周未使用期限，但以根及成员组成的组为单位判定，最近活动取组内最新值。任一成员在使用，或者存在未交付修改、未整合结果、待处理 Git 操作或不确定归属，就保留全组并给出原因。孤立成员或不完整记录不自动删除。

组回收沿用可恢复的维护意图，记录成员清单和进度，避免崩溃后只删除一半。根 Agent 持有组的活动保护，成员不各自启动全局清理。

worktree 由单独的 Git 生命周期动作回收：等待成员与命令结束，确认结果已整合或用户明确放弃，核对修改、未跟踪文件和其他尚未确认可丢弃的内容，再调用 git worktree remove。失败或有未交付内容则保留。两周会话清理绝不连带删除工作区和分支；读取历史也不重新创建已回收目录。

## 三个建议交付 Plan

| Plan | 用户可用结果 | 验收重点 |
| --- | --- | --- |
| 1：Git 与 worktree | 主 Agent 查询 Git、创建隔离目录、受控形成及整合结果、回收受管资源 | 固定提交基线、原修改不被带入或改变、审批与 Git 状态一致、冲突处理、崩溃后资源核对 |
| 2：SubAgent | 独立委派，可写成员使用独立 worktree；查看、停止、回收结果、显式继续中断任务 | 不可递归委派、来源正确、并发目录隔离、审批取消、成员历史及组清理 |
| 3：AgentTeam | 保留成员、共享任务、定向通信、围绕真实成果实施和验证、结束团队 | 消息/任务/成员闭环、确切受测版本、未交付状态、空闲无调用、重开只恢复记录 |

三个 Plan 同属本次范围，第一个交付实际 Git/worktree 操作能力。每个 Plan 包含自己的 TUI、存储和必要验证，不额外拆空框架或测试阶段。每个完成后按项目流程停下供开发者检查。

Git/worktree 用临时本地仓库验证，Agent 用确定性 ModelStream 验证；重点覆盖伪造创建调用被拒绝、两个独立目录写入、目标分支变化、整合冲突、消息去重、取消和历史回收。沿用可信单 Agent 结果，不复制整套旧测试。真实 Provider 另行授权，本轮未运行上述未来验收。

## 当前确认边界

已确定的是成员不可递归委派、Git/worktree 纳入本次、从明确提交创建并提示未带入修改。三个 Plan 的划分、根 Agent 管理 Git 修改、Schema 3、平铺存储及分组回收、显式继续的细节仍待讨论确认。

方案确认后再分配 Feature 编号并形成 Spec、Plan 和统一 Tasks。本轮只修订研究与设计材料，没有修改实现、创建 worktree、提交或推送。
