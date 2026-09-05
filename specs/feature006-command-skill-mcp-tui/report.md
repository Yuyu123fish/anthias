# Feature 006 实施报告

状态：已实现，待开发者验收

## 开发者速览

> **一句话**：命令、全屏 TUI、外部 Skill 与 MCP 已贯通现有 Agent。<br>
> **核心做法**：保持两个 package，用普通函数衔接能力目录、Session 事实、上下文预算和权限执行。<br>
> **边界**：本地模型、协议与终端夹具；未调用真实 Provider 或开发者的 MCP 服务。<br>
> **风险 / 未验证**：真实 Windows Terminal 主观视觉、输入法和复制仍待开发者验收。<br>
> **当前 / 请审阅**：主体已提交；开发者已确认滚动性能、可见滑块和鼠标折叠修正，并授权本次增量提交。

日期：2026-09-05。基线：`main / 4855892`。开发者授权连续完成整个 Feature，主体后按要求提交为 `fdcbce4`；开发者随后确认本次体验修正并授权提交，未推送或创建 PR。Feature 005 验收文档修改保留，Feature 004 的历史视觉验收状态不改写。

## 实现结果

### 全屏 TUI 与命令

- 使用独立 `@earendil-works/pi-tui@0.84.1` 的 alternate screen、Editor、ScrollView、Markdown；旧 `terminal-driver.ts` 整区擦除实现已删除。
- 固定 Workspace、输入、状态；正文独立滚动，阅读历史时保留位置，详情按宽度并列或覆盖。鱼形标识与珊瑚色沿用 Anthias 主题。
- Markdown、未闭合代码块和 Reasoning 持续呈现；Shiki 异步完成不会堵塞输入或模型事件。保留安全文件引用、中文显示、控制序列清理和纯文本降级。
- `/help /new /resume /context /compact /mode /skills /skill:name /mcp /details /exit` 共用命令、帮助与补全定义；参数错误在本地解释，`//` 按字面提交。
- 多行粘贴保留一条输入；审批必须能完整呈现并浏览到底部，窄屏覆盖时提示也可见。
- CLI 等待 Agent 与终端关闭后再释放自己持有的 stdin 引用，父进程保持输入管道打开也能自然退出。

### Agent、Session 与 Skill

- `agent.ts` 保持稳定对象，`session-agent.ts` 绑定单个 Session 的 Run、上下文与产物。目标会话准备失败保留原实例；成功后切换订阅并关闭旧实例。
- 独立 `operation` 表达会话切换、手动压缩和能力变更。先登记完成 Promise，再向订阅者发布事件，保证同步关闭也能等待资源收口。
- 手动压缩复用已有摘要和预算，不生成普通回复，不插入伪造用户消息；写入失败沿用 Session 封存规则。
- Skill 只读发现项目、用户和显式目录，YAML 元数据 8 KiB、正文 64 KiB、参考资料 32 KiB；单根最多 128 项，目录重名可按来源 ID 选择。
- `load_skill/read_skill` 按需装载，外部内容保存为 Schema 2 的 `context_source` 事实，当前外部上下文合计最多 128 KiB。恢复保留原版本并诊断正文/参考文件变化；模型重复加载不能静默换版。用户显式重新激活才更新正文并清除旧参考。
- 新 Session 不继承激活；外部文本不进入用户消息和自动审批的可信授权来源。

### MCP

- 使用官方 `@modelcontextprotocol/client@2.0.0`。读取配置后保持断开，用户显式连接才启动 stdio 或 HTTP；环境与 header 只解析变量名引用。
- 发现 Tools、静态 Resources 与 Prompts，处理分页、数量、schema 和字节上限。目录变化使已有连接版本失效，需显式重连。
- 工具以稳定 server/tool 名称、完整参数、schema 和连接 generation 绑定；审批前和执行前均验证。Plan 拒绝未知外部工具，其他模式复用人工或 AutoAllow。
- MCP 也先保存审批及副作用开始事实，再实际调用；SDK 自动重连与 `input_required` 自动履行关闭，结果不明时明确提示不自动重试。
- 预览最多 32 KiB，工具原文产物最多保留 256 KiB，原文截断与预览截断分别记录。资源和模板按需进入外部上下文，二进制等内容明确标识不支持。

