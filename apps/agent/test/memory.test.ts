import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Agent, createAgentWithModelStream } from "../src/agent.js";
import { createMemory } from "../src/memory/index.js";
import type { MemoryEntry } from "../src/memory/schema.js";
import { memoryHash } from "../src/memory/schema.js";
import { createSession } from "../src/session/index.js";

const roots: string[] = [];
const agents: Agent[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup(existingRoot?: string) {
  const root = existingRoot ?? (await mkdtemp(join(tmpdir(), "anthias-memory-")));
  if (!existingRoot) roots.push(root);
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const session = await createSession({
    workspaceRoot,
    sessionDirectory: join(root, "sessions"),
    shell: { kind: "powershell", executable: "pwsh", arguments: ["-NoProfile", "-Command"] },
  });
  const agent = createAgentWithModelStream({
    session,
    memoryDirectory: join(root, "memory"),
    modelStream: async function* () {
      yield { type: "text_delta", delta: "done" };
      yield { type: "finish", finishReason: "stop" };
    },
  });
  agents.push(agent);
  return { root, workspaceRoot, agent };
}
function first(result: Awaited<ReturnType<Agent["memory"]["execute"]>>): MemoryEntry {
  if (!result.ok) throw new Error(result.error);
  const entry = result.value.entries[0];
  if (!entry) throw new Error("missing memory");
  return entry;
}
describe("Agent memory management", () => {
  it("shares durable manual controls across sessions and prevents stale updates after forgetting", async () => {
    const { agent, root } = await setup();
    expect((await agent.memory.query()).ok).toBe(true);
    const saved = first(
      await agent.memory.execute({
        action: "save",
        kind: "user",
        scope: "global",
        content: "以后先给结论，再解释。",
      }),
    );
    expect(saved.revision).toBe(1);
    expect(saved.status).toBe("active");
    expect(agent.state.messageHistory).toEqual([]);
    const other = (await setup(root)).agent;
    expect(first(await other.memory.query({ id: saved.id }))).toEqual(saved);
    await agent.memory.execute({ action: "settings", automatic: false });
    const settings = await other.memory.query();
    expect(settings.ok && settings.value.automatic).toBe(false);
    const corrected = first(
      await other.memory.execute({
        action: "save",
        id: saved.id,
        revision: saved.revision,
        kind: "user",
        scope: "global",
        content: "以后先说明结果，再列依据。",
      }),
    );
    expect(corrected.revision).toBe(2);
    expect((await agent.memory.execute({ action: "forget", id: saved.id, revision: 1 })).ok).toBe(
      false,
    );
    const forgotten = first(
      await other.memory.execute({
        action: "forget",
        id: saved.id,
        revision: 2,
        stopSending: true,
      }),
    );
    expect(forgotten.content).toBeNull();
    expect(forgotten.status).toBe("forgotten");
    const persisted = await readFile(join(root, "memory", "user", saved.id + ".json"), "utf8");
    expect(persisted).not.toContain(corrected.content);
    expect((await agent.memory.execute({ action: "confirm", id: saved.id, revision: 3 })).ok).toBe(
      false,
    );
    const memory = createMemory({
      directory: join(root, "memory"),
      workspaceRoot: join(root, "workspace"),
    });
    await agent.memory.execute({ action: "settings", automatic: true });
    await expect(
      memory.execute(
        {
          action: "save",
          kind: "user",
          scope: "global",
          content: corrected.content ?? "",
        },
        {
          explicit: false,
          source: { kind: "inferred", sessionId: "old", entryIds: [], note: "旧候选" },
        },
      ),
    ).rejects.toThrow("遗忘");
  });
  it("keeps expiry and file revalidation separate from access time", async () => {
    const { agent, workspaceRoot } = await setup();
    await writeFile(join(workspaceRoot, "config.txt"), "version one");
    const experience = first(
      await agent.memory.execute({
        action: "save",
        kind: "experience",
        content: "配置采用 version one。",
        paths: ["config.txt"],
        reviewAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    const preference = first(
      await agent.memory.execute({
        action: "save",
        kind: "user",
        scope: "global",
        content: "长期用中文回答。",
      }),
    );
    const temporary = first(
      await agent.memory.execute({
        action: "save",
        kind: "user",
        content: "暂不升级依赖。",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    expect(temporary.status).toBe("expired");
    expect(first(await agent.memory.query({ id: preference.id })).confirmedAt).toBe(
      preference.confirmedAt,
    );
    await writeFile(join(workspaceRoot, "config.txt"), "version two");
    expect(first(await agent.memory.query({ id: experience.id })).status).toBe("review");
    expect(first(await agent.memory.query({ id: experience.id })).confirmedAt).toBe(
      experience.confirmedAt,
    );
    expect(first(await agent.memory.query({ id: preference.id })).status).toBe("active");
  });
  it("isolates corrupt entries and refuses maintenance without guessing their suppression state", async () => {
    const { agent, root } = await setup();
    const saved = first(
      await agent.memory.execute({ action: "save", kind: "user", content: "先解释结果" }),
    );
    await writeFile(join(root, "memory", "user", saved.id + ".json"), "{broken");
    const snapshot = await agent.memory.query({ status: "all" });
    expect(snapshot.ok && snapshot.value.diagnostics).toHaveLength(1);
    expect(snapshot.ok && snapshot.value.entries).toEqual([]);
    expect(
      (await agent.memory.execute({ action: "save", kind: "user", content: "新内容" })).ok,
    ).toBe(false);
  });

  it("preserves a committed manual result when an event subscriber cancels immediately", async () => {
    const { agent } = await setup();
    agent.subscribe((event) => {
      if (event.type === "memory_changed") agent.abort();
    });
    const saved = await agent.memory.execute({
      action: "save",
      kind: "user",
      content: "已提交的偏好",
    });
    expect(saved.ok).toBe(true);
    expect(first(await agent.memory.query()).content).toBe("已提交的偏好");
    expect((await agent.memory.execute({ action: "settings", automatic: false })).ok).toBe(true);
  });

  it("recovers a dead writer under competing processes without losing a committed revision", async () => {
    const { agent, root, workspaceRoot } = await setup();
    const saved = first(
      await agent.memory.execute({ action: "save", kind: "user", content: "原始偏好" }),
    );
    const execute = promisify(execFile);
    const deadProcess = await execute(
      process.execPath,
      ["-e", "process.stdout.write(String(process.pid))"],
      { windowsHide: true },
    );
    await writeFile(
      join(root, "memory", "state", "write.lock"),
      JSON.stringify({ pid: Number(deadProcess.stdout), token: "dead-owner" }),
    );
    const script = [
      "const {createMemory} = await import(process.argv[1]);",
      "const memory=createMemory({workspaceRoot:process.argv[2],directory:process.argv[3]});",
      "try { await memory.execute(JSON.parse(process.argv[4]),{explicit:true,source:{kind:'user',sessionId:'fixture',entryIds:[],note:'用户更正'}}); process.stdout.write('committed'); }",
      "catch(error) { process.stdout.write(error.message.includes('版本已变化')?'conflict':error.message); }",
    ].join("\n");
    const outcomes = await Promise.all(
      [0, 1].map((index) =>
        execute(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            script,
            new URL("../dist/memory/index.js", import.meta.url).href,
            workspaceRoot,
            join(root, "memory"),
            JSON.stringify({
              action: "save",
              id: saved.id,
              revision: 1,
              kind: "user",
              content: "进程更正 " + index,
            }),
          ],
          { windowsHide: true, timeout: 15_000 },
        ),
      ),
    );
    expect(outcomes.map((outcome) => outcome.stdout).sort()).toEqual(["committed", "conflict"]);
    expect(first(await agent.memory.query()).revision).toBe(2);
  }, 20_000);

  it("identifies an unborn Git repository without requiring a commit", async () => {
    const { root, workspaceRoot } = await setup();
    await promisify(execFile)("git", ["init"], { cwd: workspaceRoot, windowsHide: true });
    const memory = createMemory({ directory: join(root, "memory"), workspaceRoot });
    const project = await memory.project();
    const expected = memoryHash(
      process.platform === "win32"
        ? join(workspaceRoot, ".git").toLowerCase()
        : join(workspaceRoot, ".git"),
    ).slice(0, 32);
    expect(project.id).toBe("project-" + expected);
  });

  it("serializes independent writers and preserves a successfully corrected revision", async () => {
    const { agent, root } = await setup();
    const other = (await setup(root)).agent;
    const saved = first(
      await agent.memory.execute({ action: "save", kind: "user", content: "回答简短。" }),
    );
    const outcomes = await Promise.all(
      [agent, other].map((writer, index) =>
        writer.memory.execute({
          action: "save",
          id: saved.id,
          revision: 1,
          kind: "user",
          content: "回答方式 " + index,
        }),
      ),
    );
    expect(outcomes.filter((result) => result.ok)).toHaveLength(1);
    expect(outcomes.filter((result) => !result.ok)).toHaveLength(1);
    expect(first(await agent.memory.query({ id: saved.id })).revision).toBe(2);
    expect(
      (
        await agent.memory.execute({
          action: "save",
          kind: "user",
          content: "api_key=sk-123456789012345678901234",
        })
      ).ok,
    ).toBe(false);
  });
});
