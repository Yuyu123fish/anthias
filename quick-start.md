# Quick Start

下面以 Windows + PowerShell 7 为例。示例中的 Anthias 仓库位于 `C:\projects\anthias`；如果你放在其他位置，替换对应路径即可。

## 1. 安装依赖并构建

需要 Node.js 24 LTS、pnpm 10.33.0，以及 PATH 中可用的 PowerShell 7（`pwsh`）；Git/worktree 功能还需要 Git。先在 Anthias 仓库执行：

```powershell
Set-Location 'C:\projects\anthias'
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` 会生成 `apps/tui/dist/main.js`。修改或更新源码后重新构建；启动读取的是构建产物。

## 2. 在 Anthias 根目录配置一次

Anthias 使用 OpenAI-compatible Chat Completions 接口。在 Anthias 根目录把 [.env-example](.env-example) 复制为 `.env`，填写自己的连接配置；已有 `.env` 时直接编辑。首次启动时若文件不存在，程序也会生成一份不含凭据的模板，并在模型配置不完整时提示缺少的变量。

| 变量 | 填写内容 |
| --- | --- |
| `ANTHIAS_MODEL_BASE_URL` | 服务提供的 API 基础地址，不要附加 `/chat/completions` |
| `ANTHIAS_MODEL_ID` | 服务实际支持的模型 ID |
| `ANTHIAS_MODEL_API_KEY` | 自己的 API Key |
| `SEARCHAPI_API_KEY` | 可选；留空只影响网页搜索 |
| `ANTHIAS_PERMISSION_MODE` | `agent`、`auto_allow` 或 `full_access`；模板默认 `agent` |

这份 `.env` 只从 Anthias 自身的项目或安装根目录加载，与启动时的当前目录、`--workspace` 和恢复的 Session 无关；不会读取任务项目里的同名文件。已有文件不会被启动流程覆盖，`.env` 已排除在版本控制之外。填写后重新启动即可采用；不要提交真实值。

同名变量以进程环境覆盖 `.env`，进程里的显式空值也不会回退到文件中的 Key。模式优先级为 **`--mode` → 进程中的 `ANTHIAS_PERMISSION_MODE` → 根 `.env` → `agent`**。非法模式会提示错误。运行中的 `/mode` 只改变当前 Agent，不改写文件，也不授予工作区权限。

DeepSeek V4.1 Flash 的日常参考配置为 Base URL `https://api.deepseek.com`、模型 ID `deepseek-flash`，窗口与输出能力内置；旧调用名继续兼容，核验来源见 [Feature 015 Research](specs/feature015-execution-recovery/research.md)。其他模型若没有内置能力数据，还需在 `.env` 中取消 `ANTHIAS_MODEL_CONTEXT_WINDOW` 的注释，并填写服务明确声明的窗口。

安全余量固定为 20,000 token。普通输出默认 64,000；上下文窗口不超过 84,000 时沿用 16,000，再按已声明的模型输出能力收窄。摘要输出和保留原文目标仍为 8,000、32,000。`ANTHIAS_RESPONSE_MAX_TOKENS`、`ANTHIAS_COMPACTION_MAX_TOKENS`、`ANTHIAS_CONTEXT_KEEP_TOKENS` 可显式覆盖；`ANTHIAS_MODEL_MAX_OUTPUT_TOKENS` 声明模型输出能力，显式配置超限在启动时拒绝。

`/diagnostics` 显示模型、最终窗口、回复/摘要预算、推理强度及“进程环境 / 根 .env / 默认”来源；不输出 Key 或 Endpoint。已有较低预算会覆盖默认值，修改后须重新启动。Session 的 request_usage 记录会保存实际请求使用的安全配置，便于与启动值核对。

支持 `reasoning_effort` 的服务还可分别配置 `ANTHIAS_RESPONSE_REASONING_EFFORT` 与 `ANTHIAS_APPROVAL_REASONING_EFFORT`，可选 `low`、`medium`、`high`。前者用于普通生成，后者用于授权审核；未配置时不发送该参数。当前日常模型可使用 `low` 减少思考等待；更换服务时按其支持情况调整。

`.env` 支持 `NAME=value`、单行引号值和注释，不展开变量或执行命令。配置错误只显示变量名、文件位置或行号。无法创建文件但进程环境已经提供完整配置时，程序会提示并继续启动。

