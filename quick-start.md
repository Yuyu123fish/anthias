# Quick Start

下面以 Windows + PowerShell 7 为例。示例中的 Anthias 仓库位于 `C:\projects\anthias`；如果你放在其他位置，替换对应路径即可。

## 1. 安装依赖并构建

需要 Node.js 24 LTS、pnpm 10.33.0，以及 PATH 中可用的 PowerShell 7（`pwsh`）。先在 Anthias 仓库执行：

```powershell
Set-Location 'C:\projects\anthias'
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` 会生成 `apps/tui/dist/main.js`。修改或更新源码后重新构建；启动读取的是构建产物。

## 2. 配置模型

Anthias 使用 OpenAI-compatible Chat Completions 接口。若当前终端已配置以下三个环境变量，可以跳过本节；否则在准备启动 Anthias 的 PowerShell 窗口中输入：

```powershell
$env:ANTHIAS_MODEL_BASE_URL = Read-Host 'OpenAI-compatible Base URL'
$env:ANTHIAS_MODEL_ID = Read-Host '模型 ID'
$env:ANTHIAS_MODEL_API_KEY = Read-Host 'API Key' -MaskInput
```

Base URL 使用模型服务提供的 API 基础地址，不要附加 `/chat/completions`。模型 ID 使用该服务实际支持的值。


DeepSeek V4 Flash 可使用 Base URL https://api.deepseek.com 与模型 ID deepseek-v4-flash，窗口能力内置。其他模型若没有内置能力数据，还需设置模型服务明确声明的窗口，例如：

```powershell
$env:ANTHIAS_MODEL_CONTEXT_WINDOW = Read-Host '模型上下文窗口 token 数'
```

安全余量固定为 20,000，不需要按模型手工配置。普通回答、摘要输出和保留原文的目标默认分别为 16,000、8,000 和 32,000 token；需要调整时使用 ANTHIAS_RESPONSE_MAX_TOKENS、ANTHIAS_COMPACTION_MAX_TOKENS、ANTHIAS_CONTEXT_KEEP_TOKENS。ANTHIAS_MODEL_MAX_OUTPUT_TOKENS 用于声明模型输出能力，配置超限会在启动前说明。

这些设置只在当前终端及其子进程中生效，新开窗口需要重新配置。API Key 不会回显，也不要把真实值写进仓库文档或提交。Anthias 不会自动读取 `.env` 文件。

## 3. 从任意目录直接启动

先进入希望 Agent 操作的项目，再用 Node 调用 Anthias 的绝对入口：

```powershell
Set-Location 'D:\你的项目'
node 'C:\projects\anthias\apps\tui\dist\main.js'
```

此时 Workspace 是 `D:\你的项目`，不是 Anthias 仓库。启动后核对界面上的完整 Workspace 路径。

也可以留在当前目录，显式选择另一个工作区：

```powershell
node 'C:\projects\anthias\apps\tui\dist\main.js' --workspace 'D:\你的项目' --mode plan
```

`--workspace` 必须指向已经存在的目录；相对路径按执行命令时的当前目录解析。省略 `--mode` 时为 Agent 模式，`--mode plan` 只允许读取、发现和搜索工作区文件及当前 Session 产物；`--mode auto_allow` 根据真实任务授权独立审核，批准后直接执行，信息不足时转人工确认。

## 4. 使用 `anthias` 短命令

在当前 PowerShell 窗口定义一个函数，就能在任意目录直接输入 `anthias`：

```powershell
function anthias {
    & node 'C:\projects\anthias\apps\tui\dist\main.js' @args
}

Set-Location 'D:\你的项目'
anthias
```

函数保留当前目录，并把参数原样传给 CLI。需要只读模式时使用 `anthias --mode plan`；指定工作区时使用 `anthias --workspace 'D:\另一个项目'`。

想让新开的 PowerShell 窗口也有这个命令，打开个人 Profile，把上述函数定义加到文件末尾：

```powershell
if (-not (Test-Path -LiteralPath $PROFILE)) {
    New-Item -ItemType File -Path $PROFILE -Force | Out-Null
}
notepad $PROFILE
```

保存后重开 PowerShell，或运行 `. $PROFILE` 加载。Profile 中只放启动函数；模型环境变量仍按上一节配置。仓库移动后，需要同步修改函数里的入口路径。

## 5. 常用操作与 Session

| 操作 | 用法 |
| --- | --- |
| 命令发现 | 输入 `/` 查看菜单，`Tab` 补全；`/help` 查看完整帮助 |
| 提交任务 | `Enter` 提交；`Alt+Enter` 或支持的 `Shift+Enter` 换行，多行粘贴保持一条输入 |
| 新建或恢复会话 | `/new`；`/resume` 列出 ID，`/resume <id>` 打开 |
| 主动压缩 | `/compact`，只压缩历史投影，不产生额外普通回复 |
| 查询或切换模式 | `/mode`、`/mode plan`、`/mode agent`、`/mode auto_allow`；只能在空闲时切换 |
| 查看上下文用量 | `/context`，当前窗口与各用途累计用量分别显示 |
| 阅读与详情 | `PageUp/PageDown` 滚动，`Ctrl+Home/End` 到顶部/末尾；`/details` 或 `Ctrl+T` 查看详情 |
| 批准当前副作用 | 完整阅读审批详情后输入 `approve`；详情未读完时阻止确认 |
| 拒绝当前副作用 | 输入 `deny` |
| 停止当前 Run | 运行中按 `Ctrl+C`，停止后可以继续输入 |
| 退出 | `/exit`，或空闲时按 `Ctrl+C` |

