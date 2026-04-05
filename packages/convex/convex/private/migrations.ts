import { vWorkflowId, type WorkflowStatus } from "@convex-dev/workflow";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { internalMutation, internalQuery, mutation, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  normalizeResourceItemDescription,
  normalizeResourceItemName,
  normalizeResourceItemUrl,
  normalizeResourceName,
} from "../resourceHelpers";
import { workflow } from "../workflow";

const migrationModeValidator = v.union(
  v.literal("resources"),
  v.literal("threads"),
  v.literal("all"),
);

const migrationRunStatusValidator = v.union(
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
);

const migrationCurator = {
  kind: "agent" as const,
  userId: undefined,
  threadId: "legacy-convex-migration",
};

const LEGACY_ASSISTANT_API = "legacy-convex-import";
const LEGACY_ASSISTANT_PROVIDER = "legacy-convex-import";
const LEGACY_ASSISTANT_MODEL = "legacy-convex-import";

const createTextPart = (text: string) => ({
  type: "text" as const,
  text,
});

const createThinkingPart = (thinking: string) => ({
  type: "thinking" as const,
  thinking,
});

const createEmptyUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
});

const toPreview = (value: string, maxLength = 120) => {
  const normalized = value.trim().replace(/\s+/g, " ");

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
};

const buildHostedFaviconUrl = (value: string) => {
  const parsed = new URL(value);
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(parsed.hostname)}&sz=64`;
};

type PrivateMutationCtx = MutationCtx;
type PrivateQueryCtx = QueryCtx;

type ImportedThreadMessage = {
  role: "user" | "assistant";
  timestamp: number;
  rawJson: string;
  sourceId?: string;
  sourceKey?: string;
};

type MigrationWorkflowError = {
  scope: "instance" | "thread" | "run";
  id: string;
  message: string;
};

type MigrationWorkflowResult = {
  dryRun: boolean;
  mode: "resources" | "threads" | "all";
  runId: Id<"v2_migrationRuns">;
  instancesScanned: number;
  resourcesCreated: number;
  resourcesReused: number;
  resourceItemsImported: number;
  resourceItemsSkipped: number;
  resourceItemErrors: number;
  threadsImported: number;
  threadsSkipped: number;
  messagesImported: number;
  messagesSkipped: number;
  syntheticMessagesAdded: number;
  errors: MigrationWorkflowError[];
};

type MigrationSummary = Pick<
  MigrationWorkflowResult,
  | "resourcesCreated"
  | "resourcesReused"
  | "resourceItemsImported"
  | "threadsImported"
  | "messagesImported"
  | "syntheticMessagesAdded"
>;

const migrationWorkflowErrorValidator = v.object({
  scope: v.union(v.literal("instance"), v.literal("thread"), v.literal("run")),
  id: v.string(),
  message: v.string(),
});

const migrationWorkflowResultValidator = v.object({
  dryRun: v.boolean(),
  mode: migrationModeValidator,
  runId: v.id("v2_migrationRuns"),
  instancesScanned: v.number(),
  resourcesCreated: v.number(),
  resourcesReused: v.number(),
  resourceItemsImported: v.number(),
  resourceItemsSkipped: v.number(),
  resourceItemErrors: v.number(),
  threadsImported: v.number(),
  threadsSkipped: v.number(),
  messagesImported: v.number(),
  messagesSkipped: v.number(),
  syntheticMessagesAdded: v.number(),
  errors: v.array(migrationWorkflowErrorValidator),
});

const stripGitSuffix = (value: string) => value.replace(/\/+$/, "").replace(/\.git$/i, "");

const encodePathSegments = (value: string) => value.split("/").map(encodeURIComponent).join("/");

const inferGitRepoLabel = (value: string) => {
  const normalized = stripGitSuffix(value).replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) ?? "Repository";
};

const toBrowsableGitUrl = (value: string) => {
  const trimmed = stripGitSuffix(value.trim());

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return normalizeResourceItemUrl(trimmed);
  }

  const sshMatch = trimmed.match(/^git@([^:]+):(.+)$/);

  if (sshMatch) {
    return normalizeResourceItemUrl(`https://${sshMatch[1]}/${sshMatch[2]}`);
  }

  const sshUrlMatch = trimmed.match(/^ssh:\/\/git@([^/]+)\/(.+)$/);

  if (sshUrlMatch) {
    return normalizeResourceItemUrl(`https://${sshUrlMatch[1]}/${sshUrlMatch[2]}`);
  }

  if (!trimmed.includes("://") && trimmed.includes("/")) {
    return normalizeResourceItemUrl(`https://${trimmed}`);
  }

  throw new Error(`Unsupported git URL "${value}".`);
};

const toNpmPackageUrl = (packageName: string) =>
  normalizeResourceItemUrl(`https://www.npmjs.com/package/${encodePathSegments(packageName)}`);

const buildDescription = (parts: Array<string | undefined>) => {
  const normalized = parts
    .map((part) => part?.trim())
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(" ");

  return normalized.length > 0 ? normalizeResourceItemDescription(normalized) : undefined;
};

const normalizeTaggedResourceList = (names: readonly string[]) => [
  ...new Set(names.map((name) => normalizeResourceName(name))),
];

const formatTaggedResources = (names: readonly string[]) =>
  normalizeTaggedResourceList(names)
    .map((name) => `@${name}`)
    .join(" ");

