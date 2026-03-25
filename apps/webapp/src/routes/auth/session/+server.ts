import { json, type RequestEvent } from "@sveltejs/kit";
import { Effect } from "effect";
import { runtime } from "$lib/runtime";
import { AUTH_SESSION_COOKIE_NAME, AuthService } from "$lib/services/auth";

const getSessionCookieOptions = (event: RequestEvent) => ({
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  secure: event.url.protocol === "https:",
});

export const GET = async (event: RequestEvent) => {
  try {
    const session = await runtime.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthService;
        return yield* auth.validateSession(event);
      }),
    );

    if (session.sealedSession) {
      event.cookies.set(
        AUTH_SESSION_COOKIE_NAME,
        session.sealedSession,
        getSessionCookieOptions(event),
      );
    }

    return json(
      {
        authenticated: true,
        user: session.user,
      },
      {
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  } catch {
    event.cookies.delete(AUTH_SESSION_COOKIE_NAME, { path: "/" });

    return json(
      {
        authenticated: false,
      },
      {
        status: 401,
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  }
};
