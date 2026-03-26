import { buildAuthorizationServerMetadata } from "$lib/server/mcpAuthMetadata";
import type { RequestHandler } from "@sveltejs/kit";

const responseHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
  "Content-Type": "application/json",
} as const;

export const GET: RequestHandler = async ({ request }) =>
  Response.json(buildAuthorizationServerMetadata(request), {
    headers: responseHeaders,
  });
