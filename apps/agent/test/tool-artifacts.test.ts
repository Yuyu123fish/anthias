import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentLoopEvent, runAgentLoop } from "../src/agent-loop.js";
import { estimateTextTokens } from "../src/context/budget.js";
import type { AssistantToolCallPart } from "../src/message.js";
import type { ModelStream } from "../src/model-stream.js";
import {
  createSessionArtifactStore,
  SESSION_ARTIFACT_BYTE_LIMIT,
  type SessionArtifactStore,
} from "../src/session/artifacts.js";
import { decideToolPolicy } from "../src/tool/tool-policy.js";
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
  it("allows read_artifact in Plan mode without changing write permissions", () => {
    expect(decideToolPolicy({ permissionMode: "plan", toolName: "read_artifact" }).kind).toBe(
      "allow",
    );
    expect(decideToolPolicy({ permissionMode: "plan", toolName: "execute_command" }).kind).toBe(
      "deny",
    );
  });

  it("requires a registered reference and pages literal UTF-8 output with a forward cursor", async () => {
    const storageDirectory = await createTemporaryDirectory("anthias-artifact-read-");
    const store = createStore(storageDirectory);
    const writer = store.createWriter(toolCallId(1));
    const sourceText = `🙂`.repeat(40_000) + "\nneedle [x]\nplain\n";
    await writeInChunks(writer, Buffer.from(sourceText, "utf8"));
    const reference = await writer.finish("completed", true);
    if (reference === null) {
      throw new Error("expected retained artifact");
    }

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
    const writer = store.createWriter(toolCallId(1));
    const sourceText = "中🙂".repeat(450);
    await writer.write(sourceText);
    const reference = await writer.finish("completed", true);
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
      expect(page.content).toContain("nextCursor: " + page.nextCursor);
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
    const firstWriter = store.createWriter(toolCallId(2));
    const secondWriter = store.createWriter(toolCallId(3));
    await Promise.all([firstWriter.write("a".repeat(96)), secondWriter.write("b".repeat(96))]);
    const [firstReference, secondReference] = await Promise.all([
      firstWriter.finish("completed", true),
      secondWriter.finish("completed", true),
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

    const firstBatchWriter = firstStore.createWriter(toolCallId(8));
    await firstBatchWriter.write("a");
    const firstBatchReference = await firstBatchWriter.finish("completed", true);
    if (firstBatchReference === null) {
      throw new Error("expected first retained artifact");
    }
    expect(firstBatchReference).toMatchObject({ byteLength: 1, complete: true });

    const interleavedWriter = secondStore.createWriter(toolCallId(9));
    await interleavedWriter.write("b");
    const interleavedReference = await interleavedWriter.finish("completed", true);
    if (interleavedReference === null) {
      throw new Error("expected interleaved retained artifact");
    }
    expect(interleavedReference).toMatchObject({ byteLength: 1, complete: true });

    const laterBatchWriter = firstStore.createWriter(toolCallId(10));
    await laterBatchWriter.write("c");
    const laterBatchReference = await laterBatchWriter.finish("completed", true);
    expect(laterBatchReference).toMatchObject({
      byteLength: 0,
      complete: false,
      incompleteReason: "session_limit",
    });
  });
  it("reports a write failure without preventing finish", async () => {
    const storageDirectory = await createTemporaryDirectory("anthias-artifact-write-failure-");
    await writeFile(join(storageDirectory, "artifacts"), "directory is unavailable");
    const store = createStore(storageDirectory);
    const writer = store.createWriter(toolCallId(4));

    await expect(writer.write("output")).resolves.toBeUndefined();
    expect(writer.hasIncomplete).toBe(true);
    await expect(writer.finish("completed", true)).resolves.toBeNull();
  });

  it("marks a failed artifact publish when final rename is unavailable", async () => {
    const storageDirectory = await createTemporaryDirectory("anthias-artifact-publish-failure-");
    const store = createStore(storageDirectory);
    const writer = store.createWriter(toolCallId(11));
    await writer.write("output");
    await mkdir(join(storageDirectory, "artifacts", `${writer.artifactId}.txt`));

    await expect(writer.finish("completed", true)).resolves.toBeNull();
    expect(writer.hasIncomplete).toBe(true);
  });
  it("rejects a linked artifact path and keeps another Session unprivileged", async () => {
    const firstStorageDirectory = await createTemporaryDirectory("anthias-artifact-links-a-");
    const secondStorageDirectory = await createTemporaryDirectory("anthias-artifact-links-b-");
    const firstStore = createStore(firstStorageDirectory);
    const secondStore = createStore(secondStorageDirectory);
    const writer = firstStore.createWriter(toolCallId(5));
    await writer.write("secret\n");
    const reference = await writer.finish("completed", true);
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

  it("retains an 8192-byte UTF-8 result that fits the 4000-token item limit", async () => {
    const workspaceRoot = await createTemporaryDirectory("anthias-artifact-utf8-budget-workspace-");
    const storageDirectory = await createTemporaryDirectory(
      "anthias-artifact-utf8-budget-storage-",
    );
    await writeFile(join(workspaceRoot, "utf8.txt"), "é".repeat(4096), "utf8");
    const store = createStore(storageDirectory);
    const toolRunner = createToolRunner({
      workspace: {
        workspaceRoot,
        sessionDirectory: join(storageDirectory, "session"),
      },
      shell: { kind: "posix", executable: "sh", arguments: [] },
      artifactStore: store,
    });
    const toolCall: AssistantToolCallPart = Object.freeze({
      type: "tool_call",
      toolCallId: toolCallId(12),
      toolName: "read_file",
      input: { path: "utf8.txt" },
      invalid: false,
    });

    const preparation = await toolRunner.createPlan(toolCall, "plan").prepare();
    if (!preparation.ok) {
      throw new Error("expected read_file preparation to succeed");
    }
    const result = await preparation.preparedExecution.execute(
      new AbortController().signal,
      () => undefined,
    );
    expect(result.artifact).toMatchObject({ byteLength: 8192, complete: true });
  });
  it("bounds each ToolResult to 4,000 tokens and a source-ordered 8,000-token batch", async () => {
    const toolRunner: ToolRunner = Object.freeze({
      createPlan() {
        return Object.freeze({
          scheduling: "parallel_read_only" as const,
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
    const events: AgentLoopEvent[] = [];
    await expect(
      runAgentLoop({
        messages: [],
        modelStream,
        systemPrompt: "",
        toolDefinitions: [],
        permissionMode: "plan",
        toolRunner,
        abortController: new AbortController(),
        emit: async (event) => {
          events.push(event);
        },
        updatePhase: () => undefined,
        requestToolApproval: async () => {
          throw new Error("approval is not expected");
        },
      }),
    ).resolves.toEqual({ status: "completed" });
    const results = events
      .filter(
        (event): event is Extract<AgentLoopEvent, { type: "tool_result" }> =>
          event.type === "tool_result",
      )
      .map((event) => event.message);
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

async function writeInChunks(
  writer: ReturnType<SessionArtifactStore["createWriter"]>,
  bytes: Buffer,
) {
  for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
    await writer.write(bytes.subarray(offset, offset + 64 * 1024));
  }
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
