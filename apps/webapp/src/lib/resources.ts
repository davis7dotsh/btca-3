import type { TaggedResourcePromptResource } from "$lib/types/resources";

export const resourceItemKindLabels = {
  git_repo: "Git repo",
  npm_package: "NPM package",
  website: "Website",
} as const;

export const normalizeResourceSlug = (value: string) => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return normalized.length > 0 ? normalized : "resource";
};

export const createResourceSlugFromName = (value: string) => normalizeResourceSlug(value);

export const extractTaggedResourceSlugs = (value: string) => {
  const matches = value.matchAll(/(^|[\s([{"'])@([a-zA-Z0-9][a-zA-Z0-9-]*)/g);
  const slugs = new Set<string>();

  for (const match of matches) {
    const slug = match[2];

    if (!slug) {
      continue;
    }

    slugs.add(normalizeResourceSlug(slug));
  }

  return [...slugs];
};

const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const renderOptionalTag = (tag: string, value: string | null | undefined) =>
  value && value.trim().length > 0 ? `    <${tag}>${escapeXml(value)}</${tag}>` : null;

export const buildTaggedResourcesXml = (resources: readonly TaggedResourcePromptResource[]) => {
  if (resources.length === 0) {
    return "<tagged_resources></tagged_resources>";
  }

  const xml = resources
    .map((resource) => {
      const notes = renderOptionalTag("notes", resource.notes);
      const items = resource.items
        .map((item) =>
          [
            "      <item>",
            `        <kind>${escapeXml(item.kind)}</kind>`,
            `        <name>${escapeXml(item.name)}</name>`,
            `        <description>${escapeXml(item.description)}</description>`,
            `        <url>${escapeXml(item.url)}</url>`,
            renderOptionalTag("branch", item.branch),
            renderOptionalTag("package_name", item.packageName),
            "      </item>",
          ]
            .filter((line): line is string => line !== null)
            .join("\n"),
        )
        .join("\n");

      return [
        "  <resource>",
        `    <name>${escapeXml(resource.name)}</name>`,
        `    <slug>${escapeXml(resource.slug)}</slug>`,
        notes,
        "    <items>",
        items,
        "    </items>",
        "  </resource>",
      ]
        .filter((line): line is string => line !== null)
        .join("\n");
    })
    .join("\n");

  return `<tagged_resources>\n${xml}\n</tagged_resources>`;
};
