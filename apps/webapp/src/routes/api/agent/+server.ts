import { waitUntil } from "@vercel/functions";
import { json, type RequestHandler } from "@sveltejs/kit";
import { Data, Effect, Schema } from "effect";
import { runtime } from "$lib/runtime";
import { normalizeAgentEvent } from "$lib/services/agentStreamEvents";
import { AgentService } from "$lib/services/agent";
import { AutumnService } from "$lib/services/autumn";
import { AuthService } from "$lib/services/auth";
import { BoxServiceError } from "$lib/services/box";
import { getRateLimitHeaders, RateLimitService } from "$lib/services/rateLimit";
import { RunControlService, RunKilledError } from "$lib/services/runControl";
import { RunStreamService } from "$lib/services/runStream";
import type { AgentPromptStreamEvent, AgentRunStartResponse } from "$lib/types/agent";

class AgentRequestError extends Data.TaggedError("AgentRequestError")<{
  readonly status: number;
  readonly message: string;
  readonly headers?: Record<string, string>;
  readonly cause?: unknown;
}> {}

const PromptThreadAgentRequestInputSchema = Schema.Struct({
  threadId: Schema.NonEmptyString,
  prompt: Schema.NonEmptyString,
  modelId: Schema.optional(Schema.NonEmptyString),
  attachmentIds: Schema.optional(Schema.Array(Schema.NonEmptyString)),
});

const DELTA_FLUSH_INTERVAL_MS = 150;
type AssistantTextDeltaUsage = Extract<
  AgentPromptStreamEvent,
  { type: "assistant_text_delta" }
>["usage"];

const appendRunErrorEvent = ({
  runId,
  threadId,
  message,
}: {
  runId: string;
  threadId: string;
  message: string;
}) =>
  Effect.gen(function* () {
    const runStream = yield* RunStreamService;

    yield* runStream.appendEvent({
      runId,
      event: {
        type: "run_error",
        message,
        timestamp: Date.now(),
      } satisfies AgentPromptStreamEvent,
    });
    yield* runStream.markFailed({
      runId,
      threadId,
      message,
    });
  });

const executeAgentRun = ({
  runId,
  userId,
  body,
}: {
  runId: string;
  userId: string;
  body: Schema.Schema.Type<typeof PromptThreadAgentRequestInputSchema>;
}) =>
  Effect.gen(function* () {
    const runStream = yield* RunStreamService;
    const runControl = yield* RunControlService;
    const agent = yield* AgentService;
    try {
      const execution = yield* agent
        .promptThread({
          ...body,
          runId,
          userId,
        })
        .pipe(Effect.catchTag("RunKilledError", () => Effect.succeed(null)));

      if (execution === null) {
        return;
      }
      runControl.setSandboxId(runId, execution.sandboxId);

      yield* runStream.markRunning({
        runId,
        sandboxId: execution.sandboxId,
        model: execution.model,
      });
      yield* runStream.appendEvent({
        runId,
        event: {
          type: "ready",
          threadId: execution.threadId,
          sandboxId: execution.sandboxId,
          model: execution.model,
          timestamp: Date.now(),
        },
      });

      yield* Effect.tryPromise({
        try: async () => {
          let pendingAssistantDelta = "";
          let pendingAssistantUsage: AssistantTextDeltaUsage = null;
          let pendingAssistantTimestamp: number | null = null;
          let pendingReasoningDelta = "";
          let pendingReasoningTimestamp: number | null = null;
          let pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;
          let pendingFlushPromise: Promise<void> | null = null;
          let pendingFlushError: unknown = null;

          const flushPendingDeltas = async () => {
            if (pendingFlushTimer) {
              clearTimeout(pendingFlushTimer);
              pendingFlushTimer = null;
            }

            if (pendingFlushPromise) {
              return pendingFlushPromise;
            }

            const batchedEvents: AgentPromptStreamEvent[] = [];

            if (pendingReasoningDelta.length > 0 && pendingReasoningTimestamp !== null) {
              batchedEvents.push({
                type: "reasoning_delta",
                delta: pendingReasoningDelta,
                timestamp: pendingReasoningTimestamp,
              });
            }

            if (pendingAssistantDelta.length > 0 && pendingAssistantTimestamp !== null) {
              batchedEvents.push({
                type: "assistant_text_delta",
                delta: pendingAssistantDelta,
                usage: pendingAssistantUsage,
                timestamp: pendingAssistantTimestamp,
              });
            }

            pendingReasoningDelta = "";
            pendingReasoningTimestamp = null;
            pendingAssistantDelta = "";
            pendingAssistantUsage = null;
            pendingAssistantTimestamp = null;

            if (batchedEvents.length === 0) {
              return;
            }

            pendingFlushPromise = runtime
              .runPromise(
                Effect.gen(function* () {
                  const backgroundRunStream = yield* RunStreamService;
                  yield* backgroundRunStream.appendEvents({
                    runId,
                    events: batchedEvents,
                  });
                }),
              )
              .catch((cause) => {
                pendingFlushError = cause;
                throw cause;
              })
              .finally(() => {
                pendingFlushPromise = null;
              });

            return pendingFlushPromise;
          };

          const schedulePendingFlush = () => {
            if (pendingFlushTimer || pendingFlushPromise) {
              return;
            }

            pendingFlushTimer = setTimeout(() => {
              void flushPendingDeltas().catch(() => undefined);
            }, DELTA_FLUSH_INTERVAL_MS);
          };

          const appendImmediateEvents = async (events: readonly AgentPromptStreamEvent[]) => {
            if (events.length === 0) {
              return;
            }

            await flushPendingDeltas();
            await runtime.runPromise(
              Effect.gen(function* () {
                const backgroundRunStream = yield* RunStreamService;
                yield* backgroundRunStream.appendEvents({
                  runId,
                  events,
                });
              }),
            );
          };

          try {
            for await (const agentEvent of execution.events) {
              runControl.throwIfAborted({
                runId,
                threadId: body.threadId,
                message: "The agent run was stopped.",
              });

              if (pendingFlushError) {
                throw pendingFlushError;
              }

              const normalizedEvents = normalizeAgentEvent(agentEvent);

              const immediateEvents: AgentPromptStreamEvent[] = [];

              for (const normalizedEvent of normalizedEvents) {
                if (normalizedEvent.type === "assistant_text_delta") {
                  pendingAssistantDelta += normalizedEvent.delta;
                  pendingAssistantUsage = normalizedEvent.usage;
                  pendingAssistantTimestamp = normalizedEvent.timestamp;
                  schedulePendingFlush();
                  continue;
                }

                if (normalizedEvent.type === "reasoning_delta") {
                  pendingReasoningDelta += normalizedEvent.delta;
                  pendingReasoningTimestamp = normalizedEvent.timestamp;
                  schedulePendingFlush();
                  continue;
                }

                immediateEvents.push(normalizedEvent);
              }

              await appendImmediateEvents(immediateEvents);
            }

            if (pendingFlushError) {
              throw pendingFlushError;
            }

            await flushPendingDeltas();

            await runtime.runPromise(
              Effect.gen(function* () {
                const backgroundRunStream = yield* RunStreamService;
                yield* backgroundRunStream.markCompleted({
                  runId,
                  threadId: body.threadId,
                });
              }),
            );
          } catch (cause) {
            if (pendingFlushTimer) {
              clearTimeout(pendingFlushTimer);
              pendingFlushTimer = null;
            }

            if (cause instanceof RunKilledError) {
              return;
            }

            const message = cause instanceof Error ? cause.message : "The agent run failed.";

            await runtime.runPromise(
              appendRunErrorEvent({
                runId,
                threadId: body.threadId,
                message,
              }),
            );

            throw cause;
          }
        },
        catch: (cause) =>
          new AgentRequestError({
            status: 500,
            message: cause instanceof Error ? cause.message : "The agent run failed.",
            cause,
          }),
      });
    } finally {
      runControl.clearRun(runId);
    }
  });

