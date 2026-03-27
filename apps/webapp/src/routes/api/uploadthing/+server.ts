import type { RequestHandler } from "@sveltejs/kit";
import { uploadthingRouteHandler } from "$lib/server/uploadthing";

export const GET: RequestHandler = ({ request }) => uploadthingRouteHandler(request);
export const POST: RequestHandler = ({ request }) => uploadthingRouteHandler(request);
