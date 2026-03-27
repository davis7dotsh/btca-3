import { env } from "$env/dynamic/private";
import { Axiom } from "@axiomhq/js";
import { trace } from "@opentelemetry/api";

const serviceName = "@btca/webapp";
const environment = env.NODE_ENV ?? "development";
const levelOrder = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
} as const;

type LogLevel = keyof typeof levelOrder;

const serializeUnknown = (value: unknown): unknown => {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: value.cause === undefined ? undefined : serializeUnknown(value.cause),
    };
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    return value;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return { nonSerializableValue: Object.prototype.toString.call(value) };
  }
};

const trimToUndefined = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

const parseLogLevel = (value: string | undefined): LogLevel | undefined => {
  const trimmed = trimToUndefined(value);

  if (trimmed === "debug" || trimmed === "info" || trimmed === "warn" || trimmed === "error") {
    return trimmed;
  }

  return undefined;
};

const logLevel = parseLogLevel(env.LOG_LEVEL) ?? (environment === "production" ? "info" : "debug");

const getAxiomClient = () => {
  const token = trimToUndefined(env.AXIOM_TOKEN);

  if (!token) {
    return null;
  }

  return new Axiom({
    token,
    url: trimToUndefined(env.AXIOM_URL),
    edge: trimToUndefined(env.AXIOM_EDGE),
    edgeUrl: trimToUndefined(env.AXIOM_EDGE_URL),
  });
};

const axiom = getAxiomClient();
const dataset = trimToUndefined(env.AXIOM_LOGS_DATASET);

const withTraceContext = (fields: Record<string, unknown> = {}) => {
  const spanContext = trace.getActiveSpan()?.spanContext();

  if (!spanContext) {
    return fields;
  }

  return {
    ...fields,
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
  };
};

const shouldLog = (level: LogLevel) => levelOrder[level] >= levelOrder[logLevel];

const writeConsole = (level: LogLevel, message: string, fields: Record<string, unknown>) => {
  const consoleMethod =
    level === "debug"
      ? console.debug
      : level === "info"
        ? console.info
        : level === "warn"
          ? console.warn
          : console.error;

  if (Object.keys(fields).length === 0) {
    consoleMethod(message);
    return;
  }

  consoleMethod(message, fields);
};

const writeAxiom = (entry: Record<string, unknown>) => {
  if (!axiom || !dataset) {
    return;
  }

  axiom.ingest(dataset, entry);
};

const log = (level: LogLevel, message: string, fields?: Record<string, unknown>) => {
  if (!shouldLog(level)) {
    return;
  }

  const event = {
    level,
    message,
    service: serviceName,
    environment,
    _time: new Date().toISOString(),
    ...withTraceContext(fields),
  };

  writeConsole(level, message, event);
  writeAxiom(event);
};

export const serverLogger = {
  debug(message: string, fields?: Record<string, unknown>) {
    log("debug", message, fields);
  },
  info(message: string, fields?: Record<string, unknown>) {
    log("info", message, fields);
  },
  warn(message: string, fields?: Record<string, unknown>) {
    log("warn", message, fields);
  },
  error(message: string, fields?: Record<string, unknown>) {
    log("error", message, fields);
  },
  flush() {
    return axiom?.flush() ?? Promise.resolve();
  },
};

export { serializeUnknown };
