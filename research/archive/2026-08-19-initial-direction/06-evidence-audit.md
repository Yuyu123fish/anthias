# Anthias 前沿研究证据与来源审计（01—05）

> 审计截止：2026-08-19
>
> 审计对象：[01-agent-evolution-frontier.md](01-agent-evolution-frontier.md)、[02-runtime-extensibility-governance.md](02-runtime-extensibility-governance.md)、[03-evaluation-safety-frontier.md](03-evaluation-safety-frontier.md)、[04-anthias-fit-review.md](04-anthias-fit-review.md)、[05-evolution-red-team.md](05-evolution-red-team.md)
>
> 文档性质：证据与主张边界审计，不是新的架构、Spec、Plan、Stage 或实现方案

## 0. 审计结论

五份报告整体保持了较好的证据纪律：多数段落已经区分来源事实、项目约束、研究推断和暂缓项，也反复声明 benchmark、软件发布实践和协议规范不能直接证明 Anthias 的长期安全性。

本轮没有发现足以推翻研究主线的一手反证，但发现六类需要在统一总报告中继续收窄的表述：

1. **benchmark 增益不能外推为长期 Agent 演化成立。** DGM、SICA、AHE、Mem2Evolve、MemEvolve 等结果只支持特定模型、任务、预算和实验设置下的作者报告。
2. **规范只能证明规范自身的公开语义。** MCP、JDK、OSGi、WASI、SLSA、in-toto、TUF 等不能证明 Anthias 的映射已经正确，更不能证明 Agent 生成组件在运行时安全。
3. **软件发布类比不是 Agent 实证。** canary、rollback、separation of duties 和供应链 provenance 可以提供控制原则，不能被写成 Agent Evolution 的已验证机制。
4. **2026 年新预印本不能冻结方案。** AHE、Agent libOS、Continuity Kernel、When Self-Evolution Backfires、SpecBench、AJ-Bench 和 Causal Agent Replay 目前只能提供问题定义、反例或候选方法。
5. **“未发现一个完整系统”必须带检索范围。** 可保留的表述是“在本次审查的一手来源中未发现”，不能升级为世界唯一、世界首创或完备性声明。
6. **部分来源状态需要更新。** 截至截止日，DGM 已有 ICLR 2026 正式页面，MemEvolve 已进入 ICML 2026 / PMLR 306；A-MEM 是 NeurIPS 2025，Mem2Evolve 是 ACL 2026。它们不应再与所有工作一起笼统标成“主要为预印本”，但同行评审也不扩大其 benchmark 适用范围。

最终可高置信保留的是一组**边界结论**，而不是“最佳架构已经被论文证明”：Anthias 的产品语义由项目文档决定；外部研究能支持若干局部机制的可行性或风险存在；候选生成、权威激活、独立评价、长期身份和用户约束之间的组合仍是 Anthias 的研究综合判断。

## 1. 审计方法与证据分类

### 1.1 审计单位

本轮以“可被外部核对的关键主张”为单位，检查：

- 链接是否指向论文、官方规范、官方源码/仓库或机构一手页面；
- 来源是否直接包含所引用的机制、数字、限制或版本；
- 报告是否把作者报告、项目约束和本文推断混写；
- benchmark 结果是否被外推为长时程、生产、安全或因果结论；
- 软件交付、安全控制或供应链规范是否只被作为类比；
- 新预印本是否被提前当成成熟共识；
- “没有单一系统”等检索结论是否保留了范围限定。

“有一手链接”不等于“主张成立”。本审计同时检查来源类型、正文支持范围和从来源到 Anthias 结论之间的推理跨度。

### 1.2 证据类别

| 代码 | 类别 | 可以支持 | 不能自动支持 |
| --- | --- | --- | --- |
| **P** | Anthias 项目权威：项目定义、`AGENTS.md`、技术基线 | 当前产品语义、协作约束和架构不变量 | 已实现、有效、安全或优于其他方案 |
| **PR** | 同行评审的一手论文/正式会议版本 | 给定实验、数据、模型和评价设置中的机制与结果 | 长期生产有效性、跨域泛化、Anthias 整体正确性 |
| **NS** | 官方规范、API、源码、协议或标准 | 该技术自身的公开语义、版本和保证边界 | Anthias 集成效果、行为安全或演化收益 |
| **OP** | 机构一手产品研究、部署复盘或工程实践 | 该机构在其系统与环境中的观察、流程和已披露限制 | 无对照的因果结论、普遍最佳实践、对 Anthias 的直接复现 |
| **WD** | 官方工作草案、SEP、工作组章程或在审实现 | 当前提案方向和正在讨论的边界 | 已批准标准、稳定互操作承诺 |
| **PP** | 预印本、早期原型或未确认同行评审版本 | 新问题、作者报告的早期实验、反例线索 | 成熟共识、独立复现、应立即冻结的核心机制 |
| **I** | 本组研究推断、工程类比或适配判断 | 将多个有限证据与 Anthias 约束连接起来的候选解释 | 外部来源直接证明了该结论 |

