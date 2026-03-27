import { generateSvelteHelpers } from "@uploadthing/svelte";

export const { createUploadThing } = generateSvelteHelpers({
  url: "/api/uploadthing",
});
