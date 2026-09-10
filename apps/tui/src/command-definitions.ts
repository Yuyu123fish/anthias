type SubcommandDefinition = Readonly<{
  name: string;
  argumentHint?: string;
  description?: string;
  optionalName?: boolean;
  completionSuffixes?: readonly string[];
  argumentCompletion?: "member" | "mcp-server";
}>;

type CommandDefinition = Readonly<{
  name: string;
  description: string;
  argumentHint?: string;
  subcommands?: readonly SubcommandDefinition[];
  helpNotes?: readonly string[];
}>;

const memoryCommand: CommandDefinition = {
  name: "memory",
  description: "查看和维护分层记忆",
  subcommands: [
    {
      name: "list",
      optionalName: true,
      argumentHint: "[user|experience] [active|candidate|review|expired|forgotten|all]",
    },
    {
      name: "all",
      argumentHint: "[user|experience] [active|candidate|review|expired|forgotten|all]",
      description: "查看全部项目",
    },
    { name: "show", argumentHint: "<id>" },
    { name: "save", argumentHint: "user|experience global|project <正文>" },
    { name: "correct", argumentHint: "<id> <版本> <正文>" },
    { name: "confirm", argumentHint: "<id> <版本>" },
    { name: "forget", argumentHint: "<id> <版本> [no-send]" },
    { name: "on", description: "开启自动维护" },
    { name: "off", description: "关闭自动维护" },
    { name: "help", description: "查看维护命令" },
  ],
  helpNotes: [
    "遗忘停止采用记忆；no-send 同时要求后续模型投影排除相关原文。原始会话清理由独立功能负责。",
  ],
};

// 声明只负责发现信息；参数校验、审批与执行仍由各命令的显式分支持有。
export const COMMAND_DEFINITIONS: readonly CommandDefinition[] = [
  { name: "agents", description: "成员、Team 与任务状态" },
  {
    name: "agent",
    description: "委派与成员历史",
    subcommands: [
      { name: "spawn", argumentHint: "[--write] <任务>", description: "委派成员" },
      {
        name: "result",
        argumentHint: "<id> [offset]",
        description: "结果与完整历史",
        argumentCompletion: "member",
      },
      {
        name: "artifact",
        argumentHint: "<id> <artifactId> [cursor]",
        description: "读取成员产物",
        argumentCompletion: "member",
      },
      {
        name: "wait",
        argumentHint: "<id> [id2] [id3]",
        description: "等待成员结束",
        argumentCompletion: "member",
      },
      { name: "stop", argumentHint: "<id>", description: "停止成员", argumentCompletion: "member" },
      {
        name: "release",
        argumentHint: "<id>",
        description: "释放成员",
        argumentCompletion: "member",
      },
      {
        name: "resume",
        argumentHint: "<id> [任务]",
        description: "显式继续成员",
        argumentCompletion: "member",
      },
    ],
    helpNotes: ["可写成员从已提交版本创建；主目录未提交修改不会带入。"],
  },
  {
    name: "team",
    description: "持续团队协作",
    subcommands: [
      { name: "create", argumentHint: "<名称>" },
      { name: "add", argumentHint: "[--write] <任务>" },
      { name: "assign", argumentHint: "<id> <任务>", argumentCompletion: "member" },
      { name: "message", argumentHint: "<id> <消息>", argumentCompletion: "member" },
      { name: "tasks", description: "查看 Team 与任务状态" },
      { name: "close", description: "关闭当前 Team" },
    ],
  },
  {
    name: "git",
    description: "本地 Git 与 worktree",
    subcommands: [
      { name: "status", argumentHint: "[worktreeId]" },
      { name: "diff", argumentHint: "[worktreeId]" },
      { name: "log", argumentHint: "[worktreeId]" },
      { name: "show", argumentHint: "[ref]" },
      { name: "branches", argumentHint: "[worktreeId]" },
      { name: "worktrees", argumentHint: "[worktreeId]" },
      { name: "create", argumentHint: "[ref]" },
      { name: "inspect", argumentHint: "<id>" },
      { name: "remove", argumentHint: "<id> [discard]" },
      {
        name: "commit",
        argumentHint: '{"paths":["文件路径"],"message":"提交说明","worktreeId":"可选"}',
      },
      { name: "integrate", argumentHint: "<worktreeId> <commit>" },
      { name: "continue", description: "继续当前集成" },
      { name: "abort", description: "中止当前集成" },
    ],
  },
  { name: "help", description: "命令与快捷键" },
  { name: "new", description: "新建当前工作区的会话" },
  { name: "resume", argumentHint: "[id]", description: "列出或恢复会话" },
  memoryCommand,
  { name: "context", description: "上下文窗口和调用用量" },
  {
    name: "permissions",
    description: "查看、授予或撤销工作区授权",
    subcommands: [
      {
        name: "grant",
        argumentHint: "[--remember] [--members]",
        completionSuffixes: ["", " --remember", " --members", " --remember --members"],
      },
      {
        name: "command",
        argumentHint: "[--remember] [--members] [--prefix] [--cwd <相对目录>] -- <完整命令或前缀>",
        completionSuffixes: [" -- ", " --prefix -- "],
      },
      { name: "revoke" },
    ],
    helpNotes: [
      "工作区授权需完整浏览后输入 grant 或 cancel。",
      "--cwd 支持带引号的目录；-- 后保留命令引号。--prefix 允许入口后续任意字面参数或脚本，浏览合并范围后再确认。",
      "工作区授权及其撤销只影响 auto_allow；退出 FullAccess 请在空闲时使用 /mode 切换模式。",
    ],
  },
  { name: "approval", description: "查看当前执行确认" },
  { name: "diagnostics", description: "查看最近 Run 的安全诊断" },
  {
    name: "continue",
    argumentHint: "[补充要求]",
    description: "明确继续暂停的输入队列或上一任务",
  },
  { name: "steer", argumentHint: "<消息>", description: "在安全点优先插入当前任务" },
  { name: "followup", argumentHint: "<消息>", description: "等待当前任务完成后插入" },
  { name: "draft", description: "恢复未接受的上一份输入" },
  { name: "compact", description: "手动压缩上下文" },
  {
    name: "mode",
    description: "查看或切换权限模式",
    subcommands: [
      { name: "agent" },
      { name: "plan" },
      { name: "auto_allow" },
      { name: "full_access" },
    ],
    helpNotes: ["FullAccess 跳过人工与自动审核，可访问工作区外文件；当前没有 OS 沙箱。"],
  },
  {
    name: "skills",
    description: "外部 Skill 目录与激活状态",
    subcommands: [{ name: "reload" }, { name: "clear" }],
  },
  { name: "skill:name", argumentHint: "[任务]", description: "激活指定 Skill，可附带用户任务" },
  {
    name: "mcp",
    description: "MCP 连接与外部能力",
    subcommands: [
      { name: "connect", argumentHint: "<id>", argumentCompletion: "mcp-server" },
      { name: "disconnect", argumentHint: "<id>", argumentCompletion: "mcp-server" },
      { name: "inspect", argumentHint: "<id>", argumentCompletion: "mcp-server" },
      { name: "read", argumentHint: "<id> <uri>", argumentCompletion: "mcp-server" },
      {
        name: "prompt",
        argumentHint: '<id> <name> [{"参数名":"值"}]',
        argumentCompletion: "mcp-server",
      },
    ],
  },
  {
    name: "details",
    description: "查看命令、Reasoning 和 Tool 详情",
    subcommands: [{ name: "prev" }, { name: "next" }],
  },
  { name: "exit", description: "停止 Agent 并退出" },
];

