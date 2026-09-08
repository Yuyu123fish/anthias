# Anthias

Anthias 是一个本地优先、交互形态无关的 Coding Agent。

已确认的后续方向是工程验证：把开发者对系统的疑问转化为可执行、可复现的验证，并根据实际证据解释结果。验证对象可以是页面、接口、命令行程序、并发逻辑、性能或数据一致性；缺少数据和验证手段时，Agent 可以利用工具与 Coding 能力准备数据、编写脚本和检查程序。这一方向待后续 Feature 实现。

## 当前重点

当前优先补齐 Coding Agent 剩余的基本功能，完善实际编码、上下文、运行控制和交互体验，再推进工程验证能力。下一项基础功能根据当前代码与实际使用缺口单独确定。

当前 Coding Harness 已形成模型对话、线性 Session、基础 Tool、工作区操作、权限与安全策略的本地闭环，并继续与具体界面分离：

    Anthias Agent（运行核心）
      ├─ TUI 适配器（首个交互入口）
      └─ Desktop 适配器（未来能力）

TUI 直接调用 Agent，并订阅 Agent 发布的事件。未来 Desktop 可以通过适配器转发同一组命令和事件，不要求 Agent 理解 Electron、MessagePort 或其他界面技术。

## 启动

首次使用请阅读 [Quick Start](quick-start.md)，完成依赖安装、构建，并在 Anthias 根目录的 `.env` 配置模型。仓库提供 [.env-example](.env-example)；首次启动缺少 `.env` 时会生成无凭据模板，已有文件不覆盖。构建完成后，可以在希望 Agent 操作的任意目录启动：

```powershell
node 'C:\projects\anthias\apps\tui\dist\main.js'
```

把上面的仓库路径替换为你的实际路径。省略 `--workspace` 时使用调用命令的当前目录，也可以传入 `--workspace 'D:\你的项目'`。根 `.env` 与任务工作区无关，进程环境覆盖文件；模式优先级为 `--mode` → 进程环境 → 根 `.env` → `agent`。`--mode plan` 以只读模式启动；`--mode auto_allow` 采用已明确授予的工作区权限，未命中的动作再独立审核。Session 默认集中保存在 Anthias 仓库的 `data/conversation/`。

需要记住日常工作区授权时，使用 `/permissions grant --remember`，浏览范围后另行输入 `grant`；`--members` 可明确包含登记成员 worktree，`/permissions revoke` 可撤销。可选的 `SEARCHAPI_API_KEY` 启用网页搜索。Quick Start 包含详细范围、PowerShell `anthias` 短命令、Session 恢复和故障处理。

## 当前状态

