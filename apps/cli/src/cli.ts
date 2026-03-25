#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Cli from "effect/unstable/cli";

const hello = Cli.Command.make("hello", {}, () => Console.log("hello world")).pipe(
  Cli.Command.withDescription("Print a friendly hello world."),
);

const btca = Cli.Command.make("btca").pipe(
  Cli.Command.withDescription("BTCA command line tools."),
  Cli.Command.withSubcommands([hello]),
);

const cli = Cli.Command.run(btca, {
  version: "0.0.0",
});

cli.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
