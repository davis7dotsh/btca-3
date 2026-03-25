import { env as privateEnv } from "$env/dynamic/private";
import { runtime } from "$lib/runtime";
import { AgentService } from "$lib/services/agent";
import { ZodJsonSchemaAdapter } from "@tmcp/adapter-zod";
import { HttpTransport } from "@tmcp/transport-http";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { Effect } from "effect";
import { McpServer } from "tmcp";
import { tool } from "tmcp/utils";
import type { RequestHandler } from "@sveltejs/kit";
import { z } from "zod";

type McpAuthContext = {
  accessToken: string;
  userId: string;
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

const getRequiredValue = (name: string) => {
  const value = privateEnv[name];

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
};

const getRequiredUrl = (name: string) => new URL(getRequiredValue(name));

const getAuthkitDomain = () => getRequiredUrl("WORKOS_AUTHKIT_DOMAIN");

const getPublicOrigin = (request: Request) =>
  new URL(privateEnv.MCP_PUBLIC_URL ?? request.url).origin;

const corsHeaders = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "WWW-Authenticate, mcp-session-id",
});

const readBearerToken = (authorizationHeader: string | null) =>
  authorizationHeader?.match(/^Bearer\s+(.+)$/i)?.[1];

const unauthorized = (request: Request) => {
  const metadataUrl = new URL("/.well-known/oauth-protected-resource", getPublicOrigin(request));

  return Response.json(
    {
      error: "Unauthorized",
    },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": [
          'Bearer error="unauthorized"',
          'error_description="Authorization needed"',
          `resource_metadata="${metadataUrl.href}"`,
        ].join(", "),
        "Cache-Control": "no-store",
        ...corsHeaders(),
      },
    },
  );
};

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

const askAgent = (input: { userId: string; prompt: string; threadId?: string; modelId?: string }) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const agent = yield* AgentService;
      const threadId = input.threadId ?? crypto.randomUUID();
      const { events, model, sandboxId } = yield* agent.promptThread({
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
        sandboxId,
        modelId: model.id,
        modelLabel: model.label,
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

server.tool(
  {
    name: "ask",
    description:
      "Ask the existing pi-land agent a question. Reuse threadId to continue an existing conversation.",
    schema: ASK_TOOL_INPUT,
    outputSchema: z.object({
      answer: z.string(),
      threadId: z.string(),
      sandboxId: z.string(),
      modelId: z.string(),
      modelLabel: z.string(),
    }),
  },
  async ({ prompt, threadId, modelId }) => {
    const auth = server.ctx.custom;

    if (!auth) {
      return tool.error("Authentication context missing.");
    }

    try {
      const response = await askAgent({
        userId: auth.userId,
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

const handle: RequestHandler = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return (await transport.respond(request)) ?? new Response("Not Found", { status: 404 });
  }

  const token = readBearerToken(request.headers.get("authorization"));

  if (!token) {
    return unauthorized(request);
  }

  try {
    const { payload } = await jwtVerify<WorkosClaims>(token, getJwks(), {
      issuer: getAuthkitDomain().origin,
    });

    if (!payload.sub) {
      return unauthorized(request);
    }

    return (
      (await transport.respond(request, {
        accessToken: token,
        userId: payload.sub,
        organizationId: typeof payload.org_id === "string" ? payload.org_id : undefined,
        permissions: getPermissions(payload.permissions),
        expiresAt: typeof payload.exp === "number" ? payload.exp : undefined,
      })) ?? new Response("Not Found", { status: 404 })
    );
  } catch (error) {
    console.error("Failed to verify MCP access token", {
      error: error instanceof Error ? error.message : String(error),
    });

    return unauthorized(request);
  }
};

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
export const OPTIONS = handle;
