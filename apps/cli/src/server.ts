import {
  startServerWithLogging,
  type AuthState,
  type AuthProviderId,
  type HealthResponse,
} from "@btca/server";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as ServiceMap from "effect/ServiceMap";

export class ServerServiceError extends Data.TaggedError("ServerServiceError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ServerFlags {
  readonly port: Option.Option<number>;
  readonly url: Option.Option<string>;
  readonly debug: boolean;
}

type ConfigSnapshotResponse = {
  readonly config: {
    readonly startupDirectory: string;
    readonly globalConfigPath: string;
    readonly localConfigPath: string;
    readonly loadedConfigPaths: readonly string[];
    readonly dataDirectory: string;
    readonly providerTimeoutMs: number;
    readonly maxSteps: number;
    readonly model: string;
    readonly provider: string;
    readonly providerOptions: Record<string, { readonly baseURL?: string; readonly name?: string }>;
    readonly resources: readonly (
      | {
          readonly type: "git";
          readonly name: string;
          readonly url: string;
          readonly branch?: string;
          readonly searchPath?: string;
          readonly searchPaths?: readonly string[];
          readonly specialNotes?: string;
        }
      | {
          readonly type: "local";
          readonly name: string;
          readonly path: string;
          readonly specialNotes?: string;
        }
      | {
          readonly type: "npm";
          readonly name: string;
          readonly package: string;
          readonly version?: string;
          readonly specialNotes?: string;
        }
    )[];
    readonly scopes: {
      readonly model: "default" | "global" | "local";
      readonly resources: Readonly<Record<string, "default" | "global" | "local">>;
    };
  };
  readonly model: {
    readonly provider: string;
    readonly model: string;
    readonly providerOptions: Record<string, { readonly baseURL?: string; readonly name?: string }>;
    readonly providerTimeoutMs: number;
    readonly maxSteps: number;
    readonly scope: "default" | "global" | "local";
  };
};

type ResourcesResponse = {
  readonly resources: readonly (
    | {
        readonly type: "git";
        readonly name: string;
        readonly url: string;
        readonly branch?: string;
        readonly searchPath?: string;
        readonly searchPaths?: readonly string[];
        readonly specialNotes?: string;
      }
    | {
        readonly type: "local";
        readonly name: string;
        readonly path: string;
        readonly specialNotes?: string;
      }
    | {
        readonly type: "npm";
        readonly name: string;
        readonly package: string;
        readonly version?: string;
        readonly specialNotes?: string;
      }
  )[];
};

type AgentRunResponse = {
  readonly run: {
    readonly threadId: string;
    readonly provider: string;
    readonly modelId: string;
    readonly resourceNames: readonly string[];
    readonly workspaceDir: string;
    readonly answer: string;
    readonly messageCount: number;
  };
  readonly thread: unknown;
  readonly workspace: unknown;
};

export interface ServerDef {
  readonly baseUrl: string;
  readonly quiet: boolean;
  readonly health: () => Effect.Effect<HealthResponse, ServerServiceError>;
  readonly getConfig: () => Effect.Effect<ConfigSnapshotResponse, ServerServiceError>;
  readonly getResources: () => Effect.Effect<ResourcesResponse, ServerServiceError>;
  readonly getAuthState: () => Effect.Effect<AuthState, ServerServiceError>;
  readonly loginApiKey: (
    provider: AuthProviderId,
    apiKey: string,
  ) => Effect.Effect<AuthState, ServerServiceError>;
  readonly logout: (provider: AuthProviderId) => Effect.Effect<AuthState, ServerServiceError>;
  readonly addResource: (
    args:
      | {
          readonly type: "git";
          readonly name: string;
          readonly url: string;
          readonly branch?: string;
          readonly searchPath?: string;
          readonly searchPaths?: readonly string[];
          readonly specialNotes?: string;
          readonly scope?: "local" | "global";
        }
      | {
          readonly type: "local";
          readonly name: string;
          readonly path: string;
          readonly specialNotes?: string;
          readonly scope?: "local" | "global";
        }
      | {
          readonly type: "npm";
          readonly name: string;
          readonly package: string;
          readonly version?: string;
          readonly specialNotes?: string;
          readonly scope?: "local" | "global";
        },
  ) => Effect.Effect<unknown, ServerServiceError>;
  readonly removeResource: (name: string) => Effect.Effect<void, ServerServiceError>;
  readonly ask: (args: {
    readonly question: string;
    readonly resourceNames?: readonly string[];
    readonly quiet?: boolean;
  }) => Effect.Effect<string, ServerServiceError>;
  readonly askStream: (args: {
    readonly question: string;
    readonly resourceNames: readonly string[];
    readonly quiet?: boolean;
  }) => Effect.Effect<ReadableStream<Uint8Array>, ServerServiceError>;
}

const normalizeBaseUrl = (url: string) => {
  const parsedUrl = new URL(url);

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`Unsupported server protocol: ${parsedUrl.protocol}`);
  }

  return parsedUrl.toString().replace(/\/$/, "");
};

const trimMessage = (value: string) => value.trim().replace(/\s+/g, " ");

const readResponseText = async (response: Response) => {
  try {
    return await response.text();
  } catch {
    return "";
  }
};

const getResponseErrorMessage = (path: string, response: Response, bodyText: string) => {
  if (bodyText.trim().length > 0) {
    try {
      const parsed = JSON.parse(bodyText) as unknown;

      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "message" in parsed &&
        typeof parsed.message === "string" &&
        parsed.message.trim().length > 0
      ) {
        return trimMessage(parsed.message);
      }
    } catch {
      return trimMessage(bodyText);
    }
  }

  return `Server returned ${response.status} for ${path}.`;
};

