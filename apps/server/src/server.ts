import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ServiceMap from "effect/ServiceMap";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Http from "node:http";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
export {
  AUTH_FILE_PATH,
  AUTH_FILE_VERSION,
  SUPPORTED_AUTH_PROVIDERS,
  isAuthProviderId,
  type AuthProviderId,
  type AuthProviderState,
  type AuthState,
  type ResolvedProviderCredentials,
} from "./auth/service.ts";
export { getOAuthProvider, type OAuthLoginCallbacks } from "@mariozechner/pi-ai/oauth";
import { ConfigLive } from "./config.ts";
import { AgentService, AgentError } from "./agent/service.ts";
import { AgentThreadStore, ThreadStoreError } from "./agent/threads.ts";
import { AuthError, AuthService, isAuthProviderId } from "./auth/service.ts";
import { Config, ConfigError } from "./config.ts";
import { ResourceError, ResourcesService } from "./resources/service.ts";
import { WorkspaceError, WorkspaceService } from "./workspace/service.ts";

export { Config, ConfigError } from "./config.ts";

export interface HealthResponse {
  readonly ok: true;
  readonly name: "@btca/server";
}

export interface HelloResponse {
  readonly message: string;
}

const ApiKeyLoginInput = Schema.Struct({
  apiKey: Schema.NonEmptyString,
});

const AuthProviderPathParams = Schema.Struct({
  provider: Schema.NonEmptyString,
});

const AgentRunInput = Schema.Struct({
  threadId: Schema.optional(Schema.NonEmptyString),
  prompt: Schema.NonEmptyString,
  modelId: Schema.optional(Schema.NonEmptyString),
  resourceNames: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  quiet: Schema.optional(Schema.Boolean),
});

const AskInput = Schema.Struct({
  threadId: Schema.optional(Schema.NonEmptyString),
  question: Schema.NonEmptyString,
  modelId: Schema.optional(Schema.NonEmptyString),
  resourceNames: Schema.Array(Schema.NonEmptyString),
  quiet: Schema.optional(Schema.Boolean),
});

const ThreadPathParams = Schema.Struct({
  threadId: Schema.NonEmptyString,
});

type ResourceScope = "local" | "global";

type AddResourceInput =
  | {
      readonly type: "git";
      readonly name: string;
      readonly url: string;
      readonly branch?: string;
      readonly searchPath?: string;
      readonly searchPaths?: readonly string[];
      readonly specialNotes?: string;
      readonly scope?: ResourceScope;
    }
  | {
      readonly type: "local";
      readonly name: string;
      readonly path: string;
      readonly specialNotes?: string;
      readonly scope?: ResourceScope;
    }
  | {
      readonly type: "npm";
      readonly name: string;
      readonly package: string;
      readonly version?: string;
      readonly specialNotes?: string;
      readonly scope?: ResourceScope;
    };