所有工作区的 Session 默认集中保存在 Anthias 仓库的 `data/conversation/`，不会随当前工作目录改变。当前示例对应 `C:\projects\anthias\data\conversation`。

每次不带 `--session` 启动都会创建新 Session。恢复时使用启动信息中的完整 Session UUID，并选择创建它时的 Workspace：

```powershell
anthias --workspace 'D:\你的项目' --session '<完整的 Session UUID>'
```

如果需要自定义 Session 保存位置，在启动前设置绝对路径：

```powershell
$env:ANTHIAS_SESSION_DIR = 'D:\AnthiasData\conversation'
```

恢复旧 Session 时也需要使用原来的数据目录。显式打开该目录内的旧 Schema 1 Session 时会保存原始备份并迁移；程序不自动扫描其他工作区。

会话以 UTC 日期和创建时间戳分目录保存；日志、索引与工具产物归属于同一个 Session。每次启动会在后台检查最近使用时间，两周未使用且没有活动使用者的会话及其产物会被清理。压缩保留完整历史，只缩减模型输入；TUI 显示过程和结果，成功后自动继续。

Agent 模式中的文件修改和普通命令仍需要逐次确认；命中硬拒绝规则的命令无法通过确认放行。命令以当前用户权限运行，没有 OS 沙箱，Workspace 和命令 `cwd` 不代表文件或网络隔离。

## 6. 接入外部 Skill

把已有 Skill 目录放到项目或用户的 `.agents/skills`，每个直接子目录包含自己的 `SKILL.md`。名称需与目录名一致，正文使用 Agent Skills 的 YAML frontmatter：

```markdown
---
name: review-guide
description: 检查项目的接口兼容性与错误处理
---
先阅读项目约定，再检查本次变更的公开接口和失败路径。
需要时读取 references/checklist.md。
```

`/skills` 显示来源与诊断；`/skill:review-guide 检查当前变更` 激活并提交任务。模型也可按目录调用 `load_skill`、`read_skill`。启动只读取元数据，正文最多 64 KiB，单次参考文本最多 32 KiB；目录重名时按列表里的稳定 ID 选择。脚本执行仍经过正常 Tool 权限。

额外根目录用 `ANTHIAS_SKILL_DIRS`，Windows 以分号分隔。`/skills reload` 重新发现并核对版本；`/skills clear` 清除当前会话的 Skill 激活。恢复保留已保存的正文和参考版本，文件变化会提示；显式再次 `/skill:<id>` 才替换正文，并清除旧正文关联的参考资料。新 Session 不继承激活内容。

## 7. 接入 MCP

配置读取用户 `~/.anthias/mcp.json`、项目 `.anthias/mcp.json`，也可用 `ANTHIAS_MCP_CONFIG` 添加一个文件。示例中的路径与地址需替换为你的服务；配置发现不会自动连接或安装程序：

```json
{
  "mcpServers": {
    "local-tools": {
      "transport": "stdio",
      "command": "node",
      "args": ["C:/tools/my-mcp/server.js"],
      "env": { "SERVICE_TOKEN": "MY_SERVICE_TOKEN" }
    },
    "remote-tools": {
      "transport": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "MY_MCP_AUTHORIZATION" }
    }
  }
}
```

`env` 和 `headers` 的值都是**当前进程的环境变量名**。例如 `MY_MCP_AUTHORIZATION` 保存完整 Authorization header 值；配置文件只存变量名。无需认证的服务可省略对应字段。

`/mcp` 查看状态，`/mcp connect project:local-tools` 显式连接，`/mcp inspect project:local-tools` 查看工具、资源、模板及诊断。同名服务保留来源，唯一短名也可使用。

- `/mcp read <id> <uri>`：读取目录中已列出的文本资源。
- `/mcp prompt <id> <name> {"参数":"值"}`：选用模板，保存为外部上下文，然后自行输入任务。
- `/mcp disconnect <id>`：断开并关闭 Anthias 启动的进程；退出会关闭全部连接。

模型只获得已连接且符合预算的工具定义。MCP 工具经过当前模式的审批；Plan 拒绝未知外部工具。资源和模板不是新的用户授权。工具预览最多 32 KiB，原文产物最多保留 256 KiB，完整性单独标记；当前不支持 OAuth 登录、自动安装、二进制呈现及 MCP Apps。

## 启动遇到问题

- **找不到 `anthias`**：先在当前窗口定义第 4 节的函数，或直接使用第 3 节的 Node 绝对入口。
- **找不到 `dist/main.js` 或依赖**：回 Anthias 仓库安装依赖并执行 `pnpm build`，保留完整仓库及其依赖目录。
- **提示缺少模型配置**：检查当前终端是否设置了第 2 节的连接配置及自定义模型的窗口容量；单独放置 `.env` 文件不会生效。
- **Workspace 与预期不一致**：从目标目录直接调用 CLI，或显式使用 `--workspace`。根目录的 `pnpm start` 会通过 pnpm 进入 TUI 包目录；它适合开发脚本调用，不应用来隐式选择外部工作区。
- **Session Workspace 不匹配或正在使用**：使用原 Workspace 恢复，并先退出占用该 Session 的另一个 Anthias 进程。

日常开发验证在仓库根目录运行 `pnpm verify`。它使用确定性本地测试；真实模型可用性需要在正确配置后另外确认。