const flattenLegacyContent = (
  content: Doc<"messages">["content"],
  options?: { includeFileAndToolSummaries?: boolean },
) => {
  if (typeof content === "string") {
    return content.trim();
  }

  const pieces = content.chunks.flatMap((chunk) => {
    switch (chunk.type) {
      case "text":
      case "reasoning":
        return chunk.text.trim().length > 0 ? [chunk.text.trim()] : [];
      case "tool":
        return options?.includeFileAndToolSummaries === false
          ? []
          : [`[Tool ${chunk.state}: ${chunk.toolName}]`];
      case "file":
        return options?.includeFileAndToolSummaries === false ? [] : [`[File: ${chunk.filePath}]`];
    }
  });

  return pieces.join("\n\n").trim();
};

const appendResourceMentions = (content: string, names: readonly string[]) => {
  const formatted = formatTaggedResources(names);

  if (formatted.length === 0) {
    return content;
  }

  const suffix = `Referenced resources: ${formatted}`;

  if (content.trim().length === 0) {
    return suffix;
  }

  return `${content}\n\n${suffix}`;
};

const buildLegacyUserMessage = (message: Doc<"messages">) => ({
  role: "user" as const,
  timestamp: message.createdAt,
  content: appendResourceMentions(flattenLegacyContent(message.content), message.resources ?? []),
});

const buildLegacyAssistantMessage = (message: Doc<"messages">) => {
  const content: Array<ReturnType<typeof createTextPart> | ReturnType<typeof createThinkingPart>> =
    typeof message.content === "string"
      ? [createTextPart(message.content)]
      : message.content.chunks.reduce<
          Array<ReturnType<typeof createTextPart> | ReturnType<typeof createThinkingPart>>
        >((parts, chunk) => {
          switch (chunk.type) {
            case "text":
              if (chunk.text.trim().length > 0) {
                parts.push(createTextPart(chunk.text));
              }
              break;
            case "reasoning":
              if (chunk.text.trim().length > 0) {
                parts.push(createThinkingPart(chunk.text));
              }
              break;
            case "tool":
              parts.push(createTextPart(`[Tool ${chunk.state}: ${chunk.toolName}]`));
              break;
            case "file":
              parts.push(createTextPart(`[File: ${chunk.filePath}]`));
              break;
          }

          return parts;
        }, []);

  const usage = message.stats
    ? {
        input: message.stats.inputTokens,
        output: message.stats.outputTokens,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: message.stats.totalTokens,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: message.stats.totalPriceUsd,
        },
      }
    : createEmptyUsage();

  return {
    role: "assistant" as const,
    timestamp: message.createdAt,
    api: LEGACY_ASSISTANT_API,
    provider: LEGACY_ASSISTANT_PROVIDER,
    model: LEGACY_ASSISTANT_MODEL,
    usage,
    stopReason: message.canceled ? ("aborted" as const) : ("stop" as const),
    ...(message.canceled ? { errorMessage: "Canceled" } : {}),
    ...(message.stats
      ? {
          runMetrics: {
            priceUsd: message.stats.totalPriceUsd,
            totalToolCalls:
              typeof message.content === "string"
                ? 0
                : message.content.chunks.filter((chunk) => chunk.type === "tool").length,
            outputTokens: message.stats.outputTokens,
            generationDurationMs: message.stats.durationMs,
            outputTokensPerSecond: message.stats.tokensPerSecond,
          },
        }
      : {}),
    content,
  };
};

const buildLegacySystemMessage = (message: Doc<"messages">) => ({
  role: "assistant" as const,
  timestamp: message.createdAt,
  api: LEGACY_ASSISTANT_API,
  provider: LEGACY_ASSISTANT_PROVIDER,
  model: LEGACY_ASSISTANT_MODEL,
  usage: createEmptyUsage(),
  stopReason: "stop" as const,
  content: [
    createTextPart(
      appendResourceMentions(
        flattenLegacyContent(message.content, { includeFileAndToolSummaries: true }),
        message.resources ?? [],
      ).trim().length > 0
        ? `Legacy system message:\n\n${appendResourceMentions(
            flattenLegacyContent(message.content, { includeFileAndToolSummaries: true }),
            message.resources ?? [],
          )}`
        : "Legacy system message.",
    ),
  ],
});

const createLegacyResourceNote = (threadResourceNames: readonly string[], timestamp: number) => ({
  role: "assistant" as const,
  timestamp,
  api: LEGACY_ASSISTANT_API,
  provider: LEGACY_ASSISTANT_PROVIDER,
  model: LEGACY_ASSISTANT_MODEL,
  usage: createEmptyUsage(),
  stopReason: "stop" as const,
  content: [
    createTextPart(
      `Legacy migration note: this thread previously had these tagged resources available: ${formatTaggedResources(threadResourceNames)}.`,
    ),
  ],
});

const recordAudit = async ({
  ctx,
  runId,
  scope,
  status,
  sourceTable,
  sourceId,
  sourceKey,
  targetTable,
  targetId,
  detail,
}: {
  ctx: PrivateMutationCtx;
  runId: Id<"v2_migrationRuns">;
  scope: Doc<"v2_migrationAudit">["scope"];
  status: Doc<"v2_migrationAudit">["status"];
  sourceTable: string;
  sourceId: string;
  sourceKey: string;
  targetTable?: string;
  targetId?: string;
  detail?: string;
}) => {
  await ctx.db.insert("v2_migrationAudit", {
    runId,
    scope,
    status,
    sourceTable,
    sourceId,
    sourceKey,
    targetTable,
    targetId,
    detail,
    createdAt: Date.now(),
  });
};

