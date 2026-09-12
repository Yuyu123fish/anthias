# Plan：Agent 运行对象与工具组织

状态：已实现

## 开发者速览

> **一句话**：完成单 Agent 状态集中、同源工具装配与 Session 内部整理。<br>
> **核心做法**：先固定接口，再由互不重叠的区域完成实现，统一验证集成结果。<br>
> **边界**：一个 Plan 交付完整内部重构，保持已有用户行为与存储合同。<br>
> **风险 / 未验证**：授权来源、请求隔离、写入封口和共享关闭属于关键检查点。<br>
> **当前 / 请审阅**：本 Plan 的实现与验证已完成，证据见 Report，等待开发者验收。

## 当前基线

- `main @ c7b8853`，开始时工作区干净；Node.js 24.13.1、pnpm 10.33.0。
- Agent 83 个生产 TypeScript 文件；Session 14 文件 / 7,991 行，Tool 23 文件 / 5,065 行，Git 3 文件 / 2,186 行；行数包含空行与注释。
- package 入口有 1 个生产工厂、46 个类型导出。SessionAgent 1,334 行，Runtime 159 行。
- 基线可信验证沿用 Feature 011 Report：577 个不同用例通过、1 个平台条件跳过；本 Feature 新改动单独验证，不重复启动基线全量测试。
- Pi 参考为本地 `6160683` 的 `packages/agent/src/agent.ts`、`types.ts`：Agent 持有状态和 Run 资源，Context 为 Loop 输入快照，AgentSession 的 state 委托 Agent。只采用已确认职责，不移植其公开可变状态、Provider 暴露或事件等待语义。

## 实施工作包

### 核心运行对象

统筹修改 SessionAgent、Runtime、Agent Loop 及必要 Context 接线。把消息、消息身份、当前回复、审批、失败和运行资源迁入明确持有对象，删除旧散落变量；组合 Session、Context、工具和权限能力。请求准备同时形成模型定义和绑定执行计划，保留原 ModelRequest 身份。根/成员复用共同配置与装配，成员来源和只读限制显式保留。

### 工具与 Git

执行 Agent 修改 `tool/`、`git/`、`external-capabilities.ts` 和所属定向测试。内部 AgentTool 包含 definition 与 createPlan；基础工具自身提供对象，扩展按模式提供工具集合。模型定义与 runner 从同一集合投影，未知/隐藏工具继续拒绝。保留测试用 ToolRunner seam。外部请求准备保留 MCP 快照并交付绑定工具。Git Tool 与实现归位，直接导入 GitWorkspace 类型；相对 import 路径由各区域持有者更新。命令输出逻辑只在确有共同状态时聚合，不改变进程与临时产物关闭。

### Session 职责

执行 Agent 修改 `session/` 和所属测试。Message codec 从 schema 中抽出，Schema 验证权威不复制；清理 pending/trash 恢复收进内部状态模块；list/history 合为只读查询入口，查询摘要类型由 Session 提供或结构兼容引用，消除对 agent-controls 的反向依赖。writer、lock、locations 既有合同保持。跨区域消费路径由统筹更新。

## 并行接口与所有权

- 工具对象及工具集合接口由工具执行 Agent 固定并通知统筹；SessionAgent/Runtime 由统筹接入，工具执行 Agent 不改这两个文件。
- Session 执行 Agent 不改 Agent/Context/协作模块，列出旧导出与新导出映射供统筹接入。
- 不互相覆盖文件，不重复相同版本的约定测试，不提交、不调用真实网络或读取凭据。
- 所有工作包完成后统一格式与类型检查；必要接口修复集中在统筹。

## 验证

各区完成时用本地确定性定向用例覆盖所改合同，只补能区分回归的必要用例：

- 核心：Agent、AgentControls、Context/MCP 快照与 MultiAgent 的状态、停止、来源及恢复。
- 工具：文件/命令完整循环、权限、调度、Git 三套与必要动态工具行为。
- Session：session、recovery、locations、cleanup 四套；测试 import 调整不改变断言。
- 工具或 Session 定向验证若需要尚未完成的接线，先汇报由统筹完成后执行，不反复运行已知不完整版本。
- 最终 `pnpm verify` 一次覆盖 Biome、类型检查、生产构建和全部本地测试。失败先定位并修复，按影响范围复验。
- 一位非作者对照 A01–A09 做一次独立审查，不重复执行测试；确认问题修复后只补必要验证。
- 对比 package 入口、真实消费者、状态写入点、工具名单及 Git/Session 路径；`git diff --check` 和文档相对链接检查。

## 风险与停止条件

不得通过改断言掩盖行为退化；不得把工具可见性作为权限、把共享连接改为单 Agent 独占或改动持久化格式。发现必须扩大公开合同、产品语义或外部验证范围时停止对应工作并回到讨论；正常实现错误在已授权范围内修复。

## 汇报与 Git

维护统一 Tasks 和 Report，报告前后调用链、资源归属、实际命令与结果、未验证边界及工作区范围。完成标为“已实现”，开发者验收前不改成“已验收”；稳定产品文档在验收后同步。实现后的本地提交已获得开发者单独授权；不推送或创建 PR。
