import { startServer, type HealthResponse, type HelloResponse } from "@btca/server";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ServiceMap from "effect/ServiceMap";

export class ServerServiceError extends Data.TaggedError("ServerServiceError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ServerFlags {
  readonly port: Option.Option<number>;
  readonly url: Option.Option<string>;
}

export interface ServerDef {
  readonly baseUrl: string;
  readonly health: () => Effect.Effect<HealthResponse, ServerServiceError>;
  readonly hello: (name: string) => Effect.Effect<HelloResponse, ServerServiceError>;
}

const normalizeBaseUrl = (url: string) => {
  const parsedUrl = new URL(url);

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`Unsupported server protocol: ${parsedUrl.protocol}`);
  }

  return parsedUrl.toString().replace(/\/$/, "");
};

const makeServerService = (baseUrl: string): ServerDef => {
  const rpc = <A>(path: `/${string}`) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${baseUrl}${path}`);
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
  };
};

const verifyServer = (baseUrl: string) =>
  makeServerService(baseUrl)
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
  static readonly make = ({ port, url }: ServerFlags) =>
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
        return makeServerService(baseUrl);
      }

      const startedServerExit = yield* Effect.exit(
        startServer({
          port: Option.getOrUndefined(port) ?? 0,
        }),
      );

      if (startedServerExit._tag === "Failure") {
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

      return makeServerService(startedServerExit.value.localUrl);
    });
}
