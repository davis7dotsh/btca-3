import { api } from "@btca/convex/api";
import { runtime } from "$lib/runtime";
import { getAuthkitDomain, getProtectedResourceMetadataUrl } from "$lib/server/mcpAuthMetadata";
import { AgentService } from "$lib/services/agent";
import { AuthService } from "$lib/services/auth";
import { AutumnService } from "$lib/services/autumn";
import { ConvexPrivateService } from "$lib/services/convex";
import {
  getRateLimitHeaders,
  RateLimitService,
  type RateLimitCheckResult,
} from "$lib/services/rateLimit";
import { ZodJsonSchemaAdapter } from "@tmcp/adapter-zod";
import { HttpTransport } from "@tmcp/transport-http";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from "jose";
import { Effect } from "effect";
import { waitUntil } from "@vercel/functions";
import { McpServer } from "tmcp";
import { tool } from "tmcp/utils";
import type { RequestHandler } from "@sveltejs/kit";
import { z } from "zod";

type McpAuthContext = {
  accessToken: string;
  userId: string;
  workosUserId: string;
  legacyClerkUserId: string | null;
  email: string | null;
  name: string | null;
  organizationId?: string;
  permissions: string[];
  expiresAt?: number;
};

type WorkosClaims = JWTPayload & {
  org_id?: string;
  permissions?: string[];
};

const ASK_TOOL_INPUT = z.object({
  prompt: z.string().min(1),
  threadId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
});

const LIST_RESOURCES_TOOL_INPUT = z.object({
  includeItems: z.boolean().optional(),
});

const RESOURCE_ITEM_SCHEMA = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  url: z.string(),
  iconUrl: z.string().nullable(),
  sortOrder: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const RESOURCE_SUMMARY_SCHEMA = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  itemCount: z.number(),
  items: z.array(RESOURCE_ITEM_SCHEMA).optional(),
});

const RESOURCE_CATALOG_URI = "btca://resources/catalog.json";
const MCP_AUTH_CHANGED_MESSAGE =
  "BTCA MCP auth has changed. Update your config from https://btca.dev/app/mcp/getting-started";
const MCP_NO_USAGE_MESSAGE = "No usage remaining. Upgrade to Pro to continue.";

const corsHeaders = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers":
    "WWW-Authenticate, mcp-session-id, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset",
});

const readBearerToken = (authorizationHeader: string | null) =>
  authorizationHeader?.match(/^Bearer\s+(.+)$/i)?.[1];

const unauthorized = (request: Request) => {
  const metadataUrl = getProtectedResourceMetadataUrl(request);

  return Response.json(
    {
      error: "Unauthorized",
      message: MCP_AUTH_CHANGED_MESSAGE,
    },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": [
          'Bearer error="unauthorized"',
          `error_description="${MCP_AUTH_CHANGED_MESSAGE}"`,
          `resource_metadata="${metadataUrl}"`,
        ].join(", "),
        "Cache-Control": "no-store",
        ...corsHeaders(),
      },
    },
  );
};

const rateLimited = ({
  message,
  result,
}: {
  message: string;
  result: Pick<RateLimitCheckResult, "limit" | "remaining" | "reset">;
}) =>
  Response.json(
    {
      error: "Rate limit exceeded",
      message,
    },
    {
      status: 429,
      headers: {
        "Cache-Control": "no-store",
        ...corsHeaders(),
        ...getRateLimitHeaders(result),
      },
    },
  );

const internalServerError = (message = "Failed to process the MCP request.") =>
  Response.json(
    {
      error: "Internal Server Error",
      message,
    },
    {
      status: 500,
      headers: {
        "Cache-Control": "no-store",
        ...corsHeaders(),
      },
    },
  );

const getPermissions = (permissions: unknown) =>
  Array.isArray(permissions)
    ? permissions.filter((permission): permission is string => typeof permission === "string")
    : [];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const extractTextContent = (value: unknown) => {
  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .flatMap((part) => {
      if (isRecord(part) && typeof part.text === "string") {
        return [part.text];
      }

      return [];
    })
    .join("\n\n");
};

