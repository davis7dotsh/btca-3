import type { RequestHandler } from "@sveltejs/kit";

const getRequiredValue = (name: string) => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
};

const getAuthkitDomain = () => new URL(getRequiredValue("WORKOS_AUTHKIT_DOMAIN"));

const corsHeaders = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "WWW-Authenticate, mcp-session-id",
});

export const GET: RequestHandler = async ({ request }) => {
  const upstreamUrl = new URL("/.well-known/oauth-authorization-server", getAuthkitDomain());
  upstreamUrl.search = new URL(request.url).search;

  const upstreamResponse = await fetch(upstreamUrl, {
    headers: {
      accept: request.headers.get("accept") ?? "application/json",
    },
  });
  const responseText = await upstreamResponse.text();
  const headers = new Headers({
    "Cache-Control": "no-store",
    ...corsHeaders(),
  });
  const contentType = upstreamResponse.headers.get("content-type");

  if (contentType) {
    headers.set("content-type", contentType);
  }

  return new Response(responseText, {
    status: upstreamResponse.status,
    headers,
  });
};
