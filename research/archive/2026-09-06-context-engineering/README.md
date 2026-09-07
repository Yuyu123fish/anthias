# 上下文工程调研（原 Feature 008，已搁置）

状态：已归档（原 Feature 008 已于 2026-09-06 整体搁置）

## 开发者速览

> **一句话**：原 Feature 008 已整体搁置，保留调研供后续问题复盘。<br>
> **核心做法**：保存 Codex 等一手资料、Anthias 现状和候选方案。<br>
> **边界**：仅作历史参考，未进入 Spec、Plan 或实施。<br>
> **风险 / 未验证**：项目收益尚无对照证据，新增调用、状态管理和失败恢复会增加复杂度。<br>
> **当前 / 请审阅**：2026-09-06 归档，现有压缩与运行限制保持原实现。

## 搁置决定

开发者于 2026-09-06 决定整体搁置原 Feature 008。主动整理、草稿摘要和原文回读目前缺少 Anthias 实际任务中的收益证据，尚不足以说明收益值得新增的调用、状态管理与失败恢复成本。

本次不推进原 Feature 讨论的任何实现，包括默认运行上限调整。调研移出 `specs/` 后保留为历史参考；下文的建议、候选方案和后续 Spec 设想记录的是当时的讨论，不是当前工作计划或实施授权。后续若出现具体问题，再通过小范围对照实验判断是否值得重新考虑。

## 要回答的问题

排查问题、修改代码、运行验证，再根据结果继续修复，本来就可能需要很多轮。上下文工程要让这样的任务能持续推进：模型知道还剩多少空间，在合适的节点整理已有工作，整理后仍然知道哪些做完了、哪里还没验证、接下来做什么。

这次围绕三个问题调查：Codex 怎样让模型主动管理窗口；“先草稿、再最终摘要”到底对应什么过程；Anthias 为什么会因模型请求次数而停止。初步建议是把预算反馈、主动整理和取消默认请求次数截止作为主线，把原有自动压缩作为兜底。草稿的具体形式和收益需要继续比较。

