import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ToolCallScheduling } from "./tool-runner.js";
import { arePathsEqual } from "./workspace-path.js";

type FileAccess = Readonly<{
  path: string;
  access: "read" | "write";
  recursive: boolean;
  identity?: string;
}>;

/** 只合并连续且无冲突的调用；未知副作用和资源冲突阻止后续调用跨越。 */
export function selectConcurrentToolBatch<T extends Readonly<{ scheduling: ToolCallScheduling }>>(
  plans: readonly T[],
  start: number,
): readonly T[] {
  const batch: T[] = [];
  const accesses: FileAccess[] = [];
  for (let index = start; index < plans.length; index += 1) {
    const plan = plans[index];
    if (plan === undefined) break;
    if (plan.scheduling === "serial") {
      if (batch.length === 0) batch.push(plan);
      break;
    }
    const access = plan.scheduling === "parallel" ? null : resolveAccess(plan.scheduling);
    if (access !== null && accesses.some((previous) => conflicts(previous, access))) break;
    batch.push(plan);
    if (access !== null) accesses.push(access);
  }
  return batch;
}

function resolveAccess(scheduling: Exclude<ToolCallScheduling, string>): FileAccess {
  let path = resolve(scheduling.path);
  let existingAncestor = path;
  const missingNames: string[] = [];
  for (;;) {
    try {
      existingAncestor = realpathSync(existingAncestor);
      path = join(existingAncestor, ...missingNames.reverse());
      break;
    } catch {
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) break;
      missingNames.push(basename(existingAncestor));
      existingAncestor = parent;
    }
  }
  let identity: string | undefined;
  try {
    const stats = statSync(path, { bigint: true });
    if (stats.ino !== 0n) identity = stats.dev + ":" + stats.ino;
  } catch {
    // 不存在的目标由真实父目录和文件名定位；执行阶段仍需独立复核。
  }
  return {
    path,
    access: scheduling.access,
    recursive: scheduling.recursive === true,
    ...(identity === undefined ? {} : { identity }),
  };
}

function conflicts(left: FileAccess, right: FileAccess): boolean {
  if (left.access === "read" && right.access === "read") return false;
  // 搜索可能经文件链接读取目录外目标，未枚举完整读集时不能与任何写入重叠。
  if (left.recursive || right.recursive) return true;
  return (
    arePathsEqual(left.path, right.path) ||
    (left.identity !== undefined && left.identity === right.identity)
  );
}
