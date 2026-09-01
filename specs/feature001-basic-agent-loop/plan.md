# Feature 001：基础 Agent Loop 与 TUI 对话实施方案

状态：已计划

- 文档类型：Plan
- 对应 Spec：[spec.md](spec.md)
- 授权状态：Feature 001 实施已获得；2026-09-01 开发者授权完成 Model Adapter 职责修正；不含新的本地提交、真实 Provider 验证、推送或 PR

## 1. 当前基线

- 当前分支为 `main`，纠正前检查点为 `52726d9`，工作区干净。
- Feature 001 已有可运行实现，但生产 Model Adapter、模型配置和 AI SDK 依赖错误地位于 `apps/tui`，Model Stream 也从 Agent package 入口暴露给了 TUI。
- 本次只纠正模块职责和测试 seam，不改变消息、事件、取消、失败、配置错误或 TUI 用户行为。
- 本机运行时为 Node.js `24.13.1`、pnpm `10.33.0`。
- 默认验证不访问真实模型、外部网络或凭据。

## 2. 交付结果

完成本 Plan 后，开发者可以：

1. 从终端启动 Anthias；
2. 提交非空提示词并看到流式 Assistant 文本；
3. 完成后继续下一轮，模型收到此前消息上下文；
4. 生成期间停止当前响应，保留部分文本并继续会话；
5. 模型失败后看到安全提示，并继续提交提示词；
6. 正常退出并释放模型流与终端资源；
7. 在模型配置缺失或本地格式无效时，于请求前得到提示和非零退出码。

本 Plan 不证明未来 Desktop 合同，不包含 Tool、文件、命令、Session、Compaction、重试、队列、协议层或执行分叉。

## 3. 技术方案

### 3.1 最小工作区

所有 workspace package 统一放在 `apps/` 下：

```text
apps/
  agent/    # @anthias/agent，Agent Loop、模型配置与内部 Model Adapter
  tui/      # @anthias/tui，行式终端输入、呈现与退出
```

根目录只保留私有 workspace 配置、统一脚本和工具配置，不再同时维护 `apps/` 与 `packages/` 两套顶层目录。

`apps/tui` 只依赖 `apps/agent`，负责终端输入、呈现、信号和退出；`apps/agent` 不得反向依赖 TUI，并在内部持有环境配置、生产 OpenAI-compatible Adapter 和 Agent Loop。

Agent 通过 `apps/agent/src/index.ts` 向 TUI 暴露启动工厂、Agent 实例 Interface 及必要事件和消息类型。Model Stream 是生产 Adapter 与确定性测试 Adapter 共同使用的内部 seam，不从 package 入口导出，也不进入 TUI 测试。不创建 Desktop、Host、共享 DTO、Provider Registry、独立 Model package 或额外的 Coding Agent 组合 package。

### 3.2 依赖版本

以 2026-08-31 的本机环境和 npm Registry 查询结果为基线：

| 项目 | 版本 |
| --- | --- |
| Node.js | 24.13.1 |
| pnpm | 10.33.0 |
| `ai` | 7.0.85 |
| `@ai-sdk/openai-compatible` | 3.0.41 |
| TypeScript | 7.0.2 |
| Vitest | 4.1.11 |
| Biome | 2.5.11 |
| `@types/node` | 24.13.3 |

`packageManager` 固定为 `pnpm@10.33.0`，直接依赖使用精确版本并生成 lockfile。TUI 使用 `node:readline`、标准输入输出和进程信号，不引入第三方终端库。

### 3.3 Agent Module

`apps/agent` 持有消息、当前 Assistant 消息、运行状态、`AbortController`、模型迭代器和订阅者，只公开：

- 通过本地环境创建生产 Agent，并返回可安全展示的配置结果；
- 读取只读 state；
- `prompt(text)`；
- `abort()`；
- `subscribe(listener)`。

公开 Interface 的类型语义在本 Plan 固定如下：