const getTransportErrorMessage = ({
  baseUrl,
  path,
  cause,
}: {
  baseUrl: string;
  path: string;
  cause: unknown;
}) => {
  if (cause instanceof ServerServiceError) {
    return cause.message;
  }

  if (cause instanceof Error) {
    const message = cause.message.trim();

    if (
      message.includes("fetch failed") ||
      message.includes("ECONNREFUSED") ||
      message.includes("ENOTFOUND") ||
      message.includes("ETIMEDOUT")
    ) {
      return `Unable to connect to the BTCA server at ${baseUrl}.`;
    }

    if (message.length > 0) {
      return trimMessage(message);
    }
  }

  return `Unable to complete the request to ${path} on ${baseUrl}.`;
};

const makeServerService = ({ baseUrl, quiet }: { baseUrl: string; quiet: boolean }): ServerDef => {
  const rpc = <A>(path: `/${string}`, init?: RequestInit) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${baseUrl}${path}`, init);
        const bodyText = await readResponseText(response);

        if (!response.ok) {
          throw new ServerServiceError({
            message: getResponseErrorMessage(path, response, bodyText),
          });
        }

        try {
          return JSON.parse(bodyText) as A;
        } catch (cause) {
          throw new ServerServiceError({
            message: `Server returned an invalid JSON response for ${path}.`,
            cause,
          });
        }
      },
      catch: (cause) =>
        new ServerServiceError({
          message: getTransportErrorMessage({
            baseUrl,
            path,
            cause,
          }),
          cause,
        }),
    });

  return {
    baseUrl,
    quiet,
    health: () => rpc<HealthResponse>("/health"),
    getConfig: () => rpc<ConfigSnapshotResponse>("/config"),
    getResources: () => rpc<ResourcesResponse>("/resources"),
    getAuthState: () =>
      rpc<{
        auth: AuthState;
      }>("/auth").pipe(Effect.map((response) => response.auth)),
    loginApiKey: (provider, apiKey) =>
      rpc<{
        auth: AuthState;
      }>(`/auth/${encodeURIComponent(provider)}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          apiKey,
        }),
      }).pipe(Effect.map((response) => response.auth)),
    logout: (provider) =>
      rpc<{
        auth: AuthState;
      }>(`/auth/${encodeURIComponent(provider)}`, {
        method: "DELETE",
      }).pipe(Effect.map((response) => response.auth)),
    addResource: (resource) =>
      rpc("/config/resources", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(resource),
      }),
    removeResource: (name) =>
      rpc("/config/resources", {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name,
        }),
      }).pipe(Effect.asVoid),
    ask: ({ question, resourceNames, quiet: requestQuiet }) =>
      rpc<AgentRunResponse>("/agent/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          prompt: question,
          resourceNames,
          quiet: requestQuiet ?? quiet,
        }),
      }).pipe(Effect.map((response) => response.run.answer)),
    askStream: ({ question, resourceNames, quiet: requestQuiet }) =>
      Effect.tryPromise({
        try: async () => {
          const response = await fetch(`${baseUrl}/ask`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              question,
              resourceNames,
              quiet: requestQuiet ?? quiet,
            }),
          });

          if (!response.ok) {
            const bodyText = await readResponseText(response);
            throw new ServerServiceError({
              message: getResponseErrorMessage("/ask", response, bodyText),
            });
          }

          if (response.body === null) {
            throw new ServerServiceError({
              message: "Server returned an empty response body for /ask.",
            });
          }

          return response.body;
        },
        catch: (cause) =>
          new ServerServiceError({
            message: getTransportErrorMessage({
              baseUrl,
              path: "/ask",
              cause,
            }),
            cause,
          }),
      }),
  };
};

const verifyServer = (baseUrl: string) =>
  makeServerService({
    baseUrl,
    quiet: false,
  })
    .health()
    .pipe(
      Effect.map(() => undefined),
      Effect.mapError(
        (cause) =>
          new ServerServiceError({
            message: `Unable to connect to server at ${baseUrl}`,
            cause,
          }),
      ),
    );

export class Server extends ServiceMap.Service<Server, ServerDef>()("Server") {
  static readonly make = ({ port, url, debug }: ServerFlags) =>
    Effect.gen(function* () {
      if (Option.isSome(port) && Option.isSome(url)) {
        return yield* Effect.fail(
          new ServerServiceError({
            message: "The --port and --url flags are mutually exclusive.",
          }),
        );
      }

      if (Option.isSome(url)) {
        const baseUrl = yield* Effect.try({
          try: () => normalizeBaseUrl(url.value),
          catch: (cause) =>
            new ServerServiceError({
              message: `Invalid server URL: ${url.value}`,
              cause,
            }),
        });

        yield* verifyServer(baseUrl);
        return makeServerService({
          baseUrl,
          quiet: !debug,
        });
      }

      const startedServerExit = yield* Effect.exit(
        startServerWithLogging({
          port: Option.getOrUndefined(port) ?? 0,
          quiet: !debug,
        }),
      );

      if (Exit.isFailure(startedServerExit)) {
        return yield* Effect.fail(
          new ServerServiceError({
            message:
              Option.getOrUndefined(port) === undefined
                ? "Failed to start the embedded BTCA server."
                : `Failed to start the embedded BTCA server on port ${Option.getOrUndefined(port)}.`,
            cause: startedServerExit.cause,
          }),
        );
      }

      return makeServerService({
        baseUrl: startedServerExit.value.localUrl,
        quiet: !debug,
      });
    });
}
