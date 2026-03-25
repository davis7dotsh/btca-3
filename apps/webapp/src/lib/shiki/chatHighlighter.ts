import { createHighlighter, type Highlighter } from "shiki";

let highlighterPromise: Promise<Highlighter> | null = null;
let highlighterInstance: Highlighter | null = null;
let generation = 0;

const LOADED_LANGS = new Set([
  "bash",
  "css",
  "diff",
  "dotenv",
  "html",
  "javascript",
  "json",
  "markdown",
  "python",
  "shell",
  "sql",
  "svelte",
  "text",
  "tsx",
  "typescript",
  "xml",
  "yaml",
]);

export const isLoadedLang = (lang: string) => LOADED_LANGS.has(lang);

export const getChatHighlighter = () => {
  if (!highlighterPromise) {
    generation += 1;
    const current = generation;

    highlighterPromise = createHighlighter({
      themes: ["light-plus", "dark-plus"],
      langs: [...LOADED_LANGS],
    }).then((highlighter) => {
      if (current !== generation) {
        highlighter.dispose();
        return highlighter;
      }

      highlighterInstance = highlighter;
      return highlighter;
    });
  }

  return highlighterPromise;
};

export const disposeChatHighlighter = () => {
  if (!highlighterPromise && !highlighterInstance) {
    return;
  }

  generation += 1;
  highlighterInstance?.dispose();
  highlighterInstance = null;
  highlighterPromise = null;
};
