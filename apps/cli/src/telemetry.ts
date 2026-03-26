import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as ServiceMap from "effect/ServiceMap";

const POSTHOG_KEY = "phc_aUZcaccxNs56PokvsvIInqHCrwjUjvpiMWih9P86cTV";
const POSTHOG_HOST = "https://us.i.posthog.com";
const TELEMETRY_ENV_FLAG = "BTCA_TELEMETRY";
const TELEMETRY_CONFIG_DIR = "~/.config/btca";
const TELEMETRY_FILENAME = "telemetry.json";
const TELEMETRY_TIMEOUT_MS = 1_000;

export type TelemetryConfig = {
  readonly enabled: boolean;
  readonly distinctId: string;
};

export type TelemetryContext = {
  readonly provider?: string;
  readonly model?: string;
  readonly cliVersion?: string;
};

type TelemetryStatus = {
  readonly envDisabled: boolean;
  readonly enabled: boolean;
  readonly distinctId: string | null;
};

type TrackedCliCommandArgs<A, E, R> = {
  readonly command: string;
  readonly mode: string;
  readonly eventName?: string;
  readonly startProperties?: Record<string, unknown>;
  readonly successProperties?: (result: A) => Record<string, unknown> | undefined;
  readonly failureProperties?: (error: unknown) => Record<string, unknown> | undefined;
  readonly action: Effect.Effect<A, E, R>;
};

type TelemetryService = {
  readonly setContext: (next: TelemetryContext) => Effect.Effect<void>;
  readonly setEnabled: (enabled: boolean) => Effect.Effect<TelemetryConfig, TelemetryError>;
  readonly getStatus: () => Effect.Effect<TelemetryStatus>;
  readonly trackEvent: (args: {
    readonly event: string;
    readonly properties?: Record<string, unknown>;
  }) => Effect.Effect<void>;
};

export class TelemetryError extends Data.TaggedError("TelemetryError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const expandHome = (filePath: string) => {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (filePath.startsWith("~/")) {
    return `${home}${filePath.slice(1)}`;
  }
  return filePath;
};

const getTelemetryPath = () => `${expandHome(TELEMETRY_CONFIG_DIR)}/${TELEMETRY_FILENAME}`;

const getTelemetryDirectory = () => {
  const telemetryPath = getTelemetryPath();
  return telemetryPath.slice(0, telemetryPath.lastIndexOf("/"));
};

const isEnvDisabled = () => process.env[TELEMETRY_ENV_FLAG] === "0";

const createDefaultConfig = (): TelemetryConfig => ({
  enabled: true,
  distinctId: crypto.randomUUID(),
});

const normalizeConfig = (raw: unknown) => {
  const candidate = raw as Partial<TelemetryConfig> | null;
  const enabled = typeof candidate?.enabled === "boolean" ? candidate.enabled : true;
  const distinctId =
    typeof candidate?.distinctId === "string" && candidate.distinctId.trim().length > 0
      ? candidate.distinctId
      : crypto.randomUUID();

  const config = {
    enabled,
    distinctId,
  } satisfies TelemetryConfig;

  const needsSave =
    candidate?.enabled !== enabled ||
    typeof candidate?.distinctId !== "string" ||
    candidate?.distinctId !== distinctId;

  return {
    config,
    needsSave,
  };
};

const ensureConfigDir = Effect.tryPromise({
  try: async () => {
    const fs = await import("node:fs/promises");
    await fs.mkdir(getTelemetryDirectory(), { recursive: true });
  },
  catch: (cause) =>
    new TelemetryError({
      message: "Failed to create the telemetry config directory.",
      cause,
    }),
});

const readTelemetryConfig = Effect.tryPromise({
  try: async () => {
    const fs = await import("node:fs/promises");

    try {
      const text = await fs.readFile(getTelemetryPath(), "utf8");
      return normalizeConfig(JSON.parse(text) as unknown);
    } catch (cause) {
      if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") {
        return null;
      }

      return null;
    }
  },
  catch: (cause) =>
    new TelemetryError({
      message: "Failed to read the telemetry config.",
      cause,
    }),
}).pipe(Effect.orElseSucceed(() => null));

