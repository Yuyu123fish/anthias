# Anthias 产品定义

## 当前状态

状态：产品路线与 Coding Harness 方向已确认；Feature 003、005 已验收，Feature 004 四个 Plan 已完成本地实现、外部验收待补。

2026-08-30，开发者撤销了此前围绕 Java/JVM 形成的产品与技术决定，并确认 Anthias 的长期路线是做一个可分叉的 Coding Agent。

2026-08-31，开发者进一步撤销了“Anthias 必须是 Desktop + Local Agent Host”以及由此形成的 Feature 001 实现。旧实现把基础对话提前扩展成跨进程状态协议，复杂度超过了当前用户结果需要。

当前先建立一个比较完整、可复用且与交互形态无关的 Coding Harness。TUI 是第一个交互入口；Desktop 可以在未来通过 Adapter 接入同一个 Agent，而不是反向决定 Agent 的内部结构。

## 产品定位

Anthias 把一次编码任务表示为一棵可以产生不同候选方向的执行树，而不只是一段只能沿单一路径继续的对话。

当任务出现多个值得保留的解决方向时，用户可以从共同的检查点创建互不覆盖的执行分支，让它们分别继续，并根据各自结果选择后续采用的方向。

Anthias 的核心价值是：

> 不要求 Agent 在岔路口只做一次不可逆的选择；保留岔路，分别推进，再由用户比较和选择。

执行分叉是长期产品差异。当前不会直接实现复杂分叉，而是先让模型对话、Tool、本地工作区操作、上下文和运行控制形成可信的 Coding Harness。

## 产品形态

Anthias 是本地优先、交互形态无关的 Coding Agent。

    Anthias Agent（运行核心）
      ├─ TUI 适配器
      └─ Desktop 适配器

- Agent 持有消息、模型运行、运行状态以及后续 Tool 和工作区副作用，是行为权威。
- TUI 是首个交互入口，直接调用 Agent，并根据 AgentEvent 呈现运行过程。
- Desktop 是未来可加入的交互适配器。它可以转发同一组 Agent 命令和事件，但不产生另一套 Agent 状态。
- Agent 的公开接口不依赖终端库、Electron、React、MessagePort 或传输协议。
- 当前不建设云端后端或公共网络服务；是否需要独立本地进程，由具体交互 Feature 决定。

## Coding Harness（编码运行内核）

Coding Harness 是 Anthias 在执行分叉之前需要建立的运行基础，最终应能够承载：

- 模型消息与多轮上下文；
- 流式 Assistant 输出；
- Agent 生命周期、取消和失败恢复；
- Tool 定义、调用和结果回传；
- 文件、编辑和命令等本地能力；
- 权限、资源释放和可观察事件；
- Session 与上下文管理。

这些能力会由多个 Feature 逐步完成，不在 Feature 001 中一次性预建。普通 Coding Harness 能力本身不是 Anthias 的最终产品差异，但它必须足够简单、可信，才能支撑后续执行分叉。

## 当前实现状态

- 仓库已有可构建、可启动的 Agent 与对话式 TUI；生产 OpenAI-compatible Model Adapter、线性 Session、Tool 和运行生命周期位于 Agent Module 内部，TUI 不持有这些行为权威。
- 旧的 Electron Desktop、Utility Process Host、JSON-RPC、Protocol DTO 和 Renderer 状态投影已经撤销。
- Feature 001–003 已累计实现多轮模型与 Tool 循环、六个固定 Tool、线性 JSONL Session、工作区文件和命令能力、逐次副作用确认、Agent / Plan 权限模式、`allow | ask | deny` 安全决策与只读 Tool 四并发；Feature 003 已由开发者验收。
- 当前命令仍以 Anthias 所在用户权限运行，没有 OS 沙箱；真实 Provider 只有 Feature 005 报告所列的有限冒烟，长期人工终端体验仍待验收。
- [Feature 006](../specs/feature006-command-skill-mcp-tui/spec.md) 已实现全屏 TUI、常用命令、外部 Skill 按需加载与 MCP 接入。正文支持可见滑块和鼠标滚动，任务结束后折叠执行过程，并可点击逐级展开；最终回答保持在主体中。会话和能力仍由 Agent 管理，外部内容不增加用户授权；当前交互替代了下面 Feature 004 的历史布局，主观体验待验收。
- [Feature 004](../specs/feature004-tui-workspace-experience/spec.md) 已在本地实现现代对话层级：稳定 scrollback 与底部动态区域并存，完整 Workspace、模式、Session 和 Run 状态持续可见；Visible Reasoning 自动折叠并可用 `/details` 回看，超出终端高度时通过 `/details prev|next` 分页；Tool 按 `toolCallId` 呈现摘要与详情，Assistant 文件引用经 Workspace 校验，已标记代码块由 Shiki 按需着色。运行中窗口小到无法安全保留上下文时会暂停提交和确认，放大后恢复；非 TTY、无颜色和无 Unicode 均有等价降级。
- Feature 004 的自动门禁和 Windows ConPTY loopback 已通过；真实 DeepSeek V4 Flash 冒烟与 Windows Terminal 主观视觉检查尚未完成，因此尚未进入“已实现”状态。
- Feature 005 已于 2026-09-05 由开发者验收，形成上下文压缩和自动继续、完整历史与模型投影分离、工具原文访问、两周未使用会话的启动清理，以及 AutoAllow 模式。自动审核只能依据真实用户授权，不能覆盖硬禁止策略。
- Desktop、可用对话 fork、执行检查点、执行分支和候选比较尚未实现。

