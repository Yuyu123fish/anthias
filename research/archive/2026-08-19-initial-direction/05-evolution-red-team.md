# Anthias 自进化红队研究：如何证明改变没有自我授权、污染谱系或破坏运行时

> 研究截止：2026-08-19
>
> 文档性质：对抗性研究，不是 Spec、Plan、Stage 或实现设计
>
> 研究对象：Anthias 已确定的“持续身份 + 跨任务 Evidence + Agent 自写组件 + Runtime Mutation + 独立 Evaluation + 用户强制 pin”闭环

## 0. 阅读约定

本文始终区分四类陈述：

- **[项目约束]**：来自 Anthias 当前项目定义、`AGENTS.md` 与技术基线，本研究不能静默改写。
- **[来源事实]**：外部一手来源直接报告的机制、实验或限制，不自动成为 Anthias 的设计。
- **[红队推断]**：在 Anthias 约束下推导出的失败路径；它是待验证的风险判断。
- **[原则防线]**：为了使风险可证伪而需要保持的原则，不冻结状态机、字段、阈值、模块或实现步骤。

外部证据再按可信边界分级：

- **S1**：官方规范、官方 API 或官方源码定义；能证明公开语义，不能证明 Anthias 已正确实现。
- **S2**：同行评审论文或有成熟实验公开的论文；能支持限定实验结论，不能直接外推到长期生产 Runtime。
- **S3**：带公开方法、数据或代码的预印本；是研究信号，不视为独立复现后的定律。
- **S4**：非常新的预印本；只作为高价值反例或设计线索，不能单独冻结 Anthias 边界。

这里特意使用 `S`（source），避免与 [03-evaluation-safety-frontier.md](03-evaluation-safety-frontier.md) 中用于表达 Anthias Evaluation 证据层次的 `E0—E5` 混淆。

## 1. 红队结论先行

**[红队推断] Anthias 最大的危险不是 Agent 会写出一段坏代码，而是它能够逐步改写“什么算事实、什么算成功、谁有权让改变生效”。** 如果 Proposal、Reflection、Evaluator 输入、Runtime 激活和长期记忆落入同一信任闭环，那么系统即使拥有完整 Ledger，也可能只是完整记录了一次自我授权。

因此需要守住四条不可互相替代的分界：

1. **事实与解释分开**：Run Event、Artifact 和实际副作用是事实；Reflection、根因判断和经验抽取只是可推翻的解释。
2. **候选与权威分开**：Candidate 可以被试运行、记录和比较，但不能因为“已经运行”就成为 Agent HEAD、长期经验或后续蒸馏的可信输入。
3. **能力表面与资源权力分开**：Agent 可以生成新 Skill、Tool、Plugin 或 Provider，不代表它因此获得新的文件、网络、进程、Secret、评价或治理权限。
4. **提案与证明分开**：提出改变的 Agent 可以声明预期收益和可能回归，但不能决定评价集、删除不利证据、修改裁判，或把自己的解释当成 Promote 依据。

这四条分界共同导向一个原则级判据：

> **Candidate 可以改变同一 Agent 的可执行能力结构，但不能在同一次候选变化中扩大自己的授权边界、重写评价权威、改写已接受谱系，或让未验证产物进入未来学习上下文。**

这个判据与 Anthias 现有方向一致，但仍需要红队补上三个容易被“可追踪、可回滚”口号掩盖的问题：

- **可追踪不等于因果正确**：完整轨迹仍可能支持错误归因。
- **可回滚不等于世界复原**：远端调用、消息、文件、进程、迁移和后代经验可能已经不可逆。
- **独立 Evaluation 不等于真实独立**：若候选能影响数据、裁判、预算、输入投影或 Promotion 规则，换一个模型充当 critic 仍然是同一权力域。

## 2. 攻击面模型

### 2.1 八个可被偷换的面

| 攻击面 | 被保护的真实问题 | 典型偷换 | 最坏后果 |
|---|---|---|---|
| Evidence 面 | 发生过什么 | 选择性记录、压缩掉失败、把 Reflection 写成事实 | 演进理由不可复核 |
| Evaluation 面 | 候选是否更好 | 泄漏 holdout、改 grader、提高预算、只展示成功切片 | 伪提升被 Promote |
| Learning 面 | 什么可以影响未来决策 | 未验证 Skill 进入上下文、候选经验参与后代蒸馏 | 污染跨代传播 |
| Activation 面 | 哪个候选成为权威 | stale proposal、重复提交、部分提交、candidate 自签 | HEAD 与实际 Runtime 分裂 |
| Authority 面 | 能影响哪些资源 | Tool 增多同时隐式扩权、绕过 ProcessSupervisor | 自写组件越权或外泄 |
| Lifecycle 面 | 谁拥有并释放副作用 | Owner 丢失、进程树逃逸、旧 ClassLoader 被引用 | 热替换后残留活体 |
| Capability 面 | 替换后是否仍满足真实语义 | schema 相同但前置条件、失败语义或数据边界变化 | Consumer 被静默欺骗 |
| Identity / Intent 面 | 仍是谁、用户要求什么 | Branch 计成新 Agent；安全隔离偷换成解除 pin | 谱系与用户控制失真 |

### 2.2 攻击者不必是恶意模型

