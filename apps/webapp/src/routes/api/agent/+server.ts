import { waitUntil } from "@vercel/functions";
import { json, type RequestHandler } from "@sveltejs/kit";
import { Data, Effect, Schema } from "effect";
import { runtime } from "$lib/runtime";
import { normalizeAgentEvent } from "$lib/services/agentStreamEvents";
import { AgentService } from "$lib/services/agent";
import { AutumnService } from "$lib/services/autumn";
import { AuthService } from "$lib/services/auth";
import { BoxServiceError } from "$lib/services/box";
import { RunStreamService } from "$lib/services/runStream";
import type { AgentPromptStreamEvent, AgentRunStartResponse } from "$lib/types/agent";

class AgentRequestError extends Data.TaggedError("AgentRequestError")<{
  readonly status: number;
  readonly message: string;
  readonly cause?: unknown;
}> {}

const PromptThreadAgentRequestInputSchema = Schema.Struct({
  threadId: Schema.NonEmptyString,
  prompt: Schema.NonEmptyString,
  modelId: Schema.optional(Schema.NonEmptyString),
  attachmentIds: Schema.optional(Schema.Array(Schema.NonEmptyString)),
});

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
    const agent = yield* AgentService;
    const executionExit = yield* Effect.exit(
      agent.promptThread({
        ...body,
        userId,
      }),
    );

    if (executionExit._tag === "Failure") {
      const message = "The agent run failed.";

      yield* appendRunErrorEvent({
        runId,
        threadId: body.threadId,
        message,
      });

      return yield* Effect.fail(
        new AgentRequestError({
          status: 500,
          message,
          cause: executionExit.cause,
        }),
      );
    }

    const execution = executionExit.value;

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
        try {
          for await (const agentEvent of execution.events) {
            const normalizedEvents = normalizeAgentEvent(agentEvent);

            for (const normalizedEvent of normalizedEvents) {
              await runtime.runPromise(
                Effect.gen(function* () {
                  const backgroundRunStream = yield* RunStreamService;
                  yield* backgroundRunStream.appendEvent({
                    runId,
                    event: normalizedEvent,
                  });
                }),
              );
            }
          }

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
  });

export const POST: RequestHandler = async (event) => {
  try {
    const response = await runtime.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthService;
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
        const autumn = yield* AutumnService;
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
        { status: error.status },
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