仍可仅在当前 PowerShell 窗口临时配置，例如：

```powershell
$env:ANTHIAS_MODEL_BASE_URL = Read-Host 'OpenAI-compatible Base URL'
$env:ANTHIAS_MODEL_ID = Read-Host '模型 ID'
$env:ANTHIAS_MODEL_API_KEY = Read-Host 'API Key' -MaskInput
```

## 3. 从任意目录直接启动

先进入希望 Agent 操作的项目，再用 Node 调用 Anthias 的绝对入口：

```powershell
Set-Location 'D:\你的项目'
node 'C:\projects\anthias\apps\tui\dist\main.js'
```

此时 Workspace 是 `D:\你的项目`，不是 Anthias 仓库。启动后核对界面上的完整 Workspace 路径。

也可以留在当前目录，显式选择另一个工作区：

```powershell
node 'C:\projects\anthias\apps\tui\dist\main.js' --workspace 'D:\你的项目' --mode agent
```

`--workspace` 必须指向已经存在的目录；相对路径按执行命令时的当前目录解析。省略 `--mode` 时采用第 2 节的默认配置。`agent` 模式下只读请求立即执行，代码写入、命令与外部操作逐次批准；`auto_allow` 由独立审核放行普通必要操作，极高风险转人工；`full_access` 跳过人工和模型批准。组内通信、状态和受管笔记在三种模式下自动允许。

## 4. 使用 `anthias` 短命令

在当前 PowerShell 窗口定义一个函数，就能在任意目录直接输入 `anthias`：

```powershell
function anthias {
    & node 'C:\projects\anthias\apps\tui\dist\main.js' @args
}

Set-Location 'D:\你的项目'
anthias
```

函数保留当前目录，并把参数原样传给 CLI。需要逐次批准时使用 `anthias --mode agent`；指定工作区时使用 `anthias --workspace 'D:\另一个项目'`。

想让新开的 PowerShell 窗口也有这个命令，打开个人 Profile，把上述函数定义加到文件末尾：

```powershell
if (-not (Test-Path -LiteralPath $PROFILE)) {
    New-Item -ItemType File -Path $PROFILE -Force | Out-Null
}
notepad $PROFILE
```

保存后重开 PowerShell，或运行 `. $PROFILE` 加载。Profile 中只放启动函数；连接配置由 Anthias 根 `.env` 加载。仓库移动后，需要同步修改函数里的入口路径。

## 5. 常用操作与 Session

| 操作 | 用法 |
| --- | --- |
| 命令发现 | 输入 `/` 查看菜单，`Tab` 补全；`/help` 查看完整帮助 |
| 提交任务 | `Enter` 提交；`Alt+Enter` 或支持的 `Shift+Enter` 换行，多行粘贴保持一条输入 |
| 新建或恢复会话 | `/new`；`/resume` 列出 ID，`/resume <id>` 打开 |
| 主动压缩 | `/compact`，只压缩历史投影，不产生额外普通回复 |
| 查询或切换模式 | `/mode`、`/mode agent`、`/mode auto_allow`、`/mode full_access`；只能在空闲时切换 |
| 工作区授权 | `/permissions` 查看；授予与撤销见下文 |
| 最近停止原因与生效配置 | `/diagnostics` 查看安全分类、预算来源、已知用量与重试事实 |
| 明确继续 | `/continue [补充要求]`，采用已保存事实开始新的 Run |
| 恢复未接受输入 | `/draft`，用于当前交互 TUI 中保留的草稿 |
| 记忆管理 | `/memory` 查看；`/memory help` 查看维护命令 |
| 查看上下文用量 | `/context`，当前窗口与各用途累计用量分别显示 |
| 阅读与滚动 | 鼠标滚轮、点击轨道或拖动右侧滑块；`PageUp/PageDown`、`Ctrl+Home/End` 继续可用 |
| 执行过程 | 显示工具准备、审批和执行进度；成功过程可折叠，失败原因默认可见，最终回答保持可见 |
| 详情面板 | `/details` 或 `Ctrl+T` 打开；点击 `[<]`、`[>]` 切换详情，`[x]` 关闭；窄屏占满正文区 |
| 批准当前副作用 | 完整阅读审批详情后输入 `approve`；详情未读完时阻止确认 |
| 拒绝当前副作用 | 输入 `deny` |
| 提交与立即插入 | Enter 默认排入后续消息；运行中已有排队消息时按 Esc，立即取消当前回答并等待必要清理后处理最早一条 |
| 停止群组 | 运行中按 `Ctrl+C`，同时停止根与成员并暂停输入；`/continue` 明确继续 |
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

