import { getRequestEvent, query } from "$app/server";
import type { RequestEvent } from "@sveltejs/kit";
import { Effect } from "effect";
import { effectRunner } from "$lib/runtime";
import { AuthService } from "$lib/services/auth";
import { ConvexPrivateService } from "$lib/services/convex";
import { api } from "@btca/convex/api";

const demoRemote = Effect.gen(function* () {
  const convex = yield* ConvexPrivateService;

  return yield* convex.query({
    func: api.private.demo.privateDemoQuery,
    args: {
      username: "hello there",
    },
  });
});

export const remoteDemoQuery = query(async () => {
  return await effectRunner(demoRemote);
});

const demoAuthed = (event: RequestEvent) =>
  Effect.gen(function* () {
    const auth = yield* AuthService;
    const user = yield* auth.validateSession(event);

    return {
      user: {
        id: user.userId,
        email: user.email,
      },
    };
  });

export const remoteAuthedDemoQuery = query(async () => {
  return await effectRunner(demoAuthed(getRequestEvent()));
});
