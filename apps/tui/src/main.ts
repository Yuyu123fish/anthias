#!/usr/bin/env node

import { parseArgs } from "node:util";
import { createAgentFromEnvironment } from "@anthias/agent";
import { runTui } from "./index.js";

/** 创建生产 Agent 并进入 TUI；启动配置无效时以非零状态退出。 */
async function main(): Promise<number> {
  let sessionId: string | undefined;
  try {
    const parsedArguments = parseArgs({
      args: process.argv.slice(2),
      options: { session: { type: "string" } },
      allowPositionals: false,
      strict: true,
    });
    sessionId = parsedArguments.values.session;
  } catch {
    process.stderr.write("命令行参数无效；仅支持无参数启动或 --session <UUID>。\n");
    return 1;
  }

  const agentCreationResult = await createAgentFromEnvironment(
    sessionId === undefined ? {} : { sessionId },
  );
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
