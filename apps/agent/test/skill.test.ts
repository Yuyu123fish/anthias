import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSkillLibrary } from "../src/skill/index.js";

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

describe("Skill library", () => {
  it("discovers project, user and additional roots without reading bodies eagerly", async () => {
    const workspaceRoot = await createDirectory();
    const userRoot = join(workspaceRoot, "home");
    const additionalRoot = join(workspaceRoot, "additional");
    await writeSkill(
      join(workspaceRoot, ".agents", "skills"),
      "project-skill",
      "p".repeat(100_000),
    );
    await writeSkill(join(userRoot, ".agents", "skills"), "user-skill", "User instructions");
    const standaloneRoot = await writeSkill(additionalRoot, "standalone-skill", "Standalone");
    await writeSkill(
      join(workspaceRoot, ".agents", "skills", "nested", "deeper"),
      "hidden",
      "Hidden",
    );

    const library = await createSkillLibrary({
      workspaceRoot,
      environment: {
        USERPROFILE: userRoot,
        HOME: userRoot,
        ANTHIAS_SKILL_DIRS: [additionalRoot, standaloneRoot].join(delimiter),
      },
    });

    expect(library.list().map((skill) => [skill.name, skill.source, skill.error])).toEqual([
      ["project-skill", "project", null],
      ["user-skill", "user", null],
      ["standalone-skill", "additional", null],
    ]);
    expect(library.list()[0]).not.toHaveProperty("content");
    await expect(library.load("project-skill")).rejects.toThrow("正文超过 64 KiB");
  });

  it("loads YAML block metadata, instructions and references with stable source identities", async () => {
    const workspaceRoot = await createDirectory();
    const skillRoot = await writeSkill(workspaceRoot, "review-code", "Review these changes.\n", {
      description: ">-\n  Review changes\n  and explain risks.",
      extra:
        "allowed-tools: execute_command\ncustom-field: &custom {nested: value}\ncopy: *custom\n",
    });
    await mkdir(join(skillRoot, "references"));
    await writeFile(join(skillRoot, "references", "guide.md"), "# Guide\n使用中文说明。", "utf8");
    const library = await isolatedLibrary(workspaceRoot);
    const skill = library.list()[0];
    expect(skill?.description).toBe("Review changes and explain risks.");
    expect(skill).not.toHaveProperty("allowed-tools");
    if (skill === undefined) throw new Error("Expected discovered skill");

    const loaded = await library.load(skill.id);
    expect(loaded).toMatchObject({ skill, path: "SKILL.md", content: "Review these changes.\n" });
    expect(loaded.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    const reference = await library.read(skill.id, "references\\guide.md");
    expect(await library.read(skill.id, "./references//guide.md")).toEqual(reference);
    expect(reference).toMatchObject({
      path: "references/guide.md",
      content: "# Guide\n使用中文说明。",
    });
    expect((await library.reload())[0]?.id).toBe(skill.id);
    expect(await library.load(skill.id)).toEqual(loaded);
    expect(Object.isFrozen(library.list())).toBe(true);
    expect(Object.isFrozen(skill)).toBe(true);
  });

  it("preserves conflicting names and requires a stable id to load them", async () => {
    const workspaceRoot = await createDirectory();
    const firstDirectory = join(workspaceRoot, "first");
    const secondDirectory = join(workspaceRoot, "second");
    await writeSkill(firstDirectory, "same-name", "First");
    await writeSkill(secondDirectory, "same-name", "Second");
    const library = await createSkillLibrary({
      workspaceRoot,
      directories: [
        { path: firstDirectory, source: "project" },
        { path: secondDirectory, source: "user" },
      ],
    });

    expect(library.list()).toHaveLength(2);
    await expect(library.load("same-name")).rejects.toThrow("名称存在重名");
    const loaded = await Promise.all(library.list().map((skill) => library.load(skill.id)));
    expect(loaded.map((content) => content.content)).toEqual(["First", "Second"]);
    expect(new Set(loaded.map((content) => content.skill.id)).size).toBe(2);
  });

  it.each([
    ["missing", "No frontmatter", "frontmatter"],
    ["invalid-name", "---\nname: Invalid-Name\ndescription: Purpose\n---\n", "name"],
    ["wrong-directory", "---\nname: other-name\ndescription: Purpose\n---\n", "name"],
    ["empty-description", "---\nname: empty-description\ndescription: ''\n---\n", "description"],
    [
      "duplicate-key",
      "---\nname: duplicate-key\nname: duplicate-key\ndescription: Purpose\n---\n",
      "frontmatter",
    ],
    [
      "alias-name",
      "---\nvalue: &name alias-name\nname: *name\ndescription: Purpose\n---\n",
      "name",
    ],
  ])("reports invalid %s metadata without exposing raw YAML", async (name, document, reason) => {
    const workspaceRoot = await createDirectory();
    await mkdir(join(workspaceRoot, name));
    await writeFile(join(workspaceRoot, name, "SKILL.md"), document, "utf8");
    const library = await isolatedLibrary(workspaceRoot);

    expect(library.list()).toHaveLength(1);
    expect(library.list()[0]?.error).toContain(reason);
    await expect(library.load(name)).rejects.toThrow(reason);
    expect(library.list()[0]?.error).not.toContain(document);
  });

  it("enforces metadata, body and reference byte limits without silent truncation", async () => {
    const workspaceRoot = await createDirectory();
    await writeSkill(workspaceRoot, "huge-metadata", "Body", {
      extra: `extra: ${"x".repeat(8200)}\n`,
    });
    const exactRoot = await writeSkill(workspaceRoot, "exact-body", "x".repeat(64 * 1024));
    const largeRoot = await writeSkill(workspaceRoot, "large-reference", "Body");
    await writeFile(join(largeRoot, "exact.txt"), "x".repeat(32 * 1024), "utf8");
    await writeFile(join(largeRoot, "large.txt"), "x".repeat(32 * 1024 + 1), "utf8");
    const library = await isolatedLibrary(workspaceRoot);

    expect(library.list().find((skill) => skill.name === "huge-metadata")?.error).toContain(
      "8 KiB",
    );
    expect((await library.load("exact-body")).content).toHaveLength(64 * 1024);
    await writeFile(
      join(exactRoot, "SKILL.md"),
      skillDocument("exact-body", "中".repeat(22_000)),
      "utf8",
    );
    await expect(library.load("exact-body")).rejects.toThrow("64 KiB");
    expect((await library.read("large-reference", "exact.txt")).content).toHaveLength(32 * 1024);
    await expect(library.read("large-reference", "large.txt")).rejects.toThrow("32 KiB");
  });

  it("reports explicitly configured missing roots while ignoring absent default roots", async () => {
    const workspaceRoot = await createDirectory();
    const library = await createSkillLibrary({
      workspaceRoot,
      environment: { USERPROFILE: workspaceRoot, HOME: workspaceRoot },
    });
    expect(library.list()).toEqual([]);
    const explicitLibrary = await createSkillLibrary({
      workspaceRoot,
      directories: [{ path: "missing", source: "explicit" }],
    });
    expect(explicitLibrary.list()[0]?.error).toContain("不存在");
  });

  it("rejects an oversized discovery root instead of selecting an arbitrary subset", async () => {
    const workspaceRoot = await createDirectory();
    await Promise.all(
      Array.from({ length: 129 }, (_, index) => mkdir(join(workspaceRoot, `entry-${index}`))),
    );
    const library = await isolatedLibrary(workspaceRoot);

    expect(library.list()).toHaveLength(1);
    expect(library.list()[0]?.error).toContain("超过 128 项");
  });

  it("confines references to the real skill root including Windows junctions", async () => {
    const workspaceRoot = await createDirectory();
    const skillRoot = await writeSkill(workspaceRoot, "safe-reader", "Instructions");
    const externalRoot = join(workspaceRoot, "external");
    await mkdir(externalRoot);
    await writeFile(join(externalRoot, "secret.txt"), "External content", "utf8");
    await symlink(
      externalRoot,
      join(skillRoot, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await mkdir(join(skillRoot, "references"));
    await writeFile(join(skillRoot, "references", "safe.txt"), "Inside", "utf8");
    const library = await isolatedLibrary(workspaceRoot);

    for (const requestedPath of [
      "../external/secret.txt",
      "C:\\external\\secret.txt",
      "/etc/passwd",
      "note.txt:stream",
      "",
    ]) {
      await expect(library.read("safe-reader", requestedPath)).rejects.toThrow("相对文件路径");
    }
    await expect(library.read("safe-reader", "escape/secret.txt")).rejects.toThrow(
      "越出 Skill 根目录",
    );
    await expect(library.read("safe-reader", "references")).rejects.toThrow("普通文件");
    expect((await library.read("safe-reader", "references/safe.txt")).content).toBe("Inside");
  });

  it("requires rediscovery for changed metadata and reports missing or non-text files safely", async () => {
    const workspaceRoot = await createDirectory();
    const skillRoot = await writeSkill(workspaceRoot, "changing-skill", "Original");
    await writeFile(join(skillRoot, "binary.bin"), Buffer.from([0xff, 0x00]));
    const library = await isolatedLibrary(workspaceRoot);
    const original = await library.load("changing-skill");
    await writeFile(
      join(skillRoot, "SKILL.md"),
      skillDocument("changing-skill", "Updated", { description: "Updated purpose" }),
      "utf8",
    );

    await expect(library.load("changing-skill")).rejects.toThrow("元数据已改变");
    await library.reload();
    const updated = await library.load(original.skill.id);
    expect(updated.content).toBe("Updated");
    expect(updated.fingerprint).not.toBe(original.fingerprint);
    await expect(library.read(original.skill.id, "binary.bin")).rejects.toThrow("UTF-8");
    await expect(library.read(original.skill.id, "private-name-do-not-echo.txt")).rejects.toThrow(
      "不存在",
    );
    await rm(join(skillRoot, "SKILL.md"));
    await expect(library.load(original.skill.id)).rejects.toThrow("不存在");
    expect(await library.reload()).toEqual([]);
  });
});

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "anthias-skill-test-"));
  temporaryDirectories.add(directory);
  return directory;
}

function isolatedLibrary(workspaceRoot: string) {
  return createSkillLibrary({
    workspaceRoot,
    environment: {},
    directories: [{ path: workspaceRoot, source: "test" }],
  });
}

async function writeSkill(
  parentRoot: string,
  name: string,
  body: string,
  metadata: { description?: string; extra?: string } = {},
): Promise<string> {
  const skillRoot = join(parentRoot, name);
  await mkdir(skillRoot, { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), skillDocument(name, body, metadata), "utf8");
  return skillRoot;
}

function skillDocument(
  name: string,
  body: string,
  metadata: { description?: string; extra?: string } = {},
): string {
  return `---\nname: ${name}\ndescription: ${metadata.description ?? "Use this skill for its documented purpose."}\n${metadata.extra ?? ""}---\n${body}`;
}
