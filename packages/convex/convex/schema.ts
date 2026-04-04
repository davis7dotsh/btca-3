import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const legacyBtcaChunkValidator = v.union(
  v.object({
    type: v.literal("text"),
    id: v.string(),
    text: v.string(),
  }),
  v.object({
    type: v.literal("reasoning"),
    id: v.string(),
    text: v.string(),
  }),
  v.object({
    type: v.literal("tool"),
    id: v.string(),
    toolName: v.string(),
    state: v.union(v.literal("pending"), v.literal("running"), v.literal("completed")),
  }),
  v.object({
    type: v.literal("file"),
    id: v.string(),
    filePath: v.string(),
  }),
);

const legacyMessageContentValidator = v.union(
  v.string(),
  v.object({
    type: v.literal("chunks"),
    chunks: v.array(legacyBtcaChunkValidator),
  }),
);

const legacyMessageStatsValidator = v.object({
  durationMs: v.number(),
  inputTokens: v.number(),
  outputTokens: v.number(),
  tokensPerSecond: v.number(),
  totalPriceUsd: v.number(),
  totalTokens: v.number(),
});

const resourceCuratorValidator = v.object({
  kind: v.union(v.literal("user"), v.literal("agent")),
  userId: v.optional(v.string()),
  threadId: v.optional(v.string()),
});

