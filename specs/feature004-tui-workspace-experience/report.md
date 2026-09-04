# Feature 004：TUI 交互与工作区启动体验实施报告

状态：实施中
报告日期：2026-09-04

## 开发者速览

> **一句话**：Plan 01–03 已交付路径分离、可观察 Agent 周期，以及安全文件引用和 Shiki 代码呈现。<br>
> **核心做法**：Agent 发布真实生命周期，TUI 用串行 Content Renderer 校验文件、清理控制字符并按需加载 Shiki。<br>
> **边界**：当前仍为行式 scrollback；动态区、Reasoning 折叠、详情、resize 和完整输入壳由 Plan 04 实现。<br>
> **风险 / 未验证**：旧 Session 未迁移；真实 Provider、最终视觉、交互式清理和 resize 尚未验证。<br>
> **当前 / 请审阅**：Plan 01–02 已提交，Plan 03 定向与完整门禁通过并准备提交；随后连续实施 Plan 04。

- 对应 Spec：[spec.md](spec.md)
- 当前 Plan：[Plan 03](plan-03-terminal-content-rendering.md)
- 任务事实源：[tasks.md](tasks.md)

## 1. Plan 01 已成立结果

- 直接运行编译后 CLI 时，省略 `--workspace` 使用调用时 `cwd`；`--workspace <path>` 支持相对和绝对目录，相对值以调用时 `cwd` 为基准。
- 启动 Module 从自身 `import.meta.url` 定位 Anthias Project Root，并校验根 `package.json` 的 `name`；它不从用户 Workspace 向上扫描。
- 默认 Session Directory 是 `<Anthias Project Root>/data/conversation`。生产 Agent 工厂必须分别接收规范化 Workspace Root 与绝对 Session Directory，不再从 Workspace 推导数据目录。
- `ANTHIAS_SESSION_DIR` 仍可覆盖默认位置，但只接受绝对路径；相对值在 Session 文件和模型请求之前失败。
- Session Header 继续记录创建时的规范化 Workspace；同一 Workspace 可以重开，错误 Workspace 返回两端路径且不会自动切换或创建新 Session。
- 当前行式 TUI 在每次普通输入前显示完整 `cwd`、Permission Mode、Session 短 ID 与 `idle | active`，作为后续动态底栏的文案基线。
- 根 `.gitignore` 已加入 `/data/`；Session Directory 内原有 `*` 忽略规则保持不变。

尚未完成的范围：Plan 04 的动态 TUI、Windows Terminal 人工验收和真实 DeepSeek V4 Flash 冒烟。

## 2. Plan 02 已成立结果

- `RunPhase` 以既有三值公开；`run_start` 建立初始 `requesting_model`，后续只有真实 phase 变化才发布一次 `run_phase_changed`。
- `executing_tool` 已从“开始预检”收紧为“即将发布真实 execution start”。invalid、denied、预检失败和被拒 approval 不再伪装成正在执行。
- Model Stream 规范化 `reasoning_start | reasoning_delta | reasoning_end`。空 span 不显示；text、ToolCall、finish、Provider error 与 abort 都会先唯一结束活动 span。
- `AssistantMessage` 仍只保存 text / ToolCall。当前 Run 用私有映射保留带 Reasoning 的模型输入用于 Tool continuation；Run 结束后映射释放，后续 Run 只从持久 Message 重建上下文。
- OpenAI-compatible Adapter 已映射 AI SDK Reasoning part，并能把同 Run 临时 reasoning message 回传；没有增加 DeepSeek 专用类型或条件分支。
- `tool_execution_start` 现在只携带 `ToolActivity { toolCallId, toolName, summary }`。摘要在已验证/预检计划中形成，单行且最多 160 个可见字符；文件正文、运行时环境值和原始 Tool JSON 不进入事件。
- 无 I/O 即可判定的路径逃逸和非法 grep 正则已前移到验证，因此不会产生 execution start；文件存在性、权限和实际执行错误仍按 start → end(failed) 呈现。
- 当前行式 TUI 已能直接呈现 Requesting model、phase 变化、Visible Reasoning 与 Tool summary；它不根据 spinner、计时器或 Tool 事件反推 Agent 阶段。

典型公开顺序：

```text
run_start                         // 初始 requesting_model
message_start(assistant)
reasoning_start → update* → end   // 仅 Provider 明确给出的文本
message_end(assistant)
run_phase_changed(executing_tool)
tool_execution_start(activity)
tool_execution_end
message_end(tool)
run_phase_changed(requesting_model)
...
run_end
```

已验证摘要样例：`pattern: **/*.ts; base: .`、`path: src/example.ts`、`target: existing.txt`、`cwd: .; command: ...`。

## 3. Plan 03 已成立结果

