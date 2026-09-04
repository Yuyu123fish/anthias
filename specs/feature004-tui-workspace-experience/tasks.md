# Feature 004：TUI 交互与工作区启动体验任务

状态：实施中

## 开发者速览

> **一句话**：十五项任务按四个 Plan 交付工作区启动、Agent 可观察性、内容渲染和完整 TUI。<br>
> **核心做法**：每项任务形成可验证 tracer，按依赖顺序推进，每个 Plan 完成后停止。<br>
> **边界**：不改变 Session Schema、Tool Policy 或 Agent 核心 Interface，不自动跨 Plan。<br>
> **风险 / 未验证**：路径、Reasoning 顺序、Shiki、终端重绘与真实 Provider 仍待实施证明。<br>
> **当前 / 请审阅**：实施中；T001–T003 已完成，Plan 01 已停止并等待开发者审查。

- 对应 Spec：[spec.md](spec.md)
- 实施计划：[Plan 01](plan-01-workspace-and-data-root.md)、[Plan 02](plan-02-agent-observability.md)、[Plan 03](plan-03-terminal-content-rendering.md)、[Plan 04](plan-04-interactive-tui-and-closeout.md)

任务状态使用：`待开始`、`进行中`、`已完成`、`阻塞`。

## Plan 01：工作区启动与 Anthias Data Root

### T001：任意 Workspace 启动 tracer

状态：已完成

Blocked by：无

- [x] 编译后 CLI 支持省略或传入 `--workspace <path>`，相对路径以调用时 `cwd` 为基准。
- [x] 启动 Module 从自身位置确定并校验 Anthias Project Root，不扫描用户 Workspace。
- [x] 生产装配把规范化 Workspace Root 与默认 Anthias Session Directory 分别交给 Agent。
- [x] 新 Session Header 记录目标 Workspace；输入旁上下文行显示完整路径、模式和 Session。
- [x] 两个临时 Workspace 的 CLI happy path 测试证明 Session 集中进入同一 Anthias Data Root。

### T002：Session 兼容与启动失败 tracer

状态：已完成

Blocked by：T001

- [x] 绝对 `ANTHIAS_SESSION_DIR` 保持可用，相对值在 Session 创建前拒绝。
- [x] 同 Workspace 能重开；Workspace mismatch 显示当前和记录路径且不自动切换。
- [x] Session busy、changed、invalid、mismatch 与 Shell / 存储失败保持可区分的安全 reason。
- [x] 无效 Workspace、文件路径、未知参数和 mismatch 不产生模型请求或 Tool 副作用。
- [x] 旧 Session 目录不扫描、不迁移、不复制、不删除。

### T003：Plan 01 门禁与阶段报告

状态：已完成

Blocked by：T001、T002

- [x] 启动、Session、CLI 与 TUI 定向测试通过。
- [x] `pnpm check` 通过，Session Schema 1 和现有输入 / approval / 停止语义无回归。
- [x] 根 `.gitignore` 明确排除 Anthias `data`，目标 Workspace 与 `apps/tui` 无默认 Session 污染。
- [x] 创建唯一 `report.md`，只记录 Plan 01 已成立能力与后续未完成范围。
- [x] 更新本任务状态并汇报；停止，不进入 Plan 02。

## Plan 02：Agent 可观察生命周期

### T004：真实 RunPhase tracer

状态：待开始

Blocked by：T003

- [ ] 导出三值 `RunPhase`，新增归属 `runId` 的 `run_phase_changed`。
- [ ] `run_start` 建立初始 requesting_model；相同 phase 不重复发布。
- [ ] Model → approval → Tool → Model、failed 和 aborted 的阶段顺序由公开 Agent Interface 验证。
- [ ] TUI 只呈现事件与 state，不自行推断阶段。

### T005：Visible Reasoning tracer

状态：待开始

Blocked by：T004

- [ ] Model Stream 与 OpenAI-compatible Adapter 规范化 reasoning start / delta / end。
- [ ] 每个 span 在 text、ToolCall、finish、error 或 abort 前唯一收口。
- [ ] 同一 Run 的 Tool continuation 可以按 Provider 协议使用临时 Reasoning，上下文在 Run 结束后释放。
- [ ] Reasoning 不进入 Message、AgentState、Session JSONL 或下一 Run。
- [ ] 无 Reasoning、多 span、Reasoning → text / Tool / failure / abort 均有确定性验证。

### T006：安全 ToolActivity tracer

状态：待开始

Blocked by：T004

- [ ] 六个 Tool 在输入验证后的计划层形成不超过 160 个可见字符的一行 summary。
- [ ] `tool_execution_start` 携带 `ToolActivity`，并发 update / end 继续按 `toolCallId` 归属。
- [ ] 文件写入正文、敏感环境、原始 JSON 和控制序列不进入 summary。
- [ ] denied、invalid 与预检失败不伪造 execution start。
- [ ] 当前 TUI 能以纯文本呈现 phase、Reasoning 与 ToolActivity。

### T007：Plan 02 门禁与阶段报告

状态：待开始

Blocked by：T005、T006

- [ ] Agent、Model Adapter、Tool Loop、调度和 TUI 定向测试通过。
- [ ] `pnpm check` 通过，公开 Agent 操作、Session Schema 1、六个 Tool 与 Permission Policy 无回归。
- [ ] Report 补充事件顺序、瞬时 Reasoning 和 Tool summary 证据。
- [ ] 更新任务状态并汇报；停止，不进入 Plan 03。

## Plan 03：终端内容渲染

### T008：Content Renderer 安全 seam