为控制代码复杂度，TUI 的 command、terminal、theme 与 view 保持直接文件，内容高亮另放 `content/`；没有机械生成每层目录、Registry、Manager、独立 Host 或插件框架。Agent 的 `external-capabilities.ts` 集中处理来源事实与既有 Tool 计划的衔接，SDK 类型留在 `mcp/` 内。

## 验证证据

环境：Windows、Node.js `24.13.1`、pnpm `10.33.0`。独立执行者负责各自验证；根 Agent 复用同版本结果，仅重跑失败或发生相关修改的用例。

| 检查 | 结果 |
| --- | --- |
| Skill：`pnpm exec vitest run apps/agent/test/skill.test.ts` | 14/14；包含实际 Windows junction 越界 |
| MCP：`pnpm exec vitest run apps/agent/test/mcp.test.ts` | 7/7；两种本地传输、版本协商、schema、取消、不重放、脱敏和子进程退出 |
| Agent 边界：`pnpm exec vitest run apps/agent/test/agent-capability-boundaries.test.ts` | 5/5；同步关闭、压缩取消、两类持久化失败封存、Plan 拒绝 MCP |
| 其余 Agent：`pnpm exec vitest run apps/agent/test --exclude apps/agent/test/skill.test.ts --exclude apps/agent/test/mcp.test.ts --exclude apps/agent/test/agent-capability-boundaries.test.ts` | 24 文件、238 项；两个旧状态断言补齐 `operation`，对应文件重新通过 |
| 修正与集成：`pnpm exec vitest run apps/agent/test/agent.test.ts apps/agent/test/startup.test.ts apps/agent/test/agent-controls.test.ts` | 41/41；属于上行 238 项，不重复计数 |
| TUI：command / content-renderer / tui / main | 5 + 10 + 11 + 9 = 35 项；main 使用新编译 CLI，包含保持父输入管道打开时退出的回归 |
| `pnpm check` | 通过；现有及局部代码保留 Biome informational 提示，无检查错误 |
| `pnpm build` | 通过 |

主体提交时共 **31 个测试文件、299 项行为测试**。没有把多次运行同一测试重复相加，也未把分工执行的验证写成运行过 `pnpm verify`。

实际终端证据：pi 输出送入 `@xterm/headless@6.0.0`，8 次代码增量合并为 1 个同步帧，无全屏清空；覆盖阅读锚点、中文多行粘贴、resize、审批阅读和终端恢复。

实际协议证据：stdio 分别协商到 **2026-07-28、2025-11-25**，Streamable HTTP 验证 **2026-07-28**。stdio 自动协商会由 SDK 启动一次短暂探测进程。HTTP 旧版本、真实外部服务互操作尚未验证。

编译 CLI 本地闭环通过：本机 SSE 模型 → `load_skill` → 流式 Markdown → `/new` → `/resume` → `/exit`。共两次模型请求；首个请求不含 Skill 正文，第二个请求才含已保存指令。持久化一条外部来源、一条真实用户消息、两个 Session；父进程保持输入管道打开，CLI 仍以 0 自然退出，stderr 为空，纯文本输出无 ANSI。夹具仅使用临时工作区、回环地址和占位密钥，结束后关闭进程与服务并清理临时目录。

## 2026-09-05：滚动性能与鼠标折叠修正

开发者在主体提交后反馈滚动卡顿、缺少可见滚动条，以及最终回答被思考和工具步骤分散。修正仍属于本 Feature 的终端体验，Agent、Session 格式、模型调用与权限语义不变。

