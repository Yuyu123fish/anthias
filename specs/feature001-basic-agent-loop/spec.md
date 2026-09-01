# Feature 001：基础 Agent Loop 与 TUI 对话

状态：已定义

- 文档类型：Spec
- Feature 目录：feature001-basic-agent-loop
- 关联基线：[产品定义](../../docs/product-definition.md)、[技术基线](../../docs/technical-baseline.md)

## 1. 问题

Anthias 需要先建立一个能够持续演进为 Coding Harness 的 Agent 运行基础。此前的 Feature 001 从 Desktop 形态出发，把一次基础模型对话拆成独立 Host、JSON-RPC、Protocol DTO、Run 状态机和 Renderer 状态投影。虽然它可以运行，但调用链和接口明显大于当前用户行为，后续维护者必须理解大量传输与同步知识才能修改 Agent Loop。

新的 Feature 001 要证明更小的闭环：开发者从终端启动 Anthias，与一个内存 Agent 进行多轮流式对话，可以停止当前生成，并在失败或停止后继续。Agent 的状态和生命周期只能存在一份，并通过简单、稳定的事件接口支持当前 TUI。

## 2. 方案

实现一个与界面无关的 Agent 模块，以及一个直接使用它的 TUI 适配器。

Agent 负责消息记录、模型流、运行状态、取消和事件发布。TUI 负责读取用户输入、调用 Agent 并根据 AgentEvent 展示过程。生产模型适配器使用通用 OpenAI-compatible 接口；自动验证使用确定性本地模型流。

Feature 001 不建设 Desktop、独立 Host 或传输协议。它只保证 Agent 不依赖当前 TUI 的界面技术；未来 Desktop 的具体需要由后续 Feature 决定。

## 3. 用户故事

1. 作为 Anthias 用户，我希望可以从终端启动 Anthias 并提交提示词，从而无需安装 Desktop 也能与模型对话。
2. 作为 Anthias 用户，我希望在 Assistant 文本生成期间看到增量内容，从而不必等待完整响应才了解进度。
3. 作为 Anthias 用户，我希望已经完成的消息自动进入下一次提示词的上下文，从而进行连贯的多轮对话。
4. 作为 Anthias 用户，我希望能够停止当前响应，从而在模型方向不对或耗时过长时重新取得控制。
5. 作为 Anthias 用户，我希望在响应停止或失败后继续对话，从而不因单次请求失败而结束终端会话。
6. 作为 Anthias 用户，我希望模型配置缺失或可在本地判断为格式错误时，在请求开始前看到明确提示，从而能够修正配置且不会暴露凭据。
7. 作为 Anthias TUI 开发者，我希望 Agent 通过一条事件流暴露可观察变化，从而无需在 TUI 中复制 Agent 生命周期。
8. 作为 Anthias 用户，我希望退出时释放活动模型流和终端资源，从而不遗留请求或后台进程。

## 4. 用户流程

1. 开发者从终端启动 Anthias。
2. Anthias 通过 Agent 的启动工厂校验本地模型配置；配置和生产 Model Adapter 不进入 TUI。
3. TUI 接收已经创建好的内存 Agent，订阅其事件，并显示输入区域或输入提示。
4. 开发者提交非空文本。
5. Agent 记录用户消息，启动一次模型流，并依次发布生命周期事件和消息事件。
6. TUI 随着消息增量事件到达，逐步显示 Assistant 文本。
7. 模型流完成、失败或被停止后，Agent 发布最终消息状态和 Agent 结束事件，然后回到空闲状态。
8. 开发者可以基于当前消息记录继续提交提示词，也可以退出终端会话。
9. 退出时，Anthias 中止仍在运行的模型流，释放终端事件处理器并正常结束进程。

具体终端布局、按键和 TUI 库由 Plan 决定，但不得改变上述流程或 Agent 接口。

## 5. 行为与失败

### 5.1 Agent 状态与提示词行为

