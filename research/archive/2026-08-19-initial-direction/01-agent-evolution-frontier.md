# Anthias Agent 自进化前沿研究：持续身份、跨任务经验与可验证演化

> 研究时间边界：截至 2026-08-19
>
> 研究范围：长期运行 Agent 的 identity、episodic / semantic / procedural memory、trajectory / provenance、reflection、skill / component synthesis、online / offline evolution、agent self-model 及模型权重适配
>
> 证据范围：论文原文、作者或机构项目页、官方代码仓库；不使用媒体报道和二手博客作为技术结论依据

## 0. 阅读约定与结论摘要

本文用以下标签明确区分证据与判断：

- **来源事实**：一手来源直接报告的设计、实验或限制。
- **本文推断**：把来源机制与 Anthias 已确定语义进行比较后得到的判断。
- **建议**：面向 Anthias 的最小原则，不代表已确定的实现、Spec、Plan 或 Stage。

结论先行：

1. **持续身份不是长上下文，也不是某个模型实例的“人格连续性”。** 在 Anthias 中，`AgentId`、谱系和被提升的 `Revision` 才能构成持续身份；模型、Prompt、Skill、Plugin、工作流乃至记忆策略都应是可替换、可追踪的组成部分。
2. **原始痕迹、记忆、经验与能力必须分层。** Run 轨迹和 Artifact 是事实；episodic memory 是对事实的可检索组织；semantic memory 是带来源的归纳；procedural memory 是可执行的 Skill / Workflow / Tool / Plugin。把这些都叫“memory”会遮蔽真正发生了什么变化。
3. **检索和反思可以改善行为，但通常不等于 Agent 已经进化。** Reflexion、ExpeL、AWM 等主要在不更新模型权重的情况下，把历史反馈或抽象流程放回后续上下文。只有当改变成为可复用的能力结构，并经独立 Evaluation 后进入新的稳定 Revision，才符合 Anthias 的 Evolution 语义。
4. **当前最契合 Anthias 的前沿组合不是单篇论文，而是四类机制的受控组合：** 完整 trajectory / provenance；从多次 Run 中形成候选经验；将经验编译为 Skill、Workflow 或组件；用 Branch + 独立 Evaluation 选择是否 Promote。Voyager、SkillWeaver、DGM 分别为后三步提供了较强证据，但它们都缺少 Anthias 已明确的完整 Governance 与持续身份语义。
5. **最前沿工作正在从“让 Agent 管理记忆”转向“让 Agent 改变学习机制甚至模型权重”。** A-MEM、Memory-R1、MemEvolve、SEAL、Agent Lightning、LifeSkill 分别触及记忆组织、记忆操作策略、记忆架构、权重自适配、轨迹到训练的解耦、在线技能内化。它们适合作为 Anthias 的远期能力边界参考，不应被提前混进当前 Runtime 语义。
6. **自我评价不能成为晋升依据。** 反思适合产生 Hypothesis；执行结果、回归任务、资源消耗、安全约束和独立评估才适合产生 Evolution Evidence。这一点与 Anthias 已有 Governance 原则一致，也是 DGM、AlphaEvolve、LifeSkill 等工作真正有效的共同前提。

---

## 1. Anthias 问题重述与项目约束

### 1.1 Anthias 研究的不是普通 Coding Harness 增强

Anthias 的核心问题不是给固定 Agent 增加更多工具，而是：

> 一个拥有持续身份的 Agent，如何在真实任务中留下完整痕迹，从多次任务中发现自身摩擦，提出并试运行能力结构改变，再用独立证据决定这个改变是否成为新的稳定自己。

这要求同时处理四种连续性：

- **事实连续性**：过去发生过什么，不能因总结、反思或版本切换而被改写。
- **身份连续性**：模型、Prompt 或组件变化不自动创建另一个 Agent。
- **能力连续性**：每个时刻 Agent 实际拥有什么能力，可以被还原和比较。
- **因果连续性**：为什么改变、改变了什么、改变后发生了什么，必须能连回 Evidence。

### 1.2 已确定且本研究不得改写的边界

- `AgentId` 持续存在；LLM 只是可替换的 Cognitive Engine Provider。
- Runtime 变化由 Agent 提出 `Runtime Mutation Proposal`，由 Governance 决策，最终由 `RuntimeCoordinator` 单写执行。
- Self Model 来自 Runtime Graph、Ledger、Artifact、Metrics 和 Configuration，不来自隐藏思维链。
- 多次 Run 的高耗时、重试、失败和能力缺口可以汇聚为长期 Evidence。
- Agent 可以编写自己的 Plugin、Capability Provider、Tool、Skill、Workflow 和其他可演化组件，但生成物先是 Artifact 与 Proposal，不能直接修改受保护的 Harness Core。
- Evolution 需要独立 Evaluation；提出改变的 Agent 不能仅凭自身判断证明改变成功。
- Revision 表示同一 Agent 在某个时点具有持续语义的能力组合；Branch 表示同一谱系的候选方向，不应自动解释为多个 Agent。
- 传统 Plugin、MCP、Skill 与 Agent 自己生成的扩展都受同一 Runtime 生命周期和 Governance 约束；用户强制开启的能力不能被 Agent 自行解除。

### 1.3 本研究要回答的实际问题

