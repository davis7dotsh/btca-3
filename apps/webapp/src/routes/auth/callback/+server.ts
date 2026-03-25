import { redirect, type RequestEvent } from "@sveltejs/kit";
import { Effect } from "effect";
import { runtime } from "$lib/runtime";
import { AUTH_SESSION_COOKIE_NAME, AuthService } from "$lib/services/auth";

const DEFAULT_RETURN_TO = "/app";

const normalizeReturnTo = (value: string | null) => {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return DEFAULT_RETURN_TO;
  }

  return value;
};

const getSessionCookieOptions = (event: RequestEvent) => ({
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  secure: event.url.protocol === "https:",
});

export const GET = async (event: RequestEvent) => {
  const code = event.url.searchParams.get("code");
  const returnTo = normalizeReturnTo(event.url.searchParams.get("state"));

  if (!code) {
    throw redirect(302, `/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  }

  const authentication = await runtime.runPromise(
    Effect.gen(function* () {
      const auth = yield* AuthService;
      return yield* auth.authenticateWithCode({ code });
    }),
  );

  event.cookies.set(
    AUTH_SESSION_COOKIE_NAME,
    authentication.sealedSession,
    getSessionCookieOptions(event),
  );

  throw redirect(302, returnTo);
};
