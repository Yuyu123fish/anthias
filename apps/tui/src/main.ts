#!/usr/bin/env node

import { createAgentFromEnvironment } from "@anthias/agent";
import { runTui } from "./index.js";

/** 创建生产 Agent 并进入 TUI；启动配置无效时以非零状态退出。 */
async function main(): Promise<number> {
  const agentCreationResult = createAgentFromEnvironment();
  if (!agentCreationResult.ok) {
    process.stderr.write(`${agentCreationResult.error}\n`);
    return 1;
  }

  return runTui({ agent: agentCreationResult.agent });
}

try {
  process.exitCode = await main();
} catch {
  process.stderr.write("Anthias 启动失败。\n");
  process.exitCode = 1;
}
