import { OPENAI_API_KEY } from "$env/static/private";
import { createOpenAI } from "@ai-sdk/openai";
import type { Message } from "@mariozechner/pi-ai";
import { generateText, Output } from "ai";
import type { StoredAgentThreadMessage } from "$lib/types/agent";
import { Cause, Effect, Exit } from "effect";
import { z } from "zod";
import type { ConvexError } from "./convex";

const THREAD_TITLE_MODEL_ID = "galapagos-nano-alpha";

const threadTitleOpenAI = createOpenAI({
  apiKey: OPENAI_API_KEY,
});

const threadTitleSchema = z.object({
  title: z.string().min(1).describe("A concise thread title between four and six words long."),
});

export const normalizeWhitespace = (value: string) => value.replace(/\s+/g, " ").trim();

export const getPromptPreview = (prompt: string) => normalizeWhitespace(prompt).slice(0, 120);

const sentenceCase = (value: string) =>
  value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`;

const stripTitleFormatting = (value: string) =>
  normalizeWhitespace(value.replace(/^["'`]+|["'`]+$/g, "").replace(/[.!?,:;]+$/g, ""));

const splitIntoWords = (value: string) => stripTitleFormatting(value).split(/\s+/u).filter(Boolean);

const fallbackThreadTitle = (prompt: string) => {
  const words = normalizeWhitespace(prompt)
    .replace(/[^\p{L}\p{N}\s'-]+/gu, " ")
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 6);

  for (const filler of ["thread", "discussion", "details", "today"]) {
    if (words.length >= 4) {
      break;
    }

    words.push(filler);
  }

  return sentenceCase(words.join(" "));
};

const coerceThreadTitle = (title: string, prompt: string) => {
  const normalizedTitle = stripTitleFormatting(title);
  const wordCount = splitIntoWords(normalizedTitle).length;

  return wordCount >= 4 && wordCount <= 6
    ? sentenceCase(normalizedTitle)
    : fallbackThreadTitle(prompt);
};

const extractMessageTextContent = (content: Message["content"]) => {
  if (typeof content === "string") {
    return normalizeWhitespace(content);
  }

  return normalizeWhitespace(
    content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n"),
  );
};

export const getThreadTitleSourcePrompt = (persistedMessages: Message[], prompt: string) => {
  const originalUserMessage = persistedMessages.find((message) => message.role === "user");
  const originalPrompt =
    originalUserMessage === undefined
      ? null
      : extractMessageTextContent(originalUserMessage.content);

  return originalPrompt && originalPrompt.length > 0 ? originalPrompt : normalizeWhitespace(prompt);
};

export const getThreadTitleSourcePromptFromStored = (
  messages: readonly StoredAgentThreadMessage[],
  fallbackPrompt: string,
): string => {
  for (const m of messages) {
    if (m.role !== "user") {
      continue;
    }

    try {
      const parsed = JSON.parse(m.rawJson) as {
        role?: string;
        content?: unknown;
      };

      if (parsed.role !== "user") {
        continue;
      }

      if (typeof parsed.content === "string" && parsed.content.trim().length > 0) {
        return normalizeWhitespace(parsed.content);
      }

      if (Array.isArray(parsed.content)) {
        const text = parsed.content
          .flatMap((part) => {
            if (
              typeof part === "object" &&
              part !== null &&
              "type" in part &&
              part.type === "text" &&
              "text" in part &&
              typeof part.text === "string"
            ) {
              return [part.text];
            }

            return [];
          })
          .join("\n\n");

        if (text.trim().length > 0) {
          return normalizeWhitespace(text);
        }
      }
    } catch {
      continue;
    }
  }

  return normalizeWhitespace(fallbackPrompt);
};

export const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const generateThreadTitle = (
  threadId: string,
  prompt: string,
): Effect.Effect<string, never> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () =>
        generateText({
          model: threadTitleOpenAI(THREAD_TITLE_MODEL_ID),
          output: Output.object({
            schema: threadTitleSchema,
            name: "thread_title",
            description: "A thread title that is between four and six words long.",
          }),
          system:
            "You write concise thread titles. Return a title between four and six words long, with no surrounding quotes.",
          prompt: `Write a title for this original user prompt:\n\n${prompt}`,
          maxOutputTokens: 32,
          temperature: 0,
        }),
      catch: (cause) => cause,
    });

    return coerceThreadTitle(result.output.title, prompt);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        console.warn("Failed to generate thread title, using prompt fallback", {
          threadId,
          error: getErrorMessage(Cause.squash(cause)),
        });

        return fallbackThreadTitle(prompt);
      }),
    ),
  );

export const persistGeneratedThreadTitle = ({
  setThreadTitle,
  threadId,
  title,
}: {
  setThreadTitle: (title: string) => Effect.Effect<unknown, ConvexError>;
  threadId: string;
  title: string;
}) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const exit = yield* Effect.exit(setThreadTitle(title));

      if (Exit.isSuccess(exit)) {
        yield* Effect.sync(() => {
          console.log("Thread title persisted in background", { threadId });
        });
        return;
      }

      const error = Cause.findErrorOption(exit.cause);
      if (error._tag === "Some" && getErrorMessage(error.value).includes("Thread not found.")) {
        yield* Effect.sleep(500);
        continue;
      }

      return yield* Effect.failCause(exit.cause);
    }

    yield* Effect.sync(() => {
      console.warn("Timed out waiting to persist thread title in background", {
        threadId,
      });
    });
  });
