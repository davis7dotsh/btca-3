import { json, type RequestHandler } from "@sveltejs/kit";
import { Data, Effect } from "effect";
import { runtime } from "$lib/runtime";
import { AuthService } from "$lib/services/auth";
import { RunStreamService } from "$lib/services/runStream";

class ActiveRunRequestError extends Data.TaggedError("ActiveRunRequestError")<{
  readonly status: number;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const GET: RequestHandler = async (event) => {
  try {
    const response = await runtime.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthService;
        const runStream = yield* RunStreamService;
        const user = yield* auth.validateSession(event).pipe(
          Effect.mapError(
            (error) =>
              new ActiveRunRequestError({
                status: 401,
                message: "Unauthorized",
                cause: error,
              }),
          ),
        );
        const threadId = event.url.searchParams.get("threadId");

        if (!threadId) {
          return yield* Effect.fail(
            new ActiveRunRequestError({
              status: 400,
              message: "Expected a threadId query param.",
            }),
          );
        }

        return yield* runStream.getActiveRunForThread({
          threadId,
          userId: user.userId,
        });
      }),
    );

    return json(response);
  } catch (error) {
    if (error instanceof ActiveRunRequestError) {
      return json({ message: error.message }, { status: error.status });
    }

    console.error("Failed to load active agent run", {
      error: error instanceof Error ? error.message : String(error),
    });

    return json({ message: "Failed to load the active agent run." }, { status: 500 });
  }
};
