# Feature 013 审查：Session 与输入流程的理解成本

状态：审查完成，问题未修复

## 开发者速览

> **一句话**：当前实现有一处已复现的停止竞态，也没有达到降低 Session 理解成本的目标。<br>
> **核心做法**：沿消息提交、上下文构造和运行结束三条路径，对照 pi 检查实际代码。<br>
> **边界**：记录缺陷、设计问题和后续方向，本次不修改业务代码。<br>
> **风险 / 未验证**：再次停止后仍可能自动执行 followUp；可读性问题尚未整改。<br>
> **当前 / 请审阅**：保存当前实现和审查结果，结构调整留给后续 Feature；不视为验收通过。

## 结论与范围

审查日期：2026-09-10。审查对象为本文件首次提交所包含的 Feature 013 实现，改造前基线为 `main @ 8581c269400fbd775e97c15bc281bc73b19a154d`。

对照本地 `C:/projects/pi`，版本 `6160683a4a8012f0d1cd30c145df18b4ca6f5176`。以下 pi 路径和行号均相对此版本，不代表上游最新实现。

检查覆盖 Session、SessionAgent、Agent Loop、Context，以及相关 TUI 和测试调用者。重点是读懂一条消息如何保存、进入上下文、完成执行，需要理解哪些状态和顺序。

结论分两类：

- **行为缺陷**：R01 已通过一个确定性的本地场景复现。
- **可读性问题**：R02–R06 是基于实际调用链的设计判断，不能将它们冒充已经测出的运行故障或性能数据。

上一轮“测试通过、无遗留缺陷”的结论不充分。已有测试证明了所覆盖场景，但没有覆盖 R01，也不能证明读代码更容易。[Report](report.md) 和 [Tasks](tasks.md) 已同步记录这一限制。

## R01：再次停止没有撤销先前的继续请求（P1）

**状态：已复现，未修复。**

[Spec](spec.md) 的“停止、失败与继续”及 A08 要求停止后暂停队列，只有开发者再次明确继续才恢复。

复现步骤：

1. 启动一个 Run，让本地模型流等待一个可控制的闸门。
2. 排队一条 followUp。
3. 依次调用停止、`prompt("", { resume: true })`、再次停止，期间旧 Run 尚未结束。
4. 释放模型流闸门，让旧 Run 完成取消和结束记录写入。
5. 观察是否仍然自动开始 followUp。

| 观察点 | 模型请求次数 | 队列暂停 | 待处理 followUp |
| --- | --- | --- | --- |
| 最后一次停止后、释放闸门前 | 1 | true | 1 |
| 旧 Run 结束后 | 2 | false | 0 |

事件顺序为：

`run_end(aborted) → run_start → input_consumed(followUp) → run_end(completed)`

最后一次停止本应继续有效，实际却自动执行了下一条要求。

原因集中在 [session-agent.ts](../../apps/agent/src/session-agent.ts)：

- `abortActiveRun`（613–622 行）遇到已经取消的 signal 就提前返回，因此第二次停止没有执行 `resumeAfterTermination = false`。
- `finalizeRun`（1514–1516 行）仍根据这个旧标记解除暂停。
- `startQueuedRun` 的完成回调（1069–1073 行）随后启动下一轮。

后续修复必须保证最后一次停止覆盖此前的继续请求，并覆盖旧 Run 仍在模型等待、写入结束记录等不同阶段的情况。这个问题还说明：分散保存暂停、取消和继续状态，容易让更新顺序决定最终行为。

## R02：一个 Run 的结束状态分散在多个地方

[session-agent.ts](../../apps/agent/src/session-agent.ts) 同时保存 `activeRun` 与 `ownedRunResultPromise`。读者还需要追踪 `terminalResultPromise`、`resumeAfterTermination` 和 `inputsPaused`，才能判断当前能否开始新操作。

当前会出现 `activeRun === null`，但 Run 的完成 Promise 还没有清空的阶段。`run_end` 已发出，执行权仍未释放。这个内部顺序已经影响调用者：