这些类别不是一条简单的高低排序。`NS` 对“JDK 或 MCP 定义了什么”最权威，`PR` 对“某机制在给定 benchmark 中是否出现效果”更有意义，`P` 则始终决定 Anthias 当前要构建什么。

### 1.3 支持状态

- **直接支持**：来源正文直接包含该限定主张。
- **部分支持**：来源支持局部机制或特定实验，但 Anthias 表述仍包含额外推断。
- **仅类比**：来源属于相邻领域，只能帮助识别控制原则。
- **不支持当前强度**：来源存在，但不足以支持报告中的因果、普遍性或安全强度。
- **未逐页复核**：本轮只确认链接结构、来源身份或报告内的引用关系，没有重新打开正文验证每个细节。

## 2. 实际核对范围与可访问性

### 2.1 本轮实际打开并核对正文或官方摘要的来源

本轮实际核对了下列高风险或高影响一手来源，而不只是检查 URL 形状：

- [DGM arXiv v3](https://arxiv.org/abs/2505.22954) 与 [ICLR 2026 正式页面](https://iclr.cc/virtual/2026/poster/10007327)：archive、20.0%→50.0%、14.2%→30.7%、sandbox/human oversight 及会议状态；ICLR 页面正文受抓取限制，但官方页面身份和摘要可由检索结果核对。
- [SICA](https://arxiv.org/abs/2504.15228)：随机 SWE-bench Verified 子集上的 17%→53% 是作者报告，所引用版本仍是预印本。
- [Mem2Evolve](https://aclanthology.org/2026.acl-long.952/)：ACL 2026 正式论文及 18.53%、11.80%、6.46% 的作者报告。
- [A-MEM](https://proceedings.neurips.cc/paper_files/paper/2025/hash/19909c36f51abc4856b4560aff3d36d6-Abstract-Conference.html)：NeurIPS 2025 Main Conference Track 状态及 memory organization 主张。
- [MemEvolve](https://openreview.net/pdf?id=qpkG0eKx4v)：正文标注 ICML 2026、PMLR 306，并报告四个 agentic benchmark 中的结果。
- [Agentic Harness Engineering](https://arxiv.org/html/2604.25850v4)：单次研究 campaign、任务规模、结果、可证伪 manifest、回归预测 precision 11.8% / recall 11.1% 及作者限制。
- [When Self-Evolution Backfires](https://arxiv.org/abs/2608.05810)：Event-50 / Terminal-Bench 2 设置、资产数量、门禁结果和 source-only rollback 的有限恢复。
- [Continuity Kernel](https://arxiv.org/abs/2608.11632)：精确前驱、四类 disposition、有界状态模型，以及论文自己声明的语义与物理实现限制。
- [Agent libOS](https://arxiv.org/abs/2606.03895)：action surface / authority 分离、原型测试与沙箱、外部副作用和 planner 能力限制。
- [MCP 2026-07-28 规范](https://modelcontextprotocol.io/specification/2026-07-28)、[官方版本说明](https://blog.modelcontextprotocol.io/posts/2026-07-28/) 与 [Skills over MCP 工作组](https://modelcontextprotocol.io/community/working-groups/skills-over-mcp)：协议版本、无状态 core、Tools/Resources/Prompts 以及 SEP/参考实现仍在审的状态。
- [OpenAI 长时程模型安全复盘](https://openai.com/index/safety-alignment-long-horizon-models/) 与 [Anthropic Agent eval 工程文章](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)：各自一手部署/工程观察及局限。
- [JLS 25 §12.7](https://docs.oracle.com/javase/specs/jls/se25/html/jls-12.html#jls-12.7)：类和接口卸载与 defining class loader 可回收之间的规范条件。

### 2.2 只做结构审查或未能完整打开的来源

- 01—05 的链接域名和来源表结构已整体检查，但本轮**没有重新逐页打开全部来源**。OSGi、NIST、Google SRE、Argo Rollouts、SLSA、in-toto、TUF、ToolSandbox、AgentDojo、Agent Security Bench 等仍依赖原报告中的一手引用与限定语句；它们不应在总报告中被描述为“已由本轮逐条复核正文”。
- OpenJDK JEP 486 官方页面在本轮抓取中返回访问限制；因此本审计只确认其官方 URL 和报告中的来源类型，没有把页面正文算作本轮实际核对证据。
- 对 arXiv 工作核对的是截止日可见版本；以后替换版本、改变作者结论或获得正式录用，不会自动回写本审计。
- 本轮未下载并运行论文代码、复现实验、重算置信区间或验证数据污染；所有论文数字仍是作者报告，不是 Anthias 团队独立复现。

## 3. 01：Agent Evolution 前沿报告抽查

| 关键主张 | 直接来源 / 类别 | 审计判断 | 总报告需要保留的边界 |
| --- | --- | --- | --- |
| 模型只是更大认知架构中的一部分 | CoALA 等正式研究，**PR** | **直接支持局部概念** | 不能据此推出稳定 `AgentId`；后者是 Anthias 的 **P** 与 **I** |
| Generative Agents 保存“完整经验流”并做 reflection | UIST 2023 论文，**PR** | **部分支持** | 应写成“在其模拟环境中维护 memory stream”；不能类比成完整运行时 Ledger、权限审计或所有副作用记录 |
| SICA 从 17% 提升到 53% | [SICA](https://arxiv.org/abs/2504.15228)，**PP** | **直接支持该论文设置** | 必须同时写随机子集、作者报告、非生产设置；不能称为通用自进化收益 |
| DGM 从 20.0%→50.0%、14.2%→30.7%，archive 保留 stepping stone | [DGM](https://arxiv.org/abs/2505.22954) / [ICLR 2026](https://iclr.cc/virtual/2026/poster/10007327)，**PR** | **直接支持实验与 archive** | benchmark fitness 不证明长期安全、真实任务永久改善或 Anthias 的身份/治理语义 |
| DGM 证明“经验评价优于形式证明” | DGM，**PR + I** | **不支持当前强度** | 可改成“DGM 展示了经验 benchmark evaluation 能在该搜索设置中驱动改进；没有比较并证明其普遍优于形式证明” |
| DGM archive 可映射为同一 Agent 的 Revision / Branch | DGM + Anthias 项目定义，**I + P** | **合理适配，不是来源事实** | archive node 在论文中是候选 agent/scaffold，不直接具有 Anthias 的持续 AgentId |
| AlphaEvolve 说明 evaluator-driven evolutionary search 可产生可验证算法改进 | [AlphaEvolve 白皮书](https://arxiv.org/abs/2506.13131)，**OP** | **直接支持其科学/算法任务中的作者报告** | 演化的是候选问题解法，不是持续 Agent 身份；高度可量化 evaluator 也不代表开放 Coding Task 的评价条件 |
| A-MEM 与 MemEvolve 表明 memory organization / architecture 可变化 | [A-MEM](https://proceedings.neurips.cc/paper_files/paper/2025/hash/19909c36f51abc4856b4560aff3d36d6-Abstract-Conference.html)、[MemEvolve](https://openreview.net/pdf?id=qpkG0eKx4v)，**PR** | **直接支持各自 benchmark 内的机制** | 不能推出不可变 Ledger、在线 Runtime Mutation、Pin 或长期因果正确性；来源状态应更新为正式会议版本 |
| 本次检索未找到同时覆盖全部 Anthias 不变量的系统 | 本轮来源集合，**I** | **可保留但不可外扩** | 固定写成“在本次审查的一手来源中未发现”；不能写世界首创、唯一或不可能存在 |

## 4. 02：Runtime 扩展与 Governance 报告抽查

| 关键主张 | 直接来源 / 类别 | 审计判断 | 总报告需要保留的边界 |
| --- | --- | --- | --- |
| MCP 2026-07-28 core 是无状态请求，Server 暴露 Resources / Prompts / Tools | [MCP 规范](https://modelcontextprotocol.io/specification/2026-07-28) 与[官方说明](https://blog.modelcontextprotocol.io/posts/2026-07-28/)，**NS** | **直接支持** | 只证明该版本协议；不能推出 Anthias 的会话、身份、Pin、Owner 或 Capability 语义 |
| Skills over MCP 正在形成发现与获取机制 | [官方工作组](https://modelcontextprotocol.io/community/working-groups/skills-over-mcp)，**WD** | **直接支持当前草案状态** | SEP-2640 和参考实现仍在审；不得称为已批准、唯一或稳定 Skill 标准 |
| JDK 类卸载依赖 defining ClassLoader 可回收，`AutoCloseable`/`ProcessHandle` 保证有限 | Oracle JLS / API，**NS** | **直接支持语言/API 边界** | 不能推出恶意代码隔离、确定卸载、Owner Graph 或完整进程树治理 |
| OSGi 生命周期、WASI/WIT 合同可作为动态扩展构件 | 官方规范，**NS + I** | **规范语义可保留，适配仅为类比** | 规范没有验证 Anthias Evolution、外部副作用回退或用户 Pin |
| SLSA、in-toto、Sigstore、TUF 可提高可验证来源与更新完整性 | 官方规范，**NS** | **直接支持 provenance / update 风险控制** | 签名、attestation 和版本可信不证明组件行为安全、权限合理或对任务有益 |
| Agent 生成代码默认不进入 Host JVM | 风险分析，**I** | **方向性保守建议** | 不是外部实验定律，也不是已经冻结的永久项目不变量；04 对此已有正确收窄 |
| Plugin、MCP、Skill 与 Agent 自写组件统一进入 Runtime 生命周期和 Governance | 项目定义与 `AGENTS.md`，**P** | **项目权威，非外部结论** | 外部来源只提供局部构件；统一治理的有效性仍待 Anthias 实际验证 |
| 用户强制开启对象不能被 Agent 间接使其失效 | 项目定义与 `AGENTS.md`，**P** | **项目权威** | 现有标准没有替 Anthias 证明图级 Pin 语义；报告中的传递检查是 **I** |

## 5. 03：Evaluation 与 Safety 报告抽查

| 关键主张 | 直接来源 / 类别 | 审计判断 | 总报告需要保留的边界 |
| --- | --- | --- | --- |
| 长时程受控部署发现了预部署 eval 未覆盖的失败，随后暂停并补充 incident eval / trajectory monitor | [OpenAI 一手复盘](https://openai.com/index/safety-alignment-long-horizon-models/)，**OP** | **直接支持该次内部部署观察** | 不是同行评审、无通用对照；不能证明其流程对 Anthias 有同样效果，replay 也受随机性与环境重建限制 |
| Agent eval 应组合代码、模型和人工 grader，并区分 `pass@k` / `pass^k` | [Anthropic 工程文章](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)，**OP** | **直接支持其工程建议** | 是企业一手实践，不是所有 Agent 的受控因果结论或固定统计处方 |
| E0—E5 是 Evaluation 证据层次 | 03 报告自身，**I** | **可作为研究组织语言** | 不是学术标准、已实现状态机或必须采用的流程；报告已正确声明这一点 |
| Independent Evaluation 首先要求权力、数据、规则和写权限分离 | NIST 通用控制、评测研究、项目约束，**NS + PR + P + I** | **高价值综合推断** | 不能写成某一来源直接证明的 Agent 定律；“另一个模型名不等于独立”是边界判断 |
| shadow / canary / rollback 可降低真实暴露风险 | Google SRE、Argo 等，**OP/NS + I** | **仅类比** | 不得照搬比例、时间或基础设施；不可逆 Agent 副作用也不因代码回退而消失 |
| Judge 需要硬 oracle、异构证据和分歧保留 | Agent-as-a-Judge、AgentRewardBench 等，**PR + I** | **部分支持** | 研究表明 Judge 有不同盲区，但没有证明某个组合就是 Anthias 的权威真值 |
| SpecBench、AJ-Bench、Causal Agent Replay 暴露新风险/方法 | 各自 2026 论文，**PP** | **方向性支持** | 不能用来冻结 held-out、Judge 或 replay 机制，更不能声称已能安全评价不可逆真实副作用 |
| SLSA / in-toto / TUF 支持 Artifact 可核对和更新保护 | 官方规范，**NS + I** | **直接支持供应链语义，Agent 映射仅类比** | 不能把软件发布完整性写成 Candidate 正确、有效或安全的证据 |

## 6. 04：Anthias 适配复核抽查

| 关键主张 | 直接来源 / 类别 | 审计判断 | 总报告需要保留的边界 |
| --- | --- | --- | --- |
| Mem2Evolve 让 Experience Memory 与 Asset Memory 双向共演化，并报告 18.53% / 11.80% / 6.46% 的改善 | [ACL 2026 正式论文](https://aclanthology.org/2026.acl-long.952/)，**PR** | **直接支持论文设置与作者数字** | 六类任务、八个 benchmark 的结果不证明 Anthias 的持续身份、活体 Plugin、治理、Pin 或长期生产收益；百分比沿用作者摘要口径，不擅自改写为百分点 |
| 没有一个“被审查的外部系统”同时覆盖全部 Anthias 要求 | 04 的来源集合，**I** | **措辞合格** | 04 已限定“被审查”并明确不是世界首创；统一报告必须保留这两个限定 |
| “受治理的演化 Runtime”是 Anthias 的合适描述 | 项目文档 + 研究综合，**P + I** | **可作为描述性综合** | 不是行业正式术语、外部分类法或已证明的最佳产品类别 |
| DGM、AHE、Mem2Evolve、Agent libOS、Continuity Kernel 分别提供局部拼图 | 多类来源，**PR / PP / I** | **比较总体克制** | “接近”只指某个局部问题；它们不能被合并成一个已有的端到端实证系统 |
| 统一后的 12 条最小原则应 Adopt / Adapt | 项目不变量 + 研究综合，**P + I** | **项目适配判断** | `Adopt` 不能被理解为已授权实现、已冻结模块或论文证明；04 已声明不是实施设计 |
| Candidate / HEAD 分离与 Continuity Kernel 高度相似 | [Continuity Kernel](https://arxiv.org/abs/2608.11632)，**PP + I** | **概念相似成立** | Kernel 的 continuity 是基础设施谱系；不能替换 Anthias Agent 身份语义，也不能借其有界模型声称运行时已安全 |
| 每次 Candidate 声明可证伪预期，但自我预测不能替代风险检查 | [AHE](https://arxiv.org/html/2604.25850v4)，**PP + I** | **来源与推断匹配** | manifest 是记录主张的方法；11.8% precision / 11.1% recall 反而说明它不是可靠回归 oracle |

## 7. 05：Evolution 红队报告抽查

| 关键主张 | 直接来源 / 类别 | 审计判断 | 总报告需要保留的边界 |
| --- | --- | --- | --- |
| 14 个 Failure Mode 是 Anthias 的主要攻击面 | 项目约束 + 红队推演，**P + I** | **是 falsification 假设，不是已发现缺陷** | 不得写成 Anthias 已遭遇这些事故，也不能声称集合完备 |
| AHE 的回归预测 precision 11.8%、recall 11.1% | [AHE v4](https://arxiv.org/html/2604.25850v4)，**PP** | **直接支持** | 来自单一研究 campaign；只能说明该设置中预测很弱，不能量化 Anthias 的未来盲区 |
| 无门禁 Skill 池先升后降；只删污染源仅恢复退化的 17% | [When Self-Evolution Backfires](https://arxiv.org/abs/2608.05810)，**PP** | **直接支持该小样本设置，外推风险极高** | Event-50、Terminal-Bench 2、有限任务/重复；应写“在该实验中观察到残余退化”，不能写成所有 Agent 的结构性不可逆定律 |
| 上述单篇结果“足以否定文本可删，所以积累天然可逆” | 同一新预印本，**PP + I** | **不支持如此确定的经验强度** | 可改成“提供了一个需要认真对待的反例信号，因此不能把可删除当成已证实的可逆性” |
| Continuity Kernel 以精确前驱、freshness 和单一权威 HEAD 约束提交 | [Continuity Kernel](https://arxiv.org/abs/2608.11632)，**PP** | **直接支持协议模型** | 2,808,230 个可达状态和 5,526,474 条状态变化边的有界检查只覆盖编码不变量；不证明 evaluator、语义、存储驱动或真实副作用正确 |
| Agent libOS 将 action surface 与 authority 分开，并承认恢复不能撤销外部世界 | [Agent libOS](https://arxiv.org/abs/2606.03895)，**PP** | **直接支持原型理念与限制** | 123 个回归测试和 smoke test 不等于内核级沙箱、完整端到端评价或生产验证 |
| `AutoCloseable`、ClassLoader、`ProcessHandle` 的保证有限 | Oracle JDK 文档，**NS** | **直接支持** | ProcessSupervisor、Owner closure 与反向释放顺序是 Anthias 的 **P/I**，不是 JDK 自动提供 |
| 最小 Falsification Suite 是“声称安全演进前必须能尝试推翻的问题集” | 05 的红队综合，**I** | **可作为研究检查面** | 不是正式测试标准、证明体系、实现清单或完整攻击覆盖 |
| 没有现有单一系统同时实证覆盖全部 Anthias 要求 | 05 的来源集合，**I** | **需继续收窄** | 改成“在本轮审查的一手来源中未发现”；不能从有限检索推出全球不存在 |

## 8. 2026 年高风险新来源专门清单

| 来源 | 截止日状态 | 可安全引用的最强主张 | 不得据此冻结或外推 |
| --- | --- | --- | --- |
| [Agentic Harness Engineering](https://arxiv.org/html/2604.25850v4) | 2026-05-18 v4，预印本/研究 campaign | 在其 Coding Agent harness 自修改实验中，分层可观察性与 falsifiable manifest 可使用；同时观察到严重 regression blindness | Anthias 应照搬其文件组件、轮次或流程；manifest 能预测安全回归；单次结果代表长期演化 |
| [Agent libOS](https://arxiv.org/abs/2606.03895) | 2026-06 预印本与 Python 原型 | 动态 action surface 不应隐式扩张资源 authority；外部 effect 恢复有不确定性 | 已实现内核/虚拟机级隔离；解决语义注入、不可逆副作用或 planner 正确性 |
| [Causal Agent Replay](https://arxiv.org/abs/2606.08275) | 2026-06 预印本 | 对轨迹中介入点做因果重放是一个候选研究方向，并有明确环境重建限制 | 已能对开放、随机、不可逆 Agent 轨迹给出可靠因果结论 |
| [AJ-Bench](https://arxiv.org/abs/2604.18240) | 2026-04 预印本 | 可用于观察交互轨迹 Judge 的局部挑战 | 某个 Judge、投票或阈值可以成为 Anthias 的权威评价机制 |
| [SpecBench](https://arxiv.org/abs/2605.21384) | 2026-05 预印本 | visible 与 held-out compositional 检查之间可能存在差距 | 所有差距都由蓄意 reward hacking 导致，或其数据切分就是 Anthias 标准 |
| [When Self-Evolution Backfires](https://arxiv.org/abs/2608.05810) | 2026-08-06 新预印本，距截止日 13 天 | 在其 Event-50 / TB2 设置中观察到非单调积累、污染和 source-only rollback 后的残余退化 | “Skill 污染普遍结构性不可逆”、72% 门禁或任一固定策略应直接采用；其 17% 可外推 |
| [Continuity Kernel](https://arxiv.org/abs/2608.11632) | 2026-08-12 新预印本，距截止日 7 天 | 在给定有限抽象和假设下，精确前驱、writer fencing、candidate/head 分离的编码不变量未被模型检查反例打破 | 无界正确性、语义正确、存储实现一致、真实副作用原子性、Anthias Agent 身份已被形式证明 |
| [Learning While Acting / LifeSkill](https://arxiv.org/abs/2606.04815) | 2026-06 预印本 | verifier-guided Skill 学习与在线参数内化在其设置中的早期信号 | Anthias 当前必须引入在线权重训练，或参数演化已满足可回滚与数据权利要求 |
| [Skills over MCP](https://modelcontextprotocol.io/community/working-groups/skills-over-mcp) | 官方工作组；SEP 与参考实现仍在审 | MCP 社区正在讨论 Skill 发现/获取的互操作方向 | 已形成稳定标准、bundle/package 已解决、Anthias 应以它作为唯一内部格式 |

### 8.1 新但已有正式会议版本的来源

下列工作不应归入“仅预印本”，但仍必须按实验范围引用：

- [DGM，ICLR 2026](https://iclr.cc/virtual/2026/poster/10007327)：同行评审提高了来源成熟度，不把 Coding Benchmark 变成长时生产安全证据。
- [MemEvolve，ICML 2026 / PMLR 306](https://openreview.net/pdf?id=qpkG0eKx4v)：支持 memory architecture meta-evolution 的 benchmark 结果，不支持 Anthias Governance 或稳定身份。
- [Mem2Evolve，ACL 2026](https://aclanthology.org/2026.acl-long.952/)：是当前最直接的 Experience / Asset 共演化实证之一，但“资产”不等于受管 Plugin，也不证明在线挂载。

## 9. 可保留的高置信结论

### 9.1 来自项目权威的确定结论

以下内容可以确定地写成“Anthias 当前要求”，但不能伪装成论文结论：

- Agent 具有持续身份，模型是可替换 Cognitive Engine；
- Agent 只提出 Runtime Mutation Proposal，Governance 决策，`RuntimeCoordinator` 单写执行；
- Consumer 依赖 Capability 合同，受管副作用有 Owner、Scope 和释放语义；
- Plugin、MCP、Skill 与 Agent 自写组件进入统一生命周期和 Governance；
- 用户 Pin 不能被 Agent 直接或间接解除；
- Evolution 需要独立 Evaluation，提出改变的 Agent 不能自行证明成功；
- 当前只讨论原则与证据，不提前冻结 Stage、模块、Schema、阈值或实现产品。

这些结论的置信来自 **P**，不是因为外部研究已经验证它们。

### 9.2 来自外部来源的有限高置信结论

- DGM、Mem2Evolve、A-MEM 与 MemEvolve 的正式会议版本直接支持各自在公开实验中报告的可测结果；它们没有共同证明这些机制在长期生产环境中成立。
- MCP、JDK、OSGi 等官方材料可以确定各自协议、装载、关闭和生命周期的公开边界；这些边界足以排除“schema 等于行为安全”“ClassLoader 等于沙箱”“close 接口自动拥有全部资源”等错误理解。
- SLSA、in-toto、TUF 等规范只解决 provenance、完整性和更新攻击的一部分；它们本身不评价运行行为。这一否定边界可以高置信保留。
- OpenAI 与 Anthropic 一手材料足以证明：在它们披露的系统中，长轨迹、环境状态、预算、grader 与实际部署反馈会影响评价；不能把一次成功或单一 Judge 当成普遍可靠性证明。
- 代码/Revision 回退不能自动撤销已经发生的外部调用、消息、信息泄露或第三方行为。这是跨系统副作用边界，不依赖某一篇论文的算法成立。

## 10. 只能作为方向的中低置信结论

- “稳定 AgentId 是所有自进化系统的必要条件”目前没有直接实证；它是 Anthias 的产品定义与身份模型。
- Experience 与 Asset 双向共演化很有前景，但现有证据不足以证明长期、跨域、持续单调提升。
- DGM 式 archive / Branch 在真实长期 Coding Agent 中能否稳定保留有价值 stepping stone，仍需考虑污染、成本和评价漂移。
- AHE 的 manifest 值得作为可证伪声明的灵感，但其自身结果不支持把自我预测当回归检查。
- Backfires 的污染与 residual degradation 是重要反例信号，不能升级为“任何 Skill 积累都会越过 tipping point”或“污染普遍不可逆”。
- Continuity Kernel 的 candidate/head、freshness 和 writer fencing 与 Anthias 高度相似，但具体 disposition、状态机和形式模型不应因这篇极新预印本而冻结。
- Agent libOS 对 authority boundary 的表达有启发，但其原型不能决定 Anthias 最终隔离技术。
- SRE canary、软件 rollback 和供应链控制可以提供类比，不能直接决定 Anthias 的真实暴露流程。
- 同模型隔离实例、异构模型、规则 evaluator 或人工分别适合什么风险，目前没有足够 Anthias 数据支持统一答案。
- 在线权重训练、Memory meta-evolution、复杂 Branch 搜索和自改 Governance 都属于远期研究轴，不是当前证据已经要求的基础能力。

## 11. 必须从总报告删除或改写的表述

| 不应出现的强表述 | 可接受的改写 |
| --- | --- |
| “DGM 证明经验评价优于形式证明。” | “DGM 展示了经验 benchmark evaluation 在其开放式搜索中可以驱动改进；论文没有证明它普遍优于形式证明。” |
| “Generative Agents 记录了完整经验，因此等价于可审计 Ledger。” | “Generative Agents 在模拟环境中维护 memory stream；它不是运行时权限、副作用和 Artifact 的完整审计 Ledger。” |
| “这些最新自进化工作都还是预印本。” | “来源状态逐项记录：DGM、A-MEM、MemEvolve、Mem2Evolve 已有正式会议版本；AHE、Agent libOS、Backfires、Continuity Kernel 等仍是预印本/原型。” |
| “现有世界上没有任何系统覆盖 Anthias，因此 Anthias 是首创/唯一。” | “在截至 2026-08-19 本次审查的一手来源中，未发现单一系统同时实证覆盖所列 Anthias 要求；这不是全球完备检索或首创声明。” |
| “Backfires 证明 Skill 污染结构性不可逆。” | “该新预印本在有限 TB2 设置中观察到 source-only rollback 后的残余退化；它提供风险信号，不构成普遍不可逆定律。” |
| “删除污染源只恢复 17%，所以 Anthias 会损失同样比例。” | “17% 是该论文特定实验对退化恢复比例的作者报告，不能预测 Anthias。” |
| “Continuity Kernel 已形式证明候选提交安全。” | “该论文在有限抽象和显式假设下穷举编码状态而未发现不变量违规；作者明确不证明语义、实现或外部副作用正确。” |
| “Agent libOS 已解决动态 Tool 的沙箱问题。” | “Agent libOS 原型区分 action surface 与 authority，并明确没有提供内核级沙箱或完整语义安全。” |
| “签名、SLSA 或 TUF 证明组件可信/安全。” | “这些机制可以证明部分来源、构建或更新属性；行为、权限和任务收益仍需独立评价。” |
| “MCP/JSON Schema 兼容即可证明 Capability 可替换。” | “协议与 schema 只证明结构兼容；Consumer 可见语义、失败模式、数据边界和副作用仍未被证明。” |
| “另一个 Agent/模型就是独立 Evaluation。” | “模型异质性只是一种证据；独立性还取决于 Candidate 无法控制数据、规则、预算、记录、凭据和 Promote authority。” |
| “04 的 Adopt 表示已经批准实现。” | “Adopt/Adapt 是研究适配结论；项目流程仍要求真实 Feature 出现后另行讨论与授权。” |
| “05 的 Failure Modes 是 Anthias 已存在的漏洞。” | “它们是基于项目边界推演的 falsification targets；本轮没有运行实现或发现对应缺陷。” |
| “这套方案已经能证明安全自进化。” | “当前研究只能建立可追踪、可证伪和受治理的原则边界，不能证明未来开放环境中无回归或无事故。” |

## 12. 截至 2026-08-19 的时效边界

1. 本审计只对截止日可见的论文版本、会议页面、规范版本和工作组状态负责。
2. MCP 2026-07-28 距截止日不足一个月；Skills over MCP 仍有在审 SEP 和参考实现。未来真实兼容工作必须重新核对当时版本，不能把本报告当永久协议快照。
3. Backfires 发布于 2026-08-06，Continuity Kernel 发布于 2026-08-12；它们距离截止日仅 13 天和 7 天，几乎没有时间形成独立复现或社区共识。
4. arXiv 版本可能在截止日后修改实验、限制或标题；会议录状态应优先于旧报告中的 arXiv-only 分类，但仍不得扩大正文结论。
5. 本次检索不是系统综述、注册式文献综述或全网完备搜索。“未发现”只能描述本次实际审查集合。
6. 产品、模型、benchmark、协议和公开仓库都可能变化；任何与版本相关的主张在进入真实开发讨论前都应重新核对一手来源。

## 13. 本审计无法验证的内容

- 没有运行 Anthias 代码，也没有可供审计的 Candidate、Runtime Mutation、长期 Run、Pin 故障、污染样本或 Evaluation 结果。
- 没有复现任何论文实验；所有数字都是作者报告，未独立验证原始数据、统计代码、样本选择、基础模型污染或计算预算。
- 没有验证每个来源的全部引用链和所有附录；实际逐页核对与仅结构审查的范围已在第 2 节列明。
- 没有证据证明某套有限 Evaluation 能覆盖未来开放任务，也没有证据证明 Ledger 可以从相关性自动恢复真实因果。
- 没有证据证明外部副作用可以普遍原子提交或完整撤销；代码回退、补偿和世界复原必须继续区分。
- 没有证据给出稳定身份的客观阈值、Promotion 的样本数/分数线、统一 Judge 组合、固定 canary 比例或最佳隔离产品。
- 没有证据证明保护层可以无限递归地自我验证；最终的人类/Host 信任根及其局限仍是项目约束。
- 没有完成全球专利、闭源产品或未公开系统调查，因此不能支持首创、唯一或不存在其他系统的声明。

## 14. 审计后的统一表述

在不把外部研究夸大为方案证明的前提下，01—05 可以共同支持以下有限结论：

> Anthias 选择把同一持续 Agent 的跨任务事实、经验抽取、资产生成、候选激活和独立评价分开治理。现有正式研究报告了其中若干局部机制在受控 benchmark 中的效果，官方规范提供了协议与生命周期构件，企业一手实践和新预印本暴露了长轨迹、评价污染、权限漂移与回退边界；但没有一项来源单独证明 Anthias 的完整闭环、长期收益或生产安全。

这段表述忠于项目实际：保留最前沿研究带来的问题与启发，同时不把尚未实现、尚未复现或尚未同行评审的内容提前写成事实。
