import { env } from "$env/dynamic/private";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_NAMESPACE,
} from "@opentelemetry/semantic-conventions";

const serviceName = "@btca/webapp";
const environment = env.NODE_ENV ?? "development";

const trimToUndefined = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

const resolveTraceUrl = () => {
  const explicitUrl = trimToUndefined(env.AXIOM_OTLP_URL);

  if (explicitUrl) {
    return explicitUrl;
  }

  const endpoint = trimToUndefined(env.AXIOM_OTLP_ENDPOINT);

  if (!endpoint) {
    return undefined;
  }

  return endpoint.endsWith("/v1/traces") ? endpoint : `${endpoint.replace(/\/+$/, "")}/v1/traces`;
};

const createSdk = () => {
  const token = trimToUndefined(env.AXIOM_TOKEN);
  const dataset = trimToUndefined(env.AXIOM_TRACES_DATASET);
  const url = resolveTraceUrl();

  if (!token || !dataset || !url) {
    if (environment !== "test") {
      console.warn(
        "Axiom tracing is disabled. Set AXIOM_TOKEN, AXIOM_TRACES_DATASET, and AXIOM_OTLP_ENDPOINT or AXIOM_OTLP_URL to enable it.",
      );
    }

    return null;
  }

  return new NodeSDK({
    resource: resourceFromAttributes({
      [SEMRESATTRS_SERVICE_NAME]: serviceName,
      [SEMRESATTRS_SERVICE_NAMESPACE]: "btca",
      [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: environment,
    }),
    traceExporter: new OTLPTraceExporter({
      url,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Axiom-Dataset": dataset,
      },
    }),
  });
};

type OtelState = {
  sdk: NodeSDK | null;
  started: boolean;
  shutdownRegistered: boolean;
};

declare global {
  var __btcaWebappOtelState: OtelState | undefined;
}

const otelState =
  globalThis.__btcaWebappOtelState ??
  (globalThis.__btcaWebappOtelState = {
    sdk: createSdk(),
    started: false,
    shutdownRegistered: false,
  });

const registerShutdown = () => {
  if (!otelState.sdk || otelState.shutdownRegistered) {
    return;
  }

  otelState.shutdownRegistered = true;

  process.once("beforeExit", () => {
    void otelState.sdk?.shutdown().catch((error: unknown) => {
      console.error("Failed to shut down OpenTelemetry", error);
    });
  });
};

export async function register() {
  if (!otelState.sdk || otelState.started) {
    return;
  }

  otelState.started = true;
  registerShutdown();
  otelState.sdk.start();
}
