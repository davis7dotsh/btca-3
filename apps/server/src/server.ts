import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ServiceMap from "effect/ServiceMap";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Http from "node:http";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import { ConfigLive } from "./config.ts";
import { AgentService, AgentError } from "./agent/service.ts";
import { AgentThreadStore, ThreadStoreError } from "./agent/threads.ts";
import { AuthError, AuthService } from "./auth/service.ts";
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

const OpenAiApiKeyInput = Schema.Struct({
  apiKey: Schema.NonEmptyString,
});

const AgentRunInput = Schema.Struct({
  threadId: Schema.optional(Schema.NonEmptyString),
  prompt: Schema.NonEmptyString,
  modelId: Schema.optional(Schema.NonEmptyString),
  resourceNames: Schema.optional(Schema.Array(Schema.NonEmptyString)),
});

const AskInput = Schema.Struct({
  threadId: Schema.optional(Schema.NonEmptyString),
  question: Schema.NonEmptyString,
  modelId: Schema.optional(Schema.NonEmptyString),
  resourceNames: Schema.Array(Schema.NonEmptyString),
});

const ThreadPathParams = Schema.Struct({
  threadId: Schema.NonEmptyString,
});

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
    "/auth/openai",
    handleJsonRoute(
      Effect.gen(function* () {
        const body = yield* HttpServerRequest.schemaBodyJson(OpenAiApiKeyInput);
        const auth = yield* AuthService;
        yield* auth.setApiKey(body.apiKey);
        return {
          auth: yield* auth.getAuthState,
        };
      }),
    ),
  ),
  HttpRouter.add(
    "DELETE",
    "/auth/openai",
    handleJsonRoute(
      Effect.gen(function* () {
        const auth = yield* AuthService;
        yield* auth.clearApiKey;
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

        const result = yield* agent.run(body);
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
      });

      const stream = Stream.fromAsyncIterable(
        (async function* () {
          yield toSseChunk("start", {
            threadId: streamResult.threadId,
            provider: streamResult.provider,
            modelId: streamResult.modelId,
            resourceNames: streamResult.resourceNames,
            workspaceDir: streamResult.workspaceDir,
          });

          for await (const event of streamResult.events) {
            yield toSseChunk(event.type, {
              threadId: streamResult.threadId,
              event,
            });
          }

          yield toSseChunk("done", {
            threadId: streamResult.threadId,
          });
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

export const startServer = ({
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
