#!/usr/bin/env node

import { createAgent } from "@anthias/agent";
import { readModelConfig } from "./config.js";
import { runTui } from "./index.js";
import { createOpenAICompatibleModelStream } from "./model-adapter.js";

async function main(): Promise<number> {
  const config = readModelConfig();
  if (!config.ok) {
    process.stderr.write(`${config.error}\n`);
    return 1;
  }

  const agent = createAgent({
    modelStream: createOpenAICompatibleModelStream(config.config),
  });
  return runTui({ agent });
}

try {
  process.exitCode = await main();
} catch {
  process.stderr.write("Anthias 启动失败。\n");
  process.exitCode = 1;
}