const getAuditBySourceKey = async (
  ctx: PrivateMutationCtx | PrivateQueryCtx,
  scope: Doc<"v2_migrationAudit">["scope"],
  sourceKey: string,
) =>
  ctx.db
    .query("v2_migrationAudit")
    .withIndex("by_scope_and_source_key", (query) =>
      query.eq("scope", scope).eq("sourceKey", sourceKey),
    )
    .unique();

const requireRunId = (dryRun: boolean, runId?: Id<"v2_migrationRuns">) => {
  if (!dryRun && runId === undefined) {
    throw new Error("Expected runId for non-dry-run legacy imports.");
  }

  return runId;
};

const assertPrivateApiKey = (apiKey: string) => {
  if (apiKey !== process.env.CONVEX_PRIVATE_BRIDGE_KEY) {
    throw new Error("Invalid API key");
  }
};

const inferLegacyResourceKind = (resource: Doc<"userResources">) => {
  if (resource.type) {
    return resource.type;
  }

  if (resource.package) {
    return "npm" as const;
  }

  if (resource.url) {
    return "git" as const;
  }

  return null;
};

type ResourceCandidate = {
  sourceTable: "globalResources" | "userResources";
  sourceId: string;
  sourceKey: string;
  resourceName: string;
  resourceCreatedAt: number;
  itemName: string;
  itemDescription?: string;
  itemUrl: string;
  itemIconUrl: string;
};

const getRunKindForMode = (
  mode: "resources" | "threads" | "all",
): Doc<"v2_migrationRuns">["kind"] => {
  switch (mode) {
    case "resources":
      return "legacy_convex_resources";
    case "threads":
      return "legacy_convex_threads";
    case "all":
      return "legacy_convex_all";
  }
};

const toMigrationSummary = (result: MigrationWorkflowResult): MigrationSummary => ({
  resourcesCreated: result.resourcesCreated,
  resourcesReused: result.resourcesReused,
  resourceItemsImported: result.resourceItemsImported,
  threadsImported: result.threadsImported,
  messagesImported: result.messagesImported,
  syntheticMessagesAdded: result.syntheticMessagesAdded,
});

export const start = mutation({
  args: {
    apiKey: v.string(),
    mode: migrationModeValidator,
    dryRun: v.boolean(),
    includeGlobalResources: v.optional(v.boolean()),
    instanceId: v.optional(v.id("instances")),
    clerkUserId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ runId: Id<"v2_migrationRuns">; workflowId: string }> => {
    assertPrivateApiKey(args.apiKey);
    const runId = await ctx.db.insert("v2_migrationRuns", {
      userId: args.clerkUserId,
      kind: getRunKindForMode(args.mode),
      status: "running",
      dryRun: args.dryRun,
      notes: "Workflow queued.",
      startedAt: Date.now(),
      completedAt: undefined,
      processedResourceCount: 0,
      processedResourceItemCount: 0,
      processedThreadCount: 0,
      processedMessageCount: 0,
      skippedCount: 0,
      errorCount: 0,
    });

    const workflowId: string = await workflow.start(ctx, internal.private.migrations.migrate, {
      runId,
      mode: args.mode,
      dryRun: args.dryRun,
      includeGlobalResources: args.includeGlobalResources,
      instanceId: args.instanceId,
      clerkUserId: args.clerkUserId,
      limit: args.limit,
    });

    await ctx.db.patch(runId, {
      notes: `Workflow started: ${workflowId}`,
    });

    return {
      runId,
      workflowId,
    };
  },
});

export const finalizeRun = internalMutation({
  args: {
    runId: v.id("v2_migrationRuns"),
    status: migrationRunStatusValidator,
    notes: v.optional(v.string()),
    processedResourceCount: v.number(),
    processedResourceItemCount: v.number(),
    processedThreadCount: v.number(),
    processedMessageCount: v.number(),
    skippedCount: v.number(),
    errorCount: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.runId, {
      status: args.status,
      notes: args.notes,
      completedAt: Date.now(),
      processedResourceCount: args.processedResourceCount,
      processedResourceItemCount: args.processedResourceItemCount,
      processedThreadCount: args.processedThreadCount,
      processedMessageCount: args.processedMessageCount,
      skippedCount: args.skippedCount,
      errorCount: args.errorCount,
    });

    return {
      runId: args.runId,
      status: args.status,
    };
  },
});

