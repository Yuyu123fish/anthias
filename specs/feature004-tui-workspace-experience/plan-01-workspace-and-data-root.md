# Feature 004 Plan 01：工作区启动与 Anthias Data Root

状态：已实现

## 开发者速览

> **一句话**：先交付从任意目录启动、显式选择 Workspace 与集中保存 Session 的完整闭环。<br>
> **核心做法**：CLI 分别解析 Workspace、Anthias Project Root 和 Session Directory，再显式装配 Agent。<br>
> **边界**：保留现有行式 TUI，不提前实现 Reasoning、Shiki 或动态终端布局。<br>
> **风险 / 未验证**：模块位置解析、Windows 路径、Session mismatch 和旧目录兼容最易出错。<br>
> **当前 / 请审阅**：已实现并提交为 `8b2f2f8`；T001–T003 与完整门禁通过。

- 对应 Spec：[spec.md](spec.md)
- 任务事实源：[tasks.md](tasks.md)
- 后续 Plan：[Plan 02](plan-02-agent-observability.md)

## 1. 当前基线与交付范围

- CLI 只解析 `--session` 与 `--mode`，默认把进程 `cwd` 直接交给 Agent。
- 生产工厂把规范化 Workspace Root 同时用于 Tool 工作区和默认 Session 目录。
- `ANTHIAS_SESSION_DIR` 当前接受相对路径；全部启动失败被压成同一个 Session 错误。
- TUI 启动时输出一次 Workspace，但输入位置没有稳定的运行上下文行。

本 Plan 只交付 Spec 的启动与存储闭环：

1. 当前目录和 `--workspace <path>` 都能成为明确 Workspace Root；
2. 默认 Session 进入 Anthias Project Root 下的 `data/conversation`；
3. Session 继续绑定创建时的 Workspace，错误工作区不能重开；
4. 每次等待输入时都能看到完整 Workspace、模式和 Session；
5. 旧 Session 不扫描、不迁移、不删除。

## 2. 已确定的模块与 Interface

### 2.1 启动装配

- `apps/tui` 的启动 Module 负责解析 CLI 路径语义，不把路径判断放进 renderer。
- 相对 `--workspace` 以调用 Anthias 时的 `cwd` 为基准；省略时直接使用该 `cwd`。
- Workspace 必须经 `realpath` 规范化并确认是目录；失败发生在 Session 创建与模型请求之前。
- Anthias Project Root 从启动模块的 `import.meta.url` 和已知仓库发行布局确定，并校验根 `package.json` 的项目身份；禁止从用户 Workspace 向上搜索。
- 源码构建产物与本地 link 后的 bin 都必须解析到同一个 Anthias Project Root。

### 2.2 Session Directory

- 启动 Module 形成独立的 `workspaceRoot` 与 `sessionDirectory`，两者作为显式值交给生产 Agent 工厂。
- 默认 `sessionDirectory` 是 `<Anthias Project Root>/data/conversation`。
- 非空 `ANTHIAS_SESSION_DIR` 只接受绝对路径；相对值直接返回可操作错误，不再相对用户 `cwd` 展开。
- 生产 Agent 工厂不再从 Workspace Root 推导 Session Directory；其创建选项将 `sessionDirectory` 设为必需装配值。
- 根 `.gitignore` 明确忽略 `/data/`；Session 目录内部仍保留既有 `.gitignore` 保险。

### 2.3 启动失败

- `AgentCreationResult` 的失败分支增加稳定 reason，至少区分模型配置、Session busy、Session changed、Workspace mismatch、Session 无效和 Shell / 存储不可用。
- TUI 只呈现安全的可操作消息，不接收 Provider 配置或底层异常。
- Workspace mismatch 显示当前 Workspace 与 Session Header 中记录的 Workspace，并提示回到所属目录或创建新 Session；不会自动切换目录。
- 无效 Workspace、相对 Session override 和 mismatch 均不得产生模型请求或 Tool 副作用。

### 2.4 Plan 01 呈现

- 保留现有 `runTui()` 与 Node.js `readline`。
- 在启动历史之后和每次重新等待输入前输出一条紧凑上下文行，包含完整 `cwd`、Permission Mode、Session 短 ID 与 idle / active 状态。
- 这一行是后续固定底栏的数据与文案基线；真正的动态底栏和 resize 由 Plan 04 交付。
- 非 TTY 继续输出确定性纯文本，不加入 ANSI 或光标控制。

## 3. 实施顺序

1. 先通过编译后 CLI 测试写出两个 Workspace 共用同一 Anthias Data Root 的失败断言。
2. 拆出可测试的启动路径解析，加入 `--workspace` 与 Anthias Project Root 解析。
3. 把 `sessionDirectory` 改成生产工厂的显式输入，收紧绝对 override。
4. 为 Session 启动失败保留稳定 reason，并补齐 mismatch 的安全文案。
5. 把上下文行接入当前行式 TUI，保持输入、approval、停止与退出语义。
6. 完成定向门禁、更新 Tasks 和唯一 Report 后停止。

## 4. 验证

定向验证：

```text
pnpm exec vitest run apps/agent/test/startup.test.ts apps/agent/test/session.test.ts apps/tui/test/main.test.ts apps/tui/test/tui.test.ts
pnpm check
```

必须证明：

- 两个临时 `cwd` 通过同一个编译后 bin 启动时，各自 Header 记录正确 Workspace；
- 两份新 Session 都位于同一个 Anthias `data/conversation`，两个 Workspace 与 `apps/tui` 不产生默认 Session；
- 相对和绝对 `--workspace` 等价，无效文件、缺失目录与未知参数在副作用前失败；
- 绝对 `ANTHIAS_SESSION_DIR` 继续可用，相对 override 被拒绝；
- 同 Workspace 可以重开，错误 Workspace 明确 mismatch；
- 旧目录不被扫描、移动、复制或删除；
- 上下文行在启动、一次 Run 结束和拒绝输入后仍显示准确路径。

## 5. 风险与停止条件

- 若已知构建布局无法从 `import.meta.url` 稳定找到 Anthias Project Root，先解决发行布局；不能回退为扫描用户 Workspace。
- 若细分启动错误要求把原始异常、API Key 或 Provider 响应交给 TUI，停止并在 Agent 内收敛安全 reason。
- 若兼容需要修改 Session Header 或 Schema 1，停止并回到 Spec。
- 若发现已有修改与启动或 Session 文件重叠，不重置、不覆盖，先报告冲突。

## 6. 汇报与停止

- Report 记录已成立的路径语义、调用链、错误与验证，不声称新 TUI 已完成。
- 本 Plan 已按开发者后续连续实施授权完成独立提交；推送和 PR 未授权。
