import { dev } from "$app/environment";
import { env } from "$env/dynamic/public";

const localConvexUrl = import.meta.env.VITE_CONVEX_URL;
const localConvexSiteUrl = import.meta.env.VITE_CONVEX_SITE_URL;

const getRequiredPublicEnv = (value: string | undefined, key: string) => {
  if (!value) {
    throw new Error(`Missing required public env var: ${key}`);
  }

  return value;
};

export const CONVEX_URL = getRequiredPublicEnv(
  dev && localConvexUrl ? localConvexUrl : env.PUBLIC_CONVEX_URL,
  "PUBLIC_CONVEX_URL",
);

export const CONVEX_SITE_URL = getRequiredPublicEnv(
  dev && localConvexSiteUrl ? localConvexSiteUrl : env.PUBLIC_CONVEX_SITE_URL,
  "PUBLIC_CONVEX_SITE_URL",
);
