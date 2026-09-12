# Feature 015 模型能力核验

状态：已定义

## 开发者速览
> **一句话**：实际调用名 deepseek-flash 对应 V4.1 Flash，旧能力条目需要同步。<br>
> **核心做法**：交叉核对官方模型说明、价格页与集成配置。<br>
> **边界**：只读取公开资料，没有调用真实 Provider。<br>
> **风险 / 未验证**：服务端限额可能变化，实际请求仍记录采用参数。<br>
> **当前 / 请审阅**：2026-09-12 核验完成，用于本 Feature 的能力表与预算修正。

[官方发布说明](https://deepseek.com/news/deepseek-v4-1-flash/) 明确 deepseek-flash 为 V4.1 Flash 调用名，旧 deepseek-v4-flash 与 deepseek-v4-flash-vision-exp 暂时映射到同一版本。

[官方模型详情](https://api-docs.deepseek.com/quick_start/pricing/) 声明 1M 上下文与最大 384K 输出；[官方集成配置](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/) 给出精确上下文 1,048,576。

项目仅更新数据表与旧别名映射，普通 Coding 默认仍为 64,000，不把模型最大输出当作每次请求的策略。摘要与审核保留独立预算。没有据此修改 Provider 类型或引入模型专用执行分支。