export function commandArgumentHint(command: CommandDefinition): string {
  if (command.argumentHint !== undefined) return command.argumentHint;
  if (command.subcommands === undefined) return "";
  const names = command.subcommands.map((subcommand) => subcommand.name).join("|");
  const acceptsArguments = command.subcommands.some((subcommand) => subcommand.argumentHint);
  return `[${names}${acceptsArguments ? " ..." : ""}]`;
}

function detailedCommandHelp(command: CommandDefinition): string[] {
  return [
    ...(command.subcommands ?? []).map((subcommand) => {
      const name = subcommand.optionalName ? `[${subcommand.name}]` : subcommand.name;
      return [
        `/${command.name} ${name}`,
        subcommand.argumentHint,
        subcommand.description ? `· ${subcommand.description}` : undefined,
      ]
        .filter(Boolean)
        .join(" ");
    }),
    ...(command.helpNotes ?? []),
  ];
}

export const MEMORY_HELP = detailedCommandHelp(memoryCommand).join("\n");

export function commandHelp(): string {
  return [
    ...COMMAND_DEFINITIONS.map((command) => {
      const argumentHint = commandArgumentHint(command);
      return `/${command.name}${argumentHint ? ` ${argumentHint}` : ""}  ${command.description}`;
    }),
    "",
    ...COMMAND_DEFINITIONS.flatMap((command) => {
      const details = detailedCommandHelp(command);
      return details.length ? [...details, ""] : [];
    }),
    "Enter 提交 · Alt+Enter / Shift+Enter 换行 · Tab 补全",
    "鼠标滚轮 / 拖动右侧滑块滚动 · 点击执行过程或步骤标题展开、收起",
    "PageUp / PageDown 滚动 · Ctrl+Home / Ctrl+End 顶部/末尾",
    "Ctrl+T 详情 · Ctrl+C 停止运行，空闲时退出 · Ctrl+D 空输入时退出",
    "审批时输入 approve 或 deny；先完整浏览审批详情，再确认。/approval 返回当前审批。",
    "正文默认优先插入；/steer <消息> 优先插入，/followup <消息> 等待当前任务完成。",
    "排队输入尚未保存；停止或失败后用 /continue 恢复，关闭后不会保留。",
    "拒绝的输入可用 /draft 恢复；/continue 明确继续上一任务。",
    "// 开头会将一个 / 作为普通文本发送。",
  ].join("\n");
}
