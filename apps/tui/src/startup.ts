import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 保存启动装配已经规范化的三条互不混淆的路径。 */
export type StartupPaths = Readonly<{
  workspaceRoot: string;
  anthiasProjectRoot: string;
  sessionDirectory: string;
}>;

/** 描述只在 CLI 组合根内部使用的路径输入。 */
export type ResolveStartupPathsOptions = Readonly<{
  invocationWorkingDirectory: string;
  requestedWorkspace?: string;
  environment?: NodeJS.ProcessEnv;
  moduleUrl?: string;
}>;

export type StartupPathFailureReason =
  | "anthias_project_unavailable"
  | "workspace_unavailable"
  | "session_directory_invalid";

/** 携带可安全展示的启动路径失败，不暴露底层文件系统异常。 */
export class StartupPathError extends Error {
  readonly reason: StartupPathFailureReason;

  constructor(reason: StartupPathFailureReason, message: string) {
    super(message);
    this.name = "StartupPathError";
    this.reason = reason;
  }
}

/** 从 CLI 调用位置与安装位置分别解析 Workspace 和 Anthias Data Root。 */
export async function resolveStartupPaths(
  options: ResolveStartupPathsOptions,
): Promise<StartupPaths> {
  const environment = options.environment ?? process.env;
  const anthiasProjectRoot = await resolveAnthiasProjectRoot(options.moduleUrl ?? import.meta.url);
  const workspaceRoot = await resolveWorkspaceRoot(
    options.invocationWorkingDirectory,
    options.requestedWorkspace,
  );
  const overrideDirectory = environment.ANTHIAS_SESSION_DIR?.trim();
  if (overrideDirectory && !isAbsolute(overrideDirectory)) {
    throw new StartupPathError("session_directory_invalid", "ANTHIAS_SESSION_DIR 必须是绝对路径。");
  }

  return Object.freeze({
    workspaceRoot,
    anthiasProjectRoot,
    sessionDirectory: overrideDirectory
      ? resolve(overrideDirectory)
      : join(anthiasProjectRoot, "data", "conversation"),
  });
}

/** 只根据启动模块位置识别 Anthias，不从用户 Workspace 向上扫描。 */
async function resolveAnthiasProjectRoot(moduleUrl: string): Promise<string> {
  try {
    const moduleDirectory = dirname(fileURLToPath(moduleUrl));
    const projectRoot = await realpath(resolve(moduleDirectory, "../../.."));
    const packageMetadata = JSON.parse(
      await readFile(join(projectRoot, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    if (packageMetadata.name !== "anthias") {
      throw new Error("unexpected package identity");
    }
    return projectRoot;
  } catch {
    throw new StartupPathError(
      "anthias_project_unavailable",
      "无法确定 Anthias 项目目录，请从完整的 Anthias 项目启动。",
    );
  }
}

/** 以调用时 cwd 为相对路径基准，并拒绝文件或不可访问目录。 */
async function resolveWorkspaceRoot(
  invocationWorkingDirectory: string,
  requestedWorkspace: string | undefined,
): Promise<string> {
  const workspaceArgument = requestedWorkspace?.trim();
  if (requestedWorkspace !== undefined && !workspaceArgument) {
    throw new StartupPathError("workspace_unavailable", "Workspace 必须是存在的目录。");
  }
  const workspacePath = workspaceArgument
    ? isAbsolute(workspaceArgument)
      ? workspaceArgument
      : resolve(invocationWorkingDirectory, workspaceArgument)
    : invocationWorkingDirectory;
  try {
    const workspaceRoot = await realpath(workspacePath);
    if (!(await stat(workspaceRoot)).isDirectory()) {
      throw new Error("workspace is not a directory");
    }
    return workspaceRoot;
  } catch {
    throw new StartupPathError("workspace_unavailable", "Workspace 必须是存在的目录。");
  }
}