- 旧的 Desktop、Local Agent Host、JSON-RPC 和 Protocol 实现已经撤销。
- Feature 001–003 已累计实现事件驱动的 Agent Loop、线性 JSONL Session、六个固定 Tool、逐次副作用确认、Agent / Plan 权限模式、`allow | ask | deny` 安全决策和只读 Tool 四并发；Feature 003 已由开发者验收。
- 仓库已有可构建、可启动的 Agent 与对话式 TUI；生产 OpenAI-compatible Model Adapter、Session、Tool 和运行生命周期均由 Agent Module 持有，TUI 只通过公开 Agent Interface 输入和呈现。
- 当前命令仍以 Anthias 所在用户权限运行，没有 OS 沙箱；真实 Provider 的有限摘要与审批冒烟另见 Feature 005 Report，长期人工终端体验仍待验收。
- 已确认的基础方向是 Strict TypeScript、Node.js 24 LTS、ESM 和 pnpm workspace。
- 首个模型接入继续使用通用 OpenAI-compatible 接口；DeepSeek V4 Flash 只是日常使用与联调的参考模型。
- Electron 不再是产品前提；Desktop 的框架、进程模型和传输方式留给未来 Feature 决定。
- [Feature 004](specs/feature004-tui-workspace-experience/spec.md) 的四个 Plan 已完成本地实现：可从任意目录或 `--workspace` 启动，Session 集中保存到 Anthias `data/conversation`；TUI 使用 `><°>` 分叉尾鱼标识、稳定 scrollback、动态运行区和常驻完整工作路径，并呈现 Visible Reasoning、可分页详情、Tool 活动、安全文件引用及 Shiki 代码高亮。自动门禁与 Windows ConPTY loopback 已通过；真实 DeepSeek 冒烟和 Windows Terminal 主观视觉检查仍是验收边界，因此 Feature 暂保持“实施中”。
- [Feature 005](specs/feature005-context-engineering/spec.md) 已于 2026-09-05 由开发者验收，包含请求前预算、自动 Compaction、历史与模型上下文分离、Schema 2 恢复索引、按 UTC 时间归档、工具原文及 `read_artifact`、启动时清理两周未使用的会话，以及 AutoAllow 独立审核。`/context` 查看窗口与累计用量；[实施报告](specs/feature005-context-engineering/report.md) 记录实际验证边界。
- [Feature 006](specs/feature006-command-skill-mcp-tui/spec.md) 已实现全屏固定面板与应用内滚动、流式 Markdown、统一 `/` 命令、会话切换与手动压缩、按需加载外部 Skill、显式连接 MCP。当前全屏交互替代 Feature 004 的 scrollback 方案；[实施报告](specs/feature006-command-skill-mcp-tui/report.md) 记录本地验证，等待开发者终端体验验收。
- [Feature 007](specs/feature007-multi-agent/spec.md) 已实现 SubAgent、AgentTeam 与本地 Git/worktree；复用现有 Agent，最多三个成员，可写成员从固定提交隔离执行。来源授权、Schema 3 历史、显式继续和组清理已完成本地验证，等待开发者验收；使用方式见 [Quick Start](quick-start.md#multiagent-与本地-git)，证据见 [实施报告](specs/feature007-multi-agent/report.md)。
- [Feature 008](specs/feature008-memory-and-prompt-orchestration/spec.md) 已实现主动记忆、`/memory` 管理、项目 `AGENTS.md` 自动加载、稳定提示词顺序与来源增量，以及历史身份和压缩恢复映射。已移除 12/60 次模型调用截止，保留 30 分钟时限和资源边界；本地验证与真实缓存收益的证据边界见 [实施报告](specs/feature008-memory-and-prompt-orchestration/report.md)，待开发者验收。
- [Feature 009](specs/feature009-usage-stability/spec.md) 已实现根 `.env` 配置、SearchAPI 网页搜索、可记住与撤销的工作区授权，以及命令顺序、工具过程和输入草稿修复；`/diagnostics` 查看安全停止原因，`/continue` 明确继续，`/draft` 恢复未接受输入。普通模型生成仅在未交付内容时对明确暂时错误最多额外重试两次，Tool 副作用不自动重试。本地验证见 [实施报告](specs/feature009-usage-stability/report.md)，当前待开发者验收；本 Feature 未进行真实模型、SearchAPI 调用或 Windows Terminal 主观体验验收。
- 工程验证方向尚未进入对应 Feature；Desktop 尚未实现。执行分叉已退出产品核心路线，不再作为必须实现的后续目标。

## 文档入口

- [Quick Start](quick-start.md)：安装、根配置、工作区授权、网页搜索、任意目录启动和 Session 恢复。
- [产品定义](docs/product-definition.md)：产品路线、交互形态、核心术语与当前边界。
- [技术基线](docs/technical-baseline.md)：当前 TypeScript、Agent、TUI、事件和模型方向。
- [开发流程](docs/development-workflow.md)：讨论、Spec、Plan、实施与验收的协作方式。
- [Feature 文档约定](specs/README.md)：编号 Feature 的目录、文档结构和状态。
- [Research](research/README.md)：项目级或跨 Feature 的调查规则和历史归档；Feature 专属 Research 见对应 Feature 目录。
