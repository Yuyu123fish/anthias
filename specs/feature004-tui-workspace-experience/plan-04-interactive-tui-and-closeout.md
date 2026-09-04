# Feature 004 Plan 04：交互式 TUI 与整体验收

状态：已计划

## 开发者速览

> **一句话**：把既有启动、Agent 事实和 Content Renderer 收敛为现代 Anthias 对话终端。<br>
> **核心做法**：用一个深 Terminal Conversation Module 管理 scrollback、动态区、输入、底栏与清理。<br>
> **边界**：不进入 alternate screen，不加入多行编辑器、Session 管理器、Desktop 或新 Tool。<br>
> **风险 / 未验证**：readline 光标、窄终端、异步重绘、退出清理和真实 Provider 表现最易出错。<br>
> **当前 / 请审阅**：已计划；Plan 03 已完成，按连续授权在独立提交后立即实施。

- 对应 Spec：[spec.md](spec.md)
- 前置 Plan：[Plan 03](plan-03-terminal-content-rendering.md)
- 任务事实源：[tasks.md](tasks.md)

## 1. 设计复核

### 1.1 视觉系统

- 色彩、图标和语义沿用 Spec：`><°>` / `><o>`、Anthias Coral、Reef Rose、Fin Violet、Lagoon、Pearl 与 Reef Slate。
- 字体完全沿用用户终端，不下载或假定字体；正文行宽优先控制在八十列以内。
- 唯一持续动态是活动 Run 的低频鱼尾 / 耗时变化；Reasoning 结束、Tool 完成和 approval 决定才使用状态转换。
- 不修改背景，不把颜色作为唯一语义，不使用显示宽度不稳定的 Emoji。

### 1.2 布局

```text
稳定 scrollback
  用户消息
  Anthias 正文 / 已完成 Tool / 已折叠 Reasoning

动态区域
  当前 Reasoning 或 Tool
  approval（仅待确认时）
  > 输入
  cwd <完整路径> | mode <模式> | session <短 ID> | <Run 状态>
```

主轴左对齐，只在 approval、错误和输入边界使用框线。与 Claude Code 相同的是对话优先和底部上下文；不同的是分叉尾 Anthias 身份、海洋色与明确 Workspace。

### 1.3 自我审查后的删减

- 不采用全屏 Dashboard、alternate screen、同形圆角卡片或大 Logo。
- 不复制 Claude 的名称、橙色、字形和逐字符布局。
- 不同时运行多个 spinner；一个活动状态足以说明 TUI 未卡死。
- Tool 默认一行摘要，完整输出只在用户执行 `/details` 后展开。

## 2. 深 Module

- 保留唯一包入口 `runTui(options): Promise<number>`。
- 内部 `TerminalConversation` 集中持有 TUI Presentation State、异步 render queue、当前输入、Reasoning span、Tool 条目、terminal capabilities、resize revision、timer 与关闭状态。
- `TerminalWriter` 是真实 seam：
  - interactive Adapter 提交稳定 scrollback并替换底部动态区域；
  - plain Adapter 只做确定性追加，不发 ANSI、OSC 8 或光标指令。
- Agent 仍是 Run、approval、Message 与 Tool 的唯一权威；TerminalConversation 只投影事件，不猜测阶段。
- 所有异步 render 操作串行；resize、abort 或 close 后的旧 revision 不能覆盖新 frame。

## 3. 输入、详情与生命周期

- stdin 和 stdout 都是 TTY 时启用 interactive writer；否则使用 plain writer 与现有行式输入。
- 继续使用 Node.js readline 的单行编辑能力，不自制多行编辑器。
- `/details` 是统一详情命令，在 active Run 期间也只切换 TUI Presentation State，不提交给 Agent。
- active Run 拒绝普通 prompt；approval 期间只接收 y / yes、n / no 或空行，现有一次性绑定保持不变。
- Reasoning 活动时显示最近四个可见行和单调耗时；结束后提交 `▸ 思考了 <duration>`，详情打开时可以查看进程内完整瞬时文本。
- Tool 按 `toolCallId` 更新；默认显示名称、summary、状态和耗时，详情显示已安全化的 stdout / stderr 与 ToolResult。
- `Ctrl+C`、`/exit`、EOF、failure 与 abort 都等待 render queue 收口，并释放 readline、resize / signal listener、timer、raw mode 与光标状态。
- 使用可靠的 Unicode 显示宽度实现处理中文、组合字符和宽字符；依赖在实施时固定版本并只进入 `apps/tui`。

## 4. 实施顺序

1. 先建立可注入 terminal driver、单调时钟与 interactive / plain writer。
2. 把历史消息、用户输入、Assistant streaming 和 Plan 01 上下文行迁入 TerminalConversation。
3. 接入 phase、Reasoning、ToolActivity、approval 与终态的动态投影。
4. 实现 `/details`、窄终端布局、resize revision 和可靠清理。
5. 运行结构测试、完整 `pnpm verify` 与 Windows Terminal 人工验收。
6. 使用已授权的 DeepSeek V4 Flash 做一次 Plan 模式真实冒烟，完成唯一 Report 与文档状态收口。

## 5. 自动验证

```text
pnpm exec vitest run apps/tui/test/tui.test.ts apps/tui/test/main.test.ts apps/tui/test/content-renderer.test.ts
pnpm verify
```

测试重点：

- 正常宽度、窄宽度、无颜色、无 Unicode 与非 TTY；
- streaming、Reasoning、并发 Tool、approval、failed、aborted 和再次输入；
- 输入缓冲在事件与 resize 后不丢失，历史不重复；
- plain 输出不含 ANSI / OSC，关闭后没有 timer、listener、隐藏光标或 raw mode；
- 不为每个 ANSI frame 建立大快照，只验证 writer 操作和少量结构样例。

## 6. 人工与真实 Provider 验证

- Windows Terminal 人工覆盖启动、流式回复、文件标识、Shiki 代码、Tool、approval、`/details`、resize、停止与退出。
- 开发者已授权 DeepSeek V4 Flash 冒烟；官方 OpenAI-compatible Base URL 使用 `https://api.deepseek.com`，模型 ID 使用 `deepseek-v4-flash`。
- 冒烟只在目标进程环境中把 `DEEPSEEK_API_KEY` 映射给 `ANTHIAS_MODEL_API_KEY`，不读取、回显、记录或持久化值。
- 使用 Plan 模式和临时 Workspace，只允许只读 Tool；失败也只报告安全阶段与恢复建议。
- 真实冒烟证明该时点的 Provider 连通和用户可见行为，不替代确定性回归，也不外推长期可用性。

## 7. 风险与停止条件

- 若 readline 与底栏无法在宽字符、wrap 和 resize 下可靠恢复输入，停止并先收紧 TerminalWriter；不以丢输入换视觉效果。
- 若异步 Shiki 或文件检查能在 close 后写终端，先修复队列与所有权再继续。
- 若真实冒烟要求写出 Key、开放副作用 Tool 或改变通用 Adapter，停止并保持本地验证。
- 若实现需要 alternate screen、Desktop、完整 Markdown 或 Session 管理器，停止并回到 Spec。

## 8. 汇报与收口

- Report 汇总四个 Plan 已成立能力、调用链、验证、真实 Provider 证据与未验证限制。
- 只有全部门禁通过后，Spec、四个 Plan、Tasks 与 Report 进入“已实现”，等待开发者验收。
- 本 Plan 的本地提交已由开发者授权；推送和 PR 仍未授权。
