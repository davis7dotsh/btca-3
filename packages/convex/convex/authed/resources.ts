import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  buildResourceItemFields,
  normalizeResourceDescription,
  normalizeResourceName,
  normalizeResourceSlug,
  resourceItemKindValidator,
} from "../resourceHelpers";
import { authedMutation, authedQuery } from "./helpers";

const getUserId = (identity: { subject: string }) => identity.subject;
type AuthedQueryCtx = QueryCtx & { identity: { subject: string } };
type AuthedMutationCtx = MutationCtx & { identity: { subject: string } };

const createCurator = (userId: string) => ({
  kind: "user" as const,
  userId,
  threadId: undefined,
});

const getOwnedResource = async (
  ctx: AuthedQueryCtx | AuthedMutationCtx,
  resourceId: Id<"resources">,
  userId: string,
) => {
  const resource = await ctx.db.get(resourceId);

  if (resource === null) {
    throw new Error("Resource not found.");
  }

  if (resource.userId !== userId) {
    throw new Error("Unauthorized resource access");
  }

  return resource;
};

const getOwnedResourceItem = async (
  ctx: AuthedQueryCtx | AuthedMutationCtx,
  itemId: Id<"resourceItems">,
  userId: string,
) => {
  const item = await ctx.db.get(itemId);

  if (item === null) {
    throw new Error("Resource item not found.");
  }

  const resource = await getOwnedResource(ctx, item.resourceId, userId);

  return { item, resource };
};

const ensureUniqueSlug = async ({
  ctx,
  userId,
  slug,
  resourceId,
}: {
  ctx: AuthedQueryCtx | AuthedMutationCtx;
  userId: string;
  slug: string;
  resourceId?: Id<"resources">;
}) => {
  const existing = await ctx.db
    .query("resources")
    .withIndex("by_user_id_and_slug", (query) => query.eq("userId", userId).eq("slug", slug))
    .unique();

  if (existing !== null && existing._id !== resourceId) {
    throw new Error(`A resource with the slug "@${slug}" already exists.`);
  }
};

const createUniqueSlug = async (
  ctx: AuthedQueryCtx | AuthedMutationCtx,
  userId: string,
  name: string,
) => {
  const baseSlug = normalizeResourceSlug(name);
  let slug = baseSlug;

  for (let suffix = 1; suffix < 1000; suffix += 1) {
    const existing = await ctx.db
      .query("resources")
      .withIndex("by_user_id_and_slug", (query) => query.eq("userId", userId).eq("slug", slug))
      .unique();

    if (existing === null) {
      return slug;
    }

    slug = `${baseSlug}-${suffix + 1}`;
  }

  throw new Error("Failed to generate a unique resource slug.");
};

const itemArgs = {
  kind: resourceItemKindValidator,
  name: v.string(),
  description: v.string(),
  url: v.optional(v.string()),
  branch: v.optional(v.string()),
  packageName: v.optional(v.string()),
};

const createResourceRecord = async ({
  ctx,
  userId,
  name,
  slug,
  notes,
}: {
  ctx: AuthedMutationCtx;
  userId: string;
  name: string;
  slug: string;
  notes?: string;
}) => {
  const now = Date.now();
  const createdBy = createCurator(userId);
  const resourceId = await ctx.db.insert("resources", {
    userId,
    name,
    slug,
    notes,
    createdAt: now,
    updatedAt: now,
    createdBy,
    updatedBy: createdBy,
  });

  return {
    resourceId,
    now,
    createdBy,
  };
};

export const list = authedQuery({
  args: {},
  handler: async (ctx) => {
    const userId = getUserId(ctx.identity);
    const resources = await ctx.db
      .query("resources")
      .withIndex("by_user_id", (query) => query.eq("userId", userId))
      .collect();

    const resourcesWithCounts = await Promise.all(
      resources.map(async (resource) => {
        const items = await ctx.db
          .query("resourceItems")
          .withIndex("by_resource_sort_order", (query) => query.eq("resourceId", resource._id))
          .collect();

        return {
          id: resource._id,
          name: resource.name,
          slug: resource.slug,
          notes: resource.notes ?? null,
          createdAt: resource.createdAt,
          updatedAt: resource.updatedAt,
          itemCount: items.length,
        };
      }),
    );

    return resourcesWithCounts.sort((left, right) => left.name.localeCompare(right.name));
  },
});

