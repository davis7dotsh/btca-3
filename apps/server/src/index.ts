import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { startServerWithLogging } from "./server.ts";

const host = process.env.HOST ?? "127.0.0.1";
const STARTUP_ATTEMPTS = 3;
const PORT_RANGE_MIN = 30_000;
const PORT_RANGE_MAX = 60_000;

class ServerStartupError extends Data.TaggedError("ServerStartupError")<{
  readonly message: string;
  readonly attempts: readonly number[];
  readonly cause?: unknown;
}> {}

const randomPort = () =>
  Math.floor(Math.random() * (PORT_RANGE_MAX - PORT_RANGE_MIN + 1)) + PORT_RANGE_MIN;

const createPortAttempts = (count: number) => {
  const ports = new Set<number>();

  while (ports.size < count) {
    ports.add(randomPort());
  }

  return [...ports];
};

const startServerWithRetries = Effect.gen(function* () {
  const attemptedPorts = createPortAttempts(STARTUP_ATTEMPTS);
  let lastError: unknown = null;

  for (const port of attemptedPorts) {
    const attempt = yield* Effect.exit(startServerWithLogging({ host, port }));

    if (Exit.isSuccess(attempt)) {
      return attempt.value;
    }

    lastError = attempt.cause;
  }

  return yield* Effect.fail(
    new ServerStartupError({
      message: `Failed to start the server after ${STARTUP_ATTEMPTS} random port attempts.`,
      attempts: attemptedPorts,
      cause: lastError,
    }),
  );
});

const program = Effect.scoped(
  Effect.gen(function* () {
    const server = yield* startServerWithRetries;

    yield* Console.log(server.localUrl);
    return yield* Effect.never;
  }),
);

const main = program.pipe(Effect.provide(NodeServices.layer), Effect.orDie) as Effect.Effect<
  never,
  never,
  never
>;

NodeRuntime.runMain(main);
