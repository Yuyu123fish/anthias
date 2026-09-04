# Feature 003：Windows OS sandbox 取舍调研

状态：Research 已完成
核验日期：2026-09-04

## 开发者速览

> **一句话**：Windows sandbox-runtime 当前侵入系统且边界不完整，本 Feature 不采用 OS 沙箱。<br>
> **核心做法**：对照 Pi、sandbox-runtime 源码和本机前置条件，区分人工确认与内核隔离。<br>
> **边界**：不安装依赖、不提权，也不创建账户或修改 ACL、WFP。<br>
> **风险 / 未验证**：命令仍拥有 Anthias 当前用户权限，HITL 不能替代 OS 隔离。<br>
> **当前 / 请审阅**：取舍已确认；若未来需要强隔离，另开 Feature 在 VM 或容器中验证。

- 所属 Feature：feature003-tool-execution-safety
- 研究用途：决定 Feature 003 是否引入 Windows OS sandbox

## 研究问题

1. Pi 当前怎样隔离命令，是否存在可直接复用的原生 Windows 方案？
2. `@anthropic-ai/sandbox-runtime` 的 Windows 实现会修改哪些系统状态？
3. 它能否可靠实现 Anthias 需要的“工作区可写、工作区外不可写”？

## 已验证事实

### Pi 的边界

- Pi 本身不提供内建 permission system，默认命令继承启动进程的用户权限；官方把更强隔离交给容器或 VM。[Pi README](https://github.com/earendil-works/pi/blob/main/README.md)
- Pi 的 sandbox 示例只为 macOS 和 Linux 装配 backend；不支持或初始化失败时会回退到宿主命令执行，因此不能作为 Anthias 的 fail-closed Windows 方案。[Pi sandbox 示例](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts)

### Windows 候选的边界

- `@anthropic-ai/sandbox-runtime` 的 Windows 支持仍标为 alpha。它需要一次管理员级 setup，创建本地账户和组、写入机器级状态，并配置 WFP；运行时还会调整 NTFS ACL。[sandbox-runtime README](https://github.com/anthropics/sandbox-runtime/blob/main/README.md)
- Windows 文件限制依赖既有 DACL。若某个工作区外目录已经向 `Authenticated Users` 等主体授予修改权限，单独给 sandbox SID 添加限制不能证明所有写入都被阻止；upstream 也有对应缺口记录。[sandbox-runtime issue #402](https://github.com/anthropics/sandbox-runtime/issues/402)
- 当前实现不等同于虚拟机或容器：它会影响真实 Windows 主机上的账户、ACL 和网络过滤配置，异常清理或权限继承问题会增加维护成本。

### 本机只读核对

调研时本机没有候选运行库的 setup 状态、专用用户、专用组或 `srt` 命令。只下载并检查了精确 npm 包的发布内容，没有运行安装脚本、UAC setup 或任何真实沙箱命令。

## 项目结论

Feature 003 不引入 OS sandbox，也不保留未来 backend 的空接口。原因不是 OS 隔离没有价值，而是当前 Windows 候选同时存在两类不匹配：

1. **安全承诺不够稳**：无法证明所有工作区外写入都会被阻止。
2. **宿主影响过重**：需要机器级账户、ACL 和 WFP 变更，超出本 Feature 的合理安装与恢复成本。

本 Feature 改为交付可验证的应用层安全边界：

- Agent / Plan 权限模式；
- `allow | ask | deny` Tool Policy；
- 高置信危险命令硬拒绝；
- 所有普通命令逐次 HITL，并明确提示“当前用户权限、无 OS 隔离”；
- 文件 Tool 的精确路径和目标指纹约束；
- 固定 Shell、工作区 `cwd`、最小子进程环境、超时和进程树清理。

这些措施降低误操作概率，但不声称阻止已经获批命令访问工作区外文件、网络或当前用户可访问的系统资源。

## 证据边界

结论基于 2026-09-04 可见的 upstream 文档、源码、issue 与本机只读状态。未来候选实现、Windows 平台能力或产品部署方式变化时，应重新 Research；本文件不授权机器级安装，也不证明容器或 VM 已适配 Anthias。
