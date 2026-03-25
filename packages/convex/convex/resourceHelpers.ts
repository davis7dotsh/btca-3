import { v } from "convex/values";

export const resourceItemKindValidator = v.union(
  v.literal("git_repo"),
  v.literal("npm_package"),
  v.literal("website"),
);

export const normalizeResourceName = (value: string) => value.trim().replace(/\s+/g, " ");

export const normalizeResourceDescription = (value: string) => value.trim().replace(/\s+/g, " ");

export const normalizeResourceSlug = (value: string) => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return normalized.length > 0 ? normalized : "resource";
};

const trimTrailingSlash = (value: string) => value.replace(/\/+$/g, "");

const parseUrl = (value: string) => {
  try {
    return new URL(value);
  } catch {
    throw new Error("Expected a valid URL.");
  }
};

const normalizeUrl = (value: string) => {
  const parsed = parseUrl(value.trim());
  parsed.hash = "";
  parsed.search = "";

  return parsed.toString();
};

const normalizeRepoPath = (pathname: string) =>
  trimTrailingSlash(pathname)
    .replace(/\.git$/i, "")
    .replace(/^\/+/, "");

const getPackageUrl = (packageName: string) => `https://www.npmjs.com/package/${packageName}`;

const getCanonicalWebsiteUrl = (url: string) => trimTrailingSlash(normalizeUrl(url));

export const buildResourceItemFields = ({
  kind,
  name,
  description,
  url,
  packageName,
  branch,
}: {
  kind: "git_repo" | "npm_package" | "website";
  name: string;
  description: string;
  url?: string;
  packageName?: string;
  branch?: string;
}) => {
  const normalizedName = normalizeResourceName(name);
  const normalizedDescription = normalizeResourceDescription(description);
  const normalizedPackageName = packageName?.trim();
  const normalizedBranch = branch?.trim() || "main";

  if (!normalizedName) {
    throw new Error("Expected an item name.");
  }

  if (!normalizedDescription) {
    throw new Error("Expected an item description.");
  }

  switch (kind) {
    case "git_repo": {
      if (!url?.trim()) {
        throw new Error("Git repo items require a URL.");
      }

      const normalizedUrl = normalizeUrl(url);
      const parsed = parseUrl(normalizedUrl);
      const repoPath = normalizeRepoPath(parsed.pathname);
      const [repoOwner, repoName] = repoPath.split("/");

      if (!repoOwner || !repoName) {
        throw new Error("Git repo URLs must include an owner and repository name.");
      }

      return {
        kind,
        name: normalizedName,
        description: normalizedDescription,
        url: normalizedUrl,
        canonicalKey: `git:${parsed.hostname.toLowerCase()}/${repoOwner.toLowerCase()}/${repoName.toLowerCase()}#${normalizedBranch.toLowerCase()}`,
        repoHost: parsed.hostname.toLowerCase(),
        repoOwner,
        repoName,
        branch: normalizedBranch,
        packageName: undefined,
        websiteHost: undefined,
      };
    }
    case "npm_package": {
      const normalizedNameForPackage = normalizedPackageName?.length
        ? normalizedPackageName
        : undefined;

      if (!normalizedNameForPackage) {
        throw new Error("NPM package items require a package name.");
      }

      const normalizedUrl = url?.trim()
        ? normalizeUrl(url)
        : getPackageUrl(normalizedNameForPackage);

      return {
        kind,
        name: normalizedName,
        description: normalizedDescription,
        url: normalizedUrl,
        canonicalKey: `npm:${normalizedNameForPackage.toLowerCase()}`,
        repoHost: undefined,
        repoOwner: undefined,
        repoName: undefined,
        branch: undefined,
        packageName: normalizedNameForPackage,
        websiteHost: undefined,
      };
    }
    case "website": {
      if (!url?.trim()) {
        throw new Error("Website items require a URL.");
      }

      const normalizedUrl = getCanonicalWebsiteUrl(url);
      const parsed = parseUrl(normalizedUrl);

      return {
        kind,
        name: normalizedName,
        description: normalizedDescription,
        url: normalizedUrl,
        canonicalKey: `website:${normalizedUrl.toLowerCase()}`,
        repoHost: undefined,
        repoOwner: undefined,
        repoName: undefined,
        branch: undefined,
        packageName: undefined,
        websiteHost: parsed.hostname.toLowerCase(),
      };
    }
  }
};
