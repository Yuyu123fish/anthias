import { mkdir, mkdtemp, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgentLoop } from "../src/agent-loop.js";
import { estimateTextTokens } from "../src/context/budget.js";
import type {
  AssistantToolCallPart,
  CompletedMessage,
  ToolArtifactReference,
} from "../src/message.js";
import type { ModelStream } from "../src/model/model-stream.js";
import { decideToolPolicy } from "../src/permission/tool-policy.js";
import {
  createSessionArtifactStore,
  SESSION_ARTIFACT_BYTE_LIMIT,
  type SessionArtifactStore,
} from "../src/tool/artifacts.js";
import { fileContentVersion } from "../src/tool/basetool/text-file.js";
import { finalizeToolResult } from "../src/tool/tool-result.js";
import { createToolRunner, type ToolRunner } from "../src/tool/tool-runner.js";

const temporaryDirectories = new Set<string>();
const artifactStores = new Set<SessionArtifactStore>();

afterEach(async () => {
  await Promise.all([...artifactStores].map((store) => store.close()));
  artifactStores.clear();
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

describe("Session Tool artifacts", () => {
  it("allows read_artifact for a read-only member without changing write permissions", () => {
    expect(
      decideToolPolicy({ permissionMode: "agent", writable: false, toolName: "read_artifact" })
        .kind,
    ).toBe("allow");
    expect(
      decideToolPolicy({ permissionMode: "agent", writable: false, toolName: "execute_command" })
        .kind,
    ).toBe("deny");
  });

  it("keeps incomplete-source evidence visible for short results without an artifact", async () => {
    const storageDirectory = await createTemporaryDirectory("anthias-incomplete-short-");
    const store = createStore(storageDirectory);
    const result = await finalizeToolResult(
      toolCallId(20),
      {
        status: "completed",
        content: "No matches.",
        truncated: true,
        sourceIncomplete: "source_failed",
      },
      store,
    );
    expect(result.content).toContain("未穷尽");
    expect(result.content).toContain("source_failed");
    expect(result.content).toContain("No matches.");
    expect(result.artifact).toBeUndefined();
    await expect(readdir(join(storageDirectory, "artifacts"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("requires a registered legacy reference and pages literal UTF-8 output with a forward cursor", async () => {
    const storageDirectory = await createTemporaryDirectory("anthias-artifact-read-");
    const store = createStore(storageDirectory);
    const sourceText = `${"🙂".repeat(40_000)}\nneedle [x]\nplain\n`;
    const artifactId = toolCallId(101);
    const artifactsDirectory = join(storageDirectory, "artifacts");
    await mkdir(artifactsDirectory, { recursive: true });
    await writeFile(join(artifactsDirectory, `${artifactId}.txt`), sourceText, "utf8");
    const reference: ToolArtifactReference = Object.freeze({
      artifactId,
      toolCallId: toolCallId(1),
      byteLength: Buffer.byteLength(sourceText, "utf8"),
      complete: true,
    });

    await expect(store.readArtifact({ artifactId: reference.artifactId })).resolves.toMatchObject({
      status: "failed",
    });
    store.registerReference(reference);

    const firstPage = await store.readArtifact({ artifactId: reference.artifactId, lineCount: 1 });
    expect(firstPage.status).toBe("completed");
    expect(firstPage.content).toContain("1| ");
    expect(firstPage.content).not.toContain("�");
    expect(Buffer.byteLength(firstPage.content, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(firstPage.nextCursor).not.toBeNull();

    let cursor = firstPage.nextCursor;
    let pageCount = 1;
    while (cursor !== null && pageCount < 10) {
      const page = await store.readArtifact({
        artifactId: reference.artifactId,
        cursor,
        lineCount: 1,
      });
      expect(page.status).toBe("completed");
      expect(page.content).not.toContain("�");
      expect(Buffer.byteLength(page.content, "utf8")).toBeLessThanOrEqual(64 * 1024);
      cursor = page.nextCursor;
      pageCount += 1;
    }
    expect(cursor).toBeNull();

    const literalSearch = await store.readArtifact({
      artifactId: reference.artifactId,
      search: "[x]",
      lineCount: 5,
    });
    expect(literalSearch.status).toBe("completed");
    expect(literalSearch.content).toContain("needle [x]");
  });

  it("keeps token-bounded page cursors aligned with the visible UTF-8 text", async () => {
    const store = createStore(await createTemporaryDirectory("anthias-artifact-token-page-"));
    const sourceText = "中🙂".repeat(450);
    const reference = await store.save(toolCallId(1), sourceText);
    if (reference === null) throw new Error("expected retained artifact");
    store.registerReference(reference);
    let cursor: string | undefined;
    let visibleText = "";
    for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
      const page = await store.readArtifact(
        { artifactId: reference.artifactId, ...(cursor === undefined ? {} : { cursor }) },
        250,
      );
      expect(page.status).toBe("completed");
      expect(estimateTextTokens(page.content)).toBeLessThanOrEqual(250);
      visibleText += page.content
        .split("\n")
        .filter((line) => /^\d+\| /u.test(line))
        .map((line) => line.replace(/^\d+\| /u, ""))
        .join("");
      if (page.nextCursor === null) break;
      expect(page.nextCursor).not.toBe(cursor);
      expect(page.content).toContain(`nextCursor: ${page.nextCursor}`);
      cursor = page.nextCursor;
    }
    expect(visibleText).toBe(sourceText);
  });
  it("counts existing files and concurrent pending writes against the Session quota", async () => {
    const storageDirectory = await createTemporaryDirectory("anthias-artifact-quota-");
    const artifactsDirectory = join(storageDirectory, "artifacts");
    await mkdir(artifactsDirectory, { recursive: true });
    const stalePartPath = join(artifactsDirectory, "stale.part");
    await writeFile(stalePartPath, "");
    await truncate(stalePartPath, SESSION_ARTIFACT_BYTE_LIMIT - 128);

    const store = createStore(storageDirectory);
    const [firstReference, secondReference] = await Promise.all([
      store.save(toolCallId(2), "a".repeat(96)),
      store.save(toolCallId(3), "b".repeat(96)),
    ]);
    const retainedReferences = [firstReference, secondReference].filter(
      (reference): reference is NonNullable<typeof reference> => reference !== null,
    );
    expect(
      retainedReferences.reduce((total, reference) => total + reference.byteLength, 0),
    ).toBeLessThanOrEqual(128);
    expect(retainedReferences.some((reference) => reference.complete === false)).toBe(true);
  });

  it("refreshes a later quota batch after an interleaved write from another store", async () => {
    const storageDirectory = await createTemporaryDirectory("anthias-artifact-cross-store-quota-");
    const artifactsDirectory = join(storageDirectory, "artifacts");
    await mkdir(artifactsDirectory, { recursive: true });
    const stalePartPath = join(artifactsDirectory, "stale.part");
    await writeFile(stalePartPath, "");
    await truncate(stalePartPath, SESSION_ARTIFACT_BYTE_LIMIT - 2);

    const firstStore = createStore(storageDirectory);
    const secondStore = createStore(storageDirectory);

    const firstBatchReference = await firstStore.save(toolCallId(8), "a");
    if (firstBatchReference === null) {
      throw new Error("expected first retained artifact");
    }
    expect(firstBatchReference).toMatchObject({ byteLength: 1, complete: true });

    const interleavedReference = await secondStore.save(toolCallId(9), "b");
    if (interleavedReference === null) {
      throw new Error("expected interleaved retained artifact");
    }
    expect(interleavedReference).toMatchObject({ byteLength: 1, complete: true });

    const laterBatchReference = await firstStore.save(toolCallId(10), "c");
    expect(laterBatchReference).toMatchObject({
      byteLength: 0,
      complete: false,
      incompleteReason: "session_limit",
    });
  });
  it("returns null when saving cannot create the artifact directory", async () => {
    const storageDirectory = await createTemporaryDirectory("anthias-artifact-write-failure-");
    await writeFile(join(storageDirectory, "artifacts"), "directory is unavailable");
    const store = createStore(storageDirectory);

    await expect(store.save(toolCallId(4), "output")).resolves.toBeNull();
  });

  it("marks a failed artifact publish when final rename is unavailable", async () => {
    const storageDirectory = await createTemporaryDirectory("anthias-artifact-publish-failure-");
    const artifactsDirectory = join(storageDirectory, "artifacts");
    const store = createStore(storageDirectory);

    async function* sourceWithBlockedPublish(): AsyncGenerator<Uint8Array> {
      yield Buffer.from("output", "utf8");
      const temporaryFileName = (await readdir(artifactsDirectory)).find((name) =>
        name.endsWith(".part"),
      );
      if (temporaryFileName === undefined) {
        throw new Error("expected an artifact temporary file");
      }
      await mkdir(join(artifactsDirectory, temporaryFileName.replace(/\.part$/u, ".txt")));
    }

    await expect(store.save(toolCallId(11), sourceWithBlockedPublish())).resolves.toBeNull();
    expect((await readdir(artifactsDirectory)).some((name) => name.endsWith(".part"))).toBe(false);
  });
  it("rejects a linked artifact path and keeps another Session unprivileged", async () => {
    const firstStorageDirectory = await createTemporaryDirectory("anthias-artifact-links-a-");
    const secondStorageDirectory = await createTemporaryDirectory("anthias-artifact-links-b-");
    const firstStore = createStore(firstStorageDirectory);
    const secondStore = createStore(secondStorageDirectory);
    const reference = await firstStore.save(toolCallId(5), "secret\n");
    if (reference === null) {
      throw new Error("expected retained artifact");
    }
    firstStore.registerReference(reference);

    await expect(
      secondStore.readArtifact({ artifactId: reference.artifactId }),
    ).resolves.toMatchObject({
      status: "failed",
    });

    if (process.platform === "win32") {
      return;
    }
    const artifactPath = join(firstStorageDirectory, "artifacts", `${reference.artifactId}.txt`);
    const externalPath = join(firstStorageDirectory, "outside.txt");
    await writeFile(externalPath, "outside\n", "utf8");
    await rm(artifactPath, { force: true });
    await symlink(externalPath, artifactPath, "file");
    await expect(
      firstStore.readArtifact({ artifactId: reference.artifactId }),
    ).resolves.toMatchObject({
      status: "failed",
    });
  });

  it("keeps a short 8192-byte UTF-8 result in Session without creating an artifact", async () => {
    const workspaceRoot = await createTemporaryDirectory("anthias-artifact-utf8-budget-workspace-");
    const storageDirectory = await createTemporaryDirectory(
      "anthias-artifact-utf8-budget-storage-",
    );
    const sourceText = "é".repeat(3400) + "x".repeat(1392);
    expect(Buffer.byteLength(sourceText, "utf8")).toBe(8192);
    await writeFile(join(workspaceRoot, "utf8.txt"), sourceText, "utf8");
    const store = createStore(storageDirectory);
    const toolRunner = createToolRunner({
      workspace: {
        workspaceRoot,
        sessionDirectory: join(storageDirectory, "session"),
      },
      shell: { kind: "posix", executable: "sh", arguments: [] },
    });
    const toolCall: AssistantToolCallPart = Object.freeze({
      type: "tool_call",
      toolCallId: toolCallId(12),
      toolName: "read_file",
      input: { path: "utf8.txt" },
      invalid: false,
    });

    const preparation = await toolRunner.createPlan(toolCall, "agent").prepare();
    if (!preparation.ok) {
      throw new Error("expected read_file preparation to succeed");
    }
    const executionResult = await preparation.preparedExecution.execute(
      new AbortController().signal,
      () => undefined,
    );
    const result = await finalizeToolResult(toolCall.toolCallId, executionResult, store);

    expect(result.artifact).toBeUndefined();
    expect(result.truncated).toBe(false);
    expect(result.content).toContain(sourceText);
    expect(await readdir(storageDirectory)).toEqual([]);
  });

  it("saves oversized ordinary Tool text through the result finalizer and reads the original", async () => {
    const store = createStore(await createTemporaryDirectory("anthias-artifact-finalize-large-"));
    const originalText = `start\n${"x".repeat(20_000)}\nneedle [large]\n`;
    const result = await finalizeToolResult(
      toolCallId(13),
      Object.freeze({
        status: "completed",
        content: originalText,
        truncated: false,
      }),
      store,
    );
    const reference = result.artifact;
    if (reference === undefined) {
      throw new Error("expected an oversized Tool result artifact");
    }

    expect(reference).toMatchObject({
      toolCallId: toolCallId(13),
      byteLength: Buffer.byteLength(originalText, "utf8"),
      complete: true,
    });
    expect(result.truncated).toBe(true);
    expect(estimateTextTokens(result.content)).toBeLessThanOrEqual(4_000);

    store.registerReference(reference);
    const originalSearch = await store.readArtifact({
      artifactId: reference.artifactId,
      search: "[large]",
    });
    expect(originalSearch.status).toBe("completed");
    expect(originalSearch.content).toContain("needle [large]");
  });

  it("saves only the requested file page and keeps visible lines aligned with nextStartLine", async () => {
    const workspaceRoot = await createTemporaryDirectory("anthias-artifact-file-page-workspace-");
    const storageDirectory = await createTemporaryDirectory("anthias-artifact-file-page-storage-");
    const requestedLines = [2, 3, 4, 5].map(
      (lineNumber) => `requested-${lineNumber}-${String(lineNumber).repeat(1200)}`,
    );
    const fileLines = [
      `outside-before-${"a".repeat(2000)}`,
      ...requestedLines,
      `outside-after-${"z".repeat(2000)}`,
    ];
    const sourceText = fileLines.join("\n");
    await writeFile(join(workspaceRoot, "page.txt"), sourceText, "utf8");
    const store = createStore(storageDirectory);
    const toolRunner = createToolRunner({
      workspace: { workspaceRoot, sessionDirectory: join(storageDirectory, "session") },
      shell: { kind: "posix", executable: "sh", arguments: [] },
    });
    const toolCall: AssistantToolCallPart = Object.freeze({
      type: "tool_call",
      toolCallId: toolCallId(14),
      toolName: "read_file",
      input: { path: "page.txt", startLine: 2, lineCount: 4 },
      invalid: false,
    });
    const preparation = await toolRunner.createPlan(toolCall, "agent").prepare();
    if (!preparation.ok) {
      throw new Error("expected ranged read_file preparation to succeed");
    }
    const executionResult = await preparation.preparedExecution.execute(
      new AbortController().signal,
      () => undefined,
    );
    const expectedPageText = [
      "path: page.txt",
      "version: " + fileContentVersion(Buffer.from(sourceText)),
      "lines: 2-5 of 6",
      "nextStartLine: 6",
      "---",
      ...requestedLines.map((line, index) => `${index + 2}| ${line}`),
    ].join("\n");
    expect(executionResult.content).toBe(expectedPageText);

    const result = await finalizeToolResult(toolCall.toolCallId, executionResult, store, 800);
    const reference = result.artifact;
    if (reference === undefined) {
      throw new Error("expected a ranged read_file artifact");
    }
    expect(reference.byteLength).toBe(Buffer.byteLength(expectedPageText, "utf8"));
    expect(reference.byteLength).toBeLessThan(Buffer.byteLength(sourceText, "utf8"));

    const visibleRange = /^lines: 2-(\d+) of 6$/mu.exec(result.content);
    if (visibleRange === null) {
      throw new Error("expected visible file line range");
    }
    const visibleEndLine = Number(visibleRange[1]);
    expect(visibleEndLine).toBeGreaterThanOrEqual(2);
    expect(visibleEndLine).toBeLessThan(5);
    expect(result.content).toContain(`nextStartLine: ${visibleEndLine + 1}`);
    for (let lineNumber = 2; lineNumber <= visibleEndLine; lineNumber += 1) {
      expect(result.content).toContain(`${lineNumber}| requested-${lineNumber}-`);
    }
    expect(result.content).not.toContain(`${visibleEndLine + 1}| requested-${visibleEndLine + 1}-`);

    store.registerReference(reference);
    const savedPage = await store.readArtifact({ artifactId: reference.artifactId });
    expect(savedPage.status).toBe("completed");
    expect(savedPage.content).toContain("requested-2-");
    expect(savedPage.content).toContain("requested-5-");
    expect(savedPage.content).not.toContain("outside-before-");
    expect(savedPage.content).not.toContain("outside-after-");
  });

  it("keeps an oversized single file line continuable through its artifact", async () => {
    const workspaceRoot = await createTemporaryDirectory("anthias-artifact-long-line-workspace-");
    const storageDirectory = await createTemporaryDirectory("anthias-artifact-long-line-storage-");
    const longLine = "中🙂".repeat(15_000);
    await writeFile(join(workspaceRoot, "long-line.txt"), `${longLine}\ntail-only`, "utf8");
    const store = createStore(storageDirectory);
    const toolRunner = createToolRunner({
      workspace: { workspaceRoot, sessionDirectory: join(storageDirectory, "session") },
      shell: { kind: "posix", executable: "sh", arguments: [] },
    });
    const toolCall: AssistantToolCallPart = Object.freeze({
      type: "tool_call",
      toolCallId: toolCallId(15),
      toolName: "read_file",
      input: { path: "long-line.txt", startLine: 1, lineCount: 1 },
      invalid: false,
    });
    const preparation = await toolRunner.createPlan(toolCall, "agent").prepare();
    if (!preparation.ok) {
      throw new Error("expected long-line read_file preparation to succeed");
    }
    const executionResult = await preparation.preparedExecution.execute(
      new AbortController().signal,
      () => undefined,
    );
    const result = await finalizeToolResult(toolCall.toolCallId, executionResult, store);
    const reference = result.artifact;
    if (reference === undefined) {
      throw new Error("expected a long-line read_file artifact");
    }
    expect(result.content).toContain("lines: none of 2");
    expect(result.content).toContain("nextStartLine: 1");
    expect(result.content).toContain("首行超限时使用产物读取剩余内容");
    expect(reference.byteLength).toBe(Buffer.byteLength(executionResult.content, "utf8"));

    store.registerReference(reference);
    let cursor: string | undefined;
    let reachedEnd = false;
    let reconstructedLine = "";
    for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
      const page = await store.readArtifact({
        artifactId: reference.artifactId,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(page.status).toBe("completed");
      expect(page.content).not.toContain("�");
      const storedLineSegment = page.content.split("\n").find((line) => line.startsWith("6| "));
      if (storedLineSegment !== undefined) {
        let segment = storedLineSegment.slice("6| ".length);
        if (reconstructedLine.length === 0) {
          expect(segment.startsWith("1| ")).toBe(true);
          segment = segment.slice("1| ".length);
        }
        reconstructedLine += segment;
      }
      if (page.nextCursor === null) {
        reachedEnd = true;
        break;
      }
      cursor = page.nextCursor;
    }
    expect(reachedEnd).toBe(true);
    expect(reconstructedLine).toBe(longLine);
  });

  it("bounds each ToolResult to 4,000 tokens and a source-ordered 8,000-token batch", async () => {
    const toolRunner: ToolRunner = Object.freeze({
      createPlan() {
        return Object.freeze({
          scheduling: "parallel" as const,
          abortedPreparationContent: "aborted",
          prepare: () =>
            Promise.resolve(
              Object.freeze({
                ok: true as const,
                preparedExecution: Object.freeze({
                  approval: null,
                  activitySummary: "large output",
                  executionUnavailableContent: "aborted",
                  async execute() {
                    return Object.freeze({
                      status: "completed" as const,
                      content: "x".repeat(20_000),
                      truncated: false,
                      cleanupUncertain: false,
                    });
                  },
                }),
              }),
            ),
        });
      },
    });
    let modelRequestCount = 0;
    const modelStream: ModelStream = async function* () {
      modelRequestCount += 1;
      if (modelRequestCount === 1) {
        yield toolCallEvent(6);
        yield toolCallEvent(7);
        yield Object.freeze({ type: "finish" as const, finishReason: "tool_calls" as const });
        return;
      }
      yield Object.freeze({ type: "text_delta" as const, delta: "done" });
      yield Object.freeze({ type: "finish" as const, finishReason: "stop" as const });
    };
    const messages: CompletedMessage[] = [];
    await expect(
      runAgentLoop({
        readMessages: () => messages,
        async recordMessage(message) {
          messages.push(message);
          return toolCallId(1000 + messages.length);
        },
        consumeSteer: async () => false,
        modelStream,
        systemPrompt: "",
        toolDefinitions: [],
        permissionMode: "agent",
        toolRunner,
        abortController: new AbortController(),
        emit: async () => {},
        updatePhase: () => undefined,
        requestToolApproval: async () => {
          throw new Error("approval is not expected");
        },
      }),
    ).resolves.toMatchObject({ status: "completed", diagnostic: { category: "completed" } });
    const results = messages.filter((message) => message.role === "tool");
    expect(results).toHaveLength(2);
    expect(results.every((result) => estimateTextTokens(result.content) <= 4_000)).toBe(true);
    expect(
      results.reduce((total, result) => total + estimateTextTokens(result.content), 0),
    ).toBeLessThanOrEqual(8_000);
    expect(results.every((result) => result.status === "completed")).toBe(true);
  });
});

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}

function createStore(storageDirectory: string): SessionArtifactStore {
  const store = createSessionArtifactStore({
    sessionId: toolCallId(100),
    storageDirectory,
  });
  artifactStores.add(store);
  return store;
}

function toolCallEvent(index: number): AssistantToolCallPart {
  return Object.freeze({
    type: "tool_call" as const,
    toolCallId: toolCallId(index),
    toolName: "read_file",
    input: { path: "large.txt" },
    invalid: false,
  });
}

function toolCallId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}
