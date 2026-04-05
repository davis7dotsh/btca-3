import { env as privateEnv } from "$env/dynamic/private";
import { api } from "@btca/convex/api";
import { WorkOS } from "@workos-inc/node";
import type { RequestEvent } from "@sveltejs/kit";
import { Data, Effect, Layer, ServiceMap } from "effect";
import { ConvexPrivateService } from "./convex";

export const AUTH_SESSION_COOKIE_NAME = "wos-session";

export class AuthError extends Data.TaggedError("AuthError")<{
  readonly message: string;
  readonly kind: string;
  readonly traceId: string;
  readonly timestamp: number;
  readonly cause?: unknown;
}> {}

const getRequiredValue = (value: string | undefined, key: string) => {
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }

  return value;
};

const getCookiePassword = () =>
  getRequiredValue(privateEnv.WORKOS_COOKIE_PASSWORD, "WORKOS_COOKIE_PASSWORD");

const getClientId = () => getRequiredValue(privateEnv.WORKOS_CLIENT_ID, "WORKOS_CLIENT_ID");

const getApiKey = () => getRequiredValue(privateEnv.WORKOS_API_KEY, "WORKOS_API_KEY");

const createAuthError = ({
  message,
  kind,
  cause,
}: {
  message: string;
  kind: string;
  cause?: unknown;
}) =>
  new AuthError({
    message,
    kind,
    traceId: crypto.randomUUID(),
    timestamp: Date.now(),
    cause,
  });

const mapUser = (
  user: {
    id: string;
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    profilePictureUrl?: string | null;
  },
  userId = user.id,
) => ({
  id: userId,
  email: user.email ?? null,
  firstName: user.firstName ?? null,
  lastName: user.lastName ?? null,
  profilePictureUrl: user.profilePictureUrl ?? null,
});

type WorkosUser = {
  id: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  profilePictureUrl?: string | null;
  externalId?: string | null;
  metadata?: Record<string, unknown> | null;
};

const getLegacyClerkUserId = (user: WorkosUser) => {
  if (typeof user.externalId === "string" && user.externalId.length > 0) {
    return {
      legacyClerkUserId: user.externalId,
      source: "externalId" as const,
    };
  }

  const metadataClerkUserId = user.metadata?.clerkUserId;

  if (typeof metadataClerkUserId === "string" && metadataClerkUserId.length > 0) {
    return {
      legacyClerkUserId: metadataClerkUserId,
      source: "metadata.clerkUserId" as const,
    };
  }

  return {
    legacyClerkUserId: null,
    source: "none" as const,
  };
};

const fetchFullWorkosUser = ({ workos, user }: { workos: WorkOS; user: WorkosUser }) =>
  Effect.tryPromise({
    try: async () => {
      try {
        return await workos.userManagement.getUser(user.id);
      } catch (cause) {
        createAuthError({
          message: `Failed to load the full WorkOS profile for ${user.id}.`,
          kind: "workos_get_user_error",
          cause,
        });

        return user;
      }
    },
    catch: (cause) =>
      createAuthError({
        message: `Unexpected failure while hydrating WorkOS user ${user.id}.`,
        kind: "workos_get_user_unexpected_error",
        cause,
      }),
  });

const normalizeWorkosUser = (
  user: WorkosUser,
  accessToken: string,
  sessionId: string,
  userId: string,
  legacyClerkUserId: string | null,
  sealedSession?: string,
) => ({
  user: mapUser(user, userId),
  userId,
  workosUserId: user.id,
  legacyClerkUserId,
  email: user.email ?? null,
  accessToken,
  sessionId,
  sealedSession,
});

const readCookieValue = (cookieHeader: string | null, key: string) => {
  if (!cookieHeader) {
    return null;
  }

  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");

    if (rawName !== key) {
      continue;
    }

    return decodeURIComponent(rawValue.join("="));
  }

  return null;
};

interface AuthDef {
  getAuthorizationUrl: (options: {
    redirectUri: string;
    returnTo: string;
  }) => Effect.Effect<string, AuthError>;
  authenticateWithCode: (options: { code: string }) => Effect.Effect<
    {
      sealedSession: string;
      user: ReturnType<typeof mapUser>;
    },
    AuthError
  >;
  validateSession: (event: RequestEvent) => Effect.Effect<
    {
      user: ReturnType<typeof mapUser>;
      userId: string;
      workosUserId: string;
      legacyClerkUserId: string | null;
      email: string | null;
      accessToken: string;
      sessionId: string;
      sealedSession?: string;
    },
    AuthError
  >;
  validateRequest: (request: Request) => Effect.Effect<
    {
      user: ReturnType<typeof mapUser>;
      userId: string;
      workosUserId: string;
      legacyClerkUserId: string | null;
      email: string | null;
      accessToken: string;
      sessionId: string;
      sealedSession?: string;
    },
    AuthError
  >;
  getLogoutUrl: (event: RequestEvent, returnTo: string) => Effect.Effect<string, AuthError>;
}

