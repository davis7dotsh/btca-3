import { randomUUID } from "node:crypto";
import { env } from "$env/dynamic/private";
import { Data, Effect, Layer, ServiceMap } from "effect";
import { Autumn } from "autumn-js";
import { BILLING_PLAN, FREE_BILLING_PLAN } from "$lib/billing/plans";
import { AUTUMN_USAGE_FEATURE_ID } from "$lib/billing/usage";

type AutumnOperation =
  | "checkUsageBalance"
  | "trackUsage"
  | "getBillingState"
  | "createCheckoutSession"
  | "createPortalSession";

export class AutumnServiceError extends Data.TaggedError("AutumnServiceError")<{
  readonly message: string;
  readonly kind: string;
  readonly traceId: string;
  readonly timestamp: number;
  readonly operation: AutumnOperation;
  readonly cause?: unknown;
}> {}

interface CheckUsageBalanceInput {
  readonly userId: string;
  readonly email?: string | null;
  readonly name?: string | null;
  readonly requiredBalance?: number;
}

interface TrackUsageInput {
  readonly userId: string;
  readonly valueUsd: number;
  readonly idempotencyKey: string;
  readonly properties?: Record<string, unknown>;
}

interface BillingUserInput {
  readonly userId: string;
  readonly email?: string | null;
  readonly name?: string | null;
}

interface CreateCheckoutSessionInput extends BillingUserInput {
  readonly successUrl: string;
}

interface CreatePortalSessionInput extends BillingUserInput {
  readonly returnUrl: string;
}

export interface BillingState {
  readonly customerId: string;
  readonly activePlanId: string;
  readonly hasPaidPlan: boolean;
  readonly usage: {
    readonly granted: number;
    readonly remaining: number;
    readonly used: number;
    readonly remainingPercentage: number;
    readonly nextResetAt: number | null;
    readonly isLifetime: boolean;
  };
}

interface AutumnDef {
  readonly enabled: boolean;
  readonly checkUsageBalance: (
    input: CheckUsageBalanceInput,
  ) => Effect.Effect<boolean, AutumnServiceError>;
  readonly trackUsage: (input: TrackUsageInput) => Effect.Effect<void, AutumnServiceError>;
  readonly getBillingState: (
    input: BillingUserInput,
  ) => Effect.Effect<BillingState, AutumnServiceError>;
  readonly createCheckoutSession: (
    input: CreateCheckoutSessionInput,
  ) => Effect.Effect<string, AutumnServiceError>;
  readonly createPortalSession: (
    input: CreatePortalSessionInput,
  ) => Effect.Effect<string, AutumnServiceError>;
}

const createAutumnServiceError = ({
  message,
  kind,
  operation,
  cause,
}: {
  message: string;
  kind: string;
  operation: AutumnOperation;
  cause?: unknown;
}) =>
  new AutumnServiceError({
    message,
    kind,
    traceId: randomUUID(),
    timestamp: Date.now(),
    operation,
    cause,
  });

const toAutumnServiceError = ({
  cause,
  message,
  kind,
  operation,
}: {
  cause: unknown;
  message: string;
  kind: string;
  operation: AutumnOperation;
}) =>
  cause instanceof AutumnServiceError
    ? cause
    : createAutumnServiceError({
        message,
        kind,
        operation,
        cause,
      });

export class AutumnService extends ServiceMap.Service<AutumnService, AutumnDef>()("AutumnService") {
  static readonly layer = Layer.sync(AutumnService, () => {
    const secretKey = env.AUTUMN_SECRET_KEY;
    const client =
      secretKey && secretKey.length > 0
        ? new Autumn({
            secretKey,
            ...(env.AUTUMN_URL ? { url: env.AUTUMN_URL } : {}),
          })
        : null;

    const enabled = client !== null;

    const ensureCustomer = async (input: BillingUserInput) => {
      if (!client) {
        return null;
      }

      return await client.customers.getOrCreate({
        customerId: input.userId,
        ...(input.email ? { email: input.email } : {}),
        ...(input.name ? { name: input.name } : {}),
        autoEnablePlanId: FREE_BILLING_PLAN.id,
      });
    };

    const getUsageState = (customer: Awaited<ReturnType<typeof ensureCustomer>>) => {
      const usageBalance = customer?.balances[AUTUMN_USAGE_FEATURE_ID] ?? null;
      const granted = usageBalance?.granted ?? 0;
      const remaining = usageBalance?.remaining ?? 0;
      const used = usageBalance?.usage ?? Math.max(granted - remaining, 0);
      const remainingPercentage =
        granted <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((remaining / granted) * 100)));

      return {
        granted,
        remaining,
        used,
        remainingPercentage,
        nextResetAt: usageBalance?.nextResetAt ?? null,
        isLifetime: usageBalance?.nextResetAt === null,
      };
    };

