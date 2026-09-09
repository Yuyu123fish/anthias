/** handled 表示输入已处理，不保证业务操作成功，也不触发重投。 */
export type CommandResult =
  | Readonly<{ kind: "handled" }>
  | Readonly<{ kind: "rejected" }>
  | Readonly<{ kind: "prompt"; text: string }>;