export const get = authedQuery({
  args: {
    resourceId: v.id("resources"),
  },
  handler: async (ctx, args) => {
    const userId = getUserId(ctx.identity);
    const resource = await getOwnedResource(ctx, args.resourceId, userId);
    const items = (
      await ctx.db
        .query("resourceItems")
        .withIndex("by_resource_sort_order", (query) => query.eq("resourceId", resource._id))
        .collect()
    ).sort((left, right) => left.sortOrder - right.sortOrder);

    return {
      resource: {
        id: resource._id,
        name: resource.name,
        slug: resource.slug,
        notes: resource.notes ?? null,
        createdAt: resource.createdAt,
        updatedAt: resource.updatedAt,
      },
      items: items.map((item) => ({
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
      })),
    };
  },
});

export const create = authedMutation({
  args: {
    name: v.string(),
    slug: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = getUserId(ctx.identity);
    const name = normalizeResourceName(args.name);
    const requestedSlug = args.slug?.trim() ? normalizeResourceSlug(args.slug) : undefined;
    const slug = requestedSlug ?? (await createUniqueSlug(ctx, userId, name));
    const notes = args.notes?.trim() ? normalizeResourceDescription(args.notes) : undefined;

    if (!name) {
      throw new Error("Expected a resource name.");
    }

    if (requestedSlug) {
      await ensureUniqueSlug({ ctx, userId, slug: requestedSlug });
    }

    const { resourceId } = await createResourceRecord({
      ctx,
      userId,
      name,
      slug,
      notes,
    });

    return {
      resourceId,
    };
  },
});

export const createWithItems = authedMutation({
  args: {
    name: v.string(),
    slug: v.optional(v.string()),
    notes: v.optional(v.string()),
    items: v.array(v.object(itemArgs)),
  },
  handler: async (ctx, args) => {
    const userId = getUserId(ctx.identity);
    const name = normalizeResourceName(args.name);
    const requestedSlug = args.slug?.trim() ? normalizeResourceSlug(args.slug) : undefined;
    const slug = requestedSlug ?? (await createUniqueSlug(ctx, userId, name));
    const notes = args.notes?.trim() ? normalizeResourceDescription(args.notes) : undefined;

    if (!name) {
      throw new Error("Expected a resource name.");
    }

    if (args.items.length === 0) {
      throw new Error("Expected at least one resource item.");
    }

    if (requestedSlug) {
      await ensureUniqueSlug({ ctx, userId, slug: requestedSlug });
    }

    const normalizedItems = args.items.map((item) => buildResourceItemFields(item));
    const { resourceId, now, createdBy } = await createResourceRecord({
      ctx,
      userId,
      name,
      slug,
      notes,
    });

    for (const [index, item] of normalizedItems.entries()) {
      await ctx.db.insert("resourceItems", {
        resourceId,
        sortOrder: index,
        createdAt: now,
        updatedAt: now,
        createdBy,
        updatedBy: createdBy,
        ...item,
      });
    }

    return {
      resourceId,
    };
  },
});