- [TUI view](../../apps/tui/src/view.ts) 在结束事件后用 `setImmediate` 再刷新一次状态。
- [prompt-helper](../../apps/agent/test/prompt-helper.ts) 在等到 `run_end` 后，还需要等一次 `setImmediate` 才能继续会话控制。

这些等待不是清楚的领域行为，而是调用者对内部时序的补偿。

pi 的 `packages/agent/src/agent.ts:486` 用 `runWithLifecycle` 集中创建当前 Run，并在 `finally` 中调用 `finishRun`。可以借鉴这个组织方式：同一个 Run 对象持有取消与完成状态，集中规定清理、释放和通知的顺序。

## R03：消息队列混入了不同的执行用途

[QueuedInput](../../apps/agent/src/session-agent.ts)（139 行）通过 `internalInput?`、`controlCall?`、`completion?` 混合普通消息、成员投递和直接 Tool 操作。

这些字段不只是额外数据，还改变执行规则：直接 Tool 操作可以绕过队列暂停检查、禁止消费 steer；是否携带 completion 又决定是否有人等待终态。类型没有直接表达这些组合，读者要从分支中推断。

pi 的 `packages/agent/src/agent.ts:125` 中，`PendingMessageQueue` 主要处理消息的入队和取出。后续应让队列项目的含义明确，用少量判别类型表达真正不同的输入；直接 Tool 操作复用必要的执行能力，不必伪装成普通消息队列的一种特殊情况。

## R04：消息提交顺序被回调拆开

当前路径位于 [session-agent.ts](../../apps/agent/src/session-agent.ts)：

`consumeInput → recordMessage → beforePublish 回调 → 返回 consumeInput`

`consumeInput`（1117 行）把出队和首次 `run_start` 发布放进回调，交给 `recordMessage`（1410 行）在保存与更新历史之后调用；函数返回后，再发 `input_consumed` 并确认成员投递。

理解这段代码，需要同时记住两处函数体中“保存、更新历史、出队、Run 开始、消息事件、投递确认”的位置。`messageStartAlreadyPublished` 这个布尔参数还要求调用者知道消息事件已经走到了哪一步。

pi 的 `packages/agent/src/agent-loop.ts:200` 把处理输入、更新消息和继续模型请求顺序写在循环中。Anthias 可以保留先保存后推进的约束，同时让提交返回 Entry，由消费流程直接写出后续动作，减少回跳。

## R05：Session 合并文件后，转发层仍然存在

[session/index.ts](../../apps/agent/src/session/index.ts) 中，`createSessionView`（387 行）先创建 `createSessionWriter`，再逐项转发追加、查询和关闭方法。`Session` 类型还通过私有工厂的 `ReturnType` 拼出来。

这让读者在“Session 是什么”和“Session 怎样工作”之间多跳了一层。删除 `writer.ts` 并没有删除这个对象与转发关系。

pi 的 `packages/coding-agent/src/core/session-manager.ts:1071` 中，`appendMessage` 直接构造 Entry，再调用 `_appendEntry`。后续可以让持有 Entry 的工厂直接返回完整 Session，底层文件读写继续负责自身的校验和资源关闭。是否使用 class 不是这里的关键。

## R06：读取 context 隐藏了两次完整构造

[session-agent.ts](../../apps/agent/src/session-agent.ts)（376 行）的 `state.context` 是 getter，实际调用 [context/index.ts](../../apps/agent/src/context/index.ts) 的 `projectMessages`，继续进入 [projectContextHistory](../../apps/agent/src/context/projection.ts)。

这个过程会复制记录列表、筛选消息、构造身份映射、分组，再选择压缩节点和来源。模型请求包装层随后又调用一次 `projectHistory(rawRequest.messages)`。

因此，表面上的“读取状态”隐藏了完整上下文构造。Header 的最新压缩引用是在前面的全量处理之后才使用，并没有让普通读取只处理压缩后的有效部分。本轮未做性能基准，不给出耗时或加速比例。

