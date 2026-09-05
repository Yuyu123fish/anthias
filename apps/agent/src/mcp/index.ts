import { createHash } from "node:crypto";
import {
  Client,
  type JsonSchemaValidator,
  StreamableHTTPClientTransport,
  type Transport,
} from "@modelcontextprotocol/client";
import {
  DEFAULT_INHERITED_ENV_VARS,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { isRecord, type McpConfigFile, type McpServerConfig, readMcpConfig } from "./config.js";

export type McpActionResult<T> = { ok: true; value: T } | { ok: false; error: string };
export type McpServerInfo = {
  id: string;
  name: string;
  source: string;
  transport: "stdio" | "http";
  state: "disconnected" | "connecting" | "connected" | "error";
  generation: number;
  error: string | null;
  protocolVersion: string | null;
};
export type McpToolInfo = {
  name: string;
  serverId: string;
  originalName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  generation: number;
};
export type McpResourceInfo = { uri: string; name: string; description: string };
export type McpPromptInfo = {
  name: string;
  description: string;
  arguments: { name: string; description: string; required: boolean }[];
};
export type McpServerDetails = McpServerInfo & {
  tools: readonly McpToolInfo[];
  resources: readonly McpResourceInfo[];
  prompts: readonly McpPromptInfo[];
  diagnostics: readonly string[];
};
export type McpContent = {
  text: string;
  isError: boolean;
  truncated: boolean;
  sourceTruncated: boolean;
  unsupportedContent: boolean;
  originalText?: string;
};
export type McpConnections = {
  list(): readonly McpServerInfo[];
  tools(): readonly McpToolInfo[];
  connect(id: string, signal?: AbortSignal): Promise<McpActionResult<McpServerInfo>>;
  disconnect(id: string): Promise<McpActionResult<McpServerInfo>>;
  inspect(id: string, signal?: AbortSignal): Promise<McpActionResult<McpServerDetails>>;
  validateToolCall(
    name: string,
    argumentsValue: unknown,
    generation: number,
  ): McpActionResult<void>;
  callTool(
    name: string,
    argumentsValue: unknown,
    generation: number,
    signal?: AbortSignal,
  ): Promise<McpActionResult<McpContent>>;
  readResource(
    serverId: string,
    uri: string,
    signal?: AbortSignal,
  ): Promise<McpActionResult<McpContent>>;
  getPrompt(
    serverId: string,
    name: string,
    argumentsValue?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<McpActionResult<McpContent>>;
  close(): Promise<void>;
};

type BoundTool = {
  info: McpToolInfo;
  validateInput: JsonSchemaValidator<unknown>;
  validateOutput?: JsonSchemaValidator<unknown>;
};
type Connection = {
  config: McpServerConfig;
  info: McpServerInfo;
  client: Client | null;
  transport: Transport | null;
  cancellation: AbortController;
  pendingConnection: Promise<McpActionResult<McpServerInfo>> | null;
  boundTools: Map<string, BoundTool>;
  resources: McpResourceInfo[];
  prompts: McpPromptInfo[];
  diagnostics: string[];
  secrets: string[];
};

const MAX_LIST_ITEMS = 128;
const MAX_LIST_BYTES = 256 * 1024;
const MAX_WIRE_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const PREVIEW_BYTES = 32 * 1024;
const MAX_SCHEMA_BYTES = 16 * 1024;

/** 连接、请求和子进程由此对象持有；配置发现本身不触发进程或网络。 */
export async function createMcpConnections(options: {
  workspaceRoot: string;
  environment?: NodeJS.ProcessEnv;
  configFiles?: readonly McpConfigFile[];
  requestTimeoutMs?: number;
}): Promise<McpConnections> {
  const environment = options.environment ?? process.env;
  const configurations = await readMcpConfig({
    workspaceRoot: options.workspaceRoot,
    environment,
    ...(options.configFiles ? { configFiles: options.configFiles } : {}),
  });
  const connections: Connection[] = configurations.map((config) => ({
    config,
    info: {
      id: config.id,
      name: config.name,
      source: config.source,
      transport: config.transport,
      state: config.error ? "error" : "disconnected",
      generation: 0,
      error: config.error,
      protocolVersion: null,
    },
    client: null,
    transport: null,
    cancellation: new AbortController(),
    pendingConnection: null,
    boundTools: new Map(),
    resources: [],
    prompts: [],
    diagnostics: [],
    secrets: [],
  }));
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  let closed = false;

  function findConnection(id: string): McpActionResult<Connection> {
    const exact = connections.filter((connection) => connection.info.id === id);
    const matches = exact.length
      ? exact
      : connections.filter((connection) => connection.info.name === id);
    if (matches.length > 1) return failure("MCP 名称存在歧义，请使用包含来源的完整 ID。");
    const connection = matches[0];
    return connection ? success(connection) : failure("未找到 MCP 配置。");
  }

  function selectConnected(id: string): McpActionResult<Connection & { client: Client }> {
    const selected = findConnection(id);
    if (!selected.ok) return selected;
    if (closed || selected.value.info.state !== "connected" || !selected.value.client)
      return failure("MCP 未连接，请先显式连接该服务器。");
    return success({ ...selected.value, client: selected.value.client });
  }

  function requestOptions(connection: Connection, signal?: AbortSignal) {
    return {
      signal: AbortSignal.any([
        connection.cancellation.signal,
        ...(signal ? [signal] : []),
        AbortSignal.timeout(requestTimeoutMs),
      ]),
      timeout: requestTimeoutMs,
    };
  }

  async function disconnectConnection(connection: Connection): Promise<void> {
    connection.cancellation.abort();
    connection.info.generation += 1;
    connection.info.state = connection.config.error ? "error" : "disconnected";
    connection.info.error = connection.config.error;
    connection.info.protocolVersion = null;
    const client = connection.client;
    const transport = connection.transport;
    connection.client = null;
    connection.transport = null;
    connection.boundTools.clear();
    connection.resources = [];
    connection.prompts = [];
    connection.diagnostics = [];
    // 先使执行快照失效，再等待 SDK 收口；旧审批不能跨连接继续使用。
    await Promise.allSettled([client?.close(), transport?.close()]);
    await connection.pendingConnection;
    connection.secrets = [];
  }

  async function connectConnection(
    connection: Connection,
    signal?: AbortSignal,
  ): Promise<McpActionResult<McpServerInfo>> {
    if (connection.config.error) return failure(connection.config.error);
    connection.info.state = "connecting";
    connection.info.error = null;
    const generation = ++connection.info.generation;
    connection.cancellation = new AbortController();
    try {
      const transport = createTransport(connection, options.workspaceRoot, environment);
      connection.transport = transport;
      const client = new Client(
        { name: "anthias", version: "0.0.0" },
        {
          capabilities: {},
          versionNegotiation: {
            mode: "auto",
            probe: { timeoutMs: Math.min(requestTimeoutMs, 1500), maxRetries: 0 },
          },
          inputRequired: { autoFulfill: false },
          listMaxPages: 8,
        },
      );
      connection.client = client;
      client.onerror = () => {
        if (connection.client === client)
          connection.info.error = "MCP 连接报告协议或传输错误；原始服务错误已隐藏。";
      };
      client.onclose = () => {
        if (connection.client !== client) return;
        connection.cancellation.abort();
        connection.info.generation += 1;
        connection.info.state = "error";
        connection.info.error = "MCP 连接已关闭；未完成的调用结果可能未知，请检查服务后再连接。";
        connection.boundTools.clear();
      };
      const invalidateCapabilities = () => {
        if (connection.client !== client) return;
        connection.cancellation.abort();
        connection.info.generation += 1;
        connection.info.state = "error";
        connection.info.error = "MCP 能力目录已变化，旧工具已失效；请重新连接以重新确认能力。";
        connection.boundTools.clear();
        connection.resources = [];
        connection.prompts = [];
      };
      for (const method of [
        "notifications/tools/list_changed",
        "notifications/resources/list_changed",
        "notifications/prompts/list_changed",
      ] as const)
        client.setNotificationHandler(method, invalidateCapabilities);
      await client.connect(transport, {
        ...requestOptions(connection, signal),
        timeout: Math.min(requestTimeoutMs, 15_000),
      });
      await discoverCapabilities(connection, requestOptions(connection, signal));
      if (
        generation !== connection.info.generation ||
        closed ||
        connection.cancellation.signal.aborted
      )
        throw new Error("cancelled");
      connection.info.state = "connected";
      connection.info.protocolVersion = client.getNegotiatedProtocolVersion() ?? null;
      return success(structuredClone(connection.info));
    } catch {
      const client = connection.client;
      const transport = connection.transport;
      connection.client = null;
      connection.transport = null;
      connection.boundTools.clear();
      await Promise.allSettled([client?.close(), transport?.close()]);
      const error =
        signal?.aborted ||
        connection.cancellation.signal.aborted ||
        generation !== connection.info.generation
          ? "MCP 连接已取消。"
          : "MCP 连接或能力发现失败；请检查配置、服务状态及环境变量引用。";
      if (generation === connection.info.generation) {
        connection.info.state = "error";
        connection.info.error = error;
      }
      return failure(error);
    }
  }

  function prepareToolCall(
    name: string,
    argumentsValue: unknown,
    generation: number,
  ): McpActionResult<{
    connection: Connection & { client: Client };
    boundTool: BoundTool;
    argumentsValue: Record<string, unknown>;
  }> {
    const connection = connections.find((candidate) => candidate.boundTools.has(name));
    const boundTool = connection?.boundTools.get(name);
    if (
      closed ||
      !connection?.client ||
      connection.info.state !== "connected" ||
      !boundTool ||
      generation !== connection.info.generation ||
      generation !== boundTool.info.generation
    )
      return failure("MCP 工具或连接版本已失效，请重新发现并确认后调用。");
    try {
      if (
        !isRecord(argumentsValue) ||
        Buffer.byteLength(JSON.stringify(argumentsValue), "utf8") > MAX_LIST_BYTES ||
        !boundTool.validateInput(argumentsValue).valid
      )
        return failure("MCP 工具参数不符合已绑定的 JSON Schema。");
    } catch {
      return failure("MCP 工具参数无法按已绑定的 JSON Schema 校验。");
    }

    return success({
      connection: { ...connection, client: connection.client },
      boundTool,
      argumentsValue,
    });
  }

  return {
    list: () => connections.map((connection) => structuredClone(connection.info)),
    tools: () =>
      connections
        .filter((connection) => connection.info.state === "connected")
        .flatMap((connection) =>
          [...connection.boundTools.values()].map((tool) => structuredClone(tool.info)),
        ),
    async connect(id, signal) {
      if (closed) return failure("MCP 已关闭。");
      if (signal?.aborted) return failure("MCP 连接已取消。");
      const selected = findConnection(id);
      if (!selected.ok) return selected;
      const connection = selected.value;
      if (connection.pendingConnection) return failure("MCP 正在连接。");
      if (connection.info.state === "connected") return success(structuredClone(connection.info));
      if (connection.client) await disconnectConnection(connection);
      const pendingConnection = connectConnection(connection, signal);
      connection.pendingConnection = pendingConnection;
      try {
        return await pendingConnection;
      } finally {
        connection.pendingConnection = null;
      }
    },
    async disconnect(id) {
      const selected = findConnection(id);
      if (!selected.ok) return selected;
      await disconnectConnection(selected.value);
      return success(structuredClone(selected.value.info));
    },
    async inspect(id, signal) {
      if (signal?.aborted) return failure("MCP 查看已取消。");
      const selected = findConnection(id);
      if (!selected.ok) return selected;
      const connection = selected.value;
      return success(
        structuredClone({
          ...connection.info,
          tools: [...connection.boundTools.values()].map((tool) => tool.info),
          resources: connection.resources,
          prompts: connection.prompts,
          diagnostics: connection.diagnostics,
        }),
      );
    },
    validateToolCall(name, argumentsValue, generation) {
      const prepared = prepareToolCall(name, argumentsValue, generation);
      return prepared.ok ? success(undefined) : prepared;
    },
    async callTool(name, argumentsValue, generation, signal) {
      const prepared = prepareToolCall(name, argumentsValue, generation);
      if (!prepared.ok) return prepared;
      const { connection, boundTool } = prepared.value;
      try {
        const result = await connection.client.request(
          {
            method: "tools/call",
            params: { name: boundTool.info.originalName, arguments: prepared.value.argumentsValue },
          },
          requestOptions(connection, signal),
        );
        if (
          boundTool.validateOutput &&
          !result.isError &&
          !boundTool.validateOutput(result.structuredContent).valid
        )
          return failure("MCP 工具返回值不符合输出 Schema；调用可能已生效，请勿自动重试。");
        return success(
          contentFromBlocks(
            result.content,
            connection.secrets,
            result.isError === true,
            result.structuredContent,
          ),
        );
      } catch {
        return failure(
          signal?.aborted || connection.cancellation.signal.aborted
            ? "MCP 工具调用已取消；服务端执行结果可能未知，请勿自动重试。"
            : "MCP 工具调用失败或超时；服务端执行结果可能未知，请勿自动重试。",
        );
      }
    },
    async readResource(serverId, uri, signal) {
      const selected = selectConnected(serverId);
      if (!selected.ok) return selected;
      const connection = selected.value;
      if (!connection.resources.some((resource) => resource.uri === uri))
        return failure("资源不在当前 MCP 目录中；请使用已列出的 URI。");
      try {
        const result = await connection.client.readResource(
          { uri },
          requestOptions(connection, signal),
        );
        return success(
          contentFromBlocks(
            result.contents.map((content) => ({ type: "resource", resource: content })),
            connection.secrets,
          ),
        );
      } catch {
        return failure("MCP 资源读取失败、超时或已取消。");
      }
    },
    async getPrompt(serverId, name, argumentsValue = {}, signal) {
      const selected = selectConnected(serverId);
      if (!selected.ok) return selected;
      const connection = selected.value;
      const prompt = connection.prompts.find((candidate) => candidate.name === name);
      if (!prompt) return failure("模板不在当前 MCP 目录中。");
      if (
        !isRecord(argumentsValue) ||
        Object.values(argumentsValue).some((value) => typeof value !== "string") ||
        Buffer.byteLength(JSON.stringify(argumentsValue), "utf8") > PREVIEW_BYTES ||
        prompt.arguments.some(
          (argument) => argument.required && !(argument.name in argumentsValue),
        ) ||
        Object.keys(argumentsValue).some(
          (argument) => !prompt.arguments.some((candidate) => candidate.name === argument),
        )
      )
        return failure("MCP 模板参数缺失或无效。");
      try {
        const result = await connection.client.getPrompt(
          { name, arguments: argumentsValue },
          requestOptions(connection, signal),
        );
        const blocks = result.messages.flatMap((message) => [
          { type: "text", text: `[MCP 模板中的 ${message.role} 内容]` },
          message.content,
        ]);
        return success(contentFromBlocks(blocks, connection.secrets));
      } catch {
        return failure("MCP 模板读取失败、超时或已取消。");
      }
    },
    async close() {
      closed = true;
      await Promise.all(connections.map(disconnectConnection));
    },
  };
}

function createTransport(
  connection: Connection,
  workspaceRoot: string,
  environment: NodeJS.ProcessEnv,
): Transport {
  function resolveReferences(references: Record<string, string>): Record<string, string> {
    const values: Record<string, string> = {};
    for (const [name, variableName] of Object.entries(references)) {
      const value = environment[variableName];
      if (!value || value.includes("\0")) throw new Error("missing referenced environment");
      values[name] = value;
      connection.secrets.push(value);
    }
    return values;
  }
  if (connection.config.transport === "stdio") {
    const inheritedEnvironment: Record<string, string> = {};
    for (const name of DEFAULT_INHERITED_ENV_VARS) {
      const value = environment[name];
      if (value !== undefined && !value.startsWith("()")) inheritedEnvironment[name] = value;
    }
    return new StdioClientTransport({
      command: connection.config.command,
      args: connection.config.args,
      env: {
        ...inheritedEnvironment,
        ...resolveReferences(connection.config.environmentReferences),
      },
      cwd: workspaceRoot,
      stderr: "ignore",
      maxBufferSize: MAX_WIRE_BYTES,
    });
  }
  return new StreamableHTTPClientTransport(new URL(connection.config.url), {
    requestInit: {
      headers: resolveReferences(connection.config.headerReferences),
      redirect: "error",
    },
    fetch: limitedFetch,
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
    onInsufficientScope: "throw",
    maxStepUpRetries: 0,
  });
}

const limitedFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, { ...init, redirect: "error" });
  if (!response.body) return response;
  let responseBytes = 0;
  const limitedBody = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        responseBytes += chunk.byteLength;
        if (responseBytes > MAX_WIRE_BYTES)
          controller.error(new Error("MCP response exceeds byte limit"));
        else controller.enqueue(chunk);
      },
    }),
  );
  return new Response(limitedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

async function discoverCapabilities(
  connection: Connection,
  requestOptions: { signal: AbortSignal; timeout: number },
): Promise<void> {
  const client = connection.client;
  if (!client) throw new Error("not connected");
  const capabilities = client.getServerCapabilities();
  const [tools, resources, prompts] = await Promise.all([
    capabilities?.tools
      ? collectPages(async (cursor) => {
          const page = await client.request(
            { method: "tools/list", params: cursor ? { cursor } : {} },
            requestOptions,
          );
          return {
            values: page.tools,
            ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
          };
        })
      : [],
    capabilities?.resources
      ? collectPages(async (cursor) => {
          const page = await client.request(
            { method: "resources/list", params: cursor ? { cursor } : {} },
            requestOptions,
          );
          return {
            values: page.resources,
            ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
          };
        })
      : [],
    capabilities?.prompts
      ? collectPages(async (cursor) => {
          const page = await client.request(
            { method: "prompts/list", params: cursor ? { cursor } : {} },
            requestOptions,
          );
          return {
            values: page.prompts,
            ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
          };
        })
      : [],
  ]);
  const validator = new AjvJsonSchemaValidator();
  const nameCounts = new Map<string, number>();
  for (const tool of tools) nameCounts.set(tool.name, (nameCounts.get(tool.name) ?? 0) + 1);
  for (const tool of tools) {
    try {
      if (
        nameCounts.get(tool.name) !== 1 ||
        !tool.name ||
        tool.name.length > 128 ||
        [...tool.name].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
        Buffer.byteLength(JSON.stringify(tool.inputSchema), "utf8") > MAX_SCHEMA_BYTES ||
        /"(?:x-mcp-header|\$async)"/.test(JSON.stringify([tool.inputSchema, tool.outputSchema]))
      )
        throw new Error("unsupported tool");
      if (
        connection.secrets.some((secret) =>
          JSON.stringify(tool).includes(JSON.stringify(secret).slice(1, -1)),
        )
      )
        throw new Error("sensitive descriptor");
      if (
        tool.outputSchema &&
        Buffer.byteLength(JSON.stringify(tool.outputSchema), "utf8") > MAX_SCHEMA_BYTES
      )
        throw new Error("output schema size");
      const name = `mcp_${createHash("sha256")
        .update(JSON.stringify([connection.info.id, tool.name]))
        .digest("hex")
        .slice(0, 24)}_${tool.name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32)}`;
      const info: McpToolInfo = {
        name,
        serverId: connection.info.id,
        originalName: tool.name,
        description: safeText(tool.description ?? "", connection.secrets, 2048),
        inputSchema: structuredClone(tool.inputSchema),
        generation: connection.info.generation,
      };
      connection.boundTools.set(name, {
        info,
        validateInput: validator.getValidator<Record<string, unknown>>(info.inputSchema),
        ...(tool.outputSchema
          ? { validateOutput: validator.getValidator(copySchema(tool.outputSchema)) }
          : {}),
      });
    } catch {
      connection.diagnostics.push(
        "一个 MCP 工具存在重复名称、超限或不支持的 Schema，已从可调用目录排除。",
      );
    }
  }
  connection.resources = resources
    .filter(
      (resource) =>
        validIdentity(resource.uri, connection.secrets, 4096) &&
        resources.filter((candidate) => candidate.uri === resource.uri).length === 1,
    )
    .map((resource) => ({
      uri: safeText(resource.uri, connection.secrets, 4096),
      name: safeText(resource.name, connection.secrets, 256),
      description: safeText(resource.description ?? "", connection.secrets, 2048),
    }));
  connection.prompts = prompts
    .filter(
      (prompt) =>
        validIdentity(prompt.name, connection.secrets, 128) &&
        (prompt.arguments?.length ?? 0) <= 32 &&
        (prompt.arguments ?? []).every((argument) =>
          validIdentity(argument.name, connection.secrets, 128),
        ) &&
        prompts.filter((candidate) => candidate.name === prompt.name).length === 1,
    )
    .map((prompt) => ({
      name: safeText(prompt.name, connection.secrets, 128),
      description: safeText(prompt.description ?? "", connection.secrets, 2048),
      arguments: (prompt.arguments ?? []).slice(0, 32).map((argument) => ({
        name: safeText(argument.name, connection.secrets, 128),
        description: safeText(argument.description ?? "", connection.secrets, 1024),
        required: argument.required === true,
      })),
    }));
}

async function collectPages<T>(
  fetchPage: (cursor?: string) => Promise<{ values: T[]; nextCursor?: string }>,
): Promise<T[]> {
  const values: T[] = [];
  const visitedCursors = new Set<string>();
  let cursor: string | undefined;
  let totalBytes = 0;
  for (let pageNumber = 0; pageNumber < 8; pageNumber += 1) {
    const page = await fetchPage(cursor);
    totalBytes += Buffer.byteLength(JSON.stringify(page.values), "utf8");
    if (values.length + page.values.length > MAX_LIST_ITEMS || totalBytes > MAX_LIST_BYTES)
      throw new Error("MCP catalog exceeds limit");
    values.push(...page.values);
    if (!page.nextCursor) return values;
    if (page.nextCursor.length > 4096 || visitedCursors.has(page.nextCursor))
      throw new Error("MCP repeated cursor");
    cursor = page.nextCursor;
    visitedCursors.add(cursor);
  }
  throw new Error("MCP catalog exceeds page limit");
}

function contentFromBlocks(
  blocks: readonly unknown[],
  secrets: readonly string[],
  isError = false,
  structuredContent?: unknown,
): McpContent {
  const fragments: string[] = [];
  let unsupportedContent = false;
  for (const block of blocks) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string")
      fragments.push(block.text);
    else if (
      isRecord(block) &&
      block.type === "resource" &&
      isRecord(block.resource) &&
      typeof block.resource.text === "string"
    )
      fragments.push(
        `${typeof block.resource.uri === "string" ? block.resource.uri : "MCP Resource"}\n${block.resource.text}`,
      );
    else if (isRecord(block) && block.type === "resource_link" && typeof block.uri === "string")
      fragments.push(`[MCP 资源引用，尚未读取] ${block.uri}`);
    else {
      unsupportedContent = true;
      fragments.push("[不支持的 MCP 二进制或多模态内容已省略]");
    }
  }
  if (structuredContent !== undefined) fragments.push(JSON.stringify(structuredContent));
  const completeText = safeText(fragments.join("\n\n"), secrets, MAX_WIRE_BYTES);
  const originalText = truncateUtf8(completeText, MAX_TEXT_BYTES);
  const originalTruncated = originalText !== completeText;
  const preview = truncateUtf8(originalText, PREVIEW_BYTES);
  const truncated = originalTruncated || preview !== originalText;
  const text =
    preview +
    (truncated
      ? `\n[MCP 内容已截断${originalTruncated ? "；最多保留 256 KiB 原文" : "；完整文本可保存为产物"}]`
      : "");
  return {
    text,
    isError,
    truncated,
    sourceTruncated: originalTruncated,
    unsupportedContent,
    ...(truncated ? { originalText } : {}),
  };
}

function safeText(text: string, secrets: readonly string[], limit: number): string {
  let safe = text;
  for (const secret of secrets) {
    if (secret) {
      safe = safe.split(secret).join("[REDACTED]");
      safe = safe.split(JSON.stringify(secret).slice(1, -1)).join("[REDACTED]");
    }
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: MCP 文本的控制字符不能传播到终端。
  safe = safe.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
  return truncateUtf8(safe, limit);
}

function truncateUtf8(text: string, bytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= bytes) return text;
  let end = bytes;
  while (end > 0 && (buffer[end] ?? 0) >= 0x80 && (buffer[end] ?? 0) < 0xc0) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

function success<T>(value: T): McpActionResult<T> {
  return { ok: true, value };
}
function failure(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function copySchema(schema: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(schema);
}

function validIdentity(value: string, secrets: readonly string[], limit: number): boolean {
  return (
    value.length > 0 &&
    safeText(value, secrets, limit) === value &&
    !value.includes("\n") &&
    !value.includes("\r")
  );
}