恢复旧 Session 时也需要使用原来的数据目录。显式打开该目录内的旧 Schema 1/2/3 Session 时会保存原始备份并升级到 Schema 4；程序不自动扫描其他工作区。

会话以 UTC 日期和创建时间戳分目录保存；日志、索引与工具产物归属于同一个 Session。每次启动会在后台检查最近使用时间，两周未使用且没有活动使用者的会话及其产物会被清理；协作会话按根和成员成组检查，未交付资源会阻止清理。压缩保留完整历史，只缩减模型输入；TUI 显示过程和结果，成功后自动继续。

Agent 模式中的文件修改和普通命令仍需要逐次确认；命中硬拒绝规则的命令无法通过确认放行。命令以当前用户权限运行，没有 OS 沙箱，Workspace 和命令 `cwd` 不代表文件或网络隔离。

### 工作区授权

需要减少重复审批时，先使用 `/mode auto_allow`，再输入：

```text
/permissions grant --remember
```

这一步只打开授权范围。核对完整 Workspace、文件范围、命令及工作目录，浏览面板到底部后另行输入 `grant` 才授予；输入 `cancel` 取消。省略 `--remember` 只授予本次会话；选择记住后，同一规范工作区重新启动可复用。`/permissions` 随时显示当前范围、来源及保存错误。

该范围包含工作区内的普通文件创建与编辑，以及 17 个默认构建、测试、检查和 lint 命令，例如 `pnpm build`、`pnpm test`、`npm run check`。默认命令按完整参数与确切 cwd 匹配。只选择 AutoAllow 不会创建这份授权；无有效授权时 TUI 会给出提示。

常用的其他命令可单独登记，例如：

```text
/permissions command --remember -- node --check demo.js
/permissions command --remember --prefix --cwd scripts -- python check.py
```

第一条精确授权工作区根目录的检查命令；第二条允许 `scripts` 目录下 `python check.py` 及其后续字面参数，目录必须已存在。命令保留 `--` 后的引号，带空格的目录可写 `--cwd "app files"`。登记会合并当前命令，并继承当前记住/成员选项；没有当前授权时从默认 17 项开始。仍需浏览完整范围后输入 `grant` 确认，最多保存 49 个入口，完整记录不得超过 192,000 字节。

`--prefix` 按参数边界匹配；授予 `python -c`、`powershell -Command` 等前缀即允许其后续字面脚本，需按实际需要选择范围。组合命令的每段均须已登记；动态展开、重定向、未登记命令以及可直接识别的 Git、清理、发布入口继续审核。旧授权不会自动扩大，Agent 模式仍逐动作确认，成员只读能力独立生效。命令以当前系统用户运行，cwd 不限制脚本的运行时副作用。

确实希望成员继承时，使用 `/permissions grant --remember --members`，阅读后同样输入 `grant`。`--members` 覆盖共享根工作区与受管工作树中的成员；选择 `--remember` 后，还适用于今后从同一根工作区发起的成员任务。不选择 `--members` 就不继承，也不会扩展到相邻目录或任意工作树。

`/permissions revoke` 可在运行中撤销：尚未开始的根与成员动作、待批准请求失效；已经开始的动作可用 `Ctrl+C` 停止，已经产生的副作用不回滚。授权记录由 Agent 保存在 Anthias `data/permissions/`，与 Session、记忆和项目规则分开。保存失败会分别说明本次会话是否生效、跨启动设置是否保存；以 `/permissions` 的实际结果为准。

### 失败、重试与继续

`/diagnostics` 显示最近 Run 的安全分类、HTTP 状态、Provider 结束原因、受控错误码和参数字段、用量、请求结构计数及自动重试次数。Provider 返回思考用量时会显示；它属于输出用量，不能再次加总。旧 Session 缺失字段保持未知，不补猜历史原因，也不保存请求正文或原始异常。

一次普通模型生成只会针对明确的暂时网络、限流或服务错误最多额外重试两次，等待时间和次数在 TUI 可见。已经显示正文、Reasoning、工具参数片段，或收到完整 ToolCall 后不会自动重试；认证、配置、未知错误和输出截止也不重试。压缩、审批与 Tool 执行不套用这套重试。服务要求等待超过 30 秒、剩余任务时间不足或用户停止时，后续请求终止；重试不重置共享任务时限。

