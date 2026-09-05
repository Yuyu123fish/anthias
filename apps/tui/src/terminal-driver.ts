import { Writable } from "node:stream";
import stringWidth from "string-width";
import { sanitizeTerminalText } from "./content-renderer.js";

export type DynamicTerminalFrame = Readonly<{
  lines: readonly string[];
  inputLineIndex: number;
  inputColumn: number;
  inputPrefix?: string;
  compact?: boolean;
}>;

export type TerminalDriver = Readonly<{
  kind: "interactive" | "plain";
  width(): number;
  height(): number;
  writeStable(text: string): void;
  renderDynamic(frame: DynamicTerminalFrame): void;
  clearDynamic(): void;
  close(): void;
}>;

export type CreateTerminalDriverOptions = Readonly<{
  output: NodeJS.WritableStream;
  interactive: boolean;
}>;

const MINIMUM_TERMINAL_WIDTH = 20;
const MINIMUM_TERMINAL_HEIGHT = 12;
const DEFAULT_TERMINAL_WIDTH = 80;
const DEFAULT_TERMINAL_HEIGHT = 24;
const TERMINAL_TAB_WIDTH = 4;
const ESCAPE = "\u001B";
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 判断当前物理尺寸能否安全容纳完整 interactive frame。 */
export function supportsInteractiveTerminalSize(width: number, height: number): boolean {
  return width >= MINIMUM_TERMINAL_WIDTH && height >= MINIMUM_TERMINAL_HEIGHT;
}

/** readline 仍持有输入编辑状态，但其内部回显不得与 TerminalDriver 争抢 stdout。 */
export function createReadlineOutputSink(output: NodeJS.WritableStream): NodeJS.WritableStream {
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const terminalOutput = output as NodeJS.WritableStream & { columns?: number; rows?: number };
  Object.defineProperties(sink, {
    isTTY: { value: true },
    columns: { get: () => terminalOutput.columns ?? DEFAULT_TERMINAL_WIDTH },
    rows: { get: () => terminalOutput.rows },
  });
  return sink;
}

/** interactive driver 只替换当前动态区；plain driver 永远只做确定性追加。 */
export function createTerminalDriver({
  output,
  interactive,
}: CreateTerminalDriverOptions): TerminalDriver {
  // 极窄终端无法可靠容纳输入与光标余量，退回只追加模式以避免物理换行破坏清屏计数。
  if (
    !interactive ||
    !supportsInteractiveTerminalSize(
      readReportedTerminalWidth(output),
      readReportedTerminalHeight(output),
    )
  ) {
    return Object.freeze({
      kind: "plain" as const,
      width: () => readTerminalWidth(output),
      height: () => readTerminalHeight(output),
      writeStable: (text: string) => {
        output.write(text);
      },
      renderDynamic: () => undefined,
      clearDynamic: () => undefined,
      close: () => undefined,
    });
  }

  let currentFrame: DynamicTerminalFrame | null = null;

  const clearDynamic = () => {
    if (currentFrame === null || currentFrame.lines.length === 0) {
      currentFrame = null;
      return;
    }
    const physicalLayout = measurePhysicalFrame(currentFrame, readReportedTerminalWidth(output));
    output.write(`${ESCAPE}[?25l`);
    if (physicalLayout.rowsAboveCursor > 0) {
      output.write(`${ESCAPE}[${physicalLayout.rowsAboveCursor}A`);
    }
    output.write("\r");
    for (let rowIndex = 0; rowIndex < physicalLayout.totalRows; rowIndex += 1) {
      output.write(`${ESCAPE}[2K`);
      if (rowIndex < physicalLayout.totalRows - 1) {
        output.write(`${ESCAPE}[1B\r`);
      }
    }
    if (physicalLayout.totalRows > 1) {
      output.write(`${ESCAPE}[${physicalLayout.totalRows - 1}A`);
    }
    output.write("\r");
    currentFrame = null;
  };

  return Object.freeze({
    kind: "interactive" as const,
    width: () => readTerminalWidth(output),
    height: () => readTerminalHeight(output),
    writeStable(text) {
      clearDynamic();
      output.write(text);
      if (!text.endsWith("\n")) {
        output.write("\n");
      }
    },
    renderDynamic(frame) {
      clearDynamic();
      if (frame.lines.length === 0) {
        output.write(`${ESCAPE}[?25h`);
        return;
      }
      output.write(frame.lines.join("\n"));
      const linesBelowInput = frame.lines.length - frame.inputLineIndex - 1;
      if (linesBelowInput > 0) {
        output.write(`${ESCAPE}[${linesBelowInput}A`);
      }
      output.write(`${ESCAPE}[${Math.max(1, frame.inputColumn + 1)}G`);
      output.write(`${ESCAPE}[?25h`);
      currentFrame = frame;
    },
    clearDynamic,
    close() {
      clearDynamic();
      output.write(`${ESCAPE}[?25h`);
    },
  });
}