## 核心产品术语

### 编码任务

用户希望 Anthias 在一个代码库中完成或推进的一项目标。一次编码任务可以只有一条执行路径，也可以包含多个执行分支。

### 检查点

编码任务中可作为后续共同起点的已知状态。检查点让不同执行分支从同一任务位置出发；它在存储和运行时中的具体表示尚未决定。

### 执行分支

从一个检查点开始、可以独立继续的候选解决方向。不同执行分支后续产生的上下文、代码候选变化和执行结果不能彼此静默覆盖。

执行分支是 Anthias 的产品概念，不等同于 Git 分支。Git branch、worktree、补丁、文件覆盖层或其他机制是否参与实现，由后续 Feature 决定。

### 候选结果

一个执行分支在当前阶段形成、可供用户理解和比较的结果。它具体应包含哪些代码变化、验证证据、成本、风险或未决项，仍需在分叉 Feature 中确认。

## 已确认的产品边界

- Anthias 是本地优先、交互形态无关的可分叉 Coding Agent。
- 先建立比较完整的 Coding Harness，再实现复杂的检查点、执行分支和候选比较。
- TUI 是首个交互入口，Desktop 是未来可选的适配器，不是产品前提。
- Agent 通过小而稳定的命令与事件接口被不同交互形态使用。
- 一个交互适配器只负责输入和呈现，不复制 Agent 的消息、生命周期或副作用权威。
- 分叉不以多 Agent 为前提；同一个 Agent 也可以沿不同执行分支继续。
- 普通代码生成、Tool 调用、隔离修改、Diff 和测试属于支撑产品可信运行的能力，不单独作为 Anthias 的产品差异。

## 明确不等同的方向

- **不是 Git 客户端包装**：执行分支可能借助 Git 实现，但还包含编码任务的上下文和候选方向。
- **不是对话分叉本身**：只复制聊天记录而不能独立推进代码候选状态，不构成执行分支。
- **不是多 Agent 编排器**：执行者数量与是否可以分叉是两个独立问题。
- **不是自进化 Agent**：当前路线不包含 Agent 自动修改自身 Prompt、Tool、模型路由、Runtime 或代码。
- **不是 Desktop 专属应用**：Desktop 和 TUI 可以采用不同交互过程，但应使用同一个 Agent 行为接口。
- **不是云端前提**：模型可以是远程服务，但 Agent 执行和本地副作用默认发生在用户机器上。

## 仍需回答的问题

- Anthias 首先聚焦哪一种具体编码任务和用户工作流；
- 是否为旧 Workspace 内 Session 提供单独迁移能力；当前合同是不扫描、不迁移、不删除；
- 何时需要 Desktop，以及 Desktop 是否需要独立本地进程；
- 哪个场景最能证明分叉比线性执行更有价值；
- 检查点与执行分支需要继承哪些任务状态；
- 用户如何比较候选结果，以及选择之后发生什么；
- 分支是否需要跨进程或跨会话持久化与恢复。

## 确认边界

- 当前确认的是产品路线、Coding Harness 近期目标、交互形态无关原则和 TUI 优先顺序。
- TypeScript、`apps/agent` 与 `apps/tui` 布局、Agent 内部 Model Adapter、线性 Session、固定 Tool、Permission Mode 与安全策略已经由 Feature 001–003 和 lockfile 形成当前基线。
- Feature 003 已于 2026-09-04 由开发者验收；没有 OS 沙箱、未调用真实 Provider，以及未进行长期人工终端体验仍是明确边界。
- Feature 004 的 Spec、四个 Plan 与 Tasks 已由开发者确认，四个 Plan 的本地实现与约定验证均已完成。Shiki 是唯一代码高亮实现；真实 Provider 与主观终端视觉没有证据前，Feature 仍保持“实施中”。
- 归档 Research 和历史实现可以提供反例与证据，但不能自动恢复旧决定。
