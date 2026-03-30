import { v } from "convex/values";
import { authedMutation, authedQuery } from "./helpers";

export const list = authedQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("v2_conferences").collect();
  },
});

export const create = authedMutation({
  args: {
    name: v.string(),
    location: v.string(),
    startDate: v.number(),
    endDate: v.number(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("v2_conferences", args);
  },
});

export const update = authedMutation({
  args: {
    id: v.id("v2_conferences"),
    name: v.string(),
    location: v.string(),
    startDate: v.number(),
    endDate: v.number(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { id, ...fields } = args;
    await ctx.db.patch(id, fields);
  },
});

export const remove = authedMutation({
  args: {
    id: v.id("v2_conferences"),
  },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});