停止后先查看诊断，再用 `/continue` 或 `/continue 缩小剩余范围` 明确继续。它会保留已完成消息、Tool 结果和产物，开始新的 Run 核对剩余工作；恢复与回放不会自动重放历史工具、审批或 Git 操作。

输入被 busy 或状态拒绝时会保留为可编辑草稿；如果等待期间已经输入新内容，新草稿不会被覆盖，可用 `/draft` 取回上一份未接受的输入。此恢复入口只属于当前交互 TUI，不是跨退出保存；普通管道输入需要重新输入任务。运行中不支持的输入不会隐式排队。

### 网页搜索

在 Anthias 根 `.env` 填写可选的 `SEARCHAPI_API_KEY` 并重启后，可以直接要求 Agent“搜索相关官方文档并给出来源”。Agent 使用内建 `web_search`，不需要连接 MCP，也没有单独的 `/search` 命令。未配置时其余 Coding 能力仍可启动，实际搜索会说明缺少的变量。

搜索固定使用 SearchAPI Google，接受非空 query 和可选正整数 page，默认第一页，不自动翻页或抓取全文。查询最多 2000 字符，一次响应最多 1 MiB，呈现结果最多 20 条、总计 60 KiB；请求超时为 15 秒，支持 `Ctrl+C` 取消。结果含标题、链接、摘要和来源；这些是外部不可信事实，不构成授权，只有摘要时不能声称已经阅读全文。不要把项目文件、密钥或完整会话放进查询。

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

模型只获得已连接且符合预算的工具定义。MCP 工具经过当前模式的审批；只读成员拒绝未知外部工具。资源和模板不是新的用户授权。工具预览最多 32 KiB，原文产物最多保留 256 KiB，完整性单独标记；当前不支持 OAuth 登录、自动安装、二进制呈现及 MCP Apps。

## 8. 记忆与项目规则

开始任务或明确继续会话时，Agent 自动加载项目根目录的 `AGENTS.md`，并采用当前有效记忆。Git 项目使用当前工作树的根目录；非 Git 项目使用选定的 Workspace。首版不扫描嵌套规则，文件不存在可以正常工作，读取失败或超过 64 KiB 时会暂停本次请求并显示原因。

记忆统一保存在 **Anthias 仓库根目录的 `memory/`**，当前示例为 `C:\projects\anthias\memory`。它与任务 Workspace、Session 目录分别管理，已排除在版本控制之外：

- `user/` 保存用户偏好、习惯与长期要求，条目可以限定当前项目。
- `experience/<project-id>/` 保存项目事实、经过验证的做法与适用条件；同一 Git 仓库的 worktree 共享项目身份。
- `state/` 保存自动记忆开关与写入协调状态。

| 操作 | 用法 |
| --- | --- |
| 查看当前项目与通用记忆 | `/memory` |
| 筛选类别与状态 | `/memory list user candidate`、`/memory list experience review` |
| 查看全部项目 | `/memory all`，也可追加类别与状态 |
| 查看正文、来源、条件和时间 | `/memory show <id>` |
| 保存长期偏好 | `/memory save user global 以后回答先给结论` |
| 保存项目经验 | `/memory save experience project 测试需要在仓库根目录执行` |
| 纠正正文 | `/memory correct <id> <版本> <新正文>` |
| 确认候选 | `/memory confirm <id> <版本>` |
| 遗忘 | `/memory forget <id> <版本>` |
| 同时停止发送相关历史内容 | `/memory forget <id> <版本> no-send` |
| 自动记忆开关 | `/memory on`、`/memory off` |
| 完整语法 | `/memory help` |

列表显示 `id @版本`；维护时使用最新版本，避免覆盖其他会话的修改。支持的状态为 `active`、`candidate`、`review`、`expired`、`forgotten`，`all` 表示全部状态。查询可在运行中使用，人工维护和开关切换需先停止当前 Run。

自动记忆默认开启。可以直接告诉 Agent“记住，以后回答先给结论”，或要求它查找项目经验；模型通过同一受管入口查询和维护。推断出的偏好先成为候选，用户确认后才可采用；经验引用实际已完成的 Tool 结果。关闭自动记忆仍允许读取和用户明确要求的维护。受管 Anthias 记忆维护不因此开放工作区写入。

