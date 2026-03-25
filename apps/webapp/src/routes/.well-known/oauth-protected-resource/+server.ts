import type { RequestHandler } from "@sveltejs/kit";

const getRequiredValue = (name: string) => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
};

const getAuthkitDomain = () => new URL(getRequiredValue("WORKOS_AUTHKIT_DOMAIN"));

const getPublicOrigin = (request: Request) =>
  new URL(process.env.MCP_PUBLIC_URL ?? request.url).origin;

const corsHeaders = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "WWW-Authenticate, mcp-session-id",
});

export const GET: RequestHandler = async ({ request }) =>
  Response.json(
    {
      resource: getPublicOrigin(request),
      authorization_servers: [getAuthkitDomain().origin],
      bearer_methods_supported: ["header"],
    },
    {
      headers: {
        "Cache-Control": "no-store",
        ...corsHeaders(),
      },
    },
  );
