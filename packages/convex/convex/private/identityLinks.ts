import type { IndexRangeBuilder } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { privateMutation, privateQuery } from "./helpers";

const migrationSourceValidator = v.union(
  v.literal("workos_external_id"),
  v.literal("sign_in_fallback"),
  v.literal("manual"),
);

const linkStatusValidator = v.union(
  v.literal("linked"),
  v.literal("fallback_linked"),
  v.literal("pending_review"),
);

const assertCompatibleLink = ({
  existing,
  clerkUserId,
  workosUserId,
}: {
  existing: Doc<"v2_identityLinks">;
  clerkUserId: string;
  workosUserId: string;
}) => {
  if (existing.clerkUserId !== clerkUserId || existing.workosUserId !== workosUserId) {
    throw new Error("Identity link conflict detected.");
  }
};

export const getCanonicalUserId = privateQuery({
  args: {
    workosUserId: v.string(),
  },
  handler: async (ctx, args) => {
    const link = await ctx.db
      .query("v2_identityLinks")
      .withIndex(
        "by_workos_user_id",
        (query: IndexRangeBuilder<Doc<"v2_identityLinks">, ["workosUserId"]>) =>
          query.eq("workosUserId", args.workosUserId),
      )
      .unique();

    return {
      canonicalUserId: link?.clerkUserId ?? args.workosUserId,
      legacyClerkUserId: link?.clerkUserId ?? null,
      workosUserId: args.workosUserId,
    };
  },
});

export const upsert = privateMutation({
  args: {
    clerkUserId: v.string(),
    workosUserId: v.string(),
    primaryEmail: v.optional(v.string()),
    migrationSource: migrationSourceValidator,
    status: linkStatusValidator,
  },
  handler: async (ctx, args) => {
    const existingByWorkosUserId = await ctx.db
      .query("v2_identityLinks")
      .withIndex(
        "by_workos_user_id",
        (query: IndexRangeBuilder<Doc<"v2_identityLinks">, ["workosUserId"]>) =>
          query.eq("workosUserId", args.workosUserId),
      )
      .unique();
    const existingByClerkUserId = await ctx.db
      .query("v2_identityLinks")
      .withIndex(
        "by_clerk_user_id",
        (query: IndexRangeBuilder<Doc<"v2_identityLinks">, ["clerkUserId"]>) =>
          query.eq("clerkUserId", args.clerkUserId),
      )
      .unique();

    if (
      existingByWorkosUserId !== null &&
      existingByClerkUserId !== null &&
      existingByWorkosUserId._id !== existingByClerkUserId._id
    ) {
      throw new Error("Identity link conflict detected.");
    }

    if (existingByWorkosUserId !== null) {
      assertCompatibleLink({
        existing: existingByWorkosUserId,
        clerkUserId: args.clerkUserId,
        workosUserId: args.workosUserId,
      });
    }

    if (existingByClerkUserId !== null) {
      assertCompatibleLink({
        existing: existingByClerkUserId,
        clerkUserId: args.clerkUserId,
        workosUserId: args.workosUserId,
      });
    }

    const now = Date.now();
    const existing = existingByWorkosUserId ?? existingByClerkUserId;

    if (existing === null) {
      await ctx.db.insert("v2_identityLinks", {
        clerkUserId: args.clerkUserId,
        workosUserId: args.workosUserId,
        primaryEmail: args.primaryEmail,
        migrationSource: args.migrationSource,
        createdAt: now,
        linkedAt: now,
        status: args.status,
      });
    } else {
      await ctx.db.patch(existing._id, {
        primaryEmail: args.primaryEmail ?? existing.primaryEmail,
        migrationSource: args.migrationSource,
        linkedAt: now,
        status: args.status,
      });
    }

    return {
      canonicalUserId: args.clerkUserId,
      legacyClerkUserId: args.clerkUserId,
      workosUserId: args.workosUserId,
    };
  },
});