    const getActivePlanId = (customer: Awaited<ReturnType<typeof ensureCustomer>>) =>
      customer?.subscriptions.find(
        (subscription) => subscription.status === "active" || subscription.status === "trialing",
      )?.planId ?? FREE_BILLING_PLAN.id;

    const checkUsageBalance: AutumnDef["checkUsageBalance"] = (input) =>
      Effect.tryPromise({
        try: async () => {
          if (!client) {
            return true;
          }

          await ensureCustomer(input);
          const result = await client.check({
            customerId: input.userId,
            featureId: AUTUMN_USAGE_FEATURE_ID,
            ...(input.requiredBalance !== undefined
              ? { requiredBalance: input.requiredBalance }
              : {}),
          });

          return result.allowed;
        },
        catch: (cause) =>
          toAutumnServiceError({
            cause,
            operation: "checkUsageBalance",
            message: `Failed to check Autumn balance for ${input.userId}`,
            kind: "autumn_check_usage_balance_error",
          }),
      });

    const trackUsage: AutumnDef["trackUsage"] = (input) =>
      Effect.tryPromise({
        try: async () => {
          if (!client || input.valueUsd <= 0) {
            return;
          }

          await ensureCustomer({
            userId: input.userId,
          });
          await client.track({
            customerId: input.userId,
            featureId: AUTUMN_USAGE_FEATURE_ID,
            value: input.valueUsd,
            properties: {
              meteringKey: input.idempotencyKey,
              ...input.properties,
            },
          });
        },
        catch: (cause) =>
          toAutumnServiceError({
            cause,
            operation: "trackUsage",
            message: `Failed to track Autumn usage for ${input.userId}`,
            kind: "autumn_track_usage_error",
          }),
      });

    const getBillingState: AutumnDef["getBillingState"] = (input) =>
      Effect.tryPromise({
        try: async () => {
          const customer = await ensureCustomer(input);

          if (!customer) {
            return {
              customerId: input.userId,
              activePlanId: FREE_BILLING_PLAN.id,
              hasPaidPlan: false,
              usage: {
                granted: FREE_BILLING_PLAN.limits.usageUsd,
                remaining: FREE_BILLING_PLAN.limits.usageUsd,
                used: 0,
                remainingPercentage: 100,
                nextResetAt: null,
                isLifetime: true,
              },
            } satisfies BillingState;
          }

          const activePlanId = getActivePlanId(customer);

          return {
            customerId: customer.id ?? input.userId,
            activePlanId,
            hasPaidPlan: activePlanId === BILLING_PLAN.id,
            usage: getUsageState(customer),
          } satisfies BillingState;
        },
        catch: (cause) =>
          toAutumnServiceError({
            cause,
            operation: "getBillingState",
            message: `Failed to load Autumn billing state for ${input.userId}`,
            kind: "autumn_get_billing_state_error",
          }),
      });

    const createCheckoutSession: AutumnDef["createCheckoutSession"] = (input) =>
      Effect.tryPromise({
        try: async () => {
          if (!client) {
            return input.successUrl;
          }

          await ensureCustomer(input);
          const result = await client.billing.attach({
            customerId: input.userId,
            planId: BILLING_PLAN.id,
            successUrl: input.successUrl,
            redirectMode: "always",
          });

          return result.paymentUrl ?? input.successUrl;
        },
        catch: (cause) =>
          toAutumnServiceError({
            cause,
            operation: "createCheckoutSession",
            message: `Failed to create Autumn checkout session for ${input.userId}`,
            kind: "autumn_create_checkout_session_error",
          }),
      });

    const createPortalSession: AutumnDef["createPortalSession"] = (input) =>
      Effect.tryPromise({
        try: async () => {
          if (!client) {
            return input.returnUrl;
          }

          await ensureCustomer(input);
          const result = await client.billing.openCustomerPortal({
            customerId: input.userId,
            returnUrl: input.returnUrl,
          });

          return result.url;
        },
        catch: (cause) =>
          toAutumnServiceError({
            cause,
            operation: "createPortalSession",
            message: `Failed to create Autumn portal session for ${input.userId}`,
            kind: "autumn_create_portal_session_error",
          }),
      });

    return {
      enabled,
      checkUsageBalance,
      trackUsage,
      getBillingState,
      createCheckoutSession,
      createPortalSession,
    };
  });
}
