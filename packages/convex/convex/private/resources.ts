import type { IndexRangeBuilder } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { normalizeResourceSlug } from "../resourceHelpers";
import { privateQuery } from "./helpers";

export const getTaggedResources = privateQuery({
  args: {
    userId: v.string(),
    slugs: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const normalizedSlugs = [...new Set(args.slugs.map((slug) => normalizeResourceSlug(slug)))];
    const resources: {
      id: string;
      name: string;
      slug: string;
      notes: string | null;
      items: {
        id: string;
        kind: "git_repo" | "npm_package" | "website";
        name: string;
        description: string;
        url: string;
        branch: string | null;
        packageName: string | null;
      }[];
    }[] = [];

    for (const slug of normalizedSlugs) {
      const resource = await ctx.db
        .query("resources")
        .withIndex(
          "by_user_id_and_slug",
          (query: IndexRangeBuilder<Doc<"resources">, ["userId", "slug"]>) =>
            query.eq("userId", args.userId).eq("slug", slug),
        )
        .unique();

      if (resource === null) {
        continue;
      }

      const items = (
        await ctx.db
          .query("resourceItems")
          .withIndex(
            "by_resource_sort_order",
            (query: IndexRangeBuilder<Doc<"resourceItems">, ["resourceId", "sortOrder"]>) =>
              query.eq("resourceId", resource._id),
          )
          .collect()
      ).sort(
        (left: Doc<"resourceItems">, right: Doc<"resourceItems">) =>
          left.sortOrder - right.sortOrder,
      );

      resources.push({
        id: resource._id,
        name: resource.name,
        slug: resource.slug,
        notes: resource.notes ?? null,
        items: items.map((item: Doc<"resourceItems">) => ({
          id: item._id,
          kind: item.kind,
          name: item.name,
          description: item.description,
          url: item.url,
          branch: item.branch ?? null,
          packageName: item.packageName ?? null,
        })),
      });
    }

    return resources;
  },
});
