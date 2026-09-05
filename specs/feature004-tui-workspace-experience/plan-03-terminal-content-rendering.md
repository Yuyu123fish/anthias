# Feature 004 Plan 03：终端内容渲染

状态：已实现

## 开发者速览

> **一句话**：把 Assistant 的文件引用与 fenced code 安全渲染成可降级的 Anthias 终端内容。<br>
> **核心做法**：建立内部 Content Renderer，以 Shiki Core 按需着色，并在校验后生成文件标识和链接。<br>
> **边界**：只支持 Spec 的 Markdown 子集，不做完整 CommonMark、自动语言猜测或 LSP。<br>
> **风险 / 未验证**：异步顺序、控制序列注入、Unicode 宽度与 Shiki 首次加载最易出错。<br>
> **当前 / 请审阅**：已实现并提交为 `83d2bba`；内容、文件与代码渲染门禁通过。

- 对应 Spec：[spec.md](spec.md)
- 技术依据：[终端内容渲染 Research](research-terminal-rendering.md)
- 前置 Plan：[Plan 02](plan-02-agent-observability.md)
- 任务事实源：[tasks.md](tasks.md)

## 1. 当前基线与交付范围

- Assistant delta 目前直接写到 stdout，跨 delta 的 fence、inline code 和本地链接没有稳定解析点。
- TUI 没有颜色、Unicode、hyperlink 或非 TTY 能力模型，也没有统一控制字符清理。
- Shiki 已由 Spec 固定，但尚未进入依赖与实现。

本 Plan 只建立一个 TUI 内部 Content Renderer，交付文件引用、有限 Markdown 与代码着色；不重做输入壳和动态布局。

## 2. 深 Module 与内部 seam

- `AssistantContentRenderer` 是 TUI 内部深 Module；调用者只交付原始 Assistant 文本、Workspace Root 和明确的终端能力。
- renderer 输出受控的语义 spans / lines，再由 Terminal Writer 唯一添加 ANSI 或 OSC 8；模型文本不得携带可执行控制序列。
- renderer 按顺序串行处理异步文件检查与 Shiki grammar 加载，晚到结果不得越过后续消息或 Run 终态。
- streaming 使用“稳定块提交”：完整普通行或闭合 fence 可以提交，末尾未闭合块保留到后续 delta；message end 负责最终 flush。
- plain writer 与 interactive writer 共用同一语义结果，不维护两套 Markdown 解析。

## 3. Shiki 决策

在 `apps/tui` 固定同版本依赖：

- `@shikijs/core@4.4.3`
- `@shikijs/langs@4.4.3`
- `@shikijs/engine-javascript@4.4.3`

实现规则：

- 使用 Shiki Core、JavaScript regex engine 与 token 输出；不使用 `@shikijs/cli` 的进程级 ANSI 便利层。
- 一个 TUI 进程只持有一个 lazy highlighter Promise；每种 grammar 的并发加载合并，不缓存完整代码输出。
- 自有 `anthias-terminal` TextMate theme 把 token 映射到 Fin Violet、Reef Rose、Lagoon、Anthias Coral 与 Reef Slate；忽略背景色。
- 首批 grammar 与别名：
  - TypeScript：`typescript`、`ts`、`tsx`
  - JavaScript：`javascript`、`js`、`jsx`
  - JSON：`json`、`jsonc`
  - Markdown：`markdown`、`md`
  - Bash：`bash`、`shell`、`sh`
  - PowerShell：`powershell`、`ps1`
  - Java、Python / `py`、YAML / `yml`、SQL
- 单个代码块超过 64 KiB 或 2,000 行时直接 plain；未知、未标、未闭合或加载失败同样保持原文。
- 24-bit、256 色、16 色和无颜色转换由 Anthias Terminal Writer 决定，Shiki 不读取进程环境。

## 4. 文件引用与控制字符

- 只识别完整 Markdown inline code 和本地 link target，不扫描普通自然语言。
- 去除可选行列号后，目标必须 `realpath` 到 Workspace 内现有普通文件；目录、缺失、外部、UNC、WSL UNC 和 SSH 目标保持原文。
- 显示 label 使用 `▧ <relative-path>:<line>`，ASCII 降级为 `[file]`；行列号不写入文件 URI。
- URI 只通过 Node.js `pathToFileURL()` 形成；OSC 8 能力与颜色能力分别输入，链接永不自动打开。
- ESC、C0 / C1 控制字符、模型构造的 OSC 与孤立 surrogate 在测宽和着色前统一安全化；换行与必要 tab 由内容语义明确保留。
- 除 Shiki 三个包外不引入完整 Markdown 框架或语义分析依赖。

## 5. 实施顺序

1. 建立 TerminalCapabilities、受控 span 和 sanitizer 的内部 seam。
2. 用跨 delta fixture 实现有限 Markdown 分段与稳定块提交。
3. 接入 Workspace 文件校验、label、`pathToFileURL()` 与 hyperlink fallback。
4. 接入 Shiki lazy highlighter、自有 theme、grammar 别名和 ANSI 色阶转换。
5. 把 renderer 接入 Assistant 历史与流式正文，保持原文可复制。
6. 运行定向门禁、记录冷 / 热高亮测量、更新 Tasks / Report 并独立提交。

## 6. 验证

```text
pnpm exec vitest run apps/tui/test/content-renderer.test.ts apps/tui/test/tui.test.ts
pnpm check
```

必须覆盖：

- TypeScript、PowerShell、Java、Markdown 的代表性 token；
- 未知、未标、未闭合、超限和 Shiki 异常的 plain fallback；
- Windows / POSIX 路径、空格、中文、`#`、`%` 与行列号；
- Workspace 外、不存在、目录和远程路径不生成链接；
- 恶意 ANSI / OSC 无法闭合或注入 renderer 控制序列；
- 去除 renderer 自己的样式后，内容等于安全化后的原始代码；
- 首块冷加载和同语言热加载只记录本机结果，不设脆弱时间断言。

## 7. 风险与停止条件

- 若 Shiki token 无法映射为不改背景且可降级的终端 spans，停止并先修正 renderer seam，不替换 highlighter。
- 若 streaming 需要重绘全部历史才能正确，停止并改为更保守的稳定块提交。
- 若文件点击必须依赖特定编辑器 URI 或自动打开行为，保持纯文本 label，不扩张 Spec。
- 若 renderer 需要读取 Agent 内部状态或 Provider 类型，停止并收回到公开 Message / Event。

## 8. 汇报与停止

- Report 记录 Shiki 依赖、grammar、主题、fallback、安全边界和本地测量。
- 本 Plan 完成后按开发者最新授权独立提交，并连续进入 Plan 04。
- 本 Plan 不运行真实 Provider；提交已授权，推送和 PR 未授权。
