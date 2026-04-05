import { env } from "$env/dynamic/private";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { Data, Effect, Layer, ServiceMap } from "effect";

type RateLimitOperation = "checkWebChat" | "checkMcp";
type RateLimitReason = "timeout" | "cacheBlock" | "denyList";

export type RateLimitCheckResult = {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly reset: number;
  readonly pending: Promise<unknown>;
  readonly reason?: RateLimitReason;
  readonly deniedValue?: string;
};

export class RateLimitServiceError extends Data.TaggedError("RateLimitServiceError")<{
  readonly message: string;
  readonly kind: string;
  readonly operation: RateLimitOperation;
  readonly cause?: unknown;
}> {}

interface RateLimitDef {
  checkWebChat: (userId: string) => Effect.Effect<RateLimitCheckResult, RateLimitServiceError>;
  checkMcp: (userId: string) => Effect.Effect<RateLimitCheckResult, RateLimitServiceError>;
}

const getRequiredValue = (value: string | undefined, key: string) => {
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }

  return value;
};

const createRateLimitServiceError = ({
  message,
  kind,
  operation,
  cause,
}: {
  message: string;
  kind: string;
  operation: RateLimitOperation;
  cause?: unknown;
}) =>
  new RateLimitServiceError({
    message,
    kind,
    operation,
    cause,
  });

const toRateLimitCheckResult = ({
  success,
  limit,
  remaining,
  reset,
  pending,
  reason,
  deniedValue,
}: {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
  pending: Promise<unknown>;
  reason?: RateLimitReason;
  deniedValue?: string;
}): RateLimitCheckResult => ({
  allowed: success && reason !== "timeout",
  limit,
  remaining,
  reset,
  pending,
  reason,
  deniedValue,
});

const getRetryAfterSeconds = (reset: number) => {
  const millisecondsUntilReset = reset - Date.now();

  if (!Number.isFinite(millisecondsUntilReset) || millisecondsUntilReset <= 0) {
    return "1";
  }

  return `${Math.max(1, Math.ceil(millisecondsUntilReset / 1_000))}`;
};

export const getRateLimitHeaders = (
  result: Pick<RateLimitCheckResult, "limit" | "remaining" | "reset">,
) => ({
  "Retry-After": getRetryAfterSeconds(result.reset),
  "X-RateLimit-Limit": `${Math.max(0, result.limit)}`,
  "X-RateLimit-Remaining": `${Math.max(0, result.remaining)}`,
  "X-RateLimit-Reset": `${result.reset}`,
});

export class RateLimitService extends ServiceMap.Service<RateLimitService, RateLimitDef>()(
  "RateLimitService",
) {
  static readonly layer = Layer.sync(RateLimitService, () => {
    const redis = new Redis({
      url: getRequiredValue(
        env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL,
        "UPSTASH_REDIS_REST_URL",
      ),
      token: getRequiredValue(
        env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN,
        "UPSTASH_REDIS_REST_TOKEN",
      ),
      readYourWrites: true,
    });

    const webChatLimiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(1, "1 s"),
      prefix: "btca:webapp:ratelimit:web-chat",
      analytics: true,
      enableProtection: true,
      ephemeralCache: new Map(),
      timeout: 0,
    });

    const mcpLimiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(5, "1 s"),
      prefix: "btca:webapp:ratelimit:mcp",
      analytics: true,
      enableProtection: true,
      ephemeralCache: new Map(),
      timeout: 0,
    });

    const checkWebChat: RateLimitDef["checkWebChat"] = (userId) =>
      Effect.tryPromise({
        try: async () => toRateLimitCheckResult(await webChatLimiter.limit(userId)),
        catch: (cause) =>
          createRateLimitServiceError({
            message: `Failed to evaluate the web chat rate limit for ${userId}.`,
            kind: "web_chat_rate_limit_error",
            operation: "checkWebChat",
            cause,
          }),
      });

    const checkMcp: RateLimitDef["checkMcp"] = (userId) =>
      Effect.tryPromise({
        try: async () => toRateLimitCheckResult(await mcpLimiter.limit(userId)),
        catch: (cause) =>
          createRateLimitServiceError({
            message: `Failed to evaluate the MCP rate limit for ${userId}.`,
            kind: "mcp_rate_limit_error",
            operation: "checkMcp",
            cause,
          }),
      });

    return {
      checkWebChat,
      checkMcp,
    };
  });
}
