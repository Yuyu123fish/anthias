# Feature 007 实施报告

状态：已实现

## 开发者速览
> **一句话**：SubAgent、AgentTeam 与 Git worktree 已实现并通过本地验证。<br>
> **核心做法**：复用 SessionAgent，根持有成员、权限与协作记录，Git 成果在独立目录形成。<br>
> **边界**：三个成员、一个活动 Team；没有新增 package、数据库或远端 Git 操作。<br>
> **风险 / 未验证**：真实 Provider 和人工终端体验仍待验证，worktree 不提供 OS 沙箱。<br>
> **当前 / 请审阅**：332 个测试通过，独立审查问题已修复，等待开发者验收。

## 交付行为

三个 Plan 连续实施，按开发者本轮“完整实施整个 Feature”的明确授权执行。实现沿用两个 package：Agent 增加协作与本地 Git 行为，TUI 增加语义命令和成员状态。

- **Git/worktree**：固定提交基线、脏主目录提示、受管目录归属、查询与暂存差异、明确路径本地提交、指定成果集成、冲突继续/中止、安全回收。Git 状态与完整审批指纹在执行前复核；操作意图与结果分别保存。
- **SubAgent**：默认只读，可写任务进入独立 worktree；成员只能执行自己的任务，运行端拒绝继续派生。根可以等待、停止、查看历史和产物、显式继续；完成后释放执行者。
- **AgentTeam**：Lead 创建一个活动团队并分派任务；成员可更新自己任务、交换同队消息。消息有界入队且稳定 ID 去重，不唤醒空闲成员；明确分派才开始下一 Run。
- **权限与停止**：委派和消息保存为内部来源，不生成真实用户授权记录。AutoAllow 核对根原文，人工审批显示来源成员。根权限变化在 Team 成员下一任务生效；停止和关闭等待成员、直接查询、工具预检和 Git 子进程收口。
- **持久化**：Schema 3 明确根与成员归属，保留日期平铺 JSONL 和 Schema 1/2 兼容。查看历史独立于工作目录；重开不自动调用模型。清理以整组最后活动与待交付资源为依据，不删除 Git 目录或分支。

## 文件与职责

| 位置 | 实际职责 |
| --- | --- |
| `apps/agent/src/agent.ts` | 根装配、公开控制、审批路由、整组关闭 |
| `apps/agent/src/session-agent.ts`、`context/` | 复用执行循环、有来源输入、请求前投递与上下文预算 |
| `apps/agent/src/multi-agent/` | 成员执行者、Team 任务、消息与组预算 |
| `apps/agent/src/git/` | 仓库状态、受管 worktree、本地提交与集成 |
| `apps/agent/src/tool/` | 新工具参数、权限、审批及取消合同 |
| `apps/agent/src/session/` | Schema、归属、追加顺序、兼容、历史与组清理 |
| `apps/tui/src/multi-agent-view.ts`、`command.ts` | 协作查看、命令发现和语义操作 |

没有新增依赖或 package。协作目录使用 `index.ts`、`members.ts`、`agent-team.ts`；Git 目录使用 `index.ts` 与 `command.ts`，没有预建 Registry、调度框架或多层 service。

## 验证

环境：Windows、Node.js v24.13.1、pnpm 10.33.0、Git 2.45.1.windows.1。所有模型行为使用确定性本地 ModelStream；Git 验证使用临时仓库及其测试提交。

最终版本执行 `pnpm verify` 通过：Biome 与 TypeScript 检查通过，两个 package 构建通过，35 个测试文件、332 个测试全部通过。测试阶段用时 95.98 秒；Biome 仅有不阻断检查的字符串模板建议。

| 验证范围 | 已成立证据 |
| --- | --- |
| Git 与审批 | 临时仓库覆盖固定基线、目录隔离、精确路径提交、集成继续/中止、冲突和回收保护；另覆盖审批后内容变化、超出预览截断范围的变化，以及被忽略文件的覆盖冲突。 |
| 公开 Agent 行为 | 六个协作场景覆盖来源与递归拒绝、两个可写成员及完整 Git 交付、Team 消息与重开、容量与停止、根真实授权和保留成员的权限同步。 |
| Session 与清理 | 覆盖 Schema 兼容、来源去重、独立追加和 Run 交接顺序、整组保护，以及清理中断后的恢复。 |
| TUI 与既有行为 | 命令经公开控制路由，单 Agent、模型适配、权限、命令执行和已有终端测试全部纳入统一门禁。 |

审查采用一次独立源码审查，后续只复核发现的问题。已修复并关闭成员权限滞后、Session 取锁与首输入交接、消息重投、清理半移动恢复和 Git 审批指纹等问题；原审查范围内没有剩余阻断项。最后的 Session 修复先通过定向用例，再纳入上述最终全量结果。

未运行真实 Provider 或人工终端演示。Git 取消的专门用例验证预先取消；成员停止、等待和关闭由公开 Agent 用例覆盖，不将这些结果泛化为所有 Git 钩子或外部程序的终止保证。

## 使用与边界

从 `/agents` 查看成员，使用 `/agent spawn` 或 `/team create` 开始；可写成员加 `--write`。从成员结果取得 worktree ID，核对差异，再显式提交和集成。完整命令与恢复步骤见 [Quick Start](../../quick-start.md#multiagent-与本地-git)。

工作目录默认 `data/worktrees/<根SessionID>/<worktreeID>`，历史默认 `data/conversation/<UTC日期>/<创建时间>-<SessionID>`。两者分别由 `ANTHIAS_WORKTREE_DIR`、`ANTHIAS_SESSION_DIR` 覆盖。成员 ID、worktree ID 与 commit 是不同对象，命令明确区分。

只读委派不要求 Git 仓库；可写成员要求普通仓库、有 HEAD，首版不支持子模块。集成按一次一个成果处理，成功暂存后显式继续形成本地提交。资源缺失、未决副作用、待处理消息和未交付成果保留诊断；程序不会自动重建工作区或重放动作。

本地验证不证明真实模型的任务分工质量，也不代替开发者的终端体验验收。当前没有 OS 沙箱；外部进程仍可能同时修改仓库，端口、数据库与外部服务也不会随 worktree 隔离。

## Git 与验收状态

实施基线为 `main / 3a8530e`。保留开始前已有的产品方向文档修改。2026-09-06，开发者授权将当前实现、测试、Feature 文档及产品方向说明一次性提交；未授权推送或创建 PR，没有调用真实 Provider。提交不改变验收状态，Feature 的最终验收由开发者完成。
