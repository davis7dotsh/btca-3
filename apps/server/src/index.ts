import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { startServer } from "./server.ts";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "3001");

const program = Effect.scoped(
  Effect.gen(function* () {
    const server = yield* startServer({ host, port });

    yield* Console.log(server.localUrl);
    return yield* Effect.never;
  }),
);

NodeRuntime.runMain(Effect.orDie(Effect.provide(program, NodeServices.layer)));
