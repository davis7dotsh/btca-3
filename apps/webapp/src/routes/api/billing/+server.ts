import { json, type RequestHandler } from "@sveltejs/kit";
import { Data, Effect, Schema } from "effect";
import { runtime } from "$lib/runtime";
import { BILLING_PLAN, FREE_BILLING_PLAN } from "$lib/billing/plans";
import { AutumnService } from "$lib/services/autumn";
import { AuthService } from "$lib/services/auth";

class BillingRequestError extends Data.TaggedError("BillingRequestError")<{
  readonly status: number;
  readonly message: string;
  readonly cause?: unknown;
}> {}

const BillingActionSchema = Schema.Struct({
  action: Schema.Literals(["checkout", "portal"]),
});

const getUserName = (user: {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}) => {
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return fullName.length > 0 ? fullName : user.email;
};

const getReturnUrl = (url: URL) => new URL("/app/billing", url).toString();

export const GET: RequestHandler = async (event) => {
  try {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthService;
        const autumn = yield* AutumnService;
        const session = yield* auth.validateSession(event).pipe(
          Effect.mapError(
            (cause) =>
              new BillingRequestError({
                status: 401,
                message: "Unauthorized",
                cause,
              }),
          ),
        );

        const billingState = yield* autumn.getBillingState({
          userId: session.userId,
          email: session.email,
          name: getUserName(session.user),
        });

        return {
          enabled: autumn.enabled,
          currentPlan: billingState.activePlanId,
          hasPaidPlan: billingState.hasPaidPlan,
          usage: billingState.usage,
          plans: {
            free: FREE_BILLING_PLAN,
            pro: BILLING_PLAN,
          },
        };
      }),
    );

    return json(result);
  } catch (error) {
    if (error instanceof BillingRequestError) {
      return json({ message: error.message }, { status: error.status });
    }

    console.error("Failed to load billing state", {
      error: error instanceof Error ? error.message : String(error),
    });

    return json({ message: "Failed to load billing state." }, { status: 500 });
  }
};

export const POST: RequestHandler = async (event) => {
  try {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthService;
        const autumn = yield* AutumnService;
        const session = yield* auth.validateSession(event).pipe(
          Effect.mapError(
            (cause) =>
              new BillingRequestError({
                status: 401,
                message: "Unauthorized",
                cause,
              }),
          ),
        );
        const body = yield* Effect.tryPromise({
          try: () => event.request.json(),
          catch: (cause) =>
            new BillingRequestError({
              status: 400,
              message: "Expected a JSON body.",
              cause,
            }),
        }).pipe(
          Effect.flatMap((value) =>
            Effect.try({
              try: () => Schema.decodeUnknownSync(BillingActionSchema)(value),
              catch: (cause) =>
                new BillingRequestError({
                  status: 400,
                  message: "Expected a valid billing action.",
                  cause,
                }),
            }),
          ),
        );

        const userInput = {
          userId: session.userId,
          email: session.email,
          name: getUserName(session.user),
        };

        const url =
          body.action === "checkout"
            ? yield* autumn.createCheckoutSession({
                ...userInput,
                successUrl: getReturnUrl(event.url),
              })
            : yield* autumn.createPortalSession({
                ...userInput,
                returnUrl: getReturnUrl(event.url),
              });

        return { url };
      }),
    );

    return json(result);
  } catch (error) {
    if (error instanceof BillingRequestError) {
      return json({ message: error.message }, { status: error.status });
    }

    console.error("Failed to create billing session", {
      error: error instanceof Error ? error.message : String(error),
    });

    return json({ message: "Failed to create billing session." }, { status: 500 });
  }
};