长期偏好没有统一到期天数；临时记忆可带到期时间，经验可关联复核时间、分支和文件内容。到期后退出默认采用，条件变化后进入待复核；读取不会刷新最后确认时间。需要设置这些条件时，通过自然语言明确告诉 Agent 期限和关联文件。确认候选也不会跳过仍不满足的条件。

发生冲突时，先检查范围和有效性，再按“当前真实用户要求 > AGENTS.md > 有效经验记忆 > 用户记忆”处理。普通更新追加来源新版本；遗忘会移除对应记忆采用及受影响摘要，`no-send` 还过滤相关原文的模型投影。原始 Session 仍保留历史事实，不等同于物理删除全部记录。

初始快照采用固定顺序，按需读取的 Skill、MCP 和记忆正文只注入一次。`/context` 继续显示各用途用量；Provider 未返回缓存数据时保留未知，不能据此判断为零命中。详细合同和本地证据见 [Feature 008 Report](specs/feature008-memory-and-prompt-orchestration/report.md)。

## 启动遇到问题

- **找不到 `anthias`**：先在当前窗口定义第 4 节的函数，或直接使用第 3 节的 Node 绝对入口。
- **找不到 `dist/main.js` 或依赖**：回 Anthias 仓库安装依赖并执行 `pnpm build`，保留完整仓库及其依赖目录。
- **提示缺少模型配置**：检查 Anthias 根 `.env` 的第 2 节变量、自定义模型窗口，以及进程环境是否覆盖了文件配置；任务工作区里的 `.env` 不参与加载。
- **配置文件或默认模式无效**：按提示检查变量、文件位置或行号；不要把 Key 粘贴到错误反馈中。`/mode` 不会修复或保存根配置。
- **搜索不可用**：检查 `SEARCHAPI_API_KEY`，或按结果中的认证、限流、配额、超时提示处理；其余 Coding 功能不依赖搜索配置。
- **Workspace 与预期不一致**：从目标目录直接调用 CLI，或显式使用 `--workspace`。根目录的 `pnpm start` 会通过 pnpm 进入 TUI 包目录；它适合开发脚本调用，不应用来隐式选择外部工作区。
- **Session Workspace 不匹配或正在使用**：使用原 Workspace 恢复，并先退出占用该 Session 的另一个 Anthias 进程。

日常开发验证在仓库根目录运行 `pnpm verify`。它使用确定性本地测试。Feature 009 的配置、搜索、授权与交互能力已实现，待开发者验收；本 Feature 未完成真实模型或 SearchAPI 调用、Windows Terminal 主观体验验收，不能用本地模拟结果代替。

## MultiAgent 与本地 Git

[Feature 014](specs/feature014-unified-multi-agent/spec.md) 将成员统一为持续协作：根负责分工和生命周期，成员默认在当前工作区修改，普通目录也能使用；需要 Git 隔离或成果交付时，才要求已有提交的仓库和可用 Git。当前实现与验证边界见 [Report](specs/feature014-unified-multi-agent/report.md)。

| 操作 | 用法 |
| --- | --- |
| 查看成员、任务和状态 | `/agents`、`/agent list` |
| 创建可写 / 只读成员 | `/agent spawn 修复指定问题并报告验证`、`/agent spawn --read-only 检查会话恢复` |
| 等待、查看结果 | `/agent wait <成员ID>`、`/agent result <成员ID>` |
| 查看完整工具产物 | `/agent artifact <成员ID> <产物ID> [cursor]` |
| 暂停 / 关闭成员 | `/agent stop <成员ID>`、`/agent release <成员ID>` |
| 继续 / 重新打开 | `/agent resume <成员ID> [任务]`、`/agent reopen <成员ID>` |
| 分派任务、发送邮箱消息 | `/agent assign <成员ID> 下一任务`、`/agent message <成员ID> 补充信息` |
| 共享笔记 | `/agent notes read`、`/agent notes append 协作内容`、`/agent notes replace <读取版本> 整理后的内容` |
| 暂停 / 继续群组 | `/agent group stop`、`/agent group continue` |
| 查看 / 检查工作区阻塞 | `/agents` 查看来源，`/agent recover <blockId>` 检查原命令清理结果 |
| 查看仓库与工作树 | `/git status [worktreeID]`、`/git diff [worktreeID]`、`/git worktrees` |
| 显式创建与绑定工作树 | `/git create [已提交ref]`、`/agent workspace <成员ID> <worktreeID>` |
| 返回根工作区 | `/agent workspace <成员ID> root` |

