import type { EditorTheme, MarkdownTheme } from "@earendil-works/pi-tui";
import {
  styleTerminalFragment,
  type TerminalCapabilities,
  type TerminalPaletteColor,
} from "./content-renderer.js";

/** 固定界面和内容共用语义色；不依赖终端默认背景。 */
export function createTheme(capabilities: TerminalCapabilities) {
  const color = (name: TerminalPaletteColor) => (text: string) =>
    styleTerminalFragment(text, name, capabilities);
  const emphasis = (code: number) => (text: string) =>
    capabilities.colorDepth === "none" ? text : `\u001b[${code}m${text}\u001b[0m`;
  const coral = color("anthiasCoral");
  const muted = color("reefSlate");
  const lagoon = color("lagoon");
  const editor: EditorTheme = {
    borderColor: coral,
    selectList: {
      selectedPrefix: coral,
      selectedText: coral,
      description: muted,
      scrollInfo: muted,
      noMatch: muted,
    },
  };
  const markdown: MarkdownTheme = {
    heading: coral,
    link: lagoon,
    linkUrl: muted,
    code: lagoon,
    codeBlock: (text) => text,
    codeBlockBorder: muted,
    quote: muted,
    quoteBorder: color("finViolet"),
    hr: muted,
    listBullet: coral,
    bold: emphasis(1),
    italic: emphasis(3),
    strikethrough: emphasis(9),
    underline: emphasis(4),
  };
  const scrollbar = (_text: string) => coral(capabilities.unicode ? "┃" : "#");
  return { coral, muted, lagoon, scrollbar, editor, markdown };
}
