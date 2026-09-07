import { createHash } from "node:crypto";

export type MemoryKind = "user" | "experience";
export type MemoryStatus = "active" | "candidate" | "review" | "expired" | "forgotten";
export type MemorySource = Readonly<{
  kind: "user" | "verified" | "inferred";
  sessionId: string;
  entryIds: readonly string[];
  note: string;
}>;
export type MemoryConditions = Readonly<{
  branch: string | null;
  files: readonly Readonly<{ path: string; fingerprint: string }>[];
}>;
export type MemoryEntry = Readonly<{
  formatVersion: 1;
  id: string;
  revision: number;
  kind: MemoryKind;
  scope: string;
  content: string | null;
  contentHash: string;
  status: MemoryStatus;
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  userConfirmed?: boolean;
  expiresAt: string | null;
  reviewAt: string | null;
  conditions: MemoryConditions;
  suppressedSources: readonly string[];
  suppressedHashes: readonly string[];
  stopSending: boolean;
}>;
export type MemoryAction =
  | Readonly<{
      action: "save";
      kind: MemoryKind;
      content: string;
      scope?: "global" | "project";
      id?: string;
      revision?: number;
      expiresAt?: string | null;
      reviewAt?: string | null;
      branch?: string | null;
      paths?: readonly string[];
    }>
  | Readonly<{ action: "confirm"; id: string; revision: number }>
  | Readonly<{ action: "forget"; id: string; revision: number; stopSending?: boolean }>
  | Readonly<{ action: "settings"; automatic: boolean }>;
export type MemoryQuery = Readonly<{
  id?: string;
  text?: string;
  kind?: MemoryKind;
  status?: MemoryStatus | "all";
  scope?: "current" | "all";
}>;
export type MemorySnapshot = Readonly<{
  automatic: boolean;
  projectId: string;
  entries: readonly MemoryEntry[];
  diagnostics: readonly string[];
}>;
export const MEMORY_CONTENT_BYTES = 8 * 1024;
export const MEMORY_ENTRY_BYTES = 24 * 1024;
export const MEMORY_ENTRY_LIMIT = 512;

export function memoryHash(text: string): string {
  return createHash("sha256").update(text.trim().replace(/\r\n/g, "\n")).digest("hex");
}
export function isMemoryIdentity(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}
export function isMemoryScope(value: unknown): value is string {
  return value === "global" || (typeof value === "string" && /^project-[a-f0-9]{32}$/.test(value));
}
function validTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function nullableTime(value: unknown): value is string | null {
  return value === null || validTime(value);
}
function stringArray(value: unknown, limit: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= limit &&
    value.every((item) => typeof item === "string" && item.length <= 256)
  );
}
export function isMemoryStatus(value: unknown): value is MemoryStatus {
  return (
    typeof value === "string" &&
    ["active", "candidate", "review", "expired", "forgotten"].includes(value)
  );
}
export function isMemoryKind(value: unknown): value is MemoryKind {
  return value === "user" || value === "experience";
}
export function assertMemoryText(content: string) {
  if (
    typeof content !== "string" ||
    content.trim().length === 0 ||
    Buffer.byteLength(content) > MEMORY_CONTENT_BYTES
  )
    throw new Error("记忆正文不能为空，且不能超过 8 KiB。");
  if (
    /\b(?:sk-[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9]{16,}|AKIA[A-Z0-9]{16})\b/.test(content) ||
    /(?:api[_ -]?key|access[_ -]?token|password|密码|密钥)\s*[:=：]\s*["']?(?!<|placeholder\b|example\b|\$\{|process\.env\b)[a-zA-Z0-9/+_=-]{8,}/i.test(
      content,
    )
  )
    throw new Error("记忆不能保存凭据或敏感值。");
}
export function parseMemoryEntry(value: unknown): MemoryEntry {
  if (typeof value !== "object" || value === null) throw new Error("记忆格式无效。");
  const entry = value as Record<string, unknown>;
  const source = entry.source as Record<string, unknown> | null;
  const conditions = entry.conditions as Record<string, unknown> | null;
  if (
    entry.formatVersion !== 1 ||
    !isMemoryIdentity(entry.id) ||
    !Number.isSafeInteger(entry.revision) ||
    Number(entry.revision) < 1 ||
    !isMemoryKind(entry.kind) ||
    !isMemoryScope(entry.scope) ||
    !isMemoryStatus(entry.status) ||
    (entry.content !== null &&
      (typeof entry.content !== "string" ||
        Buffer.byteLength(entry.content) > MEMORY_CONTENT_BYTES)) ||
    (entry.status === "forgotten" ? entry.content !== null : typeof entry.content !== "string") ||
    typeof entry.contentHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(entry.contentHash) ||
    !validTime(entry.createdAt) ||
    !validTime(entry.updatedAt) ||
    !nullableTime(entry.confirmedAt) ||
    (entry.userConfirmed !== undefined && typeof entry.userConfirmed !== "boolean") ||
    !nullableTime(entry.expiresAt) ||
    !nullableTime(entry.reviewAt) ||
    !source ||
    !["user", "verified", "inferred"].includes(String(source.kind)) ||
    typeof source.sessionId !== "string" ||
    !stringArray(source.entryIds, 32) ||
    typeof source.note !== "string" ||
    Buffer.byteLength(source.note) > 2048 ||
    !conditions ||
    (conditions.branch !== null && typeof conditions.branch !== "string") ||
    !Array.isArray(conditions.files) ||
    conditions.files.length > 8 ||
    !conditions.files.every((file: unknown) => {
      if (typeof file !== "object" || file === null) return false;
      const item = file as Record<string, unknown>;
      return (
        typeof item.path === "string" &&
        item.path.length <= 1024 &&
        typeof item.fingerprint === "string" &&
        /^[a-f0-9]{64}$/.test(item.fingerprint)
      );
    }) ||
    !stringArray(entry.suppressedSources, 128) ||
    !stringArray(entry.suppressedHashes, 128) ||
    typeof entry.stopSending !== "boolean"
  )
    throw new Error("记忆字段或格式版本无效。");
  if (entry.content !== null && memoryHash(entry.content as string) !== entry.contentHash)
    throw new Error("记忆正文与指纹不一致。");
  return Object.freeze(value as MemoryEntry);
}
export function assertMemoryTime(value: string | null | undefined) {
  if (value !== undefined && !nullableTime(value))
    throw new Error("记忆时间必须是可解析的绝对时间。");
  if (typeof value === "string" && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value))
    throw new Error("记忆时间必须包含时区。");
}
