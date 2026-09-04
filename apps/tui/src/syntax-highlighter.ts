import {
  createHighlighterCore,
  type HighlighterCore,
  type LanguageInput,
  type ThemeRegistrationRaw,
} from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import type {
  CodeHighlighter,
  HighlightedCodeLine,
  TerminalPaletteColor,
} from "./content-renderer.js";

type SupportedLanguage = Readonly<{
  grammarName: string;
  load: LanguageInput;
}>;

const ANTHIAS_THEME = {
  name: "anthias-terminal",
  type: "dark",
  fg: "#F2EDF6",
  bg: "#00000000",
  settings: [
    { settings: { foreground: "#F2EDF6" } },
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#8E8796" },
    },
    {
      scope: ["keyword", "storage", "storage.type", "keyword.control"],
      settings: { foreground: "#8B6FF2" },
    },
    {
      scope: [
        "entity.name.type",
        "entity.name.function",
        "support.type",
        "support.function",
        "meta.function-call",
      ],
      settings: { foreground: "#E85D9E" },
    },
    {
      scope: ["string", "string.quoted", "markup.inline.raw"],
      settings: { foreground: "#46BFC3" },
    },
    {
      scope: ["constant", "constant.numeric", "constant.language"],
      settings: { foreground: "#FF8066" },
    },
  ],
} satisfies ThemeRegistrationRaw;

const LANGUAGE_ALIASES = new Map<string, SupportedLanguage>([
  ["typescript", language("typescript", () => import("@shikijs/langs/typescript"))],
  ["ts", language("typescript", () => import("@shikijs/langs/typescript"))],
  ["tsx", language("tsx", () => import("@shikijs/langs/tsx"))],
  ["javascript", language("javascript", () => import("@shikijs/langs/javascript"))],
  ["js", language("javascript", () => import("@shikijs/langs/javascript"))],
  ["jsx", language("jsx", () => import("@shikijs/langs/jsx"))],
  ["json", language("json", () => import("@shikijs/langs/json"))],
  ["jsonc", language("jsonc", () => import("@shikijs/langs/jsonc"))],
  ["markdown", language("markdown", () => import("@shikijs/langs/markdown"))],
  ["md", language("markdown", () => import("@shikijs/langs/markdown"))],
  ["bash", language("shellscript", () => import("@shikijs/langs/bash"))],
  ["shell", language("shellscript", () => import("@shikijs/langs/bash"))],
  ["sh", language("shellscript", () => import("@shikijs/langs/bash"))],
  ["powershell", language("powershell", () => import("@shikijs/langs/powershell"))],
  ["ps1", language("powershell", () => import("@shikijs/langs/powershell"))],
  ["java", language("java", () => import("@shikijs/langs/java"))],
  ["python", language("python", () => import("@shikijs/langs/python"))],
  ["py", language("python", () => import("@shikijs/langs/python"))],
  ["yaml", language("yaml", () => import("@shikijs/langs/yaml"))],
  ["yml", language("yaml", () => import("@shikijs/langs/yaml"))],
  ["sql", language("sql", () => import("@shikijs/langs/sql"))],
]);

let highlighterPromise: Promise<HighlighterCore> | undefined;
const languageLoadPromises = new Map<string, Promise<void>>();

/** 按需加载 grammar，并把 Shiki token 收窄为 Anthias 自有语义色。 */
export const highlightCodeWithShiki: CodeHighlighter = async (code, languageName) => {
  const supportedLanguage = LANGUAGE_ALIASES.get(languageName.toLocaleLowerCase("en-US"));
  if (supportedLanguage === undefined) {
    return null;
  }
  const highlighter = await getHighlighter();
  await loadLanguage(highlighter, supportedLanguage);
  const tokenResult = highlighter.codeToTokens(code, {
    lang: supportedLanguage.grammarName,
    theme: ANTHIAS_THEME.name,
  });
  return Object.freeze(
    tokenResult.tokens.map(
      (line) =>
        Object.freeze(
          line.map((token) => {
            const color = toTerminalPaletteColor(token.color);
            return Object.freeze({
              text: token.content,
              color,
              dim: color === "reefSlate",
            });
          }),
        ) as HighlightedCodeLine,
    ),
  );
};

function language(grammarName: string, load: LanguageInput): SupportedLanguage {
  return Object.freeze({ grammarName, load });
}

/** 一个进程只创建一个 highlighter；创建失败时允许后续渲染重新尝试。 */
function getHighlighter(): Promise<HighlighterCore> {
  if (highlighterPromise === undefined) {
    highlighterPromise = createHighlighterCore({
      engine: createJavaScriptRegexEngine(),
      themes: [ANTHIAS_THEME],
      langs: [],
      warnings: false,
    }).catch((error: unknown) => {
      highlighterPromise = undefined;
      throw error;
    });
  }
  return highlighterPromise;
}

/** 同一 grammar 的并发加载共用 Promise，失败不会污染后续重试。 */
async function loadLanguage(
  highlighter: HighlighterCore,
  supportedLanguage: SupportedLanguage,
): Promise<void> {
  let loadPromise = languageLoadPromises.get(supportedLanguage.grammarName);
  if (loadPromise === undefined) {
    loadPromise = highlighter
      .loadLanguage(supportedLanguage.load)
      .then(() => undefined)
      .catch((error: unknown) => {
        languageLoadPromises.delete(supportedLanguage.grammarName);
        throw error;
      });
    languageLoadPromises.set(supportedLanguage.grammarName, loadPromise);
  }
  await loadPromise;
}

function toTerminalPaletteColor(color: string | undefined): TerminalPaletteColor | null {
  switch (color?.toLocaleUpperCase("en-US")) {
    case "#8B6FF2":
      return "finViolet";
    case "#E85D9E":
      return "reefRose";
    case "#46BFC3":
      return "lagoon";
    case "#FF8066":
      return "anthiasCoral";
    case "#8E8796":
      return "reefSlate";
    default:
      return null;
  }
}
