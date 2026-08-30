# Anthias 前沿 Agent 原理适配审查

> 审查日期：2026-08-19
>
> 审查对象：[Agent 自进化前沿研究](01-agent-evolution-frontier.md)、[动态扩展与治理研究](02-runtime-extensibility-governance.md)、[Evaluation 与安全研究](03-evaluation-safety-frontier.md)
>
> 权威顺序：Anthias 当前项目定义、AGENTS.md 与技术基线高于外部论文、规范和其他 Coding Harness。
>
> 文档性质：研究适配审查，不是 Spec、Plan、Stage 规划或实施授权；不冻结模块、Schema、阈值、算法或基础设施。

## 0. 判定方法与总判断

本文使用四种判定：

- **Adopt**：结论与 Anthias 已确认语义一致，可以作为长期原则或对既有原则的外部佐证；不代表照搬来源实现。
- **Adapt**：来源解决了 Anthias 问题的一部分，但必须重新映射到 AgentId、Revision、Governance、Runtime 生命周期或 Evaluation 语义。
- **Reject**：直接照搬会破坏 Anthias 已确定的不变量，或把来源尚未证明的能力冒充成项目事实。
- **Defer**：方向可能成立，但当前没有真实 Feature、风险或运行 Evidence 支持做决定。

总判断：

1. 第一轮三份报告的主要方向与 Anthias 项目定义一致，不需要因为新论文重写项目核心。
2. 目前没有一个被审查的外部系统同时覆盖 Anthias 要求的持续 Agent 身份、同一 Run 内 Runtime 变化、时空可组合生命周期、受治理的 Candidate Revision、跨 Run Evidence、独立 Evaluation、传统扩展兼容和用户 Pin。这个结论只限于本次审查来源，不是“世界首创”声明。
3. 最适合 Anthias 的不是复制某个框架，而是把数条已被分别验证的研究线收敛到项目已有闭环：经验与资产共同演进、候选谱系、可证伪修改、稳定权限边界、独立评价。
4. 可以用“受治理的演化 Runtime”概括这一收敛方向，但它只是本文的描述性短语，不应被静默加入项目正式术语。

## 1. Anthias 真正要解决的问题

Anthias 不是要让一个固定 Coding Harness 自动调 Prompt，也不是要让模型在每个任务后多写一条 Memory。真实问题是：

> 同一个拥有持续身份的 Agent，如何在真实任务和多次任务中留下可复核痕迹，基于这些痕迹提出、编写并试运行新的能力结构，同时确保变化不自我授权、不破坏运行中依赖、不改写历史、不绕过用户约束，最后由独立证据决定它是否成为新的稳定 Revision。

这个问题至少同时包含六条边界：

| 边界 | Anthias 的权威回答 | 外部工作常见缺口 |
| --- | --- | --- |
| 身份 | AgentId 持续；模型和组件是可替换部分 | 把每个候选版本、模型实例或角色称为新 Agent |
| 事实 | Ledger 保存发生事实，Artifact 保存产物，Projection 可重建 | 把总结后的 Memory 当成历史本身 |
| 变化 | Agent 提 Proposal；Governance 决策；RuntimeCoordinator 单写执行 | Agent 直接改活体代码、工具表或评分面 |
| 生命周期 | Capability 合同、Owner、Scope、释放、Safe Point、Epoch | 只验证代码能运行，不验证退出、替换和资源归属 |
| 演化 | Candidate 与 HEAD 分离；独立 Evaluation 后 Promote 或 Reject | 一次成功、自测通过或分数上升即宣布进化 |
| 用户权威 | Pin 在 Agent 可编辑状态之外，直接和间接失效都受约束 | 把启用状态当普通可变配置或提示词 |

因此，“更强”不是 Anthias 的唯一目标。Anthias 同时要求变化的身份连续性、权力合法性、运行完整性、因果可追踪性和可退出性。

## 2. 项目不变量检查表

下表只检查第一轮结论是否尊重当前项目，不提出新设计。

