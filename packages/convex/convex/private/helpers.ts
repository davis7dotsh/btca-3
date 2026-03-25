import { v } from "convex/values";
import {
  customAction,
  customCtxAndArgs,
  customMutation,
  customQuery,
} from "convex-helpers/server/customFunctions";
import { action, mutation, query } from "../_generated/server";

const apiKeyGuard = customCtxAndArgs({
  args: { apiKey: v.string() },
  input: async (ctx, { apiKey }) => {
    if (apiKey !== process.env.CONVEX_PRIVATE_BRIDGE_KEY) {
      throw new Error("Invalid API key");
    }

    return { ctx, args: {} };
  },
});

export const privateQuery = customQuery(query, apiKeyGuard);
export const privateMutation = customMutation(mutation, apiKeyGuard);
export const privateAction = customAction(action, apiKeyGuard);
