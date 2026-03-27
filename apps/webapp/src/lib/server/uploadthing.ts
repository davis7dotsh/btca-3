import { env as privateEnv } from "$env/dynamic/private";
import { z } from "zod";
import { api } from "@btca/convex/api";
import { Effect } from "effect";
import {
  UploadThingError,
  createRouteHandler,
  createUploadthing,
  type FileRouter,
} from "uploadthing/server";
import { runtime } from "$lib/runtime";
import { AuthError, AuthService } from "$lib/services/auth";
import { ConvexPrivateService } from "$lib/services/convex";

const logUploadThingError = (stage: string, error: unknown, context?: Record<string, unknown>) => {
  console.error("[uploadthing]", stage, {
    ...context,
    error:
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
          }
        : error,
  });
};

const toUploadThingError = (error: unknown, stage: string, context?: Record<string, unknown>) => {
  logUploadThingError(stage, error, context);

  if (error instanceof UploadThingError) {
    return error;
  }

  if (error instanceof AuthError) {
    return new UploadThingError({
      code: "FORBIDDEN",
      message: error.message,
      cause: error,
    });
  }

  if (error instanceof Error && error.message === "Thread not found.") {
    return new UploadThingError({
      code: "NOT_FOUND",
      message: error.message,
      cause: error,
    });
  }

  if (error instanceof Error && error.message.startsWith("Unauthorized")) {
    return new UploadThingError({
      code: "FORBIDDEN",
      message: error.message,
      cause: error,
    });
  }

  return new UploadThingError({
    code: "INTERNAL_SERVER_ERROR",
    message: "Failed to process the upload request.",
    cause: error,
  });
};

const f = createUploadthing({
  errorFormatter: (error) => {
    logUploadThingError("request_error", error, { code: error.code });

    return {
      code: error.code,
      message: error.message,
      cause:
        typeof error.cause === "string"
          ? error.cause
          : error.cause instanceof Error
            ? error.cause.message
            : null,
    };
  },
});

export const uploadRouter = {
  agentAttachment: f({
    image: {
      maxFileCount: 8,
      maxFileSize: "8MB",
    },
  })
    .input(
      z.object({
        threadId: z.string().min(1),
      }),
    )
    .middleware(async ({ input, req }) => {
      try {
        return await runtime.runPromise(
          Effect.gen(function* () {
            const auth = yield* AuthService;
            const convex = yield* ConvexPrivateService;
            const user = yield* auth.validateRequest(req);
            const thread = yield* convex.query({
              func: api.private.agentThreads.getThreadContext,
              args: {
                threadId: input.threadId,
                userId: user.userId,
              },
            });

            if (thread === null) {
              throw new Error("Thread not found.");
            }

            return {
              threadId: input.threadId,
              userId: user.userId,
            };
          }),
        );
      } catch (error) {
        throw toUploadThingError(error, "middleware_failed", {
          threadId: input.threadId,
          requestUrl: req.url,
        });
      }
    })
    .onUploadError(({ error, fileKey }) => {
      logUploadThingError("upload_failed", error, { fileKey });
    })
    .onUploadComplete(async ({ metadata, file }) => {
      try {
        return await runtime.runPromise(
          Effect.gen(function* () {
            const convex = yield* ConvexPrivateService;

            return yield* convex.mutation({
              func: api.private.agentThreads.createPendingAttachment,
              args: {
                threadId: metadata.threadId,
                userId: metadata.userId,
                fileKey: file.key,
                ufsUrl: file.ufsUrl,
                fileName: file.name,
                fileSize: file.size,
                mimeType: file.type,
              },
            });
          }),
        );
      } catch (error) {
        throw toUploadThingError(error, "on_upload_complete_failed", {
          fileKey: file.key,
          threadId: metadata.threadId,
          userId: metadata.userId,
        });
      }
    }),
} satisfies FileRouter;

export const uploadthingRouteHandler = createRouteHandler({
  router: uploadRouter,
  config: {
    token: privateEnv.UPLOADTHING_TOKEN,
  },
});

export type UploadRouter = typeof uploadRouter;
