import { randomUUID } from "node:crypto";
import { promises as Fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getEnvApiKey } from "@mariozechner/pi-ai";
import {
  getOAuthApiKey,
  getOAuthProvider,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
} from "@mariozechner/pi-ai/oauth";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";

import { Config } from "../config.ts";

const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
const OPENAI_CODEX_DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const AUTH_DIRECTORY_PATH = path.join(os.homedir(), ".config", "btca");
export const AUTH_FILE_PATH = path.join(AUTH_DIRECTORY_PATH, "auth.json");
const AUTH_LOCK_DIRECTORY_PATH = `${AUTH_FILE_PATH}.lock`;
export const AUTH_FILE_VERSION = 1;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_DELAY_MS = 50;
const LOCK_RETRY_ATTEMPTS = 200;

export const SUPPORTED_AUTH_PROVIDERS = [
  "openai",
  "openai-codex",
  "anthropic",
  "opencode",
  "github-copilot",
  "google",
  "openrouter",
] as const;

export type AuthProviderId = (typeof SUPPORTED_AUTH_PROVIDERS)[number];

type AuthProviderKind = "api_key" | "oauth";

type AuthProviderDefinition = {
  readonly id: AuthProviderId;
  readonly label: string;
  readonly kind: AuthProviderKind;
  readonly defaultBaseUrl?: string;
};

const AUTH_PROVIDER_DEFINITIONS: Record<AuthProviderId, AuthProviderDefinition> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    kind: "api_key",
    defaultBaseUrl: OPENAI_DEFAULT_BASE_URL,
  },
  "openai-codex": {
    id: "openai-codex",
    label: "OpenAI Codex",
    kind: "oauth",
    defaultBaseUrl: OPENAI_CODEX_DEFAULT_BASE_URL,
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    kind: "api_key",
  },
  opencode: {
    id: "opencode",
    label: "OpenCode Zen",
    kind: "api_key",
  },
  "github-copilot": {
    id: "github-copilot",
    label: "GitHub Copilot",
    kind: "oauth",
  },
  google: {
    id: "google",
    label: "Google Gemini",
    kind: "api_key",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    kind: "api_key",
  },
};

export const isAuthProviderId = (value: string): value is AuthProviderId =>
  value in AUTH_PROVIDER_DEFINITIONS;

type StoredApiKeyCredential = {
  readonly type: "api_key";
  readonly key: string;
};

type StoredOAuthCredential = {
  readonly type: "oauth";
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly metadata?: Readonly<Record<string, string>>;
};

type StoredCredential = StoredApiKeyCredential | StoredOAuthCredential;

type StoredAuthFile = Partial<Record<AuthProviderId, StoredCredential>>;

export type AuthProviderState = {
  readonly provider: AuthProviderId;
  readonly label: string;
  readonly kind: AuthProviderKind;
  readonly configured: boolean;
  readonly source: "auth-file" | "env" | "none";
};

export type AuthState = {
  readonly path: string;
  readonly providers: Readonly<Record<AuthProviderId, AuthProviderState>>;
};

export type ResolvedProviderCredentials = {
  readonly provider: AuthProviderId;
  readonly modelId?: string;
  readonly authType: AuthProviderKind;
  readonly token: string;
  readonly source: "auth-file" | "env";
  readonly baseUrl?: string;
  readonly providerName?: string;
  readonly metadata?: Readonly<Record<string, string>>;
};

type LoginInput = {
  readonly provider: AuthProviderId;
  readonly apiKey?: string;
  readonly callbacks?: OAuthLoginCallbacks;
};

type AuthServiceShape = {
  readonly getAuthState: Effect.Effect<AuthState, AuthError>;
  readonly login: (input: LoginInput) => Effect.Effect<void, AuthError>;
  readonly logout: (provider: AuthProviderId) => Effect.Effect<void, AuthError>;
  readonly getCredentials: (
    provider: AuthProviderId,
  ) => Effect.Effect<ResolvedProviderCredentials | undefined, AuthError>;
  readonly requireModelAuth: (args: {
    provider: string;
    modelId: string;
  }) => Effect.Effect<ResolvedProviderCredentials & { readonly modelId: string }, AuthError>;
};

