# Feature 002：基础 Tool Loop 与线性 Session 实施报告

状态：已实现

- 文档类型：Report
- 对应 Spec：[spec.md](spec.md)
- 对应 Plan：[plan.md](plan.md)
- 对应 Tasks：[tasks.md](tasks.md)
- 验收状态：等待开发者验收

## 1. 实施结果

Feature 002 已把 Feature 001 的单次纯文本响应推进为一个可持久恢复的基础 Coding Harness。一次 Run 现在可以连续请求模型，串行执行 `read_file`、`glob`、`grep`、`edit_file`、`write_file` 和 `execute_command`，把每个 ToolResult 返回模型，最后由没有 ToolCall 的模型响应正常收口。

对话和 Tool 事实保存为 workspace 内 `data/conversation/<sessionId>.jsonl`。文件修改和命令执行逐次等待人工确认；只读 Tool 自动执行。Agent 统一持有循环、确认、取消、预算、Session 写入和资源回收，TUI 只通过公开 Agent Interface 输入、呈现、确认、停止和退出。

验收前的结构整理已把系统提示词归入 `src/prompts/`，把定义、输入校验、结果预算、工作区路径以及三类 Tool 实现归入 `src/tool/`。原先根目录的 `tools.ts`、`file-tool.ts` 和 `command-tool.ts` 已移除；本次只调整 Agent Module 内部 locality，没有增加 Registry、Manager、公开导出或第二套生命周期。

本 Feature 没有实现 OS 沙箱、通用权限策略、Session 分叉、Compaction、PTY、后台命令、持久 Shell、动态 Tool Registry、Desktop、跨进程协议或多 Agent。

## 2. 关键行为与边界

- Session 使用逐行完整 JSON、连续 `seq`、稳定 ID 和独占锁；只恢复文件末尾未换行且 JSON 不完整的残段，其他损坏均拒绝打开。
- 中断恢复不会重放旧工作：未开始的 ToolCall 补 `aborted`，已经记录副作用开始但缺少结果的 ToolCall 补 `unknown`，旧 Run 以 `interrupted` 收口。
- 文件 Tool 只接受 workspace 内路径，并把实际 Session 目录作为保留路径。修改类 Tool 先生成完整预览与目标指纹，批准后复核状态，再用同目录临时文件、刷新和原子 rename 生效。
- `execute_command` 使用 Session 固定的非交互 Shell，不使用 `shell: true`；每次执行都是独立子进程。子进程环境会移除 `ANTHIAS_MODEL_API_KEY`，超时或停止时回收进程树并报告清理是否确定。
- Run 预算是三个不同维度：最多 12 次模型请求、处理最多 32 个 ToolCall、最多 30 分钟活动执行时间；等待人工确认不计入活动时间。单个 ToolResult 另受 64 KiB 和 2,000 行限制。
- AssistantMessage、ToolExecutionStartedRecord、ToolResultMessage 和 RunFinishedRecord 按事实发生顺序刷新到 JSONL；流式 delta 和瞬时 AgentEvent 不持久化。

## 3. Spec A–N 验收矩阵

| Spec | 结果 | 可复核证据 |
| --- | --- | --- |
| A 只读编码检查 | PASS | `tool-loop.test.ts` 证明 `glob → grep → read_file → final` 顺序、三条对应 ToolResult、后续模型上下文和 Run 计量。 |
| B 批准精确编辑 | PASS | `file-tool-loop.test.ts` 证明批准前文件不变、Diff 确认、当前确认 ID 匹配、开始记录先于副作用、精确替换成功。 |
| C 陈旧编辑预览 | PASS | `file-tool-loop.test.ts` 在确认期间外部改写目标，旧预览返回 stale target，外部内容保持不变并回传 failed ToolResult。 |
| D 创建与覆盖文件 | PASS | `file-tool-loop.test.ts` 分别确认新建和覆盖，实际文件只获得已展示内容；拒绝路径由同文件的独立测试覆盖。 |
| E 命令确认与失败 | PASS | `command-tool-loop.test.ts` 覆盖批准前无进程副作用、Shell/cwd/命令/超时预览、成功、非零退出、超时、输出截断后继续排空，以及模型 Key 隔离。 |
| F 拒绝副作用 | PASS | `file-tool-loop.test.ts` 证明拒绝不写文件、不产生开始记录，denied 结果进入下一次模型请求，重复确认被拒绝；`tui.test.ts` 证明确认输入只映射到 Agent。 |
| G 多 Tool 多模型循环 | PASS | `complete-tool-loop.test.ts` 用四次模型请求完成读取、编辑、真实本地命令验证、总结并接受后续提示；生产 Adapter 集成测试用两次 loopback HTTP 请求完成读—改—命令—总结。 |
| H 参数错误与未知 Tool | PASS | `read-only-tool.test.ts`、`file-tool-loop.test.ts`、`agent-budget.test.ts` 和 `openai-compatible-model.test.ts` 覆盖越界/保留路径、二进制、非法 Schema、未知 Tool 与不可解析调用，均无副作用且形成对应失败结果。 |
| I 分阶段停止 | PASS | `agent.test.ts`、`file-tool-loop.test.ts` 和 `command-tool-loop.test.ts` 分别覆盖模型流、等待确认、命令执行期间停止，均只有一个终态并回到 idle。 |
| J 执行预算 | PASS | `agent-budget.test.ts` 证明第 13 次模型请求不发送、第 33 个 ToolCall 不处理、30 分钟活动时长终止及确认等待不计时；`command-tool-loop.test.ts` 证明输出达到限制后明确截断且管道继续排空。 |
| K JSONL 保存与重载 | PASS | `session.test.ts`、`agent.test.ts` 与生产 Adapter 集成测试检查记录顺序、稳定引用、累计 usage、重开投影和沿线性上下文继续。 |
| L 中断恢复 | PASS | `session.test.ts` 分别构造 requesting_model、awaiting_tool_approval、executing_tool 中断，证明 `aborted` / `unknown` 补录、`interrupted` 终态、幂等重开且不重放。 |
| M 接口与职责 | PASS | `apps/agent/src/index.ts` 只导出交互所需类型与生产工厂；Session、Model Stream、Provider、Tool Schema/执行器未导出。`apps/tui/package.json` 的唯一运行时依赖是 `@anthias/agent`，完整构建通过。 |
| N 干净退出 | PASS | Agent、命令、TUI 和生产 Adapter 测试覆盖 idle、模型、确认和命令阶段；断言模型迭代器、HTTP 服务、Session 锁、临时写入和进程树已收口，TUI 移除监听并取消订阅。 |

