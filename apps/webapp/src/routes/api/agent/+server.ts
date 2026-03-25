import { json, type RequestHandler } from "@sveltejs/kit";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { Data, Effect, Schema, Stream } from "effect";
import { runtime } from "$lib/runtime";
import { AgentService } from "$lib/services/agent";
import { AuthService } from "$lib/services/auth";
import { BoxServiceError } from "$lib/services/box";
import {
  isSandboxExecuteCommandResult,
  isSandboxReadFileResult,
  isExecCommandToolArgs,
  isReadFileToolArgs,
  type AgentPromptStreamEvent,
} from "$lib/types/agent";

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseJsonValue = (value: unknown) => {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const parseReadFileArgs = (value: unknown) => {
  const parsed = parseJsonValue(value);
  return isReadFileToolArgs(parsed) ? parsed : null;
};

const parseExecCommandArgs = (value: unknown) => {
  const parsed = parseJsonValue(value);
  return isExecCommandToolArgs(parsed) ? parsed : null;
};

const extractTextContent = (value: unknown) => {
  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .flatMap((part) => {
      if (
        typeof part === "object" &&
        part !== null &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return [part.text];
      }

      return [];
    })
    .join("\n\n");
};

const normalizeAgentEvent = (event: AgentEvent): AgentPromptStreamEvent | null => {
  const timestamp = Date.now();

  switch (event.type) {
    case "message_update":
      if (event.assistantMessageEvent.type !== "text_delta") {
        return null;
      }

      return {
        type: "assistant_text_delta",
        delta: event.assistantMessageEvent.delta,
        usage: event.assistantMessageEvent.partial.usage,
        timestamp,
      };
    case "message_end": {
      if (event.message.role !== "assistant") {
        return null;
      }

      const content = extractTextContent(event.message.content);

      return {
        type: "assistant_message",
        content,
        usage: event.message.usage,
        api: event.message.api,
        provider: event.message.provider,
        model: event.message.model,
        errorMessage: event.message.errorMessage,
        timestamp,
      };
    }
    case "tool_execution_start":
      if (event.toolName === "read_file") {
        return {
          type: "tool_call_start",
          toolType: "read_file",
          toolCallId: event.toolCallId,
          args: parseReadFileArgs(event.args),
          timestamp,
        };
      }

      if (event.toolName === "exec_command") {
        return {
          type: "tool_call_start",
          toolType: "exec_command",
          toolCallId: event.toolCallId,
          args: parseExecCommandArgs(event.args),
          timestamp,
        };
      }

      return {
        type: "tool_call_start",
        toolType: "unknown",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        args: event.args,
        timestamp,
      };
    case "tool_execution_end": {
      const result = isRecord(event.result) ? event.result : null;
      const details = parseJsonValue(result?.details);
      const content = extractTextContent(result?.content);

      if (event.toolName === "read_file") {
        return {
          type: "tool_call_end",
          toolType: "read_file",
          toolCallId: event.toolCallId,
          isError: event.isError,
          content,
          details: isSandboxReadFileResult(details) ? details : null,
          timestamp,
        };
      }

      if (event.toolName === "exec_command") {
        const normalizedDetails = isSandboxExecuteCommandResult(details) ? details : null;

        return {
          type: "tool_call_end",
          toolType: "exec_command",
          toolCallId: event.toolCallId,
          isError: event.isError || (normalizedDetails?.exitCode ?? 0) !== 0,
          content,
          details: normalizedDetails,
          timestamp,
        };
      }

      return {
        type: "tool_call_end",
        toolType: "unknown",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        isError: event.isError,
        content,
        details,
        timestamp,
      };
    }
    case "agent_end":
      return {
        type: "done",
        timestamp,
      };
    default:
      return null;
  }
};

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
          Effect.flatMap((body) =>
            Schema.decodeUnknownEffect(PromptThreadAgentRequestInputSchema)(body).pipe(
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
        const agent = yield* AgentService;
        const { events, sandboxId, threadId, model } = yield* agent.promptThread({
          ...body,
          userId: user.userId,
        });
        const eventStream = Stream.succeed<AgentPromptStreamEvent>({
          type: "ready",
          threadId,
          sandboxId,
          model,
          timestamp: Date.now(),
        }).pipe(
          Stream.concat(
            Stream.fromAsyncIterable(
              events,
              (cause) => new AgentAsyncIterableError({ cause }),
            ).pipe(
              Stream.tap((event) =>
                Effect.sync(() => {
                  if (event.type === "agent_end") {
                    console.log("Agent stream delivered to client", {
                      threadId,
                      messageCount: event.messages.length,
                    });
                  }
                }),
              ),
              Stream.map(normalizeAgentEvent),
              Stream.filter((event): event is AgentPromptStreamEvent => event !== null),
            ),
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

const toServerSentEvent = (event: AgentPromptStreamEvent) => `data: ${JSON.stringify(event)}\n\n`;
