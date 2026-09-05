import { type Terminal, visibleWidth } from "@earendil-works/pi-tui";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { vi } from "vitest";

export function createTestTerminal(columns = 100, rows = 28) {
  const screen = new HeadlessTerminal({ cols: columns, rows, allowProposedApi: true });
  const writes: string[] = [];
  let inputListener = (_data: string) => {};
  let resizeListener = () => {};
  const write = (data: string) => {
    writes.push(data);
    screen.write(data);
  };
  const terminal: Terminal = {
    get columns() {
      return columns;
    },
    get rows() {
      return rows;
    },
    kittyProtocolActive: false,
    start(onInput, onResize) {
      inputListener = onInput;
      resizeListener = onResize;
    },
    stop: vi.fn(),
    drainInput: vi.fn(async () => {}),
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
  return {
    terminal,
    writes,
    screen,
    send(data: string) {
      inputListener(data);
    },
    mouse(button: number, x: number, y: number, release = false) {
      inputListener(`\u001b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`);
    },
    locate(text: string) {
      for (let row = 0; row < rows; row += 1) {
        const line = screen.buffer.active.getLine(row)?.translateToString(true) ?? "";
        const index = line.indexOf(text);
        if (index >= 0) return { x: visibleWidth(line.slice(0, index)), y: row };
      }
      throw new Error(`Text is not visible: ${text}`);
    },
    resize(width: number, height: number) {
      columns = width;
      rows = height;
      screen.resize(width, height);
      resizeListener();
    },
    async flush() {
      await new Promise<void>((resolve) => screen.write("", resolve));
    },
    text() {
      return Array.from(
        { length: rows },
        (_, row) =>
          screen.buffer.active
            .getLine(screen.buffer.active.viewportY + row)
            ?.translateToString(true) ?? "",
      ).join("\n");
    },
    dispose() {
      screen.dispose();
    },
  };
}
