#!/usr/bin/env node

import { parseArgs } from "node:util";
import { createAgentFromEnvironment, type PermissionMode } from "@anthias/agent";
import { runTui } from "./index.js";
import { resolveStartupPaths, StartupPathError, type StartupPaths } from "./startup.js";

/** 创建生产 Agent 并进入 TUI；启动配置无效时以非零状态退出。 */
async function main(): Promise<number> {
  let sessionId: string | undefined;
  let requestedWorkspace: string | undefined;
  let permissionMode: PermissionMode = "agent";
  try {
    const parsedArguments = parseArgs({
      args: process.argv.slice(2),
      options: {
        session: { type: "string" },
        mode: { type: "string" },
        workspace: { type: "string" },
      },
      allowPositionals: false,
      strict: true,
    });
    sessionId = parsedArguments.values.session;
    requestedWorkspace = parsedArguments.values.workspace;
    const requestedMode = parsedArguments.values.mode;
    if (
      requestedMode !== undefined &&
      requestedMode !== "agent" &&
      requestedMode !== "plan" &&
      requestedMode !== "auto_allow"
    ) {
      throw new Error("invalid mode");
    }
    permissionMode = requestedMode ?? "agent";
  } catch {
    process.stderr.write(
      "命令行参数无效；支持 --workspace <path>、--session <UUID> 与 --mode <agent|plan|auto_allow>。\n",
    );
    return 1;
  }

  let startupPaths: StartupPaths;
  try {
    startupPaths = await resolveStartupPaths({
      invocationWorkingDirectory: process.cwd(),
      environment: process.env,
      ...(requestedWorkspace === undefined ? {} : { requestedWorkspace }),
    });
  } catch (error) {
    process.stderr.write(
      `${error instanceof StartupPathError ? error.message : "Anthias 启动路径解析失败。"}\n`,
    );
    return 1;
  }

  const agentCreationResult = await createAgentFromEnvironment(
    sessionId === undefined
      ? {
          workspaceRoot: startupPaths.workspaceRoot,
          sessionDirectory: startupPaths.sessionDirectory,
          permissionMode,
        }
      : {
          workspaceRoot: startupPaths.workspaceRoot,
          sessionDirectory: startupPaths.sessionDirectory,
          sessionId,
          permissionMode,
        },
  );
  if (!agentCreationResult.ok) {
    process.stderr.write(`${agentCreationResult.error}\n`);
    return 1;
  }

  try {
    return await runTui({ agent: agentCreationResult.agent });
  } finally {
    // 暂停输入仍可能保留 Windows 管道引用；业务与终端关闭后再释放，避免提前结束清理。
    process.stdin.unref?.();
  }
}

try {
  process.exitCode = await main();
} catch {
  process.stderr.write("Anthias 启动失败。\n");
  process.exitCode = 1;
}
