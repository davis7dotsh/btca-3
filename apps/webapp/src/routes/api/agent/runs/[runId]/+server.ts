import { json, type RequestHandler } from "@sveltejs/kit";
import { Data, Effect } from "effect";
import { api } from "@btca/convex/api";
import { runtime } from "$lib/runtime";
import { AuthService } from "$lib/services/auth";
import { BoxService } from "$lib/services/box";
import { ConvexPrivateService } from "$lib/services/convex";
import { RunControlService } from "$lib/services/runControl";
import { RunStreamService } from "$lib/services/runStream";
import type { AgentPromptStreamEvent } from "$lib/types/agent";

class KillRunRequestError extends Data.TaggedError("KillRunRequestError")<{
  readonly status: number;
  readonly message: string;
  readonly cause?: unknown;
}> {}

const KILLED_RUN_MESSAGE = "The agent run was stopped.";

export const DELETE: RequestHandler = async (event) => {
  try {
    const response = await runtime.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthService;
        const box = yield* BoxService;
        const convex = yield* ConvexPrivateService;
        const runControl = yield* RunControlService;
        const runStream = yield* RunStreamService;
        const user = yield* auth.validateSession(event).pipe(
          Effect.mapError(
            (cause) =>
              new KillRunRequestError({
                status: 401,
                message: "Unauthorized",
                cause,
              }),
          ),
        );
        const runId = event.params.runId;

        if (!runId) {
          return yield* Effect.fail(
            new KillRunRequestError({
              status: 400,
              message: "Expected a runId route param.",
            }),
          );
        }

        const meta = yield* runStream.getRunMeta(runId);

        if (!meta || meta.userId !== user.userId) {
          return yield* Effect.fail(
            new KillRunRequestError({
              status: 404,
              message: "Run not found.",
            }),
          );
        }

        if (meta.status !== "pending" && meta.status !== "running") {
          return {
            ok: true as const,
            runId,
            status: meta.status,
          };
        }

        const controlState = runControl.abortRun(runId);

        yield* runStream.appendEvent({
          runId,
          event: {
            type: "run_error",
            message: KILLED_RUN_MESSAGE,
            timestamp: Date.now(),
          } satisfies AgentPromptStreamEvent,
        });
        yield* runStream.markFailed({
          runId,
          threadId: meta.threadId,
          message: KILLED_RUN_MESSAGE,
        });
        yield* convex.mutation({
          func: api.private.agentThreads.setThreadState,
          args: {
            threadId: meta.threadId,
            userId: user.userId,
            timestamp: Date.now(),
            status: "idle",
            activity: "Stopped",
          },
        });

        const sandboxId = controlState?.sandboxId ?? meta.sandboxId;

        if (sandboxId) {
          yield* box.deleteBox(sandboxId).pipe(Effect.catchCause(() => Effect.void));
        }

        return {
          ok: true as const,
          runId,
          status: "failed" as const,
        };
      }),
    );

    return json(response);
  } catch (error) {
    if (error instanceof KillRunRequestError) {
      return json({ message: error.message }, { status: error.status });
    }

    console.error("Failed to stop agent run", {
      error: error instanceof Error ? error.message : String(error),
    });

    return json({ message: "Failed to stop the agent run." }, { status: 500 });
  }
};