const getErrorMessage = (error: unknown) => {
  if (error instanceof ConfigError) return error.message;
  if (error instanceof AuthError) return error.message;
  if (error instanceof ResourceError) return error.message;
  if (error instanceof WorkspaceError) return error.message;
  if (error instanceof ThreadStoreError) return error.message;
  if (error instanceof AgentError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
};

const parseAuthProvider = (value: string) => {
  if (!isAuthProviderId(value)) {
    throw new AuthError({
      message: `Unsupported provider "${value}".`,
    });
  }

  return value;
};

const getNonEmptyString = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

const getOptionalString = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

const getOptionalStringArray = (record: Record<string, unknown>, key: string) => {
  const value = record[key];

  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value.map((entry) => entry.trim()).filter(Boolean)
    : undefined;
};

const getOptionalResourceScope = (record: Record<string, unknown>) => {
  const scope = record.scope;
  return scope === "local" || scope === "global" ? scope : undefined;
};

const parseAddResourceInput = (body: unknown): AddResourceInput => {
  if (typeof body !== "object" || body === null) {
    throw new ConfigError({
      message: "Invalid resource body.",
    });
  }

  const record = body as Record<string, unknown>;
  const type = getNonEmptyString(record, "type");
  const name = getNonEmptyString(record, "name");

  if (!type || !name) {
    throw new ConfigError({
      message: 'Resource "type" and "name" are required.',
    });
  }

  if (type === "git") {
    const url = getNonEmptyString(record, "url");

    if (!url) {
      throw new ConfigError({
        message: 'Git resources require a non-empty "url".',
      });
    }

    return {
      type,
      name,
      url,
      branch: getOptionalString(record, "branch"),
      searchPath: getOptionalString(record, "searchPath"),
      searchPaths: getOptionalStringArray(record, "searchPaths"),
      specialNotes: getOptionalString(record, "specialNotes"),
      scope: getOptionalResourceScope(record),
    };
  }

  if (type === "local") {
    const resourcePath = getNonEmptyString(record, "path");

    if (!resourcePath) {
      throw new ConfigError({
        message: 'Local resources require a non-empty "path".',
      });
    }

    return {
      type,
      name,
      path: resourcePath,
      specialNotes: getOptionalString(record, "specialNotes"),
      scope: getOptionalResourceScope(record),
    };
  }

  if (type === "npm") {
    const packageName = getNonEmptyString(record, "package");

    if (!packageName) {
      throw new ConfigError({
        message: 'NPM resources require a non-empty "package".',
      });
    }

    return {
      type,
      name,
      package: packageName,
      version: getOptionalString(record, "version"),
      specialNotes: getOptionalString(record, "specialNotes"),
      scope: getOptionalResourceScope(record),
    };
  }

  throw new ConfigError({
    message: `Unsupported resource type "${type}".`,
  });
};

const parseRemoveResourceInput = (body: unknown) => {
  if (typeof body !== "object" || body === null) {
    throw new ConfigError({
      message: "Invalid remove resource body.",
    });
  }

  const name = getNonEmptyString(body as Record<string, unknown>, "name");

  if (!name) {
    throw new ConfigError({
      message: 'Remove resource requests require a non-empty "name".',
    });
  }

  return {
    name,
  };
};

const getErrorStatus = (error: unknown) => {
  if (
    error instanceof ConfigError ||
    error instanceof AuthError ||
    error instanceof ResourceError ||
    error instanceof WorkspaceError ||
    error instanceof ThreadStoreError ||
    error instanceof AgentError
  ) {
    return 400;
  }

  return 500;
};

const jsonError = (error: unknown) =>
  HttpServerResponse.jsonUnsafe(
    {
      ok: false,
      message: getErrorMessage(error),
      errorType: error instanceof Error ? error.name : typeof error,
    },
    {
      status: getErrorStatus(error),
    },
  );

const handleJsonRoute = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options?: {
    status?: number;
  },
) =>
  effect.pipe(
    Effect.map((body) =>
      HttpServerResponse.jsonUnsafe(
        {
          ok: true,
          ...body,
        },
        {
          status: options?.status,
        },
      ),
    ),
    Effect.catchCause((cause) => Effect.succeed(jsonError(Cause.squash(cause)))),
  );

const textEncoder = new TextEncoder();

const toSseChunk = (event: string, data: unknown) =>
  textEncoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

const getAssistantErrorMessage = (message: unknown) => {
  if (
    typeof message !== "object" ||
    message === null ||
    !("role" in message) ||
    message.role !== "assistant" ||
    !("stopReason" in message) ||
    message.stopReason !== "error"
  ) {
    return undefined;
  }

  if ("errorMessage" in message && typeof message.errorMessage === "string") {
    return message.errorMessage;
  }

  return "The model request failed.";
};

