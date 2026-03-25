#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Cli from "effect/unstable/cli";
import { Server } from "./server.ts";

const serverFlags = {
  port: Cli.Flag.optional(
    Cli.Flag.integer("port").pipe(
      Cli.Flag.withDescription(
        "Start an embedded server on this port. Fails if the port is taken.",
      ),
    ),
  ),
  url: Cli.Flag.optional(
    Cli.Flag.string("url").pipe(
      Cli.Flag.withDescription(
        "Use an existing BTCA server at this URL instead of starting one locally.",
      ),
    ),
  ),
};

const btca = Cli.Command.make("btca").pipe(
  Cli.Command.withDescription("BTCA command line tools."),
  Cli.Command.withSharedFlags(serverFlags),
);

const withServer = <Name extends string, Input, ContextInput, E, R>(
  command: Cli.Command.Command<Name, Input, ContextInput, E, R>,
) =>
  command.pipe(
    Cli.Command.provideEffect(
      Server,
      Effect.gen(function* () {
        const { port, url } = yield* btca;

        return yield* Server.make({ port, url });
      }),
    ),
  );

const hello = withServer(
  Cli.Command.make("hello", {}, () =>
    Effect.gen(function* () {
      const server = yield* Server;
      const response = yield* server.hello("world");

      yield* Console.log(response.message);
    }),
  ),
).pipe(Cli.Command.withDescription("Print a friendly hello world."));

const serve = withServer(
  Cli.Command.make("serve", {}, () =>
    Effect.gen(function* () {
      const server = yield* Server;

      yield* Console.log(server.baseUrl);
      return yield* Effect.never;
    }),
  ),
).pipe(Cli.Command.withDescription("Start the local BTCA HTTP server and keep it running."));

const app = btca.pipe(Cli.Command.withSubcommands([hello, serve]));

const program = Effect.scoped(
  Cli.Command.run(app, {
    version: "0.0.0",
  }),
);

NodeRuntime.runMain(Effect.orDie(Effect.provide(program, NodeServices.layer)));