正文与详情现在显示可点击轨道、拖动的滑块；无颜色或无 Unicode 时保留 ASCII 滑块。每个任务的思考、工具和中间消息归入执行过程，任务结束后自动折叠，最终回答及失败/停止提示继续可见。点击执行过程与单个步骤标题可逐级展开、收起；普通详情侧栏在结束后关闭，标题按钮可切换或关闭详情。正文拖选、链接、编辑区点击和审批阅读继续保留。折叠只改变呈现；Reasoning 沿用当前运行内存，恢复只使用已有公开消息，不伪造未保存的思考内容。

根因是嵌套布局重复用全部历史测量尺寸，每个滚动帧遍历正文六次；稳定内容也反复执行安全裁切。固定伸展区的 basis 并按宽度和内容版本复用最终安全行后，普通滚动无需重渲染历史。正文事件、折叠、异步高亮和文件装饰仍会让缓存失效。滑块不可见的原因是原样式只给空格设置前景色，现改为明确可见的字符。

在相同 Windows / Node 24.13.1 / pi-tui 0.84.1 / xterm headless 6.0.0 环境，以 100×28 视口、相同历史消息，每档发送 20 次实际 SGR 滚轮：

| 已完成轮数 | 修正前中位 / p95 | 修正后中位 / p95 | 历史 Markdown.render 次数 |
| --- | --- | --- | --- |
| 20 | 38.01 / 91.32 ms | 16.95 / 30.78 ms | 2,400 → 0 |
| 200 | 293.84 / 462.03 ms | 15.68 / 31.22 ms | 24,000 → 0 |
| 1,000 | 3,365.11 / 4,104.70 ms | 16.09 / 30.84 ms | 120,000 → 0 |

时间从滚轮输入前到同步帧提交给 headless，包含输入、调度、布局与渲染，不包含启动稳定等待和物理终端显示。每档 20 帧且视口确实移动。临时命令为 `node .tmp/scroll-diagnosis.mjs`，修正前 1,000 轮 p95 小于 50 ms 的检查失败，修正后通过；脚本已清理。

另以 200 轮历史、一个新任务和初始 40 行的 Assistant，连续 20 个增量各穿插一次滚轮：中位 26.48 ms、p95 39.34 ms，事件与输入最大 1.41 ms，返回末尾仍能看到最后增量。内容变化时会重新生成正文，但同宽 Markdown 缓存继续生效。临时命令为 `node .tmp/scroll-stream-diagnosis.mjs`，完成后已清理；不把机器相关毫秒阈值放入常规测试。

本次运行 `pnpm exec vitest run apps/tui/test/tui.test.ts`，17/17 通过，较主体新增 6 项；包含真实鼠标点击、滚动条拖动、无色 ASCII、非零滚动位置和标题锚点、历史重建、窄屏切换、正文拖选、审批与退出。稳定正文的 8 次独立滚轮和草稿输入均不再调用历史 Markdown.render。TUI 构建 `pnpm --filter @anthias/tui build`、局部 Biome 和根 `pnpm check` 通过。其余未改行为复用主体基线，当前合计 31 个文件、305 项测试覆盖；没有重复执行或重复计数。

该增量只增加一个局部 execution-view 呈现文件，没有新增依赖或通用 UI 框架。真实 Windows Terminal 的鼠标手感、输入法和物理显示完成时间仍由开发者实际验收。本次增量已于 2026-09-05 获开发者确认并授权提交，无残留诊断脚本或后台进程。

## 收口与验收边界

有界源码审查发现并修复 MCP 开始事实遗漏、外部来源写失败未封存、同步关闭登记顺序、读取后取消、恢复版本被模型替换和手动压缩写失败未封存。相关边界由上述集成验证覆盖。最终 CLI 检查另发现 Windows 输入管道仍引用事件循环，修复前新增进程回归超时，修复后退出码为 0。

Quick Start 已更新命令、Skill 目录、MCP 配置及显式连接步骤；README、产品定义、技术基线与 AGENTS 已同步当前实现。真实 Provider、开发者 MCP 服务、Windows Terminal 主观观感、输入法组合和人工复制未作为已通过证据。当前不提供 OAuth 登录、自动安装、Skill 生成、MCP Apps 或执行分叉。
