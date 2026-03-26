import { v } from "convex/values";
import { authedMutation, authedQuery } from "./helpers";

const getUserId = (identity: { subject: string }) => identity.subject;

const toThreadListItem = (thread: {
  threadId: string;
  title?: string;
  sandboxId?: string;
  selectedModelId?: string;
  isMcp?: boolean;
  status?: "idle" | "running" | "error";
  activity?: string;
  createdAt: number;
  updatedAt: number;
  lastPromptAt: number;
  lastCompletedAt?: number;
  messageCount: number;
}) => ({
  threadId: thread.threadId,
  title: thread.title ?? null,
  sandboxId: thread.sandboxId ?? null,
  selectedModelId: thread.selectedModelId ?? null,
  isMcp: thread.isMcp ?? false,
  status: thread.status ?? "idle",
  activity: thread.activity ?? null,
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
  lastPromptAt: thread.lastPromptAt,
  lastCompletedAt: thread.lastCompletedAt ?? null,
  messageCount: thread.messageCount,
});

export const list = authedQuery({
  args: {},
  handler: async (ctx) => {
    const userId = getUserId(ctx.identity);
    const threads = await ctx.db
      .query("agentThreads")
      .withIndex("by_user_id", (query) => query.eq("userId", userId))
      .collect();

    return threads.sort((a, b) => b.updatedAt - a.updatedAt).map(toThreadListItem);
  },
});

export const listMcp = authedQuery({
  args: {},
  handler: async (ctx) => {
    const userId = getUserId(ctx.identity);
    const threads = await ctx.db
      .query("agentThreads")
      .withIndex("by_user_id", (query) => query.eq("userId", userId))
      .collect();

    return threads
      .filter((thread) => thread.isMcp === true)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(toThreadListItem);
  },
});

export const get = authedQuery({
  args: {
    threadId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = getUserId(ctx.identity);
    const thread = await ctx.db
      .query("agentThreads")
      .withIndex("by_thread_id", (query) => query.eq("threadId", args.threadId))
      .unique();

    if (thread === null) {
      return null;
    }

    if (thread.userId !== userId) {
      throw new Error("Unauthorized thread access");
    }

    const messages = await ctx.db
      .query("agentThreadMessages")
      .withIndex("by_thread_sequence", (query) => query.eq("threadId", args.threadId))
      .collect();

    return {
      thread: toThreadListItem(thread),
      messages: messages.map((message) => ({
        sequence: message.sequence,
        role: message.role,
        timestamp: message.messageTimestamp ?? null,
        rawJson: message.rawJson,
      })),
    };
  },
});

export const getDefaultModel = authedQuery({
  args: {},
  handler: async (ctx) => {
    const userId = getUserId(ctx.identity);
    const preferences = await ctx.db
      .query("agentUserPreferences")
      .withIndex("by_user_id", (query) => query.eq("userId", userId))
      .unique();

    return {
      defaultModelId: preferences?.defaultModelId ?? null,
    };
  },
});