**[红队推断]** 下列失败都可能在没有主动恶意时发生：模型自信但归因错误；评测样本太少；并发任务使用旧 Epoch；Provider 在返回结果前已完成远端副作用；故障恢复重复执行；依赖图替换让 pinned 能力表面存在但实际不可调用；某个 Skill 的错误逻辑被后代 Skill 吸收。

因此 Governance 不能只防“越狱”或“恶意插件”。它还要防正常组件、正常模型和正常重试共同产生的结构性错误。

## 3. Failure Modes

### FM-01：候选修改或污染 Evaluator

- **触发条件**：Candidate 能写评价规则、测试夹具、grader prompt、模型配置、预算、采样参数或 Evaluation 输入投影；或者能通过被测 Runtime 间接影响裁判看到的输出。
- **可观察痕迹**：候选改动与分数规则同批出现；评估时模型、预算或工具权限发生变化；失败 Evidence 缺失；只有候选生成的测试通过；重放不能得到相同裁判输入。
- **普通 harness 容易漏掉的原因**：常见 harness 把“工作区可编辑”视为能力，而没有把 verifier、运行记录和模型配置定义为独立保护层。即使另一个 LLM 负责打分，只要输入来自候选可编辑路径，权力仍未隔离。
- **原则防线**：Evaluator、评价数据、模型/预算基线、Ledger 权威和 Promotion 规则位于候选不可写的保护域；Candidate 可以提交自测与预期，但它们只增加 Evidence，不授予 verdict；评价输入必须能绑定到受保护来源和精确版本。
- **仍无法证明的边界**：保护域能防直接篡改，不能证明 grader 语义正确，也不能消除固定指标被间接博弈。

