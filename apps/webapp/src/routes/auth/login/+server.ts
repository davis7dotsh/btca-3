import { redirect, type RequestEvent } from "@sveltejs/kit";
import { Effect } from "effect";
import { runtime } from "$lib/runtime";
import { AuthService } from "$lib/services/auth";

const DEFAULT_RETURN_TO = "/app";

const normalizeReturnTo = (value: string | null) => {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return DEFAULT_RETURN_TO;
  }

  return value;
};

export const GET = async (event: RequestEvent) => {
  const returnTo = normalizeReturnTo(event.url.searchParams.get("returnTo"));
  const authorizationUrl = await runtime.runPromise(
    Effect.gen(function* () {
      const auth = yield* AuthService;
      return yield* auth.getAuthorizationUrl({
        redirectUri: `${event.url.origin}/auth/callback`,
        returnTo,
      });
    }),
  );

  throw redirect(302, authorizationUrl);
};
