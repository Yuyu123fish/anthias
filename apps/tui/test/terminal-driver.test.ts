import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createReadlineOutputSink,
  createTerminalDriver,
  formatVisibleInput,
  terminalTextWidth,
  wrapTerminalText,
} from "../src/terminal-driver.js";

describe("Terminal Driver", () => {
  it("wraps CJK, combining characters, and wide symbols without losing graphemes", () => {
    const source = "A你e\u0301🙂B";
    const lines = wrapTerminalText(source, 4);

    expect(lines.join("")).toBe(source);
    expect(lines.every((line) => terminalTextWidth(line) <= 4)).toBe(true);
    expect(lines.some((line) => line.includes("e\u0301"))).toBe(true);
  });

  it("expands tabs before measuring dynamic lines", () => {
    const lines = wrapTerminalText("ab\t你x", 4);

    expect(lines).toEqual(["ab  ", "你x"]);
    expect(lines.every((line) => terminalTextWidth(line) <= 4)).toBe(true);
    expect(lines.join("")).not.toContain("\t");
  });

  it("projects a long readline buffer into one bounded line without mutating its value", () => {
    const input = "前缀-long-command-组合e\u0301-尾部";
    const projection = formatVisibleInput(input, input.length, 18);

    expect(projection.line).toContain("…");
    expect(projection.line).toContain("e\u0301-尾部");
    expect(terminalTextWidth(projection.line)).toBeLessThanOrEqual(18);
    expect(input).toBe("前缀-long-command-组合e\u0301-尾部");
  });

  it("keeps both sides of a middle cursor visible with ASCII clipping markers", () => {
    const input = "prefix-left-CURSOR-right-suffix";
    const cursorIndex = input.indexOf("CURSOR") + "CURSOR".length;
    const projection = formatVisibleInput(input, cursorIndex, 22, "> ", "...");

    expect(projection.line).toMatch(/^> \.\.\..+\.\.\.$/u);
    expect(projection.line).toContain("CURSOR");
    expect(projection.cursorColumn).toBeLessThan(terminalTextWidth(projection.line));
    expect(terminalTextWidth(projection.line)).toBeLessThanOrEqual(21);
    expect(input).toBe("prefix-left-CURSOR-right-suffix");
  });

  it("swallows readline echo while proxying terminal dimensions", () => {
    const output = Object.assign(new PassThrough(), { columns: 48, rows: 20 });
    const sink = createReadlineOutputSink(output) as NodeJS.WritableStream & {
      columns: number;
      rows: number;
      isTTY: boolean;
    };
    let rendered = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      rendered += chunk;
    });

    sink.write("readline echo");

    expect(rendered).toBe("");
    expect(sink.isTTY).toBe(true);
    expect(sink.columns).toBe(48);
    expect(sink.rows).toBe(20);
  });

  it("keeps plain output free of terminal controls", () => {
    const output = new PassThrough();
    let rendered = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      rendered += chunk;
    });
    const driver = createTerminalDriver({ output, interactive: false });

    driver.writeStable("plain\n");
    driver.renderDynamic({ lines: ["ignored"], inputLineIndex: 0, inputColumn: 0 });
    driver.close();

    expect(rendered).toBe("plain\n");
    expect(rendered).not.toContain("\u001B");
  });

  it("falls back to plain output when the terminal is too narrow for safe repainting", () => {
    const output = Object.assign(new PassThrough(), { columns: 12, rows: 24 });
    let rendered = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      rendered += chunk;
    });
    const driver = createTerminalDriver({ output, interactive: true });

    driver.renderDynamic({ lines: ["ignored"], inputLineIndex: 0, inputColumn: 0 });
    driver.writeStable("narrow\n");
    driver.close();

    expect(driver.kind).toBe("plain");
    expect(rendered).toBe("narrow\n");
    expect(rendered).not.toContain("\u001B");

    const shortOutput = Object.assign(new PassThrough(), { columns: 80, rows: 10 });
    expect(createTerminalDriver({ output: shortOutput, interactive: true }).kind).toBe("plain");
  });

  it("clears and replaces only its owned interactive frame, then restores the cursor", () => {
    const output = new PassThrough() as PassThrough & { columns: number };
    output.columns = 40;
    let rendered = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      rendered += chunk;
    });
    const driver = createTerminalDriver({ output, interactive: true });

    driver.renderDynamic({
      lines: ["abcd你efgh", "abcd你efgh"],
      inputLineIndex: 1,
      inputColumn: 6,
      inputPrefix: "abcd你",
    });
    output.columns = 5;
    driver.renderDynamic({
      lines: [">"],
      inputLineIndex: 0,
      inputColumn: 1,
    });
    output.columns = 40;
    driver.renderDynamic({
      lines: ["abcd", "xy"],
      inputLineIndex: 1,
      inputColumn: 2,
      inputPrefix: "xy",
    });
    output.columns = 1;
    driver.renderDynamic({
      lines: [""],
      inputLineIndex: 0,
      inputColumn: 0,
      inputPrefix: "",
    });
    driver.writeStable("committed\n");
    driver.close();

    expect(rendered).toContain("\u001B[?25l");
    expect(rendered).toContain("\u001B[2K");
    expect(rendered).toContain("\u001B[4A");
    expect(rendered).toContain("\u001B[5A");
    expect(rendered).toContain("\u001B[2G");
    expect(rendered.endsWith("\u001B[?25h")).toBe(true);
    expect(rendered).toContain("committed\n");
  });
});
