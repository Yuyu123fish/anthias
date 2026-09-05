# Feature 006 Plan 02：会话命令与外部 Skills

状态：已实现，待开发者验收

## 开发者速览

> **一句话**：在同一 Agent 中切换会话、主动压缩并使用外部 Skill。<br>
> **核心做法**：稳定 Agent 门面持有会话切换，Skill 有界读取，Context/Session 复用既有事实链。<br>
> **边界**：不生成 Skill，不提高脚本权限，不把外部内容当用户授权。<br>
> **风险 / 未验证**：会话切换、加载与恢复、取消和持久化失败已通过本地验证；真实 Provider 未调用。<br>
> **当前 / 请审阅**：会话命令、手动压缩与 Skill 已贯通，证据见 [Report](report.md)。

对应 [Spec](spec.md) 与 [Tasks](tasks.md)。依赖 `yaml@2.9.0`；保留 Node 24、ESM 和现有 Session 数据目录。

1. Skill 执行 Agent 仅负责 `skill/` 和聚焦测试：目录发现、元数据、冲突、加载、引用路径及大小限制。
2. 根 Agent 负责 Session 列表/原子切换、手动压缩和统一忙闲/取消；保持生产工厂与测试内部 seam。
3. 根 Agent 接入 Skill Tool、外部上下文事实与预算：加载去重，清除、恢复和文件变化诊断，权限审核仅引用真实授权。
4. TUI 调用这些语义行为，根 Agent 与 TUI 执行者补集成需要，不各自复制 Session 行为。

验证：Skill 执行者运行 `pnpm exec vitest run apps/agent/test/skill.test.ts` 并报告；根 Agent 运行新增 session/commands/context 集成测试及受影响 Agent 回归，复用 Skill 独立验证。检查取消/失败无丢历史、compact 不触发普通回复、Session 切换失败保留旧实例、来源改变不静默替换。

若需要越出配置来源、允许任意脚本或改变 Workspace 绑定则停止相关修改并报告；不得以宽泛文件权限替代受管加载。不提交。
