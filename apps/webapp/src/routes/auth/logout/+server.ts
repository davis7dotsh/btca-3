import { redirect, type RequestEvent } from "@sveltejs/kit";
import { Effect } from "effect";
import { runtime } from "$lib/runtime";
import { AUTH_SESSION_COOKIE_NAME, AuthService } from "$lib/services/auth";

const DEFAULT_RETURN_TO = "/app";

const normalizeReturnTo = (value: FormDataEntryValue | null) => {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return DEFAULT_RETURN_TO;
  }

  return value;
};

const ensureSameOrigin = (event: RequestEvent) => {
  const origin = event.request.headers.get("origin");

  if (origin && origin !== event.url.origin) {
    throw redirect(303, DEFAULT_RETURN_TO);
  }
};

export const POST = async (event: RequestEvent) => {
  ensureSameOrigin(event);

  const formData = await event.request.formData();
  const returnTo = normalizeReturnTo(formData.get("returnTo"));
  const absoluteReturnTo = `${event.url.origin}${returnTo}`;
  let logoutUrl: string;

  try {
    logoutUrl = await runtime.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthService;
        return yield* auth.getLogoutUrl(event, absoluteReturnTo);
      }),
    );
  } catch {
    event.cookies.delete(AUTH_SESSION_COOKIE_NAME, { path: "/" });
    throw redirect(303, returnTo);
  }

  event.cookies.delete(AUTH_SESSION_COOKIE_NAME, { path: "/" });
  throw redirect(303, logoutUrl);
};