状态：待开始

Blocked by：T007

- [ ] 在 `apps/tui` 内建立单一 Assistant Content Renderer 与明确 TerminalCapabilities。
- [ ] 模型内容先安全化为语义 spans / lines，只有 Terminal Writer 可以生成 ANSI / OSC。
- [ ] 跨 delta 只提交稳定块，异步结果保持消息与 Run 顺序。
- [ ] plain 与 interactive writer 共用解析结果，不导出内部 renderer 框架。

### T009：Workspace 文件引用 tracer

状态：待开始

Blocked by：T008

- [ ] inline code 和 Markdown 本地链接经 `realpath`、普通文件与 Workspace 范围验证。
- [ ] 合格目标显示 `▧` / `[file]`、相对路径和行列号；URI 使用 `pathToFileURL()`。
- [ ] hyperlink 与颜色分别降级，链接不会自动打开。
- [ ] 缺失、目录、Workspace 外、UNC、WSL UNC、SSH 和解析失败目标保持原文。
- [ ] 恶意 ESC / OSC 和特殊 Windows 路径不能注入终端控制。

### T010：Shiki 代码块 tracer

状态：待开始

Blocked by：T008

- [ ] 只在 `apps/tui` 安装并锁定 `@shikijs/core`、`@shikijs/langs`、`@shikijs/engine-javascript` 4.4.3。
- [ ] lazy highlighter、按需 grammar、并发加载合并与 Anthias 自有 theme 按 Plan 工作。
- [ ] 首批语言与别名全部可用，代表性 token 映射到五类语义色。
- [ ] 未知、未标、未闭合、64 KiB / 2,000 行超限和 Shiki 异常保持 plain 原文。
- [ ] 无颜色、256 色与 16 色由注入能力决定，不由 Shiki 读取进程状态。

### T011：Plan 03 门禁与阶段报告

状态：待开始

Blocked by：T009、T010

- [ ] Content Renderer 与 TUI 定向测试通过，去除 renderer 样式后代码内容保持一致。
- [ ] `pnpm check` 通过，无完整 Markdown、LSP、自动语言猜测或 Provider 类型泄漏。
- [ ] 记录本机首块冷加载和热加载结果，不设 CI 时间断言。
- [ ] Report 补充文件、Shiki、fallback 与控制序列安全证据。
- [ ] 更新任务状态并汇报；停止，不进入 Plan 04。

## Plan 04：交互式 TUI 与整体验收

### T012：Terminal Conversation 基础 tracer

状态：待开始

Blocked by：T011

- [ ] 保持 `runTui()` 唯一入口，内部 Module 持有 presentation state、render queue、时钟与关闭状态。
- [ ] interactive writer 提交稳定 scrollback 并替换动态区；plain writer 确定性追加。
- [ ] 用户、Anthias、活动区、approval、输入和完整 cwd 底栏形成 Spec 效果层级。
- [ ] 终端字体和背景不变，Anthias 图标与颜色不复制 Claude Code。

### T013：完整对话周期 tracer

状态：待开始

Blocked by：T012

- [ ] 请求模型、Reasoning、Assistant streaming、并发 Tool、approval 与 Run 终态由真实事件驱动。
- [ ] Reasoning 活动窗口最多四行，结束自动折叠；`/details` 显示进程内完整瞬时内容。
- [ ] Tool 默认显示名称、summary、状态和耗时，详情归属于正确 `toolCallId`。
- [ ] active Run、approval、`/mode`、`/exit`、Ctrl+C 与 EOF 保持既有控制语义。

### T014：终端降级与资源清理 tracer

状态：待开始

Blocked by：T012、T013

- [ ] 正常、窄终端和 resize 后输入不丢失、历史不重复、完整 cwd 仍可见。
- [ ] `NO_COLOR`、无 Unicode 与非 TTY 保留等价文本；plain 输出没有 ANSI / OSC。
- [ ] Unicode 测宽覆盖中文、组合字符和宽字符。
- [ ] abort、failure、EOF 和退出后无 timer、listener、raw mode、隐藏光标或晚到 frame。
- [ ] 少量结构快照与 terminal driver 操作测试通过，不建立大面积 ANSI 快照。

### T015：完整门禁、真实冒烟与 Feature 收口

状态：待开始

Blocked by：T014

- [ ] `pnpm verify` 通过，Windows Terminal 人工覆盖 Spec 的启动、内容、Tool、approval、resize、停止和退出。
- [ ] 在临时 Workspace 和 Plan 模式运行一次 DeepSeek V4 Flash；只把 `DEEPSEEK_API_KEY` 临时映射给通用 Adapter。
- [ ] 冒烟不回显、记录或持久化 Key，不执行副作用 Tool，并说明时点与证明边界。
- [ ] 唯一 Report 汇总四个 Plan 的成立能力、调用链、验证、限制和 Git 状态。
- [ ] 全部门禁通过后把 Spec、Plans、Tasks 与 Report 标为“已实现”，等待开发者验收。

## 授权

- 开发者已确认 Spec、Shiki 选型、四个 Plan 与本 Tasks 的连续交付方向。
- 开发者已授权先提交截至本 Tasks 的文档变更，再直接实施 Plan 01。
- 开发者已授权 Plan 04 进行一次 DeepSeek V4 Flash 真实冒烟；凭据仅来自 `DEEPSEEK_API_KEY`。
- 按仓库规则，Plan 01 完成后必须汇报并停止；后续 Plan 仍等待逐 Plan 审查。
- 本轮授权不包含 Plan 01 代码提交、后续提交、推送或创建 PR。
