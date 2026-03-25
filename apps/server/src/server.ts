import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ServiceMap from "effect/ServiceMap";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Http from "node:http";

export interface HealthResponse {
  readonly ok: true;
  readonly name: "@btca/server";
}

export interface HelloResponse {
  readonly message: string;
}

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

  return Layer.mergeAll(
    nodeServerLayer,
    HttpRouter.serve(RoutesLive).pipe(Layer.provide(nodeServerLayer)),
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
