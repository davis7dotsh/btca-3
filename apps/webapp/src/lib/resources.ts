import type { TaggedResourcePromptResource } from "$lib/types/resources";

const normalizeResourceSlug = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

export const getResourceNameError = (value: string) =>
  normalizeResourceSlug(value).length === 0 ? "Enter a resource name." : null;

export const normalizeResourceName = (value: string) => {
  const normalized = normalizeResourceSlug(value);

  return normalized.length > 0 ? normalized : "resource";
};

export const extractTaggedResourceNames = (value: string) => {
  const matches = value.matchAll(/(^|[\s([{"'])@([a-zA-Z0-9][a-zA-Z0-9-]*)/g);
  const names = new Set<string>();

  for (const match of matches) {
    const name = match[2];

    if (!name) {
      continue;
    }

    names.add(normalizeResourceName(name));
  }

  return [...names];
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
      const items = resource.items
        .map((item) =>
          [
            "      <item>",
            `        <name>${escapeXml(item.name)}</name>`,
            renderOptionalTag("description", item.description),
            `        <url>${escapeXml(item.url)}</url>`,
            "      </item>",
          ]
            .filter((line): line is string => line !== null)
            .join("\n"),
        )
        .join("\n");

      return [
        "  <resource>",
        `    <name>${escapeXml(resource.name)}</name>`,
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
