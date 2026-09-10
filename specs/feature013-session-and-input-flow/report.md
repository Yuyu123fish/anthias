# Feature 013 实施报告

状态：实施中

## 开发者速览

> **一句话**：Session 与输入流程已有实现，复审确认仍有停止竞态与理解成本问题。<br>
> **核心做法**：持久 Entry 统一提交，压缩按 Header 导航，两类输入在 Agent 安全点消费。<br>
> **边界**：保留旧历史与协作投递，不实现 fork，不运行真实外部验证。<br>
> **风险 / 未验证**：R01 停止竞态未修复；未进行真实模型、硬断电或人工终端体验验收。<br>
> **当前 / 请审阅**：保存实现与复审结论，不视为验收通过；后续结构调整另立 Feature。

## 当前结论

2026-09-10，开发者质疑实现和可读性后进行了复审，确认“停止 → 继续 → 再次停止”仍可能自动执行 followUp，并发现状态、队列、回调和 Context 构造的理解成本没有降到预期。[审查文档](review.md) 保存 R01–R06、源码位置、复现结果及 pi 参考路径。

R01 尚未修复，结构与注释问题尚未整改。此前“无遗留实质缺陷”的结论不再作为当前结论；文档状态改回实施中，未满足项在 Tasks 中保留。开发者要求本轮先保存审查并作一次本地提交，项目结构调整留给后续 Feature。

## 已落地行为与已知例外

普通正文默认 `steer`；`/steer <消息>` 在完整模型响应及整批 Tool 结束后的安全点消费，每次一条并继续当前 Run。`/followup <消息>` 等当前 Run 正常封口及收尾后开始新 Run。没有 Tool 的最终回答也检查 steer。

`prompt` 返回 accepted、queued 或 rejected 回执；accepted/queued 的 `durable:false` 表示输入只是被运行队列受理。`input_consumed` 携带 inputId、runId、entryId，只有此时输入已经保存并进入历史、Context 和相应授权来源。原先通过 await prompt 等待任务完成的调用者，应改为订阅关联的 `run_end`；Session 写入失效使用 `session_unavailable`，不假报持久终态。

停止、终态失败后保留队列但暂停，`/continue` 显式恢复；但 R01 已证明连续停止、继续、再停止的时序下，最后一次停止可能失效。排队输入在消费前不影响模型请求或权限。关闭和 Session 切换报告实际未消费输入：普通输入没有保存，成员输入保留原有持久投递事实。普通队列不跨重启。根与成员仍保留稳定来源及持久去重，不自动唤醒空闲成员。用户授权只从真实、已提交用户原文取得。

Schema 4 Header 保存 `latestCompactionEntryId`；每个压缩节点保存 `previousCompactionEntryId`、`nextCompactionEntryId`。父引用 `parentEntryId` 继续表示历史树，本次仅生成单路径，没有新增 fork。Context 从 Header 定位并验证候选，来源失效时沿可信前引用回退或重建，保留压缩节点之前的原文，不叠加旧摘要。摘要期间来源换版会拒绝提交该候选。

Schema 1/2/3 与旧平铺、嵌套、混合布局继续只读兼容，取得独占写锁后才升级明确打开的单个 Session。旧成员输入曾经位于 Tool 组中间的合法历史保持身份、父链和物理顺序；新输入追加仍要求安全点。新日志不依赖 `session.index.json`。

## 职责与实际调用链

完成消息的链路为 [SessionAgent.recordMessage](../../apps/agent/src/session-agent.ts) → [Session.appendMessage/appendAgentInput](../../apps/agent/src/session/index.ts) → 刷盘并返回 Entry → 更新 Agent 内部 history → 发布消息及消费事件。[Context](../../apps/agent/src/context/index.ts) 由已提交 Entry 派生；[Loop](../../apps/agent/src/agent-loop.ts) 使用 readMessages，不再复制一份可写完整历史，临时 reasoning 只保留在当前 Run 的内部 Map。

[Tool batch](../../apps/agent/src/tool/tool-batch.ts) 的结果统一调用 recordMessage，Tool 不分别更新消息历史与模型上下文。Session 不再保存 messageHistory；正常消息使用 message.ts 的完成态表达，不再进行 Message → DurableMessage → Message 往返，也不再通过最后一条记录回查 Entry ID。

Session 生命周期和串行写入集中在 session/index.ts，writer.ts 的 lease 与桥接已删除；groups.ts 并入 cleanup 私有实现，message-codec.ts、resume-index.ts 删除。产物模块转到 [tool/artifacts.ts](../../apps/agent/src/tool/artifacts.ts)，由 Tool 资源持有者管理。Session 目录由 15 个源码文件减为 10 个；但复审确认 createSessionView/createSessionWriter 转发关系仍在，运行结束状态及输入提交顺序也仍然分散，不能据此认定整体理解成本已经降低。

执行 Session 从 create/open 到 close 持有写锁；无逐 Run acquireRun/SessionRunLease。消息、来源、协作事实与压缩导航共用串行写入。只读历史仍独立读取，不取得执行所有权，不升级或修复。

## 取消、发布与恢复

正常追加以打开时建立的关联状态做增量校验，并核验锁与文件身份、大小、时间信息；不重读此前 JSONL 正文。检测到写入失败或外部替换后废弃写入器，停止后续模型与工具推进。打开、升级、每条恢复记录及 opened 记录连续传递同一已验证文件检查点，避免在检查之间重新采样并接受外部改写。

