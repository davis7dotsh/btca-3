import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

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
    selectedModelId: v.optional(v.string()),
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
  agentUserPreferences: defineTable({
    userId: v.string(),
    defaultModelId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_user_id", ["userId"]),
  agentThreadMessages: defineTable({
    threadId: v.string(),
    threadRef: v.id("agentThreads"),
    sequence: v.number(),
    role: v.string(),
    messageTimestamp: v.optional(v.number()),
    rawJson: v.string(),
    createdAt: v.number(),
  }).index("by_thread_sequence", ["threadId", "sequence"]),
  agentThreadAttachments: defineTable({
    threadId: v.string(),
    threadRef: v.id("agentThreads"),
    userId: v.string(),
    messageSequence: v.optional(v.number()),
    status: v.union(v.literal("pending"), v.literal("attached")),
    fileKey: v.string(),
    ufsUrl: v.string(),
    fileName: v.string(),
    fileSize: v.number(),
    mimeType: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_thread_created_at", ["threadId", "createdAt"])
    .index("by_thread_message_sequence", ["threadId", "messageSequence"])
    .index("by_thread_status", ["threadId", "status"])
    .index("by_file_key", ["fileKey"]),
  resources: defineTable({
    userId: v.string(),
    name: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    createdBy: resourceCuratorValidator,
    updatedBy: resourceCuratorValidator,
  })
    .index("by_user_id", ["userId"])
    .index("by_user_id_and_name", ["userId", "name"]),
  resourceItems: defineTable({
    resourceId: v.id("resources"),
    userId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    url: v.string(),
    iconUrl: v.optional(v.string()),
    sortOrder: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    createdBy: resourceCuratorValidator,
    updatedBy: resourceCuratorValidator,
  })
    .index("by_resource_sort_order", ["resourceId", "sortOrder"])
    .index("by_user_id", ["userId"]),
});