| Anthias 不变量 | 审查结果 | 必要说明 |
| --- | --- | --- |
| Agent 拥有持续身份，模型只是 Cognitive Engine Provider | **Adopt** | 所有来源中的“新 Agent”“专家 Agent”或模型更新都不能自动生成新的 Anthias AgentId |
| Spring Boot 管 Stable Host，Dynamic Runtime Core 保持 Pure Java | **Adopt** | 外部 Agent SDK、OSGi、MCP 或 Agent libOS 只能提供参考机制，不能接管 Anthias Runtime 语义 |
| Agent Loop 由 Anthias 自己实现 | **Adopt** | 外部 Harness 的循环可以比较，不能替代 Executive Loop、Mutation、Revision 和 Evolution |
| Proposal、Governance、RuntimeCoordinator 三段权力分离 | **Adopt** | Candidate 生成、治理决定和结构写入不能折叠回同一个 Agent 动作 |
| RuntimeCoordinator 是 Control Plane Single Writer | **Adopt** | 并发准备和执行可以存在，结构提交仍须单写 |
| 结构变化发生在 Safe Point，并校验 Composition Epoch | **Adopt** | 离线候选、动态工具通知和热加载事件都不能直接改变执行中 Action 的依赖 |
| Consumer 依赖 Capability，不绑定具体 Provider 或 Plugin | **Adopt** | MCP Tool 名、Plugin 包名或模型名不是内部全局能力合同 |
| 每个受管副作用有 Owner、Scope 和释放语义 | **Adopt** | “测试通过”不能替代进程、线程、监听、缓存、文件和网络资源的生命周期证据 |
| 跨 Run 痕迹能成为长期 Evidence | **Adopt** | 历史相关性用于找问题；长期晋级仍需独立确认 |
| Agent 能写自己的 Plugin、Tool、Skill、Workflow 和组件 | **Adopt** | 这是 Anthias 的长期产品能力，不是外部论文新增给项目的方向 |
| 生成物先是 Artifact 与 Proposal，不能直接改 protected core | **Adopt** | Agent 作者身份不提高生成代码的运行权限 |
| 传统 Plugin、MCP、Skill 与 Agent 自写组件统一治理 | **Adopt** | “统一”指进入同一权威闭环，不表示强行统一文件格式和执行载体 |
| 用户 Pin 不能被 Agent 直接或间接解除 | **Adopt** | 故障隔离可停止危险执行，但不能改写用户意图或伪报健康 |
| Proposer 不能自行证明 Evolution 成功 | **Adopt** | 换一个模型名字不自动形成独立评价；关键是数据、权限、规则与职责隔离 |

第一轮没有发现需要推翻这些不变量的强证据。相反，多数前沿结果在局部上说明这些约束是必要的。

## 3. 对 01 自进化前沿报告的判定

### 3.1 Adopt

| 主张组 | 判定理由 |
| --- | --- |
| 持续身份不等于长上下文、模型实例或人格叙事 | 与 AgentId、Revision 和 Cognitive Engine 分离完全一致 |
| 原始轨迹、episodic / semantic / procedural memory、组件和模型权重必须分层 | 防止“存了一段文本”被误报成 Runtime 已进化 |
| Reflection 只产生 Hypothesis | 直接保护 Evidence 和 Evaluation 的权威边界 |
| 事实层不可变，学习层可修订 | 与 Ledger、Artifact、Projection 的分工一致；后来的归纳可以 supersede 旧归纳，但不能伪造过去 |
| Agent 生成的 Skill、Workflow、Tool 或 Plugin 先是 Candidate Artifact | 与 Agent 自写组件的既有产品语义一致 |
| 参数训练是 Cognitive Engine Provider 的独立演化轴 | 模型权重变化不吞并 Agent 身份、Runtime、Memory 或 Governance |

这里需要一个精度限制：“事实层不可变”不等于现在决定所有大体积 Artifact 永久保存。Ledger 权威、Artifact 引用、隐私、保留期限和物理删除之间的具体关系仍未设计。

### 3.2 Adapt

