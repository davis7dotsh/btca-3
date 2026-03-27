import type { RequestEvent } from "@sveltejs/kit";
import { Effect } from "effect";
import { runtime } from "$lib/runtime";
import { AUTH_SESSION_COOKIE_NAME, AuthService } from "$lib/services/auth";

export type AuthenticatedSession = {
  readonly user: {
    readonly id: string;
    readonly email: string | null;
    readonly firstName: string | null;
    readonly lastName: string | null;
    readonly profilePictureUrl: string | null;
  };
  readonly userId: string;
};

const getSessionCookieOptions = (event: RequestEvent) => ({
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  secure: event.url.protocol === "https:",
});

export const loadAuthenticatedSession = async (
  event: RequestEvent,
): Promise<AuthenticatedSession | null> => {
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

    return {
      user: session.user,
      userId: session.userId,
    };
  } catch {
    event.cookies.delete(AUTH_SESSION_COOKIE_NAME, { path: "/" });
    return null;
  }
};