- state 是不可由调用者修改的快照，`messageHistory` 保存按顺序结束的消息，`activeAssistantMessage` 保存当前正在流式生成的 Assistant 消息或空值，另外包含 `running` 和安全的 `lastError`；活动消息不同时重复出现在历史中；
- 公开消息类型只保留 `UserMessage`、`AssistantMessage` 和二者组成的 `Message`；Assistant 消息通过 streaming、completed、aborted 或 failed 状态表达阶段，不为每个阶段建立近义类型，也不增加 MessageId、ConversationId、TurnId 或 RunId；
- `prompt(text)` 返回以 `status` 判别的异步结果：拒绝为 `{ status: "rejected", reason: "empty" | "busy" }`，正常完成为 `{ status: "completed" }`，中止为 `{ status: "aborted" }`，失败为 `{ status: "failed", error: string }`；其中 error 必须是可安全展示的文本；
- rejected 结果立即返回且没有事件；已接受执行的结果在最终 message_end、agent_end、资源释放和空闲状态恢复后返回；
- `abort()` 返回 void，空闲或已经终结时调用均无副作用；
- `subscribe(listener)` 接受同步 void 回调并返回幂等的取消订阅函数；监听器返回的 Promise 或其他值不会被 Agent 等待。

关键实现约束：

- 空白提示词和运行期间的第二个提示词返回明确拒绝结果，不追加消息、不调用模型；
- 被接受的 `prompt` 在完成、失败或中止时返回对应结果；
- `abort` 在空闲时无副作用；
- 接受新提示词时清除上一轮安全错误，但不删除历史消息；
- 模型增量只更新当前 Assistant 消息；
- 失败或中止后的部分正文进入后续上下文，安全错误元数据不发送给模型；
- 完成、失败与中止共用一个终结路径；终态竞争遵循第一次终结生效，之后的完成、异常、中止或晚到增量全部忽略；
- 终结路径只发布一次最终消息事件和一次 Agent 结束事件，agent_end 的终态与 `prompt` 结果一致；
- 终结后清除本次 `AbortController` 与模型迭代器，晚到增量不得修改消息。
- state 与 AgentEvent 中的消息都是只读快照，调用者不能通过保留引用修改 Agent 内部记录。

AgentEvent 统一使用 `type` 判别，并固定为以下最小载荷：

- agent_start 不携带额外状态对象；
- message_start 和 message_end 携带对应消息快照；
- message_update 携带当前 Assistant 消息快照与本次 delta；
- agent_end 携带与 `prompt` 一致的 completed、aborted 或 failed 结果，拒绝结果不产生 AgentEvent。

AgentEvent 按 Spec 的顺序同步发布。TUI 只根据事件呈现，不维护第二套生命周期状态机。

### 3.4 Model Stream

Agent Module 内部依赖项目自有的最小 Model Stream 合同：

- 输入为按顺序排列的用户与 Assistant 正文，以及 `AbortSignal`；
- 输出为异步文本增量；
- AI SDK、Provider、模型消息与 Model Stream 类型不得从 Agent package 入口导出。

Agent 内部测试直接提供确定性异步流。`apps/agent` 内的生产 Adapter 使用 `createOpenAICompatible` 与 `streamText`，从 `fullStream` 只提取文本增量，并在 Adapter 内收敛 error part；同时传递 `abortSignal` 并设置 `maxRetries: 0`，保证一次提示词只发起一次模型请求。

生产 Adapter 不包含 DeepSeek 专用类型、枚举或条件分支。

### 3.5 配置

Agent 启动工厂读取：

- `ANTHIAS_MODEL_BASE_URL`
- `ANTHIAS_MODEL_ID`
- `ANTHIAS_MODEL_API_KEY`

请求前只校验非空值，以及 Base URL 能否解析为 `http` 或 `https`。失败时向 TUI 返回安全错误文本；TUI 不接收有效配置对象。API Key、模型和远端服务的真实有效性只能在请求时判断，统一作为可恢复的模型失败。

终端、AgentEvent、测试快照和仓库文件不得包含 API Key、Authorization Header、完整请求体或原始 Provider 响应。

### 3.6 行式 TUI

- 空闲时读取一行；空白输入提示后继续；
- `/exit`、EOF 或空闲时 `Ctrl+C` 正常退出；
- 运行时根据 AgentEvent 逐步写出 Assistant 文本；
- 运行时 `Ctrl+C` 只停止当前生成，不退出会话；
- 完成、失败或中止后恢复输入；
- 退出路径统一中止活动 Agent、取消订阅、移除监听器并关闭 readline。