- 一个 Agent 实例持有一份内存消息记录。
- 对外状态包含已经结束的消息、当前正在生成的 Assistant 消息、Agent 是否正在运行，以及安全的最近一次错误。
- 调用者必须能够区分提示词未开始执行的拒绝结果，以及已接受执行的最终结果；具体 TypeScript 返回结构由 Plan 确定。
- 仅包含空白字符的提示词作为预期结果被拒绝，不通过异常表达，不改变状态，不发布执行事件，也不调用模型。
- 被接受的提示词只会作为用户消息追加一次。
- 一个 Agent 同时最多处理一个提示词。生成期间提交的第二个提示词作为预期结果被立即拒绝，不追加消息、不发布第二组执行事件，也不进入队列。
- 模型适配器按消息顺序收到当前记录和本次新接受的用户消息。
- 流式文本持续更新同一条 Assistant 消息，不为每个增量创建新消息。
- 每个已接受的提示词最终只有 completed、aborted 或 failed 三种执行结果；正常完成、失败和用户停止都会让 Agent 回到空闲状态。
- Provider 异常被转换为 failed 结果和安全错误信息，不把原始 Provider 异常作为 prompt 的公共失败合同向外泄漏。
- 失败或停止后，Assistant 的部分内容仍保留在消息记录中，并分别记录 failed 或 aborted 终态。安全错误保存在状态和终态事件中，不追加为 Assistant 正文。
- 后续提示词直接基于当前消息文本记录继续；Assistant 终态和安全错误元数据不作为模型消息正文发送。Feature 001 不额外建立有效上下文过滤器、Turn 对象或 Run 对象。
- Agent 状态不暴露 ConversationId、TurnId、RunId 或传输标识符。

### 5.2 事件接口

- 调用者可以订阅事件，并获得取消订阅函数。
- AgentEvent 是由 Agent 模块定义的 TypeScript 判别联合。
- Agent 按自身状态变化的先后顺序，把事件交给当前订阅者。
- Feature 001 的订阅回调是同步的进程内通知；Agent 不等待订阅者的异步工作，订阅者返回值也不参与状态推进。
- 每个被接受的提示词只发布一次 Agent 开始事件和一次 Agent 结束事件。这里的 agent_start 和 agent_end 表示一次提示词执行的边界，不表示 Agent 实例的创建或销毁。
- 被接受的用户消息依次发布 message_start 和 message_end。
- Assistant 响应发布一次 message_start、零次或多次 message_update，以及一次 message_end。
- 每个 message_update 同时包含当前 Assistant 消息和本次新增文本，供交互适配器更新界面。
- 最终 Assistant 消息记录生成是正常完成、失败还是被中止；agent_end 携带相同的 completed、failed 或 aborted 终态，失败时只携带安全错误信息。
- 正常完成、失败和中止都遵守同一事件骨架：Assistant message_end 之后只发布一次 agent_end。
- 失败和中止不额外引入 Run 事件或第二个状态对象。
- 事件是普通的进程内值。Feature 001 不使用 JSON-RPC、Electron IPC 或运行时 DTO 结构包装事件。
- AgentEvent 不包含 AI SDK、Provider 或底层流事件类型。
- 订阅者只能观察状态变化，不能通过事件回调推进或替换 Agent 状态。

单次正常提示词的事件顺序如下：

    agent_start
    message_start (用户)
    message_end   (用户)
    message_start (Assistant)
    message_update (零次或多次)
    message_end   (Assistant)
    agent_end

### 5.3 TUI 行为

- TUI 只使用公开的 Agent 接口和 AgentEvent 类型。
- TUI 展示用户消息、Assistant 部分文本，以及最终的完成、失败或已中止状态。
- Agent 运行期间，TUI 提供停止操作，不再提交其他提示词。
- 正常完成、失败或停止后，TUI 恢复到可以输入的状态。
- 展示模型错误时，不清除已经收到的 Assistant 部分文本。
- Agent 空闲时退出，终端会话立即结束。
- 生成期间退出，先中止活动模型流，再恢复终端状态并结束进程。
- TUI 不维护第二套 Agent 生命周期状态机；它的本地状态只用于呈现最新的 Agent 状态和事件。

### 5.4 模型行为

- Model Stream 是 Agent Module 的内部 seam，不属于 TUI 或 Agent 的外部 Interface。
- Agent Loop 通过内部 Model Stream 传入当前模型消息和 AbortSignal，并按顺序接收 Assistant 文本增量。
- `apps/agent` 内的生产 Adapter 通过 AI SDK Core 使用一个 OpenAI-compatible Provider；Agent 内部测试使用确定性 Model Stream。
- AI SDK、Provider、模型消息和 Model Stream 类型只存在于 Agent Module 实现内部，不向 TUI 暴露。
- DeepSeek V4 Flash 是本地参考配置，不是专用代码路径。
- 一个被接受的提示词只发起一次模型请求。
- Feature 001 不执行重试、模型切换、Provider 路由或后续提示词排队。

