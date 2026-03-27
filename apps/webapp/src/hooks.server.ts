import { trace } from "@opentelemetry/api";
import type { Handle, HandleServerError } from "@sveltejs/kit";
import { serializeUnknown, serverLogger } from "$lib/server/logger";

export const handle: Handle = async ({ event, resolve }) => {
  event.tracing.root.setAttribute("btca.route.id", event.route.id ?? "unmatched");
  event.tracing.root.setAttribute("btca.request.method", event.request.method);
  event.tracing.root.setAttribute("btca.request.path", event.url.pathname);

  try {
    const response = await resolve(event);
    event.tracing.root.setAttribute("btca.response.status_code", response.status);
    return response;
  } finally {
    await serverLogger.flush();
  }
};

export const handleError: HandleServerError = ({ error, event, status, message }) => {
  const traceId = trace.getActiveSpan()?.spanContext().traceId;

  serverLogger.error("Unhandled SvelteKit server error", {
    traceId,
    status,
    message,
    routeId: event.route.id ?? null,
    pathname: event.url.pathname,
    error: serializeUnknown(error),
  });

  return {
    message,
    kind: "server_error",
    timestamp: Date.now(),
    traceId,
  };
};
