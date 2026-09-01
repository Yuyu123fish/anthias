#!/usr/bin/env node

import { createAgent } from "@anthias/agent";
import { readModelConfig } from "./config.js";
import { runTui } from "./index.js";
import { createOpenAICompatibleModelStream } from "./model-adapter.js";

async function main(): Promise<number> {
  const modelConfigResult = readModelConfig();
  if (!modelConfigResult.ok) {
    process.stderr.write(`${modelConfigResult.error}\n`);
    return 1;
  }

  const agent = createAgent({
    modelStream: createOpenAICompatibleModelStream(modelConfigResult.config),
  });
  return runTui({ agent });
}

try {
  process.exitCode = await main();
} catch {
  process.stderr.write("Anthias 启动失败。\n");
  process.exitCode = 1;
}
