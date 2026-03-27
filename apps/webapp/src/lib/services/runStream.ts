import { randomUUID } from "node:crypto";
import { env } from "$env/dynamic/private";
import { Redis } from "@upstash/redis";
import { Data, Effect, Layer, ServiceMap } from "effect";
import type { ActiveAgentRunResponse, AgentPromptStreamEvent } from "$lib/types/agent";
import type { AgentModelOption } from "$lib/models";

type RunStreamOperation =
  | "createRun"
  | "getRunMeta"
  | "getActiveRunForThread"
  | "markRunning"
  | "appendEvent"
  | "appendEvents"
  | "markCompleted"
  | "markFailed"
  | "scheduleExpiry"
  | "deleteRun"
  | "replayAfter";

type RunStatus = "pending" | "running" | "completed" | "failed";

const ACTIVE_RUN_TTL_SECONDS = 60 * 60;
const COMPLETED_RUN_TTL_SECONDS = 10 * 60;
const FAILED_RUN_TTL_SECONDS = 30 * 60;
const REPLAY_BATCH_SIZE = 100;

export class RunStreamServiceError extends Data.TaggedError("RunStreamServiceError")<{
  readonly message: string;
  readonly kind: string;
  readonly traceId: string;
  readonly timestamp: number;
  readonly operation: RunStreamOperation;
  readonly cause?: unknown;
}> {}

export interface RunStreamEventRecord {
  readonly id: string;
  readonly event: AgentPromptStreamEvent;
  readonly isTerminal: boolean;
}

export interface AgentRunMeta {
  readonly runId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly prompt: string;
  readonly attachmentIds: readonly string[];
  readonly status: RunStatus;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly expiresAt: number | null;
  readonly sandboxId: string | null;
  readonly model: AgentModelOption | null;
  readonly lastEventId: string | null;
  readonly errorMessage: string | null;
}

export interface CreateRunInput {
  readonly threadId: string;
  readonly userId: string;
  readonly prompt: string;
  readonly attachmentIds: readonly string[];
}

export interface RunStreamDef {
  createRun: (input: CreateRunInput) => Effect.Effect<AgentRunMeta, RunStreamServiceError>;
  getRunMeta: (runId: string) => Effect.Effect<AgentRunMeta | null, RunStreamServiceError>;
  getActiveRunForThread: (input: {
    readonly threadId: string;
    readonly userId: string;
  }) => Effect.Effect<ActiveAgentRunResponse | null, RunStreamServiceError>;
  markRunning: (input: {
    readonly runId: string;
    readonly sandboxId: string;
    readonly model: AgentModelOption;
  }) => Effect.Effect<void, RunStreamServiceError>;
  appendEvent: (input: {
    readonly runId: string;
    readonly event: AgentPromptStreamEvent;
    readonly publish?: boolean;
  }) => Effect.Effect<string, RunStreamServiceError>;
  appendEvents: (input: {
    readonly runId: string;
    readonly events: readonly AgentPromptStreamEvent[];
    readonly publish?: boolean;
  }) => Effect.Effect<readonly string[], RunStreamServiceError>;
  markCompleted: (input: {
    readonly runId: string;
    readonly threadId: string;
  }) => Effect.Effect<void, RunStreamServiceError>;
  markFailed: (input: {
    readonly runId: string;
    readonly threadId: string;
    readonly message: string;
  }) => Effect.Effect<void, RunStreamServiceError>;
  replayAfter: (input: {
    readonly runId: string;
    readonly after: string | null;
    readonly limit?: number;
  }) => Effect.Effect<readonly RunStreamEventRecord[], RunStreamServiceError>;
}

const getRequiredValue = (value: string | undefined, key: string) => {
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }

  return value;
};

const createRunStreamServiceError = ({
  message,
  kind,
  operation,
  cause,
}: {
  message: string;
  kind: string;
  operation: RunStreamOperation;
  cause?: unknown;
}) =>
  new RunStreamServiceError({
    message,
    kind,
    traceId: randomUUID(),
    timestamp: Date.now(),
    operation,
    cause,
  });