/**
 * resize 会让旧逻辑行在物理终端中重新换行。清除前必须按当前列宽重算，
 * 否则会把残行留在动态区，或把光标移进稳定 scrollback。
 */
function measurePhysicalFrame(
  frame: DynamicTerminalFrame,
  terminalWidth: number,
): Readonly<{ rowsAboveCursor: number; totalRows: number }> {
  const safeWidth = Math.max(1, terminalWidth);
  const rowsByLine = frame.lines.map((line) => measureWrappedRows(line, safeWidth));
  const inputLineIndex = Math.max(0, Math.min(frame.inputLineIndex, frame.lines.length - 1));
  const rowsBeforeInput = rowsByLine
    .slice(0, inputLineIndex)
    .reduce((total, rows) => total + rows, 0);
  const inputRows = rowsByLine[inputLineIndex] ?? 1;
  const cursorRowWithinInput =
    frame.inputPrefix === undefined
      ? frame.inputColumn === 0
        ? 0
        : Math.min(inputRows - 1, Math.floor((frame.inputColumn - 1) / safeWidth))
      : Math.min(inputRows - 1, measureWrappedRows(frame.inputPrefix, safeWidth) - 1);
  return Object.freeze({
    rowsAboveCursor: rowsBeforeInput + cursorRowWithinInput,
    totalRows: rowsByLine.reduce((total, rows) => total + rows, 0),
  });
}

function measureWrappedRows(line: string, terminalWidth: number): number {
  const visibleLine = stripOwnedTerminalSequences(line);
  if (terminalWidth <= 1) {
    // 单列终端无法使用正常布局的两列下限；每个可见 cell 都会占一行。
    return Math.max(1, stringWidth(expandTerminalTabs(sanitizeTerminalText(visibleLine))));
  }
  return Math.max(1, wrapTerminalText(visibleLine, terminalWidth).length);
}

/**
 * 动态 frame 的控制序列只由 Terminal Driver 上游 renderer 生成。测宽时移除 CSI / OSC，
 * 但不改变真正写出的文本，模型内容仍在更早的安全边界清理。
 */
function stripOwnedTerminalSequences(value: string): string {
  let visibleText = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== ESCAPE) {
      visibleText += value[index] ?? "";
      continue;
    }
    const sequenceType = value[index + 1];
    if (sequenceType === "[") {
      index += 1;
      while (index + 1 < value.length) {
        index += 1;
        const codeUnit = value.charCodeAt(index);
        if (codeUnit >= 0x40 && codeUnit <= 0x7e) {
          break;
        }
      }
      continue;
    }
    if (sequenceType === "]") {
      index += 1;
      while (index + 1 < value.length) {
        index += 1;
        if (value.charCodeAt(index) === 0x07) {
          break;
        }
        if (value[index] === ESCAPE && value[index + 1] === "\\") {
          index += 1;
          break;
        }
      }
    }
  }
  return visibleText;
}

