export type GlobalResource = {
  type: "git";
  name: string;
  url: string;
  branch: string;
  searchPath?: string;
  searchPaths?: string[];
  specialNotes?: string;
  displayName: string;
  logoKey?: string;
};

type GlobalResourceInput = Omit<GlobalResource, "displayName">;

const getDisplayName = (url: string) => {
  try {
    const { pathname } = new URL(url);
    const parts = pathname.split("/").filter(Boolean);
    return parts.slice(0, 2).join("/");
  } catch {
    return url;
  }
};

const baseResources: GlobalResourceInput[] = [
  {
    type: "git",
    name: "runed",
    url: "https://github.com/svecosystem/runed",
    branch: "main",
    logoKey: "svelte",
  },
  {
    type: "git",
    name: "convexWorkpools",
    url: "https://github.com/get-convex/workpool",
    branch: "main",
    logoKey: "convex",
    specialNotes:
      "This is a Convex component that does work pools. Work pools are basically background jobs with proper queuing setup, retries, and all that stuff.",
  },
  {
    type: "git",
    name: "daytona",
    url: "https://github.com/daytonaio/daytona",
    branch: "main",
    logoKey: "daytona",
    specialNotes:
      "This is the full daytona codebase. Focus on the guides and examples for answers.",
  },
  {
    type: "git",
    name: "svelte",
    url: "https://github.com/sveltejs/svelte.dev",
    branch: "main",
    logoKey: "svelte",
    searchPaths: ["apps/svelte.dev"],
    specialNotes: "Svelte docs website. Focus on content directory for markdown documentation.",
  },
  {
    type: "git",
    name: "svelteKit",
    url: "https://github.com/sveltejs/kit",
    branch: "main",
    logoKey: "svelte",
    searchPath: "documentation",
  },
  {
    type: "git",
    name: "tailwind",
    url: "https://github.com/tailwindlabs/tailwindcss.com",
    branch: "main",
    logoKey: "tailwind",
    searchPath: "src/docs",
  },
  {
    type: "git",
    name: "hono",
    url: "https://github.com/honojs/website",
    branch: "main",
    logoKey: "hono",
    searchPath: "docs",
  },
  {
    type: "git",
    name: "zod",
    url: "https://github.com/colinhacks/zod",
    branch: "main",
    logoKey: "zod",
    searchPath: "packages/docs/content",
  },
  {
    type: "git",
    name: "solidJs",
    url: "https://github.com/solidjs/solid-docs",
    branch: "main",
    logoKey: "solid",
    searchPath: "src/routes",
  },
  {
    type: "git",
    name: "vite",
    url: "https://github.com/vitejs/vite",
    branch: "main",
    logoKey: "vite",
    searchPath: "docs",
  },
  {
    type: "git",
    name: "opencode",
    url: "https://github.com/anomalyco/opencode",
    branch: "dev",
    logoKey: "opencode",
  },
  {
    type: "git",
    name: "clerk",
    url: "https://github.com/clerk/javascript",
    branch: "main",
    logoKey: "clerk",
  },
  {
    type: "git",
    name: "convexJs",
    url: "https://github.com/get-convex/convex-js",
    branch: "main",
    logoKey: "convex",
  },
  {
    type: "git",
    name: "convexDocs",
    url: "https://github.com/get-convex/convex-docs",
    branch: "main",
    logoKey: "convex",
    specialNotes:
      "Official Convex documentation. Use for HTTP actions, queries, mutations, actions, schema, and deployment guidance.",
  },
];

export const GLOBAL_RESOURCES: GlobalResource[] = baseResources.map((resource) => ({
  ...resource,
  displayName: getDisplayName(resource.url),
}));
