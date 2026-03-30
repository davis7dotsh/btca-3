import { env as privateEnv } from "$env/dynamic/private";
import { UTApi } from "uploadthing/server";
import { json, type RequestHandler } from "@sveltejs/kit";
import type { Id } from "@btca/convex/data-model";
import { Effect } from "effect";
import { api } from "@btca/convex/api";
import { runtime } from "$lib/runtime";
import { AuthService } from "$lib/services/auth";
import { ConvexPrivateService } from "$lib/services/convex";

const utapi = new UTApi({
  token: privateEnv.UPLOADTHING_TOKEN,
});

export const DELETE: RequestHandler = async (event) => {
  try {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthService;
        const convex = yield* ConvexPrivateService;
        const user = yield* auth.validateSession(event);
        const attachmentId = event.params.attachmentId;

        if (!attachmentId) {
          throw new Error("Attachment id is required.");
        }

        const removed = yield* convex.mutation({
          func: api.private.agentThreads.removePendingAttachment,
          args: {
            attachmentId: attachmentId as Id<"v2_agentThreadAttachments">,
            userId: user.userId,
          },
        });

        return removed;
      }),
    );

    await utapi.deleteFiles(result.fileKey);

    return json({ ok: true, attachmentId: result.attachmentId });
  } catch (error) {
    return json(
      {
        message: error instanceof Error ? error.message : "Failed to remove attachment.",
      },
      { status: 500 },
    );
  }
};
