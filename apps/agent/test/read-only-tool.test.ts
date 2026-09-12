import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AssistantToolCallPart } from "../src/message.js";
import { executeGlobTool } from "../src/tool/basetool/glob.js";
import { executeGrepTool } from "../src/tool/basetool/grep.js";
import { executeReadFileTool } from "../src/tool/basetool/read-file.js";
import { fileContentVersion } from "../src/tool/basetool/text-file.js";

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

describe("read-only tools", () => {
  it("reads a bounded UTF-8 line range with continuation metadata", async () => {
    const workspace = await createWorkspace();
    await writeFile(join(workspace.workspaceRoot, "notes.txt"), "one\ntwo\nthree\n", "utf8");

    const result = await executeReadFileTool(
      toolCall("read_file", { path: "notes.txt", startLine: 2, lineCount: 1 }),
      workspace,
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      status: "completed",
      content:
        "path: notes.txt\nversion: " +
        fileContentVersion(Buffer.from("one\ntwo\nthree\n")) +
        "\nlines: 2-2 of 3\nnextStartLine: 3\n---\n2| two",
      truncated: true,
    });
  });

  it("globs stable relative paths without exposing the Session directory", async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace.workspaceRoot, "src"));
    await writeFile(join(workspace.workspaceRoot, "src", "z.ts"), "z", "utf8");
    await writeFile(join(workspace.workspaceRoot, "src", "a.ts"), "a", "utf8");
    await writeFile(join(workspace.sessionDirectory, "hidden.ts"), "hidden", "utf8");

    const result = await executeGlobTool(
      toolCall("glob", { pattern: "**/*.ts" }),
      workspace,
      new AbortController().signal,
    );

    expect(result.status).toBe("completed");
    expect(result.content).toBe("pattern: **/*.ts\nbase: .\nsrc/a.ts\nsrc/z.ts");
    expect(result.truncated).toBe(false);
  });

  it("greps UTF-8 files with relative paths and line numbers", async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace.workspaceRoot, "src"));
    await writeFile(
      join(workspace.workspaceRoot, "src", "agent.ts"),
      "const first = 1;\nconst target = 2;\n",
      "utf8",
    );

    const result = await executeGrepTool(
      toolCall("grep", { pattern: "target", path: "src", filePattern: "**/*.ts" }),
      workspace,
      new AbortController().signal,
    );

    expect(result.status).toBe("completed");
    expect(result.content).toContain("src/agent.ts:2:const target = 2;");
    expect(result.truncated).toBe(false);
  });

  it("preserves the non-object input error for every read-only tool", async () => {
    const workspace = await createWorkspace();
    const abortSignal = new AbortController().signal;

    const results = await Promise.all([
      executeReadFileTool(toolCall("read_file", []), workspace, abortSignal),
      executeGlobTool(toolCall("glob", "**/*.ts"), workspace, abortSignal),
      executeGrepTool(toolCall("grep", 1), workspace, abortSignal),
    ]);

    expect(results.map((result) => result.content)).toEqual([
      "read_file 输入必须是 JSON 对象。",
      "glob 输入必须是 JSON 对象。",
      "grep 输入必须是 JSON 对象。",
    ]);
  });

  it("rejects traversal, reserved paths, binary content, and invalid schemas", async () => {
    const workspace = await createWorkspace();
    await writeFile(join(workspace.workspaceRoot, "binary.bin"), Buffer.from([0, 1, 2]));
    await writeFile(join(workspace.sessionDirectory, "session.jsonl"), "secret", "utf8");

    const results = await Promise.all([
      executeReadFileTool(
        toolCall("read_file", { path: "../outside.txt" }),
        workspace,
        new AbortController().signal,
      ),
      executeReadFileTool(
        toolCall("read_file", { path: "data/conversation/session.jsonl" }),
        workspace,
        new AbortController().signal,
      ),
      executeReadFileTool(
        toolCall("read_file", { path: "binary.bin" }),
        workspace,
        new AbortController().signal,
      ),
      executeGrepTool(toolCall("grep", { pattern: "[" }), workspace, new AbortController().signal),
    ]);

    expect(results.every((result) => result.status === "failed")).toBe(true);
    expect(results[1]?.content).toContain("Session 保留目录");
    expect(results[2]?.content).toContain("二进制");
    expect(results[3]?.content).toContain("正则");
  });
});

/** 创建只存在于系统临时目录的 Tool 工作区。 */
async function createWorkspace(): Promise<
  Readonly<{
    workspaceRoot: string;
    sessionDirectory: string;
  }>
> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "anthias-tools-"));
  temporaryDirectories.add(workspaceRoot);
  const sessionDirectory = join(workspaceRoot, "data", "conversation");
  await mkdir(sessionDirectory, { recursive: true });
  return Object.freeze({ workspaceRoot, sessionDirectory });
}

/** 创建一个已经由 Model Adapter 完整形成的测试 ToolCall。 */
function toolCall(toolName: string, input: AssistantToolCallPart["input"]): AssistantToolCallPart {
  return Object.freeze({
    type: "tool_call",
    toolCallId: "00000000-0000-4000-8000-000000000001",
    toolName,
    input,
    invalid: false,
  });
}