**[来源事实，S3]** AHE 将运行目录、tracer、verifier、LLM 配置设为只读，并要求每次 harness 编辑声明预期修复与预期回归，再由下一轮任务级结果证伪；但同一研究也报告回归预测 precision 仅 11.8%、recall 仅 11.1%，说明“候选能解释为何有用”远不等于它能预见会破坏什么。[AHE](https://arxiv.org/abs/2604.25850)

### FM-02：支持数据、演进数据与 holdout 泄漏

- **触发条件**：同一任务既用于发现摩擦、蒸馏 Skill、调试候选，又用于最终晋升；Reflection 能读取 holdout 失败；长期记忆保留了评价答案；重复评估逐渐把测试集变成训练集。
- **可观察痕迹**：候选描述中出现 holdout 专有内容；某一固定评价集持续改善但新仓库/新模型退化；每轮评估后 Skill 越来越针对具体任务；无法列明某条经验曾接触哪些任务。
- **普通 harness 容易漏掉的原因**：轨迹、记忆与评价通常共用同一检索库，“只读测试”仍可能通过日志、错误信息或反复试跑泄漏给后续 Reflection。
- **原则防线**：明确区分用于产生 Hypothesis/Asset 的支持证据、用于候选选择的验证证据和不参与演进的最终 holdout；记录每个候选、经验和后代产物的输入谱系；任何接触过评价信息的产物不再被当作该评价的独立证据。
- **仍无法证明的边界**：真实任务分布没有天然完美 holdout；跨仓库相似代码、公共 benchmark 和基础模型预训练都可能形成不可完全观测的泄漏。

**[来源事实，S4]** “When Self-Evolution Backfires”把蒸馏用 Event、门禁用 Holdout、最终评价用 Test 分离，并明确把 Event 结果视为乐观上界；这支持“演进输入与最终证据必须分开”，但其结论目前仍是 2026-08-06 发布的单篇新预印本。[论文](https://arxiv.org/abs/2608.05810)

### FM-03：Reflection 自证与叙事闭环

- **触发条件**：Agent 从失败轨迹形成根因解释，再用该解释选择证据、生成修复与总结，最终把“解释一致”当成“修复有效”。
- **可观察痕迹**：Evaluation 复述 Reflection 而没有独立结果；没有可失败的对照；候选只改善 Reflection 指出的任务；根因陈述越来越确定但客观数据不变。
- **普通 harness 容易漏掉的原因**：自然语言反思读起来合理，且 critic 往往共享同一模型、上下文和偏见。换角色名不产生权力或证据独立性。
- **原则防线**：Reflection 只创建 Hypothesis；它必须同时声明预期收益、可能回归和能推翻自己的观察；Promotion 依赖匹配的 baseline/candidate 结果和受保护事实，不依赖解释的流畅度。
- **仍无法证明的边界**：即使结果改善，也可能是模型随机性、任务难度差异或其他同时变化造成的相关性，不能自动证明 Reflection 找到了根因。

### FM-04：未门禁资产造成后代污染与不可逆积累

- **触发条件**：新 Skill、Workflow、Memory、Tool 说明或组件在 Promote 前就进入 Agent 的正常决策上下文或后续蒸馏上下文；后代产物没有记录其生成时可见的祖先资产。
- **可观察痕迹**：资产池增长而性能先升后降；删除某个坏 Skill 后错误仍存在；后代文本复现已删除资产的逻辑；无法回答某个 Artifact 是在什么能力/记忆集合下生成的。
- **普通 harness 容易漏掉的原因**：Skill 常被当作可随时删除的文本文件，系统只记录当前集合，不记录“生成时看见过谁”；于是删除源文件看似完成回滚，语义污染却已进入后代。
- **原则防线**：Candidate 默认对稳定 Agent 的学习上下文不可见；只有 Promote 后才可成为未来蒸馏的可信父输入；被隔离候选可保留为审计 Evidence，但必须带明确非权威标签；所有派生产物保留输入谱系，回滚按影响谱系判断而非只删源资产。
- **仍无法证明的边界**：语言模型可能以无法逐句定位的方式吸收上下文；即使有谱系也只能界定暴露关系，不能准确证明每个后代是否继承了某条错误推理。

**[来源事实，S4]** 上述新预印本在 Terminal-Bench 2 上报告无门禁 Skill 池出现先升后降，并称仅删除污染源只恢复了 17% 的退化；它把个体、组合和系统性污染分开。该数字不能外推为 Anthias 的预期值，但足以否定“文本可删，所以积累天然可逆”的假设。[论文](https://arxiv.org/abs/2608.05810)

### FM-05：通过依赖图间接使用户 pin 失效

- **触发条件**：Proposal 不直接 disable pinned 对象，而是移除其依赖、关闭 Owner Scope、改变 Provider precedence、撤销权限、替换路由、制造版本不兼容，或保留名称但替换成不等价实现。
- **可观察痕迹**：pin 记录仍在，Runtime Graph 也仍显示节点，但实际调用不可达、持续失败、被 shadow、缺失必需依赖或已失去授权；Agent 报告“已开启”却无法成功使用。
- **普通 harness 容易漏掉的原因**：只检查操作名或 enabled flag，不验证变化后的完整图和可调用语义。
- **原则防线**：pin 是 Stable Host 持有、位于 Agent Revision 之外的用户约束；每次 Mutation 对结果图做传递不变量检查；不得用同名占位对象满足 pin；Agent HEAD 切换、Branch、回滚和 Host 重启都不能隐式改变 pin。
- **仍无法证明的边界**：结构可满足不等于外部服务健康；“固定确切 Provider”与“固定某 Capability 可用”仍需用户语义，系统不能自行猜测。

### FM-06：旧 Composition Epoch、并发 stale writer 与 ABA

- **触发条件**：多个 Run/后台任务基于同一 Runtime Snapshot 生成 Proposal；候选准备期间 Runtime 已变化；图先从 A 变 B 又回到看似相同的 A；故障恢复重放旧 Proposal。
- **可观察痕迹**：Proposal 的 expected Epoch/HEAD 与提交时不一致；两个变更都报告成功但只有部分图存在；Owner 或 pin 校验基于旧图；同一 effect 被重复执行；HEAD、Projection 与实际 Provider 集合分叉。
- **普通 harness 容易漏掉的原因**：单机内存锁只保护一次方法调用，无法保护长时间的“读取—模型思考—候选准备—提交”；仅比较对象值也识别不了 ABA 和已改变的授权版本。
- **原则防线**：RuntimeCoordinator 保持唯一结构写入者；Proposal 绑定精确前驱 HEAD/Epoch 与相关权威版本，并在最终提交前重新验证；提交是完整结果图的单次权威变化，失败不暴露半状态；过期提案重新感知，而不是强行套用。
- **仍无法证明的边界**：结构线性化不能证明 Candidate 的业务语义正确；分布式存储、外部 Provider 与崩溃恢复仍可能让观察短暂不一致。

**[来源事实，S4]** 2026-08-12 的 Continuity Kernel 预印本把 proposer 视为不可信，要求候选绑定精确前驱、提交前复核 freshness，并以 Commit/Reject/Quarantine/Defer 区分结果；其有界模型检查覆盖协议状态，却明确不证明语义正确性。[论文](https://arxiv.org/abs/2608.11632)

### FM-07：资源 Owner 丢失与进程泄漏

- **触发条件**：Plugin/Provider 在准备、健康检查、切换或失败回滚中创建线程、进程、端口、监听器、临时目录、缓存或 ClassLoader，却没有被同一 Owner/Scope 接管；子进程再派生后代；Consumer 持有旧实现对象。
- **可观察痕迹**：Revision 已卸载但进程/端口仍存活；旧 Provider 仍接收事件；ClassLoader 可达；重复挂载后资源单调增长；关闭失败只出现在日志而不进入 Evolution Evidence。
- **普通 harness 容易漏掉的原因**：注册表删除被误当成资源已释放；`AutoCloseable` 只表达局部关闭接口，不能自动发现未登记资源；普通进程句柄也存在 PID 复用和观察竞态。
- **原则防线**：每个受管副作用创建时即绑定 Owner/Scope；ProcessSupervisor 是唯一进程创建入口并持有进程树语义；切换后旧 Revision 先停止接新工作、排空、反向释放，残留被记录为失败 Evidence；Provider 实现对象不得泄漏给长生命周期 Consumer。
- **仍无法证明的边界**：Host 无法回收绕过受管入口创建的资源；同 JVM 不可信代码无法靠 ClassLoader 或关闭约定形成安全隔离。

**[来源事实，S1]** JDK 只说 `AutoCloseable.close()` 释放对象所持资源；类卸载依赖定义它的 ClassLoader 可回收；`ProcessHandle` 对进程信息和终止只提供尽力语义并警告竞态与 PID 复用。[AutoCloseable](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/lang/AutoCloseable.html)、[JLS 25 §12.7](https://docs.oracle.com/javase/specs/jls/se25/html/jls-12.html#jls-12.7)、[ProcessHandle](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/lang/ProcessHandle.html)

### FM-08：回滚只回代码，不回副作用

- **触发条件**：Candidate 已发送消息、调用远端 API、修改外部仓库、迁移数据、泄露信息、产生计费、启动外部任务或影响后代经验，系统却把 checkout 旧 Artifact/Revision 称为“完全回滚”。
- **可观察痕迹**：代码 HEAD 已恢复但远端状态不同；crash 发生在 dispatch 后、receipt 前；恢复后同一调用重复；旧外部凭据或进程仍有效；污染后代继续被检索。
- **普通 harness 容易漏掉的原因**：Git/Artifact 回滚是可见且简单的，外部副作用却跨系统、非事务、可能不可查询，因而被排除在“版本”概念之外。
- **原则防线**：明确区分结构回退、补偿动作和不可逆历史；外部 effect 在 dispatch 前留下持久意图与唯一身份，未知结果不能盲目重放；恢复采用向前的新 Revision/修复事件，不伪造历史从未发生；Promotion 必须看到未解决 effect 与补偿边界。
- **仍无法证明的边界**：多数远端系统不能与 Anthias 原子提交；补偿不是时间倒流，不能收回已读取的信息、已发出的消息或第三方基于旧结果采取的行动。

**[来源事实，S3]** Agent libOS 将 action surface 与资源 authority 分开，并把外部 effect 设计为 prepare–dispatch–settle；dispatch 后结果不明时恢复不得盲目重放。它也明确指出 checkpoint restore 保留历史外部 effect，不能把恢复解释为撤销世界状态。[论文](https://arxiv.org/abs/2606.03895)

### FM-09：Capability substitution 的语义漂移

- **触发条件**：新 Provider 满足相同类型、Tool schema 或名称，但改变前置条件、精度、排序、幂等性、时效性、错误分类、隐私边界、成本、超时或副作用。
- **可观察痕迹**：依赖解析和健康检查通过，旧 Consumer 却出现新的重试、误编辑、顺序变化或数据外发；同一输入的失败语义不同；Provider 宣称兼容但回归只集中在某类 Consumer。
- **普通 harness 容易漏掉的原因**：结构兼容容易自动检查，行为合同与隐含假设通常没有被显式观察；MCP/JSON schema 只能约束形状，不能证明语义等价。
- **原则防线**：Provider 替换的验证对象是“候选 Provider + 受影响 Consumer + 真实任务切片”，而不只是 Provider 自测；契约证据覆盖成功与失败、资源/数据边界和旧能力回归；Capability 身份不能由同名或 schema 相同推断。
- **仍无法证明的边界**：开放环境中的行为等价不可穷举；通过已有 Consumer 集只证明观察范围内兼容。

**[来源事实，S1]** MCP Tool 的 input/output schema 描述结构，Tool annotation 仍被规范视为不可信声明，协议安全原则需要 Host 落实；这印证“协议可发现/可调用”不等于 Anthias Capability 的行为等价。[MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)、[MCP Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)

### FM-10：用成本或延迟换正确率，制造伪提升

- **触发条件**：Candidate 获得更多 token、更多重试、更强模型、更长超时、更多并行调用或更高权限，然后只用任务成功率与旧 Revision 比较；反过来也可能为降成本牺牲难题正确率。
- **可观察痕迹**：成功率提高但总调用、尾延迟、费用、资源峰值或失败恢复成本激增；只报平均值；难任务下降被简单任务数量掩盖；baseline 与 candidate 的预算不匹配。
- **普通 harness 容易漏掉的原因**：单一 leaderboard 分数把多维取舍压成“更好/更坏”，且模型本身容易把完成任务当成唯一目标。
- **原则防线**：在同一受保护条件下比较 baseline 与 candidate，并按任务类型保留正确性、安全、成本、延迟、资源和回归等独立维度；任何总分都不能抹掉硬约束失败；候选必须披露它改变了哪些预算和权限。
- **仍无法证明的边界**：不同用户对成本、速度和正确率的效用不同；不存在脱离实际使用场景的普遍最优单值。

### FM-11：把同一 Agent 的 Branch 错认成多个 Agent

- **触发条件**：实验 runner 为每个 Revision 创建独立进程/会话/模型角色，随后把技术隔离对象当成新的 Agent 身份；或把 evaluator/reflector 角色数量计入 Agent 谱系。
- **可观察痕迹**：模型切换或 Branch fork 生成新 `AgentId`；同一历史摩擦被拆散；被拒分支无法回到共同父 Revision；统计报告把候选数称为“Agent 数”。
- **普通 harness 容易漏掉的原因**：许多研究把一个 prompt/scaffold 实例直接命名为 agent，archive node 也常被叫作一个 agent；运行隔离与领域身份没有被区分。
- **原则防线**：`AgentId`、Run、Revision、Branch、Epoch 和执行进程保持不同语义；Branch 是同一 Agent 的可能未来，除非用户或明确领域事件创建新身份；多角色/多进程只是执行与评价拓扑，不自动成为持续身份。
- **仍无法证明的边界**：当目标、记忆与主要能力几乎全部变化时，何时应产生新 Agent 仍是产品语义，现有论文没有替 Anthias 给出客观阈值。

### FM-12：保护层被同层 Candidate 重写

- **触发条件**：为了追求“真正自进化”，允许 Candidate 同时修改 Governance、RuntimeCoordinator、Ledger 解释器、Evaluator、pin 存储、Artifact 身份规则或赋权原语。
- **可观察痕迹**：候选改完规则后恰好通过；旧 Evidence 无法被新解释器重放；权限扩大被包装成 Capability 优化；恢复点同时包含旧状态与新授权规则。
- **普通 harness 容易漏掉的原因**：“一切皆可插件化”容易被误解为信任根也应由被治理对象随意替换；形式上仍有 Proposal，实质上候选已定义了 Proposal 是否有效。
- **原则防线**：当前候选的裁判、权威和提交边界必须来自其父 Revision 之外的稳定保护层；若未来保护层也需要演进，它只能成为另一个明确层级的候选，由更高、独立且仍受用户控制的边界评价，不能与被测 Runtime 一起自批自准。
- **仍无法证明的边界**：不存在无限层级的绝对自证；最终仍需一个不由当前 Agent 控制的人类/Host 信任根，并明确其证据能力有限。

**[来源事实，S3]** Agent libOS 的中心不变量是模型可见 action surface 可以变化，但对既有/外部资源的 authority 不随之隐式扩张；Skill 激活与 JIT Tool 注册仍需经过底层原语与 Capability 检查。论文也明确其并非内核级沙箱、不能证明 Agent 会安全推理。[论文](https://arxiv.org/abs/2606.03895)

### FM-13：pinned 对象故障时，把安全停止偷换成 unpin

- **触发条件**：用户固定的 Provider 崩溃、泄漏、越权、依赖不可用或被安全系统隔离；Runtime 为恢复服务自动换 Provider、删除 pin，或继续宣称其健康。
- **可观察痕迹**：实际进程已停但 pin 记录消失；同名替代物未经用户语义允许被启用；系统为了保持 enabled flag 而继续运行危险对象；Agent 把“暂不可满足”报告成“用户已取消”。
- **普通 harness 容易漏掉的原因**：enabled、healthy、selected、running 与 user-required 常被压在一个布尔值中，无法同时表达“用户意图仍有效，但当前为了安全不得运行”。
- **原则防线**：Host 可以隔离、停止或阻止调用危险实例；安全动作只改变实际运行/健康事实，不改变用户 pin。此后恢复必须满足原 pin 语义；无法满足时显式保持“pin 仍在但当前不可满足”，等待安全恢复或用户决策。
- **仍无法证明的边界**：若用户坚持的对象永久不安全，系统不能同时保证运行可用与无条件执行用户意图；它能保证的是不伪造、不静默替换、不让 Agent 自行解除。

### FM-14：评价只看候选个体，漏掉组合污染

- **触发条件**：每个 Skill/Provider/Workflow 单独通过，但与现有集合共同工作时冲突、重复指令、争夺路由、扩大上下文或形成资源死锁。
- **可观察痕迹**：单件 A/B 都非负，合并后的 Runtime 却退化；错误只在特定 Skill 组合或 Provider 顺序出现；分支合并比任一父分支更差。
- **普通 harness 容易漏掉的原因**：逐插件测试规模可控，组合空间巨大；“每个组件都健康”被误当成“组合后系统健康”。
- **原则防线**：Promotion 判断针对候选加入后的完整 Runtime Graph 和受影响组合；分支合并视为新 Candidate，而不是继承父分支的成功证明；观察图级交互而不宣称穷举全部组合。
- **仍无法证明的边界**：组合空间和真实任务空间不可穷举；只能用风险驱动切片、历史 Evidence 与持续监控减少盲区。

## 4. 最小 Falsification Suite

以下不是测试代码、用例数量或实现方案，而是 Anthias 在声称“可安全演进”前必须能够尝试推翻自己的最小问题集。一次成功只能证明给定版本、环境和观察范围。

1. **评价权隔离**：给 Candidate 修改 grader、评价数据、模型预算、Ledger 与 Promotion 规则的机会，证明所有路径都不能改变权威 verdict；候选自测只能作为非权威 Evidence。
2. **数据隔离**：证明用于 Reflection/生成资产的任务、用于候选选择的任务与最终 holdout 的暴露关系可追溯；任何已暴露产物不会继续冒充独立 holdout 证据。
3. **错误 Reflection**：故意提供一个语言上合理但因果错误的 Hypothesis，证明系统能因客观结果不支持而拒绝它，而不是被叙事一致性说服。
4. **污染阻断**：让未 Promote Skill 生成后代资产，证明它不会进入稳定 Agent 的决策或蒸馏上下文；若人为允许暴露，证明所有后代都保留暴露谱系且不会被源文件删除伪装成已清除。
5. **pin 传递不变量**：分别尝试删除依赖、关闭 Owner、改变路由/优先级、撤销权限、同名替换和回滚旧图，证明任何让 pinned 目标不可满足的结果图都不会提交。
6. **stale/并发提交**：让两个 Proposal 基于同一 Epoch/HEAD 竞争，并模拟 A→B→A、重复消息与崩溃恢复，证明至多一个精确后继成为权威，失败方不留下半图或重复 effect。
7. **Owner closure**：在 prepare、health check、switch、reconcile、dispose 和 Host restart 的每个边界制造失败，证明所有受管线程、进程树、端口、监听、临时文件、Provider 注册和 ClassLoader 都能归属或显式留下未清理 Evidence。
8. **不确定外部 effect**：在远端 dispatch 后、receipt 前崩溃，证明恢复不会盲目重放，也不会把“没有响应”谎称为“没有发生”。
9. **Capability 语义回归**：提供 schema/类型完全相同但失败语义、排序、隐私或副作用不同的 Provider，证明仅靠结构健康不能 Promote，受影响 Consumer 的旧行为会被检查。
10. **代价伪提升**：让 Candidate 用更多 token、重试、时间、模型或权限换成功率，证明报告会保留各维度与任务切片，不把预算差异包装成纯能力提升。
11. **身份保持**：在一个 Run 跨多个 Candidate Revision、多个 Branch 和多个执行进程时，证明它们仍归属同一 `AgentId`，同时各自谱系、Evidence 与 HEAD 不混淆。
12. **保护层越权**：让 Candidate 尝试修改 Governance、RuntimeCoordinator、Evaluator、pin 和 Artifact 身份规则，证明同层 Proposal 无法获得这些权力。
13. **pinned 故障**：让 pinned Provider 崩溃或触发安全隔离，证明 Host 能停止危险执行，同时 pin 本身仍存在且不会被 Agent 静默替换或取消。
14. **组合退化**：让两个单独无害的候选组合后产生冲突，证明完整组合被当作新 Candidate 评价，父候选的通过结论不会自动传递。
15. **前向恢复**：从旧 Revision 恢复时保留已发生的外部 effect、现行 pin、撤销和 writer authority，证明“恢复”不会复活旧权限或伪造世界回到过去。

## 5. Promote、Reject、Quarantine 与 Defer 的红队边界

**[原则防线]** 只要关键风险未解决，所有类别都必须阻止 Promote；区别在于该 Proposal 是否已经被证伪、是否仍值得隔离保留、还是仅缺可信证据。这里不定义状态机或自动阈值。

### 必须 Reject 当前 Proposal

- 试图修改/绕过 Evaluator、Ledger 权威、Governance、RuntimeCoordinator、pin 或权限原语；
- 伪造、选择性删除或把 Reflection 冒充为原始 Evidence；
- 直接或间接使用户 pin 失效；
- 绑定 stale HEAD/Epoch 后仍要求覆盖提交，或造成双 writer/部分图；
- 产生未授权副作用、绕过 ProcessSupervisor，或把未知 effect 谎报为未发生；
- 破坏 AgentId/父 Revision/Branch 的谱系一致性；
- 已在匹配条件下观察到不可接受的正确性、安全或旧能力回归。

Reject 只否定这次精确 Proposal，不删除历史，也不禁止基于其失败 Evidence 创建新的候选。

### 应 Quarantine，而不是进入 HEAD 或学习上下文

- Artifact 可能有研究价值，但来源、构建、权限、资源释放或行为语义尚不可信；
- 怀疑 Skill/Memory/Workflow 污染，尚不能界定影响谱系；
- 单体评价通过但组合效果冲突，或 evaluator 之间显著分歧；
- Candidate 已运行并留下未解决资源/外部 effect，需保留现场证据；
- 只通过 Candidate 自己生成的测试或 critic，缺乏独立结果。

Quarantine 的核心不是“稍后自动启用”，而是**保留材料但切断它对稳定 Runtime、未来 Reflection 和后代资产的权威影响**。

### 应 Defer，等待可信事实而不是猜测

- 所需 holdout、重复观察、任务切片、成本/延迟/资源数据尚不可得；
- 外部 Provider、依赖或评价环境临时不可用，无法形成匹配对照；
- dispatch 结果未知且远端没有可靠 reconciliation 证据；
- pinned 对象当前故障，而用户语义不允许系统自行替换；
- 评价版本、Artifact 或父 HEAD 已变化，需要重新绑定再判断。

Defer 不是通过，也不应让 Candidate 留在生产 action/learning surface 中等待“自然证明”。

**[来源事实，S4]** Continuity Kernel 把 Commit、Reject、Quarantine、Defer 作为不同 disposition，并强调只有 Commit 改变权威 HEAD；但它同时说明 evaluator 可能错误，协议不宣称语义正确。Anthias 可以借鉴这种证据姿态，不能把该新预印本当作现成正确实现。[论文](https://arxiv.org/abs/2608.11632)

## 6. 对第一轮主张的反例与修正

### 6.1 “完整 trajectory + provenance 足以支持学习”需要修正

第一轮正确地把原始事实与记忆/经验分开，但**完整记录只证明数据存在，不证明归因正确、记录未被候选选择性塑形，也不证明某条经验可以进入稳定学习上下文**。

修正为：事实必须不可变、来源可追；从事实到 Experience/Asset 的变换仍是 Candidate；而且必须记录该产物生成时看过哪些已接受与未接受资产。

### 6.2 “Branch 保留 stepping stone”需要增加污染隔离

DGM 式 archive 能保留低分中间节点，这是探索价值；但若 rejected/quarantined Branch 仍被稳定 Agent 检索为经验，它就不再只是离线 stepping stone，而会污染主谱系。

修正为：Branch 可以保留、复用和继续实验，但其 Artifact、Evidence 和学习影响必须带权威状态；“可见于研究者”不等于“可见于 Agent 的正常决策/蒸馏上下文”。

### 6.3 “每次编辑带可证伪预测”是必要但不充分

AHE 的 manifest 思路值得吸收：候选必须声明目标 Evidence、预期修复和可能回归。反例是同一研究的 regression blindness：候选对未来回归预测很弱。

修正为：候选声明帮助定义可证伪问题，但不能裁剪独立 evaluator 的回归范围；未被候选预测的任务和旧能力仍必须保留观察机会。

### 6.4 “回滚到旧 Revision”需要改成前向恢复语义

代码、Prompt、Skill 集和 Runtime Graph 可以回到旧结构；外部 effect、权限撤销、已传播经验、远端数据和用户新约束不能简单倒带。

修正为：旧 Revision 是恢复材料，不是当前世界的完整快照；恢复产生一个新的后继状态，保留当前保护字段和不可逆历史，并明确补偿/未知边界。

### 6.5 “独立 Evaluation”需要从角色独立升级为权力独立

另一个模型、另一个 subagent 或另一个 prompt 只能降低部分认知相关性。若它们读取候选提供的数据、共享可编辑 grader 或由同一 Proposal 控制预算，依然不独立。

修正为：独立性至少来自不可由 Candidate 修改的输入来源、规则/版本、权限、记录和最终 Promote authority；不同模型只是一项可选的异质证据。

### 6.6 “Capability 合同允许 Provider 替换”需要加入 Consumer 语义

合同能把依赖从具体实现中解耦，但名称、Java interface 或 JSON schema 不足以证明行为替换安全。

修正为：替换判断必须包括受影响 Consumer 与旧能力回归；安装、健康、合同解析、被选择、调用成功和跨任务收益继续保持不同事实。

### 6.7 “同一治理闭环”不等于相同信任

传统签名 Plugin、用户本地 Skill、远端 MCP 和 Agent 生成组件都应走 Anthias Governance；但统一流程若把它们全部放在同 JVM、授予相同权限或采用相同证据门槛，反而消除了来源差异。

修正为：统一的是 Proposal、权威激活、Owner/Scope、Evidence 和 pin 不变量；隔离起点、授权和所需证据仍由实际来源与副作用风险决定。

### 6.8 与第一轮 Evaluation 报告的交叉核对

[03-evaluation-safety-frontier.md](03-evaluation-safety-frontier.md) 已经从正向研究回答了评价证据层级、非确定性、长时程轨迹、Judge 盲区、职责分离、shadow/canary、供应链与回退边界。本文完整复核后没有发现需要推翻其核心结论的冲突；红队补充的是五个更容易在系统连接处发生的失败：

1. **Evaluation 之前的污染窗口**：03 说明 Candidate 不能自评，本文进一步要求未 Promote 产物不能先进入稳定 Agent 的学习/蒸馏上下文，否则后续独立 Evaluation 已经面对被污染的后代。
2. **图级用户约束**：03 规定 Agent 不能 Unpin，本文把攻击扩展到依赖、路由、权限、Owner 与同名替换造成的间接失效。
3. **长 Proposal 的并发窗口**：03 确认 RuntimeCoordinator 单写，本文补上从旧 Snapshot 产生候选、准备后再提交时仍需精确 HEAD/Epoch 与最终 freshness 复核。
4. **回退之后的世界**：03 已指出现实副作用不可自动撤销；本文进一步把未知 dispatch、后代经验污染和旧授权复活都纳入前向恢复的反例。
5. **执行拓扑不是身份谱系**：03 的 Evaluator、Runner、Governance 职责分离不能被解释为创建多个持续 Agent；这些角色和进程仍必须与 `AgentId` / Revision / Branch 语义分开。

**[红队推断]** 两份报告合起来给出的不是“多加几个 evaluator”，而是从资产进入学习上下文之前，到 Candidate 成为 HEAD、再到故障恢复之后的端到端权威边界。

## 7. Anthias 最值得保留的原则级防线

1. **稳定身份在候选之外**：`AgentId` 不因模型、分支、执行进程或角色变化而改变。
2. **事实层不可被学习层回写**：Reflection、Memory、Skill 与自模型投影都可以被 supersede，原始 Event/Artifact 不能被“更好的故事”覆盖。
3. **未 Promote 产物不进入稳定学习上下文**：它们可以被隔离实验和审计，但不能悄然成为未来经验的父输入。
4. **Candidate 不能扩张 authority**：新增 Tool/Skill/Plugin 只改变 action surface；真实副作用仍通过 Host 原语、权限、Scope 与 ProcessSupervisor。
5. **激活检查精确前驱与结果图**：RuntimeCoordinator 单写，最终提交前复核 Epoch/HEAD、pin、Owner closure、权限与完整依赖。
6. **Evaluation 的独立性首先是权力分离**：候选不能控制数据、grader、预算、记录、保护层和 Promote 决策。
7. **评价保留多维与切片证据**：不让平均成功率或单一 fitness 掩盖旧能力、安全、成本、时延和资源回归。
8. **回滚是带历史的前向恢复**：不复活旧授权，不重复未知 effect，不声称外部世界被倒带。
9. **pin 表达用户意图，不表达健康事实**：危险实例可以停；pin 只能由用户解除。
10. **失败和未知都必须诚实**：Reject、Quarantine、Defer 各自保留原因；没有足够证据时不把“不知道”折算成成功。

## 8. 仍无法由当前研究证明的边界

- 没有一组有限 Evaluation 能证明任意未来真实 Coding Task 上无回归。
- 没有只靠 Ledger 的方法能从观察相关性自动恢复真实因果。
- 没有协议级原子提交能撤销所有远端副作用或信息泄露。
- 没有单一 Capability schema 能表达并验证所有行为语义。
- 没有通过另一个 LLM 就自动获得的“独立裁判”。
- 没有无限自举的安全证明；保护层最终需要用户/Host 信任根。
- 没有当前一手证据证明“长期积累更多 Skill/组件”必然单调提升。
- 没有现有单一系统同时实证覆盖 Anthias 的稳定 AgentId、同 Run Runtime Mutation、Owner/Scope、跨任务资产演进、独立 Evaluation、Branch/HEAD 和不可绕过用户 pin。

因此，Anthias 合理的研究姿态不是声称“可证明安全自进化”，而是让每次变化都留下足以暴露错误的证据，并确保错误候选没有权把自己变成新的真相。

## 9. 一手来源与证据边界

| 来源 | 等级 | 本文只使用它支持什么 | 它没有证明什么 |
|---|---|---|---|
| [Agentic Harness Engineering](https://arxiv.org/abs/2604.25850) | S3，2026-04 预印本 | 组件/轨迹/决策可观察性、falsifiable manifest、只读 evaluator 边界；报告的 regression blindness | Anthias 式在线 Runtime、长期身份、pin 或生产安全 |
| [When Self-Evolution Backfires](https://arxiv.org/abs/2608.05810) | S4，2026-08-06 新预印本 | 在其 TB2 实验中的非单调 Skill 积累、后代污染、source-only rollback recovery gap、数据切分 | 所有 Agent 都存在同一 tipping point，或其门禁算法应被 Anthias 照搬 |
| [Beyond Memory: A Transactional Continuity Kernel](https://arxiv.org/abs/2608.11632) | S4，2026-08-12 新预印本 | 精确前驱、freshness、writer fencing、四类 disposition 与“协议不证明语义正确”的边界 | Anthias 已获得线性化、正确评价或可逆外部 effect |
| [Agent libOS](https://arxiv.org/abs/2606.03895) | S3，2026-06 预印本及公开实现 | action surface 与 authority 分离、受管 JIT/Skill、effect 不确定性和恢复边界 | 内核级沙箱、完整语义安全、对 Anthias 的直接适配 |
| [Darwin Gödel Machine（ICLR 2026）](https://iclr.cc/virtual/2026/poster/10007327) | S2，同行评审论文与公开项目 | archive/branch、经验评价和非贪心 stepping stone 的研究价值 | archive node 就是 Anthias 新 Agent，或 benchmark 收益等于长期安全 |
| [MCP 2026-07-28 Specification](https://modelcontextprotocol.io/specification/2026-07-28) | S1，官方规范 | MCP Tool/Resource/Prompt 与 Host 落实安全控制的协议边界 | MCP schema 能证明 Capability 语义、安全或 pin |
| [OSGi Core 8 Service Layer](https://docs.osgi.org/specification/osgi.core/8.0.0/framework.service.html) | S1，官方规范 | 服务注册归属 Bundle、停止时注销等生命周期语义 | 恶意代码隔离、Anthias Evolution 或外部副作用回滚 |
| [JDK 25 AutoCloseable](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/lang/AutoCloseable.html)、[JLS §12.7](https://docs.oracle.com/javase/specs/jls/se25/html/jls-12.html#jls-12.7)、[ProcessHandle](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/lang/ProcessHandle.html) | S1，官方 API/语言规范 | 局部关闭、类卸载条件、进程观察/终止边界 | 自动 Owner Graph、确定卸载、完整进程沙箱 |

### 研究限制

- 本报告没有运行 Anthias 代码、第三方 Agent、恶意组件、并发模型检查或真实模型 Evaluation；当前任务只授权研究与文档。
- 对项目的所有攻击路径都是原则级 falsification target，不是已发现的 Anthias 实现缺陷，因为仓库尚未在本报告中提供相应实现事实。
- 新近预印本尤其是 2026-08 两篇只提供反例与研究信号；在独立复现、同行评审和实际 Anthias 运行证据出现前，不应把其数值、门禁策略或状态模型固化为设计。
- 本报告没有确定 Stage、模块、表结构、阈值、算法、运行平台或隔离产品。

## 10. 最终红队判断

**[红队推断]** 第一轮研究给出的主线——稳定 AgentId、不可变事实、跨 Run Evidence、Candidate Revision、受治理的自写组件和独立 Evaluation——方向正确。真正需要收紧的不是“Agent 能不能改自己”，而是三个更具体的问题：

1. **候选何时有资格影响未来学习；**
2. **谁能定义成功并让候选成为权威；**
3. **结构回退之后，哪些副作用、授权和后代污染仍然存在。**

只要 Anthias 坚持“未验证候选不进入稳定学习上下文”“action surface 变化不隐式扩权”“评价/激活/用户 pin 位于候选之外”“回滚承认不可逆世界”，它就有机会把自进化从一次漂亮的自我叙述，约束成一系列可以被现实证伪的 Runtime Operation。
