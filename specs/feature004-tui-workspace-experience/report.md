# Feature 004：TUI 交互与工作区启动体验实施报告

状态：实施中
报告日期：2026-09-04

## 开发者速览

> **一句话**：Plan 01 已支持任意 Workspace 启动，新 Session 归 Anthias Data Root。<br>
> **核心做法**：CLI 分离三条路径，Agent 显式接收 Workspace 与 Session Directory，输入前显示 cwd。<br>
> **边界**：仍为行式 TUI；Reasoning、Tool 摘要、文件标识、Shiki 和动态底栏未实现。<br>
> **风险 / 未验证**：旧 Session 未迁移；真实 Provider 与启动期 Session changed 竞态未实测。<br>
> **当前 / 请审阅**：Plan 01 已实现；全量 16 个文件、132 个测试通过，等待审查。

- 对应 Spec：[spec.md](spec.md)
- 当前 Plan：[Plan 01](plan-01-workspace-and-data-root.md)
- 任务事实源：[tasks.md](tasks.md)

## 1. Plan 01 已成立结果

- 直接运行编译后 CLI 时，省略 `--workspace` 使用调用时 `cwd`；`--workspace <path>` 支持相对和绝对目录，相对值以调用时 `cwd` 为基准。
- 启动 Module 从自身 `import.meta.url` 定位 Anthias Project Root，并校验根 `package.json` 的 `name`；它不从用户 Workspace 向上扫描。
- 默认 Session Directory 是 `<Anthias Project Root>/data/conversation`。生产 Agent 工厂必须分别接收规范化 Workspace Root 与绝对 Session Directory，不再从 Workspace 推导数据目录。
- `ANTHIAS_SESSION_DIR` 仍可覆盖默认位置，但只接受绝对路径；相对值在 Session 文件和模型请求之前失败。
- Session Header 继续记录创建时的规范化 Workspace；同一 Workspace 可以重开，错误 Workspace 返回两端路径且不会自动切换或创建新 Session。
- 当前行式 TUI 在每次普通输入前显示完整 `cwd`、Permission Mode、Session 短 ID 与 `idle | active`，作为后续动态底栏的文案基线。
- 根 `.gitignore` 已加入 `/data/`；Session Directory 内原有 `*` 忽略规则保持不变。

尚未完成的范围：Plan 02 的 RunPhase、Visible Reasoning 与 ToolActivity，Plan 03 的文件引用和 Shiki Content Renderer，以及 Plan 04 的动态 TUI、Windows Terminal 人工验收和真实 DeepSeek V4 Flash 冒烟。

## 2. 入口与调用链

```text
编译后 anthias bin
  → 解析 --workspace / --session / --mode
  → resolveStartupPaths
      → Workspace Root：调用 cwd 或 --workspace，经 realpath 与目录校验
      → Anthias Project Root：启动模块位置 + package identity
      → Session Directory：绝对 override 或 Anthias data/conversation
  → createAgentFromEnvironment({ workspaceRoot, sessionDirectory, ... })
      → 校验通用模型配置与 Workspace
      → 固定 Shell
      → createSession | openSession
      → 创建 Agent
  → runTui({ agent })
      → 从 AgentState 呈现历史和输入上下文行
```

- `apps/tui` 的启动 Module 只拥有 CLI 路径语义；它不读取 Provider 专属配置，也不推进 Agent 生命周期。
- Agent 生产工厂负责安全配置结果、Session 装配与错误收敛；它不再拥有 Anthias Project Root 的定位规则。
- Session Module 仍拥有 Schema 1、Workspace 绑定、锁、checkpoint、恢复与持久化。
- `runTui()` 仍是唯一公开 TUI 入口，只读取 Agent state 和事件。

## 3. 失败表现与兼容性

| reason | 用户可操作结果 |
| --- | --- |
| `model_configuration` | 指出缺失或格式无效的通用模型变量，不回显值 |
| `workspace_unavailable` | 要求选择存在且可访问的目录 |
| `session_busy` | 提示 Session 正被其他进程使用 |
| `session_changed` | 提示 Session 在启动期间发生变化并要求重开 |
| `workspace_mismatch` | 显示安全化后的记录 Workspace 与当前 Workspace |
| `invalid_session` | 提示 Session ID 或 Session 文件无效 |
| `shell_unavailable` | 提示固定 Shell 不可用或与 Header 不一致 |
| `storage_unavailable` | 提示检查 Anthias data 权限和磁盘状态 |

- Session Schema 仍为 1，Header 和记录格式没有变化；已有同 Workspace Session 可以从显式新目录重开。
- Plan 01 不扫描、移动、复制或删除旧数据。审查时发现被忽略的 `apps/tui/data/conversation` 中有三个早于本轮实施的旧 Session 文件；只核对了文件名、大小和修改时间，没有读取内容或改变目录。
- 路径进入启动错误或上下文行前会替换 C0 / C1 控制字符，普通路径内容保持可辨认。
- 旧调用方若直接使用生产工厂，必须补充显式 `workspaceRoot` 与 `sessionDirectory`；这是本 Plan 有意收窄的装配合同，Agent 的运行操作与事件接口没有变化。

## 4. 验证证据

验证环境：Windows，Node.js `v24.13.1`，pnpm `10.33.0`，PowerShell `7.5.4`。

### 实施前基线

```text
pnpm verify
```

结果：16 个测试文件、125 个测试通过。

### Plan 01 定向门禁

```text
pnpm exec vitest run apps/agent/test/startup.test.ts apps/agent/test/session.test.ts apps/tui/test/main.test.ts apps/tui/test/tui.test.ts
```

结果：4 个测试文件、51 个测试通过。

定向证据包括：

- 在临时 Anthias 发行布局中运行真实编译后 bin；两个临时 `cwd` 分别形成正确 Header，两个 JSONL 都进入同一个临时 `<Anthias>/data/conversation`。
- 相对与绝对 `--workspace` 解析一致，无效文件 Workspace、未知参数和相对 Session override 在 Session 创建前失败。
- 工厂级覆盖显式 Session Directory、同 Workspace 重开、live lock、无效 ID、Shell 缺失、Workspace mismatch 与存储失败。
- TUI 覆盖启动、连续两个 Run 和空输入拒绝后的完整 cwd 上下文行，原有 Tool、approval、停止与退出测试继续通过。

### 完整门禁

```text
pnpm verify
```

结果：静态检查通过；16 个测试文件、132 个测试全部通过。

## 5. 证据边界与 Git 状态

- 没有使用真实 Provider、外部网络、付费 API 或真实凭据；`DEEPSEEK_API_KEY` 未读取、未映射、未输出，也未进入文件。
- `session_changed` 有稳定公开 reason 和真实 checkpoint 变化映射；自动测试覆盖既有 Run 期 checkpoint 变化，但没有用非确定性并发写入强制制造启动瞬间竞态。
- 自动测试证明路径、持久化位置和文本合同，不证明 Plan 04 的最终视觉质量、resize 或 Windows Terminal 交互体验。
- 文档提交为 `0cbb45e`。Plan 01 实现和本报告当前都是 `main` 上的未提交工作区变更；没有推送或创建 PR。
- Plan 01 完成后按约定停止。代码提交、Plan 02、推送和 PR 均未获得本阶段授权。
