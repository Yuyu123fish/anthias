import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@anthias/agent": fileURLToPath(new URL("./apps/agent/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["apps/**/*.test.ts"],
  },
});