Feature 001 不创建子进程或后台进程。

## 4. 实施顺序

### 4.1 工程基线

- 创建根私有 package、workspace、TypeScript、Biome、Vitest 配置和 lockfile。
- 创建 `apps/agent` 与 `apps/tui` 两个 workspace package，并建立单向依赖。
- 建立 `check`、`test`、`build` 和 `verify` 脚本。

### 4.2 Agent Module

- 定义必要的消息、状态、结果、事件与 Model Stream 类型。
- 实现提示词接纳、单运行约束、流式更新、有序事件和统一终结。
- 通过公开 Agent Interface 使用确定性 Model Stream 验证行为。

### 4.3 生产 Model Adapter

- 在 `apps/agent` 内实现环境配置读取与本地校验。
- 接入通用 OpenAI-compatible Provider。
- 禁用重试、传递取消信号并收敛敏感错误。

### 4.4 TUI

- 通过 Agent 启动工厂取得已配置的 Agent，不构造 Model Stream 或 Provider。
- 实现输入、流式输出、停止、失败恢复和退出。
- 验证 Windows 终端下 `Ctrl+C` 与 readline 的真实行为。

### 4.5 收口

- 运行全部本地门禁和缺失配置进程验证。
- 经单独授权后才能运行真实 DeepSeek V4 Flash 冒烟测试。
- 实施完成后创建唯一 `report.md` 并停止，等待开发者验收。

## 5. 验证

### 5.1 自动化行为

使用确定性 Model Stream 覆盖：

1. 空白提示词返回 empty 拒绝，不追加消息、不发布事件且不调用模型；
2. 多个增量形成一条 Assistant 消息，事件顺序、消息快照和 completed 结果一致；
3. 第二轮收到完整有序上下文；
4. 运行中第二个提示词返回 busy 拒绝，不追加消息、不发布第二组事件；
5. 中止后保留部分文本、忽略晚到增量并允许继续，终态竞争只生效一次；
6. 失败后保留部分文本、错误不进入 Assistant 正文、错误已脱敏并允许继续；
7. 完成、失败和中止只终结一次并释放运行资源；
8. 同步订阅者按顺序收到事件，未完成的监听器 Promise 不阻塞 Agent，取消订阅后不再收到事件；
9. TUI 通过 Agent 外部 Interface 完成流式输出、停止和恢复输入，不导入内部 Model Stream；
10. `/exit`、EOF、`Ctrl+C` 与配置缺失时的进程退出行为。

测试优先通过 Agent Interface 和完整 TUI 入口，不为内部步骤增加专用测试接口。

### 5.2 验证命令

实现完成后至少运行：

```powershell
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm verify
```

`pnpm verify` 必须覆盖格式与静态检查、Strict TypeScript、测试和构建。真实 Provider、网络连通性和凭据有效性不属于默认验证结果。

## 6. 风险与停止条件

主要风险：

- AI SDK 默认重试会破坏一次提示词一次请求，必须显式关闭；
- 正常完成、异常与取消可能竞争，必须保证单一终态；
- Windows `Ctrl+C` 与 readline 的实际行为可能和测试流不同；
- Provider 异常可能携带敏感请求或响应内容；
- 初始化或格式化命令可能误碰开发者现有文档修改。

出现以下情况时立即停止并回到讨论：

- 必须改变已确认的事件顺序、部分消息上下文或并发拒绝语义；
- Node 内置行式终端无法满足停止与退出，需要引入完整 TUI 库；
- AI SDK、Provider、模型消息或 Model Stream 类型无法被限制在 Agent Module 内部；
- 需要增加 Desktop、Host、协议、Tool、Session、重试、队列或 Registry；
- 需要真实模型、外部网络或凭据才能继续默认验证；
- 与开发者现有修改发生无法安全处理的重叠。

## 7. 汇报与授权

实施报告需说明用户闭环、主要调用关系、资源释放、实际验证结果、未验证边界和 Git 状态。

- 本 Plan 已由开发者确认并进入“已计划”。
- 开发者已明确授权按本 Plan 创建 `tasks.md` 并实施 Feature 001。
- 本地提交已在实施报告完成后单独获得授权；真实模型验证、推送和创建 PR 仍需分别取得授权。