| 来源机制 | 适配后的 Anthias 语义 | 不能照搬的部分 |
| --- | --- | --- |
| Reflexion、ExpeL 的轨迹反思 | 生成 Reflection Case、Experience Candidate 和可证伪 Hypothesis | 语言反思不能写 Evaluation 结论或直接 Promote |
| AWM 的跨任务 Workflow | 带 Run/Evidence provenance、适用范围和版本的 Workflow Candidate | 不能静默覆盖全局 Prompt，也不能把网页任务结果外推到 Coding Runtime |
| Voyager、SkillWeaver 的可执行 Skill / API | 证明经验可以转为可执行资产并改变 Action Space | 自验证、受控网页/Minecraft 结果不等于生产 Plugin 生命周期和独立 Governance |
| AlphaEvolve 的 evaluator-driven search | 当目标可重复验证时，用 evaluator 选择候选和保留结果证据 | 演化的是算法候选，不是具有 AgentId 的长期 Runtime；单一 fitness 不能代表 Anthias 的“更好” |
| DGM 的 archive、parent selection 和 stepping stone | 每个节点映射为同一 AgentId 下的 Candidate Revision / Branch，父子关系映射为谱系 | 不能把每个节点变成独立 Anthias Agent，也不能把 benchmark 分数直接作为 HEAD 晋级权威 |
| Agent Lightning 的轨迹到训练数据解耦 | Ledger / Artifact 可在未来派生训练数据，训练结果成为 Provider Candidate | 训练 transition 不是事实 Ledger；RL 管线不是当前 Runtime Core |

DGM 的映射还需要保持一个细节：Composition Epoch 表示细粒度 Runtime 状态，不应把每次临时挂载都膨胀成 DGM 式 archive node。只有具有持续语义的能力组合才属于 Revision；这一边界由 Anthias 项目定义而不是 DGM 决定。

### 3.3 对第一轮的必要补充：Mem2Evolve

