import {
  startServerWithLogging,
  type AuthState,
  type AuthProviderId,
  type HealthResponse,
  type HelloResponse,
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

export interface ServerDef {
  readonly baseUrl: string;
  readonly health: () => Effect.Effect<HealthResponse, ServerServiceError>;
  readonly hello: (name: string) => Effect.Effect<HelloResponse, ServerServiceError>;
  readonly getAuthState: () => Effect.Effect<AuthState, ServerServiceError>;
  readonly loginApiKey: (
    provider: AuthProviderId,
    apiKey: string,
  ) => Effect.Effect<AuthState, ServerServiceError>;
  readonly logout: (provider: AuthProviderId) => Effect.Effect<AuthState, ServerServiceError>;
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

const makeServerService = ({ baseUrl, quiet }: { baseUrl: string; quiet: boolean }): ServerDef => {
  const rpc = <A>(path: `/${string}`, init?: RequestInit) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${baseUrl}${path}`, init);
        const body = await response.json();

        if (!response.ok) {
          throw new Error(`Server returned ${response.status} for ${path}`);
        }

        return body as A;
      },
      catch: (cause) =>
        new ServerServiceError({
          message: `Failed to call ${path} on ${baseUrl}`,
          cause,
        }),
    });

  return {
    baseUrl,
    health: () => rpc<HealthResponse>("/health"),
    hello: (name) => rpc<HelloResponse>(`/hello/${encodeURIComponent(name)}`),
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
            const body = await response.text();
            throw new Error(
              `Server returned ${response.status} for /ask${body.length > 0 ? `: ${body}` : ""}`,
            );
          }

          if (response.body === null) {
            throw new Error("Server returned an empty response body for /ask");
          }

          return response.body;
        },
        catch: (cause) =>
          new ServerServiceError({
            message: `Failed to call /ask on ${baseUrl}`,
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
