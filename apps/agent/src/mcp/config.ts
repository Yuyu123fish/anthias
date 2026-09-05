import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type McpConfigFile = { path: string; source: string };
export type McpServerConfig = {
  id: string;
  name: string;
  source: string;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  url: string;
  environmentReferences: Record<string, string>;
  headerReferences: Record<string, string>;
  error: string | null;
};

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_SERVERS = 32;
const IDENTIFIER = /^[a-zA-Z0-9_.-]{1,64}$/;
const ENVIRONMENT_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export async function readMcpConfig(options: {
  workspaceRoot: string;
  environment: NodeJS.ProcessEnv;
  configFiles?: readonly McpConfigFile[];
}): Promise<McpServerConfig[]> {
  const files = options.configFiles ?? [
    { path: join(homedir(), ".anthias", "mcp.json"), source: "user" },
    { path: join(options.workspaceRoot, ".anthias", "mcp.json"), source: "project" },
    ...(options.environment.ANTHIAS_MCP_CONFIG
      ? [
          {
            path: resolve(options.workspaceRoot, options.environment.ANTHIAS_MCP_CONFIG),
            source: "extra",
          },
        ]
      : []),
  ];
  const servers: McpServerConfig[] = [];
  const paths = new Set<string>();
  for (const file of files.slice(0, 8)) {
    const configPath = resolve(file.path);
    if (paths.has(configPath)) continue;
    paths.add(configPath);
    let document: unknown;
    try {
      document = JSON.parse(await readBoundedConfig(configPath));
    } catch (error) {
      if (isMissingFile(error) && !options.configFiles && file.source !== "extra") continue;
      servers.push(invalidConfig(file, "MCP 配置无法读取、不是有效 JSON 或超过 64 KiB。"));
      continue;
    }
    if (!isRecord(document) || !isRecord(document.mcpServers)) {
      servers.push(invalidConfig(file, "MCP 配置需要 mcpServers 对象。"));
      continue;
    }
    const entries = Object.entries(document.mcpServers);
    if (entries.length + servers.length > MAX_SERVERS) {
      servers.push(invalidConfig(file, "MCP 配置总数超过 32 项；请减少配置后重启。"));
      continue;
    }
    for (const [name, value] of entries) {
      const config = parseServer(file, name, value, options.workspaceRoot);
      if (servers.some((server) => server.id === config.id)) {
        config.error = "MCP 来源和名称重复，无法唯一识别配置。";
        const duplicate = servers.find((server) => server.id === config.id);
        if (duplicate) duplicate.error = config.error;
      }
      servers.push(config);
    }
  }
  return servers;
}

function parseServer(
  file: McpConfigFile,
  name: string,
  value: unknown,
  workspaceRoot: string,
): McpServerConfig {
  const config: McpServerConfig = {
    id: `${IDENTIFIER.test(file.source) ? file.source : "invalid-source"}:${IDENTIFIER.test(name) ? name : "invalid-entry"}`,
    name: IDENTIFIER.test(name) ? name : "invalid-entry",
    source: IDENTIFIER.test(file.source) ? file.source : "invalid-source",
    transport: "stdio",
    command: "",
    args: [],
    url: "",
    environmentReferences: {},
    headerReferences: {},
    error: null,
  };
  try {
    if (!IDENTIFIER.test(name) || !IDENTIFIER.test(file.source) || !isRecord(value))
      throw new Error("id");
    const transport = value.transport ?? (typeof value.command === "string" ? "stdio" : "http");
    config.environmentReferences = parseReferences(value.env);
    config.headerReferences = parseReferences(value.headers);
    if (transport === "stdio") {
      if (
        typeof value.command !== "string" ||
        value.command.length === 0 ||
        value.command.length > 4096 ||
        /[\r\n\0]/.test(value.command)
      )
        throw new Error("command");
      if (
        value.args !== undefined &&
        (!Array.isArray(value.args) ||
          value.args.length > 64 ||
          value.args.some(
            (argument) =>
              typeof argument !== "string" || argument.length > 4096 || argument.includes("\0"),
          ))
      )
        throw new Error("args");
      config.command =
        value.command.includes("/") || value.command.includes("\\")
          ? isAbsolute(value.command)
            ? value.command
            : resolve(workspaceRoot, value.command)
          : value.command;
      config.args = value.args === undefined ? [] : (value.args as string[]);
      if (Object.keys(config.headerReferences).length) throw new Error("headers");
    } else if (transport === "http" || transport === "streamable-http") {
      config.transport = "http";
      if (typeof value.url !== "string" || value.url.length > 4096) throw new Error("url");
      const endpoint = new URL(value.url);
      if (
        !["http:", "https:"].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.hash
      )
        throw new Error("url");
      config.url = endpoint.toString();
      if (Object.keys(config.environmentReferences).length) throw new Error("env");
      for (const header of Object.keys(config.headerReferences)) {
        if (
          !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header) ||
          /^(host|content-length|connection|mcp-.+)$/i.test(header)
        )
          throw new Error("header");
      }
    } else throw new Error("transport");
  } catch {
    config.error =
      "MCP 配置无效：检查 transport、command/args 或 URL；env/headers 的值必须是环境变量名。";
  }
  return config;
}

function parseReferences(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).length > 32) throw new Error("references");
  const references: Record<string, string> = {};
  for (const [name, reference] of Object.entries(value)) {
    if (typeof reference !== "string" || !ENVIRONMENT_NAME.test(reference))
      throw new Error("reference");
    if (name.length > 128 || /[\r\n\0=]/.test(name)) throw new Error("name");
    references[name] = reference;
  }
  return references;
}

function invalidConfig(file: McpConfigFile, error: string): McpServerConfig {
  return {
    id: `${file.source}:config-error`,
    name: "config-error",
    source: IDENTIFIER.test(file.source) ? file.source : "invalid-source",
    transport: "stdio",
    command: "",
    args: [],
    url: "",
    environmentReferences: {},
    headerReferences: {},
    error,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

async function readBoundedConfig(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let totalBytes = 0;
    while (totalBytes < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        totalBytes,
        buffer.byteLength - totalBytes,
        totalBytes,
      );
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
    }
    if (totalBytes > MAX_CONFIG_BYTES) throw new Error("size");
    return buffer.subarray(0, totalBytes).toString("utf8");
  } finally {
    await handle.close();
  }
}
