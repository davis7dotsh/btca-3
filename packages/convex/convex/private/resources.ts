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

export const listForMcp = privateQuery({
  args: {
    userId: v.string(),
    includeItems: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const includeItems = args.includeItems ?? false;
    const resources = await ctx.db
      .query("resources")
      .withIndex("by_user_id", (query: IndexRangeBuilder<Doc<"resources">, ["userId"]>) =>
        query.eq("userId", args.userId),
      )
      .collect();

    const resourcesWithItems = await Promise.all(
      resources.map(async (resource: Doc<"resources">) => {
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

        return {
          id: resource._id,
          name: resource.name,
          slug: resource.slug,
          notes: resource.notes ?? null,
          createdAt: resource.createdAt,
          updatedAt: resource.updatedAt,
          itemCount: items.length,
          items: includeItems
            ? items.map((item: Doc<"resourceItems">) => ({
                id: item._id,
                kind: item.kind,
                name: item.name,
                description: item.description,
                url: item.url,
                branch: item.branch ?? null,
                packageName: item.packageName ?? null,
                repoHost: item.repoHost ?? null,
                repoOwner: item.repoOwner ?? null,
                repoName: item.repoName ?? null,
                websiteHost: item.websiteHost ?? null,
                sortOrder: item.sortOrder,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
              }))
            : undefined,
        };
      }),
    );

    return resourcesWithItems.sort((left, right) => left.name.localeCompare(right.name));
  },
});
