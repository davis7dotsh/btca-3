const ICON_LINK_PATTERN =
  /<link\b[^>]*rel=["'][^"']*(?:icon|apple-touch-icon)[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>/gi;

const normalizeWhitespace = (value: string) => value.trim().replace(/\s+/g, " ");

const parseUrl = (value: string) => {
  try {
    return new URL(value);
  } catch {
    throw new Error("Expected a valid URL.");
  }
};

const getHostedFaviconUrl = (pageUrl: URL) =>
  `https://www.google.com/s2/favicons?domain=${encodeURIComponent(pageUrl.hostname)}&sz=64`;

export const normalizeResourceName = (value: string) => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  if (normalized.length === 0) {
    throw new Error("Expected a resource name.");
  }

  return normalized;
};

export const normalizeResourceItemName = (value: string) => {
  const normalized = normalizeWhitespace(value);

  if (normalized.length === 0) {
    throw new Error("Expected an item name.");
  }

  return normalized;
};

export const normalizeResourceItemDescription = (value: string) => {
  const normalized = normalizeWhitespace(value);

  return normalized.length > 0 ? normalized : undefined;
};

export const normalizeResourceItemUrl = (value: string) => {
  const parsed = parseUrl(value.trim());
  parsed.hash = "";

  return parsed.toString();
};

const getIconCandidates = (html: string, pageUrl: URL) => {
  const candidates = new Set<string>();

  for (const match of html.matchAll(ICON_LINK_PATTERN)) {
    const href = match[1]?.trim();

    if (!href) {
      continue;
    }

    try {
      candidates.add(new URL(href, pageUrl).toString());
    } catch {
      continue;
    }
  }

  candidates.add(new URL("/favicon.png", pageUrl.origin).toString());
  candidates.add(new URL("/favicon.svg", pageUrl.origin).toString());
  candidates.add(new URL("/apple-touch-icon.png", pageUrl.origin).toString());
  candidates.add(new URL("/favicon.ico", pageUrl.origin).toString());

  return [...candidates];
};

const canUseIconResponse = (response: Response) => {
  if (!response.ok) {
    return false;
  }

  const contentType = response.headers.get("content-type");

  return contentType === null || contentType.startsWith("image/");
};

const canUseIconUrl = async (url: string) => {
  try {
    const headResponse = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      headers: {
        "user-agent": "btca-resource-icon-fetcher",
      },
    });

    if (canUseIconResponse(headResponse)) {
      return true;
    }
  } catch {
    // Fall through to GET.
  }

  try {
    const getResponse = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "user-agent": "btca-resource-icon-fetcher",
        range: "bytes=0-0",
      },
    });

    return canUseIconResponse(getResponse);
  } catch {
    return false;
  }
};

export const discoverFaviconUrl = async (url: string) => {
  const pageUrl = parseUrl(url);
  const fallbackCandidates = getIconCandidates("", pageUrl);

  try {
    const pageResponse = await fetch(pageUrl.toString(), {
      redirect: "follow",
      headers: {
        "user-agent": "btca-resource-icon-fetcher",
      },
    });

    if (!pageResponse.ok) {
      for (const candidate of fallbackCandidates) {
        if (await canUseIconUrl(candidate)) {
          return candidate;
        }
      }

      return getHostedFaviconUrl(pageUrl);
    }

    const html = await pageResponse.text();

    for (const candidate of getIconCandidates(html, pageUrl)) {
      if (await canUseIconUrl(candidate)) {
        return candidate;
      }
    }
  } catch {
    for (const candidate of fallbackCandidates) {
      if (await canUseIconUrl(candidate)) {
        return candidate;
      }
    }

    return getHostedFaviconUrl(pageUrl);
  }

  return getHostedFaviconUrl(pageUrl);
};
