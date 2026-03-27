import type { LayoutServerLoad } from "./$types";
import { loadAuthenticatedSession } from "$lib/server/app-bootstrap";

export const load: LayoutServerLoad = async (event) => ({
  session: await loadAuthenticatedSession(event),
});