export class AuthError extends Data.TaggedError("AuthError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const emptyAuthFile = (): StoredAuthFile => ({});

const parseStoredCredential = (value: unknown): StoredCredential | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  if (record.type === "api_key" && typeof record.key === "string" && record.key.trim().length > 0) {
    return {
      type: "api_key",
      key: record.key.trim(),
    };
  }

  if (
    record.type === "oauth" &&
    typeof record.access === "string" &&
    typeof record.refresh === "string" &&
    typeof record.expires === "number" &&
    Number.isFinite(record.expires)
  ) {
    const metadata =
      typeof record.metadata === "object" && record.metadata !== null
        ? Object.fromEntries(
            Object.entries(record.metadata).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : undefined;

    return {
      type: "oauth",
      access: record.access,
      refresh: record.refresh,
      expires: record.expires,
      metadata,
    };
  }

  return undefined;
};

const parseAuthFile = (content: string | undefined): StoredAuthFile => {
  if (!content?.trim()) {
    return emptyAuthFile();
  }

  const parsed = JSON.parse(content) as unknown;

  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const flatProviders = Object.fromEntries(
      Object.entries(parsed).flatMap(([provider, value]) => {
        if (!isAuthProviderId(provider)) {
          return [];
        }

        const credential = parseStoredCredential(value);
        return credential ? ([[provider, credential]] as const) : [];
      }),
    ) as StoredAuthFile;

    if (Object.keys(flatProviders).length > 0) {
      return flatProviders;
    }
  }

  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "version" in parsed &&
    parsed.version === AUTH_FILE_VERSION &&
    "providers" in parsed &&
    typeof parsed.providers === "object" &&
    parsed.providers !== null
  ) {
    return Object.fromEntries(
      Object.entries(parsed.providers).flatMap(([provider, value]) => {
        if (!isAuthProviderId(provider)) {
          return [];
        }

        const credential = parseStoredCredential(value);
        return credential ? ([[provider, credential]] as const) : [];
      }),
    ) as StoredAuthFile;
  }

  return emptyAuthFile();
};

const serializeAuthFile = (value: StoredAuthFile) => `${JSON.stringify(value, null, 2)}\n`;

