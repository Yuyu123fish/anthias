import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { isMap, parseDocument } from "yaml";

export type SkillInfo = Readonly<{
  id: string;
  name: string;
  description: string;
  path: string;
  source: string;
  error: string | null;
}>;

export type SkillContent = Readonly<{
  skill: SkillInfo;
  path: string;
  content: string;
  fingerprint: string;
}>;

export type SkillLibrary = Readonly<{
  list(): readonly SkillInfo[];
  reload(): Promise<readonly SkillInfo[]>;
  load(idOrUniqueName: string): Promise<SkillContent>;
  read(idOrUniqueName: string, relativePath: string): Promise<SkillContent>;
}>;

type SkillDirectory = Readonly<{ path: string; source: string }>;
type SkillEntry = Readonly<{ info: SkillInfo; root: string }>;
type SkillMetadata = Readonly<{ name: string; description: string; bodyOffset: number }>;

const MAX_DIRECTORY_ENTRIES = 128;
const MAX_METADATA_BYTES = 8 * 1024;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_REFERENCE_BYTES = 32 * 1024;
const ERRORS = Object.freeze({
  missing: "Skill 文件或目录不存在，请重新发现 Skills。",
  read: "无法读取 Skill 文件或目录。",
  directory: "Skill 根目录不是目录。",
  limit: "Skill 根目录超过 128 项，请配置更小的目录。",
  file: "Skill 只支持读取普通文件。",
  changed: "Skill 文件或目录在读取期间发生变化，请重新发现 Skills。",
  path: "Skill 引用必须是根目录内的相对文件路径。",
  escape: "Skill 引用的真实路径越出 Skill 根目录。",
  metadata: "Skill frontmatter 必须是 8 KiB 内的 YAML 映射。",
  name: "Skill name 必须为 1–64 个小写字母、数字或单连字符，并与目录名一致。",
  description: "Skill description 必须为 1–1024 个字符的非空文本。",
  body: "Skill 正文超过 64 KiB，请拆分为按需引用资料。",
  reference: "Skill 引用超过 32 KiB，请选择更小的文本资料。",
  encoding: "Skill 只支持不含空字符的有效 UTF-8 文本。",
  notFound: "未找到 Skill，请查看 Skills 列表或重新发现。",
  ambiguous: "Skill 名称存在重名，请使用列表中的稳定 ID。",
  stale: "Skill 元数据已改变，请先重新发现 Skills。",
});
const SAFE_ERRORS = new Set<string>(Object.values(ERRORS));

