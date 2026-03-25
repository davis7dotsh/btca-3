#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Cli from "effect/unstable/cli";
import { createRequire } from "node:module";
import { Server } from "./server.ts";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

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

const hello = Cli.Command.make("hello", {}, () =>
  Effect.gen(function* () {
    const server = yield* Server;
    const response = yield* server.hello("world");

    yield* Console.log(response.message);
  }),
).pipe(Cli.Command.withDescription("Print a friendly hello world."));

const serve = Cli.Command.make("serve", {}, () =>
  Effect.gen(function* () {
    const server = yield* Server;

    yield* Console.log(server.baseUrl);
    return yield* Effect.never;
  }),
).pipe(Cli.Command.withDescription("Start the local BTCA HTTP server and keep it running."));

const app = btca.pipe(
  Cli.Command.withSubcommands([hello, serve]),
  Cli.Command.provideEffect(Server, ({ port, url }) => Server.make({ port, url })),
);

const program = Effect.scoped(
  Cli.Command.run(app, {
    version,
  }),
);

NodeRuntime.runMain(Effect.orDie(Effect.provide(program, NodeServices.layer)));
