# Feature 003：Pi OS sandbox 调研

状态：Research，尚未形成 Feature 决策
核验日期：2026-09-04

## 开发者速览

> **一句话**：Pi 的 sandbox 示例不能直接用于 Anthias 的原生 Windows 安全边界。<br>
> **核心做法**：对照 Pi 源码与 sandbox-runtime，核验平台判断、执行回退、Windows 机制和生命周期。<br>
> **边界**：调研只证明现状与风险，不选定依赖，也不代表获得系统安装或提权授权。<br>
> **风险 / 未验证**：Windows 支持仍是 alpha，低权限用户、ACL、Job Object 与 WFP 尚未在 Anthias 环境完成 spike。<br>
> **当前 / 请审阅**：Feature 003 仅采纳 Policy 分层、命令隔离和 fail-closed，具体 backend 留给 Plan 验证。

- 所属 Feature：feature003-tool-execution-safety

## 已验证事实

### 1. Pi 自己提供了什么

- Pi README 明确写着“没有内建 permission system”，默认按启动 Pi 的用户和进程权限运行；官方给出的更强隔离路线是 Gondolin、Docker 或 OpenShell。[Pi README](https://github.com/earendil-works/pi/blob/main/README.md#L31-L38)
- Pi 的 sandbox 示例说明它只覆盖 `bash` 命令，macOS 使用 `sandbox-exec`，Linux 使用 Bubblewrap；它不是整个 Agent 进程的隔离层。[示例说明](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts#L1-L9)
- 示例只接受 `process.platform === "darwin"` 或 `"linux"`。其他平台会将 `sandboxEnabled` 设为 `false`；初始化异常也只是关闭 sandbox 并提示错误。[平台与初始化](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts#L221-L269)
- 工具执行时，如果 sandbox 未启用或未初始化，会直接调用宿主 `localBash.execute(...)`。所以 Windows 和初始化失败不是“命令拒绝”，而是“无隔离执行”。[回退路径](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts#L190-L219)
- 示例固定依赖 `@anthropic-ai/sandbox-runtime` `0.0.26`。[package.json](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/sandbox/package.json#L15-L17)

这意味着：不能用“当前 sandbox-runtime 已支持 Windows”反推“Pi 当前已支持 Windows”。两者版本和平台判断都对不上。

### 2. Unix 平台的底层机制

#### Linux

当前 sandbox-runtime 在 Linux 上以 Bubblewrap 建立 mount、user、PID、network 等 namespace：根文件系统先只读绑定，再显式挂载可写路径，并创建独立的 `/proc`、`/dev`，丢弃 capabilities。[只读根与可写挂载](https://github.com/anthropics/sandbox-runtime/blob/main/src/sandbox/linux-sandbox-utils.ts#L886-L889) [namespace 与进程配置](https://github.com/anthropics/sandbox-runtime/blob/main/src/sandbox/linux-sandbox-utils.ts#L1817-L1905)

网络默认在隔离的 network namespace 中，HTTP/SOCKS 流量通过 Unix socket 转发给宿主代理，域名过滤发生在代理层；内核层提供的是“能否出隔离网络”这一层，不理解域名语义。[Linux 网络桥](https://github.com/anthropics/sandbox-runtime/blob/main/src/sandbox/linux-sandbox-utils.ts#L544-L568)

可选 seccomp 在内层进程应用，用来限制 Unix socket 和部分绕过通道；依赖不可用时可以只告警，因此不能把 seccomp 当成所有环境都存在的保证。[两阶段包装](https://github.com/anthropics/sandbox-runtime/blob/main/src/sandbox/linux-sandbox-utils.ts#L1548-L1594) [Unix socket 限制与边界](https://github.com/anthropics/sandbox-runtime/blob/main/README.md#L618-L639)

#### macOS

macOS 使用系统 `/usr/bin/sandbox-exec` 执行动态生成的 Seatbelt profile。profile 描述文件读写、网络和 Unix socket 规则，命令最终通过 `sandbox-exec -p <profile>` 启动。[文件规则](https://github.com/anthropics/sandbox-runtime/blob/main/src/sandbox/macos-sandbox-utils.ts#L1070-L1111) [命令包装](https://github.com/anthropics/sandbox-runtime/blob/main/src/sandbox/macos-sandbox-utils.ts#L1120-L1313)

网络只放行本地代理端口，再由代理执行域名 allow/deny 判断。[Seatbelt 网络规则](https://github.com/anthropics/sandbox-runtime/blob/main/src/sandbox/macos-sandbox-utils.ts#L981-L1068)

### 3. Windows：当前依赖项目的 alpha，不是 Pi 当前方案

当前 sandbox-runtime README 把 Windows 标为 alpha。底层组合不是一个单独的“Windows sandbox API”，而是多层机制：

- 专用低权限本地用户和组；
- `CreateProcessWithLogonW` 启动中间进程，再用 restricted token 启动真正命令，并放入 Job Object；
- 通过 NTFS ACL 给 sandbox SID 增加本次 Session 的 grant/deny ACE；
- 使用 Windows Filtering Platform（WFP）按用户 SID 阻断直接外联，只允许连接本地代理。

官方架构说明见 [Windows 实现注释](https://github.com/anthropics/sandbox-runtime/blob/main/src/sandbox/windows-sandbox-utils.ts#L29-L53) 和 [Windows 安装与校验](https://github.com/anthropics/sandbox-runtime/blob/main/README.md#L417-L486)。它需要一次提权安装来创建用户、组和机器级 WFP 规则；`initialize()` 会检查这些前置条件并做行为校验，缺失时失败。[初始化检查](https://github.com/anthropics/sandbox-runtime/blob/main/src/sandbox/sandbox-manager.ts#L658-L695)

Windows 还存在当前限制：`allowRead`、`allowWrite` 只能在 Session 初始化时确定，单次命令只支持附加 deny；DNS resolver 不受 WFP fence 约束；sandbox 用户默认无法读取只安装给当前用户的工具；代理认证 token 会出现在子进程 argv 中。[Windows 限制](https://github.com/anthropics/sandbox-runtime/blob/main/README.md#L497-L510)

当前 upstream 包版本为 `0.0.75`，声明 ESM 和 `node >=20.11.0`，所以 Node.js 24 在版本约束内，但项目仍标为 research preview。[当前 package.json](https://github.com/anthropics/sandbox-runtime/blob/main/package.json#L1-L12) [项目状态](https://github.com/anthropics/sandbox-runtime/blob/main/README.md#L2-L7)

### 4. 生命周期与执行链

Pi 示例的链路是：

```text
Extension 加载
  -> 注册覆盖内建 bash 的 Tool 与生命周期回调

Session 启动
  -> 读取全局/项目 sandbox 配置
  -> SandboxManager.initialize(config)

一次命令
  -> 检查 sandboxEnabled / sandboxInitialized
  -> SandboxManager.wrapWithSandbox(command)
  -> 宿主 spawn("bash", ["-c", wrappedCommand])
  -> timeout / abort 时终止进程组

Session 关闭
  -> SandboxManager.reset()
```

对应源码为 [配置加载](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts#L52-L122)、[包装和 spawn](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts#L125-L188)、[关闭清理](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts#L270-L278)。

当前 sandbox-runtime 自身也是 `initialize -> wrap/spawn -> reset`。Windows 初始化时应用 Session 级 ACL、启动代理；reset 时撤销 ACL、停止代理和监控资源。[库调用示例](https://github.com/anthropics/sandbox-runtime/blob/main/README.md#L139-L191) [Windows ACL 应用](https://github.com/anthropics/sandbox-runtime/blob/main/src/sandbox/sandbox-manager.ts#L748-L860) [reset 清理](https://github.com/anthropics/sandbox-runtime/blob/main/src/sandbox/sandbox-manager.ts#L1978-L2068)

### 5. 它能限制什么，不能保证什么

能限制的主要是被包装命令及其子进程所能触达的资源：文件读写路径、直接网络连接、部分 Unix socket，以及进程树的结束。它缩小的是 blast radius。

它不能单独保证：

- 判断命令的业务意图，或识别全部危险命令变体；
- 保护被明确挂载为可写的工作区，工作区内仍可能被破坏；
- 约束没有经过这个 executor 的 Node 文件 API、其他 Tool、自定义 Extension 或 Agent 主进程；
- 防止数据被发送到已允许域名；
- 覆盖各平台的所有内核通道和实现缺口；
- 把 Docker/Gondolin 的宿主工作区挂载变成副本，写入仍会透传到宿主。

Pi 的容器化文档也区分“把整个 Pi 放入隔离环境”和“仅把某些 Tool 路由到隔离环境”；自定义 Tool 若没有显式委托，仍在宿主运行。[Pi 容器化边界](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md#L2-L13)

Gondolin 是更强的 Linux micro-VM 路线：命令与内建文件 Tool 都可转入 VM，但宿主工作区挂载到 `/workspace`，写入仍是 write-through；它当前列出的宿主要求只有 macOS/Linux 和 QEMU，并非原生 Windows 方案。[Pi Gondolin 示例](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/gondolin/index.ts#L1-L19) [Gondolin 平台要求](https://github.com/earendil-works/gondolin/blob/main/README.md#L69-L86)

## 对 Anthias 的建议

### 1. approval 与 OS sandbox 必须分层

建议把两者理解成不同问题：

1. Policy / approval 判断“这次操作是否允许、允许到什么范围”；危险命令硬拒绝属于这一层。
2. OS sandbox 把上面的决定转成内核可执行的资源边界，约束真正启动的进程。

不能让 sandbox violation 或初始化失败自动退回宿主执行。Anthias 应 fail-closed：返回结构化拒绝，说明缺失的能力或路径；只有用户明确批准一个可描述的扩大范围后，才创建新的受限执行。硬拒绝规则不进入 approval，不允许通过“确认”绕过。

Plan / Agent 权限模式也不要与 OS sandbox 混成一个枚举。Plan 决定是否能调用有副作用 Tool；Agent 即使能调用命令，也仍应默认运行在 `workspace-write + network-deny/allowlist` 的 sandbox 中。

### 2. 不直接复制 Pi 示例

可以借鉴它的 lifecycle 和 Tool override 思路，但不能照搬三个关键行为：

- 不支持的平台不能静默降级；
- 初始化失败不能调用宿主 executor；
- 只包 `bash` 不足以覆盖 Anthias 的文件 Tool 和以后新增的有副作用 Tool。

建议在 Agent 内形成一个窄接口的深 Module，例如由 Session 持有 `CommandSandbox`，对 ToolRunner 只暴露初始化、执行、取消和关闭。Linux、macOS、Windows 是三套 backend；“Unix”只能作为产品文档分类，不能掩盖 Bubblewrap 与 Seatbelt 的差异。

### 3. Windows-first 的落地顺序

Feature 003 可以先确认安全语义和 backend seam，但把当前 sandbox-runtime Windows alpha 作为限时 spike，而不是直接确定生产依赖。建议 spike 只使用临时目录、无害命令和本地 loopback server，至少验证：

- 未安装、安装损坏和初始化失败时严格拒绝执行；
- 工作区可写、工作区外不可写，并且拒绝不会先产生副作用；
- PowerShell 7、Node、pnpm 与项目本地依赖对专用用户可读；
- abort/timeout 能结束完整子进程树；
- 默认网络拒绝，allowlist 只通过代理生效；
- 正常退出和异常恢复后 ACL 被清理；
- 并发命令不会共享一次临时扩大权限。

最后一点尤其重要：Windows 的 read/write grant 是 Session 级，而不是单命令级。如果一个命令获得临时目录授权，同时并行运行的另一个命令也可能看到这份 grant，就产生 capability leak。短期可以选择“有临时扩大权限的命令独占执行”，或为它创建独立短生命周期 sandbox；不要在共享 Session 中边并行执行边修改全局 ACL。

Docker Desktop、WSL2 或 Gondolin 可以作为显式选择的更强隔离路径，但它们不是无感的 Windows 原生实现，也不应成为 native backend 失败后的静默回退。

## 未决问题

- Anthias 首期要隔离的范围只是 command Tool，还是 write/edit 等所有有副作用 Tool？只隔离 command 时，整体安全承诺必须写得更窄。
- Windows 是否接受一次 UAC 安装、专用本地用户和机器级 WFP 规则？这属于产品安装体验，不只是代码实现。
- Session 级基础权限与单次 approval 扩权如何共存？在 Windows backend 验证前，不应承诺“并行执行 + 单次路径授权”同时成立。
- Feature 003 是否要求 macOS 可运行验证，还是只要求接口设计和一手源码证据？当前开发环境无法替代真实 macOS 验收。

## 证据边界

以上 Pi 结论以其 `main` 分支当前源码及示例固定依赖为准；sandbox-runtime 的 Windows 内容以其当前 `main` 分支为准，属于依赖项目的后续 alpha 能力。Research 说明“现状与风险”，不等同于 Anthias 已选择依赖、完成平台支持或授权实施。
