import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { resourceItemKindValidator } from "./resourceHelpers";

const resourceCuratorValidator = v.object({
  kind: v.union(v.literal("user"), v.literal("agent")),
  userId: v.optional(v.string()),
  threadId: v.optional(v.string()),
});

export default defineSchema({
  conferences: defineTable({
    name: v.string(),
    location: v.string(),
    startDate: v.number(),
    endDate: v.number(),
    description: v.optional(v.string()),
  }),
  agentThreads: defineTable({
    threadId: v.string(),
    userId: v.string(),
    title: v.optional(v.string()),
    sandboxId: v.optional(v.string()),
    isMcp: v.optional(v.boolean()),
    status: v.optional(v.union(v.literal("idle"), v.literal("running"), v.literal("error"))),
    activity: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    lastPromptAt: v.number(),
    lastCompletedAt: v.optional(v.number()),
    messageCount: v.number(),
  })
    .index("by_thread_id", ["threadId"])
    .index("by_user_id", ["userId"]),
  agentThreadMessages: defineTable({
    threadId: v.string(),
    threadRef: v.id("agentThreads"),
    sequence: v.number(),
    role: v.string(),
    messageTimestamp: v.optional(v.number()),
    rawJson: v.string(),
    createdAt: v.number(),
  }).index("by_thread_sequence", ["threadId", "sequence"]),
  resources: defineTable({
    userId: v.string(),
    name: v.string(),
    // Used for future @mentions like @svelte.
    slug: v.string(),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    createdBy: resourceCuratorValidator,
    updatedBy: resourceCuratorValidator,
  })
    .index("by_user_id", ["userId"])
    .index("by_user_id_and_slug", ["userId", "slug"])
    .index("by_user_id_and_name", ["userId", "name"]),
  resourceItems: defineTable({
    resourceId: v.id("resources"),
    kind: resourceItemKindValidator,
    // A normalized identifier we can use later for dedupe checks per resource.
    canonicalKey: v.string(),
    name: v.string(),
    description: v.string(),
    url: v.string(),
    sortOrder: v.number(),
    repoHost: v.optional(v.string()),
    repoOwner: v.optional(v.string()),
    repoName: v.optional(v.string()),
    branch: v.optional(v.string()),
    packageName: v.optional(v.string()),
    websiteHost: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    createdBy: resourceCuratorValidator,
    updatedBy: resourceCuratorValidator,
  })
    .index("by_resource_sort_order", ["resourceId", "sortOrder"])
    .index("by_resource_canonical_key", ["resourceId", "canonicalKey"])
    .index("by_kind", ["kind"]),
});
