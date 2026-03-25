import type { PageServerLoad } from "./$types";
import { getCuratedResources } from "$lib/server/curated-resources";

export const load: PageServerLoad = async () => ({
  curatedResources: getCuratedResources(),
});
