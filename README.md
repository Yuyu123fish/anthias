# Anthias

本地优先的 Coding Agent，使用 TypeScript 和 Node.js 构建，在终端中完成代码阅读、文件修改、命令执行与多 Agent 协作。

Agent 管理模型、工具、权限和会话；TUI 负责输入与呈现。当前以 Windows + PowerShell 7 为主要开发和验证环境，项目仍在持续开发中。

## 当前能力

- **编码与执行**：接入 OpenAI-compatible Chat Completions，支持文件读取、搜索、写入、编辑和命令执行；可选 SearchAPI 网页搜索。
- **上下文与会话**：保留线性 Session 历史，按预算压缩模型上下文；工具输出超限时截断并保存原文，支持按需回读。
- **多 Agent 协作**：持续成员、持久邮箱和共享笔记，含根最多十个执行并发；默认共享工作区，需要隔离时显式创建 Git worktree。
- **权限与恢复**：提供 `agent`、`auto_allow`、`full_access` 三种模式，支持工作区授权、输入排队、中断、诊断和工作区阻塞恢复。
- **项目上下文**：加载项目 `AGENTS.md`、管理本地记忆、按需读取 Skill，并由用户显式连接 MCP 服务。
- **终端交互**：全屏 TUI、流式 Markdown、代码高亮、可滚动正文、工具过程、审批和详情面板。

上述能力已有本地实现，各项验收和真实服务验证范围见 [Feature 索引](specs/README.md)。本地测试通过不代表所有模型、终端和外部工具都已验证。

**运行边界**：当前没有 OS 沙箱。命令使用启动 Anthias 的系统用户权限，工作区和 Git worktree 不构成系统级隔离。Session 与记忆保存在本机；模型、SearchAPI 和远程 MCP 请求可能将所需内容发送至配置的服务。

## 快速开始

准备 Node.js 24 LTS、pnpm 10.33.0、Git，以及 PATH 中可用的 PowerShell 7（`pwsh`）。以下命令在 PowerShell 中执行：

```powershell
git clone https://github.com/Yuyu123fish/anthias.git
Set-Location anthias
corepack pnpm install --frozen-lockfile
corepack pnpm build
Copy-Item .env.example .env
```

编辑仓库根目录的 `.env`，填写 `ANTHIAS_MODEL_BASE_URL`、`ANTHIAS_MODEL_ID` 和 `ANTHIAS_MODEL_API_KEY`；自定义模型还需声明上下文窗口。默认模式为 `agent`。已有 `.env` 时直接编辑，保留原配置。

在仓库根目录启动，并明确指定希望处理的项目：

```powershell
node ./apps/tui/dist/main.js --workspace 'C:\projects\your-project'
```

`--workspace` 必须指向现有目录。省略时使用当前目录；从其他位置启动，可使用 `apps/tui/dist/main.js` 的绝对路径。完整配置、`anthias` 短命令、会话恢复与常见问题见 [使用指南](quick-start.md)。

Session 和工具产物默认保存在本仓库的 `data/`，记忆保存在 `memory/`，均已被 Git 忽略。启动时会清理两周未使用且满足回收条件的会话，重要记录请自行备份。

## 开发

```powershell
corepack pnpm check   # 规范与类型检查
corepack pnpm test    # 构建并运行本地测试
corepack pnpm verify  # 完整本地验证
```

| 目录 | 内容 |
| --- | --- |
| `apps/agent/` | Agent、模型适配、工具、权限、Session 与协作 |
| `apps/tui/` | CLI 入口与终端交互 |
| `docs/` | 产品定义、技术基线、开发流程与故障记录 |
| `specs/` | 编号 Feature 的合同、计划、任务和实施报告 |
| `research/` | 项目级调查与历史研究归档 |

提交问题时请附复现步骤、系统与 Node.js 版本，以及去除敏感值的诊断信息。修改前阅读 [开发流程](docs/development-workflow.md) 和 [AGENTS.md](AGENTS.md)。

## 后续方向

当前继续完善 Coding Agent 的基本功能。已确认的后续方向是工程验证：围绕页面、接口、命令行、并发、性能或数据一致性问题构造可执行、可复现的验证，并根据证据解释结果。专用验证能力与 Desktop Adapter 尚未实现。

## 文档

- [使用指南](quick-start.md)：安装、配置、命令、权限、Skill、MCP 和多 Agent 使用。
- [产品定义](docs/product-definition.md)与[技术基线](docs/technical-baseline.md)：当前决定、模块边界及未实现方向。
- [Feature 索引](specs/README.md)：按功能查找 Spec、Plan、Tasks 和 Report。
- [故障记录](docs/incident/README.md)：实际问题、修复依据和已知限制。
- [研究归档](research/README.md)：历史调查及其适用范围。
