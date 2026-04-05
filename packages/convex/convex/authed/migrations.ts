import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { mutation, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { workflow } from "../workflow";
import { resolveAuthUser } from "./helpers";

const LEGACY_CONVEX_MIGRATION_KEY = "legacy_convex_data" as const;

const getOwnedMigration = async (ctx: QueryCtx | MutationCtx, userId: string) =>
  ctx.db
    .query("v2_userMigrations")
    .withIndex("by_user_id_and_key", (indexQuery) =>
      indexQuery.eq("userId", userId).eq("key", LEGACY_CONVEX_MIGRATION_KEY),
    )
    .unique();

const requireAuthUser = async (ctx: QueryCtx | MutationCtx) => {
  const identity = await ctx.auth.getUserIdentity();

  if (identity === null) {
    throw new Error("Unauthorized");
  }

  return {
    identity,
    authUser: await resolveAuthUser(ctx, identity.subject),
  };
};

export const getStatus = query({
  args: {},
  handler: async (ctx) => {
    const { authUser } = await requireAuthUser(ctx);
    const migration = await getOwnedMigration(ctx, authUser.userId);

    if (migration === null) {
      return {
        key: LEGACY_CONVEX_MIGRATION_KEY,
        status: "not_started" as const,
        shouldAutoStart: true,
        startedAt: null,
        completedAt: null,
        updatedAt: 0,
        errorMessage: null,
      };
    }

    return {
      key: migration.key,
      status: migration.status,
      shouldAutoStart: migration.status === "not_started",
      startedAt: migration.startedAt ?? null,
      completedAt: migration.completedAt ?? null,
      updatedAt: migration.updatedAt,
      errorMessage: migration.errorMessage ?? null,
    };
  },
});

export const start = mutation({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    started: boolean;
    status: "running" | "completed";
    workflowId: string | null;
    runId: Id<"v2_migrationRuns"> | null;
  }> => {
    const { authUser } = await requireAuthUser(ctx);
    const userId = authUser.userId;
    const existing = await getOwnedMigration(ctx, userId);

    if (existing?.status === "completed") {
      return {
        started: false,
        status: existing.status,
        workflowId: existing.workflowId ?? null,
        runId: existing.runId ?? null,
      };
    }

    if (existing?.status === "running") {
      return {
        started: false,
        status: existing.status,
        workflowId: existing.workflowId ?? null,
        runId: existing.runId ?? null,
      };
    }

    const now = Date.now();
    const runId = await ctx.db.insert("v2_migrationRuns", {
      userId,
      kind: "legacy_convex_all",
      status: "running",
      dryRun: false,
      notes: "Workflow queued from authenticated app session.",
      startedAt: now,
      completedAt: undefined,
      processedResourceCount: 0,
      processedResourceItemCount: 0,
      processedThreadCount: 0,
      processedMessageCount: 0,
      skippedCount: 0,
      errorCount: 0,
    });
    const migrationId =
      existing?._id ??
      (await ctx.db.insert("v2_userMigrations", {
        userId,
        key: LEGACY_CONVEX_MIGRATION_KEY,
        status: "not_started",
        runId: undefined,
        workflowId: undefined,
        startedAt: undefined,
        completedAt: undefined,
        updatedAt: now,
        errorMessage: undefined,
        resourcesCreated: 0,
        resourcesReused: 0,
        resourceItemsImported: 0,
        threadsImported: 0,
        messagesImported: 0,
        syntheticMessagesAdded: 0,
      }));
    try {
      const workflowId: string = await workflow.start(ctx, internal.private.migrations.migrate, {
        runId,
        migrationId,
        mode: "all",
        dryRun: false,
        includeGlobalResources: true,
        instanceId: undefined,
        clerkUserId: userId,
        limit: undefined,
      });

      await ctx.db.patch(runId, {
        notes: `Workflow started from app session: ${workflowId}`,
      });
      await ctx.db.patch(migrationId, {
        status: "running",
        runId,
        workflowId,
        startedAt: existing?.startedAt ?? now,
        completedAt: undefined,
        updatedAt: now,
        errorMessage: undefined,
        resourcesCreated: 0,
        resourcesReused: 0,
        resourceItemsImported: 0,
        threadsImported: 0,
        messagesImported: 0,
        syntheticMessagesAdded: 0,
      });

      return {
        started: true,
        status: "running" as const,
        workflowId,
        runId,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await ctx.db.patch(runId, {
        status: "failed",
        notes: `Failed to start workflow: ${message}`,
        completedAt: Date.now(),
        errorCount: 1,
      });
      await ctx.db.patch(migrationId, {
        status: "failed",
        runId,
        workflowId: undefined,
        startedAt: existing?.startedAt ?? now,
        completedAt: Date.now(),
        updatedAt: Date.now(),
        errorMessage: message,
      });

      throw error;
    }
  },
});