/** 按 grapheme 与真实终端列宽换行，既不拆组合字符，也不丢失长路径内容。 */
export function wrapTerminalText(text: string, width: number): readonly string[] {
  const safeWidth = Math.max(2, width);
  const logicalLines = sanitizeTerminalText(text).split("\n");
  const wrappedLines: string[] = [];
  for (const logicalLine of logicalLines) {
    if (logicalLine.length === 0) {
      wrappedLines.push("");
      continue;
    }
    let currentLine = "";
    let currentWidth = 0;
    for (const { segment } of graphemeSegmenter.segment(logicalLine)) {
      if (segment === "\t") {
        let remainingSpaces = TERMINAL_TAB_WIDTH - (currentWidth % TERMINAL_TAB_WIDTH);
        while (remainingSpaces > 0) {
          if (currentWidth === safeWidth) {
            wrappedLines.push(currentLine);
            currentLine = "";
            currentWidth = 0;
          }
          const spacesOnCurrentLine = Math.min(remainingSpaces, safeWidth - currentWidth);
          currentLine += " ".repeat(spacesOnCurrentLine);
          currentWidth += spacesOnCurrentLine;
          remainingSpaces -= spacesOnCurrentLine;
        }
        continue;
      }
      const segmentWidth = Math.max(0, stringWidth(segment));
      if (currentLine.length > 0 && currentWidth + segmentWidth > safeWidth) {
        wrappedLines.push(currentLine);
        currentLine = "";
        currentWidth = 0;
      }
      currentLine += segment;
      currentWidth += segmentWidth;
    }
    wrappedLines.push(currentLine);
  }
  return Object.freeze(wrappedLines);
}

/** 把 readline 的真实缓冲投影为单个可见输入行，底层输入内容不被截断。 */
export function formatVisibleInput(
  input: string,
  cursorIndex: number,
  width: number,
  prompt = "> ",
  truncationMarker = "…",
): Readonly<{ line: string; cursorColumn: number; cursorPrefix: string }> {
  const safeCursorIndex = Math.max(0, Math.min(cursorIndex, input.length));
  const beforeCursor = expandTerminalTabs(sanitizeTerminalText(input.slice(0, safeCursorIndex)));
  const afterCursor = expandTerminalTabs(
    sanitizeTerminalText(input.slice(safeCursorIndex)),
    stringWidth(beforeCursor),
  );
  const safeInput = `${beforeCursor}${afterCursor}`;
  const promptWidth = stringWidth(prompt);
  // 预留一列给下一次按键回显，避免 readline 在重绘前先触发物理换行。
  const availableWidth = Math.max(1, width - promptWidth - 1);
  if (stringWidth(safeInput) <= availableWidth) {
    return Object.freeze({
      line: `${prompt}${safeInput}`,
      cursorColumn: promptWidth + stringWidth(beforeCursor),
      cursorPrefix: `${prompt}${beforeCursor}`,
    });
  }

  const marker = stringWidth(truncationMarker) <= availableWidth ? truncationMarker : ".";
  const markerWidth = stringWidth(marker);
  let leadingMarkerRequired = beforeCursor.length > 0;
  let trailingMarkerRequired = afterCursor.length > 0;
  let visibleBeforeCursor = "";
  let visibleAfterCursor = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const contentWidth = Math.max(
      1,
      availableWidth -
        (leadingMarkerRequired ? markerWidth : 0) -
        (trailingMarkerRequired ? markerWidth : 0),
    );
    const budgets = allocateInputViewport(
      stringWidth(beforeCursor),
      stringWidth(afterCursor),
      contentWidth,
    );
    visibleBeforeCursor = takeTerminalTail(beforeCursor, budgets.before);
    visibleAfterCursor = takeTerminalHead(afterCursor, budgets.after);
    const nextLeadingMarkerRequired = visibleBeforeCursor.length < beforeCursor.length;
    const nextTrailingMarkerRequired = visibleAfterCursor.length < afterCursor.length;
    if (
      nextLeadingMarkerRequired === leadingMarkerRequired &&
      nextTrailingMarkerRequired === trailingMarkerRequired
    ) {
      break;
    }
    leadingMarkerRequired = nextLeadingMarkerRequired;
    trailingMarkerRequired = nextTrailingMarkerRequired;
  }
  const leadingMarker = leadingMarkerRequired ? marker : "";
  const trailingMarker = trailingMarkerRequired ? marker : "";
  const visibleInput = `${leadingMarker}${visibleBeforeCursor}${visibleAfterCursor}${trailingMarker}`;
  return Object.freeze({
    line: `${prompt}${visibleInput}`,
    cursorColumn: promptWidth + stringWidth(leadingMarker) + stringWidth(visibleBeforeCursor),
    cursorPrefix: `${prompt}${leadingMarker}${visibleBeforeCursor}`,
  });
}

