# Feature 001：基础 Agent Loop 与 TUI 对话实施报告

状态：已实现

- 文档类型：Report
- 对应 Spec：[spec.md](spec.md)
- 对应 Plan：[plan.md](plan.md)
- 对应 Tasks：[tasks.md](tasks.md)
- 实现基线：`main` / `ae142b0`

## 1. 已经成立的用户行为

- 模型配置缺失或 Base URL 本地格式无效时，TUI 在创建模型请求前给出安全提示并以非零状态码退出。
- 非空提示词会进入同一个内存 Agent，模型文本增量持续更新同一条 Assistant 消息；完成后明确展示完成状态并恢复输入。
- 后续提示词会携带此前用户与 Assistant 正文，包含失败或停止后保留的部分 Assistant 文本。
- 空白提示词与运行期间的第二个提示词分别返回 empty、busy 拒绝，不追加消息、不发布第二组事件，也不发起第二次模型请求。
- 运行时 `Ctrl+C` 停止当前响应，空闲时 `Ctrl+C` 退出；`/exit` 与 EOF 也进入统一退出路径。
- 失败只向 Agent 状态、终态事件和 TUI 暴露安全错误，原始 Provider 错误不会进入 Assistant 正文。

Feature 001 没有加入 Tool、文件或命令执行、Session、Compaction、重试队列、多 Provider、Desktop、Host、协议层、执行分叉或多 Agent 编排。

## 2. 入口与调用关系

```text
apps/tui/src/main.ts
  ├─ readModelConfig()                         请求前配置校验
  ├─ createOpenAICompatibleModelStream()       生产 Model Adapter
  ├─ createAgent()                             唯一消息与运行状态持有者
  └─ runTui()                                  输入、呈现、信号与退出清理

用户输入 → agent.prompt() → ModelStream → 文本增量
                                  ↓
TUI 呈现 ← AgentEvent ← Agent 状态更新与统一终结
```

`apps/tui` 单向依赖 `apps/agent`。Agent 公共面只有 state、prompt、abort、subscribe 及其必要类型；AI SDK 和 OpenAI-compatible Provider 类型只存在于 TUI 的生产 Adapter。

## 3. 并发、取消、失败与资源边界

- 一个 Agent 同时只有一个 active run；终态发布完成前仍保持 busy，避免同步订阅者重入 prompt 时把下一轮事件插入上一轮 `agent_end` 之前。
- completed、aborted、failed 共用同一终结路径，第一次终态生效；晚到增量、异常或取消不会再次结束本轮。
- abort 通过本轮 `AbortController` 取消底层请求，并与挂起的迭代器读取竞争；迭代器 `return()` 只做不阻塞终态的收尾。
- 失败和停止都会保留已生成正文，清除活动引用并恢复空闲；新一轮接受时清除上一轮安全错误。
- TUI 退出会先中止活动请求，等待当前 prompt 结束，再取消 Agent 订阅、移除 `SIGINT` 监听器并关闭 readline。输入读取不会在生成期间暂停，因此 EOF 和 `/exit` 可以及时触发退出。

## 4. 验证证据

环境：Windows，Node.js `v24.13.1`，pnpm `10.33.0`。

| 层级 | 命令 | 结果 |
| --- | --- | --- |
| 版本 | `node --version`、`pnpm --version` | 与 Plan 固定版本一致 |
| 安装 | `pnpm install --frozen-lockfile --offline` | 通过；lockfile 已同步，未下载依赖 |
| 审查修复回归 | `pnpm exec vitest run apps/agent/test/agent.test.ts apps/tui/test/tui.test.ts` | 2 个文件、12 个测试通过 |
| 完整门禁 | `pnpm verify` | Biome 检查 20 个文件、Strict TypeScript、构建通过；5 个测试文件、20 个测试通过 |

完整门禁覆盖 Agent 公共接口、事件顺序、只读快照、多轮上下文、empty / busy、终态重入、停止与晚到增量、失败恢复、订阅行为、TUI 流式呈现、SIGINT、EOF、配置预检、CLI 非零退出，以及本机 loopback OpenAI-compatible 流与禁用重试。loopback HTTP 只监听 `127.0.0.1`，没有访问外部网络。

## 5. 尚未验证与已知边界

- 未调用真实 DeepSeek V4 Flash、其他远端 Provider 或付费 API，也未读取真实凭据；因此不声称真实模型配置、网络连通性或 Provider 兼容性已经通过。
- `Ctrl+C` 已通过可控信号接缝验证运行时停止与空闲退出；尚未在真实 Windows 交互终端中进行人工按键体验验证。
- 当前是内存单会话 Agent；进程退出后不保存消息，这属于 Feature 001 的明确范围。
- README、AGENTS 和稳定技术文档已同步为“已实现、等待验收”，没有把本地验证写成“已验收”。

## 6. Git 边界

- 当前仍在 `main`，实现基线为 `ae142b0`。
- `.gitignore`、AGENTS、README、稳定 `docs/`、Feature 文档、工程配置、源码和测试组成同一个本地提交增量；合并提交范围已由开发者单独确认。
- 开始实施前已有的文档修改均被保留并按当前实现状态完成一致性收口，没有重置或覆盖。
- 未推送，也未创建 PR；这些动作仍需开发者分别授权。