const toRunStreamServiceError = ({
  cause,
  message,
  kind,
  operation,
}: {
  cause: unknown;
  message: string;
  kind: string;
  operation: RunStreamOperation;
}) =>
  cause instanceof RunStreamServiceError
    ? cause
    : createRunStreamServiceError({
        message,
        kind,
        operation,
        cause,
      });

const toMetaKey = (runId: string) => `chat:run:${runId}:meta`;
const toEventsKey = (runId: string) => `chat:run:${runId}:events`;
const toThreadActiveRunKey = (threadId: string) => `chat:thread:${threadId}:active-run`;
const toRunChannel = (runId: string) => `chat:run:${runId}:events:live`;

const parseAttachmentIds = (value: unknown) => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => (typeof item === "string" ? [item] : []));
};

const parseModel = (value: unknown) => {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  if (
    "id" in value &&
    typeof value.id === "string" &&
    "label" in value &&
    typeof value.label === "string" &&
    "description" in value &&
    typeof value.description === "string" &&
    "pricingConfigured" in value &&
    typeof value.pricingConfigured === "boolean" &&
    "provider" in value &&
    typeof value.provider === "string" &&
    "api" in value &&
    typeof value.api === "string" &&
    "modelId" in value &&
    typeof value.modelId === "string"
  ) {
    return value as AgentModelOption;
  }

  return null;
};

const parseRunStatus = (value: unknown): RunStatus =>
  value === "running" || value === "completed" || value === "failed" ? value : "pending";

const parseNumber = (value: unknown) => (typeof value === "number" ? value : null);

const parseString = (value: unknown) => (typeof value === "string" ? value : null);

const parseMeta = (runId: string, raw: Record<string, unknown> | null): AgentRunMeta | null => {
  if (raw === null) {
    return null;
  }

  const threadId = parseString(raw.threadId);
  const userId = parseString(raw.userId);
  const prompt = parseString(raw.prompt);
  const startedAt = parseNumber(raw.startedAt);

  if (!threadId || !userId || !prompt || startedAt === null) {
    return null;
  }

  return {
    runId,
    threadId,
    userId,
    prompt,
    attachmentIds: parseAttachmentIds(raw.attachmentIds),
    status: parseRunStatus(raw.status),
    startedAt,
    completedAt: parseNumber(raw.completedAt),
    expiresAt: parseNumber(raw.expiresAt),
    sandboxId: parseString(raw.sandboxId),
    model: parseModel(raw.model),
    lastEventId: parseString(raw.lastEventId),
    errorMessage: parseString(raw.errorMessage),
  };
};

const streamIdToTuple = (value: string) => {
  const [millisecondsPart = "0", sequencePart = "0"] = value.split("-", 2);
  const milliseconds = Number.parseInt(millisecondsPart, 10);
  const sequence = Number.parseInt(sequencePart, 10);

  return {
    milliseconds: Number.isFinite(milliseconds) ? milliseconds : 0,
    sequence: Number.isFinite(sequence) ? sequence : 0,
  };
};

const compareStreamIds = (left: string, right: string) => {
  const parsedLeft = streamIdToTuple(left);
  const parsedRight = streamIdToTuple(right);

  if (parsedLeft.milliseconds !== parsedRight.milliseconds) {
    return parsedLeft.milliseconds - parsedRight.milliseconds;
  }

  return parsedLeft.sequence - parsedRight.sequence;
};

const parseReplayEntries = (entries: Record<string, { event?: unknown; terminal?: unknown }>) =>
  Object.entries(entries)
    .flatMap(([id, value]) => {
      const event = value.event;
      return event && typeof event === "object"
        ? [
            {
              id,
              event: event as AgentPromptStreamEvent,
              isTerminal: value.terminal === "1" || value.terminal === 1 || value.terminal === true,
            },
          ]
        : [];
    })
    .sort((left, right) => compareStreamIds(left.id, right.id));

const isTerminalEvent = (event: AgentPromptStreamEvent) =>
  event.type === "done" || event.type === "run_error";