### 5.5 配置、失败与资源行为

- Agent 启动工厂从本地环境读取 ANTHIAS_MODEL_BASE_URL、ANTHIAS_MODEL_ID 和 ANTHIAS_MODEL_API_KEY；TUI 不解析或持有模型配置。
- 配置缺失或能在本地判断为格式错误时，Agent 启动工厂返回安全错误；TUI 在发起模型请求前显示该错误，并以非零状态码退出。
- API Key、模型标识或服务地址被远端 Provider 拒绝属于模型请求期间的 failed 结果；Feature 001 不声称能在发出请求前验证远端凭据或模型可用性。
- API Key、Authorization Header、完整请求体和未经处理的 Provider 响应不得进入 AgentEvent、终端输出、自动化测试快照或仓库文件。
- 模型抛出异常时，当前 Assistant 消息以 failed 状态结束，保留已经生成的正文但不追加错误说明；安全错误单独进入 Agent 状态和 Agent 结束事件。
- 停止操作通过 AbortSignal 中止当前模型流。
- Assistant 消息结束后，任何文本增量都不得再修改该消息。
- 正常完成、失败或中止后，不再持有对应的 AbortController 和模型迭代器。
- 进程退出时移除终端监听器，不遗留 Anthias 后台进程。

## 6. 已确认决定

- Feature 001 采用 TUI 优先、Agent 为先的设计：TUI 是首个适配器，不拥有 Agent 行为。
- TUI 单向依赖 Agent 的公开 Interface；Agent 不反向依赖 TUI。AI SDK 和具体 Provider 只允许存在于 `apps/agent` 的内部 Model Adapter，不进入 Agent Loop 类型或外部 Interface。
- Agent 由普通工厂函数创建，并暴露一个小型对象接口；不建立 Agent 类继承层级。
- 本 Feature 对外只需要 state、prompt、abort 和 subscribe 四类行为。
- prompt 必须区分预期拒绝和已接受执行的终态，不用异常表示空提示词或 Agent 忙碌。
- AgentEvent 是当前 TUI 和自动化验证共用的观察接缝。Feature 001 只证明 Agent 不依赖 TUI，不提前承诺未来 Desktop 的具体合同。
- AgentEvent 采用有序的同步进程内通知，不暴露 Provider 事件，也不等待订阅者的异步工作。
- TUI 与 Agent 运行在同一个 Node.js 进程中，通过直接函数调用协作。
- 当前唯一注入的 seam 是 Agent Module 内部的 Model Stream，由生产 OpenAI-compatible Adapter 和确定性测试 Adapter 共同证明其必要性；它不向交互 Adapter 暴露。
- 状态转换全部留在 Agent 内部；TUI、模型适配器和测试都不能调用内部生命周期函数。
- 具体文件布局、依赖版本、TUI 库和终端按键在本 Spec 确认后的 Plan 中确定。

## 7. 不在范围内

- Tool Calling 或 Tool Loop；
- 文件读取、编辑、搜索或命令执行；
- 权限、审批、沙箱或工作区隔离；
- Coding Agent 系统提示词和具体编码场景；
- Session 持久化、对话列表、重载恢复或迁移；
- 上下文裁剪、摘要或 Compaction；
- 重试、steering、follow-up 队列或多个活动提示词；
- 多 Provider、模型切换或 Provider Registry；
- Conversation、Turn 或 Run 实体及其标识符；
- 检查点、执行分支、候选比较或接纳；
- Desktop、Electron、React、Local Agent Host 或后台守护进程；
- JSON-RPC、MessagePort、IPC 合同或协议包；
- 多 Agent 编排；
- 默认自动化测试中的真实 Provider 调用。

## 8. 验收标准

### A. 配置缺失

模型配置缺失或能在本地判断为格式错误时启动生产 TUI：

- 明确指出无效的配置类别，但不输出凭据；
- 不创建活动 Agent 请求；
- 不连接外部 Provider；
- 以非零状态码退出。

### B. 单轮流式响应

确定性模型流依次产出多个文本增量时：