pi 的 `packages/coding-agent/src/core/session-manager.ts:418`、`:461` 分别明确构造有效 Entry 和模型消息；Agent 另有运行时消息状态。单一事实来源不等于禁止保留用途明确的运行时视图。后续应明确何时增量更新、何时重建，避免 getter 和请求包装层重复承担构造工作。

## 注释为什么难读

下面的修改示例用于说明问题，本次没有改写源码注释。

| 位置与原注释 | 问题 | 更直接的表达 |
| --- | --- | --- |
| `session-agent.ts:1034`：“先登记整轮所有权，终态订阅者的新输入只会留给封口后的下一轮。” | 抽象词遮住了实际的 Promise 检查。 | “先记录当前 Run 的完成 Promise，避免 run_end 回调启动第二个 Run。” |
| `session-agent.ts:1263`：“持久化 Agent Loop 事实，再投影为稳定的公开 AgentEvent。” | 没说明保存什么，还容易让人误以为所有事件都会落盘。 | “更新消息和工具状态并转发事件；有副作用的工具先保存开始记录。” |
| `session/index.ts:533`：“追加或身份检查失败后不能把旧 context 用于后续副作用……” | 存储层的注释跳到 Context 和副作用，实际代码只是在禁止后续追加。 | “写入或文件校验失败后拒绝后续追加；关闭仍等待已接受的写入结束。” |

注释应说明具体的原因和顺序，例如为什么此处要等待、失败后禁止哪项动作。不能靠“事实、投影、所有权、封口、交付”等词替代这些解释。若调整结构后某条注释不再需要，应删除，而不是换一组抽象说法。

## 留给后续 Feature 的方向

开发者已明确，后续 Feature 将参考 pi 调整项目结构，目标是降低理解成本。本次仅保存审查，不创建后续 Spec、Plan，也不在本轮开始结构改造。

建议围绕三项职责重新组织主流程：

1. **Session** 保存 Entry，提供历史读取与上下文构造。追加方法直接返回提交的 Entry，减少中间对象和转发。
2. **AgentState** 明确持有运行时消息、当前 Run 和输入队列。历史与模型上下文可以是用途不同的视图，更新方式必须清楚。
3. **Agent Loop** 顺序处理模型、完整 Tool batch、steer 与 followUp。Run 的开始、结束和取消集中处理，调用者不应依赖额外事件循环等待。

pi 是组织方式的参考，不能默认覆盖 Anthias 已确认的行为：父引用与压缩前后导航、先落盘后执行、完整 Tool batch 后插入、成员来源与权限、旧历史兼容及恢复规则仍需保留。需要改变这些合同的地方，应在后续 Feature 中逐项说明。

验收时应能沿一条消息直接追踪保存、更新视图和继续执行的步骤；文件数、测试数量和统一命名模板都不能单独证明理解成本下降。

## 证据与未完成范围

- 上一轮 `pnpm verify`：50 个测试文件通过，607 项通过、1 项跳过。这是当时覆盖场景的结果，不等于本次审查通过。
- 本次只运行 R01 的新增定向复现。通过标准输入执行 Node.js 脚本，使用本地可控模型流和临时 Session；耗时 1.45 秒，退出码 0。核对了源码与执行用 dist 的相关分支；最后关闭 Agent 并清理临时目录，没有添加永久测试。
- 保存文档前，在内存中去除类型与注释后核对了 `context/index.ts`、`context/projection.ts` 与上轮构建产物，可执行代码一致。本轮测试 TypeScript 检查、Biome 检查、文档链接检查和差异空白检查通过；只整理了 `projection.ts` 的格式，未改动注释原文与业务逻辑。
- 没有重复运行全套测试，也没有调用真实模型或外部服务。临时脚本和原始运行输出不进入提交，复现步骤和观察结果保存在本文。
- R01 尚未修复，R02–R06 及注释问题尚未整改。未确认的其他候选没有列为缺陷。
- 本次提交保存当前实现与审查结论，不代表 Feature 已验收，也不表示上述问题已经解决。