export const RoutesLive = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    "/health",
    HttpServerResponse.jsonUnsafe({
      ok: true,
      name: "@btca/server",
    }),
  ),
  HttpRouter.add(
    "GET",
    "/hello/:name",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;

      return HttpServerResponse.jsonUnsafe({
        message: `Hello, ${params.name ?? "world"}! from @btca/server`,
      });
    }),
  ),
  HttpRouter.add(
    "GET",
    "/config",
    handleJsonRoute(
      Effect.gen(function* () {
        const config = yield* Config;
        return {
          config: yield* config.snapshot,
          model: yield* config.getModel,
        };
      }),
    ),
  ),
  HttpRouter.add(
    "POST",
    "/config/reload",
    handleJsonRoute(
      Effect.gen(function* () {
        const config = yield* Config;
        yield* config.reload;
        return {
          config: yield* config.snapshot,
        };
      }),
    ),
  ),
  HttpRouter.add(
    "GET",
    "/auth",
    handleJsonRoute(
      Effect.gen(function* () {
        const auth = yield* AuthService;
        return {
          auth: yield* auth.getAuthState,
        };
      }),
    ),
  ),
  HttpRouter.add(
    "POST",
    "/auth/:provider",
    handleJsonRoute(
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(AuthProviderPathParams);
        const body = yield* HttpServerRequest.schemaBodyJson(ApiKeyLoginInput);
        const auth = yield* AuthService;
        yield* auth.login({
          provider: parseAuthProvider(params.provider),
          apiKey: body.apiKey,
        });
        return {
          auth: yield* auth.getAuthState,
        };
      }),
    ),
  ),
  HttpRouter.add(
    "DELETE",
    "/auth/:provider",
    handleJsonRoute(
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(AuthProviderPathParams);
        const auth = yield* AuthService;
        yield* auth.logout(parseAuthProvider(params.provider));
        return {
          auth: yield* auth.getAuthState,
        };
      }),
    ),
  ),
  HttpRouter.add(
    "GET",
    "/resources",
    handleJsonRoute(
      Effect.gen(function* () {
        const resources = yield* ResourcesService;
        return {
          resources: yield* resources.listConfiguredResources,
        };
      }),
    ),
  ),
  HttpRouter.add(
    "POST",
    "/config/resources",
    handleJsonRoute(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const rawBody = yield* request.json;
        const body = yield* Effect.try({
          try: () => parseAddResourceInput(rawBody),
          catch: (cause) =>
            cause instanceof Error
              ? cause
              : new ConfigError({
                  message: "Invalid resource body.",
                  cause,
                }),
        });
        const config = yield* Config;

        const { scope, ...resource } = body;
        const added = yield* config.addResource(resource, scope ?? "local");

        return {
          resource: added,
          scope: scope ?? "local",
        };
      }),
      {
        status: 201,
      },
    ),
  ),
  HttpRouter.add(
    "DELETE",
    "/config/resources",
    handleJsonRoute(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const rawBody = yield* request.json;
        const body = yield* Effect.try({
          try: () => parseRemoveResourceInput(rawBody),
          catch: (cause) =>
            cause instanceof Error
              ? cause
              : new ConfigError({
                  message: "Invalid remove resource body.",
                  cause,
                }),
        });
        const config = yield* Config;
        yield* config.removeResource(body.name);

        return {
          name: body.name,
        };
      }),
    ),
  ),
  HttpRouter.add(
    "GET",
    "/threads",
    handleJsonRoute(
      Effect.gen(function* () {
        const threads = yield* AgentThreadStore;
        const items = yield* threads.listThreads();

        return {
          threads: items.map((thread) => ({
            threadId: thread.threadId,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
            status: thread.status,
            activity: thread.activity,
            workspaceDir: thread.workspaceDir,
            modelId: thread.modelId,
            provider: thread.provider,
            resourceNames: thread.resourceNames,
            messageCount: thread.messages.length,
          })),
        };
      }),
    ),
  ),
  HttpRouter.add(
    "GET",
    "/threads/:threadId",
    handleJsonRoute(
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(ThreadPathParams);
        const threads = yield* AgentThreadStore;
        return {
          thread: yield* threads.loadThread(params.threadId),
        };
      }),
    ),
  ),
  HttpRouter.add(
    "POST",
    "/agent/run",
    handleJsonRoute(
      Effect.gen(function* () {
        const body = yield* HttpServerRequest.schemaBodyJson(AgentRunInput);
        const agent = yield* AgentService;
        const threads = yield* AgentThreadStore;
        const workspace = yield* WorkspaceService;

        const result = yield* agent.run({
          threadId: body.threadId,
          prompt: body.prompt,
          modelId: body.modelId,
          resourceNames: body.resourceNames,
          quiet: body.quiet,
        });
        const thread = yield* threads.loadThread(result.threadId);
        const workspaceState = yield* workspace
          .getThreadWorkspace(result.threadId)
          .pipe(Effect.orElseSucceed(() => null));

        return {
          run: {
            threadId: result.threadId,
            provider: result.provider,
            modelId: result.modelId,
            resourceNames: result.resourceNames,
            workspaceDir: result.workspaceDir,
            answer: result.answer,
            messageCount: result.messages.length,
          },
          thread,
          workspace: workspaceState,
        };
      }),
    ),
  ),
  HttpRouter.add(
    "POST",
    "/ask",
    Effect.gen(function* () {
      const body = yield* HttpServerRequest.schemaBodyJson(AskInput);
      const agent = yield* AgentService;

      const streamResult = yield* agent.askStream({
        threadId: body.threadId,
        question: body.question,
        modelId: body.modelId,
        resourceNames: body.resourceNames,
        quiet: body.quiet,
      });

      const stream = Stream.fromAsyncIterable(
        (async function* () {
          let sentError = false;

          yield toSseChunk("start", {
            threadId: streamResult.threadId,
            provider: streamResult.provider,
            modelId: streamResult.modelId,
            resourceNames: streamResult.resourceNames,
            workspaceDir: streamResult.workspaceDir,
          });

          try {
            for await (const event of streamResult.events) {
              yield toSseChunk(event.type, {
                threadId: streamResult.threadId,
                event,
              });

              if (event.type === "message_end") {
                const errorMessage = getAssistantErrorMessage(event.message);

                if (errorMessage) {
                  sentError = true;
                  yield toSseChunk("error", {
                    threadId: streamResult.threadId,
                    provider: streamResult.provider,
                    modelId: streamResult.modelId,
                    message: errorMessage,
                  });
                }
              }
            }
          } catch (error) {
            sentError = true;
            yield toSseChunk("error", {
              threadId: streamResult.threadId,
              provider: streamResult.provider,
              modelId: streamResult.modelId,
              message: getErrorMessage(error),
            });
          }

          if (!sentError) {
            yield toSseChunk("done", {
              threadId: streamResult.threadId,
            });
          }
        })(),
        (error) => error,
      );

      return HttpServerResponse.stream(stream, {
        status: 200,
        contentType: "text/event-stream; charset=utf-8",
        headers: {
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }).pipe(Effect.catchCause((cause) => Effect.succeed(jsonError(Cause.squash(cause))))),
  ),
);

const normalizeHostname = (hostname: string) =>
  hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname;

const makeServerLayer = ({
  host = "127.0.0.1",
  port = 0,
}: {
  host?: string;
  port?: number;
} = {}) => {
  const nodeServerLayer = NodeHttpServer.layer(Http.createServer, { host, port });
  const configLayer = ConfigLive;
  const authLayer = AuthService.layer.pipe(Layer.provide(configLayer));
  const resourcesLayer = ResourcesService.layer.pipe(Layer.provide(configLayer));
  const workspaceLayer = WorkspaceService.layer.pipe(Layer.provide(configLayer));
  const threadStoreLayer = AgentThreadStore.layer.pipe(Layer.provide(configLayer));
  const agentDependencies = Layer.mergeAll(
    configLayer,
    authLayer,
    resourcesLayer,
    workspaceLayer,
    threadStoreLayer,
  );
  const agentLayer = AgentService.layer.pipe(Layer.provide(agentDependencies));
  const routeDependencies = Layer.mergeAll(
    nodeServerLayer,
    configLayer,
    authLayer,
    resourcesLayer,
    workspaceLayer,
    threadStoreLayer,
    agentLayer,
  );

  return Layer.mergeAll(
    routeDependencies,
    HttpRouter.serve(RoutesLive).pipe(Layer.provide(routeDependencies)),
  );
};

const startServerBase = ({
  host = "127.0.0.1",
  port = 0,
}: {
  host?: string;
  port?: number;
} = {}) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const services = yield* Layer.buildWithScope(makeServerLayer({ host, port }), scope);
      const server = ServiceMap.get(services, HttpServer.HttpServer);
      const address = server.address;
      const localUrl =
        address._tag === "TcpAddress"
          ? `http://${normalizeHostname(address.hostname)}:${address.port}`
          : address.path;

      return {
        address,
        localUrl,
        scope,
      };
    }),
    ({ scope }) => Effect.orDie(Scope.close(scope, Exit.void)),
  ).pipe(Effect.map(({ scope: _scope, ...server }) => server));

const quietLoggerLayer = Logger.layer([]);

export const startServer = ({
  host = "127.0.0.1",
  port = 0,
  quiet = false,
}: {
  host?: string;
  port?: number;
  quiet?: boolean;
} = {}) => {
  const program = startServerBase({ host, port });

  return quiet ? program.pipe(Effect.provide(quietLoggerLayer)) : program;
};

export const startServerWithLogging = startServer;