const collectAssistantAnswer = async (events: AsyncIterable<AgentEvent>) => {
  let answer = "";

  for await (const event of events) {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      answer += event.assistantMessageEvent.delta;
      continue;
    }

    if (event.type === "message_end" && event.message.role === "assistant") {
      answer = extractTextContent(event.message.content);
    }
  }

  const trimmedAnswer = answer.trim();

  return trimmedAnswer.length > 0 ? trimmedAnswer : "Agent completed without a text response.";
};

const formatResourcesText = (
  resources: ReadonlyArray<{
    name: string;
    itemCount: number;
  }>,
) => {
  if (resources.length === 0) {
    return "No saved resources yet.";
  }

  return resources
    .map(
      (resource) =>
        `@${resource.name} (${resource.itemCount} item${resource.itemCount === 1 ? "" : "s"})`,
    )
    .join("\n\n");
};

const askAgent = (input: {
  userId: string;
  email?: string | null;
  name?: string | null;
  prompt: string;
  threadId?: string;
  modelId?: string;
}) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const autumn = yield* AutumnService;
      const agent = yield* AgentService;
      const usageAllowed = yield* autumn.checkUsageBalance({
        userId: input.userId,
        email: input.email,
        name: input.name,
        requiredBalance: 0.000001,
      });

      if (!usageAllowed) {
        return yield* Effect.fail(new Error(MCP_NO_USAGE_MESSAGE));
      }

      const threadId = input.threadId ?? crypto.randomUUID();
      const { events, model, sandboxId } = yield* agent.promptThread({
        runId: `mcp-${crypto.randomUUID()}`,
        threadId,
        prompt: input.prompt,
        modelId: input.modelId,
        userId: input.userId,
        isMcp: true,
      });
      const answer = yield* Effect.tryPromise({
        try: () => collectAssistantAnswer(events),
        catch: (cause) =>
          new Error(
            cause instanceof Error ? cause.message : "Failed to collect the agent response.",
          ),
      });

      return {
        answer,
        threadId,
        sandboxId: sandboxId ?? null,
        modelId: model.id,
        modelLabel: model.label,
      };
    }),
  );

const listResources = (input: { userId: string; includeItems?: boolean }) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const convex = yield* ConvexPrivateService;
      const resources = yield* convex.query({
        func: api.private.resources.listForMcp,
        args: {
          userId: input.userId,
          includeItems: input.includeItems ?? false,
        },
      });

      return {
        resources,
        count: resources.length,
      };
    }),
  );

const server = new McpServer(
  {
    name: "pi-land-agent",
    version: "1.0.0",
    description: "Remote MCP access to the existing pi-land research agent.",
  },
  {
    adapter: new ZodJsonSchemaAdapter(),
    capabilities: {
      tools: { listChanged: true },
      resources: { listChanged: true },
    },
  },
).withContext<McpAuthContext>();

const transport = new HttpTransport(server, {
  path: "/api/mcp",
  cors: true,
  disableSse: true,
});

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

const getJwks = () => {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL("/oauth2/jwks", getAuthkitDomain()));
  }

  return jwks;
};

const verifyAccessToken = async (token: string) => {
  const { payload } = await jwtVerify<WorkosClaims>(token, getJwks(), {
    issuer: getAuthkitDomain().origin,
  });

  const workosUserId = payload.sub;

  if (!workosUserId) {
    throw new Error("Missing subject claim in MCP access token.");
  }

  return {
    payload,
    workosUserId,
  };
};

const resolveCanonicalMcpUser = (workosUserId: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const auth = yield* AuthService;
      return yield* auth.resolveCanonicalWorkosUser({ workosUserId });
    }),
  );

server.tool(
  {
    name: "ask",
    description:
      "Ask the existing pi-land agent a question. Reuse threadId to continue an existing conversation.",
    schema: ASK_TOOL_INPUT,
    outputSchema: z.object({
      answer: z.string(),
      threadId: z.string(),
      sandboxId: z.string().nullable(),
      modelId: z.string(),
      modelLabel: z.string(),
    }),
  },
  async ({ prompt, threadId, modelId }) => {
    const auth = server.ctx.custom;

    if (!auth) {
      return tool.error(MCP_AUTH_CHANGED_MESSAGE);
    }

    try {
      const response = await askAgent({
        userId: auth.userId,
        email: auth.email,
        name: auth.name,
        prompt,
        threadId,
        modelId,
      });

      return tool.mix([tool.text(response.answer)], response);
    } catch (error) {
      return tool.error(error instanceof Error ? error.message : "Failed to run the MCP ask tool.");
    }
  },
);

