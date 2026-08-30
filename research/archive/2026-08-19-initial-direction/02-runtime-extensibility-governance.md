# Anthias 动态扩展、隔离与运行时治理研究

> 研究日期：2026-08-19
>
> 研究性质：架构研究，不是 Spec、Plan 或实现设计
>
> 证据范围：仅采用官方规范、官方文档、官方仓库源码/设计文档和论文原文；Anthias 现有项目定义与技术基线优先于外部系统
>
> 时效提示：本文核对的 MCP 当前规范版本为 `2026-07-28`。协议、扩展和生态清单仍在快速变化，落地前应重新核对。

## 0. 结论先行

本文使用以下标记强制区分证据层级：

- **[项目约束]**：来自 Anthias 当前项目定义、`AGENTS.md` 或技术基线，是本研究必须服从的不变量。
- **[来源事实]**：外部一手来源直接支持的事实，不自动成为 Anthias 的设计。
- **[推断]**：把来源事实放入 Anthias 约束后得到的判断，仍需要实际开发验证。
- **[建议]**：原则级适配方向；不冻结字段、状态枚举、阈值、模块布局或具体基础设施。

核心结论如下：

1. **[建议] Plugin、Capability、Provider、Tool、Skill、Workflow、MCP Server 和运行进程不能混成一个概念。** Plugin 更适合作为交付、命名与生命周期归属边界；Capability 是 Consumer 依赖的稳定合同；Provider 是合同的实现；Tool、Skill、Workflow 是可由 Provider 或 Plugin 贡献的不同形态；MCP 是其中一种远程或进程间适配协议，而不是 Anthias 的内部运行时模型。
2. **[建议] Agent 自己编写的组件与传统扩展应进入同一治理管线，但信任起点不能相同。** 二者都要经过候选产物、确定身份、能力解析、权限与隔离决策、健康验证、安全切换、独立 Evaluation、证据沉淀和可回滚 Revision；Agent 生成不能因为“作者就是自己”而获得隐式高信任。
3. **[推断] JDK 的 `ModuleLayer`、`ServiceLoader` 与独立 `ClassLoader` 可以提供模块发现和装载边界，却不能提供可靠安全沙箱，也不能保证热卸载。** JDK 已永久禁用 Security Manager；类能否卸载取决于定义它的 ClassLoader 是否可回收；Instrumentation 的重定义也保留现有对象、静态状态和活动栈帧。因此，Anthias 的通用热替换应以“新 Revision 并行准备、原子切换引用、旧 Revision 排空与释放”为语义，不以原地改写类为核心。[JEP 486](https://openjdk.org/jeps/486)；[JLS 12.7](https://docs.oracle.com/javase/specs/jls/se25/html/jls-12.html#jls-12.7)；[Instrumentation](https://docs.oracle.com/en/java/javase/25/docs/api/java.instrument/java/lang/instrument/Instrumentation.html)
4. **[建议] 隔离必须按风险分层。** 可信、窄合同、可审计的内部 Java Provider 才考虑进程内；普通子进程主要提供生命周期和故障边界，不等于安全沙箱；WASM/WASI 适合可以能力化、接口化的可移植组件；容器配合 gVisor 一类用户态内核适合任意本地工具的更强隔离；microVM 适合最高风险或多租户场景。当前不应锁死某一产品或阈值。
5. **[建议] 用户 pin 必须是 Stable Host 持有的治理约束，而不是 Agent 可编辑的提示词、扩展清单字段或 Agent Revision 内容。** RuntimeCoordinator 在提交任何结构变化前验证变化后的完整 Runtime Graph；不仅拒绝显式关闭，还要拒绝通过移除依赖、覆盖路由、关闭 Owner Scope、改变权限、回滚到缺失版本等方式间接使 pinned 对象失效。安全隔离可以停止故障进程，但不能顺带解除 pin；此时应保留用户意图并显式进入“已固定但不可满足”的退化状态。
6. **[推断] 主流 coding harness 的插件机制主要解决一次会话中的发现、安装、命名和工具暴露，不能直接承担 Anthias 的持续身份、跨任务 Evidence、Revision 分支、独立 Evaluation 与运行时治理。** Claude Code Plugin 和 OpenAI Agents SDK 可借鉴打包、MCP 适配、审批与过滤接口；OSGi 可借鉴 Bundle 生命周期、服务注册和解析模型；DGM、Voyager、Live-SWE-agent 可证明代码/技能自改进具有研究价值，但它们的实验评估不等于长期运行安全。
7. **[建议] 清单、签名、构建来源和行为安全必须分开。** Manifest 是声明；内容摘要标识确切产物；签名说明谁对什么字节签名；SLSA/in-toto 来源证明说明产物如何生成；测试、运行轨迹和独立 Evaluation 说明观察到的行为。任何单项都不能单独证明组件安全或适合长期挂载。

## 1. Anthias 约束映射

| Anthias 当前不变量 | 外部机制能提供什么 | 不能外包给外部机制的部分 | 本文判断 |
|---|---|---|---|
| Agent 有持续身份，模型只是 Cognitive Engine | Agent SDK 可提供调用循环、Tool/MCP 适配与会话状态 | Agent 身份、跨任务 Evidence、Revision HEAD、演进责任 | **[建议]** 外部 SDK/协议只能作为 Provider 或适配层，不成为 Anthias 的 Agent 本体 |
| Agent 只提交 Runtime Mutation Proposal；Governance 决策；RuntimeCoordinator 单写 | OSGi Resolver 可借鉴 Requirement/Capability 解析，MCP 可暴露动态工具集合 | 决策权、策略优先级、图变更提交、Ledger 与回滚 | **[建议]** 所有扩展变更归一为 Proposal，由单写 Control Plane 提交 |
| Consumer 只依赖 Capability 合同 | OSGi Service/Resolver、WIT world/interface、MCP Tool schema 都提供不同粒度的合同表达 | 跨形态统一语义、Provider 选择、健康与兼容性判断 | **[建议]** 内部 Capability 合同独立于 Java、MCP、WASM 等传输/实现形态 |
| 受管副作用有 Owner、Scope、释放语义 | `AutoCloseable`、OSGi Bundle/Service 生命周期、WIT resource handle 可表达局部所有权 | 跨组件副作用台账、反向释放、失败聚合、孤儿资源恢复 | **[建议]** 扩展必须接入统一 Owner/Scope；语言本地机制只是实现手段 |
| 外部进程统一由 ProcessSupervisor 持有 | MCP stdio 定义宿主启动和关闭服务器；JDK `ProcessHandle` 提供进程观察/终止 | 安全沙箱、资源配额、完整后代进程控制、恢复策略 | **[推断]** 所有进程型 MCP/Plugin 仍由 ProcessSupervisor 创建，MCP 客户端不能私自绕过 |
| Safe Point 才发生 MVP 结构变化 | OSGi 有生命周期切换；部分运行时有动态注册 | Anthias Action 边界、Composition Epoch、新旧快照一致性 | **[建议]** 协议通知只产生待处理变化，实际挂载/替换等待 Anthias Safe Point |
| Mutation 有前后状态、理由、结果 Evidence；Evolution 独立 Evaluation | in-toto 可绑定声明和精确产物；SLSA 描述构建来源；研究论文展示自动评估 | Anthias 的任务证据、反事实比较、长期效用和独立裁判 | **[建议]** 每次候选变更绑定产物摘要、提案、评估、提交结果与回滚依据 |
| 传统 Plugin/MCP/Skill 与 Agent 自写组件统一治理 | Claude Plugin 可打包 Skill/MCP/Hook；MCP 提供协议适配 | 统一的内部身份、生命周期、隔离、Revision 与 Governance | **[建议]** 统一的是治理闭环，不强行统一文件格式或执行载体 |
| 用户可强制开启，Agent 不得直接或间接关闭 | coding harness 常有 managed settings / enabled plugin 配置 | 图级不可绕过、跨 Revision 持久性、故障退化语义 | **[建议]** pin 属于 Agent Revision 之外的用户治理状态，并对变更后的完整图做不变量校验 |
| Stable Host 承担基础设施生命周期；Dynamic Runtime Pure Java | JDK 原生模块、线程、进程和 JFR 机制 | Spring 容器式动态 Bean 语义 | **[项目约束]** 不用 Spring AI 代替 Agent Loop，也不把 Dynamic Runtime 绑定到 Spring 生命周期 |

## 2. 插件、能力与组件的形态分类

### 2.1 三个正交维度

**[建议]** Anthias 应先把“贡献了什么”“如何执行”“怎样交付”分开，避免一个 `plugin` 标签同时承担过多含义。

| 维度 | 可能形态 | 核心问题 |
|---|---|---|
| 贡献形态 | Capability Provider、Tool、Skill、Prompt/Instruction、Workflow、Hook、Model/Memory/Storage Adapter、Evaluator、UI/Resource | Consumer 实际依赖什么合同；此贡献能产生什么副作用 |
| 执行形态 | 同 JVM、独立 JVM、普通本地进程、远程服务、MCP Server、WASM Component、容器、microVM | 信任边界、故障边界、资源 Owner、通信和退出语义 |
| 交付形态 | 内建 Revision、JAR/目录包、Claude/Codex 风格插件包、MCP registry 条目、OCI image、WASM binary、Agent 生成 Artifact | 如何确定身份、来源、版本、依赖、权限声明与可复现性 |

由此得到几个关键区分：

- **[建议] Capability** 是最小稳定依赖面，描述“能做什么”和兼容性；不暴露 Provider 的包格式或进程形态。
- **[建议] Provider** 是 Capability 的具体实现，可由内建代码、传统 Plugin、MCP Server、WASM Component 或 Agent 新写组件提供。
- **[建议] Plugin** 是一组贡献的分发、命名、配置和生命周期归属边界。一个 Plugin 可以提供多个 Capability/Tool/Skill；一个 Capability 也可以有多个候选 Provider。
- **[来源事实]** MCP 当前把 Server 能力分为 Resources、Prompts、Tools，使用 JSON-RPC；Tool 有输入/输出 JSON Schema，工具集合可以变化并通过通知告知客户端。工具名仅保证在单个 Server 内唯一，聚合器需要自己消歧。[MCP 2026-07-28 总规范](https://modelcontextprotocol.io/specification/2026-07-28)；[MCP Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- **[推断]** 因此 MCP Tool 名不能直接成为 Anthias 的全局 Capability 身份；MCP 的 `list_changed` 也只能触发重新发现或 Proposal，不能直接修改运行中依赖图。
- **[来源事实]** Claude Code Plugin 以目录和可选 `plugin.json` 清单打包 command、agent、skill、hook、MCP、LSP 等组件，并为插件贡献使用命名空间；安装后会缓存具体版本。[Claude Code Plugins Reference](https://code.claude.com/docs/en/plugins-reference)
- **[推断]** 这种 Plugin 适合作为 coding harness 的交付适配格式，但其“装好即可加入会话”的语义不足以替代 Anthias 的候选 Revision、隔离决策和独立 Evaluation。
- **[来源事实]** MCP Skills 工作组截至本文日期仍把 Skills over MCP 的 SEP 与参考实现列为进行中的交付物，且明确不覆盖通用 Plugin/Bundle 打包。[Skills over MCP Charter](https://modelcontextprotocol.io/community/working-groups/skills-over-mcp)
- **[建议]** Anthias 目前应保留 Skill Adapter 边界，不把内部 Skill Artifact 固化成尚在演进中的 MCP 扩展格式。

### 2.2 Manifest 应描述声明，不应成为权威

**[来源事实]** MCP Registry 的 `server.json` schema 描述服务器名称、版本、包或远程端点、仓库、传输、输入变量以及可选文件 SHA-256；schema 同时警告包参数可能造成 shell 注入，并建议避免经 shell 执行。[MCP Registry server schema](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/draft/server.schema.json)

**[来源事实]** OSGi 把 Bundle 的身份、导入/导出包、Requirement/Capability 与运行时 Wiring 分开；Resolver 对现有解析状态计算增量，并要求 mandatory Requirement 被满足。[OSGi Core 8 Resolver](https://docs.osgi.org/specification/osgi.core/8.0.0/service.resolver.html)

**[建议]** Anthias 的扩展描述需要覆盖下列语义，但本文不确定字段名、序列化格式或必填规则：

- 稳定逻辑身份与不可变产物身份（至少能定位到精确摘要）；
- 声明提供和需要的 Capability、兼容范围与冲突关系；
- 执行/传输形态和入口，但不得把任意命令字符串当成可信输入；
- 所需权限、文件/网络/进程/密钥/模型等受管副作用声明；
- Owner/Scope、启动/健康/排空/关闭合同和失败语义；
- 配置与 Secret 只声明引用或占位，不把敏感值写入 Artifact；
- 来源、构建、测试、签名、Evaluation 证据的引用；
- 用户 pin 所需的稳定引用语义，但 pin 本身不能由该 Manifest 掌控。

**[推断]** Manifest 是作者的主张，不能授予权限、证明行为安全或覆盖 Host 实际观察。Host 解析后的 Runtime Snapshot、Governance 决策和用户约束才是当前权威。

## 3. 生命周期与治理机制比较

| 系统/规范 | 来源事实 | 适合 Anthias 借鉴 | 不适合直接照搬 |
|---|---|---|---|
| MCP 2026-07-28 | 无状态、自包含请求和逐请求能力信息；Server 动态列出 Tool；stdio 客户端启动子进程并负责关闭；工具执行需要用户控制 | Tool/Resource/Prompt 适配、协议边界、动态发现、stdio 关闭合同、逐请求授权 | MCP 不定义 Anthias 的 Revision、Owner Graph、Evolution Evaluation 或单写 Control Plane；协议安全原则也不会自动执行策略 |
| Claude Code Plugin | 目录/manifest 打包 Skill、Hook、MCP 等；插件命名空间、安装 scope、版本缓存 | 传统 coding 插件导入、包内相对路径、贡献命名空间 | 主要面向用户启动的一次 coding harness；安装/启用不等于长期 Agent 的安全挂载和演进成功 |
| OpenAI Agents SDK | Agent 由 instructions、tools、handoffs、guardrails 等构成；支持 Function Tool、MCP 和 lifecycle hooks；官方明确允许使用底层 API 自建循环 | Tool/MCP adapter、审批/过滤、追踪集成思路 | SDK Agent 定义不能替代 Anthias 持续身份、自写 Runtime、独立 Evaluation 与 RuntimeCoordinator。[Agents](https://openai.github.io/openai-agents-python/agents/)；[Tools](https://openai.github.io/openai-agents-python/tools/)；[MCP](https://openai.github.io/openai-agents-python/mcp/)
| OSGi Core 8 | Bundle 有安装、解析、启动、停止、卸载等生命周期；Service 注册与 Bundle Owner 关联，Bundle 停止时注销服务；Resolver 处理 Requirement/Capability/Wiring | Provider 注册/撤销、Owner 生命周期、合同与实现分离、解析后 wiring | OSGi 的完整模块生态和状态模型规模较大；它不是恶意代码沙箱，也没有 Anthias 的 Proposal/Governance/Evidence 语义。[Framework API](https://docs.osgi.org/specification/osgi.core/8.0.0/framework.api.html)；[Service Layer](https://docs.osgi.org/specification/osgi.core/8.0.0/framework.service.html)
| Cordis | 官方仓库把 Context、Effect 和 Service 组织为可撤销的时空组合模型 | 与 Anthias 已确认的 Owner/Scope/反向释放方向相互印证 | 框架组合性本身不是隔离、供应链信任或演进治理。[Cordis repository](https://github.com/cordiverse/cordis)
| DGM | 论文在 coding-agent archive 中让 agent 修改 agent code，用 benchmark 选择并保留分支；搜索过程可保留暂时退步的分支 | Candidate Revision、分支探索、不能只保留单一贪心 HEAD | DGM 以多个 agent archive 为实验对象；Anthias 是一个持续身份下的 Revision/Branch，且要处理真实资源和用户约束。[Darwin Gödel Machine](https://arxiv.org/abs/2505.22954)
| Voyager | 论文在 Minecraft 中建立不断增长的可执行技能库，并用环境反馈、错误和自验证迭代技能 | Skill 作为带来源与运行证据的 Artifact；跨任务复用痕迹 | 论文中的自验证不能替代 Anthias 要求的独立 Evaluation，也不覆盖任意主机副作用。[Voyager](https://arxiv.org/abs/2305.16291)
| Live-SWE-agent | 论文研究 coding agent 在任务中动态修改 scaffold，并以 SWE benchmark 评估 | 说明运行时脚手架自修改可以产生效果 | benchmark 提升不证明长期宿主隔离、可回滚性、供应链完整性或 pin 不可绕过。[Live-SWE-agent](https://arxiv.org/abs/2511.13646)

### 3.1 Anthias 所需的生命周期语义

**[项目约束]** Anthias 已确定：结构变化进入 RuntimeCoordinator；执行中的 Action 不被无约束换依赖；新旧 Runtime 以 Safe Point 和 Composition Epoch 协调；失败时保留旧实现。

**[建议]** 在不冻结状态枚举的前提下，一次挂载或替换至少需要满足以下因果顺序：

1. 候选 Artifact 与 Proposal 被固定到不可变身份，解析其贡献、依赖、权限和来源证据；
2. 在不影响当前 Runtime 的区域准备候选 Provider，并为它分配独立 Owner/Scope；
3. 验证 Capability 可解析、权限可接受、pin 不变量仍满足，并执行与风险相称的健康/契约/Evaluation；
4. 到达 Anthias Safe Point 后，由 RuntimeCoordinator 单次提交新的 Runtime Graph 与 Composition Epoch；
5. 新快照只交给后续 cognition/action，旧 action 继续持有旧快照直至完成或按明确取消语义结束；
6. 对新图进行实际 reconcile 和稳定性观察；如果切换失败，恢复旧图，而不是在半提交状态继续；
7. 旧 Revision 排空后按依赖反向顺序释放；每项释放结果进入 Evidence，失败产生可恢复的残留记录；
8. 独立 Evaluation 决定该变化能否成为 Agent HEAD 或保留为 Branch；“挂载成功”不等于“演进成功”。

**[推断]** MCP 的 tools/list changed、文件监听、Plugin 目录变化或 Agent 新产物都只是发现事件。若它们可绕过 Proposal 直接重建工具表，就会破坏 Anthias 的单写、Safe Point、pin 和可追踪性。

### 3.2 Single Writer 不意味着单线程执行

**[来源事实]** JDK 25 的 Virtual Threads 面向大量阻塞型 task-per-thread 工作，不应作为需要复用的池化资源；`ScopedValue` 提供在限定动态范围内不可变、可继承的上下文绑定。[JEP 444](https://openjdk.org/jeps/444)；[JEP 506](https://openjdk.org/jeps/506)

**[建议]** Anthias 可并发准备、探测和执行 Provider，但只有 RuntimeCoordinator 能提交结构状态。候选准备所读到的 Composition Epoch 必须在提交前复核；过期候选应重新解析或拒绝，而不是覆盖新状态。虚拟线程和 ScopedValue 适合携带 Run/Agent/Revision/Owner/Trace 等执行上下文，不负责仲裁图变更。

### 3.3 多次任务痕迹如何成为组件演进依据

**[项目约束]** Anthias 的组件自写不是 coding harness 在单个任务中临时生成一段脚本。持续 Agent 要保留多次任务的痕迹：某类步骤反复耗时、同一接口反复试错、工具选择频繁回退、上下文反复重建、资源反复泄漏或人工总在同一位置介入，都可以成为后来自省的 Evidence。

**[建议]** Evidence 应先描述可复核的发生事实，再由 Reflection 形成“某个稳定瓶颈可以被 Plugin/Provider/Skill/Workflow 改进”的假设。Agent 随后可以编写源码、说明、测试、Manifest 或适配器，但这些仍只是 Candidate Artifact 和 Runtime Mutation Proposal；不能因为问题与作者都属于同一个 Agent，就跳过来源绑定、隔离和独立 Evaluation。

**[建议]** Evaluation 需要把候选与原 Revision 在相关任务切片上比较，并观察正确性、耗时/成本、失败模式、权限与资源副作用。一次任务偶然更快只形成弱证据；候选被拒绝、回滚或只在部分任务有效也应保留在 Branch/Evidence 中，供后续改进，不等于创建了一个新的 Agent 身份。

**[推断]** DGM、Voyager 和 Live-SWE-agent 分别展示了代码 archive、技能库和任务内 scaffold 自修改的可行性信号，但 Anthias 比这些实验多出长期身份、真实 Host 资源、用户 pin 和跨 Run 治理。因此能借鉴的是“保留候选与评估痕迹”，不是把 benchmark 自验证直接复制为生产晋升条件。

## 4. JVM 动态加载与热替换的真实边界

### 4.1 可用机制

- **[来源事实]** `ModuleLayer` 表示一个模块图，可以用一个或多个 ClassLoader 定义模块；Layer 之间存在父关系。[JDK 25 ModuleLayer](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/lang/ModuleLayer.html)
- **[来源事实]** `ServiceLoader` 按 service type 发现 provider，也可以针对 ModuleLayer 加载；它解决发现，不解决 Provider 优先级、授权、健康、释放或治理。[JDK 25 ServiceLoader](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/ServiceLoader.html)
- **[来源事实]** JVM 只有在定义类的 ClassLoader 可被垃圾回收时才可能卸载该类；重新加载会重新运行初始化逻辑，静态状态、native 资源和外部引用会影响可回收性。[JLS 25 §12.7](https://docs.oracle.com/javase/specs/jls/se25/html/jls-12.html#jls-12.7)
- **[来源事实]** Instrumentation 的 redefine/retransform 能力是可选的，活动栈帧继续执行旧字节码，已有实例与静态字段不被重置，并且可修改范围受限。[JDK 25 Instrumentation](https://docs.oracle.com/en/java/javase/25/docs/api/java.instrument/java/lang/instrument/Instrumentation.html)
- **[来源事实]** Security Manager 在 JDK 24 已永久禁用，不能再作为进程内插件权限沙箱。[JEP 486](https://openjdk.org/jeps/486)

### 4.2 对 Anthias 的含义

**[推断]** 同 JVM 动态模块适合被 Host 信任、合同很窄、依赖可控且能严格释放的组件，主要价值是低延迟和直接类型合同。它不适合未经信任的 Agent 生成代码，也不适合把“ClassLoader 已丢弃”当成资源已经安全回收的证明。

**[建议]** Java Provider 的热替换使用 Revision 隔离，而非原地 class hot swap：候选 Revision 使用新的加载边界和 Owner Scope；Consumer 只通过 Host 所持 Capability 代理/句柄切换；旧实例不再接受新调用，排空后释放；如果 ClassLoader 仍可达，JFR/诊断证据应把它记录为泄漏或残留，而不是假装卸载完成。

**[建议]** 不让 Plugin 把自己的实现类、线程、Executor、ClassLoader 或进程句柄传播给 Consumer。公开合同中的值应来自 Stable API 或可序列化边界；否则 Provider 替换后，旧 ClassLoader 很容易被长生命周期对象钉住。

## 5. 资源所有权、停止与恢复

**[来源事实]** `AutoCloseable.close()` 的语义是释放对象持有的资源；JDK 文档建议实现优先标记已关闭并释放基础资源，再抛出失败，并强烈鼓励幂等关闭。[JDK 25 AutoCloseable](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/lang/AutoCloseable.html)

**[来源事实]** OSGi Service 的注册者是 Bundle，停止 Bundle 会注销其服务；`ServiceFactory` 还定义了针对使用方 Bundle 创建和释放服务实例的钩子。[OSGi Service Layer](https://docs.osgi.org/specification/osgi.core/8.0.0/framework.service.html)

**[来源事实]** MCP stdio 传输由客户端把 Server 作为子进程启动，以 stdin/stdout 交换 JSON-RPC；关闭时客户端先关闭输入并等待，必要时再终止进程；异常退出后可选择重启。[MCP stdio transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)

**[来源事实]** JDK `ProcessHandle` 能观察存活、后代和退出并请求终止，但文档警告进程信息存在竞态，进程标识也可能被操作系统复用。[JDK 25 ProcessHandle](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/lang/ProcessHandle.html)

**[建议]** Anthias 的 Owner/Scope 至少覆盖：注册的 Capability、线程/任务、定时器、文件句柄、网络连接、临时目录、ClassLoader、进程树、端口、订阅/监听、缓存、模型或密钥租约。`AutoCloseable` 是每项资源的释放接口，不是全局生命周期本身。

**[建议]** 所有进程型 Plugin/MCP Server 必须由 `ProcessSupervisor` 创建并分配稳定的内部 owner/process identity。插件只能获得受限的调用或状态视图，不能持有不受管的原始进程创建能力。终止时按“停止接新工作 → 请求优雅退出 → 限时排空 → 终止受管进程树 → 回收其余 Owner 资源 → 记录残留”执行；具体时限后续用实际观测决定。

**[推断]** 普通子进程能阻止崩溃直接破坏 Host 堆，却默认仍继承操作系统用户权限、文件和网络可见性。它是故障边界与生命周期边界，不是安全沙箱。

## 6. 隔离强度与演进路径取舍

### 6.1 隔离矩阵

| 执行边界 | 能提供的主要价值 | 不能默认保证 | 适合的 Anthias 场景 | 主要代价 |
|---|---|---|---|---|
| 同 JVM + ModuleLayer/ClassLoader | 低延迟、直接 Java 合同、易观测 | 恶意代码隔离、确定卸载、阻止 `System.exit`/native/文件网络访问 | Host 内建或经过高信任审查的窄 Provider | ClassLoader 泄漏、全局状态污染、崩溃影响 Host |
| 独立 JVM / 普通进程 | 堆和崩溃边界、明确启动/退出、语言自由 | 文件/网络/CPU/内存权限隔离；逃逸后的宿主保护 | 受信但不稳定的 MCP/Plugin、开发期 Agent 组件 | IPC、序列化、进程治理、仍需 OS 权限控制 |
| WASM Component + WASI | 默认无环境能力、由 Host 授权；WIT 合同和资源句柄；可移植 | 引擎零漏洞、任意 native/JVM 生态兼容、自动正确授权 | 能被接口化的 Agent 自写计算/转换/有限 I/O 组件 | ABI/组件工具链、宿主函数设计、调试与生态约束 |
| 容器 + gVisor/同类用户态内核 | 文件系统/namespace/cgroup 加固，加一道 syscall 隔离层 | 自动网络策略、绝对抗逃逸、任意 workload 完全兼容 | 任意本地工具、编译器、传统 Plugin 的较强隔离 | Linux 平台依赖、启动/运维成本、兼容性 |
| microVM（如 Firecracker） | 独立 guest kernel、极小设备模型、强工作负载边界 | 自动阻止 egress、自动资源策略、零虚拟化漏洞 | 高风险生成代码、多租户或高价值 Secret 周边 | KVM/Linux、镜像与启动管理、最重的观测/运维 |
| 远程托管服务 | Host 进程与执行环境分离，可由服务侧隔离 | 数据出境安全、服务可信、稳定性、成本 | 明确授权的 SaaS/MCP Remote Provider | 网络、身份授权、隐私、可用性与供应链依赖 |

### 6.2 一手来源给出的边界

- **[来源事实]** WASI 采用 capability-oriented 接口：实例启动时没有环境资源的默认访问权，由 Host 显式提供；WASI 0.2 基于 WebAssembly Component Model。[WASI overview](https://wasi.dev/)；[WASI 0.2](https://wasi.dev/releases/wasi-p2)
- **[来源事实]** WIT 用 interface/world 描述组件导入和导出，并把资源表示为带 ownership、borrowing 与 drop 语义的 handle。[WIT design](https://component-model.bytecodealliance.org/design/wit.html)
- **[来源事实]** Wasmtime 把执行不可信 WebAssembly 作为安全目标，并说明 WASI 文件访问遵循显式目录能力；其安全文档也强调引擎缺陷和终端控制序列等宿主交互仍需防御。[Wasmtime Security](https://docs.wasmtime.dev/security.html)
- **[来源事实]** gVisor 在 workload 与 Host kernel 之间实现用户态应用内核并拦截系统调用；其安全文档明确把 cgroup 资源控制和网络策略视为额外责任，而不是自动包含。[gVisor Architecture](https://github.com/google/gvisor/blob/master/g3doc/architecture_guide/intro_to_gvisor.md)；[gVisor Security](https://gvisor.dev/docs/architecture_guide/security/)
- **[来源事实]** Firecracker 用 KVM microVM、最小化设备模型、seccomp/cgroup/namespace/jailer 等多层防御；官方生产主机文档仍要求宿主正确配置，并不把网络出口策略自动包含在 microVM 边界内。[Firecracker Design](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md)；[Production host setup](https://github.com/firecracker-microvm/firecracker/blob/main/docs/prod-host-setup.md)

### 6.3 原则级演进方向

**[建议]** 不为未来可能存在的最高风险预建全套平台；但 Capability 调用、Owner、Artifact 和 ProcessSupervisor 的合同从一开始就不能假定“所有 Provider 永远同 JVM”。这样才能在实际风险出现时把某一 Provider 从进程内移动到进程、WASM、容器或 microVM，而不改变 Consumer。

**[建议]** 隔离选择应由输入因素驱动，而不是固定“插件类型 = 沙箱等级”：代码来源与审核状态、需要的权限、Secret/数据敏感度、网络/文件/进程副作用、可否接口化、失败爆炸半径、是否多租户、性能与平台能力。本文不定义评分算法和阈值。

**[建议]** Agent 新生成的可执行代码默认不进入 Host JVM；它可以先作为不可变 Candidate Artifact 在更强边界中构建、测试和 Evaluation。只有实际证据和明确治理决策才能提升信任，且信任提升不能由提出变化的 Agent 单方面完成。

## 7. Provenance、签名、供应链与回滚

### 7.1 四类证据不能混用

| 证据 | 能回答 | 不能回答 |
|---|---|---|
| 内容摘要 | 当前加载的是哪一组确切字节；是否被修改 | 谁构建、为何构建、代码是否安全 |
| 签名/证书/透明日志 | 某身份是否对该摘要签名；验证材料是否完整 | 签名者是否可信；实现是否符合声明 |
| Build Provenance | 产物由什么构建入口、参数、依赖和平台产生；不同等级有不同防篡改保证 | 运行时行为一定正确或无恶意逻辑 |
| 测试、运行轨迹与独立 Evaluation | 在给定环境、输入和观察窗口内发生了什么 | 未覆盖输入下的普遍正确性；来源完整性 |

**[来源事实]** SLSA 1.2 把 Provenance 用于描述 artifact 在哪里、何时、如何生成；Build Track 从存在 provenance 到由托管平台签名、再到强化构建平台逐步提高保证。[SLSA 1.2 Provenance](https://slsa.dev/spec/v1.2/provenance)；[Build Track](https://slsa.dev/spec/v1.2/build-track-basics)

**[来源事实]** in-toto Attestation Framework 把 subject 绑定到 Statement，把具体语义放在 Predicate，并用 Envelope/Bundle 承载认证与验证材料；官方 predicate 集合包含 SLSA provenance、测试结果和运行轨迹等不同声明类型。[in-toto Attestation Framework](https://github.com/in-toto/attestation/blob/main/spec/README.md)；[Predicate types](https://github.com/in-toto/attestation/blob/main/spec/predicates/README.md)

**[来源事实]** Sigstore Bundle 聚合签名、证书、透明日志等离线验证材料；Cosign 验证仍需要检查期望 identity、issuer 和 digest，而不是只看“签名有效”。[Sigstore Bundle](https://docs.sigstore.dev/about/bundle/)；[Cosign verification](https://docs.sigstore.dev/cosign/verifying/verify/)

**[来源事实]** JDK `jarsigner` 能签名或验证 JAR 的签名、证书链和时间戳，这解决 JAR 完整性/签名检查，不提供构建过程或行为证明。[JDK 25 jarsigner](https://docs.oracle.com/en/java/javase/25/docs/specs/man/jarsigner.html)

**[来源事实]** TUF 的元数据和客户端更新流程专门处理回滚、冻结、密钥轮换与仓库妥协等软件更新攻击。[TUF Specification 1.0.26](https://theupdateframework.github.io/specification/v1.0.26/)

### 7.2 Anthias 适配

**[建议]** Agent 自写组件的最小证据链应能从 Proposal 追到源 Artifact、构建环境/输入、精确二进制摘要、测试/Evaluation、运行时挂载 Revision、每次调用/故障的 Trace，以及最后的接受、拒绝或回滚决定。现阶段只确定“可追溯关系”，不确定 attestations 的具体 schema 或签名平台。

**[建议]** 传统插件同样必须落到精确 Artifact 身份。Registry 名称、Git tag、包版本和 URL 不是不可变身份；下载后解析、验证和实际加载的必须是同一摘要。

**[建议]** 回滚对象是经过验证的完整 Revision/Runtime Graph，而不是在原目录覆盖几个文件。回滚也要经过 pin、兼容性、权限和当前数据迁移条件检查；旧二进制仍存在不代表旧 Revision 当前可安全恢复。

**[建议]** 如果未来从远程 registry 自动更新，再评估 TUF/Sigstore/SLSA 的具体组合。目前不预建 marketplace、PKI、透明日志或全自动更新系统，但产物身份与 Evidence 关系不能阻碍以后接入。

## 8. 用户 pin 的不可绕过语义

### 8.1 pin 是治理约束，不是普通启用开关

**[项目约束]** 用户强制开启扩展或能力后，Agent 不能自行关闭、卸载、替换或间接使其失效。

**[建议]** pin 必须满足以下语义：

1. **权威归属**：pin 由 Stable Host 的用户治理域持有，位于 Agent 可修改的 Revision、Prompt、Manifest、Memory 和 Plugin 存储之外。只有具备用户授权的操作能创建、改变或解除 pin。
2. **明确目标**：产品必须区分“固定确切 Artifact/Provider Revision”和“固定某个 Capability 始终可用”。前者禁止替换；后者是否允许满足合同的 Provider 替换由用户策略决定。本文不选择默认值或字段模型。
3. **图级验证**：RuntimeCoordinator 在提交 Proposal 之前验证结果 Runtime Graph，而不是对操作名称做 denylist。任何导致 pinned 目标在新图中不可达、不可调用或不再满足合同的变化都必须拒绝。
4. **防间接绕过**：至少覆盖显式 disable/unmount/uninstall/replace，以及删除依赖、关闭 Owner Scope、改变 Provider precedence 造成 shadow、移除路由、撤回权限、破坏配置、让版本/协议不兼容、回滚到缺失目标、用同名伪 Provider 取代等间接方式。
5. **跨 Revision 持久**：Agent HEAD 切换、Branch 合并、回滚、模型切换、Run 结束和 Host 重启都不能隐式改变 pin。
6. **可观测**：Runtime Snapshot 同时呈现用户期望、实际 Provider、健康、依赖满足和最近失败。Agent 可以观察 pin，但不能伪造其 actor、来源或状态。
7. **冲突失败关闭**：Mutation 与 pin 冲突时，不提交部分变化；Ledger 记录被拒绝的 Proposal、冲突路径和当前图。Agent 可以提出修复建议，不能把拒绝解释为已经完成。

### 8.2 安全动作不等于解除 pin

**[推断]** “永远保持进程运行”与“用户意图不可被 Agent 取消”不是一回事。如果 pinned Provider 崩溃、泄漏资源、违反权限或疑似恶意，Host 必须仍能隔离、终止或阻止调用，否则 pin 会反过来成为绕过安全控制的权限。

**[建议]** Host 执行安全隔离时保留 pin 记录，并把状态显式标记为“期望仍固定，但当前不可满足/已隔离”。随后只能走符合 pin 语义的恢复：重启同一确切 Revision、修复外部依赖，或在 capability pin 允许时切换合格 Provider；否则等待用户修改 pin。安全动作不能偷偷降级成 unpin。

**[来源事实]** MCP 规范要求用户保持对工具暴露和调用的控制，并把 Tool annotation 当作不可信声明；MCP 本身也明确不能在协议层强制落实所有安全原则。[MCP Security and Trust & Safety](https://modelcontextprotocol.io/specification/2026-07-28#security-and-trust--safety)

**[来源事实]** MCP 的本地 Server 安装安全要求指出，一键安装可能等同于执行任意命令，要求展示准确命令/参数、危险性、明确同意和取消路径；文档把沙箱和签名列为进一步降低剩余风险的方向。[SEP-1024](https://modelcontextprotocol.io/seps/1024-mcp-client-security-requirements-for-local-server-)

**[推断]** 因此“用户 pin 了 Plugin”不等于“用户预先批准该 Plugin 将来的每次 Tool 调用、任意新权限或自动更新”。存在/可用性约束、每次调用授权、权限扩张和版本更新应是不同治理问题。

## 9. MCP、Skill 与传统 Plugin 的兼容原则

### 9.1 MCP

**[来源事实]** MCP 2026-07-28 使用无状态、自包含请求和逐请求 capability/identity/protocol metadata；扩展需要双方显式支持；Server 的 Tool 集合可以按授权变化并通知缓存更新。[MCP Specification](https://modelcontextprotocol.io/specification/2026-07-28)；[MCP Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)

**[建议]** Anthias 对 MCP 做边缘适配：把一个 MCP Server 视为 Provider 容器，把 Tool/Resource/Prompt 映射为 Anthias 贡献；保留 server namespace 和确切连接/Artifact 身份；把 schema 当作调用合同的一部分；把 authorization、timeout、rate limit、输入输出验证、secret 和 transport 归入 Host Governance。远端与 stdio Server 使用不同 Owner/恢复语义，但都不能绕过 Capability 选择和 pin。

### 9.2 Skill

**[建议]** Skill 首先是可版本化的认知/工作流 Artifact，不应默认获得执行权限。纯说明型 Skill 可以在较轻边界中解析；引用脚本、MCP、资源或外部命令的 Skill 必须把每项依赖解析为受管 Capability，不能因为入口文件是文本就继承信任。

**[推断]** Skill 的文本内容还会进入模型上下文，风险不只在操作系统副作用，也包括提示注入、错误长期记忆和工具选择偏置。因此 Skill 的 Evaluation 需要任务效果、触发准确性、上下文成本和副作用，而不是只检查文件格式。

### 9.3 传统 Plugin

**[建议]** 对 Claude/Codex/其他 coding harness Plugin 采用 importer/adapter，而不是让其目录约定成为 Anthias 核心模型。导入时拆解其中的 Skill、MCP、Hook、Command 等贡献，分别解析合同和权限；保留原始包的 namespace/provenance；不支持的贡献应显式标记，不做静默近似。

**[推断]** coding harness Hook 常假设一次命令/会话生命周期，并可能直接执行 shell；在 Anthias 的长期 Agent 中，Hook 必须重新归属 Owner/Scope、隔离和 Safe Point。直接兼容文件格式不等于兼容执行语义。

## 10. 原则级适配建议

下面只给出稳定原则，不是实现路线或模块清单。

1. **[建议] 内核最小、扩展统一**：保护 Agent Identity、Ledger 权威、Governance、RuntimeCoordinator、Artifact 身份解析和基础资源监管；其余能力尽可能通过合同扩展，但不要为了“可扩展”提前抽象未发生的 Feature。
2. **[建议] 合同先于载体**：Consumer 只看 Capability；Java interface、MCP schema、WIT interface 等由各 adapter 翻译到合同，不让 transport 泄漏到业务依赖。
3. **[建议] 同一治理闭环、不同信任起点**：传统签名组件、用户本地 Plugin、远端 MCP、Agent 生成代码都经过同一 Proposal → Evaluation → Commit/Reject 流程；来源影响隔离和审批，不改变治理所有权。
4. **[建议] 先生成 Candidate，不直接改活体**：Agent 可以写源代码、Manifest、测试和迁移说明，但产物先进入不可变 Candidate Revision；活体 Runtime 只接收 RuntimeCoordinator 已验证的图切换。
5. **[建议] 安装、挂载、可用、选择、调用、演进成功分开**：一个包存在不表示已运行；健康不表示被 Consumer 选中；被选中不表示每次调用获批；调用成功不表示跨任务演进有效。
6. **[建议] 权限以 Host 实际授予为准**：Manifest 声明需求，Governance 决定 grant；Provider 只能获得必要 capability handle，不获得 Host 全局对象或通用进程/文件系统入口。
7. **[建议] 变更后的图是校验对象**：依赖满足、owner closure、pin、权限、兼容性和安全边界必须在完整候选图上验证，防止把一次危险替换拆成数个看似无害 Proposal。
8. **[建议] 切换与 Evaluation 解耦**：试运行/挂载成功是运行时事实；能否提升 HEAD 是演进判断。提出修改的 Agent不能成为唯一裁判。
9. **[建议] 失败也保留价值**：构建失败、解析失败、被 pin 拒绝、运行泄漏、任务退化和回滚都进入 Evidence，可成为以后自省和组件改进的素材。
10. **[建议] 对外兼容可插拔**：MCP/Skill/Plugin 适配器允许随生态演进升级，内部 Runtime Graph、Identity 和 Evidence 不随外部草案格式重写。

## 11. 明确拒绝或暂缓的做法

### 11.1 明确拒绝

- **[拒绝]** 用 Spring AI 或任意外部 Agent SDK 替代 Anthias 自己的 Agent Loop 与运行时语义。
- **[拒绝]** 允许 Agent 生成代码后直接覆盖当前加载目录、修改 protected core 或绕过 Candidate/Evaluation 进入活体 Runtime。
- **[拒绝]** 把 `ClassLoader`、ModuleLayer、普通子进程或 Docker 本身宣传成完整恶意代码沙箱。
- **[拒绝]** 在 JDK 25 上依赖 Security Manager 做权限隔离。
- **[拒绝]** 让 Plugin/MCP client/Skill script 自行创建不受 `ProcessSupervisor` 管理的外部进程。
- **[拒绝]** 用 Tool/Plugin 名称或版本号代替不可变 Artifact 身份；用 Manifest 声明代替 Host 授权；用签名代替行为 Evaluation。
- **[拒绝]** 把 MCP 的动态列表通知、文件监听或插件自更新直接变成 Runtime Graph 写操作。
- **[拒绝]** 把 pin 实现为 Agent 可编辑配置，或只拦截名为 `disable` 的直接操作而不检查结果图。
- **[拒绝]** 因安全隔离、崩溃或回滚而静默解除用户 pin，或谎报 pinned 能力仍健康。
- **[拒绝]** 让提出 Runtime Mutation 的 Agent 单方面证明演进成功。

### 11.2 当前暂缓

- **[暂缓]** 固定内部 Manifest schema、Capability 版本算法、兼容性评分或 Provider 选择公式；应由首批真实组件暴露需求。
- **[暂缓]** 全套 OSGi 实现、通用插件市场、自动远程更新、组织级 PKI、透明日志和 TUF 仓库；保留接入所需的 Artifact/Provenance 边界即可。
- **[暂缓]** 选定 Wasmtime、gVisor、Firecracker 或某个容器编排方案；先由实际 workload、宿主平台和风险验证。
- **[暂缓]** 把 Skills over MCP 作为唯一 Skill 格式；当前工作组交付仍在演进。
- **[暂缓]** 通用原地 Java hot reload；优先 Revision 并行准备和引用切换。
- **[暂缓]** 为所有组件强制最高等级隔离；这会在没有实际风险证据时引入不必要的平台和运维成本。
- **[暂缓]** 确定 pin 的具体存储结构、UI、精确状态枚举和恢复次数；这里只冻结不可绕过语义。

## 12. 来源表

下表全部是一手来源；“支撑范围”刻意写窄，避免把来源扩张成它没有证明的结论。

| # | 一手来源 | 类型/版本 | 本文使用的事实边界 |
|---:|---|---|---|
| 1 | [MCP Specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28) | 官方规范 | JSON-RPC、Host/Client/Server、无状态请求、能力和安全原则 |
| 2 | [MCP Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) | 官方规范 | Tool schema、动态列表、命名范围、annotation 不可信、授权相关行为 |
| 3 | [MCP stdio transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio) | 官方规范 | 子进程启动、stdio 通信和关闭语义 |
| 4 | [SEP-1024](https://modelcontextprotocol.io/seps/1024-mcp-client-security-requirements-for-local-server-) | 官方 SEP | 本地 Server 安装的任意代码执行风险与用户同意要求 |
| 5 | [MCP Registry server schema](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/draft/server.schema.json) | 官方仓库 schema | registry manifest 字段、hash 与 shell injection 警告 |
| 6 | [Skills over MCP Charter](https://modelcontextprotocol.io/community/working-groups/skills-over-mcp) | 官方工作组 | 当前交付状态和 bundle/package 非目标范围 |
| 7 | [Claude Code Plugins Reference](https://code.claude.com/docs/en/plugins-reference) | 官方产品文档 | 插件 manifest、贡献类型、namespace、缓存和安装 scope |
| 8 | [OpenAI Agents SDK: Agents](https://openai.github.io/openai-agents-python/agents/) / [Tools](https://openai.github.io/openai-agents-python/tools/) / [MCP](https://openai.github.io/openai-agents-python/mcp/) | 官方开源文档 | Agent SDK 的工具、MCP、guardrail/hook 组合边界 |
| 9 | [OSGi Core 8 Framework API](https://docs.osgi.org/specification/osgi.core/8.0.0/framework.api.html) | 官方规范 | Bundle 身份、状态与生命周期 |
| 10 | [OSGi Core 8 Service Layer](https://docs.osgi.org/specification/osgi.core/8.0.0/framework.service.html) | 官方规范 | Service 注册、Bundle Owner、自动注销和 ServiceFactory |
| 11 | [OSGi Resolver](https://docs.osgi.org/specification/osgi.core/8.0.0/service.resolver.html) | 官方规范 | Resource/Requirement/Capability/Wire/Wiring 和解析增量 |
| 12 | [Cordis](https://github.com/cordiverse/cordis) | 官方源码仓库 | Context/Effect/Service 的可组合与撤销模型 |
| 13 | [JDK 25 ModuleLayer](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/lang/ModuleLayer.html) / [ServiceLoader](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/ServiceLoader.html) | JDK 官方 API | JVM 模块图、ClassLoader 与 Provider 发现 |
| 14 | [JLS 25 §12.7](https://docs.oracle.com/javase/specs/jls/se25/html/jls-12.html#jls-12.7) / [Instrumentation](https://docs.oracle.com/en/java/javase/25/docs/api/java.instrument/java/lang/instrument/Instrumentation.html) | Java 官方规范/API | 类卸载和原地重定义的限制 |
| 15 | [JEP 486](https://openjdk.org/jeps/486) | OpenJDK JEP | Security Manager 永久禁用 |
| 16 | [JDK 25 AutoCloseable](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/lang/AutoCloseable.html) / [ProcessHandle](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/lang/ProcessHandle.html) | JDK 官方 API | 本地资源关闭和 OS 进程观察/终止的边界 |
| 17 | [JEP 444](https://openjdk.org/jeps/444) / [JEP 506](https://openjdk.org/jeps/506) | OpenJDK JEP | Virtual Threads 与 Scoped Values 的适用语义 |
| 18 | [WASI](https://wasi.dev/) / [WIT](https://component-model.bytecodealliance.org/design/wit.html) | 官方规范文档 | capability-oriented 环境访问、组件接口和 resource handle |
| 19 | [Wasmtime Security](https://docs.wasmtime.dev/security.html) | 官方运行时文档 | WASM/WASI 沙箱目标及剩余宿主风险 |
| 20 | [gVisor Architecture](https://github.com/google/gvisor/blob/master/g3doc/architecture_guide/intro_to_gvisor.md) / [Security](https://gvisor.dev/docs/architecture_guide/security/) | 官方设计文档 | 用户态内核、syscall 隔离与额外资源/网络责任 |
| 21 | [Firecracker Design](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md) | 官方设计文档 | microVM、最小设备面和多层宿主防御 |
| 22 | [SLSA 1.2 Provenance](https://slsa.dev/spec/v1.2/provenance) / [Build Track](https://slsa.dev/spec/v1.2/build-track-basics) | 官方供应链规范 | 构建来源及不同保证等级 |
| 23 | [in-toto Attestation Framework](https://github.com/in-toto/attestation/blob/main/spec/README.md) | 官方规范 | subject/predicate/envelope/bundle 的证明结构 |
| 24 | [Sigstore Bundle](https://docs.sigstore.dev/about/bundle/) / [Cosign verification](https://docs.sigstore.dev/cosign/verifying/verify/) | 官方文档 | 签名验证材料与 identity/issuer/digest 检查 |
| 25 | [TUF Specification 1.0.26](https://theupdateframework.github.io/specification/v1.0.26/) | 官方规范 | 更新系统的回滚、冻结和仓库妥协防御 |
| 26 | [Darwin Gödel Machine](https://arxiv.org/abs/2505.22954) | 论文原文 | coding agent 自改代码、archive/branch 与 benchmark evaluation |
| 27 | [Voyager](https://arxiv.org/abs/2305.16291) | 论文原文 | 可执行技能库和环境反馈迭代 |
| 28 | [Live-SWE-agent](https://arxiv.org/abs/2511.13646) | 论文原文 | coding scaffold 的任务内自修改实验 |

## 13. 事实、推断与建议汇总

### 13.1 来源可以直接证明的事实

- MCP 能标准化 Tool/Resource/Prompt 连接、动态发现和若干传输/安全要求，但规范承认许多安全原则必须由 Host 实施。
- OSGi 证明在 JVM 生态中可以把模块生命周期、服务合同、注册/注销和依赖解析分离；它并非不可信代码沙箱。
- JDK 25 提供模块层、服务发现、虚拟线程、Scoped Values、进程观察和 JFR 等基础机制；Security Manager 已不可用，类卸载与重定义受明确限制。
- WASI/WIT、gVisor 与 Firecracker 提供由轻到重的不同隔离构件；每一种都有宿主配置、权限和剩余风险。
- SLSA、in-toto、Sigstore、TUF 分别处理构建来源、证明结构、签名验证材料和安全更新问题，不证明业务行为正确。
- DGM、Voyager 与 Live-SWE-agent 说明代码/技能自修改在限定实验环境中可能提升任务表现，但论文没有证明 Anthias 式长期 Agent 的运行时安全与治理。

### 13.2 基于 Anthias 约束的推断

- 外部协议和 coding harness 插件机制应该成为 Anthias Provider/Artifact 的适配入口，而不是内部权威模型。
- Agent 自写组件最危险的不是“能生成文件”，而是生成物若能绕过候选身份、隔离、Safe Point、独立 Evaluation 和回滚直接进入活体 Runtime。
- 可靠热替换的关键是新旧 Revision 并存和引用切换，而不是让类或目录原地变形。
- 防 pin 绕过必须检查最终 Runtime Graph 的可满足性，单独封禁若干 API 名称不够。
- 隔离、Provenance、行为 Evaluation 和用户授权是互补控制，不能彼此替代。

### 13.3 本研究给出的适配建议

- 建立传输无关的 Capability 合同、Provider 身份和 Owner/Scope 语义。
- 让传统扩展与 Agent 生成扩展走同一治理闭环，但按来源和权限决定隔离起点。
- 把 RuntimeCoordinator 保持为结构变化 Single Writer，动态发现只生成 Proposal。
- 把 pin 放在 Stable Host 用户治理域，并在每次图提交前做直接与传递不变量检查。
- 从可信同 JVM到进程、WASM、强化容器、microVM 保留可替换的执行边界，不提前选定全局唯一沙箱。
- 用精确 Artifact 摘要把源、构建、签名、测试、Evaluation、运行 Trace 与 Revision 串起来。

## 14. 证据边界与后续复核点

- 本研究没有运行任何第三方 Runtime、恶意样本、ClassLoader 泄漏实验、WASM/container/microVM benchmark，也没有验证 Anthias 代码，因为当前对话不涉及代码实现。
- 外部官方文档只证明各自系统的公开语义；对 Anthias 的适用性均已标记为 **[推断]** 或 **[建议]**。
- 论文结果来自其特定 benchmark、模型和实验配置，不能外推为长期生产安全或必然自进化收益。
- 当前 MCP 版本较新，Skills over MCP 等扩展仍在演进；实施相应 adapter 前必须重新核对规范、schema 与兼容策略。
- gVisor、Firecracker 和主流容器隔离依赖 Linux/KVM 等宿主条件；本文没有承诺它们在 Anthias 目标部署环境中可直接使用。
- SLSA/Sigstore/TUF 的真正保证取决于构建平台、密钥、identity policy、透明日志和客户端实现；本文只保留原则边界，不声称现有仓库已经具备这些保证。
- 何时从一种隔离级别提升到另一种、哪些 Capability 首先外置、pin 的具体用户交互、Manifest 字段和 Runtime 状态枚举，都应在真实 Feature 和运行证据出现后决定。