export function terminalTextWidth(text: string): number {
  return stringWidth(text);
}

function takeTerminalTail(text: string, maximumWidth: number): string {
  const segments = [...graphemeSegmenter.segment(text)].map(({ segment }) => segment);
  let selected = "";
  let selectedWidth = 0;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment === undefined) {
      continue;
    }
    const segmentWidth = Math.max(0, stringWidth(segment));
    if (selected.length > 0 && selectedWidth + segmentWidth > maximumWidth) {
      break;
    }
    selected = `${segment}${selected}`;
    selectedWidth += segmentWidth;
  }
  return selected;
}

function takeTerminalHead(text: string, maximumWidth: number): string {
  let selected = "";
  let selectedWidth = 0;
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const segmentWidth = Math.max(0, stringWidth(segment));
    if (selected.length > 0 && selectedWidth + segmentWidth > maximumWidth) {
      break;
    }
    selected += segment;
    selectedWidth += segmentWidth;
  }
  return selected;
}

function allocateInputViewport(
  beforeWidth: number,
  afterWidth: number,
  availableWidth: number,
): Readonly<{ before: number; after: number }> {
  let before = Math.min(beforeWidth, Math.ceil((availableWidth * 2) / 3));
  let after = Math.min(afterWidth, availableWidth - before);
  const unusedAfter = availableWidth - before - after;
  before = Math.min(beforeWidth, before + unusedAfter);
  after = Math.min(afterWidth, availableWidth - before);
  return Object.freeze({ before, after });
}

function expandTerminalTabs(text: string, initialColumn = 0): string {
  let currentColumn = initialColumn;
  let expanded = "";
  for (const { segment } of graphemeSegmenter.segment(text)) {
    if (segment === "\t") {
      const spaces = TERMINAL_TAB_WIDTH - (currentColumn % TERMINAL_TAB_WIDTH);
      expanded += " ".repeat(spaces);
      currentColumn += spaces;
    } else {
      expanded += segment;
      currentColumn += Math.max(0, stringWidth(segment));
    }
  }
  return expanded;
}

function readTerminalWidth(output: NodeJS.WritableStream): number {
  return readReportedTerminalWidth(output);
}

function readTerminalHeight(output: NodeJS.WritableStream): number {
  return readReportedTerminalHeight(output);
}

function readReportedTerminalWidth(output: NodeJS.WritableStream): number {
  const columns = (output as NodeJS.WritableStream & { columns?: number }).columns;
  return Number.isSafeInteger(columns) && (columns ?? 0) > 0
    ? (columns ?? DEFAULT_TERMINAL_WIDTH)
    : DEFAULT_TERMINAL_WIDTH;
}

function readReportedTerminalHeight(output: NodeJS.WritableStream): number {
  const rows = (output as NodeJS.WritableStream & { rows?: number }).rows;
  return Number.isSafeInteger(rows) && (rows ?? 0) > 0
    ? (rows ?? DEFAULT_TERMINAL_HEIGHT)
    : DEFAULT_TERMINAL_HEIGHT;
}