/** 只保存有界目录与元数据；正文、引用和激活状态分别由读取操作与调用者持有。 */
export async function createSkillLibrary(options: {
  workspaceRoot: string;
  environment?: NodeJS.ProcessEnv;
  directories?: readonly SkillDirectory[];
}): Promise<SkillLibrary> {
  const environment = options.environment ?? process.env;
  const configuredDirectories = options.directories ?? [
    { path: join(options.workspaceRoot, ".agents", "skills"), source: "project" },
    {
      path: join(environment.USERPROFILE || environment.HOME || homedir(), ".agents", "skills"),
      source: "user",
    },
    ...(environment.ANTHIAS_SKILL_DIRS ?? "")
      .split(delimiter)
      .filter((path) => path.trim().length > 0)
      .map((path) => ({ path: resolve(options.workspaceRoot, path.trim()), source: "additional" })),
  ];
  let entries: readonly SkillEntry[] = [];
  let infos: readonly SkillInfo[] = Object.freeze([]);

  function findEntry(selector: string): SkillEntry {
    const exactEntry = entries.find((entry) => entry.info.id === selector);
    const candidates = exactEntry
      ? [exactEntry]
      : entries.filter((entry) => entry.info.name === selector);
    if (candidates.length > 1) throw new Error(ERRORS.ambiguous);
    const entry = candidates[0];
    if (entry === undefined) throw new Error(ERRORS.notFound);
    if (entry.info.error !== null) throw new Error(entry.info.error);
    return entry;
  }

  async function reload(): Promise<readonly SkillInfo[]> {
    const discoveredEntries: SkillEntry[] = [];
    const knownRoots = new Set<string>();
    for (const directory of configuredDirectories) {
      const directoryPath = resolve(options.workspaceRoot, directory.path);
      try {
        const actualDirectory = await realpath(directoryPath);
        if (!(await stat(actualDirectory)).isDirectory()) throw new Error(ERRORS.directory);
        const candidatePaths = await discoverCandidates(actualDirectory);
        for (const candidatePath of candidatePaths) {
          let root = candidatePath;
          try {
            root = await realpath(candidatePath);
            const rootKey = pathKey(root);
            if (knownRoots.has(rootKey)) continue;
            knownRoots.add(rootKey);
            const metadata = await readMetadata(root);
            discoveredEntries.push({
              root,
              info: createInfo(root, directory.source, metadata),
            });
          } catch (error) {
            discoveredEntries.push({
              root,
              info: createInfo(root, directory.source, null, safeError(error).message),
            });
          }
        }
      } catch (error) {
        // 缺失的默认目录很常见；已有但不可读或超限的目录必须可见，不能静默少加载。
        if (
          !hasErrorCode(error, "ENOENT") ||
          options.directories !== undefined ||
          directory.source === "additional"
        ) {
          discoveredEntries.push({
            root: directoryPath,
            info: createInfo(directoryPath, directory.source, null, safeError(error).message),
          });
        }
      }
    }
    entries = Object.freeze(discoveredEntries);
    infos = Object.freeze(entries.map((entry) => entry.info));
    return infos;
  }

  const library: SkillLibrary = Object.freeze({
    list: () => infos,
    reload,
    async load(selector) {
      const entry = findEntry(selector);
      const { bytes } = await readWithinRoot(
        entry.root,
        "SKILL.md",
        MAX_METADATA_BYTES + MAX_BODY_BYTES + 1,
      );
      const metadata = parseMetadata(bytes, basename(entry.root));
      if (metadata.name !== entry.info.name || metadata.description !== entry.info.description) {
        throw new Error(ERRORS.stale);
      }
      const bodyBytes = bytes.subarray(metadata.bodyOffset);
      if (bodyBytes.length > MAX_BODY_BYTES) throw new Error(ERRORS.body);
      return createContent(entry.info, "SKILL.md", decodeText(bodyBytes), bytes);
    },
    async read(selector, requestedPath) {
      const entry = findEntry(selector);
      const normalizedPath = validateRelativePath(requestedPath);
      const { bytes, path } = await readWithinRoot(
        entry.root,
        normalizedPath,
        MAX_REFERENCE_BYTES + 1,
      );
      if (bytes.length > MAX_REFERENCE_BYTES) throw new Error(ERRORS.reference);
      return createContent(entry.info, path, decodeText(bytes), bytes);
    },
  });
  await reload();
  return library;
}

async function discoverCandidates(directory: string): Promise<readonly string[]> {
  try {
    await lstat(join(directory, "SKILL.md"));
    return [directory];
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  const candidatePaths: string[] = [];
  let inspectedEntries = 0;
  const directoryHandle = await opendir(directory);
  for await (const entry of directoryHandle) {
    inspectedEntries += 1;
    if (inspectedEntries > MAX_DIRECTORY_ENTRIES) throw new Error(ERRORS.limit);
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const candidatePath = join(directory, entry.name);
    try {
      await lstat(join(candidatePath, "SKILL.md"));
      candidatePaths.push(candidatePath);
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTDIR")) throw error;
    }
  }
  return candidatePaths.sort();
}

async function readMetadata(root: string): Promise<SkillMetadata> {
  return parseMetadata(
    (await readWithinRoot(root, "SKILL.md", MAX_METADATA_BYTES + 1)).bytes,
    basename(root),
  );
}

function parseMetadata(bytes: Buffer, directoryName: string): SkillMetadata {
  const prefix = bytes.subarray(0, MAX_METADATA_BYTES + 1).toString("utf8");
  const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(prefix);
  if (opening === null) throw new Error(ERRORS.metadata);
  const remaining = prefix.slice(opening[0].length);
  const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(remaining);
  if (closing === null) throw new Error(ERRORS.metadata);
  const bodyOffset = Buffer.byteLength(
    prefix.slice(0, opening[0].length + closing.index + closing[0].length),
    "utf8",
  );
  if (bodyOffset > MAX_METADATA_BYTES) throw new Error(ERRORS.metadata);
  const metadataText = decodeText(
    bytes.subarray(
      Buffer.byteLength(opening[0], "utf8"),
      bodyOffset - Buffer.byteLength(closing[0]),
    ),
  );
  const document = (() => {
    try {
      return parseDocument(metadataText, { schema: "core", uniqueKeys: true });
    } catch {
      throw new Error(ERRORS.metadata);
    }
  })();
  if (document.errors.length > 0 || !isMap(document.contents)) throw new Error(ERRORS.metadata);
  // 只取核心 scalar，既不展开 YAML alias，也不解释 allowed-tools 等扩展授权字段。
  const name = document.get("name");
  const description = document.get("description");
  if (
    typeof name !== "string" ||
    [...name].length > 64 ||
    !/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(name) ||
    name !== name.toLowerCase() ||
    name !== directoryName
  ) {
    throw new Error(ERRORS.name);
  }
  if (
    typeof description !== "string" ||
    description.trim().length === 0 ||
    [...description].length > 1024 ||
    [...description].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        (codePoint < 32 && ![9, 10, 13].includes(codePoint)) ||
        (codePoint >= 127 && codePoint <= 159)
      );
    })
  ) {
    throw new Error(ERRORS.description);
  }
  return { name, description: description.trim().replace(/\s+/gu, " "), bodyOffset };
}

