#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Cli from "effect/unstable/cli";
import { createRequire } from "node:module";
import util from "node:util";
import { Server } from "./server.ts";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const serverFlags = {
  debug: Cli.Flag.boolean("debug").pipe(
    Cli.Flag.withDescription("Print embedded server logs and request debugging output."),
  ),
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

const truncate = (value: string, max = 160) =>
  value.length <= max ? value : `${value.slice(0, max - 1)}...`;

const formatToolArgs = (value: unknown) => {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return truncate(value);
  }

  return truncate(
    util.inspect(value, {
      depth: 3,
      breakLength: 120,
      compact: true,
      sorted: true,
    }),
  );
};

const formatStart = (payload: Record<string, unknown>) => {
  const provider = typeof payload.provider === "string" ? payload.provider : "unknown";
  const modelId = typeof payload.modelId === "string" ? payload.modelId : "unknown";
  const threadId = typeof payload.threadId === "string" ? payload.threadId : "unknown";
  const workspaceDir = typeof payload.workspaceDir === "string" ? payload.workspaceDir : "unknown";
  const resourceNames = Array.isArray(payload.resourceNames)
    ? payload.resourceNames.filter((value): value is string => typeof value === "string")
    : [];

  return [
    "Agent ready",
    `  model: ${provider}/${modelId}`,
    `  thread: ${threadId}`,
    `  resources: ${resourceNames.join(", ") || "none"}`,
    `  workspace: ${workspaceDir}`,
    "",
  ].join("\n");
};

const parseSseEvent = (rawEvent: string) => {
  const lines = rawEvent.split(/\r?\n/);
  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  const rawData = dataLines.join("\n");
  const data =
    rawData.length === 0
      ? null
      : (() => {
          try {
            return JSON.parse(rawData) as unknown;
          } catch {
            return rawData;
          }
        })();

  return {
    eventName,
    data,
  };
};

const printAskStream = (stream: ReadableStream<Uint8Array>) =>
  Effect.tryPromise({
    try: async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantLineOpen = false;

      const ensureTrailingBreak = () => {
        if (assistantLineOpen) {
          process.stdout.write("\n");
          assistantLineOpen = false;
        }
      };

      const printTool = (label: string, args: unknown) => {
        ensureTrailingBreak();
        const renderedArgs = formatToolArgs(args);
        process.stdout.write(renderedArgs.length > 0 ? `${label} ${renderedArgs}\n` : `${label}\n`);
      };

      const handleEvent = (eventName: string, data: unknown) => {
        if (eventName === "start" && data && typeof data === "object") {
          ensureTrailingBreak();
          process.stdout.write(`${formatStart(data as Record<string, unknown>)}`);
          return;
        }

        if (eventName === "done") {
          ensureTrailingBreak();
          process.stdout.write("\nDone.\n");
          return;
        }

        if (!data || typeof data !== "object" || !("event" in data)) {
          return;
        }

        const outerEvent = data.event;

        if (!outerEvent || typeof outerEvent !== "object" || !("type" in outerEvent)) {
          return;
        }

        if (outerEvent.type === "message_update") {
          const assistantMessageEvent =
            "assistantMessageEvent" in outerEvent ? outerEvent.assistantMessageEvent : null;

          if (
            assistantMessageEvent &&
            typeof assistantMessageEvent === "object" &&
            "type" in assistantMessageEvent
          ) {
            if (assistantMessageEvent.type === "text_delta") {
              const delta =
                "delta" in assistantMessageEvent && typeof assistantMessageEvent.delta === "string"
                  ? assistantMessageEvent.delta
                  : "";

              if (!assistantLineOpen) {
                ensureTrailingBreak();
                process.stdout.write("Assistant: ");
                assistantLineOpen = true;
              }

              process.stdout.write(delta);
              return;
            }

            if (assistantMessageEvent.type === "toolcall_end") {
              const toolCall =
                "toolCall" in assistantMessageEvent ? assistantMessageEvent.toolCall : null;

              if (toolCall && typeof toolCall === "object" && "name" in toolCall) {
                const name = typeof toolCall.name === "string" ? toolCall.name : "tool";
                const args =
                  "arguments" in toolCall && toolCall.arguments !== null
                    ? toolCall.arguments
                    : undefined;
                printTool(`Tool: ${name}`, args);
              }
            }
          }

          return;
        }

        if (outerEvent.type === "message_end") {
          const message = "message" in outerEvent ? outerEvent.message : null;

          if (message && typeof message === "object" && "role" in message) {
            if (message.role === "assistant" && assistantLineOpen) {
              process.stdout.write("\n");
              assistantLineOpen = false;
            }
          }
        }
      };

      for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });

        while (true) {
          const boundaryIndex = buffer.indexOf("\n\n");

          if (boundaryIndex === -1) {
            break;
          }

          const rawEvent = buffer.slice(0, boundaryIndex).trim();
          buffer = buffer.slice(boundaryIndex + 2);

          if (rawEvent.length === 0) {
            continue;
          }

          const parsedEvent = parseSseEvent(rawEvent);
          handleEvent(parsedEvent.eventName, parsedEvent.data);
        }
      }

      buffer += decoder.decode();

      const remainingEvent = buffer.trim();

      if (remainingEvent.length > 0) {
        const parsedEvent = parseSseEvent(remainingEvent);
        handleEvent(parsedEvent.eventName, parsedEvent.data);
      }

      ensureTrailingBreak();
    },
    catch: (cause) =>
      new Error(
        cause instanceof Error ? cause.message : "Failed to print the /ask response stream.",
      ),
  });

const ask = Cli.Command.make(
  "ask",
  {
    question: Cli.Flag.string("question").pipe(
      Cli.Flag.withAlias("q"),
      Cli.Flag.withDescription("Question to send to the local BTCA agent."),
    ),
    resources: Cli.Flag.string("resource").pipe(
      Cli.Flag.withAlias("r"),
      Cli.Flag.atLeast(1),
      Cli.Flag.withDescription(
        "Configured resource name to load. Repeat -r for multiple resources.",
      ),
    ),
  },
  ({ question, resources }) =>
    Effect.gen(function* () {
      const server = yield* Server;
      const stream = yield* server.askStream({
        question,
        resourceNames: resources,
      });

      yield* printAskStream(stream);
    }),
).pipe(
  Cli.Command.withDescription(
    "Ask the local BTCA agent a question and print a readable live transcript.",
  ),
);

const app = btca.pipe(
  Cli.Command.withSubcommands([hello, serve, ask]),
  Cli.Command.provideEffect(Server, ({ port, url, debug }) => Server.make({ port, url, debug })),
);

const program = Effect.scoped(
  Cli.Command.run(app, {
    version,
  }),
);

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer), Effect.orDie));