export const updateUserMigration = internalMutation({
  args: {
    migrationId: v.id("v2_userMigrations"),
    status: v.union(
      v.literal("not_started"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    runId: v.optional(v.id("v2_migrationRuns")),
    workflowId: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    updatedAt: v.number(),
    errorMessage: v.optional(v.string()),
    resourcesCreated: v.number(),
    resourcesReused: v.number(),
    resourceItemsImported: v.number(),
    threadsImported: v.number(),
    messagesImported: v.number(),
    syntheticMessagesAdded: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.migrationId);

    if (existing === null) {
      throw new Error("User migration tracker not found.");
    }

    await ctx.db.patch(args.migrationId, {
      status: args.status,
      runId: args.runId ?? existing.runId,
      workflowId: args.workflowId ?? existing.workflowId,
      startedAt: args.startedAt ?? existing.startedAt,
      completedAt: args.completedAt ?? existing.completedAt,
      updatedAt: args.updatedAt,
      errorMessage: args.errorMessage,
      resourcesCreated: args.resourcesCreated,
      resourcesReused: args.resourcesReused,
      resourceItemsImported: args.resourceItemsImported,
      threadsImported: args.threadsImported,
      messagesImported: args.messagesImported,
      syntheticMessagesAdded: args.syntheticMessagesAdded,
    });

    return {
      migrationId: args.migrationId,
      status: args.status,
    };
  },
});

export const status = query({
  args: {
    apiKey: v.string(),
    runId: v.id("v2_migrationRuns"),
    workflowId: vWorkflowId,
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ run: Doc<"v2_migrationRuns"> | null; workflowStatus: WorkflowStatus }> => {
    assertPrivateApiKey(args.apiKey);
    const run = await ctx.db.get(args.runId);
    const workflowStatus = await workflow.status(ctx, args.workflowId);

    return {
      run,
      workflowStatus,
    };
  },
});

export const listLegacyInstances = internalQuery({
  args: {},
  handler: async (ctx) => {
    const instances = await ctx.db.query("instances").collect();

    return instances
      .map((instance) => ({
        instanceId: instance._id,
        clerkUserId: instance.clerkId,
        createdAt: instance.createdAt,
      }))
      .sort((left, right) => left.createdAt - right.createdAt);
  },
});

export const listLegacyThreadsForInstance = internalQuery({
  args: {
    instanceId: v.id("instances"),
  },
  handler: async (ctx, args) => {
    const threads = await ctx.db
      .query("threads")
      .withIndex("by_instance", (query) => query.eq("instanceId", args.instanceId))
      .collect();

    return threads
      .map((thread) => ({
        threadId: thread._id,
        title: thread.title ?? null,
        createdAt: thread.createdAt,
        lastActivityAt: thread.lastActivityAt,
      }))
      .sort((left, right) => left.createdAt - right.createdAt);
  },
});

export const importLegacyResourcesForInstance = internalMutation({
  args: {
    instanceId: v.id("instances"),
    dryRun: v.boolean(),
    runId: v.optional(v.id("v2_migrationRuns")),
    includeGlobalResources: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const runId = requireRunId(args.dryRun, args.runId);
    const includeGlobalResources = args.includeGlobalResources ?? true;
    const instance = await ctx.db.get(args.instanceId);

    if (instance === null) {
      throw new Error("Legacy instance not found.");
    }

    const userId = instance.clerkId;
    const now = Date.now();
    const userResources = await ctx.db
      .query("userResources")
      .withIndex("by_instance", (query) => query.eq("instanceId", args.instanceId))
      .collect();
    const globalResources = includeGlobalResources
      ? await ctx.db.query("globalResources").collect()
      : [];
    const candidates: ResourceCandidate[] = [];
    let itemErrors = 0;

    for (const resource of globalResources) {
      if (!resource.isActive) {
        continue;
      }

      try {
        const resourceName = normalizeResourceName(resource.name);
        const itemUrl = toBrowsableGitUrl(resource.url);
        const itemName = normalizeResourceItemName(
          resource.displayName || inferGitRepoLabel(resource.url),
        );
        const itemDescription = buildDescription([
          resource.branch ? `Branch: ${resource.branch}.` : undefined,
        ]);

        candidates.push({
          sourceTable: "globalResources",
          sourceId: `${resource._id}`,
          sourceKey: `legacy-resource-item:${userId}:globalResources:${resource._id}`,
          resourceName,
          resourceCreatedAt: instance.createdAt,
          itemName,
          itemDescription,
          itemUrl,
          itemIconUrl: buildHostedFaviconUrl(itemUrl),
        });
      } catch (error) {
        itemErrors += 1;

        if (runId) {
          await recordAudit({
            ctx,
            runId,
            scope: "resource_item",
            status: "failed",
            sourceTable: "globalResources",
            sourceId: `${resource._id}`,
            sourceKey: `legacy-resource-item:${userId}:globalResources:${resource._id}`,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    for (const resource of userResources) {
      try {
        const kind = inferLegacyResourceKind(resource);

        if (kind === null) {
          throw new Error("Unable to infer resource type.");
        }

        const resourceName = normalizeResourceName(resource.name);
        const itemUrl =
          kind === "git"
            ? toBrowsableGitUrl(resource.url ?? "")
            : toNpmPackageUrl(resource.package ?? "");
        const itemName = normalizeResourceItemName(
          kind === "git"
            ? inferGitRepoLabel(resource.url ?? resource.name)
            : resource.version
              ? `${resource.package}@${resource.version}`
              : (resource.package ?? resource.name),
        );
        const itemDescription = buildDescription([
          kind === "git" && resource.branch ? `Branch: ${resource.branch}.` : undefined,
          kind === "npm" && resource.version ? `Version: ${resource.version}.` : undefined,
          kind === "git" && resource.visibility ? `Visibility: ${resource.visibility}.` : undefined,
        ]);

        candidates.push({
          sourceTable: "userResources",
          sourceId: `${resource._id}`,
          sourceKey: `legacy-resource-item:${userId}:userResources:${resource._id}`,
          resourceName,
          resourceCreatedAt: resource.createdAt,
          itemName,
          itemDescription,
          itemUrl,
          itemIconUrl: buildHostedFaviconUrl(itemUrl),
        });
      } catch (error) {
        itemErrors += 1;

        if (runId) {
          await recordAudit({
            ctx,
            runId,
            scope: "resource_item",
            status: "failed",
            sourceTable: "userResources",
            sourceId: `${resource._id}`,
            sourceKey: `legacy-resource-item:${userId}:userResources:${resource._id}`,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const resourceState = new Map<
      string,
      {
        resourceId?: Id<"v2_resources">;
        nextSortOrder: number;
        maxTouchedAt: number;
        signatures: Set<string>;
        signatureToItemId: Map<string, string>;
      }
    >();

    let resourcesCreated = 0;
    let resourcesReused = 0;
    let itemsImported = 0;
    let itemsSkipped = 0;

    const ensureResourceState = async (candidate: ResourceCandidate) => {
      const cached = resourceState.get(candidate.resourceName);

      if (cached) {
        cached.maxTouchedAt = Math.max(cached.maxTouchedAt, candidate.resourceCreatedAt);
        return cached;
      }

      const existingAudit = await getAuditBySourceKey(
        ctx,
        "resource",
        `legacy-resource:${userId}:${candidate.resourceName}`,
      );
      const existingResource = await ctx.db
        .query("v2_resources")
        .withIndex("by_user_id_and_name", (query) =>
          query.eq("userId", userId).eq("name", candidate.resourceName),
        )
        .unique();
      const existingItems =
        existingResource === null
          ? []
          : await ctx.db
              .query("v2_resourceItems")
              .withIndex("by_resource_sort_order", (query) =>
                query.eq("resourceId", existingResource._id),
              )
              .collect();
      const signatures = new Set(
        existingItems.map((item) => `${item.name.toLowerCase()}::${item.url.toLowerCase()}`),
      );
      const signatureToItemId = new Map(
        existingItems.map((item) => [
          `${item.name.toLowerCase()}::${item.url.toLowerCase()}`,
          `${item._id}`,
        ]),
      );

      if (existingResource !== null) {
        resourcesReused += 1;

        if (!args.dryRun && runId && existingAudit === null) {
          await recordAudit({
            ctx,
            runId,
            scope: "resource",
            status: "skipped",
            sourceTable: "userResources",
            sourceId: candidate.resourceName,
            sourceKey: `legacy-resource:${userId}:${candidate.resourceName}`,
            targetTable: "v2_resources",
            targetId: `${existingResource._id}`,
            detail: "Reused existing resource container.",
          });
        }

        const state = {
          resourceId: existingResource._id,
          nextSortOrder: existingItems.length,
          maxTouchedAt: Math.max(existingResource.updatedAt, candidate.resourceCreatedAt),
          signatures,
          signatureToItemId,
        };
        resourceState.set(candidate.resourceName, state);
        return state;
      }

      resourcesCreated += 1;

      if (args.dryRun) {
        const state = {
          resourceId: undefined,
          nextSortOrder: 0,
          maxTouchedAt: candidate.resourceCreatedAt,
          signatures,
          signatureToItemId,
        };
        resourceState.set(candidate.resourceName, state);
        return state;
      }

      const resourceId = await ctx.db.insert("v2_resources", {
        userId,
        name: candidate.resourceName,
        createdAt: candidate.resourceCreatedAt,
        updatedAt: candidate.resourceCreatedAt,
        createdBy: migrationCurator,
        updatedBy: migrationCurator,
      });

      if (runId) {
        await recordAudit({
          ctx,
          runId,
          scope: "resource",
          status: "imported",
          sourceTable: candidate.sourceTable,
          sourceId: candidate.resourceName,
          sourceKey: `legacy-resource:${userId}:${candidate.resourceName}`,
          targetTable: "v2_resources",
          targetId: `${resourceId}`,
          detail: "Created resource container for legacy import.",
        });
      }

      const state = {
        resourceId,
        nextSortOrder: 0,
        maxTouchedAt: candidate.resourceCreatedAt,
        signatures,
        signatureToItemId,
      };
      resourceState.set(candidate.resourceName, state);
      return state;
    };

    for (const candidate of candidates.sort(
      (left, right) => left.resourceCreatedAt - right.resourceCreatedAt,
    )) {
      const existingAudit = await getAuditBySourceKey(ctx, "resource_item", candidate.sourceKey);

      if (existingAudit !== null) {
        itemsSkipped += 1;
        continue;
      }

      const state = await ensureResourceState(candidate);
      const signature = `${candidate.itemName.toLowerCase()}::${candidate.itemUrl.toLowerCase()}`;

      if (state.signatures.has(signature)) {
        itemsSkipped += 1;

        if (!args.dryRun && runId) {
          await recordAudit({
            ctx,
            runId,
            scope: "resource_item",
            status: "skipped",
            sourceTable: candidate.sourceTable,
            sourceId: candidate.sourceId,
            sourceKey: candidate.sourceKey,
            targetTable: "v2_resourceItems",
            targetId: state.signatureToItemId.get(signature),
            detail: "Skipped duplicate legacy resource item.",
          });
        }

        continue;
      }

      itemsImported += 1;
      state.signatures.add(signature);

      if (args.dryRun) {
        state.nextSortOrder += 1;
        continue;
      }

      const resourceId = state.resourceId;

      if (resourceId === undefined) {
        throw new Error("Expected resourceId after resource creation.");
      }

      const itemId = await ctx.db.insert("v2_resourceItems", {
        resourceId,
        userId,
        name: candidate.itemName,
        description: candidate.itemDescription,
        url: candidate.itemUrl,
        iconUrl: candidate.itemIconUrl,
        sortOrder: state.nextSortOrder,
        createdAt: candidate.resourceCreatedAt,
        updatedAt: candidate.resourceCreatedAt,
        createdBy: migrationCurator,
        updatedBy: migrationCurator,
      });

      state.signatureToItemId.set(signature, `${itemId}`);
      state.nextSortOrder += 1;

      if (runId) {
        await recordAudit({
          ctx,
          runId,
          scope: "resource_item",
          status: "imported",
          sourceTable: candidate.sourceTable,
          sourceId: candidate.sourceId,
          sourceKey: candidate.sourceKey,
          targetTable: "v2_resourceItems",
          targetId: `${itemId}`,
          detail: `Imported into @${candidate.resourceName}.`,
        });
      }
    }

    if (!args.dryRun) {
      for (const [resourceName, state] of resourceState) {
        if (state.resourceId === undefined) {
          continue;
        }

        const resource = await ctx.db.get(state.resourceId);

        if (resource === null) {
          continue;
        }

        const nextUpdatedAt = Math.max(resource.updatedAt, state.maxTouchedAt, now);
        await ctx.db.patch(state.resourceId, {
          updatedAt: nextUpdatedAt,
          updatedBy: migrationCurator,
        });

        if (runId) {
          const audit = await getAuditBySourceKey(
            ctx,
            "resource",
            `legacy-resource:${userId}:${resourceName}`,
          );

          if (audit === null) {
            await recordAudit({
              ctx,
              runId,
              scope: "resource",
              status: "skipped",
              sourceTable: "userResources",
              sourceId: resourceName,
              sourceKey: `legacy-resource:${userId}:${resourceName}`,
              targetTable: "v2_resources",
              targetId: `${state.resourceId}`,
              detail: "Resource container already existed before import.",
            });
          }
        }
      }
    }

    return {
      instanceId: args.instanceId,
      userId,
      resourcesCreated,
      resourcesReused,
      itemsImported,
      itemsSkipped,
      itemErrors,
    };
  },
});

export const importLegacyThread = internalMutation({
  args: {
    threadId: v.id("threads"),
    dryRun: v.boolean(),
    runId: v.optional(v.id("v2_migrationRuns")),
  },
  handler: async (ctx, args) => {
    const runId = requireRunId(args.dryRun, args.runId);
    const thread = await ctx.db.get(args.threadId);

    if (thread === null) {
      throw new Error("Legacy thread not found.");
    }

    const instance = await ctx.db.get(thread.instanceId);

    if (instance === null) {
      throw new Error("Legacy thread instance not found.");
    }

    const userId = instance.clerkId;
    const targetThreadId = `legacy:${thread._id}`;
    const threadSourceKey = `legacy-thread:${thread._id}`;
    const existingThreadAudit = await getAuditBySourceKey(ctx, "thread", threadSourceKey);

    if (existingThreadAudit !== null) {
      const legacyMessages = await ctx.db
        .query("messages")
        .withIndex("by_thread", (query) => query.eq("threadId", args.threadId))
        .collect();

      return {
        imported: false,
        skipped: true,
        userId,
        targetThreadId,
        messagesImported: 0,
        messagesSkipped: legacyMessages.length,
        syntheticMessagesAdded: 0,
      };
    }

    const existingThread = await ctx.db
      .query("v2_agentThreads")
      .withIndex("by_thread_id", (query) => query.eq("threadId", targetThreadId))
      .unique();

    if (existingThread !== null) {
      if (!args.dryRun && runId) {
        await recordAudit({
          ctx,
          runId,
          scope: "thread",
          status: "skipped",
          sourceTable: "threads",
          sourceId: `${thread._id}`,
          sourceKey: threadSourceKey,
          targetTable: "v2_agentThreads",
          targetId: `${existingThread._id}`,
          detail: "Skipped because target thread already exists.",
        });
      }

      const legacyMessages = await ctx.db
        .query("messages")
        .withIndex("by_thread", (query) => query.eq("threadId", args.threadId))
        .collect();

      return {
        imported: false,
        skipped: true,
        userId,
        targetThreadId,
        messagesImported: 0,
        messagesSkipped: legacyMessages.length,
        syntheticMessagesAdded: 0,
      };
    }

    const legacyMessages = (
      await ctx.db
        .query("messages")
        .withIndex("by_thread", (query) => query.eq("threadId", args.threadId))
        .collect()
    ).sort((left, right) => left.createdAt - right.createdAt);
    const threadResources = await ctx.db
      .query("threadResources")
      .withIndex("by_thread", (query) => query.eq("threadId", args.threadId))
      .collect();
    const threadResourceNames = normalizeTaggedResourceList(
      threadResources.map((resource) => resource.resourceName),
    );
    const importedMessages: ImportedThreadMessage[] = [];

    if (threadResourceNames.length > 0) {
      importedMessages.push({
        role: "assistant",
        timestamp: Math.max(thread.createdAt, 0),
        rawJson: JSON.stringify(
          createLegacyResourceNote(threadResourceNames, Math.max(thread.createdAt, 0)),
        ),
      });
    }

    for (const legacyMessage of legacyMessages) {
      const parsedMessage =
        legacyMessage.role === "user"
          ? buildLegacyUserMessage(legacyMessage)
          : legacyMessage.role === "assistant"
            ? buildLegacyAssistantMessage(legacyMessage)
            : buildLegacySystemMessage(legacyMessage);
      const role = parsedMessage.role === "user" ? "user" : "assistant";

      importedMessages.push({
        role,
        timestamp: legacyMessage.createdAt,
        rawJson: JSON.stringify(parsedMessage),
        sourceId: `${legacyMessage._id}`,
        sourceKey: `legacy-message:${legacyMessage._id}`,
      });
    }

    const firstUserMessage = legacyMessages.find((message) => message.role === "user");
    const titleSource =
      firstUserMessage === undefined
        ? (thread.title?.trim() ?? "Legacy Thread")
        : appendResourceMentions(
            flattenLegacyContent(firstUserMessage.content),
            firstUserMessage.resources ?? [],
          );
    const lastUserMessage = [...legacyMessages]
      .reverse()
      .find((message) => message.role === "user");
    const lastNonUserMessage = [...legacyMessages]
      .reverse()
      .find((message) => message.role === "assistant" || message.role === "system");
    const lastMessagePreviewSource = [...legacyMessages].reverse().find((message) => {
      const content = appendResourceMentions(
        flattenLegacyContent(message.content),
        message.resources ?? [],
      );
      return content.trim().length > 0;
    });
    const activity =
      lastMessagePreviewSource === undefined
        ? threadResourceNames.length > 0
          ? `Legacy thread resources: ${formatTaggedResources(threadResourceNames)}`
          : null
        : toPreview(
            appendResourceMentions(
              flattenLegacyContent(lastMessagePreviewSource.content),
              lastMessagePreviewSource.resources ?? [],
            ),
          );

    if (args.dryRun) {
      return {
        imported: true,
        skipped: false,
        userId,
        targetThreadId,
        messagesImported: legacyMessages.length,
        messagesSkipped: 0,
        syntheticMessagesAdded: threadResourceNames.length > 0 ? 1 : 0,
      };
    }

    const threadRef = await ctx.db.insert("v2_agentThreads", {
      threadId: targetThreadId,
      userId,
      title: thread.title?.trim() || toPreview(titleSource, 80),
      sandboxId: undefined,
      selectedModelId: LEGACY_ASSISTANT_MODEL,
      isMcp: false,
      status: "idle",
      activity: activity ?? undefined,
      createdAt: thread.createdAt,
      updatedAt: Math.max(
        thread.lastActivityAt,
        importedMessages.at(-1)?.timestamp ?? thread.createdAt,
      ),
      lastPromptAt: lastUserMessage?.createdAt ?? thread.createdAt,
      lastCompletedAt: lastNonUserMessage?.createdAt,
      messageCount: importedMessages.length,
    });

    let legacyMessageImports = 0;

    for (const [index, message] of importedMessages.entries()) {
      const insertedMessageId = await ctx.db.insert("v2_agentThreadMessages", {
        threadId: targetThreadId,
        threadRef,
        sequence: index,
        role: message.role,
        messageTimestamp: message.timestamp,
        rawJson: message.rawJson,
        createdAt: message.timestamp,
      });

      if (runId && message.sourceId && message.sourceKey) {
        legacyMessageImports += 1;
        await recordAudit({
          ctx,
          runId,
          scope: "message",
          status: "imported",
          sourceTable: "messages",
          sourceId: message.sourceId,
          sourceKey: message.sourceKey,
          targetTable: "v2_agentThreadMessages",
          targetId: `${insertedMessageId}`,
          detail: `Imported into ${targetThreadId}.`,
        });
      }
    }

    if (runId) {
      await recordAudit({
        ctx,
        runId,
        scope: "thread",
        status: "imported",
        sourceTable: "threads",
        sourceId: `${thread._id}`,
        sourceKey: threadSourceKey,
        targetTable: "v2_agentThreads",
        targetId: `${threadRef}`,
        detail: `Imported ${legacyMessages.length} legacy message(s).`,
      });
    }

    return {
      imported: true,
      skipped: false,
      userId,
      targetThreadId,
      messagesImported: legacyMessageImports,
      messagesSkipped: 0,
      syntheticMessagesAdded: importedMessages.length - legacyMessageImports,
    };
  },
});

export const migrate = workflow.define({
  args: {
    runId: v.id("v2_migrationRuns"),
    migrationId: v.optional(v.id("v2_userMigrations")),
    mode: migrationModeValidator,
    dryRun: v.boolean(),
    includeGlobalResources: v.optional(v.boolean()),
    instanceId: v.optional(v.id("instances")),
    clerkUserId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: migrationWorkflowResultValidator,
  handler: async (step, args): Promise<MigrationWorkflowResult> => {
    const legacyInstances = await step.runQuery(
      internal.private.migrations.listLegacyInstances,
      {},
    );
    type LegacyInstance = (typeof legacyInstances)[number];
    const filteredInstances = legacyInstances
      .filter((instance: LegacyInstance) =>
        args.instanceId ? instance.instanceId === args.instanceId : true,
      )
      .filter((instance: LegacyInstance) =>
        args.clerkUserId ? instance.clerkUserId === args.clerkUserId : true,
      )
      .slice(
        0,
        args.limit !== undefined && Number.isFinite(args.limit)
          ? args.limit
          : legacyInstances.length,
      );
    const result: MigrationWorkflowResult = {
      dryRun: args.dryRun,
      mode: args.mode,
      runId: args.runId,
      instancesScanned: filteredInstances.length,
      resourcesCreated: 0,
      resourcesReused: 0,
      resourceItemsImported: 0,
      resourceItemsSkipped: 0,
      resourceItemErrors: 0,
      threadsImported: 0,
      threadsSkipped: 0,
      messagesImported: 0,
      messagesSkipped: 0,
      syntheticMessagesAdded: 0,
      errors: [],
    };

    try {
      for (const instance of filteredInstances) {
        if (args.mode === "resources" || args.mode === "all") {
          try {
            const resourceResult = await step.runMutation(
              internal.private.migrations.importLegacyResourcesForInstance,
              {
                instanceId: instance.instanceId,
                dryRun: args.dryRun,
                runId: args.runId,
                includeGlobalResources: args.includeGlobalResources,
              },
            );

            result.resourcesCreated += resourceResult.resourcesCreated;
            result.resourcesReused += resourceResult.resourcesReused;
            result.resourceItemsImported += resourceResult.itemsImported;
            result.resourceItemsSkipped += resourceResult.itemsSkipped;
            result.resourceItemErrors += resourceResult.itemErrors;
          } catch (error) {
            result.errors.push({
              scope: "instance",
              id: `${instance.instanceId}`,
              message: `Resource import failed: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }

        if (args.mode === "threads" || args.mode === "all") {
          let legacyThreads: Array<{
            threadId: Id<"threads">;
            title: string | null;
            createdAt: number;
            lastActivityAt: number;
          }>;

          try {
            legacyThreads = await step.runQuery(
              internal.private.migrations.listLegacyThreadsForInstance,
              {
                instanceId: instance.instanceId,
              },
            );
          } catch (error) {
            result.errors.push({
              scope: "instance",
              id: `${instance.instanceId}`,
              message: `Thread discovery failed: ${error instanceof Error ? error.message : String(error)}`,
            });
            continue;
          }

          for (const thread of legacyThreads) {
            try {
              const threadResult = await step.runMutation(
                internal.private.migrations.importLegacyThread,
                {
                  threadId: thread.threadId,
                  dryRun: args.dryRun,
                  runId: args.runId,
                },
              );

              if (threadResult.imported) {
                result.threadsImported += 1;
              }

              if (threadResult.skipped) {
                result.threadsSkipped += 1;
              }

              result.messagesImported += threadResult.messagesImported;
              result.messagesSkipped += threadResult.messagesSkipped;
              result.syntheticMessagesAdded += threadResult.syntheticMessagesAdded;
            } catch (error) {
              result.errors.push({
                scope: "thread",
                id: `${thread.threadId}`,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
      }

      await step.runMutation(internal.private.migrations.finalizeRun, {
        runId: args.runId,
        status: result.errors.length > 0 ? "failed" : "completed",
        notes:
          result.errors.length > 0
            ? `Workflow completed with ${result.errors.length} error(s).`
            : "Workflow completed successfully.",
        processedResourceCount: result.resourcesCreated + result.resourcesReused,
        processedResourceItemCount: result.resourceItemsImported,
        processedThreadCount: result.threadsImported,
        processedMessageCount: result.messagesImported + result.syntheticMessagesAdded,
        skippedCount: result.resourceItemsSkipped + result.threadsSkipped + result.messagesSkipped,
        errorCount: result.errors.length + result.resourceItemErrors,
      });

      if (args.migrationId) {
        await step.runMutation(internal.private.migrations.updateUserMigration, {
          migrationId: args.migrationId,
          status: result.errors.length > 0 ? "failed" : "completed",
          runId: args.runId,
          workflowId: undefined,
          startedAt: undefined,
          completedAt: Date.now(),
          updatedAt: Date.now(),
          errorMessage:
            result.errors.length > 0
              ? result.errors.map((error) => error.message).join(" | ")
              : undefined,
          ...toMigrationSummary(result),
        });
      }

      return result;
    } catch (error) {
      const failureMessage = error instanceof Error ? error.message : String(error);
      const errors = [
        ...result.errors,
        {
          scope: "run" as const,
          id: `${args.runId}`,
          message: failureMessage,
        },
      ];

      await step.runMutation(internal.private.migrations.finalizeRun, {
        runId: args.runId,
        status: "failed",
        notes: `Workflow failed: ${failureMessage}`,
        processedResourceCount: result.resourcesCreated + result.resourcesReused,
        processedResourceItemCount: result.resourceItemsImported,
        processedThreadCount: result.threadsImported,
        processedMessageCount: result.messagesImported + result.syntheticMessagesAdded,
        skippedCount: result.resourceItemsSkipped + result.threadsSkipped + result.messagesSkipped,
        errorCount: errors.length + result.resourceItemErrors,
      });

      if (args.migrationId) {
        await step.runMutation(internal.private.migrations.updateUserMigration, {
          migrationId: args.migrationId,
          status: "failed",
          runId: args.runId,
          workflowId: undefined,
          startedAt: undefined,
          completedAt: Date.now(),
          updatedAt: Date.now(),
          errorMessage: failureMessage,
          ...toMigrationSummary(result),
        });
      }

      throw error;
    }
  },
});