const ensureStorageReady = async () => {
  await Fs.mkdir(AUTH_DIRECTORY_PATH, {
    recursive: true,
    mode: 0o700,
  });

  try {
    await Fs.chmod(AUTH_DIRECTORY_PATH, 0o700);
  } catch {
    // Ignore chmod failures on platforms that do not support POSIX permissions.
  }

  try {
    await Fs.access(AUTH_FILE_PATH);
  } catch (cause) {
    if (!(cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT")) {
      throw cause;
    }

    await Fs.writeFile(AUTH_FILE_PATH, serializeAuthFile(emptyAuthFile()), {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  try {
    await Fs.chmod(AUTH_FILE_PATH, 0o600);
  } catch {
    // Ignore chmod failures on platforms that do not support POSIX permissions.
  }
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const acquireLock = async () => {
  for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await Fs.mkdir(AUTH_LOCK_DIRECTORY_PATH);
      return;
    } catch (cause) {
      if (!(cause && typeof cause === "object" && "code" in cause && cause.code === "EEXIST")) {
        throw cause;
      }

      try {
        const stats = await Fs.stat(AUTH_LOCK_DIRECTORY_PATH);
        if (Date.now() - stats.mtimeMs > LOCK_STALE_MS) {
          await Fs.rm(AUTH_LOCK_DIRECTORY_PATH, { recursive: true, force: true });
          continue;
        }
      } catch {
        // If the lock disappeared between attempts, we'll just retry.
      }

      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }

  throw new Error("Timed out waiting for the auth.json lock.");
};

const releaseLock = async () => {
  await Fs.rm(AUTH_LOCK_DIRECTORY_PATH, { recursive: true, force: true });
};

const withAuthFileLock = <A>(
  fn: (current: StoredAuthFile) => Promise<{
    readonly result: A;
    readonly next?: StoredAuthFile;
  }>,
) =>
  Effect.tryPromise({
    try: async () => {
      await ensureStorageReady();
      await acquireLock();

      try {
        const currentContents = await Fs.readFile(AUTH_FILE_PATH, "utf8");
        const current = parseAuthFile(currentContents);
        const { result, next } = await fn(current);

        if (next !== undefined) {
          const temporaryPath = `${AUTH_FILE_PATH}.${randomUUID()}.tmp`;
          await Fs.writeFile(temporaryPath, serializeAuthFile(next), {
            encoding: "utf8",
            mode: 0o600,
          });

          try {
            await Fs.chmod(temporaryPath, 0o600);
          } catch {
            // Ignore chmod failures on platforms that do not support POSIX permissions.
          }

          await Fs.rename(temporaryPath, AUTH_FILE_PATH);
        }

        return result;
      } finally {
        await releaseLock();
      }
    },
    catch: (cause) =>
      new AuthError({
        message: `Failed to read or update ${AUTH_FILE_PATH}.`,
        cause,
      }),
  });

const loadAuthFile = () =>
  withAuthFileLock(async (current) => ({
    result: current,
  }));

const resolveProviderBaseUrl = (
  definition: AuthProviderDefinition,
  providerBaseUrl: string | undefined,
) => providerBaseUrl?.trim() || definition.defaultBaseUrl;

const toResolvedCredentials = (args: {
  definition: AuthProviderDefinition;
  modelId?: string;
  token: string;
  source: "auth-file" | "env";
  baseUrl?: string;
  providerName?: string;
  metadata?: Readonly<Record<string, string>>;
}): ResolvedProviderCredentials => ({
  provider: args.definition.id,
  modelId: args.modelId,
  authType: args.definition.kind,
  token: args.token,
  source: args.source,
  baseUrl: args.baseUrl,
  providerName: args.providerName,
  metadata: args.metadata,
});

const toOAuthCredentials = (credential: StoredOAuthCredential): OAuthCredentials => ({
  access: credential.access,
  refresh: credential.refresh,
  expires: credential.expires,
  ...credential.metadata,
});

const fromOAuthCredentials = (
  credentials: OAuthCredentials,
  previousMetadata?: Readonly<Record<string, string>>,
): StoredOAuthCredential => {
  const metadataEntries = Object.entries(credentials).filter(
    (entry): entry is [string, string] =>
      entry[0] !== "access" &&
      entry[0] !== "refresh" &&
      entry[0] !== "expires" &&
      typeof entry[1] === "string",
  );

  const metadata =
    metadataEntries.length > 0
      ? Object.fromEntries(metadataEntries)
      : previousMetadata && Object.keys(previousMetadata).length > 0
        ? Object.fromEntries(Object.entries(previousMetadata))
        : undefined;

  return {
    type: "oauth",
    access: credentials.access,
    refresh: credentials.refresh,
    expires: credentials.expires,
    metadata,
  };
};

export class AuthService extends ServiceMap.Service<AuthService, AuthServiceShape>()(
  "btca-server/AuthService",
) {
  static readonly layer = Layer.effect(
    AuthService,
    Effect.gen(function* () {
      const config = yield* Config;
      yield* loadAuthFile();

      const getAuthState = loadAuthFile().pipe(
        Effect.map((stored) => ({
          path: AUTH_FILE_PATH,
          providers: Object.fromEntries(
            SUPPORTED_AUTH_PROVIDERS.map((providerId) => {
              const definition = AUTH_PROVIDER_DEFINITIONS[providerId];
              const storedCredential = stored[providerId];
              const envCredential = getEnvApiKey(providerId);
              const source = storedCredential ? "auth-file" : envCredential ? "env" : "none";

              return [
                providerId,
                {
                  provider: providerId,
                  label: definition.label,
                  kind: definition.kind,
                  configured: source !== "none",
                  source,
                } satisfies AuthProviderState,
              ];
            }),
          ) as Readonly<Record<AuthProviderId, AuthProviderState>>,
        })),
      );

      const getStoredCredential = (provider: AuthProviderId) =>
        loadAuthFile().pipe(Effect.map((stored) => stored[provider]));

      const getResolvedCredentials = (provider: AuthProviderId) =>
        Effect.gen(function* () {
          const definition = AUTH_PROVIDER_DEFINITIONS[provider];
          const providerOptions = yield* config.getProviderOptions(provider);
          const baseUrl = resolveProviderBaseUrl(definition, providerOptions?.baseURL);
          const providerName = providerOptions?.name?.trim() || definition.label;

          const storedCredential = yield* getStoredCredential(provider);

          if (storedCredential?.type === "api_key") {
            return toResolvedCredentials({
              definition,
              token: storedCredential.key,
              source: "auth-file",
              baseUrl,
              providerName,
            });
          }

          if (storedCredential?.type === "oauth") {
            const oauthProvider = getOAuthProvider(provider);

            if (!oauthProvider) {
              return yield* Effect.fail(
                new AuthError({
                  message: `OAuth is not available for provider "${provider}".`,
                }),
              );
            }

            const resolved = yield* withAuthFileLock(async (current) => {
              const currentCredential = current[provider];

              if (currentCredential?.type !== "oauth") {
                return {
                  result: undefined,
                };
              }

              const oauthCredentialRecord = Object.fromEntries(
                Object.entries(current).flatMap(([key, value]) =>
                  value?.type === "oauth" ? [[key, toOAuthCredentials(value)]] : [],
                ),
              ) as Record<string, OAuthCredentials>;

              const refreshed = await getOAuthApiKey(provider, oauthCredentialRecord);

              if (!refreshed) {
                return {
                  result: undefined,
                };
              }

              const nextCredential = fromOAuthCredentials(
                refreshed.newCredentials,
                currentCredential.metadata,
              );

              return {
                result: toResolvedCredentials({
                  definition,
                  token: refreshed.apiKey,
                  source: "auth-file",
                  baseUrl,
                  providerName,
                  metadata: nextCredential.metadata,
                }),
                next: { ...current, [provider]: nextCredential },
              };
            });

            if (resolved) {
              return resolved;
            }
          }

          const envCredential = getEnvApiKey(provider)?.trim();

          if (!envCredential) {
            return undefined;
          }

          return toResolvedCredentials({
            definition,
            token: envCredential,
            source: "env",
            baseUrl,
            providerName,
          });
        });

      return {
        getAuthState,
        login: (input) =>
          Effect.gen(function* () {
            const definition = AUTH_PROVIDER_DEFINITIONS[input.provider];

            if (definition.kind === "api_key") {
              const trimmed = input.apiKey?.trim();

              if (!trimmed) {
                return yield* Effect.fail(
                  new AuthError({
                    message: `${definition.label} requires a non-empty API key.`,
                  }),
                );
              }

              yield* withAuthFileLock(async (current) => ({
                result: undefined,
                next: {
                  ...current,
                  [input.provider]: {
                    type: "api_key",
                    key: trimmed,
                  },
                },
              }));

              return;
            }

            if (!input.callbacks) {
              return yield* Effect.fail(
                new AuthError({
                  message: `${definition.label} login requires interactive OAuth callbacks.`,
                }),
              );
            }

            const oauthProvider = getOAuthProvider(input.provider);

            if (!oauthProvider) {
              return yield* Effect.fail(
                new AuthError({
                  message: `OAuth is not available for provider "${input.provider}".`,
                }),
              );
            }

            const oauthCredentials = yield* Effect.tryPromise({
              try: async () => oauthProvider.login(input.callbacks!),
              catch: (cause) =>
                new AuthError({
                  message: `Failed to complete ${definition.label} OAuth login.`,
                  cause,
                }),
            });

            yield* withAuthFileLock(async (current) => ({
              result: undefined,
              next: {
                ...current,
                [input.provider]: fromOAuthCredentials(oauthCredentials),
              },
            }));
          }),
        logout: (provider) =>
          withAuthFileLock(async (current) => {
            const nextProviders = { ...current };
            delete nextProviders[provider];

            return {
              result: undefined,
              next: nextProviders,
            };
          }),
        getCredentials: (provider) => getResolvedCredentials(provider),
        requireModelAuth: ({ provider, modelId }) =>
          Effect.gen(function* () {
            if (!isAuthProviderId(provider)) {
              return yield* Effect.fail(
                new AuthError({
                  message: `Unsupported provider "${provider}".`,
                }),
              );
            }

            const resolved = yield* getResolvedCredentials(provider);

            if (!resolved) {
              const definition = AUTH_PROVIDER_DEFINITIONS[provider];
              return yield* Effect.fail(
                new AuthError({
                  message: `${definition.label} is not authenticated. Add credentials to ${AUTH_FILE_PATH}.`,
                }),
              );
            }

            return {
              ...resolved,
              modelId,
            };
          }),
      } satisfies AuthServiceShape;
    }),
  );
}