export const POST: RequestHandler = async (event) => {
  try {
    const response = await runtime.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthService;
        const rateLimit = yield* RateLimitService;
        const user = yield* auth.validateSession(event).pipe(
          Effect.mapError(
            (error) =>
              new AgentRequestError({
                status: 401,
                message: "Unauthorized",
                cause: error,
              }),
          ),
        );
        const webChatRateLimit = yield* rateLimit.checkWebChat(user.userId);
        waitUntil(webChatRateLimit.pending);

        if (!webChatRateLimit.allowed) {
          return yield* Effect.fail(
            new AgentRequestError({
              status: 429,
              message: "Rate limit exceeded. Web chat is limited to 1 message per second.",
              headers: {
                "cache-control": "no-store",
                ...getRateLimitHeaders(webChatRateLimit),
              },
              cause: webChatRateLimit,
            }),
          );
        }

        const autumn = yield* AutumnService;
        const runControl = yield* RunControlService;
        const runStream = yield* RunStreamService;
        const body = yield* Effect.tryPromise({
          try: () => event.request.json(),
          catch: (cause) =>
            new AgentRequestError({
              status: 400,
              message: "Expected a JSON body.",
              cause,
            }),
        }).pipe(
          Effect.flatMap((value) =>
            Schema.decodeUnknownEffect(PromptThreadAgentRequestInputSchema)(value).pipe(
              Effect.mapError(
                (cause) =>
                  new AgentRequestError({
                    status: 400,
                    message: "Expected non-empty threadId and prompt strings.",
                    cause,
                  }),
              ),
            ),
          ),
        );
        const allowed = yield* autumn.checkUsageBalance({
          userId: user.userId,
          email: user.email,
          name: user.user.firstName,
          requiredBalance: 0.000001,
        });

        if (!allowed) {
          return yield* Effect.fail(
            new AgentRequestError({
              status: 402,
              message: "No usage remaining. Upgrade to Pro to continue.",
            }),
          );
        }

        const run = yield* runStream.createRun({
          threadId: body.threadId,
          userId: user.userId,
          prompt: body.prompt,
          attachmentIds: body.attachmentIds ?? [],
        });
        runControl.registerRun({
          runId: run.runId,
          threadId: body.threadId,
          userId: user.userId,
        });

        waitUntil(
          runtime.runPromise(
            executeAgentRun({
              runId: run.runId,
              userId: user.userId,
              body,
            }),
          ),
        );

        return {
          runId: run.runId,
          threadId: body.threadId,
          streamPath: `/api/agent/runs/${encodeURIComponent(run.runId)}/stream`,
        } satisfies AgentRunStartResponse;
      }),
    );

    return json(response);
  } catch (error) {
    if (error instanceof AgentRequestError) {
      if (error.status === 401) {
        console.error("Unauthorized agent request", {
          error: error.cause instanceof Error ? error.cause.message : String(error.cause),
        });
      }

      return json(
        {
          message: error.message,
        },
        {
          status: error.status,
          headers: error.headers,
        },
      );
    }

    if (error instanceof BoxServiceError) {
      console.error("Failed to start agent stream", {
        traceId: error.traceId,
        kind: error.kind,
        message: error.message,
      });

      return json({ message: error.message }, { status: 500 });
    }

    console.error("Failed to start agent stream", {
      error: error instanceof Error ? error.message : String(error),
    });

    return json(
      {
        message: "Failed to start the agent stream.",
      },
      { status: 500 },
    );
  }
};
