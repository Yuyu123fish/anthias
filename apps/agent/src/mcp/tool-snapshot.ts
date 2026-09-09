import type { JSONSchema7 } from "ai";
import { estimateTextTokens } from "../context/budget.js";
import type { PermissionMode } from "../permission/permission-mode.js";
import type { ModelToolDefinition } from "../tool/definitions.js";
import type { McpToolInfo } from "./index.js";

/** 可见定义和执行用 generation 一起归属一个请求；连接后续变化不能替换其中的工具身份。 */
export type McpToolSnapshot = Readonly<{
  tools: readonly Readonly<McpToolInfo>[];
  definitions: readonly ModelToolDefinition[];
  omittedToolCount: number;
}>;

export function createMcpToolSnapshot(options: {
  tools: readonly McpToolInfo[];
  reservedDefinitions: readonly ModelToolDefinition[];
  permissionMode: PermissionMode;
}): McpToolSnapshot {
  const tools = Object.freeze(
    [...structuredClone(options.tools)]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((tool) => Object.freeze(tool)),
  );
  const definitions: ModelToolDefinition[] = [];
  let omittedToolCount = 0;
  if (options.permissionMode !== "plan")
    for (const tool of tools) {
      const definition: ModelToolDefinition = {
        name: tool.name,
        description: tool.description,
        inputSchema: structuredClone(tool.inputSchema) as JSONSchema7,
      };
      if (
        options.reservedDefinitions.length + definitions.length >= 64 ||
        estimateTextTokens(
          JSON.stringify([...options.reservedDefinitions, ...definitions, definition]),
        ) > 12000
      ) {
        omittedToolCount += 1;
        continue;
      }
      definitions.push(Object.freeze(definition));
    }
  return Object.freeze({ tools, definitions: Object.freeze(definitions), omittedToolCount });
}

export function resolveMcpTool(
  snapshot: McpToolSnapshot | undefined,
  name: string,
): Readonly<{ tool: Readonly<McpToolInfo>; visible: boolean }> | null {
  const tool = snapshot?.tools.find((candidate) => candidate.name === name);
  return tool && snapshot
    ? { tool, visible: snapshot.definitions.some((definition) => definition.name === name) }
    : null;
}
