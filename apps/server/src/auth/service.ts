import { promises as Fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";

import { Config } from "../config.ts";

const OPENAI_PROVIDER = "openai";
const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
const ENV_FILE_PATH = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)), ".env");

export class AuthError extends Data.TaggedError("AuthError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

type AuthState = {
  readonly provider: "openai";
  readonly configured: boolean;
  readonly source: "project-env" | "env" | "none";
};

type ResolvedOpenAiAuth = {
  readonly provider: "openai";
  readonly modelId: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly providerName?: string;
};

type AuthServiceShape = {
  readonly getAuthState: Effect.Effect<AuthState, AuthError>;
  readonly setApiKey: (apiKey: string) => Effect.Effect<void, AuthError>;
  readonly clearApiKey: Effect.Effect<void, AuthError>;
  readonly requireModelAuth: (args: {
    provider: string;
    modelId: string;
  }) => Effect.Effect<ResolvedOpenAiAuth, AuthError>;
};

export class AuthService extends ServiceMap.Service<AuthService, AuthServiceShape>()(
  "btca-server/AuthService",
) {
  static readonly layer = Layer.effect(
    AuthService,
    Effect.gen(function* () {
      const config = yield* Config;

      const readProjectEnv = () =>
        Effect.gen(function* () {
          const contents = yield* Effect.tryPromise({
            try: async () => {
              try {
                return await Fs.readFile(ENV_FILE_PATH, "utf8");
              } catch (cause) {
                if (
                  cause &&
                  typeof cause === "object" &&
                  "code" in cause &&
                  cause.code === "ENOENT"
                ) {
                  return null;
                }

                throw cause;
              }
            },
            catch: (cause) =>
              new AuthError({
                message: "Failed to read apps/server/.env.",
                cause,
              }),
          });

          if (contents === null) {
            return null;
          }

          for (const line of contents.split(/\r?\n/u)) {
            const trimmed = line.trim();

            if (trimmed.length === 0 || trimmed.startsWith("#")) {
              continue;
            }

            const separatorIndex = trimmed.indexOf("=");

            if (separatorIndex === -1) {
              continue;
            }

            const key = trimmed.slice(0, separatorIndex).trim();
            const rawValue = trimmed.slice(separatorIndex + 1).trim();

            if (key !== "OPENAI_API_KEY") {
              continue;
            }

            const unquoted =
              rawValue.startsWith('"') && rawValue.endsWith('"')
                ? rawValue.slice(1, -1)
                : rawValue.startsWith("'") && rawValue.endsWith("'")
                  ? rawValue.slice(1, -1)
                  : rawValue;

            return unquoted.trim() || null;
          }

          return null;
        });

      const resolveApiKey = () =>
        Effect.gen(function* () {
          const projectEnvApiKey = yield* readProjectEnv();

          if (projectEnvApiKey) {
            return {
              apiKey: projectEnvApiKey,
              source: "project-env" as const,
            };
          }

          const envApiKey = process.env.OPENAI_API_KEY?.trim();

          if (envApiKey) {
            return {
              apiKey: envApiKey,
              source: "env" as const,
            };
          }

          return {
            apiKey: null,
            source: "none" as const,
          };
        });

      return {
        getAuthState: resolveApiKey().pipe(
          Effect.map(({ apiKey, source }) => ({
            provider: OPENAI_PROVIDER,
            configured: apiKey !== null,
            source,
          })),
        ),
        setApiKey: (apiKey) =>
          Effect.gen(function* () {
            const trimmed = apiKey.trim();

            if (trimmed.length === 0) {
              return yield* Effect.fail(
                new AuthError({
                  message: "OpenAI API key must not be empty.",
                }),
              );
            }

            yield* Effect.tryPromise({
              try: async () => {
                let nextContents = `OPENAI_API_KEY=${trimmed}\n`;

                try {
                  const existingContents = await Fs.readFile(ENV_FILE_PATH, "utf8");
                  const lines = existingContents.split(/\r?\n/u);
                  let replaced = false;
                  const updatedLines = lines
                    .filter((line) => line.length > 0)
                    .map((line) => {
                      if (!line.trim().startsWith("OPENAI_API_KEY=")) {
                        return line;
                      }

                      replaced = true;
                      return `OPENAI_API_KEY=${trimmed}`;
                    });

                  if (!replaced) {
                    updatedLines.push(`OPENAI_API_KEY=${trimmed}`);
                  }

                  nextContents = `${updatedLines.join("\n")}\n`;
                } catch (cause) {
                  if (
                    !(
                      cause &&
                      typeof cause === "object" &&
                      "code" in cause &&
                      cause.code === "ENOENT"
                    )
                  ) {
                    throw cause;
                  }
                }

                await Fs.writeFile(ENV_FILE_PATH, nextContents, "utf8");
              },
              catch: (cause) =>
                new AuthError({
                  message: "Failed to write apps/server/.env.",
                  cause,
                }),
            });
          }),
        clearApiKey: Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: async () => {
              try {
                const existingContents = await Fs.readFile(ENV_FILE_PATH, "utf8");
                const nextLines = existingContents
                  .split(/\r?\n/u)
                  .filter((line) => !line.trim().startsWith("OPENAI_API_KEY=") && line.length > 0);

                if (nextLines.length === 0) {
                  await Fs.rm(ENV_FILE_PATH, { force: true });
                  return;
                }

                await Fs.writeFile(ENV_FILE_PATH, `${nextLines.join("\n")}\n`, "utf8");
              } catch (cause) {
                if (
                  cause &&
                  typeof cause === "object" &&
                  "code" in cause &&
                  cause.code === "ENOENT"
                ) {
                  return;
                }

                throw cause;
              }
            },
            catch: (cause) =>
              new AuthError({
                message: "Failed to update apps/server/.env.",
                cause,
              }),
          });
        }),
        requireModelAuth: ({ provider, modelId }) =>
          Effect.gen(function* () {
            if (provider !== OPENAI_PROVIDER) {
              return yield* Effect.fail(
                new AuthError({
                  message: `Only the "${OPENAI_PROVIDER}" provider is supported right now. Current config provider: "${provider}".`,
                }),
              );
            }

            const resolved = yield* resolveApiKey();

            if (resolved.apiKey === null) {
              return yield* Effect.fail(
                new AuthError({
                  message: "OpenAI is not authenticated. Set `OPENAI_API_KEY` in apps/server/.env.",
                }),
              );
            }

            const providerOptions = yield* config.getProviderOptions(OPENAI_PROVIDER);

            return {
              provider: OPENAI_PROVIDER,
              modelId,
              apiKey: resolved.apiKey,
              baseUrl: providerOptions?.baseURL?.trim() || OPENAI_DEFAULT_BASE_URL,
              providerName: providerOptions?.name?.trim() || undefined,
            } satisfies ResolvedOpenAiAuth;
          }),
      } satisfies AuthServiceShape;
    }),
  );
}
