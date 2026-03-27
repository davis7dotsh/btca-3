import { json, type RequestHandler } from "@sveltejs/kit";
import { Data, Effect } from "effect";
import { runtime } from "$lib/runtime";
import { toServerSentEvent } from "$lib/services/agentStreamEvents";
import {
  RUN_STREAM_REPLAY_BATCH_SIZE,
  createRunSubscriber,
  type RunStreamEventRecord,
} from "$lib/services/runStream";
import { AuthService } from "$lib/services/auth";
import { RunStreamService } from "$lib/services/runStream";

class AgentRunStreamRequestError extends Data.TaggedError("AgentRunStreamRequestError")<{
  readonly status: number;
  readonly message: string;
  readonly cause?: unknown;
}> {}

const HEARTBEAT_INTERVAL_MS = 15_000;
const FALLBACK_REPLAY_INTERVAL_MS = 5_000;

const encoder = new TextEncoder();

const encodeComment = (value: string) => encoder.encode(`: ${value}\n\n`);

export const GET: RequestHandler = async (event) => {
  try {
    const { userId } = await runtime.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthService;
        const runStream = yield* RunStreamService;
        const user = yield* auth.validateSession(event).pipe(
          Effect.mapError(
            (error) =>
              new AgentRunStreamRequestError({
                status: 401,
                message: "Unauthorized",
                cause: error,
              }),
          ),
        );
        const runId = event.params.runId;

        if (!runId) {
          return yield* Effect.fail(
            new AgentRunStreamRequestError({
              status: 400,
              message: "Expected a runId route param.",
            }),
          );
        }

        const meta = yield* runStream.getRunMeta(runId);

        if (meta === null || meta.userId !== user.userId) {
          return yield* Effect.fail(
            new AgentRunStreamRequestError({
              status: 404,
              message: "The requested run was not found.",
            }),
          );
        }

        return {
          userId: user.userId,
        };
      }),
    );

    const runId = event.params.runId;
    const after = event.url.searchParams.get("after");

    if (!runId) {
      return json({ message: "Expected a runId route param." }, { status: 400 });
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let currentEventId = after;
        let closed = false;
        let isFlushing = false;
        let flushRequested = false;
        let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
        let replayTimer: ReturnType<typeof setInterval> | null = null;
        let subscriber: ReturnType<typeof createRunSubscriber> | null = null;

        const enqueueChunk = (chunk: Uint8Array) => {
          if (closed) {
            return;
          }

          try {
            controller.enqueue(chunk);
          } catch {
            close();
          }
        };

        const close = () => {
          if (closed) {
            return;
          }

          closed = true;

          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }

          if (replayTimer) {
            clearInterval(replayTimer);
            replayTimer = null;
          }

          if (subscriber) {
            subscriber.removeAllListeners();
            void subscriber.unsubscribe().catch(() => undefined);
            subscriber = null;
          }

          try {
            controller.close();
          } catch {
            // The request may have aborted and closed the controller already.
          }
        };

        const enqueueEntries = (entries: readonly RunStreamEventRecord[]) => {
          for (const entry of entries) {
            currentEventId = entry.id;
            enqueueChunk(encoder.encode(toServerSentEvent(entry)));

            if (closed) {
              return;
            }

            if (
              entry.isTerminal ||
              entry.event.type === "done" ||
              entry.event.type === "run_error"
            ) {
              close();
              return;
            }
          }
        };

        const flush = async () => {
          if (closed) {
            return;
          }

          if (isFlushing) {
            flushRequested = true;
            return;
          }

          isFlushing = true;

          try {
            do {
              flushRequested = false;
              const entries = await runtime.runPromise(
                Effect.gen(function* () {
                  const runStream = yield* RunStreamService;

                  return yield* runStream.replayAfter({
                    runId,
                    after: currentEventId,
                    limit: RUN_STREAM_REPLAY_BATCH_SIZE,
                  });
                }),
              );

              if (entries.length === 0) {
                const meta = await runtime.runPromise(
                  Effect.gen(function* () {
                    const runStream = yield* RunStreamService;

                    return yield* runStream.getRunMeta(runId);
                  }),
                );

                if (
                  meta?.status === "completed" ||
                  meta?.status === "failed" ||
                  meta === null ||
                  meta.userId !== userId
                ) {
                  close();
                }

                break;
              }

              enqueueEntries(entries);
            } while (!closed && flushRequested);
          } catch (cause) {
            console.error("Failed to stream agent run events", {
              runId,
              error: cause instanceof Error ? cause.message : String(cause),
            });

            close();
          } finally {
            isFlushing = false;
          }
        };

        enqueueChunk(encodeComment("connected"));
        heartbeatTimer = setInterval(() => {
          if (!closed) {
            enqueueChunk(encodeComment("keep-alive"));
          }
        }, HEARTBEAT_INTERVAL_MS);
        replayTimer = setInterval(() => {
          void flush();
        }, FALLBACK_REPLAY_INTERVAL_MS);

        subscriber = createRunSubscriber(runId);
        subscriber.on("message", () => {
          void flush();
        });
        subscriber.on("error", (cause) => {
          console.error("Agent run subscriber error", {
            runId,
            error: cause instanceof Error ? cause.message : String(cause),
          });
          void flush();
        });

        event.request.signal.addEventListener(
          "abort",
          () => {
            close();
          },
          { once: true },
        );

        void flush();
      },
      cancel() {
        return undefined;
      },
    });

    return new Response(stream, {
      headers: {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    if (error instanceof AgentRunStreamRequestError) {
      return json({ message: error.message }, { status: error.status });
    }

    console.error("Failed to start the agent run stream", {
      error: error instanceof Error ? error.message : String(error),
    });

    return json({ message: "Failed to start the agent run stream." }, { status: 500 });
  }
};
