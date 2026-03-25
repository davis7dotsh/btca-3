import { randomUUID } from "node:crypto";
import { env } from "$env/dynamic/private";
import Exa from "exa-js";
import { Data, Effect, Layer, ServiceMap } from "effect";

type ExaOperation = "getClient" | "searchWeb" | "getWebContent";

export const EXA_DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";
export const WEB_CONTENT_DEFAULT_MAX_CHARACTERS = 4_000;
export const WEB_CONTENT_MAX_CHARACTERS = 6_000;

const WEB_CONTENT_HIGHLIGHT_MAX_CHARACTERS = 700;
const WEB_CONTENT_SUMMARY_MAX_CHARACTERS = 1_500;
const WEB_CONTENT_HIGHLIGHT_ITEM_MAX_CHARACTERS = 500;
const WEB_CONTENT_MAX_HIGHLIGHTS = 5;

export class ExaServiceError extends Data.TaggedError("ExaServiceError")<{
  readonly message: string;
  readonly kind: string;
  readonly traceId: string;
  readonly timestamp: number;
  readonly operation: ExaOperation;
  readonly cause?: unknown;
}> {}

export interface ExaSearchWebInput {
  readonly query: string;
  readonly numResults?: number;
  readonly includeDomains?: readonly string[];
  readonly excludeDomains?: readonly string[];
  readonly startPublishedDate?: string;
  readonly endPublishedDate?: string;
}

export interface ExaSearchWebResultItem {
  readonly title: string;
  readonly url: string;
  readonly publishedDate: string | null;
  readonly author: string | null;
  readonly score: number | null;
}

export interface ExaSearchWebResult {
  readonly query: string;
  readonly results: readonly ExaSearchWebResultItem[];
  readonly count: number;
}

export interface ExaGetWebContentInput {
  readonly urls: readonly string[];
  readonly maxCharacters?: number;
  readonly summary?: boolean;
  readonly highlightsQuery?: string;
  readonly maxAgeHours?: number;
}

export interface ExaGetWebContentResultItem {
  readonly title: string;
  readonly url: string;
  readonly publishedDate: string | null;
  readonly author: string | null;
  readonly text: string | null;
  readonly summary: string | null;
  readonly highlights: readonly string[];
}

export interface ExaGetWebContentResult {
  readonly urls: readonly string[];
  readonly results: readonly ExaGetWebContentResultItem[];
  readonly count: number;
}

export interface ExaDef {
  getClient: () => Effect.Effect<Exa, ExaServiceError>;
  searchWeb: (input: ExaSearchWebInput) => Effect.Effect<ExaSearchWebResult, ExaServiceError>;
  getWebContent: (
    input: ExaGetWebContentInput,
  ) => Effect.Effect<ExaGetWebContentResult, ExaServiceError>;
}

const getRequiredValue = (value: string | undefined, key: string) => {
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }

  return value;
};

const createExaServiceError = ({
  message,
  kind,
  operation,
  cause,
}: {
  message: string;
  kind: string;
  operation: ExaOperation;
  cause?: unknown;
}) =>
  new ExaServiceError({
    message,
    kind,
    traceId: randomUUID(),
    timestamp: Date.now(),
    operation,
    cause,
  });

const toExaServiceError = ({
  cause,
  operation,
  message,
  kind,
}: {
  cause: unknown;
  operation: ExaOperation;
  message: string;
  kind: string;
}) =>
  cause instanceof ExaServiceError
    ? cause
    : createExaServiceError({
        message: cause instanceof Error ? cause.message : message,
        kind,
        operation,
        cause,
      });

const dedupeTrimmed = (items: readonly string[]) =>
  Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)));

const trimTo = (value: string | null | undefined, maxCharacters: number) => {
  if (!value) {
    return null;
  }

  return value.length <= maxCharacters ? value : `${value.slice(0, maxCharacters)}...`;
};

const trimStringArray = (
  values: readonly string[] | null | undefined,
  maxItems: number,
  maxCharacters: number,
) => (values ?? []).slice(0, maxItems).map((value) => trimTo(value, maxCharacters) ?? "");

const parseHttpUrl = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const parsed = new URL(withProtocol);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return null;
    }

    parsed.hash = "";
    if (parsed.pathname !== "/") {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }
    return parsed;
  } catch {
    return null;
  }
};

const normalizeUrl = (value: string) => {
  const parsed = parseHttpUrl(value);
  if (!parsed) {
    return null;
  }

  return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
};