矩阵没有 FAIL、BLOCKED 或 WAIVED。这里的 PASS 表示实现已通过约定的本地自动化验证，不表示开发者已经完成产品验收。

## 4. 验证环境与结果

验证环境：Windows，Node.js `v24.13.1`，pnpm `10.33.0`，PowerShell `7.5.4`。

- Stage 02：`pnpm verify` 通过，当时为 13 个测试文件、87 个测试；`pnpm install --frozen-lockfile --offline` 通过，manifest 和 lockfile 只增加直接运行时依赖 `diff@9.0.0`。
- Stage 03 定向验证：`pnpm exec vitest run apps/agent/test/command-tool-loop.test.ts apps/agent/test/openai-compatible-model.test.ts` 通过，2 个测试文件、9 个测试。
- Stage 03 最终门禁：`pnpm verify` 通过；Biome 检查 33 个文件无修改，Strict TypeScript 检查与构建通过，13 个测试文件中的 89 个测试全部通过。
- 验收前结构整理：`pnpm verify` 通过；Biome 检查当前 38 个文件无修改，Strict TypeScript 检查与构建通过，13 个测试文件中的 89 个测试全部通过。

Stage 3 的输出边界强化测试发现：同一输出流的连续小块会重复产生渲染标签，可能提前挤占最终 ToolResult 的 2,000 行预算并覆盖命令专用截断说明。实现已改为只合并相邻同源块，stdout / stderr 的观察顺序不变，截断后仍继续排空管道；对应定向测试和完整门禁均在修复后重新通过。

Stage 3 新增的生产 Adapter 集成测试只监听 `127.0.0.1` 的随机端口，使用假 Provider Key 和假进程 Key；它实际创建临时 Session、读写临时文件并运行本机固定 Shell。测试验证了两次 HTTP 模型请求、三个顺序 ToolResult、两次副作用确认、最终文件内容、`run_end` 计量、JSONL 累计 token usage、Key 不泄漏、Session 锁删除、原子写临时文件删除和 HTTP 服务关闭。

所有文件与命令副作用都发生在测试创建的系统临时目录。测试结束后统一删除目录；没有在 Anthias 或开发者其他项目中留下运行 Session、目标文件、子进程或后台服务。

## 5. 依赖、敏感信息与外部访问

- 开发者已单独授权下载并安装精确版本 `diff@9.0.0`；完成后使用离线 frozen-lockfile 安装验证可复现性。
- 除这次依赖下载外，没有访问其他外部网络、真实 Provider 或付费 API。
- 验证没有读取或使用真实模型凭据。测试假值不会进入子进程环境、ToolResult、AgentEvent、JSONL、TUI 或测试快照。
- 真实 Provider 的 Tool Calling 兼容性、人工长时间 PowerShell 体验和 OS 级隔离没有得到本报告证明。

## 6. Git 交付

- Stage 01 提交：`8c34b78 feat: 完成线性 Session 恢复与独占写入`。
- Stage 02 提交：`996556e feat: 完成基础 Tool Loop 与人工确认闭环`。
- Stage 03 由包含本报告、最终文档状态和集成验收测试的最终提交交付；具体提交号以包含本文件的 Git 历史为准。
- 没有推送，也没有创建 PR。Feature 当前是“已实现、等待开发者验收”，不是“已验收”。
