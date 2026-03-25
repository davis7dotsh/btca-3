import { v } from "convex/values";
import { privateQuery } from "./helpers";

export const privateDemoQuery = privateQuery({
  args: {
    username: v.string(),
  },
  handler: async (_ctx, args) => {
    return { username: args.username };
  },
});