压缩在同目录写出完整候选并刷盘、校验，再一次替换当前日志；普通消息仍追加。新节点、旧节点 next 与 Header 入口随完整文件一起发布，不原地变长覆盖 JSONL。发布后核对主文件与候选内容摘要，再建立后续追加依据。重开依据已验证事实处理遗留候选或重建导航，中间消息损坏仍拒绝，不把导航修复当成任意历史修复。

首条用户消息落盘后立即关闭可以提交 aborted 终态；不必伪造 Assistant 消息。ToolCall/ToolResult 配对、未知副作用、EOF 截断及整组清理仍有明确恢复边界。已执行副作用不会因恢复或输入队列重复执行。

`run_end` 表示持久终态已经提交；`state.running` 在资源和执行所有权交接完成前继续为 true，防止终态回调立即压缩或切换 Session，与下一项排队输入并行。TUI 在交接完成后刷新状态。失败或取消结束过程已经开始时收到明确继续，会记住该请求并在结束后恢复；正常活动 Run 中的继续不预先授权未来失败后的自动恢复。但该记忆标记没有被重复停止正确清除，形成 R01。

失效写入器不能由 `/continue` 恢复。当前 Session 的 `/resume <当前 ID>` 是未重载操作，界面明确说明这一点；恢复路径为 `/exit`，再以 `--session <id>` 重新启动并核对已保存历史。重新打开不恢复普通内存队列；成员持久投递保持其原有恢复规则。

## 验证证据

环境：Windows NT 10.0.26100.0、Node.js v24.13.1、pnpm 10.33.0，工作目录为本仓库。

基线 main @ `8581c269400fbd775e97c15bc281bc73b19a154d` 的 `pnpm verify`：48 个文件，577 项通过、1 项跳过；Biome 有 176 条 info，无错误。

2026-09-10 最终 `pnpm verify` 通过：50 个测试文件全部通过，607 项通过、1 项跳过；Vitest 耗时 105.46 秒。Biome 检查 166 个文件，无错误，保留 177 条 info 提示；生产与测试 TypeScript 检查及构建均通过。该命令包含 Biome、生产及测试 TypeScript 检查、生产构建和全部 Vitest 测试。检查中发现的导入排序、默认 Header fixture，以及启动测试中的旧 Schema、索引和逐 Run 释放锁断言均已按新合同修正。两项四次串行启动 CLI 的测试使用四个进程的总时间预算，单个子进程仍限制为五秒；未放宽运行结果断言。启动与编译后 CLI 的定向验证分别为 11 项、10 项通过。各执行者的相同版本定向证据予以复用，统筹不逐项重复运行；最终整体验证覆盖最后合并版本。

审查文档保存前，核对了随后加入注释的两个 Context 源文件与上轮构建产物，去除类型和注释后的可执行代码一致。本轮 `pnpm exec tsc -p tsconfig.test.json --noEmit`、Biome 检查、Feature 文档链接检查和 `git diff --check` 通过。`projection.ts` 仅整理格式，保留注释原文与业务逻辑，因此复用上述整体验证，不重复运行全套测试。R01 的复现与证据限制见 [审查文档](review.md)。

| Spec 验收项 | 实现与验证入口 |
| --- | --- |
| A01–A02：统一提交、唯一历史与 Context | SessionAgent / Loop / Tool batch 调用链；agent、tool-loop、context-selection、context-integration、memory-context 测试 |
| A03–A04：增量追加、生命周期独占锁 | session、session-locations、session-publication；包含不读取旧正文、不生成独立索引、文件身份冲突与只读检查 |
| A05–A08：双队列、安全点、终态与 TUI | session-input-flow、agent-controls、agent、tui、command；覆盖整批 Tool、无 Tool、FIFO、继续、关闭与终态回调重入 |
| A09：成员持久投递与权限 | multi-agent、auto-allow-integration、auto-review、workspace-permissions；来源与持久提交约束保持 |
| A10–A12：旧格式、父引用与保守恢复 | session、session-recovery、session-locations；旧布局、旧 Tool 组中成员输入、EOF、未知副作用与清理保护 |
| A13–A14：压缩导航与发布恢复 | context-selection、context-integration、memory-context、session-publication；前后导航、来源变化、候选发布故障及恢复时同长度改写窗口 |

独立只读审查覆盖非审查者实现的存储、输入与 TUI，Context 由统筹核对。审查推动修复了旧 Schema 3 成员输入读取、打开阶段文件检查点断链、终态控制操作与 followUp 并行，以及失败封口期间明确继续的处理。当时的独立审查未发现其他实质缺陷；后续复审已用确定性场景证明仍有 R01。两次审查均未重复运行原实现者的整套测试，不能将较早的审查结论替代后续证据。

## 验证边界与 Git

所有模型交互使用确定性本地流或本地 HTTP Server；未使用真实 Provider、外部网络服务或敏感凭据。终端验证使用全屏模拟终端与纯文本流，尚未做开发者的 Windows Terminal 主观体验验收。候选 sync/rename 的故障注入覆盖选定的失败窗口，不等于真实进程强杀、硬断电或所有文件系统的耐久保证。

Header 引用加速已加载 Session 查找最新压缩；Context 仍会遍历已加载记录构造消息组、校验及选择来源。打开仍完整读取校验；每次压缩候选也需要完整文件发布，不声称是磁盘随机读取或有界冷恢复。

本次在 main 上将当前实现、已有测试和 Feature 文档一并作本地提交，包含复审结论及未修复问题；未推送、未创建 PR。提交不代表验收通过，README 与稳定 docs 不将本 Feature 写成已验收能力。
