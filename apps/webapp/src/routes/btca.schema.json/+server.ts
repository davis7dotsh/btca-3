import { BTCA_CONFIG_JSON_SCHEMA } from "@btca/server/config-schema";
import type { RequestHandler } from "@sveltejs/kit";

const body = `${JSON.stringify(BTCA_CONFIG_JSON_SCHEMA, null, 2)}\n`;

export const GET: RequestHandler = () =>
  new Response(body, {
    headers: {
      "Cache-Control": "public, max-age=0, s-maxage=600",
      "Content-Type": "application/schema+json; charset=utf-8",
    },
  });
