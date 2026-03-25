#!/usr/bin/env node

import { Command } from "@effect/cli";
import * as NodeContext from "@effect/platform-node/NodeContext";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Console, Effect } from "effect";

const hello = Command.make("hello", {}, () => Console.log("hello world")).pipe(
  Command.withDescription("Print a friendly hello world."),
);

const btca = Command.make("btca").pipe(
  Command.withDescription("BTCA command line tools."),
  Command.withSubcommands([hello]),
);

const cli = Command.run(btca, {
  name: "BTCA CLI",
  version: "0.0.0",
});

cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain);