export const setDefaultModel = authedMutation({
  args: {
    modelId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = getUserId(ctx.identity);
    const now = Date.now();
    const existing = await ctx.db
      .query("agentUserPreferences")
      .withIndex("by_user_id", (query) => query.eq("userId", userId))
      .unique();

    if (existing === null) {
      await ctx.db.insert("agentUserPreferences", {
        userId,
        defaultModelId: args.modelId,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(existing._id, {
        defaultModelId: args.modelId,
        updatedAt: now,
      });
    }

    return {
      defaultModelId: args.modelId,
    };
  },
});

export const setThreadModelSelection = authedMutation({
  args: {
    threadId: v.string(),
    modelId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = getUserId(ctx.identity);
    const now = Date.now();
    const thread = await ctx.db
      .query("agentThreads")
      .withIndex("by_thread_id", (query) => query.eq("threadId", args.threadId))
      .unique();

    if (thread === null) {
      throw new Error("Thread not found.");
    }

    if (thread.userId !== userId) {
      throw new Error("Unauthorized thread access");
    }

    await ctx.db.patch(thread._id, {
      selectedModelId: args.modelId,
      updatedAt: now,
    });

    const existingPreferences = await ctx.db
      .query("agentUserPreferences")
      .withIndex("by_user_id", (query) => query.eq("userId", userId))
      .unique();

    if (existingPreferences === null) {
      await ctx.db.insert("agentUserPreferences", {
        userId,
        defaultModelId: args.modelId,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(existingPreferences._id, {
        defaultModelId: args.modelId,
        updatedAt: now,
      });
    }

    return {
      threadId: args.threadId,
      selectedModelId: args.modelId,
      defaultModelId: args.modelId,
    };
  },
});

export const deleteThread = authedMutation({
  args: {
    threadId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = getUserId(ctx.identity);
    const thread = await ctx.db
      .query("agentThreads")
      .withIndex("by_thread_id", (query) => query.eq("threadId", args.threadId))
      .unique();

    if (thread === null) {
      return;
    }

    if (thread.userId !== userId) {
      throw new Error("Unauthorized thread access");
    }

    const messages = await ctx.db
      .query("agentThreadMessages")
      .withIndex("by_thread_sequence", (query) => query.eq("threadId", args.threadId))
      .collect();

    for (const message of messages) {
      await ctx.db.delete(message._id);
    }

    await ctx.db.delete(thread._id);
  },
});

export const rewindThread = authedMutation({
  args: {
    threadId: v.string(),
    sequence: v.number(),
  },
  handler: async (ctx, args) => {
    if (!Number.isInteger(args.sequence) || args.sequence < 0) {
      throw new Error("Expected a non-negative message sequence.");
    }

    const userId = getUserId(ctx.identity);
    const thread = await ctx.db
      .query("agentThreads")
      .withIndex("by_thread_id", (query) => query.eq("threadId", args.threadId))
      .unique();

    if (thread === null) {
      throw new Error("Thread not found.");
    }

    if (thread.userId !== userId) {
      throw new Error("Unauthorized thread access");
    }

    const messages = (
      await ctx.db
        .query("agentThreadMessages")
        .withIndex("by_thread_sequence", (query) => query.eq("threadId", args.threadId))
        .collect()
    ).sort((left, right) => left.sequence - right.sequence);

    const rewindTarget = messages.find((message) => message.sequence === args.sequence);

    if (!rewindTarget) {
      throw new Error("Message not found for retry.");
    }

    if (rewindTarget.role !== "user") {
      throw new Error("Retry is only supported from user messages.");
    }

    const remainingMessages = messages.filter((message) => message.sequence < args.sequence);

    for (const message of messages) {
      if (message.sequence >= args.sequence) {
        await ctx.db.delete(message._id);
      }
    }

    const lastUserMessage = [...remainingMessages]
      .reverse()
      .find((message) => message.role === "user");
    const lastPersistedMessage = remainingMessages.at(-1);
    const now = Date.now();

    await ctx.db.patch(thread._id, {
      updatedAt: now,
      lastPromptAt: lastUserMessage?.messageTimestamp ?? thread.createdAt,
      lastCompletedAt: lastPersistedMessage?.messageTimestamp ?? undefined,
      messageCount: remainingMessages.length,
    });

    return {
      threadId: thread.threadId,
      messageCount: remainingMessages.length,
    };
  },
});

export const create = authedMutation({
  args: {
    threadId: v.string(),
    selectedModelId: v.optional(v.string()),
    isMcp: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = getUserId(ctx.identity);
    const existing = await ctx.db
      .query("agentThreads")
      .withIndex("by_thread_id", (query) => query.eq("threadId", args.threadId))
      .unique();

    if (existing !== null) {
      if (existing.userId !== userId) {
        throw new Error("Unauthorized thread access");
      }

      return {
        threadId: existing.threadId,
      };
    }

    const now = Date.now();

    await ctx.db.insert("agentThreads", {
      threadId: args.threadId,
      userId,
      title: undefined,
      sandboxId: undefined,
      selectedModelId: args.selectedModelId,
      isMcp: args.isMcp ?? false,
      status: "idle",
      activity: undefined,
      createdAt: now,
      updatedAt: now,
      lastPromptAt: now,
      lastCompletedAt: undefined,
      messageCount: 0,
    });

    return {
      threadId: args.threadId,
    };
  },
});