1. “记得过去”与“从过去学会了新的做法”有什么严格区别？
2. 哪些跨任务痕迹值得保留为事实，哪些可以被压缩成经验或策略？
3. Reflection 如何只负责提出可证伪 Hypothesis，而不偷偷变成成功证明？
4. Agent 编写 Skill、Plugin 或其他组件时，怎样保持同一身份、完整谱系和可回滚性？
5. 在线适应、离线搜索、组件演化和模型训练如何共存而不混淆？
6. Self Model 应该表达哪些可验证事实，又应如何表达未知和不确定？

---

## 2. 前沿机制分类：先把“记忆”和“进化”拆开

CoALA 把 LLM 放在更大的 cognitive architecture 中，并区分工作记忆、长期记忆以及读取、推理、写入等内部动作；其 TMLR 版本把 Agent 看作由模型之外的记忆、动作空间和决策循环共同构成的系统。[来源：CoALA](https://arxiv.org/abs/2309.02427)

**本文推断：** 这个框架适合为 Anthias 建立共同词汇，但不足以直接给出 Anthias 的持续身份、不可变 Ledger、Revision 或 Governance。Anthias 需要在该认知分类之上增加运行时与演化语义。

| 层级 | 它改变什么 | 是否跨模型调用保留 | 是否改变可执行策略 / Action Space | 是否更新模型权重 | 在 Anthias 中更接近什么 |
| --- | --- | --- | --- | --- | --- |
| 当前上下文 / working memory | 当前轮可见信息 | 通常仅在 Run 或压缩链中 | 否 | 否 | Cognition 输入、Runtime Snapshot 的当前投影 |
| Retrieval / RAG | 从外部集合选择什么放入上下文 | 外部集合可持久 | 否；只改变当前可见证据 | 否 | 对 Ledger、Artifact、Experience、Skill Catalog 的读取路径 |
| Episodic memory | 某次任务、行动、结果和时间关系 | 是 | 间接 | 否 | Run 轨迹、Event、Artifact 的可检索视图 |
| Semantic memory | 从多个事实归纳出的知识、模式和判断 | 是 | 间接 | 否 | 带 provenance 的 Experience Candidate / 已验证经验 |
| Procedural memory | 如何执行：步骤、工作流、Skill、可执行代码 | 是 | 是或显著约束策略 | 通常否 | Skill、Workflow、Tool Policy、Plugin / Provider |
| 非参数策略学习 | Prompt、规则、路由、工作流或组件发生持久变化 | 是 | 是 | 否 | Candidate Revision 中的 Runtime Composition 改变 |
| 组件 / 架构演化 | Tool、API、Plugin、Agent scaffolding 或学习机制发生变化 | 是 | 是 | 否 | Agent 生成 Artifact → Proposal → Branch / Revision |
| 参数学习 | Cognitive Engine 的参数发生变化 | 是 | 是 | 是 | 新的或更新后的 Cognitive Engine Provider Revision |

### 2.1 几个必须避免的概念偷换

- **Retrieval 不是一种独立“记忆内容”。** 它是访问机制，可以检索 episodic、semantic 或 procedural memory。
- **压缩不是学习。** 压缩可能只是在有限上下文中保留信息；它既不保证归纳正确，也不产生新能力。
- **Reflection 文本不是 Evidence 本身。** 它是基于 Evidence 形成的解释或 Hypothesis，仍可能错误、迎合评价或遗漏因果变量。
- **“memory evolution”不必然是 Agent evolution。** A-MEM 所称的 evolution 是旧笔记上下文和属性随新记忆更新；这能改善组织，但没有自动改变 Agent 的可执行能力结构。[来源：A-MEM](https://arxiv.org/abs/2502.12110)
- **代码被生成不等于代码已成为 Agent 的一部分。** 只有经过构建、验证、Governance、挂载和 Evaluation，才可能成为 Candidate Revision 的组成。
- **模型微调不等于身份替换。** 对 Anthias 而言，它首先是 Cognitive Engine Provider 的参数变化；同一 Agent 是否采用它由 Revision 和 Governance 决定。

---

## 3. 代表性系统与可核验证据

### 3.1 持续身份与 Self Model：现有工作仍有明显空缺

**来源事实：** Generative Agents 使用完整经验记录、按相关性 / 新近性 / 重要性检索、递归 reflection 和 planning 来维持长期行为连贯；论文明确说 reflection 会形成关于自身和他人的高层推断。[来源：Generative Agents](https://arxiv.org/abs/2304.03442)

**来源事实：** MemGPT 用分层 memory tier 与“虚拟上下文管理”在有限上下文之外保存信息，并在多会话聊天中验证长期交互记忆；它的核心贡献是上下文分页与控制流，而不是一个可验证的身份谱系。[来源：MemGPT](https://arxiv.org/abs/2310.08560)

**本文推断：** 这两类系统证明了“跨会话可回忆”和“形成关于自己的文字归纳”是可行的，但没有证明：

- Agent 在更换模型、Prompt、工具、工作流和组件后仍由一个稳定 `AgentId` 统摄；
- 自我描述能与实际 Runtime Composition 保持权威一致；
- 自我描述错误时如何由事实投影纠正；
- 身份谱系如何在候选分支、拒绝和回滚之后保持可审计。

**建议：** Anthias 应继续把身份视为 Host 持有的稳定领域事实，把 Self Model 视为对 Runtime Graph、Ledger 和 Metrics 的查询投影。自然语言 reflection 可以解释这些事实，但不能成为 Runtime 权威。

### 3.2 Episodic memory 与 Reflection：能从失败中改善，但容易把解释当因果

**来源事实：** Reflexion 不更新模型权重，而是把环境或评价反馈转成语言反思，放入 episodic memory buffer，影响下一次尝试；论文在决策、编程和推理任务上报告了相对基线的改善。[来源：Reflexion](https://arxiv.org/abs/2303.11366)

**来源事实：** ExpeL 从一组训练任务中自主收集成功 / 失败经验，抽取自然语言 insight，并在推理时同时召回 insight 和过往 experience；作者强调这是不访问模型参数的 experiential learning。[来源：ExpeL](https://arxiv.org/abs/2308.10144)

**来源事实：** Generative Agents 的 reflection 把较低层 observation 递归综合成较高层 inference，并把 reflection 再写回 memory stream；消融显示 observation、planning、reflection 都影响其“believability”评价。[来源：Generative Agents](https://arxiv.org/abs/2304.03442)

**本文推断：** 这些工作共同证明“轨迹 → 语言归纳 → 后续上下文”是低成本学习路径，但它们没有自动解决以下问题：

- 反思是否准确归因，而不是只与失败相关；
- 多次任务中的相似失败是否来自同一根因；
- 反思在任务分布变化后是否仍然有效；
- 旧反思与新事实矛盾时谁有权更新或废弃它。

**与 Anthias 的适配：** Reflexion / ExpeL 最适合作为 `Reflection Case` 和 `Experience Candidate` 的生成机制，而不是直接生成 `REVISION_PROMOTED`。原始 Run、Tool Result、测试、耗时与错误仍应保留为 Evidence 来源。

### 3.3 从 Episode 抽象到 Workflow：跨任务改善的直接证据

**来源事实：** Agent Workflow Memory（AWM）从训练示例或在线测试经历中诱导可复用 workflow，再按需提供给后续任务；论文同时验证 offline 和 online 两种设置，并报告跨任务、跨网站、跨领域的泛化改善。[来源：AWM](https://arxiv.org/abs/2409.07429)

**来源事实：** AWM 的 workflow 会抽掉具体示例上下文，保留共用子程序；官方仓库也把 workflow 描述为从既有轨迹中归纳出的 reusable routine。[官方实现](https://github.com/zorazrw/agent-workflow-memory)

**本文推断：** AWM 是 Anthias “多次任务留下痕迹 → 发现重复耗时位置 → 形成可复用 Workflow”最直接的证据之一。它说明长期改善不必从模型权重训练开始。

**不适配点：** AWM 主要验证网页导航任务，并把 workflow 作为提示内容提供给模型。它没有处理 Runtime Provider 更换、组件生命周期、Revision 谱系和独立晋升。因此在 Anthias 中，workflow 应是有来源和版本的 Candidate，而不是静默覆盖的全局提示片段。

### 3.4 Procedural memory 与可执行 Skill：能力确实可以累积

**来源事实：** Voyager 使用自动课程、不断增长的可执行代码 Skill Library，以及结合环境反馈、执行错误和 self-verification 的迭代程序改进；模型通过黑盒调用工作，没有参数微调。[来源：Voyager](https://arxiv.org/abs/2305.16291)

**来源事实：** Voyager 只有在 self-verification 判定目标达成后才把程序加入 Skill Library；这些 Skill 可被检索、组合，并在新世界 / 新任务上复用。[来源：Voyager 方法正文](https://arxiv.org/abs/2305.16291)

**来源事实：** SkillWeaver 会自主探索网站、提出 Skill、把实践轨迹综合为 Python API，再通过静态检查、环境反馈、测试与调试进行 honing；每个 API 还记录适用前置状态和使用日志。论文报告这些 API 能迁移给更弱的模型 / Agent，并扩展其 Action Space。[来源：SkillWeaver](https://arxiv.org/abs/2504.07079)

**本文推断：** Voyager 证明“轨迹可以编译成可执行 procedural memory”；SkillWeaver 则进一步证明“Agent 可以根据经验生成轻量 API、测试和改进它，并把能力转移给不同模型”。这与 Anthias 允许 Agent 编写 Tool、Skill、Plugin 和组件的长期方向高度吻合。

**不适配点：**

- Voyager 的成功检查由另一个 GPT-4 critic 完成，仍不等同于 Anthias 所要求的、与提案方权力隔离的 Evaluation。
- SkillWeaver 在受控 WebArena 与选定真实网站上验证，API 的前置条件和选择错误仍是主要失败来源；其探索行为也需要额外副作用约束。
- 两者都没有 Stable Host / Dynamic Runtime 的生命周期模型，也没有 Agent HEAD 与 Candidate Revision 的区分。

**建议：** Anthias 可以学习“生成物是带适用条件和历史使用证据的可执行 Artifact”这一原则，但是否挂载、是否成为长期 Revision，仍由 Governance 和独立 Evaluation 决定。

### 3.5 Agent 架构与自身代码演化：从候选搜索到开放分支

**来源事实：** ADAS 的 Meta Agent Search 让 meta agent 根据不断增长的 discovery archive 编写新的 Agent 代码，搜索 Prompt、工具、工作流及其组合；论文报告一些设计可跨任务领域和模型迁移。[来源：ADAS](https://arxiv.org/abs/2408.08435)

**来源事实：** ADAS 官方仓库明确警告会执行不受信任的模型生成代码，可能产生破坏性行为。[官方实现与安全提示](https://github.com/ShengranHu/ADAS)

**来源事实：** SICA 消除了 meta-agent 与 target-agent 的区分，让 Coding Agent 修改自己的实现；论文在一个随机 SWE-bench Verified 子集上报告从 17% 到 53% 的提升，并明确把它描述为反思与代码更新驱动、非梯度的学习。[来源：SICA](https://arxiv.org/abs/2504.15228)

**来源事实：** DGM 从一个初始 Coding Agent 出发，维护所有发现版本的 archive；选择父节点、读取评价日志、提出并实现自修改，再用下游 Coding Benchmark 评分。低分中间节点可以成为后来高分节点的 stepping stone，因此 archive tree 优于只保留最新版本的 hill climbing。DGM 的 open-ended archive maintenance 和 parent selection 在论文实验中仍是固定、不可由 DGM 修改的部分。[来源：DGM](https://arxiv.org/abs/2505.22954)

**来源事实：** DGM v3 报告 SWE-bench 从 20.0% 到 50.0%、Polyglot 全集从 14.2% 到 30.7%，并说明实验使用 sandbox 与 human oversight；一次 SWE-bench 演化运行约需两周且 API 成本显著。[来源：DGM](https://arxiv.org/abs/2505.22954)

**本文推断：**

- ADAS 展示的是“外部 meta-agent 设计 Agent”；SICA 展示的是“同一执行体直接改自身代码”；DGM 展示的是“保留所有候选谱系的开放式自修改”。
- 对 Anthias 最有价值的是 DGM 的 archive / lineage / stepping-stone 结果，而不是把每个节点定义成新的 Agent。DGM 的每个 archive node 更适合映射为同一 `AgentId` 下的 `Revision`，父子边映射为 Branch / lineage。
- SICA 的直接 self-edit 与 Anthias 的 Governance、受保护 Harness Core、Single Writer 相冲突；其价值在于证明非参数代码更新可以带来可测改善，而不是证明可以安全地在线改写生产 Host。
- DGM 的 benchmark fitness 仍可能导致任务分布过拟合；它证明了“经验评价优于形式证明”的可行性，不证明任意真实任务上的永久改善。

### 3.6 AlphaEvolve：强 evaluator 能驱动代码演化，但不是持续身份 Agent

**来源事实：** AlphaEvolve 让 LLM 直接修改候选算法代码，使用一个或多个自动 evaluator 持续反馈，并通过 evolutionary database 决定哪些程序进入后续提示；Google DeepMind 报告它用于数据中心调度、硬件设计、AI 训练和数学算法发现。[来源：AlphaEvolve white paper](https://arxiv.org/abs/2506.13131)

**本文推断：** AlphaEvolve 的关键启发是：当目标可以自动、客观、重复评价时，代码候选的演化效率和可信度显著提高。但它演化的是问题解法 / 算法，不是一个具有 `AgentId`、长期经验和自我模型的 Runtime Entity。

**与 Anthias 的关系：** 它适合证明“Evaluator 是演化闭环核心”，不适合直接作为 Anthias 身份或记忆架构。对于难以自动判分的真实 Coding Task，Anthias 还需要多维 Evidence，而不能把单一 benchmark score 当作全部适应度。

### 3.7 从外部记忆到学习记忆操作策略

**来源事实：** A-MEM 在加入新记忆时生成带上下文、关键词和标签的 note，建立历史链接，并允许新记忆更新旧记忆的上下文表示与属性；其“memory evolution”指记忆网络组织不断细化。[来源：A-MEM](https://arxiv.org/abs/2502.12110)

**来源事实：** Memory-R1 分离 Memory Manager 与 Answer Agent；前者通过 RL 学习 `ADD / UPDATE / DELETE / NOOP`，后者预筛选和使用记忆。v5 报告仅用 152 个训练 QA 对，在 LoCoMo、MSC、LongMemEval 和 3B–14B 模型上进行验证。[来源：Memory-R1](https://arxiv.org/abs/2508.19828)

**来源事实：** MemEvolve 不只积累 experiential knowledge，还让 encode、store、retrieve、manage 等记忆架构本身参与 meta-evolution；v1 报告在四个 Agent benchmark 上产生跨任务、跨模型可迁移的记忆架构。[来源：MemEvolve](https://arxiv.org/abs/2512.18746)

**本文推断：** 这三项工作代表三个层级：

1. A-MEM：内容和关联会变；
2. Memory-R1：管理内容的操作策略通过训练而变；
3. MemEvolve：管理记忆的架构也成为演化对象。

这对 Anthias 很重要，因为 Memory 本身也是 Runtime Capability，长期可能拥有 Provider Revision。但它们也暴露一个冲突：如果 `UPDATE / DELETE` 直接作用于事实历史，就会破坏 Anthias 的不可变 Ledger。

**建议：** 删除、合并、改写只应作用于可重建的 memory projection / candidate knowledge；Ledger Event 与原始 Artifact 仍保持不可变。任何 semantic memory 更新都应能回指来源 Run，并允许在新 Evidence 出现时被 supersede，而不是伪装成过去从未发生。

### 3.8 模型权重层：真正参数学习是另一条演化轴

**来源事实：** SEAL 让模型生成自己的 finetuning data 与 update directive；这些 self-edit 可指定数据重组、超参数或工具，再通过 SFT 产生持久权重更新。系统用更新后模型的下游表现作为 RL reward，训练模型生成更有效的 self-edit。[来源：SEAL](https://arxiv.org/abs/2506.10943)

**来源事实：** Agent Lightning 把 Agent 执行与 RL 训练解耦，将一次执行表示为状态变化和 component invocation，再抽取 policy LLM 的 input、output、reward 形成训练 transition；其统一接口记录工具等非 LLM 组件造成的状态变化，并支持复杂工作流。[来源：Agent Lightning](https://arxiv.org/abs/2508.03680)

**来源事实：** LifeSkill 先用多个 skill-conditioned rollout 的 verifier 平均奖励训练 skill extractor，再移除显式 Skill 文本，用成功轨迹在线更新 policy，使行为从外部 Skill 内化到模型参数；v2 在 LifelongAgentBench 上报告平均提升 7 个绝对点。[来源：LifeSkill](https://arxiv.org/abs/2606.04815)

**本文推断：**

- SEAL 证明模型可以生成“怎样训练自己”的指令，但其持续对象是模型参数，不是完整 Agent 身份。
- Agent Lightning 证明真实 Agent trajectory 可以与训练系统解耦，这与 Anthias 的 Ledger / Artifact / Evidence 边界有潜在契合；但 RL 所需 transition 不是事实 Ledger 的替代品，而是从事实中导出的训练数据集。
- LifeSkill 展示了 external procedural memory 与 parametric policy 之间可以形成转换通道，同时也放大了灾难性遗忘、奖励污染、在线训练稳定性和回滚难题。

**建议：** Anthias 应把参数更新视为 Cognitive Engine Provider 的独立 Candidate Revision，并继续保留原 Provider、训练数据 lineage、评价任务和回滚路径。模型权重更新不能绕过 Runtime Governance，也不能自动改变 `AgentId`。

---

## 4. Online / Offline 演化应当如何与 Anthias 语义对齐

| 时间尺度 | 代表机制 | 来源中的典型例子 | Anthias 中的合理位置 | 主要风险 |
| --- | --- | --- | --- | --- |
| 单次 Cognition 内 | 上下文管理、检索、推理 | MemGPT、CoALA | 当前 Working Context；不形成 Revision | 信息遗漏、上下文污染 |
| 同一 Run 的多次尝试 | 反馈后 reflection / program repair | Reflexion、Voyager | Reflection Case；临时 adaptation；必要时在 Safe Point 试运行 Candidate | 把自评当成功、Action 执行中变化 |
| 多个 Run 之间 | 经验抽取、workflow / skill 复用 | ExpeL、AWM、SkillWeaver | 多 Run Evidence → Experience / Skill / Workflow Candidate | 相关性冒充因果、旧经验失效 |
| 离线候选搜索 | 架构、代码、组件分支搜索 | ADAS、SICA、DGM、AlphaEvolve | Revision / Branch 树与独立 Evaluation | benchmark 过拟合、破坏性生成代码、成本 |
| 训练期或部署期参数学习 | memory policy / LLM policy 更新 | Memory-R1、SEAL、Agent Lightning、LifeSkill | Cognitive Engine Provider Candidate；训练 Artifact 与 lineage | 灾难性遗忘、reward hacking、难以归因和回滚 |
| 学习机制本身演化 | memory architecture meta-evolution | MemEvolve | 远期的 Memory Provider / Runtime component Revision | 搜索空间膨胀、评价标准被共同改变 |

**本文推断：** “online”不能自动解释为“立即修改稳定 Agent”。在线只描述 Evidence 产生或 Candidate 试运行的时间。是否进入 Agent HEAD 仍然是另一项 Governance 决策。

**建议：** 每次演化声明都至少回答四个问题：

1. 改变对象是什么：context、memory content、retrieval policy、Skill、Workflow、Plugin、Runtime composition 还是 model weights？
2. 改变在哪个时间尺度发生：当前 action、当前 Run、跨 Run、离线 evaluation 还是训练周期？
3. 改变属于临时 adaptation、Candidate Revision 还是已 Promote Revision？
4. 成功判断来自谁、使用什么不可由候选自行改写的 Evidence？

---

## 5. 与 Anthias 的适配与不适配汇总

### 5.1 高度适配的机制

| 前沿机制 | 对 Anthias 的价值 | 对应现有概念 |
| --- | --- | --- |
| 完整 trajectory + 可检索 episode | 为跨任务分析保留原始事实，不依赖模型“记住” | Run、Ledger、Artifact |
| 多 episode 归纳 insight / workflow | 把重复摩擦变成可验证候选经验 | Friction Signal、Reflection Case、Experience Candidate |
| 可执行 Skill / API synthesis | 让“学会”真实改变 Action Space | Tool、Skill、Workflow、Plugin Artifact |
| archive / lineage / stepping stones | 避免只沿当前最佳版本贪心前进 | Revision、Branch、Agent HEAD |
| evaluator-grounded selection | 防止反思文本自证成功 | Evidence、Evaluation、Promote / Reject |
| execution / training disaggregation | 允许未来从真实 Run 训练模型而不侵入 Agent Loop | Ledger / Artifact → training dataset；Cognitive Engine Provider |

### 5.2 需要改写后才能适配的机制

| 来源做法 | 与 Anthias 的冲突 | 适配方向（原则级） |
| --- | --- | --- |
| DGM 把 archive node 称为不同 coding agent | Anthias 强调一个持续 Agent 身份 | 节点解释为同一 `AgentId` 的 Revision / Branch |
| SICA 直接编辑自身 Agent code | 绕过 Governance、Stable Host 和受保护 Core | 生成代码只作为 Candidate Artifact，在隔离环境构建和评价 |
| Voyager 使用模型 critic 完成 self-verification | 提案者与证明者没有充分权力隔离 | critic 可生成信号，但 Promotion 必须依赖独立受保护 Evaluation |
| A-MEM / Memory-R1 更新或删除记忆 | 若记忆是事实，会破坏不可变历史 | 只修改可重建 Projection；保留原 Event / Artifact 与 supersession 链 |
| AWM 把 workflow 直接放回 Prompt | 缺少版本、适用范围与生命周期 | workflow 作为有 provenance 的版本化 Candidate Capability |
| SEAL / LifeSkill 在线更新权重 | 难以归因、回滚，可能遗忘旧能力 | 模型更新成为单独 Provider Revision，保留父版本与评价证据 |
| MemEvolve 让 memory architecture 参与演化 | 学习对象与评价方式同时变化会降低可解释性 | Evaluation、Governance、Ledger 继续保持受保护和独立 |

### 5.3 不应从这些工作推出的结论

- 不能因为某论文在一个 benchmark 上提升，就认定其机制对真实 Coding Task 长期有效。
- 不能因为模型写出了反思，就认定它找到了根因。
- 不能因为代码通过一次自测，就认定它能进入稳定 Runtime。
- 不能因为一个 Skill 被多次检索，就认定它产生了因果收益；也可能只是任务类型相关。
- 不能因为更换模型后效果仍提高，就认定 Agent 身份问题已经被解决。
- 不能因为 memory system 会“evolve”，就认定 Runtime Composition 或模型策略已经进化。
- 不能因为产生了多个候选分支，就把一个 Agent 的可能未来解释成 Multi-Agent Society。

---

## 6. 推荐给 Anthias 的最小原则（非详细设计）

以下只给出应长期保持的原则，不确定阈值、Schema、模块布局、算法或 Stage。

### 原则 1：身份在模型之外，变化发生在身份之下

`AgentId` 由稳定系统持有；模型、记忆、Prompt、Skill、Plugin、Workflow 和 Runtime Composition 都有自己的版本与谱系。大幅改变也先形成 Revision / Branch，而不是默认生成新 Agent。

### 原则 2：事实层不可变，学习层可修订

Run Event 与原始 Artifact 是事实；episodic index、semantic insight、procedural skill 和 self-model summary 都是可重建投影。新的归纳可以 supersede 旧归纳，但不能回写历史，让旧事实消失。

### 原则 3：每个学习产物都必须带 provenance

Reflection、Experience、Workflow、Skill、组件源码、模型训练数据都应能回到产生它的 Run、Evidence、Revision 和评价结果。无法追溯来源的“经验”不应进入稳定能力。

### 原则 4：Reflection 只产生 Hypothesis

模型可以解释“为什么慢”“可能缺什么能力”“建议怎样改变”，但这些输出仍是待证伪判断。成功与否由任务结果、测试、回归、安全、成本、时延和独立 evaluator 等外部 Evidence 决定。

### 原则 5：先区分临时适应与长期演化

当前 Run 挂载临时能力、改变检索或尝试 Candidate，并不自动改变 Agent HEAD。只有跨任务价值经过评价后才 Promote；失败 Candidate 和中间 stepping stone 仍保留谱系与结果。

### 原则 6：可执行经验必须先成为 Candidate Artifact

Agent 生成 Skill、Workflow、Tool、Plugin 或模型 update 时，生成物先脱离当前稳定 Runtime，接受构建、静态 / 动态验证、资源边界和 Governance。生成者不能直接写入受保护 Core，也不能自行完成 Promotion。

### 原则 7：评价标准与被评价对象分离

Candidate 不得修改自己的评分规则、Ledger 或 Governance。即便未来 Evaluation 本身可演化，也必须作为独立受保护对象，在更高层评价中产生版本，而不能与被评价 Candidate 同时无约束改变。

### 原则 8：演化收益必须覆盖回归与代价

“更好”不能只表示成功率更高。还应保留至少任务正确性、失败模式、成本、时延、资源、副作用和旧能力回归等证据维度。具体指标等真实 Feature 出现后再确定。

### 原则 9：Self Model 是可查询事实，不是自由叙事

Self Model 首先回答当前 Runtime 实际组成、可替换项、保护项、历史 Mutation、已知 Evidence 和未知项。语言模型可以逐层解释，但不得把未观察到的内部能力描述成事实。

### 原则 10：参数训练保持为可选的远期演化轴

Anthias 的核心价值不依赖自行训练模型。若未来吸收 SEAL、Agent Lightning 或 LifeSkill 类机制，模型权重应作为 Cognitive Engine Provider Revision 被管理，不能吞并 Runtime、Memory、Ledger 和 Governance 的职责。

---

## 7. 仍不确定且必须由真实开发继续回答的问题

1. **身份同一性边界：** 当模型、主要 Skill、工作流和 Memory Provider 都变化后，什么条件下仍是同一 Agent，什么条件下应派生新 Agent？现有来源没有给出适合 Anthias 的实证答案。
2. **经验的失效与遗忘：** 不改写 Ledger 的前提下，如何让过时 semantic / procedural memory 降权、隔离或 supersede？
3. **多因素因果归因：** 一个 Revision 同时改变 Prompt、Skill 和 Provider 时，怎样判断哪个改变贡献了收益？
4. **任务分布漂移：** 历史上有效的 workflow / component 在仓库、语言、模型或工具版本变化后，何时需要重新评价？
5. **评价被博弈：** Candidate 如何避免针对固定 benchmark、测试或 cost metric 过拟合，甚至主动操纵 evaluator 输入？
6. **分支合并：** 两个 Branch 分别改善不同能力时，合并是否产生交互回归；谱系和 Evidence 如何表达？
7. **长期记忆污染：** 错误、恶意或偶然成功的轨迹怎样避免被抽象成稳定经验，同时保留事实可审计性？
8. **用户约束与自进化冲突：** 用户强制开启的 Plugin / MCP / Skill 造成可测摩擦时，Agent 可以改变哪些相邻策略，而不间接使其失效？
9. **模型权重归属：** Provider 微调来自某一 Agent 的私有经历时，它是该 Agent 的私有 Revision、可共享组件，还是新的模型资产？
10. **隐私与数据权利：** 跨任务 trajectory 被用于经验抽取、组件生成或训练时，哪些内容允许长期保留和迁移？
11. **在线训练安全：** 部署期参数更新能否在不破坏可重复性、回滚和服务稳定性的条件下发生？当前前沿结果仍主要来自受控 benchmark。
12. **Self Model 的可信度：** Runtime Graph 能描述“有什么”，但 Agent 对自身能力上限、未知项和失败概率如何校准，仍缺少成熟统一方案。

---

## 8. 证据边界

- 本报告只把来源作者直接报告的机制和实验视为来源事实；对 Anthias 的映射均标为本文推断或建议。
- 多数代表性实验来自 Minecraft、网页导航、问答、数学或固定 Coding Benchmark，不等于真实长期运行 Coding Agent 的部署证据。
- SICA、DGM、SEAL、Agent Lightning、Memory-R1、MemEvolve、LifeSkill 等较新工作中，多项仍以 arXiv preprint 为主要公开载体；报告没有把尚未独立复现的数字当作普遍定律。
- 本次检索没有找到一个一手系统同时验证 Anthias 所要求的稳定 `AgentId`、不可变因果 Ledger、Runtime 自省、动态组件生命周期、候选分支、独立 Evaluation 与用户强制约束。Anthias 的组合仍具有独立研究价值。
- 本报告没有选择存储实现、数据 Schema、模型、阈值、Stage 或具体演化算法。

---

## 9. 一手来源表

| # | 标题 | 发布方 / 作者机构 | 日期 / 版本 | URL | 支持的具体主张 |
| --- | --- | --- | --- | --- | --- |
| 1 | Cognitive Architectures for Language Agents | Princeton；TMLR | arXiv v3，2024-03-15，TMLR camera-ready | https://arxiv.org/abs/2309.02427 | LLM 是更大认知架构的一部分；区分 memory、internal / external action、retrieval、reasoning、learning |
| 2 | Generative Agents: Interactive Simulacra of Human Behavior | Stanford / Google；UIST 2023 | arXiv v2，2023-08-06 | https://arxiv.org/abs/2304.03442 | 完整经验流、检索、递归 reflection 与 planning 支持长期行为连贯；reflection 可形成高层自我推断 |
| 3 | Reflexion: Language Agents with Verbal Reinforcement Learning | Princeton 等 | arXiv v4，2023-10-10 | https://arxiv.org/abs/2303.11366 | 通过语言反馈和 episodic reflection 改善后续尝试，不更新模型权重 |
| 4 | Voyager: An Open-Ended Embodied Agent with Large Language Models | NVIDIA / Caltech / UT Austin 等 | arXiv v2，2023-10-19 | https://arxiv.org/abs/2305.16291 | 自动课程、可执行 Skill Library、环境反馈与迭代程序改进支持非参数 lifelong learning |
| 5 | ExpeL: LLM Agents Are Experiential Learners | Tsinghua 等；AAAI 2024 | arXiv v3，2024-12-20 | https://arxiv.org/abs/2308.10144 | 从成功 / 失败任务抽取自然语言 insight，在后续任务召回 experience 与 insight，无需参数更新 |
| 6 | MemGPT: Towards LLMs as Operating Systems | UC Berkeley | arXiv v2，2024-02-12 | https://arxiv.org/abs/2310.08560 | 分层 memory tier 与虚拟上下文管理支持超出上下文窗口的文档和多会话记忆 |
| 7 | Agent Workflow Memory | CMU 等 | arXiv v1，2024-09-11 | https://arxiv.org/abs/2409.07429 | 从离线示例或在线经历诱导 reusable workflow，并在跨任务 / 网站 / 领域设置中复用 |
| 8 | Agent Workflow Memory official implementation | 论文作者官方仓库 | 仓库当前公开版本；论文 2024 | https://github.com/zorazrw/agent-workflow-memory | 官方实现确认 workflow 是抽去实例上下文的可复用子程序，并区分 online / offline |
| 9 | Automated Design of Agentic Systems | UBC / Vector / Sakana AI；ICLR 2025 | arXiv v2，2025-03-02 | https://arxiv.org/abs/2408.08435 | Meta Agent Search 从 discovery archive 编写新的 Agent 代码，搜索 Prompt、工具、工作流与组合 |
| 10 | ADAS official implementation | 论文作者官方仓库 | 仓库当前公开版本；ICLR 2025 | https://github.com/ShengranHu/ADAS | 官方安全提示：执行模型生成代码具有潜在破坏性，需视为不受信任代码 |
| 11 | A-MEM: Agentic Memory for LLM Agents | Rutgers / OPPO 等；NeurIPS 2025 | arXiv v11，2025-10-08 | https://arxiv.org/abs/2502.12110 | 新记忆可建立动态链接并更新旧记忆的上下文属性；这里的 evolution 是 memory organization evolution |
| 12 | SkillWeaver: Web Agents can Self-Improve by Discovering and Honing Skills | Ohio State / CMU / Amazon 等 | arXiv v1，2025-04-09 | https://arxiv.org/abs/2504.07079 | Agent 从实践轨迹生成 Python API，经测试和调试 honing；API 可迁移并扩展其他 Agent 的 Action Space |
| 13 | A Self-Improving Coding Agent | University of Bristol 等 | arXiv v2，2025-05-16 | https://arxiv.org/abs/2504.15228 | Coding Agent 可反思并编辑自身 scaffolding，在选定 benchmark 上产生非梯度性能改善 |
| 14 | Darwin Gödel Machine: Open-Ended Evolution of Self-Improving Agents | Sakana AI / UBC / Vector | arXiv v3，2026-03-12 | https://arxiv.org/abs/2505.22954 | 自修改 + benchmark evaluation + archive tree；保留低分 stepping stone 和多条谱系优于仅沿最新版本搜索 |
| 15 | AlphaEvolve: A coding agent for scientific and algorithmic discovery | Google DeepMind | arXiv v1 / white paper，2025-06-16 | https://arxiv.org/abs/2506.13131 | LLM 候选代码与自动 evaluator 的 evolutionary loop 可发现和部署可验证算法改进 |
| 16 | Self-Adapting Language Models | MIT CSAIL | arXiv v2，2025-09-18 | https://arxiv.org/abs/2506.10943 | 模型生成 finetuning data 和 update directive，经 SFT 持久更新权重，并用下游表现训练 self-edit policy |
| 17 | Agent Lightning: Train ANY AI Agents with Reinforcement Learning | Microsoft Research | arXiv v1，2025-08-05 | https://arxiv.org/abs/2508.03680 | Agent execution 与 RL training 解耦；从组件调用和状态变化轨迹提取训练 transition |
| 18 | Memory-R1: Enhancing Large Language Model Agents to Manage and Utilize Memories via Reinforcement Learning | TUM / LMU / Edinburgh 等 | arXiv v5，2026-01-14 | https://arxiv.org/abs/2508.19828 | RL 训练 Memory Manager 执行 ADD / UPDATE / DELETE / NOOP，并训练 Answer Agent 选择和使用记忆 |
| 19 | MemEvolve: Meta-Evolution of Agent Memory Systems | EvolveLab 团队 | arXiv v1，2025-12-21 | https://arxiv.org/abs/2512.18746 | 同时演化 experiential knowledge 与 encode / store / retrieve / manage 记忆架构 |
| 20 | Learning While Acting: A Skill-Enhanced Test-Time Co-Evolution Framework for Online Lifelong Learning Agents | Fudan 等 | arXiv v2，2026-06-19 | https://arxiv.org/abs/2606.04815 | verifier-guided Skill 学习与在线参数内化把外部 Skill 经验转为 policy weight 更新 |

---

## 10. 对 Anthias 的最终判断

**本文推断：** 截至 2026-08-19，单独依赖“更长上下文”“向量库”“反思 Prompt”“自动写 Skill”或“让 Agent 改自己代码”中的任何一种，都不足以形成 Anthias 所定义的自进化。

更符合实际证据的 Anthias 演化链是：

```text
真实 Run 与不可变痕迹
        ↓
跨 Run 聚合的摩擦与 Evidence
        ↓
可证伪的 Reflection / Hypothesis
        ↓
Experience、Workflow、Skill、组件或 Provider Candidate
        ↓
受 Governance 控制的 Revision / Branch
        ↓
与提案权力隔离的 Evaluation
        ↓
Promote / Reject / 保留 stepping stone
```

这条链同时吸收了 Reflexion / ExpeL 的经验归纳、AWM 的跨任务 Workflow、Voyager / SkillWeaver 的可执行 Skill、DGM 的分支谱系、AlphaEvolve 的 evaluator-driven search，以及 Agent Lightning / SEAL / LifeSkill 对未来参数学习的启示；但它保留了 Anthias 自己最关键、也是现有单一系统尚未完整验证的差异：

> **同一持续 Agent 的每一步改变，都由可追溯事实驱动，以 Candidate 形式发生，并由独立证据决定是否成为新的稳定自己。**