export const update = authedMutation({
  args: {
    resourceId: v.id("resources"),
    name: v.string(),
    slug: v.string(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = getUserId(ctx.identity);
    const resource = await getOwnedResource(ctx, args.resourceId, userId);
    const name = normalizeResourceName(args.name);
    const slug = normalizeResourceSlug(args.slug);
    const notes = args.notes?.trim() ? normalizeResourceDescription(args.notes) : undefined;

    if (!name) {
      throw new Error("Expected a resource name.");
    }

    await ensureUniqueSlug({ ctx, userId, slug, resourceId: resource._id });

    await ctx.db.patch(resource._id, {
      name,
      slug,
      notes,
      updatedAt: Date.now(),
      updatedBy: createCurator(userId),
    });

    return {
      resourceId: resource._id,
    };
  },
});

export const remove = authedMutation({
  args: {
    resourceId: v.id("resources"),
  },
  handler: async (ctx, args) => {
    const userId = getUserId(ctx.identity);
    const resource = await getOwnedResource(ctx, args.resourceId, userId);
    const items = await ctx.db
      .query("resourceItems")
      .withIndex("by_resource_sort_order", (query) => query.eq("resourceId", resource._id))
      .collect();

    for (const item of items) {
      await ctx.db.delete(item._id);
    }

    await ctx.db.delete(resource._id);
  },
});

export const createItem = authedMutation({
  args: {
    resourceId: v.id("resources"),
    ...itemArgs,
  },
  handler: async (ctx, args) => {
    const userId = getUserId(ctx.identity);
    const resource = await getOwnedResource(ctx, args.resourceId, userId);
    const existingItems = await ctx.db
      .query("resourceItems")
      .withIndex("by_resource_sort_order", (query) => query.eq("resourceId", resource._id))
      .collect();
    const itemFields = buildResourceItemFields(args);
    const now = Date.now();
    const createdBy = createCurator(userId);
    const itemId = await ctx.db.insert("resourceItems", {
      resourceId: resource._id,
      sortOrder: existingItems.length,
      createdAt: now,
      updatedAt: now,
      createdBy,
      updatedBy: createdBy,
      ...itemFields,
    });

    await ctx.db.patch(resource._id, {
      updatedAt: now,
      updatedBy: createdBy,
    });

    return {
      itemId,
    };
  },
});

export const updateItem = authedMutation({
  args: {
    itemId: v.id("resourceItems"),
    ...itemArgs,
  },
  handler: async (ctx, args) => {
    const userId = getUserId(ctx.identity);
    const { item, resource } = await getOwnedResourceItem(ctx, args.itemId, userId);
    const itemFields = buildResourceItemFields(args);
    const updatedAt = Date.now();
    const updatedBy = createCurator(userId);

    await ctx.db.patch(item._id, {
      ...itemFields,
      updatedAt,
      updatedBy,
    });

    await ctx.db.patch(resource._id, {
      updatedAt,
      updatedBy,
    });

    return {
      itemId: item._id,
    };
  },
});

export const removeItem = authedMutation({
  args: {
    itemId: v.id("resourceItems"),
  },
  handler: async (ctx, args) => {
    const userId = getUserId(ctx.identity);
    const { item, resource } = await getOwnedResourceItem(ctx, args.itemId, userId);
    const siblingItems = (
      await ctx.db
        .query("resourceItems")
        .withIndex("by_resource_sort_order", (query) => query.eq("resourceId", resource._id))
        .collect()
    ).sort((left, right) => left.sortOrder - right.sortOrder);

    await ctx.db.delete(item._id);

    for (const [index, sibling] of siblingItems
      .filter((candidate) => candidate._id !== item._id)
      .entries()) {
      await ctx.db.patch(sibling._id, {
        sortOrder: index,
        updatedAt: Date.now(),
        updatedBy: createCurator(userId),
      });
    }

    await ctx.db.patch(resource._id, {
      updatedAt: Date.now(),
      updatedBy: createCurator(userId),
    });
  },
});

export const reorderItems = authedMutation({
  args: {
    resourceId: v.id("resources"),
    itemIds: v.array(v.id("resourceItems")),
  },
  handler: async (ctx, args) => {
    const userId = getUserId(ctx.identity);
    const resource = await getOwnedResource(ctx, args.resourceId, userId);
    const existingItems = (
      await ctx.db
        .query("resourceItems")
        .withIndex("by_resource_sort_order", (query) => query.eq("resourceId", resource._id))
        .collect()
    ).sort((left, right) => left.sortOrder - right.sortOrder);

    if (existingItems.length !== args.itemIds.length) {
      throw new Error("Reorder payload does not match the current resource items.");
    }

    const existingIds = new Set(existingItems.map((item) => item._id));
    const requestedIds = new Set(args.itemIds);

    if (existingIds.size !== requestedIds.size) {
      throw new Error("Reorder payload contains duplicate items.");
    }

    for (const itemId of args.itemIds) {
      if (!existingIds.has(itemId)) {
        throw new Error("Reorder payload contains an invalid item.");
      }
    }

    const updatedAt = Date.now();
    const updatedBy = createCurator(userId);

    for (const [index, itemId] of args.itemIds.entries()) {
      await ctx.db.patch(itemId, {
        sortOrder: index,
        updatedAt,
        updatedBy,
      });
    }

    await ctx.db.patch(resource._id, {
      updatedAt,
      updatedBy,
    });
  },
});
