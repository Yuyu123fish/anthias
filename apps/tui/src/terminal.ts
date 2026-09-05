import type { Terminal } from "@earendil-works/pi-tui";
import { ProcessTerminal, StdinBuffer } from "@earendil-works/pi-tui";

/** 生产使用 pi 的平台输入处理；可注入流供嵌入宿主和确定性终端验证。 */
export function createTerminal(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Terminal {
  if (input === process.stdin && output === process.stdout) return new ProcessTerminal();
  const terminalInput = input as NodeJS.ReadableStream & {
    isRaw?: boolean;
    setRawMode?(enabled: boolean): void;
  };
  const terminalOutput = output as NodeJS.WritableStream & { columns?: number; rows?: number };
  const buffer = new StdinBuffer();
  const wasRaw = terminalInput.isRaw ?? false;
  let resizeListener: (() => void) | undefined;
  const dataListener = (data: string | Buffer) => buffer.process(data);
  const write = (data: string) => {
    output.write(data);
  };
  return {
    get columns() {
      return Math.max(1, terminalOutput.columns ?? 80);
    },
    get rows() {
      return Math.max(1, terminalOutput.rows ?? 24);
    },
    get kittyProtocolActive() {
      return false;
    },
    start(onInput, onResize) {
      resizeListener = onResize;
      buffer.on("data", onInput);
      buffer.on("paste", (text) => onInput(`\u001b[200~${text}\u001b[201~`));
      terminalInput.setRawMode?.(true);
      input.on("data", dataListener);
      output.on("resize", onResize);
      input.resume();
      write("\u001b[?2004h");
    },
    stop() {
      input.off("data", dataListener);
      if (resizeListener !== undefined) output.off("resize", resizeListener);
      buffer.destroy();
      terminalInput.setRawMode?.(wasRaw);
      input.pause();
      write("\u001b[?2004l");
    },
    async drainInput() {},
    write,
    moveBy(lines) {
      if (lines) write(`\u001b[${Math.abs(lines)}${lines > 0 ? "B" : "A"}`);
    },
    hideCursor() {
      write("\u001b[?25l");
    },
    showCursor() {
      write("\u001b[?25h");
    },
    clearLine() {
      write("\u001b[2K");
    },
    clearFromCursor() {
      write("\u001b[0J");
    },
    clearScreen() {
      write("\u001b[2J\u001b[H");
    },
    setTitle() {},
    setProgress() {},
  };
}
