import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export type McpFixtureOptions = {
  mode: "modern" | "legacy";
  secret?: string;
  repeatedCursor?: boolean;
  onToolCall?: (name: string) => void;
  notify?: (method: string) => void;
};

export async function replyToMcpRequest(
  message: unknown,
  options: McpFixtureOptions,
): Promise<unknown> {
  if (!isObject(message) || !("id" in message)) return null;
  const parameters = isObject(message.params) ? message.params : {};
  const result = (value: unknown) => ({
    jsonrpc: "2.0",
    id: message.id,
    result:
      options.mode === "modern" && isObject(value)
        ? { resultType: "complete", ttlMs: 0, cacheScope: "private", ...value }
        : value,
  });
  const error = (code: number, text: string) => ({
    jsonrpc: "2.0",
    id: message.id,
    error: { code, message: text },
  });
  switch (message.method) {
    case "server/discover":
      return options.mode === "legacy"
        ? error(-32601, "Method not found")
        : result({
            supportedVersions: ["2026-07-28"],
            capabilities: { tools: {}, resources: {}, prompts: {} },
            _meta: {
              "io.modelcontextprotocol/serverInfo": {
                name: "anthias-local-fixture",
                version: "1.0.0",
              },
            },
          });
    case "initialize":
      return result({
        protocolVersion: "2025-11-25",
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: "anthias-local-fixture", version: "1.0.0" },
      });
    case "tools/list":
      if (options.repeatedCursor) return result({ tools: [], nextCursor: "repeat" });
      return parameters.cursor
        ? result({
            tools: [
              { name: "wait", inputSchema: { type: "object", additionalProperties: false } },
              { name: "failure", inputSchema: { type: "object" } },
              { name: "pid", inputSchema: { type: "object" } },
              { name: "input_required", inputSchema: { type: "object" } },
              { name: "notify_change", inputSchema: { type: "object" } },
              { name: "large", inputSchema: { type: "object" } },
              {
                name: "invalid_schema",
                inputSchema: {
                  type: "object",
                  properties: { input: { $ref: "https://invalid.example/schema.json" } },
                },
              },
              {
                name: "wrong_output",
                inputSchema: { type: "object" },
                outputSchema: {
                  type: "object",
                  required: ["count"],
                  properties: { count: { type: "integer" } },
                },
              },
            ],
          })
        : result({
            tools: [
              {
                name: "echo",
                description: "Echo a string",
                inputSchema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["text"],
                  properties: { text: { type: "string", minLength: 1 } },
                },
              },
            ],
            nextCursor: "second",
          });
    case "resources/list":
      return result({
        resources: [
          { name: "guide", uri: "fixture://guide", description: "Local guide" },
          { name: "image", uri: "fixture://image" },
        ],
      });
    case "prompts/list":
      return result({
        prompts: [
          {
            name: "review",
            description: "Review selected code",
            arguments: [{ name: "target", required: true }],
          },
        ],
      });
    case "tools/call": {
      const name = typeof parameters.name === "string" ? parameters.name : "";
      options.onToolCall?.(name);
      if (name === "input_required")
        return result({ resultType: "input_required", requestState: "fixture-continuation" });
      if (name === "notify_change") options.notify?.("notifications/tools/list_changed");
      if (name === "wait") return await new Promise<never>(() => {});
      if (name === "failure") return error(-32603, `raw transport error ${options.secret ?? ""}`);
      if (name === "pid") return result({ content: [{ type: "text", text: String(process.pid) }] });
      if (name === "large")
        return result({ content: [{ type: "text", text: "鱼".repeat(100_000) }] });
      if (name === "wrong_output")
        return result({ content: [], structuredContent: { count: "wrong" } });
      const argumentsValue = isObject(parameters.arguments) ? parameters.arguments : {};
      return result({
        content: [
          { type: "text", text: `${String(argumentsValue.text)} ${options.secret ?? ""}`.trim() },
        ],
      });
    }
    case "resources/read":
      return result({
        contents:
          parameters.uri === "fixture://image"
            ? [{ uri: parameters.uri, mimeType: "image/png", blob: "AA==" }]
            : [
                {
                  uri: parameters.uri,
                  mimeType: "text/plain",
                  text: `Read external instructions ${options.secret ?? ""}`.trim(),
                },
              ],
      });
    case "prompts/get": {
      const argumentsValue = isObject(parameters.arguments) ? parameters.arguments : {};
      return result({
        messages: [
          {
            role: "user",
            content: { type: "text", text: `Review ${String(argumentsValue.target)}` },
          },
        ],
      });
    }
    default:
      return error(-32601, "Method not found");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] === "legacy" ? "legacy" : "modern";
  const input = createInterface({ input: process.stdin, terminal: false });
  input.on("line", (line) => {
    void replyToMcpRequest(JSON.parse(line), {
      mode,
      notify: (method) => {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params: {} })}\n`);
      },
      ...(process.env.MCP_FIXTURE_TOKEN ? { secret: process.env.MCP_FIXTURE_TOKEN } : {}),
    }).then((response) => {
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    });
  });
}