const getOptionalStringProperty = <Key extends string>(
  value: Record<string, unknown>,
  key: Key,
) => {
  const property = value[key];
  return typeof property === "string" ? property : null;
};

const getOptionalStringArrayProperty = <Key extends string>(
  value: Record<string, unknown>,
  key: Key,
) => {
  const property = value[key];
  return Array.isArray(property)
    ? property.filter((item): item is string => typeof item === "string")
    : [];
};

const normalizeUrls = (urls: readonly string[]) =>
  dedupeTrimmed(urls)
    .map((value) => normalizeUrl(value))
    .filter((value): value is string => Boolean(value));

export class ExaService extends ServiceMap.Service<ExaService, ExaDef>()("ExaService") {
  static readonly layer = Layer.sync(ExaService, () => {
    const client = new Exa(getRequiredValue(env.EXA_API_KEY, "EXA_API_KEY"));

    const getClient = () => Effect.succeed(client);

    const searchWeb: ExaDef["searchWeb"] = (input) =>
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: () =>
            client.search(input.query, {
              type: "auto",
              numResults: input.numResults ?? 5,
              contents: false,
              includeDomains: input.includeDomains?.length ? [...input.includeDomains] : undefined,
              excludeDomains: input.excludeDomains?.length ? [...input.excludeDomains] : undefined,
              ...(input.startPublishedDate ? { startPublishedDate: input.startPublishedDate } : {}),
              ...(input.endPublishedDate ? { endPublishedDate: input.endPublishedDate } : {}),
            }),
          catch: (cause) =>
            toExaServiceError({
              cause,
              operation: "searchWeb",
              message: "Failed to search the web with Exa.",
              kind: "exa_search_web_error",
            }),
        });

        const results = response.results.map((result) => ({
          title: result.title ?? result.url,
          url: result.url,
          publishedDate: result.publishedDate ?? null,
          author: result.author ?? null,
          score: result.score ?? null,
        }));

        return {
          query: input.query,
          results,
          count: results.length,
        };
      });

    const getWebContent: ExaDef["getWebContent"] = (input) =>
      Effect.gen(function* () {
        const urls = yield* Effect.try({
          try: () => {
            const normalizedUrls = normalizeUrls(input.urls);

            if (normalizedUrls.length === 0) {
              throw createExaServiceError({
                message: "No valid URLs provided.",
                kind: "exa_invalid_url_input",
                operation: "getWebContent",
              });
            }

            return normalizedUrls;
          },
          catch: (cause) =>
            toExaServiceError({
              cause,
              operation: "getWebContent",
              message: "Failed to normalize URLs for Exa web content retrieval.",
              kind: "exa_get_web_content_error",
            }),
        });
        const maxCharacters = Math.min(
          input.maxCharacters ?? WEB_CONTENT_DEFAULT_MAX_CHARACTERS,
          WEB_CONTENT_MAX_CHARACTERS,
        );
        const response = yield* Effect.tryPromise({
          try: () =>
            client.getContents(urls, {
              text: { maxCharacters },
              summary: input.summary ? true : undefined,
              highlights: input.highlightsQuery
                ? {
                    query: input.highlightsQuery,
                    maxCharacters: WEB_CONTENT_HIGHLIGHT_MAX_CHARACTERS,
                  }
                : undefined,
              maxAgeHours: input.maxAgeHours,
            }),
          catch: (cause) =>
            toExaServiceError({
              cause,
              operation: "getWebContent",
              message: "Failed to retrieve web content with Exa.",
              kind: "exa_get_web_content_error",
            }),
        });

        const results = response.results.map((result) => {
          const record = result as unknown as Record<string, unknown>;

          return {
            title: result.title ?? result.url,
            url: result.url,
            publishedDate: result.publishedDate ?? null,
            author: result.author ?? null,
            text: trimTo(getOptionalStringProperty(record, "text"), maxCharacters),
            summary: trimTo(
              getOptionalStringProperty(record, "summary"),
              WEB_CONTENT_SUMMARY_MAX_CHARACTERS,
            ),
            highlights: trimStringArray(
              getOptionalStringArrayProperty(record, "highlights"),
              WEB_CONTENT_MAX_HIGHLIGHTS,
              WEB_CONTENT_HIGHLIGHT_ITEM_MAX_CHARACTERS,
            ),
          };
        });

        return {
          urls,
          results,
          count: results.length,
        };
      });

    return {
      getClient,
      searchWeb,
      getWebContent,
    };
  });
}