本研究以官方文档、工程文章和源码为依据；Codex 主线核验 OpenAI 一手资料及 `openai/codex`，补充案例核验 Anthropic、Letta 与 LangChain 的公开材料；未调用 Provider，未观察托管 Codex 的不可见后端，也未改动业务代码。核验日期为 2026-09-06（Asia/Shanghai）。官方仓库当时 `main` 固定为 [`ac192cd7937b0d73edc6dffe009940ae53782dd4`](https://github.com/openai/codex/commit/ac192cd7937b0d73edc6dffe009940ae53782dd4)，提交时间为 2026-09-06T07:42:32Z。`C:\projects\codex-main` 没有 `.git`，不能提供可复核的本地 HEAD 或状态；它只作为检索线索，以下结论以该官方固定提交为准。

## Codex 已经加入了什么，哪些条件下才会启用

当前源码把这套能力命名为 experimental context management，而不是稳定的 `proactive_compaction` 功能。`ModelInfo.supports_experimental_context` 默认是 `false`；2026-09-06 的能力门控提交只为 bundled `gpt-6-astra` 打开该标志，并在会话启动和换模型时检查它。[`6af3454` 的提交说明](https://github.com/openai/codex/commit/6af345407d9c2a568da9d01b6c4b81a9e61495c0) 与 [`token_budget.rs` L12–58](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/session/token_budget.rs#L12-L58) 显示，除了模型能力，还要求实验 feature、Codex backend 路由、OpenAI 认证和合资格的 ChatGPT 账户；自定义 Provider、显式 Provider 凭据和非 Codex endpoint 不进入该路径。

因此，能够从开源客户端看到这段代码，不等于所有 Codex 用户、所有 API 模型或 OpenAI-compatible Provider 现在都默认可用。公开 `main` 也不能证明托管服务的最终灰度范围、账户策略或未来默认值。本报告把它称为“受门控的实验实现”。

2026-09-02 的引入提交已经把它描述为 under-development，并说明仅限符合条件的 Codex backend 会话。[`cff76fa` 提交](https://github.com/openai/codex/commit/cff76fa96f70f9f3b63d221446fd02cfd87e6d2e) 可追溯该边界。检索当前固定 SHA 的相关实现未发现名为 `proactive_compaction` 的稳定开关；这只能说明本次公开源码核验未看到该名称，不能反向推断不可见服务端没有类似策略。

## 模型先要知道自己还有多少上下文可用

实验路径向模型提供无参数工具 `get_context_remaining`，返回 `{ tokens_left: integer | null }`；不可取得余量时返回 `null`。[`get_context_remaining_spec.rs` L8–35](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/tools/handlers/get_context_remaining_spec.rs#L8-L35) 和 [`get_context_remaining.rs` L70–87](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/tools/handlers/get_context_remaining.rs#L70-L87) 表明它直接读取 `base_window_tokens_remaining`。

这个数字的基准并非一个“每轮还能做几次”的独立预算。`context_window.rs` 以当前活动上下文的 token 占用量计算两个上限：模型的 auto-compact scope（可为整个上下文，或去掉已知 prefix 后的 body）和完整 context window 的硬上限；暴露给模型的余量取两者中更紧的值。[`context_window.rs` L1–110](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/session/context_window.rs#L1-L110) 还把 fallback buffer 用在“何时视为已到自动压缩线”，而不是直接从 `tokens_left` 再扣一段数。

“隐含输出是否计入”没有对所有 Provider 都成立的单一答案。历史使用量先采用服务器上一次返回的 `total_tokens`，再估算那以后本地追加的项目；当该服务端配置不包含此前 reasoning 时，客户端会额外估算相应 reasoning 项。[`history.rs` L400–432](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/context_manager/history.rs#L400-L432) 这说明 `tokens_left` 不是单纯的可见输入文本长度，也不是产品层的 request quota；其中究竟有哪些隐藏 token 已由服务器计入，仍取决于模型和端点的 usage 语义。

## 模型可以主动换窗，运行时仍然保留兜底

模型可以调用 `new_context`。工具规格只承诺“开始一个新 context window，不清除或重置环境状态”；实现说明更明确地写着，新窗口会在**不摘要 conversation history**的情况下开始。[`new_context_window_spec.rs` L6–16](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/tools/handlers/new_context_window_spec.rs#L6-L16)、[`new_context_window.rs` L13–41](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/tools/handlers/new_context_window.rs#L13-L41)。这就是“模型知道预算并可主动换窗”的公开证据；它不是模型调用一个 `compact` 工具取得文本总结。

token-budget 层会在余量降到模型配置的 reminder 阈值后，至多一次地记入一条对模型可见的提醒；当余量为零且允许兜底时，至多一次地记入 fallback prompt。若模型继续工作且已请求新窗口，或上下文限制已到，turn 循环会进入 rollover；`compact_token_budget.rs` 明确说明该路径跳过 model/server summarization，直接安装一个 fresh context window。[`token_budget.rs` L165–223](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/session/token_budget.rs#L165-L223)、[`turn.rs` L480–550](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/session/turn.rs#L480-L550)、[`compact_token_budget.rs` L20–90](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/compact_token_budget.rs#L20-L90)。

这条兜底同样执行换窗，公开调用链没有显示它在此处切回传统文本摘要。让原有摘要式自动压缩继续兜底，是 Anthias 可以明确采用的项目策略。提醒和 fallback 的具体文字由模型元数据配置，公开源码没有给出一个对所有模型固定的“先写工作备忘再换窗”指令。因此也不能据此宣称 Codex 要求模型在调用 `new_context` 前保存未完成工作。

## 换窗之后，还要能接着处理原来的任务

`start_new_context_window` 会推进窗口状态，用“带 `world_state` 的初始 context”替换 compacted history；只有单独的 `RetainClientDeveloperMessages` feature 开启时，才会把受 remote compaction retained-message budget 截断的 client-authored developer messages 串入新上下文。保存的 `CompactedHistoryMetadata.message` 是空字符串。[`session/mod.rs` L3759–3807](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/session/mod.rs#L3759-L3807) 结合前述 `new_context` 的“无摘要历史”说明，可确认旧的原始对话尾部不会作为一段文本 summary 直接带入新窗口。

在本次公开核验范围内，不能把上述事实扩展成“会保留 system、最新 user、工具结果和未完成工作”的承诺。上述调用链不足以完整说明 `world_state` 如何承接当前任务，也不能证明模型在换窗前已把关键信息写到某处。hosted history-notes 后端怎样读取、压缩和返回内容，在本次可见材料中没有完整契约。源码只显示符合条件的实验会话会启用 `use_history_notes_extension`；其后端语义不应从客户端调用痕迹猜测。[`token_budget.rs` L19–58](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/session/token_budget.rs#L19-L58)。

对 Feature 008 而言，最重要的不是复制“new window”这个动作，而是在需求和验收中先定义：什么持续工作事实必须显式带过窗口，哪些可以丢弃，丢失时怎样恢复。公开 Codex 证据不足以替 Anthias 决定这个数据保留合同。

## 草稿再摘要，需要单独判断它的价值

上述实验 rollover 明确跳过 model/server summarization；`new_context` 也明确不摘要历史。因此，在当前固定 SHA 已核验的主动换窗路径中，没有“先产生短 draft，再发第二个模型请求整理 final summary”的固定两步机制。对 `draft` 与 `proactive_compaction` 的相关公开源码检索也没有给出这一机制的实现证据。

OpenAI 的 Responses API 另有两种 compaction：创建 response 时配置 `context_management` 的 `compact_threshold`，由服务端在阈值跨越后在同一 response stream 中压缩；或显式调用独立的 `POST /responses/compact`，得到可直接作为下一个窗口的 canonical output，其中含不透明、加密的 compaction item。[官方 Compaction 指南](https://developers.openai.com/api/docs/guides/compaction) 的“Server-side compaction”和“Standalone compaction”章节，以及 [Responses compact API 参考](https://developers.openai.com/api/reference/java/resources/responses/methods/compact) 可复核该行为。它们是 Responses API 的服务端状态机制，不能外推为 Chat Completions 或任意 OpenAI-compatible Provider 都能直接调用的接口。

Responses `/compact` 的不透明项并不公开其内部是否有多个推理阶段；公开接口只暴露一次 compact 操作及其 usage，不能把它叫作已证实的 draft→final。相同道理，一次模型调用里要求“先思考、后输出摘要”仍是一轮模型请求，并不等于两次独立调用。本次查到的一手资料未提供能够证明两次调用改善摘要质量、token 成本或端到端延迟的对照证据。

## Anthias 现在缺的是什么

这次核对的 Anthias 基线是 `main`，HEAD 为 `a56c921adf91199ca57a68a0b0c3d99389d6bfa2`，开始研究时工作区干净。下面是当前源码与已有用例给出的事实。

### 正常工作也会用完十二次机会

一次任务可能先搜索实现、再读几个文件、修改、运行验证、根据错误继续修复。这些步骤都有进展，但当前 Loop 在每次请求前统一累加计数，达到十二次就直接失败。它没有检查是不是反复犯同一个错误。因此，“模型连续请求次数超过安全上限”实际表示的是普通模型请求总量，不能用来证明 Agent 陷入了异常循环。

我支持移除这层默认硬截止，而不是把十二改成更大的数字。这里需要同步审视另一层：协调器把根 Agent 和成员的模型流都包起来，全组一次任务最多六十次模型调用、三十分钟；普通回复、摘要和审核都会进入它。没有创建成员的根 Agent 也经过这一层。只移除十二次限制，仍会在六十次处被截停。

这与现有 Feature 007 Spec 的默认预算合同有冲突，后续 Spec 应明确记录替代决定。请求次数与时长是两件事：建议将十二次、六十次默认计数截止一起纳入调整；三十分钟截止单独讨论，不能在改次数时默默改变。用户停止、真实请求失败、工具超时、权限拒绝、上下文无法容纳当前输入等依然是有具体原因的停止条件。单批 ToolCall 大小、并发数和摘要分批的防失控边界，也需要按各自用途判断。

证据：[Loop 的固定上限与循环](../../../apps/agent/src/agent-loop.ts#L147)、[根与成员共用模型包装](../../../apps/agent/src/agent.ts#L159)、[全组预算](../../../apps/agent/src/multi-agent/index.ts#L161)、[Feature 007 原合同](../../../specs/feature007-multi-agent/spec.md#生命周期与权限)。

### 预算已经算了，模型还用不上

目前 Context 已经估算完整请求，包括系统指令、消息和 Tool Schema；有效 usage 返回后，只在前缀与上下文版本仍然一致时用实际输入量校准。首次请求或校准失效时使用估算，未知用量不会冒充零。

当前自动压缩触发线是：

```text
完整输入量 >= 窗口容量 − 20,000 安全余量 − max(普通回复输出预算, 摘要输出预算)
```

普通回复默认预留 16,000 token，摘要默认预留 8,000 token，并受模型已声明的输出能力约束。以 128,000 的示例窗口计算，默认输入触发线是 92,000；这只是公式示例，不表示当前 Provider 的窗口容量。

TUI 的 `/context` 已能显示这些用量，但普通模型请求的 Coding prompt 没有剩余预算提示，也没有查询预算或主动压缩的 Tool。模型接收到 `maxOutputTokens` 对应的生成约束，并不等于它能读到当前窗口还剩多少可用空间。

因此，Feature 008 最值得补的是让模型获得可信的预算信息，并把主动压缩接到已有 Context 里。预算的权威继续在 Agent，模型负责选择时机。

证据：[预算构造与请求估算](../../../apps/agent/src/context/budget.ts)、[usage 校准](../../../apps/agent/src/context/request.ts)、[每次请求前的预算检查](../../../apps/agent/src/context/index.ts#L151)、[当前 Coding prompt](../../../apps/agent/src/prompts/coding-system-prompt.ts)、[TUI 用量呈现](../../../apps/tui/src/command.ts#L386)。

### 现有摘要有可靠的生效过程，但还没有两阶段草稿

现有实现会保留近期完整消息组和优先用户输入，把较早的完整历史组交给摘要模型。摘要请求不提供工具，按六个栏目整理目标、约束、决定、验证、进度和文件线索；历史中的外部指令不能变成新授权。

当输入放不进一次摘要请求时，它会把历史分批，顺序滚动更新同一份摘要，最多八批。这里的中间摘要用于逐批处理长输入，不能称为固定的“草稿→最终摘要”流程。

新的摘要必须通过结构、大小和终态检查，压缩后的请求必须比原来更小且低于触发线；压缩记录刷盘成功后才切换模型投影。失败或取消时保留原历史；Provider 报上下文溢出且尚未向上游输出内容时，现有机制可以尝试一次压缩恢复。这些都是主动压缩可以复用的基础。

目前机械校验只能证明六个栏目存在且非空，不能证明摘要没有漏掉关键事实。提示词还要求保留每个 entry 的来源，后续需要区分“保留关键结论的可追溯性”和“把所有历史逐条重新抄一遍”，否则摘要会被索引本身挤满。

证据：[历史选择与投影](../../../apps/agent/src/context/selection.ts)、[摘要分批与校验](../../../apps/agent/src/context/compaction.ts)、[六栏目提示及校验边界](../../../apps/agent/src/prompts/compaction-prompt.ts)、[持久化后生效与溢出恢复](../../../apps/agent/src/context/index.ts#L233)。

## 接入 Anthias 时，我建议优先处理这几件事

以下是依据现状提出的建议，还没有成为 Feature 008 的已确认合同。

### 让模型在合适的节点整理，Agent 保留最后的容量检查

模型应能查询“这次窗口还能安全放入多少内容”，并在接近需要整理时收到简短提醒。提示中要说清数字来自估算还是 usage 校准，并区分窗口容量、下一次输出预留、距自动压缩触发线的余量；累计计费 token 或请求次数不能充当窗口余量。

主动整理适合发生在调查已形成结论、修改准备进入验证等自然节点。Agent 接收请求后，在完整 Tool 批次已经形成结果的位置处理，继续使用 Session 的写入顺序、取消和压缩校验。ToolCall 与 ToolResult 不能被切散；已经执行过的副作用不能因换窗再做一次。

模型未主动处理时，现有阈值自动压缩仍然兜底。主动压缩、手动 `/compact`、阈值压缩和溢出恢复应该使用同一套核心能力，并让用户看到此次压缩的原因、前后用量和是否成功。失败但旧上下文仍能安全发送时，可以返回可读失败让模型调整；已经超出容量且无法压缩时，应解释具体原因。不要反复压缩同一段无新增工作信息的历史。

### 草稿应当是一份能接着工作的备忘

例如，一次并发问题排查走到一半，草稿最有用的内容是：哪一个假设已经排除、修改了哪里、哪项验证确实通过、还剩什么没有证据、下一步该执行什么。当前 Agent 可以把这些信息交给压缩过程，最终摘要再依据原始来源整理。

需要比较的两种候选路径是：运行中的 Agent 直接提交足够好的摘要；或者它先提供简短工作备忘，再由摘要请求结合原始历史与上一份摘要生成最终结果。后者可能减少遗漏，也多出一次调用、输入和输出。最终整理如果只读草稿，草稿漏掉的事实就很难补回；如果重读完整长历史，成本也要计入。现有自动兜底可能没有模型提前写的草稿，因此必须能够独立完成压缩。

草稿只记录任务状态、证据、未决问题和下一步，不收集冗长推理过程。真正要比较的是压缩后能否正确继续、是否重复劳动、遗漏是否减少，以及完成任务的总 token 和耗时。摘要更短或调用多了一次都不是“提效”的充分证据。

### 预算提醒不要破坏原来的稳定前缀

每轮把变化的剩余数字写进系统提示前部，会改变大量共享前缀。在 Anthias 中，这还会让依赖 system prompt 和消息前缀的 usage 校准失效。

建议保留稳定说明，通过明确来源的运行时提示或 Tool 结果提供动态数字，并控制提醒频率。这些内容不能伪装成用户要求，自己的 token 开销也要计入。OpenAI 官方文档确认缓存依赖匹配的前缀；据此可推导稳定前缀值得保护，但不能据此承诺 Anthias 当前 Provider 的实际命中率提升。[Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)

### 摘要之外，要保留找回关键原文的路

Anthias 已经有完整 Session 历史、来源 entryId/seq，以及工具产物分页读取。它们让压缩不必承担“记住所有细节”的任务。摘要应保留关键文件、产物、验证结果和原文定位，使模型在不确定时能定向补读。

可以把当前 Session 的有界历史读取列为补充候选，先沿现有 JSONL 和产物能力做，不急着加入向量库、长期记忆系统或独立证据平台。现有成员结果读取也不能直接等同于当前会话的任意原文检索。真正的增量应是：一个细节被摘要省略后，模型还能凭线索找回来。

多 Agent 场景下，每个成员继续管理自己的窗口；委派要求、成员结果和真实用户授权保持来源区别。压缩不能把成员转述改写成用户已经批准，也不能把“成员说已通过”改写成根已经独立验证。

## 怎样验证这次改进确实有用

实现阶段可以用少量有代表性的检查覆盖关键合同：

- 用确定性本地流完成超过十二次、六十次请求的任务，确认正常推进不会因默认计数停止，并确认用户取消仍能收口。
- 模型主动整理后在同一任务中继续，已执行工具不重复、调用结果配对完整；模型不主动整理时，原阈值兜底仍然工作。
- 在生成草稿、最终摘要、写入压缩记录几个边界取消或失败，确认原历史可读、未完成摘要不生效、预算重新估算。
- 在固定几段历史上比较现有摘要、模型直接交接和“备忘→最终摘要”，检查用户修正、已完成动作、未验证事项、文件/产物定位及下一步的保留，同时记录总调用、token 与耗时。

前三类主要验证运行机制；摘要事实质量和某个真实模型会不会主动选择合适时机，需要单独的实际模型证据。确定性测试不能代替它。

本轮只运行了一组现有用例：Windows、Node.js v24.13.1、pnpm 10.33.0 下执行 `pnpm exec vitest run apps/agent/test/agent-loop-safety.test.ts`，一个文件、两个用例通过。它证实当前第十三次请求被禁止以及过大 ToolCall 批次被拦截；没有验证 Feature 008 的新能力。本轮没有调用真实模型，没有修改业务代码或进行 Git 提交。


## 补充：模型主动整理带来的收益，以及其他 Agent 的实践

补充核验日期：2026-09-06。这里先把“模型主动整理”拆成两个不同的增量：模型选择何时请求压缩；模型在工作过程中主动维护接续所需的状态。Anthias 现有压缩已经让模型参与摘要内容选择，所以只增加一个主动调用入口，直接改变的主要是时机；工作备忘、来源和原文回读才进一步决定连续性。

### 收益应当落在继续工作的表现上

从设计上看，模型可以结合任务进展做三类判断。这些是可验证的预期收益，还不是 Anthias 已经测得的提升：

| 模型做的判断 | 可能改善的实际表现 |
| --- | --- |
| 已完成调查，准备开始实现，现在适合整理 | 在相对完整的工作节点生成交接内容，给后续大段代码或日志预留空间 |
| 已排除哪些假设、哪些结论有证据、下一步还缺什么 | 压缩后减少重复读取、重新排查和过早宣布完成 |
| 哪些原文暂时用不到，只保留文件与产物定位 | 让活跃上下文更聚焦，需要细节时再定向补读 |

例如，假设一个 Agent 在排查偶发超时。它刚确认问题出在连接池等待，已经排除数据库慢查询，尚未验证取消时连接是否归还。这时最有用的工作记录会保留这些结论、证据位置与下一步，而不是把几十次查询按时间重新复述。整理后先验证连接归还，就比重新从数据库查询开始调查更接近任务目标。这个例子说明期望的行为，不是本项目实测。

主动整理也可能选错时机、遗漏事实或过早消耗额外调用。总成本还受摘要生成和缓存变化影响。因此，短任务不必频繁整理；长任务要比较压缩后的正确继续率、重复工具调用以及整项任务的开销。

### Claude 的公开案例：换窗后能够继续原来的工作

Anthropic 在 2025-09-29 的工程文章中描述了 Claude 玩 Pokémon 的实践：Agent 自己记录训练目标、探索地图与战斗经验，context reset 后读取笔记，继续持续数小时的训练或探索。这个案例展示的是模型维护状态并回读的实际表现，文章没有提供主动选择压缩时机的独立对照实验。[Anthropic：Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

更接近 Coding Agent 的例子来自 Anthropic 2025-11-26 的长任务工程文章。作者观察到：只靠普通 compaction，模型仍可能留下未记录的半成品，后续窗口花时间重新摸索，或者看到部分完成就误判整个项目结束。他们在 Claude Agent SDK 的实验 harness 中加入功能清单、进度文件和 Git 历史，并让后续窗口先读取和核验，再继续增量工作；作者报告这样减少了重新猜测和恢复基础运行状态的时间。改善来自这组配套做法，不能单独归因于“模型主动触发压缩”，也不等于 Claude Code 默认对每个任务执行这套流程。[Anthropic：Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

### Letta / MemGPT：模型可以维护自己的工作记忆

Letta 的 Memory Blocks 让模型通过工具修改有大小约束的记忆块；只读块除外。其文档还说明，移出当前上下文的旧消息仍可经检索工具找回。这构成“主动选择要长期保留什么＋需要时回读”的实现依据，和模型自己决定整个窗口何时压缩仍是不同机制。[Letta：Memory Blocks](https://www.letta.com/blog/memory-blocks/)、[Letta V1 文档：Stateful agents](https://docs.letta.com/v1-sdk/concepts/stateful-agents)

对 Anthias 有用的是这个有限原则：给当前任务一份小而可更新的工作记录，同时保留原始事实的访问路径。这不要求引入 Letta 的数据库、完整记忆体系或自我改写系统提示词。

### Deep Agents：模型可以主动请求压缩

已核验的另一个公开例子是 LangChain Deep Agents。`SummarizationToolMiddleware` 注册 `compact_conversation`；模型或用户以普通 ToolCall 调用，工具描述建议在对话变长、转入无关任务或完成综合后主动使用。它本身不会后台执行，并要求报告的 usage 至少到自动摘要阈值约 50%，避免过早压缩。它复用同一 `SummarizationMiddleware` 摘要引擎；后者才在配置阈值到达时自动运行，两层共用摘要事件状态，避免压缩后各自看到不同的对话视图。成功时被逐出的原文先写入 backend，摘要携带可回读路径，因此模型上下文虽被替换，原文仍有找回通道。主动工具须显式加入 middleware；文档所称 `create_deep_agent` 的默认是自动摘要层，不能外推为所有 Deep Agents 默认暴露主动工具。现实运行中，模型不必等到自动阈值：完成一个阶段、准备换题或确认旧材料已无须常驻时，可以发起一次 ToolCall；未达到资格时，工具返回“nothing to compact”，不会暗中执行摘要。实现只证明可行，不能证明模型择时、摘要质量或总成本必然更好。[官方参考](https://reference.langchain.com/python/deepagents/middleware/summarization/SummarizationToolMiddleware)；[固定源码 L1636–1749](https://github.com/langchain-ai/deepagents/blob/6c89fe2197a2dfe4f3851cda38565bcadba6066b/libs/deepagents/deepagents/middleware/summarization.py#L1636-L1749)、[L1803–2155](https://github.com/langchain-ai/deepagents/blob/6c89fe2197a2dfe4f3851cda38565bcadba6066b/libs/deepagents/deepagents/middleware/summarization.py#L1803-L2155)。
## 证据边界与来源

来源日期为 2026-09-06。Codex 采用官方固定提交，Anthias 采用本文记录的本地 HEAD；本地 Codex 副本不作为版本依据。以上建议不构成 Spec、Plan 或代码实施授权。

本研究引用官方公开代码和文档，并核对 Anthias 当前实现；没有调用真实模型。官方开源客户端能证明客户端注册的工具、门控、计数和换窗路径；它不能证明未公开的后端 history-notes 内容、线上灰度开关和所有模型的默认能力。

主要一手来源（均于 2026-09-06 核验）：

- [OpenAI Codex 官方仓库固定提交 `ac192cd`](https://github.com/openai/codex/commit/ac192cd7937b0d73edc6dffe009940ae53782dd4)。关键路径：`codex-rs/core/src/tools/handlers/get_context_remaining*.rs`、`new_context_window*.rs`、`session/token_budget.rs`、`session/context_window.rs`、`context_manager/history.rs`、`session/turn.rs`、`compact_token_budget.rs`、`session/mod.rs`。
- [实验上下文能力门控提交 `6af3454`](https://github.com/openai/codex/commit/6af345407d9c2a568da9d01b6c4b81a9e61495c0) 与 [初始实验接入提交 `cff76fa`](https://github.com/openai/codex/commit/cff76fa96f70f9f3b63d221446fd02cfd87e6d2e)。
- [OpenAI Developers：Compaction guide](https://developers.openai.com/api/docs/guides/compaction)（Responses 的 server-side 与 standalone compaction）。
- [OpenAI Developers：Responses compact API reference](https://developers.openai.com/api/reference/java/resources/responses/methods/compact)（`POST /responses/compact` 的输出和 usage）。
