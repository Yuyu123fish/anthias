# Windows 沙箱与 AutoAllow 调研

状态：已确认共享受限账号及首期简化方向；具体执行器仍为候选，尚未安装或实施。检索截止：2026-09-09。

本次核对的 Anthias 为 `main`，HEAD `ebce85e8cb96d38c20a64b73e88abf5e5946a3da`；开始时工作区干净。依据当前源码、官方文档和官方开源实现，不采用第三方文章作为结论依据。本次没有安装沙箱、修改系统权限、运行隔离实验或调用真实模型。

## 要回答的问题

1. 主流 Coding Agent 在 Windows 上究竟使用什么隔离机制，哪些只是审批规则？
2. Anthias 应优先考虑原生 Windows、WSL2，还是虚拟机？有没有值得复用的实现？
3. 加入 OS 沙箱后，现有工作区授权和 AutoAllow 应怎样变化，才能减少打断又不扩大未授权操作？

初步建议：优先评估 Windows 原生受限执行，保留现有授权语义；把 AutoAllow 与实际生效的文件、网络、进程边界关联起来。是否进一步允许“项目范围内的通用命令自动执行”，需要另外确认。沙箱可以限制误操作的影响范围，不能判断一次删除、提交或远程操作是否符合用户要求。

## 本轮收敛：先做一个 Windows 子进程执行入口

开发者已确认：所有项目与成员直接共用一个 Windows 受限账号，接受该账号承载各项目已开放的 OS 权限，不要求项目间或成员间的 OS 隔离。其余首期简化方向已认可；具体依赖仍待验证，尚未授权安装或实现。

**首期目标是通过一个共享受限账号保护授权范围外的宿主文件和资源，让已授权的开发命令受限执行。所有项目、根 Agent 与成员共用这个账号；现有应用权限规则继续决定各任务可以调用什么工具。** Feature 007 明确没有承诺成员级 OS 隔离；只读成员目前固定为 Plan。无需为了接入沙箱新增成员账户或逐成员 ACL。[Feature 007 Spec](../../../specs/feature007-multi-agent/spec.md)、[成员模式](../../../apps/agent/src/multi-agent/members.ts)

已认可的首期范围控制为以下五项：

1. **只评估一个原生 Windows 执行器。** 优先验证现成 `sandbox-runtime`，不先开发账户、WFP、AppContainer 或通用多后端框架。候选不满足边界时重新选型，不为迁就它不断加补丁。
2. **各任务登记固定资源范围，共享账号承载 OS 权限。** 工作区、该根任务的受管 worktree 目录、必要 Git commonDir、专用临时/缓存目录和工具只读目录在启动时确定；允许这些已开放目录的权限在共享账号上叠加。仓库已有按 `rootSessionId` 分组的 worktree 目录，可沿用；只开放实际需要的目录。[Git 目录管理](../../../apps/agent/src/tool/basetool/git/index.ts)
3. **进程入口集中，其他权限保留。** Shell 是第一条验证链路。宣称完整覆盖外部代码执行前，还必须接入内部 Git 和 stdio MCP 启动；内置文件 Tool 保持宿主内的受信路径检查，Session、授权记录和模型请求仍由主进程持有。不得将子进程沙箱称为全部 Tool 的 OS 沙箱。
4. **AutoAllow 首期沿用。** 保留 Plan、Agent、AutoAllow、已有 grant 和独立审核；增加实际隔离状态核对，沙箱不可用就停止受影响的命令。暂缓逐命令自动扩目录、动态网络扩权、通用项目自动授权。沙箱内许可不因命令字符串相同就变成宿主执行许可。
5. **资源变化在安全时点处理。** 固定范围不足时说明缺少的目录或网络权限，待受影响进程结束后显式重建范围。首期不建设在线 ACL 变更系统。网络先验证禁网；需要联网的开发流程再使用执行器已有的受控出口能力，不自建代理或凭据注入系统。

