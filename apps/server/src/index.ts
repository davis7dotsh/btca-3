import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Http from "node:http";

const port = Number(process.env.PORT ?? "3001");

const RoutesLive = Layer.mergeAll(
  HttpRouter.add("GET", "/", HttpServerResponse.text("Hello, world! from @btca/server\n")),
  HttpRouter.add(
    "GET",
    "/health",
    HttpServerResponse.json({
      ok: true,
      name: "@btca/server",
    }),
  ),
  HttpRouter.add(
    "GET",
    "/hello/:name",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;

      return HttpServerResponse.text(`Hello, ${params.name ?? "world"}! from @btca/server\n`);
    }),
  ),
);

const ServerLive = HttpRouter.serve(RoutesLive).pipe(
  Layer.provide(NodeHttpServer.layer(Http.createServer, { port })),
);

NodeRuntime.runMain(Layer.launch(ServerLive));
