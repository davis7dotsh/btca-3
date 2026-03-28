import { randomUUID } from "node:crypto";
import { NodeServices } from "@effect/platform-node";
import { error } from "@sveltejs/kit";
import { Cause, Data, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { serializeUnknown, serverLogger } from "./server/logger";
import { AgentError, AgentService } from "./services/agent";
import { AutumnService, AutumnServiceError } from "./services/autumn";
import { AuthError, AuthService } from "./services/auth";
import { BoxService, BoxServiceError } from "./services/box";
import { ConvexError, ConvexPrivateService } from "./services/convex";
import { ExaService, ExaServiceError } from "./services/exa";
import { RunControlService } from "./services/runControl";
import { RunStreamService, RunStreamServiceError } from "./services/runStream";

const appLayer = Layer.mergeAll(
  NodeServices.layer,
  ConvexPrivateService.layer,
  AutumnService.layer,
  AuthService.layer,
  ExaService.layer,
  BoxService.layer,
  RunControlService.layer,
  RunStreamService.layer,
  AgentService.layer,
);

export const runtime = ManagedRuntime.make(appLayer);

export class GenericError extends Data.TaggedError("GenericError")<{
  readonly message: string;
  readonly status: number;
  readonly kind: string;
  readonly timestamp: number;
  readonly traceId: string;
  readonly cause?: unknown;
}> {}

export const createGenericError = ({
  message,
  status,
  kind,
  cause,
}: {
  message: string;
  status: number;
  kind: string;
  cause?: unknown;
}) =>
  new GenericError({
    message,
    status,
    kind,
    timestamp: Date.now(),
    traceId: randomUUID(),
    cause,
  });

const toPublicError = (
  errorValue: Pick<
    | GenericError
    | ConvexError
    | AuthError
    | ExaServiceError
    | BoxServiceError
    | AgentError
    | AutumnServiceError
    | RunStreamServiceError,
    "message" | "kind" | "timestamp" | "traceId"
  >,
) => ({
  message: errorValue.message,
  kind: errorValue.kind,
  timestamp: errorValue.timestamp,
  traceId: errorValue.traceId,
});

const logTaggedError = (
  errorValue:
    | GenericError
    | ConvexError
    | AuthError
    | ExaServiceError
    | BoxServiceError
    | AgentError
    | AutumnServiceError
    | RunStreamServiceError,
) => {
  if (errorValue instanceof ConvexError) {
    serverLogger.error("Convex error", {
      traceId: errorValue.traceId,
      kind: errorValue.kind,
      timestamp: errorValue.timestamp,
      operation: errorValue.operation,
      functionName: errorValue.functionName,
      componentPath: errorValue.componentPath,
      message: errorValue.message,
      cause: serializeUnknown(errorValue.cause),
    });

    return;
  }

  if (errorValue instanceof AuthError) {
    serverLogger.error("Auth error", {
      traceId: errorValue.traceId,
      kind: errorValue.kind,
      timestamp: errorValue.timestamp,
      message: errorValue.message,
      cause: serializeUnknown(errorValue.cause),
    });

    return;
  }

  if (errorValue instanceof ExaServiceError) {
    serverLogger.error("Exa service error", {
      traceId: errorValue.traceId,
      kind: errorValue.kind,
      timestamp: errorValue.timestamp,
      operation: errorValue.operation,
      message: errorValue.message,
      cause: serializeUnknown(errorValue.cause),
    });

    return;
  }

  if (errorValue instanceof BoxServiceError) {
    serverLogger.error("Box service error", {
      traceId: errorValue.traceId,
      kind: errorValue.kind,
      timestamp: errorValue.timestamp,
      operation: errorValue.operation,
      message: errorValue.message,
      cause: serializeUnknown(errorValue.cause),
    });

    return;
  }

  if (errorValue instanceof AgentError) {
    serverLogger.error("Agent service error", {
      traceId: errorValue.traceId,
      kind: errorValue.kind,
      timestamp: errorValue.timestamp,
      operation: errorValue.operation,
      message: errorValue.message,
      cause: serializeUnknown(errorValue.cause),
    });

    return;
  }

  if (errorValue instanceof AutumnServiceError) {
    serverLogger.error("Autumn service error", {
      traceId: errorValue.traceId,
      kind: errorValue.kind,
      timestamp: errorValue.timestamp,
      operation: errorValue.operation,
      message: errorValue.message,
      cause: serializeUnknown(errorValue.cause),
    });

    return;
  }

  if (errorValue instanceof RunStreamServiceError) {
    serverLogger.error("Run stream service error", {
      traceId: errorValue.traceId,
      kind: errorValue.kind,
      timestamp: errorValue.timestamp,
      operation: errorValue.operation,
      message: errorValue.message,
      cause: serializeUnknown(errorValue.cause),
    });

    return;
  }

  serverLogger.error("Application error", {
    traceId: errorValue.traceId,
    kind: errorValue.kind,
    timestamp: errorValue.timestamp,
    status: errorValue.status,
    message: errorValue.message,
    cause: serializeUnknown(errorValue.cause),
  });
};

export const effectRunner = async <T>(
  effect: Effect.Effect<
    T,
    | GenericError
    | ConvexError
    | AuthError
    | ExaServiceError
    | BoxServiceError
    | AgentError
    | AutumnServiceError,
    | NodeServices.NodeServices
    | ConvexPrivateService
    | AutumnService
    | AuthService
    | ExaService
    | BoxService
    | RunControlService
    | RunStreamService
    | AgentService
  >,
) => {
  const exit = await runtime.runPromiseExit(effect);

  if (Exit.isFailure(exit)) {
    const cause = exit.cause;

    for (const reason of cause.reasons) {
      if (Cause.isFailReason(reason)) {
        const failError = reason.error;
        const failErrorObject = failError as object;

        if (
          typeof failError === "object" &&
          failError !== null &&
          (failError instanceof GenericError ||
            failError instanceof ConvexError ||
            failError instanceof AuthError ||
            failError instanceof ExaServiceError ||
            failError instanceof BoxServiceError ||
            failError instanceof AgentError ||
            failErrorObject instanceof AutumnServiceError ||
            failErrorObject instanceof RunStreamServiceError)
        ) {
          logTaggedError(
            failError as
              | GenericError
              | ConvexError
              | AuthError
              | ExaServiceError
              | BoxServiceError
              | AgentError
              | AutumnServiceError
              | RunStreamServiceError,
          );
        } else {
          serverLogger.error("Unhandled effect error", {
            error: serializeUnknown(failError),
          });
        }
      } else if (Cause.isDieReason(reason)) {
        serverLogger.error("Effect defect", {
          defect: serializeUnknown(reason.defect),
        });
      } else if (Cause.isInterruptReason(reason)) {
        serverLogger.error("Effect interrupted", {
          fiberId: reason.fiberId,
        });
      }
    }

    const firstError = Cause.findErrorOption(cause);
    if (firstError._tag === "Some") {
      if (firstError.value instanceof ConvexError) {
        return error(500, toPublicError(firstError.value));
      }

      if (firstError.value instanceof AuthError) {
        return error(401, toPublicError(firstError.value));
      }

      if (firstError.value instanceof ExaServiceError) {
        return error(500, toPublicError(firstError.value));
      }

      if (firstError.value instanceof BoxServiceError) {
        return error(500, toPublicError(firstError.value));
      }

      if (firstError.value instanceof AgentError) {
        return error(500, toPublicError(firstError.value));
      }

      if (firstError.value instanceof AutumnServiceError) {
        return error(500, toPublicError(firstError.value));
      }

      if (firstError.value instanceof GenericError) {
        return error(firstError.value.status, toPublicError(firstError.value));
      }
    }

    const unknownError = createGenericError({
      message: "An unknown error occurred",
      status: 500,
      kind: "unknown_error",
      cause,
    });

    logTaggedError(unknownError);

    return error(unknownError.status, toPublicError(unknownError));
  }

  return exit.value;
};