export class AuthService extends ServiceMap.Service<AuthService, AuthDef>()("AuthService") {
  static readonly layer = Layer.effect(
    AuthService,
    Effect.gen(function* () {
      const convex = yield* ConvexPrivateService;
      const workos = new WorkOS(getApiKey(), {
        clientId: getClientId(),
      });

      const resolveCanonicalIdentity = (user: WorkosUser) =>
        Effect.gen(function* () {
          const { legacyClerkUserId, source } = getLegacyClerkUserId(user);

          if (!legacyClerkUserId) {
            return {
              canonicalUserId: user.id,
              legacyClerkUserId: null,
              workosUserId: user.id,
              legacyClerkUserIdSource: source,
            };
          }

          return yield* convex
            .mutation({
              func: api.private.identityLinks.upsert,
              args: {
                clerkUserId: legacyClerkUserId,
                workosUserId: user.id,
                primaryEmail: user.email ?? undefined,
                migrationSource: source === "externalId" ? "workos_external_id" : "manual",
                status: "linked",
              },
            })
            .pipe(
              Effect.map((identity) => ({
                ...identity,
                legacyClerkUserIdSource: source,
              })),
            )
            .pipe(
              Effect.mapError((cause) =>
                createAuthError({
                  message: "Failed to sync the current identity link.",
                  kind: "identity_link_sync_error",
                  cause,
                }),
              ),
            );
        });

      const validateSealedSession = (sessionData: string) =>
        Effect.gen(function* () {
          const session = workos.userManagement.loadSealedSession({
            sessionData,
            cookiePassword: getCookiePassword(),
          });
          const authentication = yield* Effect.tryPromise({
            try: () => session.authenticate(),
            catch: (cause) =>
              createAuthError({
                message: "Failed to read the current session.",
                kind: "session_authentication_error",
                cause,
              }),
          });

          if (authentication.authenticated) {
            const fullUser = yield* fetchFullWorkosUser({
              workos,
              user: authentication.user,
            });
            const identity = yield* resolveCanonicalIdentity(fullUser);

            return normalizeWorkosUser(
              fullUser,
              authentication.accessToken,
              authentication.sessionId,
              identity.canonicalUserId,
              identity.legacyClerkUserId,
            );
          }

          if (authentication.reason === "no_session_cookie_provided") {
            return yield* Effect.fail(
              createAuthError({
                message: "Unauthorized",
                kind: authentication.reason,
              }),
            );
          }

          const refresh = yield* Effect.tryPromise({
            try: () => session.refresh({ cookiePassword: getCookiePassword() }),
            catch: (cause) =>
              createAuthError({
                message: "Failed to refresh the current session.",
                kind: "session_refresh_error",
                cause,
              }),
          });

          if (!refresh.authenticated) {
            return yield* Effect.fail(
              createAuthError({
                message: "Unauthorized",
                kind: refresh.reason,
              }),
            );
          }

          if (!refresh.session) {
            return yield* Effect.fail(
              createAuthError({
                message: "Unauthorized",
                kind: "missing_refreshed_session",
              }),
            );
          }

          const fullUser = yield* fetchFullWorkosUser({
            workos,
            user: refresh.user,
          });
          const identity = yield* resolveCanonicalIdentity(fullUser);

          return normalizeWorkosUser(
            fullUser,
            refresh.session.accessToken,
            refresh.sessionId,
            identity.canonicalUserId,
            identity.legacyClerkUserId,
            refresh.sealedSession,
          );
        });

      const getAuthorizationUrl: AuthDef["getAuthorizationUrl"] = ({ redirectUri, returnTo }) =>
        Effect.try({
          try: () =>
            workos.userManagement.getAuthorizationUrl({
              provider: "authkit",
              redirectUri,
              clientId: getClientId(),
              state: returnTo,
            }),
          catch: (cause) =>
            createAuthError({
              message: "Failed to generate the login URL.",
              kind: "authorization_url_error",
              cause,
            }),
        });

      const authenticateWithCode: AuthDef["authenticateWithCode"] = ({ code }) =>
        Effect.gen(function* () {
          const authentication = yield* Effect.tryPromise({
            try: () =>
              workos.userManagement.authenticateWithCode({
                clientId: getClientId(),
                code,
                session: {
                  sealSession: true,
                  cookiePassword: getCookiePassword(),
                },
              }),
            catch: (cause) =>
              createAuthError({
                message: "Failed to authenticate the login callback.",
                kind: "callback_authentication_error",
                cause,
              }),
          });

          if (!authentication.sealedSession) {
            return yield* Effect.fail(
              createAuthError({
                message: "WorkOS did not return a sealed session",
                kind: "missing_sealed_session",
              }),
            );
          }

          const fullUser = yield* fetchFullWorkosUser({
            workos,
            user: authentication.user,
          });
          const identity = yield* resolveCanonicalIdentity(fullUser);

          return {
            sealedSession: authentication.sealedSession,
            user: mapUser(fullUser, identity.canonicalUserId),
          };
        });

      const validateSession: AuthDef["validateSession"] = (event) =>
        validateSealedSession(event.cookies.get(AUTH_SESSION_COOKIE_NAME) ?? "");

      const validateRequest: AuthDef["validateRequest"] = (request) =>
        validateSealedSession(
          readCookieValue(request.headers.get("cookie"), AUTH_SESSION_COOKIE_NAME) ?? "",
        );

      const getLogoutUrl: AuthDef["getLogoutUrl"] = (event, returnTo) =>
        Effect.gen(function* () {
          const session = workos.userManagement.loadSealedSession({
            sessionData: event.cookies.get(AUTH_SESSION_COOKIE_NAME) ?? "",
            cookiePassword: getCookiePassword(),
          });

          return yield* Effect.tryPromise({
            try: () => session.getLogoutUrl({ returnTo }),
            catch: (cause) =>
              createAuthError({
                message: "Failed to create the logout URL.",
                kind: "logout_url_error",
                cause,
              }),
          });
        });

      return {
        getAuthorizationUrl,
        authenticateWithCode,
        validateSession,
        validateRequest,
        getLogoutUrl,
      };
    }),
  );
}