export class RunStreamService extends ServiceMap.Service<RunStreamService, RunStreamDef>()(
  "RunStreamService",
) {
  static readonly layer = Layer.sync(RunStreamService, () => {
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

    const createRun: RunStreamDef["createRun"] = (input) =>
      Effect.tryPromise({
        try: async () => {
          const runId = `run-${randomUUID()}`;
          const startedAt = Date.now();
          const meta: AgentRunMeta = {
            runId,
            threadId: input.threadId,
            userId: input.userId,
            prompt: input.prompt,
            attachmentIds: [...input.attachmentIds],
            status: "pending",
            startedAt,
            completedAt: null,
            expiresAt: null,
            sandboxId: null,
            model: null,
            lastEventId: null,
            errorMessage: null,
          };
          const pipeline = redis.pipeline();

          pipeline.hset(toMetaKey(runId), {
            runId,
            threadId: input.threadId,
            userId: input.userId,
            prompt: input.prompt,
            attachmentIds: JSON.stringify(input.attachmentIds),
            status: "pending",
            startedAt,
          });
          pipeline.set(toThreadActiveRunKey(input.threadId), runId);
          pipeline.expire(toMetaKey(runId), ACTIVE_RUN_TTL_SECONDS);
          pipeline.expire(toThreadActiveRunKey(input.threadId), ACTIVE_RUN_TTL_SECONDS);
          await pipeline.exec();

          return meta;
        },
        catch: (cause) =>
          toRunStreamServiceError({
            cause,
            operation: "createRun",
            kind: "run_stream_create_error",
            message: `Failed to create run for thread ${input.threadId}`,
          }),
      });

    const getRunMeta: RunStreamDef["getRunMeta"] = (runId) =>
      Effect.tryPromise({
        try: async () =>
          parseMeta(runId, await redis.hgetall<Record<string, unknown>>(toMetaKey(runId))),
        catch: (cause) =>
          toRunStreamServiceError({
            cause,
            operation: "getRunMeta",
            kind: "run_stream_get_meta_error",
            message: `Failed to load run metadata for ${runId}`,
          }),
      });

    const getActiveRunForThread: RunStreamDef["getActiveRunForThread"] = (input) =>
      Effect.gen(function* () {
        const runId = yield* Effect.tryPromise({
          try: () => redis.get<string>(toThreadActiveRunKey(input.threadId)),
          catch: (cause) =>
            toRunStreamServiceError({
              cause,
              operation: "getActiveRunForThread",
              kind: "run_stream_get_active_error",
              message: `Failed to load active run for thread ${input.threadId}`,
            }),
        });

        if (!runId) {
          return null;
        }

        const meta = yield* getRunMeta(runId);

        if (meta === null || meta.userId !== input.userId || meta.status !== "running") {
          return null;
        }

        return {
          runId: meta.runId,
          threadId: meta.threadId,
          streamPath: `/api/agent/runs/${encodeURIComponent(meta.runId)}/stream`,
          prompt: meta.prompt,
          attachmentIds: meta.attachmentIds,
        } satisfies ActiveAgentRunResponse;
      });

    const markRunning: RunStreamDef["markRunning"] = (input) =>
      Effect.tryPromise({
        try: async () => {
          const metaKey = toMetaKey(input.runId);
          const pipeline = redis.pipeline();

          pipeline.hset(metaKey, {
            status: "running",
            sandboxId: input.sandboxId,
            model: JSON.stringify(input.model),
            errorMessage: "",
          });
          pipeline.expire(metaKey, ACTIVE_RUN_TTL_SECONDS);
          await pipeline.exec();
        },
        catch: (cause) =>
          toRunStreamServiceError({
            cause,
            operation: "markRunning",
            kind: "run_stream_mark_running_error",
            message: `Failed to mark run ${input.runId} as running`,
          }),
      });

    const appendEvent: RunStreamDef["appendEvent"] = (input) =>
      appendEvents({
        runId: input.runId,
        events: [input.event],
        publish: input.publish,
      }).pipe(Effect.map(([eventId]) => eventId));

    const appendEvents: RunStreamDef["appendEvents"] = (input) =>
      Effect.tryPromise({
        try: async () => {
          if (input.events.length === 0) {
            return [];
          }

          const eventsKey = toEventsKey(input.runId);
          const pipeline = redis.pipeline();

          for (const event of input.events) {
            pipeline.xadd(eventsKey, "*", {
              event: JSON.stringify(event),
              type: event.type,
              timestamp: event.timestamp,
              terminal: isTerminalEvent(event) ? "1" : "0",
            });
          }

          const eventIds = await pipeline.exec<string[]>();

          const lastEventId = eventIds.at(-1);

          if (input.publish !== false && lastEventId) {
            const publishPipeline = redis.pipeline();

            publishPipeline.publish(toRunChannel(input.runId), {
              runId: input.runId,
              eventId: lastEventId,
            });

            await publishPipeline.exec();
          }

          return eventIds;
        },
        catch: (cause) =>
          toRunStreamServiceError({
            cause,
            operation: "appendEvents",
            kind: "run_stream_append_error",
            message: `Failed to append events to run ${input.runId}`,
          }),
      });

    const scheduleExpiry = ({
      runId,
      threadId,
      status,
      message,
    }: {
      runId: string;
      threadId: string;
      status: Extract<RunStatus, "completed" | "failed">;
      message?: string;
    }) =>
      Effect.tryPromise({
        try: async () => {
          const expiresInSeconds =
            status === "completed" ? COMPLETED_RUN_TTL_SECONDS : FAILED_RUN_TTL_SECONDS;
          const expiresAt = Date.now() + expiresInSeconds * 1_000;
          const pipeline = redis.pipeline();

          pipeline.hset(toMetaKey(runId), {
            status,
            completedAt: Date.now(),
            expiresAt,
            ...(message === undefined ? {} : { errorMessage: message }),
          });
          pipeline.del(toThreadActiveRunKey(threadId));
          pipeline.expire(toMetaKey(runId), expiresInSeconds);
          pipeline.expire(toEventsKey(runId), expiresInSeconds);
          await pipeline.exec();
        },
        catch: (cause) =>
          toRunStreamServiceError({
            cause,
            operation: "scheduleExpiry",
            kind: "run_stream_schedule_expiry_error",
            message: `Failed to schedule expiry for run ${runId}`,
          }),
      });

    const markCompleted: RunStreamDef["markCompleted"] = (input) =>
      scheduleExpiry({
        runId: input.runId,
        threadId: input.threadId,
        status: "completed",
      });

    const markFailed: RunStreamDef["markFailed"] = (input) =>
      scheduleExpiry({
        runId: input.runId,
        threadId: input.threadId,
        status: "failed",
        message: input.message,
      });

    const replayAfter: RunStreamDef["replayAfter"] = (input) =>
      Effect.tryPromise({
        try: async () => {
          const start = input.after === null ? "-" : `(${input.after}`;
          const entries = await redis.xrange<{ event?: unknown; terminal?: unknown }>(
            toEventsKey(input.runId),
            start,
            "+",
            input.limit ?? REPLAY_BATCH_SIZE,
          );

          return parseReplayEntries(entries);
        },
        catch: (cause) =>
          toRunStreamServiceError({
            cause,
            operation: "replayAfter",
            kind: "run_stream_replay_error",
            message: `Failed to replay events for run ${input.runId}`,
          }),
      });

    return {
      createRun,
      getRunMeta,
      getActiveRunForThread,
      markRunning,
      appendEvent,
      appendEvents,
      markCompleted,
      markFailed,
      replayAfter,
    };
  });
}

export const RUN_STREAM_REPLAY_BATCH_SIZE = REPLAY_BATCH_SIZE;
export const getRunChannelName = (runId: string) => toRunChannel(runId);
export const createRunSubscriber = (runId: string) =>
  new Redis({
    url: getRequiredValue(
      env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL,
      "UPSTASH_REDIS_REST_URL",
    ),
    token: getRequiredValue(
      env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN,
      "UPSTASH_REDIS_REST_TOKEN",
    ),
    readYourWrites: true,
  }).subscribe<{ runId: string; eventId: string }>(toRunChannel(runId));