async function readWithinRoot(
  root: string,
  requestedPath: string,
  byteLimit: number,
): Promise<Readonly<{ bytes: Buffer; path: string }>> {
  try {
    const currentRoot = await realpath(root);
    if (pathKey(currentRoot) !== pathKey(root)) throw new Error(ERRORS.changed);
    const actualPath = await realpath(resolve(root, validateRelativePath(requestedPath)));
    if (!isInside(root, actualPath)) throw new Error(ERRORS.escape);
    const originalStats = await lstat(actualPath);
    if (!originalStats.isFile()) throw new Error(ERRORS.file);
    const openFlags =
      process.platform === "win32"
        ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    const fileHandle = await open(actualPath, openFlags);
    try {
      const openedStats = await fileHandle.stat();
      const confirmedPath = await realpath(actualPath);
      // 打开后再次核对路径与 inode，避免普通链接替换让已校验路径指向另一份文件。
      if (
        !openedStats.isFile() ||
        openedStats.dev !== originalStats.dev ||
        openedStats.ino !== originalStats.ino ||
        !isInside(root, confirmedPath)
      ) {
        throw new Error(ERRORS.changed);
      }
      const buffer = Buffer.alloc(byteLimit);
      let byteLength = 0;
      while (byteLength < byteLimit) {
        const { bytesRead } = await fileHandle.read(
          buffer,
          byteLength,
          byteLimit - byteLength,
          null,
        );
        if (bytesRead === 0) break;
        byteLength += bytesRead;
      }
      const finalStats = await fileHandle.stat();
      if (finalStats.size !== openedStats.size || finalStats.mtimeMs !== openedStats.mtimeMs) {
        throw new Error(ERRORS.changed);
      }
      return {
        bytes: buffer.subarray(0, byteLength),
        path: relative(root, actualPath).replaceAll("\\", "/"),
      };
    } finally {
      await fileHandle.close();
    }
  } catch (error) {
    throw safeError(error);
  }
}

function validateRelativePath(requestedPath: string): string {
  const normalizedPath = requestedPath.replaceAll("\\", "/");
  if (
    normalizedPath.length === 0 ||
    isAbsolute(normalizedPath) ||
    win32.isAbsolute(requestedPath) ||
    normalizedPath.split("/").some((part) => part === ".." || part.includes(":")) ||
    normalizedPath.includes("\0")
  ) {
    throw new Error(ERRORS.path);
  }
  return normalizedPath;
}

function isInside(root: string, targetPath: string): boolean {
  const relativePath = relative(pathKey(root), pathKey(targetPath));
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function pathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function decodeText(bytes: Buffer): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw new Error(ERRORS.encoding);
    return text;
  } catch {
    throw new Error(ERRORS.encoding);
  }
}

function createInfo(
  root: string,
  source: string,
  metadata: SkillMetadata | null,
  error: string | null = null,
): SkillInfo {
  const sourceLabel = source.replace(/[^\p{L}\p{N}_-]/gu, "-").slice(0, 32) || "local";
  return Object.freeze({
    id: `${sourceLabel}:${createHash("sha256").update(pathKey(root)).digest("hex").slice(0, 16)}`,
    name: metadata?.name ?? basename(root),
    description: metadata?.description ?? "",
    path: join(root, "SKILL.md"),
    source: sourceLabel,
    error,
  });
}

function createContent(
  info: SkillInfo,
  path: string,
  content: string,
  bytes: Buffer,
): SkillContent {
  return Object.freeze({
    skill: info,
    path,
    content,
    fingerprint: createHash("sha256").update(bytes).digest("hex"),
  });
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function safeError(error: unknown): Error {
  if (error instanceof Error && SAFE_ERRORS.has(error.message)) return error;
  return new Error(hasErrorCode(error, "ENOENT") ? ERRORS.missing : ERRORS.read);
}