同时最多根加九名成员执行，更多任务排队；空闲成员保留上下文，不占执行位置。组内通信、状态和共享笔记自动允许，文件写入、命令与 Git 仍按当前三种权限模式执行。批准界面标出成员来源。只读成员可以协作，但不能写代码、执行 Shell 或未知副作用 MCP。

运行中的成员在工具批次结束后接收邮箱，空闲成员自动处理新消息。用户暂停的成员只由用户继续，关闭后的新消息明确拒绝，根可以显式重新打开。根正常完成后停止新唤醒，迟到消息保留历史；失败或用户停止则收束成员；Esc 只中断根当前回答，成员继续。共享任务时限三十分钟，消息不会重置它。共享笔记位于根 Session 的 `shared-notes.md`，每次追加有作者和修订；重整必须携带读取版本，内容不充当授权或控制命令。

编辑文件时 Agent 必须先取得 `read_file` 返回的内容版本，再给 `edit_file/write_file` 传 `expectedVersion`；新建明确用 `missing`。成功写入或编辑返回 `newVersion`，可直接用于下一次修改；同一文件竞争时后写者会收到版本冲突，需要重新读取和调整。命令在自己的工作区占用独占写入阶段，等待和取消会显示在执行状态中。这些协调只覆盖 Anthias 受管操作，外部编辑器和脚本仍以当前系统用户权限运行。

### 工作区受阻时

命令可能仍在运行或持有管道时，Anthias 保留写入保护，并显示 `workspace_blocked`、blockId、成员与工具来源。相关排队和新写入会明确失败；命令 timeoutMs 仍限制执行时间，取锁另以同一数值为上限，结果分别给出等待/执行时长与是否启动。

1. 用 `/agents` 查看阻塞来源；`/agent recover <blockId>` 只核查原命令资源，不重新执行工具。
2. 仍无法确认时，在外部检查并关闭该命令留下的进程或资源。确认已清理后，由用户输入 `/agent recover <blockId> confirm-cleanup`；这会记录用户确认，模型不能使用这项绕过检查的确认。
3. Esc 对应输入会在自己的阻塞解除后继续；若后来按过 Ctrl+C，输入仍暂停，需要明确 `/continue`。重复 Esc 不复制消息，未发送草稿不会被提交。

已保存的阻塞位于 Session 数据目录的 `workspace-blocks/`，重启会重新加载；没有原句柄时需要用户核查。仅保存已发生的阻塞，无法保证进程崩溃前尚未落盘的状态。阻塞目录损坏时写入保持关闭，修复目录后重新启动。浏览器命令仍可能输出 Done 后超时，详见 [事故记录](docs/incident/2026-09-11-multi-agent-workspace-blocking.md)。

需要隔离时，先 `/git create`，再 `/agent spawn --worktree <ID> 任务`，或停止已有成员后绑定。工作树只含创建时指定提交，根工作区的未提交修改保留原地，不自动带入依赖、凭据或服务。默认代码目录为 `data/worktrees/<根SessionID>/`，可通过绝对路径 `ANTHIAS_WORKTREE_DIR` 覆盖；它独立于 Session 历史目录。

成员停止后，先看差异，再明确提交文件列表：

```text
/git commit {"worktreeId":"<worktreeID>","paths":["src/example.ts"],"message":"修复明确问题"}
/git integrate <worktreeID> <返回的commit>
/git diff
/git continue
/git remove <worktreeID>
```

`integrate` 把成果放入根工作区暂存区，`continue` 核对后创建本地提交；冲突保留现场，修复后继续或用 `/git abort` 中止。提交、集成和回收都受权限约束，不自动推送。根目录有暂存内容或未完成 Git 操作时拒绝集成。

移除只针对本根 Session 创建、已停止且干净的受管工作树。未集成的已提交成果需要显式 `/git remove <worktreeID> discard`，不会强制删除脏目录或删除分支。关闭成员保留代码与历史。应用退出会释放资源并保留恢复状态；重启不自动运行，使用 `/agent group continue` 明确继续，关闭成员则先 `reopen`。资源缺失时保留诊断，不偷偷重建。
