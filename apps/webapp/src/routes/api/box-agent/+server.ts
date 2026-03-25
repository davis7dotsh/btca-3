import { json, type RequestHandler } from "@sveltejs/kit";
import { Data, Effect, Schema, Stream } from "effect";
import { runtime } from "$lib/runtime";
import { AuthService } from "$lib/services/auth";
import { BoxServiceError } from "$lib/services/box";
import { BoxThreadChatService } from "$lib/services/boxThreadChat";
import { ConvexError } from "$lib/services/convex";
import type { AgentPromptStreamEvent } from "$lib/types/agent";

class AgentAsyncIterableError extends Schema.TaggedErrorClass<AgentAsyncIterableError>()(
  "AgentAsyncIterableError",
  {
    cause: Schema.Defect,
  },
) {}

class AgentRequestError extends Data.TaggedError("AgentRequestError")<{
  readonly status: number;
  readonly message: string;
  readonly cause?: unknown;
}> {}

const PromptThreadAgentRequestInputSchema = Schema.Struct({
  threadId: Schema.NonEmptyString,
  prompt: Schema.NonEmptyString,
  modelId: Schema.optional(Schema.NonEmptyString),
});

export const POST: RequestHandler = async (event) => {
  try {
    const stream = await runtime.runPromise(
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
        const body = yield* Effect.tryPromise({
          try: () => event.request.json(),
          catch: (cause) =>
            new AgentRequestError({
              status: 400,
              message: "Expected a JSON body.",
              cause,
            }),
        }).pipe(
          Effect.flatMap((parsedBody) =>
            Schema.decodeUnknownEffect(PromptThreadAgentRequestInputSchema)(parsedBody).pipe(
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
        const boxThread = yield* BoxThreadChatService;
        const { events, threadId } = yield* boxThread.promptThreadBox({
          threadId: body.threadId,
          userId: user.userId,
          prompt: body.prompt,
          modelId: body.modelId,
        });

        const eventStream = Stream.fromAsyncIterable(
          events,
          (cause) => new AgentAsyncIterableError({ cause }),
        ).pipe(
          Stream.tap((streamEvent) =>
            Effect.sync(() => {
              if (streamEvent.type === "done") {
                console.log("Box chat stream delivered to client", { threadId });
              }
            }),
          ),
          Stream.map(toServerSentEvent),
          Stream.encodeText,
        );

        const readableStream: ReadableStream<Uint8Array> =
          yield* Stream.toReadableStreamEffect(eventStream);

        return readableStream;
      }),
    );

    return new Response(stream, {
      headers: {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
      },
    });
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
      console.error("Box chat error", {
        traceId: error.traceId,
        kind: error.kind,
        message: error.message,
      });

      return json({ message: error.message }, { status: 500 });
    }

    if (error instanceof ConvexError) {
      console.error("Convex error during box chat", {
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

const toServerSentEvent = (streamEvent: AgentPromptStreamEvent) =>
  `data: ${JSON.stringify(streamEvent)}\n\n`;