- 一个非空提示词被接受；
- TUI 在模型流结束前逐步显示增量；
- Agent 消息记录包含一条用户消息和一条最终 Assistant 消息；
- Assistant 最终内容等于所有增量按顺序拼接的结果；
- 事件顺序符合事件接口合同；
- Agent 回到空闲状态。

### C. 多轮上下文

连续完成两个提示词后：

- 第二次模型请求依次收到第一条用户消息、第一条 Assistant 消息和第二条用户消息；
- 消息记录保持原有顺序，不创建 Turn 或 Run 对象；
- TUI 展示两轮对话。

### D. 拒绝并发提示词

模型流仍在运行时：

- 新提示词被拒绝；
- 拒绝作为可区分的预期结果返回，不依赖异常；
- 被拒绝的提示词不会追加消息；
- 不发布第二组 Agent 或消息事件；
- 不发起第二次模型请求；
- 第一次请求不受影响并继续运行。

### E. 停止后继续

已经收到部分 Assistant 文本后执行停止：

- 停止操作中止活动模型流；
- 后续文本增量不能修改已经结束的 Assistant 消息；
- 部分文本继续可见；
- 只发布一次 Agent 结束事件；
- Agent 回到空闲状态，并能接受后续提示词。

### F. 失败后继续

模型流在产生部分文本后失败：

- 部分文本继续可见；
- 最终 Assistant 消息记录 failed 状态，但正文不追加错误说明；
- 安全错误单独存在于 Agent 状态和 Agent 结束事件中；
- Agent 结束事件仍然只发布一次；
- 错误不包含凭据或原始请求；
- Agent 回到空闲状态，并能接受后续提示词。

### G. 接口独立性

- Agent 模块不导入 TUI、Electron、React 或传输实现；
- `apps/agent` 只在内部 Model Adapter 导入 AI SDK 或具体 Provider，相关类型不从 package 入口导出；
- `apps/tui` 不导入 AI SDK、具体 Provider、模型消息或 Model Stream；TUI 到 Agent 的依赖保持单向；
- TUI 除启动时调用 Agent 工厂外，只通过 state、prompt、abort 和 subscribe 完成整个对话；
- 一个确定性的非 TUI 订阅者可以通过公开接口观察同样的有序事件；
- 不需要协议包或重复的生命周期归约器。

### H. 干净退出

Agent 空闲或正在生成时退出：

- 终端会话正常结束；
- 如有活动模型流，退出前先将其中止；
- 移除终端监听器并恢复终端状态；
- 不遗留 Anthias 子进程或后台进程。

## 9. 验证边界

自动化验证在 Agent Module 内部使用确定性 Model Stream 验证 Agent Interface；TUI 测试只使用 Agent 的外部 Interface，不构造模型消息或 Model Stream。验证必须覆盖提示词接纳、事件顺序、流式输出、多轮上下文、并发拒绝、停止、失败恢复和资源清理，并且不访问外部网络或真实凭据。

后续可以通过真实 DeepSeek V4 Flash 冒烟测试证明参考 OpenAI-compatible 配置可用，但该验证需要单独授权和本地凭据。Mock 与构建结果不能表述为已经完成真实 Provider 验证。

## 10. 已确认基线

2026-08-31，开发者确认 Feature 001 先建立以下最小 Agent Loop 基线：

1. Feature 001 仅包含与界面无关的内存 Agent 及其首个 TUI 适配器；
2. TUI 接受非空提示词，Agent 记录用户消息并发起一次模型流；
3. 模型增量持续更新同一条 Assistant 消息，结束后 Agent 回到空闲；
4. 同一时间只处理一个提示词，失败或停止后保留部分文本并允许继续对话；
5. TUI 只通过 Agent 启动工厂以及 state、prompt、abort、subscribe 与有序 AgentEvent 使用 Agent；确定性 Model Stream 只存在于 Agent Module 内部测试中，空白或忙碌是显式拒绝结果；
6. 具体 TUI 库、布局、按键和依赖版本留给 Plan，不改变上述行为；
7. TUI 单向依赖 Agent，且不持有模型配置、模型消息、Model Stream、AI SDK 或 Provider；AgentEvent 是同步的进程内通知，不暴露或等待 Provider 与订阅者的异步实现细节；
8. 旧 Desktop、Host、Protocol 以及未来 Tool、Session 或执行分叉基础设施不进入本 Feature。
