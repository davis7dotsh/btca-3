import type { MutationCtx, QueryCtx } from "../_generated/server";
import { customAction, customMutation, customQuery } from "convex-helpers/server/customFunctions";
import { action, mutation, query } from "../_generated/server";

export const resolveAuthUser = async (
  ctx: Pick<QueryCtx | MutationCtx, "db">,
  workosUserId: string,
) => {
  const identityLink = await ctx.db
    .query("v2_identityLinks")
    .withIndex("by_workos_user_id", (indexQuery) => indexQuery.eq("workosUserId", workosUserId))
    .unique();

  return {
    userId: identityLink?.clerkUserId ?? workosUserId,
    workosUserId,
    legacyClerkUserId: identityLink?.clerkUserId ?? null,
  };
};

export const authedQuery = customQuery(query, {
  args: {},
  input: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();

    if (identity === null) {
      throw new Error("Unauthorized");
    }

    const authUser = await resolveAuthUser(ctx, identity.subject);

    return {
      ctx: {
        ...ctx,
        identity,
        authUser,
      },
      args: {},
    };
  },
});

export const authedMutation = customMutation(mutation, {
  args: {},
  input: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();

    if (identity === null) {
      throw new Error("Unauthorized");
    }

    const authUser = await resolveAuthUser(ctx, identity.subject);

    return {
      ctx: {
        ...ctx,
        identity,
        authUser,
      },
      args: {},
    };
  },
});

export const authedAction = customAction(action, {
  args: {},
  input: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();

    if (identity === null) {
      throw new Error("Unauthorized");
    }

    const authUser = {
      userId: identity.subject,
      workosUserId: identity.subject,
      legacyClerkUserId: null,
    };

    return {
      ctx: {
        ...ctx,
        identity,
        authUser,
      },
      args: {},
    };
  },
});
