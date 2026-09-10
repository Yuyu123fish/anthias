# Feature 013 实施方案

状态：实施中

## 开发者速览

> **一句话**：完整交付 Session 简化、压缩导航与运行中消息插入。<br>
> **核心做法**：统一 Entry 读写与提交，再贯通 Agent 队列、Context 和 TUI。<br>
> **边界**：兼容旧历史与协作投递，不实现 fork，不调用真实外部服务。<br>
> **风险 / 未验证**：复审确认 R01 停止竞态未修复，结构与注释仍需调整。<br>
> **当前 / 请审阅**：实现与审查结果保存为一次提交；后续改造另立 Feature，当前未验收。

## 基线、授权与范围

基线为 main @ 8581c269400fbd775e97c15bc281bc73b19a154d；开始时仅本 Feature 的 Spec 未跟踪。2026-09-10 开发者确认 Spec，并明确要求按流程一次性实现整个 Feature。本 Plan 与统一 Tasks 记录本次完整实施边界，不另设需要中途停交的 Stage。当时尚未授权提交、推送、PR 与真实外部验证。2026-09-10 复审后，开发者授权将当前实现与审查文档作一次本地提交；结构调整留给后续 Feature，推送、PR 与真实外部验证仍未授权。

基线 pnpm verify 通过：48 个测试文件，577 项通过、1 项跳过；Biome 有 176 条既有 info，无错误。测试使用本地确定性模型、临时 Session 与本地 Shell/Git。

范围对应 Spec A01–A14：Session 存储与旧格式边界、Agent 消息提交与队列、Context 压缩导航、根成员消费以及全屏/纯文本 TUI。不同实现区域可并行，接口先统一；执行者只运行自己负责的定向验证，整体检查由统筹执行。

## 存储与恢复设计

新写入 Schema 为 4。Header 保留身份与归属，增加 latestCompactionEntryId，未压缩为 null；CompactionEntry 增加 previousCompactionEntryId 与 nextCompactionEntryId。Entry 的 parentEntryId 继续连接历史父节点，与压缩前后引用分离。本次只生成单路径。

持久化完成消息直接使用 message.ts 的完成态 Message 表达；流式 Assistant 不允许提交。旧 kind 形状只在旧 Schema 解析入口归一化，去掉正常读写 codec 往返。Session 持有已提交 records、Header 与按 Entry ID 查找的内存 Map，不再持有独立可写 messageHistory。内部 getEntry(entryId) 服务 Context 导航，不从 package 公开。

Session 创建/执行打开成功起持有独占写锁，close 先停止接收写入并排空串行写入后释放。删除逐 Run acquireRun/lease；追加行为统一以 runId（无所属 Run 时为 null）和 details 为参数，返回已提交具体 Entry。消息、Tool 开始与 Run 终态必须指定 Run。源记录、协作事实和审批继续保持各自类型。

打开时校验完整日志；正常追加只校验新 Entry 和内存关联状态，再核对文件身份/长度并持久追加，不重读旧正文。删除 session.index.json 生成与读取依赖。只读查询仍有独立入口，不持有执行写锁，不修复或升级。

压缩在同一写入串行链中构造完整候选，更新 Header、新压缩节点及旧节点 next；候选在同目录独占创建、刷盘、完整校验后替换当前日志。发布前后任意失败必须能保持完整旧文件或完整新文件；不能原地变长改写旧行。候选或中断状态按明确规则恢复，不把未知中间损坏当成导航损坏修复。恢复重建导航仅依据已经验证的完整 Entry，不能掩盖消息和工具事实损坏。文件替换后重建检查点与索引，运行 context 只在提交成功后切换。

Schema 1/2/3 与旧目录布局只读兼容；明确执行打开并取得写锁后才升级单个 Session。升级将旧消息归一化，按已验证历史建立压缩链，保持 Entry 身份与历史父关系；升级失败保留可恢复事实。不批量迁移，不依赖旧独立索引。

文件按实际职责收束：Session 生命周期与串行读写集中，Schema 负责 Entry 与校验，旧格式兼容集中；清理组装并入清理私有实现；Tool 产物移至 Tool 资源归属。只有存在独立资源或恢复边界才保留独立文件，不新增转发层。

## Agent 与 Context

完成消息通过同一个提交入口形成 Entry，持久化成功后更新 Agent state 历史与请求 context，再发布完成事件。Entry 身份由追加返回，不按正文或最后记录回查。Loop 和 Tool batch 读取 Agent 持有的历史，不另外维护完整可写历史；Tool 只产出结果。