export default defineSchema({
  // Legacy production tables from better-context.
  // Keep these names unchanged so the existing production data remains intact and
  // we always have a safe rollback source while v2 is being migrated and validated.
  instances: defineTable({
    clerkId: v.string(),
    sandboxId: v.optional(v.string()),
    state: v.union(
      v.literal("unprovisioned"),
      v.literal("provisioning"),
      v.literal("stopped"),
      v.literal("starting"),
      v.literal("running"),
      v.literal("stopping"),
      v.literal("updating"),
      v.literal("error"),
    ),
    serverUrl: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    btcaVersion: v.optional(v.string()),
    opencodeVersion: v.optional(v.string()),
    latestBtcaVersion: v.optional(v.string()),
    latestOpencodeVersion: v.optional(v.string()),
    lastVersionCheck: v.optional(v.number()),
    subscriptionPlan: v.optional(v.union(v.literal("pro"), v.literal("free"), v.literal("none"))),
    subscriptionStatus: v.optional(
      v.union(v.literal("active"), v.literal("trialing"), v.literal("canceled"), v.literal("none")),
    ),
    subscriptionProductId: v.optional(v.string()),
    subscriptionCurrentPeriodEnd: v.optional(v.number()),
    subscriptionCanceledAt: v.optional(v.number()),
    subscriptionUpdatedAt: v.optional(v.number()),
    storageUsedBytes: v.optional(v.number()),
    lastActiveAt: v.optional(v.number()),
    provisionedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_clerk_id", ["clerkId"])
    .index("by_sandbox_id", ["sandboxId"]),
  projects: defineTable({
    instanceId: v.id("instances"),
    name: v.string(),
    model: v.optional(v.string()),
    isDefault: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_instance", ["instanceId"])
    .index("by_instance_and_name", ["instanceId", "name"]),
  cachedResources: defineTable({
    instanceId: v.id("instances"),
    projectId: v.optional(v.id("projects")),
    name: v.string(),
    type: v.optional(v.union(v.literal("git"), v.literal("npm"))),
    url: v.optional(v.string()),
    branch: v.optional(v.string()),
    package: v.optional(v.string()),
    version: v.optional(v.string()),
    sizeBytes: v.optional(v.number()),
    cachedAt: v.number(),
    lastUsedAt: v.number(),
  })
    .index("by_instance", ["instanceId"])
    .index("by_project", ["projectId"]),
  globalResources: defineTable({
    name: v.string(),
    displayName: v.string(),
    type: v.literal("git"),
    url: v.string(),
    branch: v.string(),
    searchPath: v.optional(v.string()),
    specialNotes: v.optional(v.string()),
    isActive: v.boolean(),
  }).index("by_name", ["name"]),
  userResources: defineTable({
    instanceId: v.id("instances"),
    projectId: v.optional(v.id("projects")),
    name: v.string(),
    type: v.optional(v.union(v.literal("git"), v.literal("npm"))),
    url: v.optional(v.string()),
    branch: v.optional(v.string()),
    package: v.optional(v.string()),
    version: v.optional(v.string()),
    searchPath: v.optional(v.string()),
    specialNotes: v.optional(v.string()),
    gitProvider: v.optional(v.union(v.literal("github"), v.literal("generic"))),
    visibility: v.optional(v.union(v.literal("public"), v.literal("private"))),
    authSource: v.optional(v.literal("clerk_github_oauth")),
    createdAt: v.number(),
  })
    .index("by_instance", ["instanceId"])
    .index("by_project", ["projectId"])
    .index("by_instance_and_name", ["instanceId", "name"])
    .index("by_project_and_name", ["projectId", "name"]),
  githubConnections: defineTable({
    instanceId: v.id("instances"),
    clerkUserId: v.string(),
    githubUserId: v.optional(v.number()),
    githubLogin: v.optional(v.string()),
    scopes: v.array(v.string()),
    status: v.union(v.literal("connected"), v.literal("missing_scope"), v.literal("disconnected")),
    connectedAt: v.optional(v.number()),
    lastValidatedAt: v.number(),
  })
    .index("by_instance", ["instanceId"])
    .index("by_clerk_user_id", ["clerkUserId"]),
  threads: defineTable({
    instanceId: v.id("instances"),
    projectId: v.optional(v.id("projects")),
    title: v.optional(v.string()),
    createdAt: v.number(),
    lastActivityAt: v.number(),
  })
    .index("by_instance", ["instanceId"])
    .index("by_project", ["projectId"]),
  messages: defineTable({
    threadId: v.id("threads"),
    role: v.union(v.literal("user"), v.literal("assistant"), v.literal("system")),
    content: legacyMessageContentValidator,
    stats: v.optional(legacyMessageStatsValidator),
    resources: v.optional(v.array(v.string())),
    canceled: v.optional(v.boolean()),
    createdAt: v.number(),
  }).index("by_thread", ["threadId"]),
  threadResources: defineTable({
    threadId: v.id("threads"),
    resourceName: v.string(),
  }).index("by_thread", ["threadId"]),
  streamSessions: defineTable({
    threadId: v.id("threads"),
    messageId: v.id("messages"),
    sessionId: v.string(),
    status: v.union(v.literal("streaming"), v.literal("done"), v.literal("error")),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
    error: v.optional(v.string()),
  })
    .index("by_thread", ["threadId"])
    .index("by_message", ["messageId"])
    .index("by_session", ["sessionId"])
    .index("by_status", ["status"])
    .index("by_thread_and_status", ["threadId", "status"]),
  mcpQuestions: defineTable({
    projectId: v.id("projects"),
    question: v.string(),
    resources: v.array(v.string()),
    answer: v.string(),
    createdAt: v.number(),
  }).index("by_project", ["projectId"]),
  apiKeyUsage: defineTable({
    clerkApiKeyId: v.string(),
    clerkUserId: v.string(),
    instanceId: v.id("instances"),
    name: v.optional(v.string()),
    lastUsedAt: v.optional(v.number()),
    usageCount: v.number(),
    createdAt: v.number(),
  })
    .index("by_clerk_api_key_id", ["clerkApiKeyId"])
    .index("by_instance", ["instanceId"]),

  // btca-3 / webapp v2 tables.
  // All future new tables in this shared deployment should use the v2_ prefix
  // until the legacy tables above are fully retired.
  v2_conferences: defineTable({
    name: v.string(),
    location: v.string(),
    startDate: v.number(),
    endDate: v.number(),
    description: v.optional(v.string()),
  }),
  v2_identityLinks: defineTable({
    clerkUserId: v.string(),
    workosUserId: v.string(),
    primaryEmail: v.optional(v.string()),
    migrationSource: v.union(
      v.literal("workos_external_id"),
      v.literal("sign_in_fallback"),
      v.literal("manual"),
    ),
    createdAt: v.number(),
    linkedAt: v.number(),
    status: v.union(v.literal("linked"), v.literal("fallback_linked"), v.literal("pending_review")),
  })
    .index("by_clerk_user_id", ["clerkUserId"])
    .index("by_workos_user_id", ["workosUserId"])
    .index("by_primary_email", ["primaryEmail"]),
  v2_agentThreads: defineTable({
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
  v2_agentUserPreferences: defineTable({
    userId: v.string(),
    defaultModelId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_user_id", ["userId"]),
  v2_agentThreadMessages: defineTable({
    threadId: v.string(),
    threadRef: v.id("v2_agentThreads"),
    sequence: v.number(),
    role: v.string(),
    messageTimestamp: v.optional(v.number()),
    rawJson: v.string(),
    createdAt: v.number(),
  }).index("by_thread_sequence", ["threadId", "sequence"]),
  v2_agentThreadAttachments: defineTable({
    threadId: v.string(),
    threadRef: v.id("v2_agentThreads"),
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
  v2_resources: defineTable({
    userId: v.string(),
    name: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    createdBy: resourceCuratorValidator,
    updatedBy: resourceCuratorValidator,
  })
    .index("by_user_id", ["userId"])
    .index("by_user_id_and_name", ["userId", "name"]),
  v2_resourceItems: defineTable({
    resourceId: v.id("v2_resources"),
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
