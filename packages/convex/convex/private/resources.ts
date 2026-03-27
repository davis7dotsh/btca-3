import type { IndexRangeBuilder } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { normalizeResourceName } from "../resourceHelpers";
import { privateQuery } from "./helpers";

export const getTaggedResources = privateQuery({
  args: {
    userId: v.string(),
    names: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const normalizedNames = [...new Set(args.names.map((name) => normalizeResourceName(name)))];
    const resources: {
      id: string;
      name: string;
      items: {
        id: string;
        name: string;
        description: string | null;
        url: string;
      }[];
    }[] = [];

    for (const name of normalizedNames) {
      const resource = await ctx.db
        .query("resources")
        .withIndex(
          "by_user_id_and_name",
          (query: IndexRangeBuilder<Doc<"resources">, ["userId", "name"]>) =>
            query.eq("userId", args.userId).eq("name", name),
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
        items: items.map((item: Doc<"resourceItems">) => ({
          id: item._id,
          name: item.name,
          description: item.description ?? null,
          url: item.url,
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
          createdAt: resource.createdAt,
          updatedAt: resource.updatedAt,
          itemCount: items.length,
          items: includeItems
            ? items.map((item: Doc<"resourceItems">) => ({
                id: item._id,
                name: item.name,
                description: item.description ?? null,
                url: item.url,
                iconUrl: item.iconUrl ?? null,
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