Context 从 Header.latestCompactionEntryId 与 getEntry 找最近压缩节点，沿 previous 检查更早候选；来源撤销、版本、压缩边界和完整 Tool 组共同决定可用性。无可用摘要时从原 Entry 与有效来源重建。保留原文可能在压缩行之前，不只读物理尾部，也不叠加历次摘要。临时 reasoning 只按持久身份合并当前 Run 协议数据。打开依旧完整校验，内存定位不宣称是文件随机读取。

## 输入与 TUI 合同

公开 prompt(text, options?) 的 options 包含 mode（steer 或 followUp，默认 steer）与 resume。返回 accepted/queued 回执（inputId、mode、durable:false）或 rejected；已持久化执行终态由 state 与 run_end 提供；Session 写入失效时发布 session_unavailable，暂停执行和队列，不伪造 run_end。回执表示接受到内存，input_consumed 才表示输入已持久化。内部 runTool 和成员启动可以继续等待终态，不扩大公开接口。

Agent state 提供只读 inputQueue，包含 steer、followUp 队列及 paused。队列项目带 inputId、原文、模式与可校验来源。input_queued、input_consumed（含 Run/Entry 身份）、input_discarded（关闭或切换原因及输入来源）用于呈现与关联。正常消息与成员输入最终共用消费时点；已有成员投递仍先耐久入队、目标落盘后确认送达，沿稳定 messageId 去重。

完整 Assistant 与整个 Tool batch 持久化后，每次消费一条 steer；没有 Tool 的最终回答也检查。steer 延续当前 Run；无 steer 且 Run 正常封口、资源收尾后才开始 followUp 对应的新 Run。输入接收、消费和终态交接明确串行，重入事件不能造成重复消费或向已封口 Run 追加。停止、失败和关闭禁止自动续队列；暂停期间保留未消费输入，resume 显式恢复。新消息在消费前不影响 Context 或授权。

两种 TUI 入口支持 /steer <消息> 与 /followup <消息>，普通正文默认 steer；/continue 显式恢复队列。有排队内容且无补充要求时直接恢复；否则保留现有明确继续正文。移除等待整轮的 TUI submissionPending 阻塞，回执后即可继续输入。状态区与事件显示排队数量、暂停、已插入或未保存；关闭时先让未消费结果可见再关闭终端。TUI 不维护第二份业务队列，审批与停止路径保持。关闭提示分别说明普通输入未保存和成员输入仍保留持久投递。当前 Session 的 /resume 不重建写入器，提示真实的未重载结果；写入失效后应 /exit，再以 --session <id> 重新启动恢复。

## 实施与验证顺序

1. 建立已批准范围的 Plan/Tasks 与接口边界，保留基线验证。
2. 完成存储统一及恢复，Runtime 在相同接口上实现提交与输入队列，Context 同步投影；分别做定向验证。
3. 贯通 TUI、旧调用者与协作消费，完成可操作的用户流程与公开接口验证。
4. 运行 pnpm verify；必要时检查真实全屏模拟终端与纯文本输入，无真实 Provider 调用。
5. 独立审查对照 A01–A14，修复实质缺陷，只重跑受影响的定向验证；有集成变化才重跑整体 gate。
6. Tasks 标记实际结果，Report 说明调用链、已删除步骤、验证环境和证据边界；状态最多为已实现。

验收重点覆盖：Schema 旧读/新写和失败恢复；两次以上压缩导航、引用损坏与来源失效；打开到关闭的写锁；消息及工具事件顺序；运行中双队列、no-tool 终态竞争、停止/关闭、成员去重；TUI 两模式与输入恢复。复用现有测试，不按每个文件或每条验收机械加测试。

## 风险、停止条件与报告

单次压缩的候选文件发布会读取/写入整个 Session，代价集中在压缩而非每条追加；本 Feature 不承诺超大日志随机恢复。Windows 文件替换、活动只读查询和进程取消需以实际测试说明。来源撤销后不得经旧摘要重新带回正文。移除 lease 后清理必须仍保护长期持锁的空闲 Session。

发现 Spec 外的产品语义、范围或权限变化时只暂停受影响部分并回报；普通实现缺陷在授权范围内修复。环境故障与已有失败先查原因，不能删除测试或放宽关键断言制造通过。Report 保存真实命令与结果、人工体验和硬断电等无法证明的边界、未提交 Git 范围；不把开发者验收或 Git 动作视为自动完成。