[Mem2Evolve（ACL 2026）](https://aclanthology.org/2026.acl-long.952/) 是目前对 Anthias “多次经验不只生成文字，还能引导新资产；新资产运行又产生新经验”最直接的同行评审证据之一。论文把 Experience Memory 与 Asset Memory 组成双向循环，并在六类任务、八个 benchmark 上报告相对只演化经验或只创建资产的增益。

对此应作两层判定：

- **Adopt：** 经验蒸馏与能力资产扩张不应分成两条互不相干的长期循环。Anthias 的跨 Run Evidence → Agent 编写组件 → 新 Runtime 轨迹，正好形成可验证的双向关系。
- **Adapt：** Mem2Evolve 的 Asset 包括工具或专家 Agent，它没有证明 Anthias 所需的稳定 AgentId、Safe Point、Single Writer、Owner/Scope、用户 Pin、Plugin 退出语义或独立 Promotion。Asset Memory 只能映射为候选资产与目录，不能映射为 Runtime 权威。

因此 Mem2Evolve 支持“经验与资产共演化”，不支持“经验足够多时 Agent 可以绕过 Governance 自动装载资产”。

### 3.4 Reject

- **Reject：** SICA 类直接修改当前 Agent 实现并立即把结果当成活体自修改。它与 protected core、Proposal、Governance、Safe Point 和独立 Evaluation 冲突。
- **Reject：** 把 DGM archive 中的每个版本或 Mem2Evolve 的专家资产解释为新的持续 Anthias Agent。
- **Reject：** 把 Reflection、检索命中、Skill 被多次调用或一次自测成功单独称为 Evolution。
- **Reject：** 把模型权重更新当作 Agent 身份替换，或让训练系统成为 Ledger / Runtime 的新权威。
- **Reject：** 为了追求 open-ended evolution，让 Candidate 同时改变被评价对象、评价规则、Governance 和晋级条件。

### 3.5 Defer

- Memory 操作策略、Memory Provider 架构和学习机制自身的 meta-evolution。
- 在线模型训练、参数内化和私有经历训练出的权重归属。
- Branch 合并、复杂 archive parent selection 与开放式搜索策略。
- 跨仓库经验共享、隐私边界、语义记忆遗忘和长期失效算法。

这些方向并非错误，只是当前没有 Anthias 真实运行数据支撑具体决定。

## 4. 对 02 Runtime 扩展与治理报告的判定

### 4.1 Adopt

| 主张组 | 判定理由 |
| --- | --- |
| Plugin、Capability、Provider、Tool、Skill、Workflow、MCP Server 和 Process 不应混为一体 | 与项目既有 Runtime 术语和 Capability 依赖原则一致 |
| Manifest 是声明，不是授权或行为证明 | 防止 Agent 自写或第三方扩展用自述扩大权限 |
| 外部动态发现只生成 Proposal | 保持 RuntimeCoordinator Single Writer、Safe Point 和 Epoch |
| 新 Provider 先准备、验证，再切换、reconcile、排空旧 Provider | 与项目已确认的热替换和 Temporal / Spatial Composability 一致 |
| 传统扩展和 Agent 生成扩展进入同一治理闭环 | 满足兼容支持与自写组件并存的产品要求 |
| Pin 要校验变化后的完整 Runtime Graph | 只有结果图检查才能捕捉移除依赖、改路由、关闭 Owner 等间接绕过 |
| Artifact 身份、来源、签名、测试和运行行为是不同证据 | 任何单项都不能证明组件安全或长期有效 |

### 4.2 Adapt

| 来源机制或建议 | Anthias 的适配边界 |
| --- | --- |
| OSGi 的 Bundle / Service / Resolver | 借鉴合同、Owner 和解析思想；不引入 OSGi 全套运行时，也不让其状态机替代 RuntimeCoordinator |
| JDK ModuleLayer、ServiceLoader、ClassLoader | 可作为可信 JVM Provider 的发现/装载构件；不是恶意代码沙箱，也不保证卸载 |
| Revision 并行准备与引用切换 | 与 Anthias 热替换高度一致；具体 ClassLoader 或代理手段仍由真实组件决定 |
| MCP 适配 | Server 是外部 Provider 容器，Tool/Resource/Prompt 是贡献；协议通知不直接写 Runtime Graph |
| Skill 适配 | Skill 是可版本化的认知或工作流资产；只要引用脚本、命令、MCP 或资源，就必须解析为受管 Capability |
| 传统 Coding Agent Plugin 导入 | 通过 importer/adapter 保留原 namespace 与 provenance；不支持的语义显式呈现，不能静默近似 |
| 分层隔离 | 接受“信任和副作用决定隔离强度”，不接受“某种包类型天然等于某个沙箱等级” |

“同一治理闭环、不同信任起点”需要再加一条约束：用户 Pin 表达持续用户意图，不等于提升 Artifact 信任等级，也不等于预先授权所有调用、权限扩张或自动更新。

### 4.3 Reject

- **Reject：** 用 Spring AI、外部 Agent SDK、MCP、OSGi 或 Cordis 代替 Anthias 自写 Agent Loop 和 Runtime 权威。
- **Reject：** 把 ClassLoader、普通子进程、容器名称或数字签名本身宣传成完整安全边界。
- **Reject：** Agent 生成代码后覆盖当前加载目录、原地修改 protected core，或让 Plugin 自己启动不受 ProcessSupervisor 持有的进程。
- **Reject：** 把 MCP tools/list changed、文件监听、插件自更新直接变成 Runtime Graph 写操作。
- **Reject：** 只拦截名为 disable 的操作来实现 Pin，或因安全停机而静默 Unpin。
- **Reject：** 把安装、挂载、健康、被选择、单次调用成功和 Evolution 成功混成同一个状态。

### 4.4 Defer

- Manifest 最终字段、Capability 版本算法、Provider 选择公式和兼容评分。
- Agent 生成 Java 组件最终运行在 JVM、独立进程、WASM、容器还是 microVM。
- SLSA、in-toto、Sigstore、TUF、PKI、透明日志和插件市场的具体组合。
- 原地 Java hot reload、远程自动更新、统一 sandbox 产品和跨平台隔离实现。
- Pin 的具体存储、UI、状态名、重试次数，以及“固定精确 Artifact”与“固定 Capability 可用”的默认产品语义。

特别是“Agent 生成代码默认不进入 Host JVM”目前只能作为高风险方向的保守建议，不能被写成项目永久不变量。当前可以固定的是：生成物不能未经治理直接获得活体权限；具体执行边界等待真实组件和部署环境。

## 5. 对 03 Evaluation 与安全报告的判定

### 5.1 Adopt

| 主张组 | 判定理由 |
| --- | --- |
| Evaluation 是受治理的证据链，不是一个总分 | Anthias 的“可验证”同时涉及结果、过程、安全、资源、可重复性和退出 |
| Proposal、Evaluation、Decision、Mutation 权力分离 | 精确落实“提出改变的 Agent 不能自行证明成功” |
| 独立性取决于输入、凭据、写权限、规则所有权和证据完整性 | “另一个模型实例”本身不构成独立裁判 |
| 一次观测可以产生 Candidate，但不能直接 Promotion | 与跨 Run Evidence 和 Candidate / HEAD 分离一致 |
| 全量失败、超时、取消、grader failure 与选择过程都要留下痕迹 | 防止选择性上报和事后进化故事 |
| Candidate 评价绑定确切 Artifact、环境、Harness 和 Evaluator 版本 | 评价后改变产物时，旧证据不能自动转移 |
| 安全不变量不能被平均收益抵消 | Pin、Ledger、权限、资源释放和 protected core 失败属于否决面 |
| 回退是新的前向事实，不改写 Ledger | 与 Anthias 的可追踪、可分支、可回滚语义一致 |

### 5.2 Adapt

| 来源方法 | Anthias 的合理用法 | 不能照搬的部分 |
| --- | --- | --- |
| baseline / Candidate 配对、重复试验、任务族切片 | 支持相对收益、可靠性和回归判断 | 不能现在固定样本数、显著性阈值或统一加权 |
| held-out、新鲜任务和事故衍生 eval | 降低公开测试过拟合与污染 | 不能形成永远不变的新静态 benchmark |
| 硬 oracle、规则、LLM Judge、Agent Judge、人工审查 | 按证明对象组合证据，并保留分歧 | 不存在一个可普遍替代其余证据的万能 Judge |
| shadow、canary、post-promotion observation | 借用小暴露、可暂停和持续监控原则 | 它们来自软件发布实践，不是每种 Anthias 变化都必须照搬的固定流水线 |
| Reject、Quarantine、Rollback、Kill / Pause | 用于区分“不晋级、隔离、停止未来暴露、紧急阻断” | 除已有 Promote / Reject / rollback 语义外，其余状态名暂不成为正式领域模型 |
| Evaluation 职责表 | 保留权限域与因果职责 | 不要求现在为每个角色建立独立服务、进程或持久 Agent |

独立 Evaluation 不等于必须创建另一个持续身份 Agent。Evaluator 可以由确定性程序、隔离模型调用、人工或组合承担；关键是它不能继承 Proposer 对 Candidate、评价资产、HEAD、Pin 或 Ledger 的写权限。

### 5.3 Reject

- **Reject：** 单次最佳结果、只报 pass@k、总分上升或 Agent 自测通过就 Promotion。
- **Reject：** Candidate 选择测试、修改 grader、删除失败、提高预算后不披露，或参与写最终 EvalResult。
- **Reject：** 用一个标量把关键安全失败与速度/成功率收益相抵。
- **Reject：** 把离线 Replay 或普通历史轨迹直接称为因果证明。
- **Reject：** 把回滚代码或 HEAD 当成现实副作用已经撤销。
- **Reject：** 把所有 Candidate 强制塞入同样昂贵的固定评价流水线；评价强度应与风险、可逆性和证据缺口相称。

### 5.4 Defer

- 报告中的 E0—E5 是有用的研究组织方式，但不是 Anthias 已确认的正式等级名。
- 固定的重复次数、置信水平、统计检验、任务权重和 Promotion 阈值。
- Replay 的精确模拟层、OPE、Causal Agent Replay 及自动反事实归因。
- Shadow / canary 的流量、时间、权限、用户范围和统一 rollout 机制。
- Evaluator Candidate 的 meta-evaluation、长期 Judge 校准和自动评价资产生成。
- 外部不可逆副作用的统一补偿协议。

## 6. 最接近 Anthias 的外部工作及决定性差异

| 外部工作 | 最值得吸收的部分 | 与 Anthias 的决定性差异 | 判定 |
| --- | --- | --- | --- |
| [DGM](https://arxiv.org/abs/2505.22954) | archive、分支、stepping stone、基准反馈驱动代码候选 | archive node 不是持续 AgentId；不具备 Anthias Runtime 生命周期、Pin 和在线 Single Writer | **Adapt** |
| [Mem2Evolve](https://aclanthology.org/2026.acl-long.952/) | Experience Memory 与 Asset Memory 双向共演化 | 资产创建和 benchmark 增益不等于 Plugin 治理、活体挂载和独立 Promotion | **Adopt 原理，Adapt 机制** |
| [Agentic Harness Engineering](https://arxiv.org/abs/2604.25850) | 可编辑组件、分层轨迹证据、每次修改绑定可证伪预测 | 修改的是离线文件化 Harness；没有同 Run Runtime Mutation、Owner/Scope、AgentId 或 Pin；对回归的预测精度和召回率仍很低 | **Adapt** |
| [Agent libOS](https://arxiv.org/abs/2606.03895) | 可见 Tool 可以变化，但受保护副作用始终经过稳定 Runtime primitive 授权 | 2026 年预印本和 Python 原型；关注进程、能力与审计，不证明 Anthias 的 Revision / Evaluation / 时空组合 | **Adapt，方向性证据** |
| [Continuity Kernel](https://arxiv.org/abs/2608.11632) | retention 不等于 authority；候选离线评价与短事务激活分离；只有接受结果推进 branch head | 2026-08-12 的极新预印本；其 continuity 明确是基础设施谱系，不是 Agent 行为身份；形式模型不证明语义正确或外部副作用原子性 | **Adapt，暂不固化** |
| [AlphaEvolve](https://arxiv.org/abs/2506.13131) | 强、可重复 evaluator 驱动候选搜索 | 演化问题解法而非长期 Agent；适用目标高度可量化 | **Adapt** |
| AWM / Voyager / SkillWeaver | 轨迹可归纳为 Workflow、Skill 或 API，并在后续任务复用 | 缺少 Anthias 的权限、生命周期、谱系、Pin 和独立 Evaluation | **Adapt** |
| OSGi / MCP / JDK / WASI 等规范 | 生命周期、合同、协议、装载和隔离构件 | 它们不是自进化 Agent，也不定义 Anthias 产品语义 | **局部 Adopt / Adapt** |

AHE 尤其说明“给每次修改附一份预测”值得采用，但它自己的实验也显示对回归的预测能力很弱。因此 Anthias 应保存 Candidate 对预期收益和可能回归的可证伪声明，却不能把这份自我预测当成风险检查的替代品。

Continuity Kernel 与 Anthias 的 Agent HEAD / Candidate 分离高度相似，但两者不能合并概念：Kernel 研究“哪个状态具有权威可达性”，Anthias 还要回答“同一 Agent 的 Runtime 在真实执行中如何安全变化、释放、评价并保持用户约束”。它适合做交叉验证，不适合反向改名或接管项目定义。

## 7. 统一后的最小原则集合

以下原则已经足以承接前沿成果，不需要现在增加完整框架：

1. **一个 AgentId，多条 Revision / Branch。** 模型、Prompt、Memory、Skill、Plugin、Workflow 和 Provider 都在持续身份之下变化。
2. **把五类变化分开。** 当前 Run 的临时 Runtime Adaptation、跨 Run 经验/记忆变化、可执行资产/组件变化、演化机制自身的 meta-change、模型权重变化不能共用一个含混的“进化分数”。
3. **事实先于反思。** Run、Event、Artifact 和 Metrics 形成可审计事实；Reflection 只把事实转成 Hypothesis。
4. **经验与资产双向演进。** 多次任务 Evidence 可以引导 Agent 写组件；新组件产生的新轨迹再成为 Evidence，但任何一边都不能自我授权。
5. **生成不等于激活。** 源码、Skill、Workflow、测试或模型更新首先是 Candidate Artifact；只有受治理的 Runtime Mutation 才改变 Action Space。
6. **权威边界不能随 Tool 一起漂移。** 外观层 Plugin、MCP、Skill 和 Agent 生成 Tool 可以变化，受保护副作用仍通过 Stable Host / Runtime 的治理、Capability、ProcessSupervisor 和 Single Writer 边界。
7. **Candidate 与 HEAD 分离。** 候选可以被试运行和保留为 stepping stone，只有独立证据和 Governance 决定是否成为稳定 Revision。
8. **每次 Candidate 都应声明可证伪主张。** 至少说明想改善什么、预期不变什么、可能伤害什么；这些是 Evaluation 的输入，不是成功证明。
9. **评价是多维证据，不是总分。** 正确性、可靠性、成本、延迟、安全、资源、旧能力回归和退出能力按实际风险组合；关键不变量不可被平均。
10. **Pin 校验最终图。** 直接操作名和间接依赖路径都不能使用户固定对象失效；安全停止保留 Pin 事实。
11. **外部生态通过 Adapter 兼容。** 保留 Plugin、MCP、Skill 各自形态和来源，转换为 Anthias 可治理的 Capability / Provider / Artifact 关系，不让外部格式成为内部权威。
12. **保护层不参与普通递归自改。** Ledger、Evaluation 权威、Governance、RuntimeCoordinator、Pin 与安全停止面若未来需要演化，必须进入更高层独立授权与评价，不能与被评 Candidate 同时变化并相互自证。

可把完整因果链写成：

真实 Run 事实 → 跨 Run Evidence → Reflection / Hypothesis → Candidate Artifact / Revision → Governance 决策 → Safe Point 激活或受控试运行 → 独立 Evaluation → Promote / Reject / 保留分支

这条链描述职责和因果，不规定模块、存储、算法或固定流水线。

## 8. 术语冲突与新增术语风险

| 外部术语 | 在来源中可能表示 | Anthias 必须保持的含义 |
| --- | --- | --- |
| Agent | 一个模型实例、一个角色、一个候选代码版本或专家资产 | 具有持续 AgentId、目标和谱系的运行实体 |
| Evolution | Prompt 更新、Memory 写入、Skill 新增、代码搜索或权重训练 | 经过 Evaluation、可能推进稳定 Revision 的长期变化；临时 Adaptation 不是 Evolution |
| Memory | 原始轨迹、摘要、知识、Workflow、Tool 或向量索引 | 必须继续区分事实、Projection、Experience 与可执行 Capability |
| Skill | 提示文本、步骤模板、函数、API 或可执行程序 | 版本化资产；执行依赖和副作用仍进入 Runtime 治理 |
| Runtime | 工具调度器、沙箱、进程系统或 Agent SDK | Anthias 的动态能力结构、Scope、Effect、Provider、Reconcile、Coordinator 和 Epoch 语义 |
| Independent evaluator | 另一个模型或 Agent | 规则、数据、凭据、写权限和职责与 Proposer 隔离的评价者 |
| Commit / accepted head | 数据库或 Continuity Kernel 的权威状态激活 | 可辅助理解 Agent HEAD，但不能未经讨论替换 Anthias 的 Promotion / Revision 术语 |
| Quarantine / canary / E0—E5 | 外部治理、发布或本报告中的组织词 | 研究词汇；真实 Feature 需要时再决定是否进入领域模型 |

尤其不要新增“Meta Agent”“Evaluator Agent”“Asset Agent”等永久身份来承载普通职责。角色、隔离执行体和持续 Agent 是不同概念。只有真实产品需要新的独立主体时，才讨论新的 AgentId。

## 9. 目前仍不可决定的问题

1. 什么粒度的长期变化值得创建 Revision，什么只推动 Composition Epoch。
2. Candidate 同时改变多个组件时，如何在成本可接受的情况下做因果归因。
3. Experience、Semantic Memory 和 Procedural Asset 的失效、降权、supersession 与隐私保留规则。
4. Agent 生成组件按什么风险进入 JVM、进程、WASM、容器或其他隔离边界。
5. 何种低风险 Evaluation 可以由同模型的权限隔离实例承担，何种必须使用异构 Judge、硬 oracle 或人工。
6. 如何维护新鲜、未污染且不被 Candidate 控制的评价面，又避免固定 benchmark 变成唯一目标。
7. Pin 应默认固定精确 Artifact、Provider 还是 Capability 可用性；冲突时怎样呈现给用户。
8. Branch 合并、stepping stone 保留、archive 搜索和跨任务组件复用的产品语义。
9. Promotion 后漂移、依赖升级、模型切换和外部 API 变化如何触发再评价。
10. Evaluation、Governance 或演化机制自身若成为候选对象，谁拥有更高层授权和评价权。
11. Agent 私有经历生成的组件或模型 Provider 是否可以跨 Agent 共享，以及其数据权利和 provenance。
12. 真实不可逆副作用如何补偿；代码/Revision 回退只解决未来选择，不能自动撤销现实结果。

这些问题应由后续真实任务从简单到复杂暴露，不应在本次研究讨论中凭空定细。

## 10. 证据等级

| 等级 | 本文中的来源 | 可以支持什么 | 不能支持什么 |
| --- | --- | --- | --- |
| P：项目权威 | 项目定义、AGENTS.md、技术基线 | Anthias 当前语义、不变量与讨论边界 | 项目尚未运行，不能证明这些机制已经工程成立 |
| A：同行评审研究 | Mem2Evolve、Agent-as-a-Judge、AgentDojo 及其他明确标注会议版本的工作 | 特定机制在给定 benchmark、模型和环境中的实证信号 | Anthias 长期 Runtime、安全或生产可靠性 |
| B：官方规范与工程事实 | JDK、MCP、OSGi、NIST、SLSA、TUF、Google SRE、官方 SDK 文档 | API、协议、生命周期或工程控制的公开语义 | 自进化收益、因果有效性或项目适用性 |
| C：机构一手研究 / 白皮书 | AlphaEvolve、OpenAI/Anthropic 安全与评测报告 | 特定实验或部署观察，以及评测方法边界 | 可直接复制的通用架构 |
| D：近期预印本 / 原型 | AHE、Agent libOS、Continuity Kernel、Causal Agent Replay、SpecBench 等 | 新问题定义、方向和待验证机制 | 成熟共识、长期生产证明或应立即冻结的核心机制 |

证据等级不是简单的好坏排序。官方规范对“JDK 能做什么”比论文更权威，同行评审实验对“某机制在 benchmark 是否提升”更有意义，而 Anthias 项目文档始终决定“这是不是我们要构建的产品”。

## 11. 最终 Adopt / Adapt / Reject / Defer 收敛

### Adopt

- 稳定 AgentId 与 Revision / Branch 分离。
- 原始事实、可修订经验、可执行资产和模型权重分层。
- Experience 与 Asset 的双向共演化原则。
- Reflection 只产生 Hypothesis。
- Candidate Artifact、受治理激活、Agent HEAD 分离。
- Single Writer、Safe Point、Composition Epoch、Owner/Scope 和 Capability 合同。
- Pin 的图级不可绕过语义。
- 独立 Evaluation 的权限与职责分离。
- 评价保留失败、回归、资源、安全、成本和真实结果的多维 Evidence。

### Adapt

- DGM archive 映射为同一 Agent 的 Revision / Branch。
- AHE 的分层证据与可证伪 change prediction 映射为 Proposal / Evaluation 输入。
- Mem2Evolve 的 Experience / Asset Memory 映射为 Evidence、Candidate Asset 和新 Runtime 轨迹，而非权威 Memory。
- Agent libOS 与 Continuity Kernel 的稳定权限/激活边界映射到 Stable Host、Governance、RuntimeCoordinator 和 HEAD，但不替换项目术语。
- MCP、传统 Plugin、Skill、OSGi、JDK、WASM 等只作为 Adapter 或底层构件。
- baseline、held-out、shadow、canary、Judge 与 replay 按风险选择，不固化统一流程。

### Reject

- 直接 self-edit 活体 Harness Core。
- 让 Candidate 自己改评分规则、选择成功样本、Promote、Unpin 或删除失败。
- 把一次任务改善、一次自测、反思文本或单一总分称为 Evolution。
- 把每个 Revision、角色、专家资产或模型实例创建成新 Agent。
- 用签名、Manifest、ClassLoader、普通进程或容器名称替代权限与行为证明。
- 把外部协议的动态事件变成绕过 RuntimeCoordinator 的结构写入。
- 把用户 Pin 当成信任升级、永久物理运行承诺或 Agent 可编辑开关。

### Defer

- 模型在线训练、Memory meta-evolution、复杂 archive 搜索和 Branch 合并。
- 最终 Schema、状态枚举、阈值、评分公式、统计方法和隔离产品。
- 插件市场、自动更新、完整供应链平台和最高强度沙箱。
- 统一 canary / rollback / compensation 基础设施。
- Governance 与 Evaluation 自身的递归演化机制。

## 12. 结论

前沿研究没有把 Anthias 变成另一个 Coding Harness，反而让项目边界更清楚：

- DGM 说明分支谱系和 stepping stone 有价值；
- Mem2Evolve 说明经验与能力资产必须共同演进；
- AHE 说明修改必须可观察、可回滚并绑定可证伪预测；
- Agent libOS 说明 Action Space 可以变化，但权限边界不能跟着漂移；
- Continuity Kernel 说明保留状态不等于赋予权威，Candidate 与 accepted head 必须分离；
- AlphaEvolve 和 Evaluation 研究说明没有独立、可重复的评价，演化只是自我叙事。

Anthias 最适合的收敛仍是它自己的定义：

> 同一持续 Agent 依据真实、跨任务 Evidence 提出并编写能力变化；变化以 Candidate Revision 的形式进入受治理 Runtime，在 Safe Point 被激活或试运行，由独立证据决定是否推进 Agent HEAD；整个过程保留身份、权限、生命周期、用户约束与因果痕迹。

当前需要保留的是这一小组不变量，而不是把所有前沿论文机制一次性设计进系统。