server.tool(
  {
    name: "list_resources",
    description: "List the authenticated user's saved btca resources.",
    schema: LIST_RESOURCES_TOOL_INPUT,
    outputSchema: z.object({
      count: z.number(),
      resources: z.array(RESOURCE_SUMMARY_SCHEMA),
    }),
  },
  async ({ includeItems }) => {
    const auth = server.ctx.custom;

    if (!auth) {
      return tool.error(MCP_AUTH_CHANGED_MESSAGE);
    }

    try {
      const response = await listResources({
        userId: auth.userId,
        includeItems,
      });

      return tool.mix([tool.text(formatResourcesText(response.resources))], response);
    } catch (error) {
      return tool.error(error instanceof Error ? error.message : "Failed to list btca resources.");
    }
  },
);

server.resource(
  {
    uri: RESOURCE_CATALOG_URI,
    name: "resource_catalog",
    title: "btca Resource Catalog",
    description: "A JSON snapshot of the authenticated user's saved btca resources.",
  },
  async (uri) => {
    const auth = server.ctx.custom;

    if (!auth) {
      return {
        contents: [
          {
            uri,
            text: JSON.stringify(
              {
                error: MCP_AUTH_CHANGED_MESSAGE,
              },
              null,
              2,
            ),
            mimeType: "application/json",
          },
        ],
      };
    }

    const response = await listResources({
      userId: auth.userId,
      includeItems: true,
    });

    return {
      contents: [
        {
          uri,
          text: JSON.stringify(response, null, 2),
          mimeType: "application/json",
        },
      ],
    };
  },
);

const handle: RequestHandler = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return (await transport.respond(request)) ?? new Response("Not Found", { status: 404 });
  }

  const token = readBearerToken(request.headers.get("authorization"));

  if (!token) {
    return unauthorized(request);
  }

  let verifiedToken: Awaited<ReturnType<typeof verifyAccessToken>>;

  try {
    verifiedToken = await verifyAccessToken(token);
  } catch (error) {
    if (error instanceof errors.JWTExpired) {
      console.info(
        "MCP access token expired during verification; returning 401 so the client can refresh and retry.",
        {
          claim: error.claim,
          reason: error.reason,
          expiresAt: typeof error.payload.exp === "number" ? error.payload.exp : undefined,
        },
      );

      return unauthorized(request);
    }

    console.error("Failed to verify MCP access token", {
      error: error instanceof Error ? error.message : String(error),
    });

    return unauthorized(request);
  }

  try {
    const canonicalUser = await resolveCanonicalMcpUser(verifiedToken.workosUserId);
    const mcpRateLimit = await runtime.runPromise(
      Effect.gen(function* () {
        const rateLimit = yield* RateLimitService;
        return yield* rateLimit.checkMcp(canonicalUser.userId);
      }),
    );
    waitUntil(mcpRateLimit.pending);

    if (!mcpRateLimit.allowed) {
      return rateLimited({
        message: "Rate limit exceeded. MCP is limited to 5 messages per second.",
        result: mcpRateLimit,
      });
    }

    return (
      (await transport.respond(request, {
        accessToken: token,
        userId: canonicalUser.userId,
        workosUserId: canonicalUser.workosUserId,
        legacyClerkUserId: canonicalUser.legacyClerkUserId,
        email: canonicalUser.email,
        name: canonicalUser.user.firstName,
        organizationId:
          typeof verifiedToken.payload.org_id === "string"
            ? verifiedToken.payload.org_id
            : undefined,
        permissions: getPermissions(verifiedToken.payload.permissions),
        expiresAt:
          typeof verifiedToken.payload.exp === "number" ? verifiedToken.payload.exp : undefined,
      })) ?? new Response("Not Found", { status: 404 })
    );
  } catch (error) {
    console.error("Failed to resolve MCP user context", {
      error: error instanceof Error ? error.message : String(error),
    });

    return internalServerError();
  }
};

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
export const OPTIONS = handle;
