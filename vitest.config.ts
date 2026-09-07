import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@anthias/agent": fileURLToPath(new URL("./apps/agent/src/index.ts", import.meta.url)),
    },
  },
  test: {
    // Windows 流程测试会启动本地 Shell/Git；约束并行进程数量，避免就绪等待被资源争抢拖延。
    maxWorkers: 4,
    include: ["apps/**/*.test.ts"],
  },
});