- `AssistantContentRenderer` 是 TUI 内部唯一内容 seam。流式输入只提交完整普通行和闭合 fence；message end flush 尾部，历史消息走同一条渲染链。
- TUI 用一个 Promise render queue 串行处理初始历史、AgentEvent、异步 `realpath`、Shiki 结果、Run 终态和下一次输入提示，因此晚到结果不能越过源事件顺序。
- 文件只从完整 inline code 或 Markdown link target 识别。候选经过行列拆分、远程与 UNC 拒绝、`realpath`、普通文件检查和 Workspace containment；symlink 逃逸也由真实路径边界拒绝。
- 合格文件显示 `▧ <relative-path>:<line>:<column>`，无 Unicode 时显示 `[file]`。OSC 8 只包装 `pathToFileURL(realpath)` 生成的 URI，行列号只在 label 中；颜色与 hyperlink 能力独立。
- 模型正文、Reasoning、Tool output、approval 文本和路径在写终端前清理 ESC、C0 / C1 与孤立 surrogate。只有 Terminal Writer 可以生成 SGR 或 OSC 8。
- `@shikijs/core`、`@shikijs/langs` 与 `@shikijs/engine-javascript` 固定为 `4.4.3`。Shiki Module、highlighter 与 grammar 都按需加载；相同 grammar 的并发加载共享 Promise。
- Anthias theme 把已知 token 收窄到 Fin Violet、Reef Rose、Lagoon、Anthias Coral 与 Reef Slate，并明确忽略背景。24-bit、256 色、16 色和无颜色由注入的 TerminalCapabilities 决定。
- 支持 TypeScript / TSX、JavaScript / JSX、JSON / JSONC、Markdown、Bash / shell、PowerShell、Java、Python、YAML 与 SQL 的固定别名。未知、未标、未闭合、超过 64 KiB / 2,000 行或 Shiki 失败时保持安全 plain 内容。
- 普通 CLI 启动不会解析 Shiki package；只有首个合格且需要颜色的代码块才动态载入高亮 Module。

## 4. 入口与调用链

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
      → 串行消费 AgentEvent
      → AssistantContentRenderer
          → 稳定块与控制字符清理
          → Workspace 文件 realpath / containment
          → lazy Shiki token → TerminalCapabilities writer
```

- `apps/tui` 的启动 Module 只拥有 CLI 路径语义；它不读取 Provider 专属配置，也不推进 Agent 生命周期。
- Agent 生产工厂负责安全配置结果、Session 装配与错误收敛；它不再拥有 Anthias Project Root 的定位规则。
- Session Module 仍拥有 Schema 1、Workspace 绑定、锁、checkpoint、恢复与持久化。
- `runTui()` 仍是唯一公开 TUI 入口，只读取 Agent state 和事件。

## 5. 失败表现与兼容性

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

## 6. 验证证据

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

### Plan 02 定向与完整门禁

```text
pnpm exec vitest run apps/agent/test/agent.test.ts apps/agent/test/openai-compatible-model.test.ts apps/agent/test/tool-loop.test.ts apps/agent/test/tool-scheduling.test.ts apps/agent/test/file-tool-loop.test.ts apps/agent/test/command-tool-loop.test.ts apps/tui/test/tui.test.ts
pnpm verify
```

结果：定向 7 个测试文件、54 个测试通过；完整静态检查、构建与 16 个测试文件、138 个测试全部通过。

定向证据同时证明：Reasoning 多 span、error / abort 收口、同 Run Tool continuation、Session 与下一 Run 不继承；六类 Tool summary、并发 start / end 归属、phase 去重和非法只读输入 no-start。

### Plan 03 定向门禁与本地测量

```text
pnpm exec vitest run apps/tui/test/content-renderer.test.ts apps/tui/test/tui.test.ts
pnpm exec vitest run apps/tui/test/main.test.ts apps/tui/test/content-renderer.test.ts apps/tui/test/tui.test.ts
pnpm verify
```

结果：Content Renderer / TUI 定向 2 个测试文件、22 个测试通过；CLI / Content Renderer / TUI 回归 3 个测试文件、30 个测试通过。

完整门禁首次运行时，既有 Windows command timeout 清理出现一次 `cleanupUncertain`，同时隔离 CLI 暴露 Shiki 顶层解析问题。前者单文件复跑 4 个测试通过；后者改为真正 lazy Module 后，CLI 定向回归通过。提交前最终复跑静态检查、构建以及 17 个测试文件、150 个测试全部通过。

内容证据覆盖跨 delta 稳定提交、历史与流式共用 renderer、异步顺序、Workspace 内外文件、空格 / 中文 / `#` / `%`、行列号、OSC 8、恶意控制序列、四种代表 grammar、三档颜色与无颜色，以及 plain fallback。

本机同一 Node.js 进程对 TypeScript 样例测量：首块冷加载 `325.56 ms`，同语言热加载 `1.21 ms`。该数据只记录本机时点，不是 CI 阈值或性能承诺。

## 7. 证据边界与 Git 状态

- 没有使用真实 Provider、外部网络、付费 API 或真实凭据；`DEEPSEEK_API_KEY` 未读取、未映射、未输出，也未进入文件。
- `session_changed` 有稳定公开 reason 和真实 checkpoint 变化映射；自动测试覆盖既有 Run 期 checkpoint 变化，但没有用非确定性并发写入强制制造启动瞬间竞态。
- 自动测试证明路径、持久化位置和文本合同，不证明 Plan 04 的最终视觉质量、resize 或 Windows Terminal 交互体验。
- 文档提交为 `0cbb45e`，Plan 01 提交为 `8b2f2f8`，Plan 02 提交为 `95611c8`。Plan 03 当前是 `main` 上准备提交的单一增量；没有推送或创建 PR。
- 开发者已授权连续完成整个 Feature，并要求每个 Plan 独立提交；真实 Provider 仍只在 Plan 04 冒烟时使用。