const saveTelemetryConfig = (config: TelemetryConfig) =>
  Effect.gen(function* () {
    yield* ensureConfigDir;

    yield* Effect.tryPromise({
      try: async () => {
        const fs = await import("node:fs/promises");
        await fs.writeFile(getTelemetryPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
      },
      catch: (cause) =>
        new TelemetryError({
          message: "Failed to write the telemetry config.",
          cause,
        }),
    });
  });

const posthogCapture = (payload: Record<string, unknown>) =>
  Effect.tryPromise({
    try: async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);

      try {
        await fetch(`${POSTHOG_HOST}/capture`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    },
    catch: () => undefined,
  }).pipe(Effect.asVoid);

const buildProperties = ({
  context,
  properties,
}: {
  context: TelemetryContext;
  properties?: Record<string, unknown>;
}) => {
  const base: Record<string, unknown> = {
    anonymous: true,
    arch: process.arch,
    cliVersion: context.cliVersion,
    os: process.platform,
  };

  if (context.provider) {
    base.provider = context.provider;
  }

  if (context.model) {
    base.model = context.model;
  }

  return {
    ...base,
    ...properties,
  };
};

export class Telemetry extends ServiceMap.Service<Telemetry, TelemetryService>()("Telemetry") {
  static readonly make = (initialContext: TelemetryContext = {}) =>
    Effect.gen(function* () {
      const contextRef = yield* Ref.make(initialContext);

      const getOrCreateTelemetryConfig = Effect.gen(function* () {
        const existing = yield* readTelemetryConfig;

        if (existing) {
          if (existing.needsSave) {
            yield* saveTelemetryConfig(existing.config);
          }

          return existing.config;
        }

        const created = createDefaultConfig();
        yield* saveTelemetryConfig(created);
        return created;
      });

      return {
        setContext: (next) =>
          Ref.update(contextRef, (current) => ({
            ...current,
            ...next,
          })),
        setEnabled: (enabled) =>
          Effect.gen(function* () {
            const existing = yield* readTelemetryConfig;
            const next = {
              ...(existing?.config ?? createDefaultConfig()),
              enabled,
            } satisfies TelemetryConfig;

            yield* saveTelemetryConfig(next);
            return next;
          }),
        getStatus: () =>
          Effect.gen(function* () {
            const existing = yield* readTelemetryConfig;

            return {
              distinctId: existing?.config.distinctId ?? null,
              enabled: existing?.config.enabled ?? true,
              envDisabled: isEnvDisabled(),
            } satisfies TelemetryStatus;
          }),
        trackEvent: ({ event, properties }) =>
          Effect.gen(function* () {
            if (isEnvDisabled() || !POSTHOG_KEY) {
              return;
            }

            const config = yield* getOrCreateTelemetryConfig.pipe(Effect.orElseSucceed(() => null));

            if (config === null || !config.enabled) {
              return;
            }

            const context = yield* Ref.get(contextRef);

            yield* posthogCapture({
              api_key: POSTHOG_KEY,
              distinct_id: config.distinctId,
              event,
              properties: buildProperties({
                context,
                properties,
              }),
            }).pipe(Effect.orElseSucceed(() => undefined));
          }),
      } satisfies TelemetryService;
    });
}

export const setTelemetryContext = (next: TelemetryContext) =>
  Effect.gen(function* () {
    const telemetry = yield* Telemetry;
    return yield* telemetry.setContext(next);
  });

export const setTelemetryEnabled = (enabled: boolean) =>
  Effect.gen(function* () {
    const telemetry = yield* Telemetry;
    return yield* telemetry.setEnabled(enabled);
  });

export const getTelemetryStatus = Effect.gen(function* () {
  const telemetry = yield* Telemetry;
  return yield* telemetry.getStatus();
});

export const trackTelemetryEvent = (args: {
  readonly event: string;
  readonly properties?: Record<string, unknown>;
}) =>
  Effect.gen(function* () {
    const telemetry = yield* Telemetry;
    return yield* telemetry.trackEvent(args);
  });

export const runTrackedCliCommand = <A, E, R>({
  command,
  mode,
  eventName = mode,
  startProperties,
  successProperties,
  failureProperties,
  action,
}: TrackedCliCommandArgs<A, E, R>) =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    const baseProperties = {
      command,
      mode,
      ...startProperties,
    };

    yield* trackTelemetryEvent({
      event: "cli_started",
      properties: baseProperties,
    });

    yield* trackTelemetryEvent({
      event: `cli_${eventName}_started`,
      properties: baseProperties,
    });

    const exit = yield* Effect.exit(action);

    if (exit._tag === "Success") {
      yield* trackTelemetryEvent({
        event: `cli_${eventName}_completed`,
        properties: {
          ...baseProperties,
          durationMs: Date.now() - startedAt,
          exitCode: 0,
          ...successProperties?.(exit.value),
        },
      });

      return exit.value;
    }

    yield* trackTelemetryEvent({
      event: `cli_${eventName}_failed`,
      properties: {
        ...baseProperties,
        durationMs: Date.now() - startedAt,
        errorName: String(exit.cause),
        exitCode: 1,
        ...failureProperties?.(exit.cause),
      },
    });

    return yield* Effect.failCause(exit.cause);
  });