共享账号是已确认的取舍。不同项目的已开放目录可以在该账号上形成共同的 OS 访问范围，项目之间不承诺系统级隔离，不再将跨项目权限叠加视为选型阻塞。任务与成员的动作授权仍由现有应用规则检查，AutoAllow grant 不因此自动转移给其他任务；并发只需核对资源持有和清理是否正确。

本机只读核查发现：Node 位于 `C:\tools\node`，Git 和 PowerShell 7 位于 `C:\Program Files`，而 pnpm 启动脚本位于 `%APPDATA%\npm\pnpm.ps1`。低权限账户能否读取入口及其实际依赖、使用独立缓存，是比抽象平台扩展更早需要验证的兼容性问题；不能因此直接开放整个用户目录。

## Anthias 当前已有的基础

当前并非只有模型审核。工作区授权已经支持文件范围、精确命令、显式命令前缀、cwd、记住授权以及成员适用范围；只有 `auto_allow` 消费这些授权，未命中才进入独立审核。`agent` 保持逐动作确认，`plan` 保持只读。命令仍以当前系统用户权限执行，cwd 和 worktree 不形成 OS 隔离。见[技术基线的工作区授权](../../../docs/technical-baseline.md#工作区授权)。

本次源码核查定位到以下入口，后续实施可从这里继续：

| 入口 | 已核实行为 | 源码位置 |
| --- | --- | --- |
| 工作区授权 | 只供 AutoAllow 使用；成员需要 includeMembers；审批与执行开始前再次核对授权版本 | [workspace-permissions.ts](../../../apps/agent/src/permission/workspace-permissions.ts) 第 224 行；[session-agent.ts](../../../apps/agent/src/session-agent.ts) 第 671、1058 行 |
| 审批等待 | 校验请求 ID、Run、phase，取消解除等待；先记录批准，再记录执行开始 | [session-agent.ts](../../../apps/agent/src/session-agent.ts) 第 514、594 行 |
| 命令执行 | 复核 cwd 真实路径与身份后，以当前用户启动 Shell；有环境白名单，没有 OS 隔离 | [execute-command.ts](../../../apps/agent/src/tool/basetool/execute-command.ts) 第 147、179、498 行 |
| MCP | 显式 connect 即启动 stdio server；后续工具审核不能约束已发生的启动副作用 | [mcp/index.ts](../../../apps/agent/src/mcp/index.ts) 第 468 行；[external-capabilities.ts](../../../apps/agent/src/external-capabilities.ts) 第 275 行 |
| Git | 固定 argv，但仍直接启动当前用户 Git；应覆盖其 hooks 与外部 helper | [git/command.ts](../../../apps/agent/src/tool/basetool/git/command.ts) 第 40 行 |
| 成员 | 同进程 SessionAgent；只读成员用 Plan，可写成员使用 worktree；共享 MCP 与根授权服务 | [members.ts](../../../apps/agent/src/multi-agent/members.ts) 第 156、298 行；[agent.ts](../../../apps/agent/src/agent.ts) 第 187 行 |

最直接的缺口是：允许 `pnpm test` 只能说明允许启动这条命令，不能限制其测试脚本、依赖包或子进程访问工作区外的文件与网络。脚本内容还可能在授权后发生变化。这是加入执行隔离的原因，也说明继续扩充命令解析器无法独立解决问题。

现有 Agent 已持有权限、工具、MCP 和 Git 行为，TUI 负责呈现。后续可以由 Agent 内部组织受限执行进程，沿用现有取消与事件合同；无需先改变产品交互形态。见[技术基线](../../../docs/technical-baseline.md)、[产品定义](../../../docs/product-definition.md)。

## 主流实现比较

以下区分“产品文档声明”“官方源码已有”和“尚未验证”。在线文档会变化，不能把当前 main 的能力直接归到旧安装版本。

| 对象 | Windows 隔离路线 | 审批与沙箱的关系 | 对 Anthias 的参考价值 |
| --- | --- | --- | --- |
| Codex | 原生 Windows；首选专用低权限用户、ACL、防火墙的 `elevated` 方案，另有当前用户受限 token 的较弱 `unelevated` 方案 | 沙箱定义资源范围，审批决定越界请求能否执行；Auto-review 接管符合条件的审批 | 最直接的原生 Windows 产品参照 |
| Claude Code | 当前产品 Bash sandbox 支持 macOS、Linux、WSL2；不支持原生 Windows | 沙箱内 Bash 可 auto-allow；权限模式与无沙箱重试仍有独立规则 | 自动执行体验、越界提示和回退合同 |
| Cursor | 官方工程文章说明 Windows 使用 WSL2 内的 Linux sandbox；Linux 使用 Landlock、seccomp | `sandbox.json` 限制执行，Auto-review classifier 做审批判断 | 有效隔离范围与运行模式应分开表达 |
| Gemini CLI | 原生受限 token、Low Integrity、Job Object；主干网络约束为限速尝试，设置失败仍继续 | 有 Tool 级隔离及单次 sandbox expansion 概念 | 不能仅凭“支持 Windows”推断网络隔离强度 |
| VS Code 内 Copilot Agent | 当前终端 sandbox 为 Preview，支持 macOS、Linux、WSL2；所查文档未列原生 Windows | 终端规则、LLM 辅助审批与 sandbox 独立；stdio MCP 也有平台受限的隔离能力 | 应单独覆盖 MCP server 的执行权限 |
| OpenCode | 所查 V1/V2 权限文档说明动作、资源与 allow/ask/deny，没有据此证明内置原生 Windows OS 沙箱 | 权限规则本身是调用前决策 | 可比较授权表达；不能把规则匹配视为系统隔离 |

对应来源：[Codex Windows](https://learn.chatgpt.com/docs/windows/windows-sandbox)、[Codex Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review)、[Claude Code sandbox](https://code.claude.com/docs/en/sandboxing)、[Cursor 实现](https://cursor.com/blog/agent-sandboxing)、[Cursor Run Modes](https://cursor.com/docs/agent/security/run-modes)、[Gemini sandbox](https://geminicli.com/docs/cli/sandbox/)、[VS Code 安全机制](https://code.visualstudio.com/docs/agents/run/security)、[OpenCode V1](https://opencode.ai/docs/permissions/)、[OpenCode V2](https://opencode.ai/v2/docs/permissions)。

### 几个会影响选型的细节

- **Codex 的 elevated 不表示模型命令以管理员运行。** 管理员批准用于建立低权限账户和系统边界；`unelevated` 的环境级离线限制弱于专用账户防火墙。两者不能标成同一个安全等级。当前文档还说明私有 desktop 和企业可限制的回退方式。[Windows 文档](https://learn.chatgpt.com/docs/windows/windows-sandbox)
- **自动审核可以保留，但不必对已有许可的每条命令调用模型。** Codex 的 Auto-review 主要处理原本需要批准的请求，不自动扩大基础权限；明确拒绝后需要更安全的路径或交回用户。[Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review)
- **不可用与无沙箱重试是两个开关。** Claude Code 分别提供 `failIfUnavailable` 和 `allowUnsandboxedCommands`；默认不可用时可警告后无沙箱运行。其 Bash sandbox 不等于所有内置文件工具都进入隔离进程。[Claude Code sandbox](https://code.claude.com/docs/en/sandboxing)
- **产品可以选择较宽的读取范围。** Cursor 的文档将部分 Git/IDE 配置列为写保护，但同时明确 `~/.ssh` 始终可读。这不适合作为 Anthias 凭据保护的默认模板。[Cursor sandbox 配置](https://cursor.com/docs/reference/sandbox)
- **“提供 sandbox”不能证明所有出口都受约束。** 还要核对 shell、内置文件工具、MCP、Git、凭据代理与已有宿主服务；文档未说明的路径保留为未知。

### Gemini：主干源码与文档的差异

本次固定到官方主干 `c647533d6c017d032420e032f932953d7df900dc`，不是对所有稳定安装包的声明。Windows 的 C# helper 确实创建 Restricted Token、设置 Low Integrity 并使用 Job Object；所查执行路径没有使用 AppContainer。网络关闭参数对应 `JobObjectNetRateControlInformation` 的 `MaxBandwidth = 1`，设置失败只警告并继续。准确结论是 OS 级限速尝试，不能称为可靠的断网边界。[GeminiSandbox.cs](https://github.com/google-gemini/gemini-cli/blob/c647533d6c017d032420e032f932953d7df900dc/packages/core/src/sandbox/windows/GeminiSandbox.cs#L188-L245)

部分内置文件操作经 SandboxedFileSystemService 和 helper 的受限 token impersonation 执行，说明沙箱可以覆盖 Shell 之外的文件工具；但不能外推所有搜索、glob、读文件路径都进入同一隔离进程。[服务装配](https://github.com/google-gemini/gemini-cli/blob/c647533d6c017d032420e032f932953d7df900dc/packages/core/src/config/config.ts#L961-L1015)

Sandbox expansion 合并额外文件和网络权限后仍进入原后端；批准扩权不必退出沙箱。这个交互方向值得参考，具体网络后端仍需独立评估。[默认策略](https://github.com/google-gemini/gemini-cli/blob/c647533d6c017d032420e032f932953d7df900dc/packages/core/src/policy/policies/sandbox-default.toml#L1-L26)、[Expansion 文档](https://geminicli.com/docs/cli/sandbox/#sandbox-expansion)

## Windows 的几条技术路线

| 路线 | 系统真正负责的事 | 代价与适用范围 |
| --- | --- | --- |
| 专用低权限用户＋受限 token＋ACL＋WFP/防火墙 | 在原生 Windows 上限制文件、进程身份与网络出口 | 保留 Windows 工具链；需要初始化、ACL 恢复、账户与网络规则维护 |
| AppContainer | 对应用身份、凭据、文件/注册表、网络、进程及窗口施加约束 | 值得作为候选；通用开发工具的启动、证书、缓存和 IPC 兼容性需要实测 |
| WSL2 内的 Linux sandbox | 由 Linux 隔离原语约束 Linux 命令 | 适合 Linux 工具链；还要处理 Windows 盘映射与 interop，不能仅启动 WSL 就称为沙箱 |
| Windows Sandbox / 专用 VM | 以独立内核隔离执行环境 | 更适合不可信工程或独立验证环境；工具安装、文件交付和环境复用成本更高 |

AppContainer 的能力见微软[隔离说明](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)与[传统 Win32 应用接入](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-for-legacy-applications-)。上述适用性是针对 Anthias 的推断，尚未通过原型验证。

Low Integrity 主要解决低完整性进程不能向更高完整性对象写入的问题；默认 `NO_WRITE_UP` 不等于禁止读取。Job Object 主要管理进程组和资源，通常可以覆盖子进程，但存在 breakaway 和外部服务代为启动等边界。两者都不能单独宣称提供完整文件、凭据和网络隔离。[MIC](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control)、[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

WSL 默认支持挂载 Windows 盘、启动 Windows 程序；应核对这些桥接能力是否被选定的 Linux sandbox 封住。Windows Sandbox 则使用独立内核，关闭后清除内部状态，宿主安装的工具不会自动可用，而且默认启用网络；映射出去的可写目录依然会影响宿主。[WSL 配置](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)、[Windows Sandbox](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/)、[映射与网络设置](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file)

Docker Sandboxes 是另外一个可复用的产品方向。当前 `sbx` 文档描述 microVM、独立 Docker daemon 和网络代理；Windows 安装要求为 Windows 11、x64 与 Windows Hypervisor Platform，文档明确不再要求先安装 Docker Desktop/Engine。它可以列入隔离验证环境的候选，但不能默认提供 Windows 原生工具链。其宿主侧 MCP gateway 还可能启动宿主 stdio server，不能由 VM 的隔离结论外推 MCP 也在 VM 内。[安装](https://docs.docker.com/ai/sandboxes/install/)、[架构](https://docs.docker.com/ai/sandboxes/architecture/)

## 优先核对的可复用实现

Anthropic 独立 `sandbox-runtime` 的当前 README 已标记 Windows alpha，采用专用用户、ACL、WFP、受限 token 和 Job Object，并提供 TS 库入口；首次初始化需管理员批准。它与 Claude Code 产品当前支持范围要分开看。[官方仓库](https://github.com/anthropics/sandbox-runtime)

版本证据：本次源码固定在 `66d35e5ffeba5f406db4343ef88bef0c2fd5bab6`，manifest 声明 Node `>=20.11.0`、ESM 与类型声明，满足 Anthias 的运行时版本前提。GitHub 有 `v0.0.75` Release，其对应提交的 README 同样包含 Windows 路线；续查已从 npm 官方 registry 获取实际 `0.0.75` tarball，在内存中核对 SHA-512 integrity 并列出文件，确认包含 x64、arm64 的 `srt-win.exe` 及 JS/类型声明入口；未安装或执行，运行兼容性仍未验证。[固定 manifest](https://github.com/anthropics/sandbox-runtime/blob/66d35e5ffeba5f406db4343ef88bef0c2fd5bab6/package.json)、[Release](https://github.com/anthropics/sandbox-runtime/releases/tag/v0.0.75)、[Release 对应 README](https://github.com/anthropics/sandbox-runtime/blob/40804af269e1616092e9971de12a1f358f58eba9/README.md)

这使“先评估现成执行器”比立即自建底层更值得尝试，但当前公开限制直接影响 Anthias：Windows 不支持每次执行单独增加 allowRead/allowWrite，授权在 session 初始化时施加；系统 DNS resolver 不受相同网络限制；新出现的 glob 匹配路径不自动获得保护。已确认不同项目和成员共用受限账号，因此不要求不同 JS 对象或进程对应独立 OS 范围；资源回收仍需与实际使用者的生命周期一致。[Windows alpha 说明](https://github.com/anthropics/sandbox-runtime#windows-alpha)

共享身份与已确认方向一致：当前设计使用同一 `srt-sandbox` SID 施加不同会话的 ACL。基于 ACL 语义推断，某会话授予的访问可能对其他同 SID 进程也有效，这是接受的共享账号行为。并发引用计数用于正确清理；逐项目、逐成员 OS 隔离和单次扩权均不属于首期范围。[固定 Windows 说明](https://github.com/anthropics/sandbox-runtime/blob/66d35e5ffeba5f406db4343ef88bef0c2fd5bab6/README.md#windows-alpha)

本地另有 `C:\reference\codex-main` 参考快照。抽查 `windows-sandbox-rs/src/token.rs`、`process.rs`、`env.rs`、`wfp.rs` 可见受限 token、按 token 创建进程、代理环境和 WFP 配置代码，但该目录没有可核对的 Git HEAD；本次不将其视为当前发布版证据，也不据此声称能够直接拆包复用。

### 复用的接入成本与限制

实际发布物可见 [npm 0.0.75](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime/v/0.0.75)；归档中的 Windows x64 helper 为 3,072,000 字节，arm64 为 2,739,200 字节。该检查只证明发布物包含 helper，不证明可运行或隔离有效。

固定到发布提交 `40804af269e1616092e9971de12a1f358f58eba9` 后，Windows 应使用 `wrapWithSandboxArgv()`；字符串包装 API 在 Windows 上直接抛错。调用方将返回的 argv 交给 `spawn(..., { shell: false, env, cwd })`，且同一个 cwd 必须同时传入包装器和 spawn。输入的 command 本身仍是字符串，因此内部 Git 的现有固定 argv 如何保持参数语义、stdio MCP 如何启动，必须在接入前核清；函数名含 Argv 并不表示它接收任意原始程序 argv。[发布版 API](https://github.com/anthropics/sandbox-runtime/blob/40804af269e1616092e9971de12a1f358f58eba9/src/sandbox/sandbox-manager.ts#L1658-L1686)

`SandboxManager` 使用模块级配置、代理与初始化状态，不是每次创建一个互相独立的实例。它生成启动描述，调用方仍持有 ChildProcess、取消和等待退出。`reset()` 清理整个初始化范围的 Windows ACE，错误按 best-effort 处理；应先结束所有相关子进程，再有序 reset，不能每条命令后 reset。已有 AbortSignal 与进程回收逻辑可作为接入基础，但仍需验证退出是否覆盖 helper 和子孙进程。[状态所有权](https://github.com/anthropics/sandbox-runtime/blob/40804af269e1616092e9971de12a1f358f58eba9/src/sandbox/sandbox-manager.ts#L117-L162)、[reset](https://github.com/anthropics/sandbox-runtime/blob/40804af269e1616092e9971de12a1f358f58eba9/src/sandbox/sandbox-manager.ts#L1978-L1986)

本地 Codex 参考快照的 Windows crate 还依赖相邻 protocol、PTY、路径及遥测模块，并包含 setup/runner、IPC、ConPTY 和账户配置。因此“直接抽取 Codex Rust 子系统”的集成面明显大于一个现成 TS 包；这里只把它作为机制参照，暂不建议首期维护一份分叉实现。这个成本判断基于本地快照，不是对当前发布版的断言。

## AutoAllow 可以怎样演进

以下为后续演进方向，尚未确认。首期只沿用现有审批语义并核对沙箱状态；本节的细粒度新增能力审核和授权扩展不自动进入首期范围。

### 先把授权与执行条件关联起来

保留已有的真实用户来源、硬禁止、成员限制、精确命令和命令前缀。让一次自动放行同时满足：动作已获授权、未命中禁止规则、当前执行器能落实所需资源限制。

授权记录应能区分沙箱内执行与宿主执行，注明文件范围、网络范围、有效期及成员范围。已有命令条目可以保留原文字范围；以后从受限执行切换到宿主执行，或增加网络/目录权限时，不能仅因命令字符串相同而沿用旧许可。

界面仍可保留 Plan、Agent、AutoAllow 三种模式，同时呈现实际隔离状态与生效范围。选择 AutoAllow 不应隐含“无沙箱时自动使用宿主权限”。

### 将审核集中在新增能力和不确定副作用上

| 场景 | 建议行为 |
| --- | --- |
| 已授权的项目测试、构建，所需资源均在有效沙箱内 | 确定性放行，继续使用已有授权快路径 |
| 测试需要额外缓存目录 | 审核具体目录及读写权限；许可不得自动扩到整个用户目录 |
| 安装依赖需要网络 | 单独核对目标域名和凭据用途；放行网络不等于允许发布或上传数据 |
| 读取另一仓库 | 有真实授权时只增加必要的只读目录；按一次或任务范围生效 |
| Git 提交、清理、远程发布 | 保留当前语义授权；沙箱内可写并不能代替用户同意 |
| MCP 修改外部服务 | 核对实际外部动作；不能以本地 shell 有沙箱为由自动放行 |
| 沙箱未初始化、损坏或规则无法落实 | 返回配置/能力错误；不得静默在宿主重跑 |
| 沙箱拦截后申请扩大范围 | 审核新增权限和本次动作，优先保持其余隔离约束 |

审核请求应包含原动作、精确执行参数、当前限制、所缺权限及相关真实用户授权。错误摘要或主 Agent 的“这只是测试”不能代替这些事实。已有批准只对其范围生效，外部网页、工具输出、仓库文本和内部委派不能生成新授权。

第一次失败也不能简单归为 sandbox denial：程序本身可能报权限错误，或已完成部分写入后才失败。应区分启动失败、隔离拒绝、程序退出、超时和取消；重跑前保留已发生的副作用，避免重复执行。

### 更宽的项目授权是后续产品选择

加入沙箱后，可以考虑让用户一次批准“在这个项目中修改代码并运行构建测试”，减少逐条登记命令。但这会改变现有授权范围，不能由安装沙箱自动启用。

即使用户接受这种模式，项目内批量删除、权限配置修改、Git 成果交付、外部系统操作仍需各自明确边界。可写工作区可能被损坏；隔离不会自动撤销磁盘变更，也不会阻止宿主上已运行的 watcher 根据文件变化执行其他动作。

## 实施时不能漏掉的入口

1. **Shell 与子进程。** PowerShell/cmd、Node、Python、测试脚本都必须继承同一实际约束；cwd 检查只解决路径选择。
2. **内置文件工具。** 如果仍在宿主 Agent 进程执行，继续由可信实现按最终路径和权限处理，并明确其保障来自应用校验；若要求同等 OS 约束，则需进入受限执行进程。不能悄悄混称为全工具 OS 隔离。
3. **MCP。** stdio server 的启动本身就会执行外部代码；连接授权、进程沙箱和单次远程动作授权需要分别处理。
4. **Git。** 固定 argv 的内部 Git 操作也可能涉及 hooks、外部 helper、共享 commonDir；受管 worktree 只隔开工作文件，不能证明成员无法触及其他成员或宿主。
5. **凭据与应用数据。** 模型凭据、授权记录和 Session 不应整体暴露给命令。工具链和缓存按实际目录授权，避免为解决安装问题开放整个用户 profile。
6. **共享资源生命周期。** 所有项目与成员共用受限账号，接受已开放目录的 OS 权限叠加。并发核对聚焦退出清理：一个实例结束时，不应误删另一活动实例仍需使用的规则或资源。

网络初始可以只设计“禁用”和“经受控出口访问必要目标”，后续再根据场景扩展。localhost 也需要按服务区分：测试服务器与 Docker daemon、数据库管理接口并非同一类能力。域名获准不能证明所有发往该域名的内容都获准。

## 下一步需要的最小证据

调研已经收窄为一个现成执行器候选。获得原型实施授权后，先验证下列有决定价值的结果，不同时实现多后端，也不直接开展整个沙箱 Feature：

| 验证问题 | 应观察的结果 |
| --- | --- |
| 正常开发是否可用 | Windows PowerShell、Node/pnpm、Git 和实际安装路径可运行；记录初始化、启动与 I/O 成本 |
| 文件边界是否真实生效 | 子进程不能读受保护私密样例、不能写共享账号授权范围外的目录；检查 junction/symlink、重命名和新文件边界 |
| 网络能否绕过代理 | 移除代理变量后 TCP/IPv6/UDP/系统 DNS 的行为清楚；未授权本地服务不可访问 |
| 取消是否完整 | 超时、父进程异常退出后，受管子孙进程与执行器资源按约定结束 |
| 共享账号并发是否正常 | 接受不同项目已开放目录的权限叠加；退出一方不能误清理另一方仍需使用的规则或资源 |
| 拒绝与降级是否可解释 | 不可用时不执行目标命令；拒绝不会触发无沙箱重试；部分执行事实不被抹掉 |
| 系统状态能否恢复 | 正常退出和崩溃恢复后，临时 ACL、代理与执行资源按约定回收；长期安装项有明确卸载路径 |

按已认可方向评估现成执行器的一次管理员初始化流程，同时验证私密样例读取与共享账号授权范围外写入的边界；管理员初始化尚未执行。AutoAllow 的单次越界扩权留到后续讨论，首期不为它新增复杂授权系统。

本次已核实候选发布物与主要接入合同，尚未证明运行兼容性、网络及文件隔离、不同根任务并发和清理行为。后续原型应先回答这些可否使用的问题，结果不足时保持候选状态，不把不确定性隐藏到实施计划中。
