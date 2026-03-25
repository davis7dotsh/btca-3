import type { IndexRangeBuilder } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { privateMutation, privateQuery } from "./helpers";

const storedMessageValidator = v.object({
  role: v.string(),
  timestamp: v.optional(v.number()),
  rawJson: v.string(),
});

const threadStatusValidator = v.union(v.literal("idle"), v.literal("running"), v.literal("error"));

export const getThreadContext = privateQuery({
  args: {
    threadId: v.string(),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const thread = await ctx.db
      .query("agentThreads")
      .withIndex("by_thread_id", (query: IndexRangeBuilder<Doc<"agentThreads">, ["threadId"]>) =>
        query.eq("threadId", args.threadId),
      )
      .unique();

    if (thread === null) {
      return null;
    }

    if (thread.userId !== args.userId) {
      throw new Error("Unauthorized thread access");
    }

    const messages = await ctx.db
      .query("agentThreadMessages")
      .withIndex(
        "by_thread_sequence",
        (query: IndexRangeBuilder<Doc<"agentThreadMessages">, ["threadId", "sequence"]>) =>
          query.eq("threadId", args.threadId),
      )
      .collect();

    return {
      thread: {
        threadId: thread.threadId,
        userId: thread.userId,
        title: thread.title ?? null,
        sandboxId: thread.sandboxId ?? null,
        isMcp: thread.isMcp ?? false,
        status: thread.status ?? "idle",
        activity: thread.activity ?? null,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        lastPromptAt: thread.lastPromptAt,
        lastCompletedAt: thread.lastCompletedAt ?? null,
        messageCount: thread.messageCount,
      },
      messages: messages.map((message: Doc<"agentThreadMessages">) => ({
        sequence: message.sequence,
        role: message.role,
        timestamp: message.messageTimestamp ?? null,
        rawJson: message.rawJson,
      })),
    };
  },
});

export const appendThreadMessages = privateMutation({
  args: {
    threadId: v.string(),
    userId: v.string(),
    sandboxId: v.string(),
    isMcp: v.optional(v.boolean()),
    startedAt: v.number(),
    completedAt: v.number(),
    promptPreview: v.string(),
    messages: v.array(storedMessageValidator),
  },
  handler: async (ctx, args) => {
    const thread = await ctx.db
      .query("agentThreads")
      .withIndex("by_thread_id", (query: IndexRangeBuilder<Doc<"agentThreads">, ["threadId"]>) =>
        query.eq("threadId", args.threadId),
      )
      .unique();

    if (thread !== null && thread.userId !== args.userId) {
      throw new Error("Unauthorized thread access");
    }

    const createdAt = thread?.createdAt ?? args.startedAt;
    const threadRef: Id<"agentThreads"> =
      thread?._id ??
      (await ctx.db.insert("agentThreads", {
        threadId: args.threadId,
        userId: args.userId,
        title: undefined,
        sandboxId: args.sandboxId,
        isMcp: args.isMcp ?? false,
        status: "idle",
        activity: args.promptPreview,
        createdAt,
        updatedAt: args.completedAt,
        lastPromptAt: args.startedAt,
        lastCompletedAt: args.completedAt,
        messageCount: 0,
      }));

    const baseSequence = thread?.messageCount ?? 0;

    for (const [index, message] of args.messages.entries()) {
      await ctx.db.insert("agentThreadMessages", {
        threadId: args.threadId,
        threadRef,
        sequence: baseSequence + index,
        role: message.role,
        messageTimestamp: message.timestamp,
        rawJson: message.rawJson,
        createdAt: args.completedAt,
      });
    }

    const nextMessageCount = baseSequence + args.messages.length;

    await ctx.db.patch(threadRef, {
      title: thread?.title ?? args.promptPreview,
      sandboxId: args.sandboxId,
      isMcp: thread?.isMcp ?? args.isMcp ?? false,
      status: "idle",
      activity: args.promptPreview,
      updatedAt: args.completedAt,
      lastPromptAt: args.startedAt,
      lastCompletedAt: args.completedAt,
      messageCount: nextMessageCount,
    });

    return {
      threadId: args.threadId,
      messageCount: nextMessageCount,
    };
  },
});

export const setThreadTitle = privateMutation({
  args: {
    threadId: v.string(),
    userId: v.string(),
    title: v.string(),
  },
  handler: async (ctx, args) => {
    const thread = await ctx.db
      .query("agentThreads")
      .withIndex("by_thread_id", (query: IndexRangeBuilder<Doc<"agentThreads">, ["threadId"]>) =>
        query.eq("threadId", args.threadId),
      )
      .unique();

    if (thread === null) {
      throw new Error("Thread not found.");
    }

    if (thread.userId !== args.userId) {
      throw new Error("Unauthorized thread access");
    }

    await ctx.db.patch(thread._id, {
      title: args.title,
      updatedAt: Date.now(),
    });

    return {
      threadId: args.threadId,
      title: args.title,
    };
  },
});

export const setThreadState = privateMutation({
  args: {
    threadId: v.string(),
    userId: v.string(),
    timestamp: v.number(),
    status: threadStatusValidator,
    activity: v.optional(v.string()),
    sandboxId: v.optional(v.string()),
    isMcp: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const thread = await ctx.db
      .query("agentThreads")
      .withIndex("by_thread_id", (query: IndexRangeBuilder<Doc<"agentThreads">, ["threadId"]>) =>
        query.eq("threadId", args.threadId),
      )
      .unique();

    if (thread !== null && thread.userId !== args.userId) {
      throw new Error("Unauthorized thread access");
    }

    if (thread === null) {
      await ctx.db.insert("agentThreads", {
        threadId: args.threadId,
        userId: args.userId,
        title: undefined,
        sandboxId: args.sandboxId,
        isMcp: args.isMcp ?? false,
        status: args.status,
        activity: args.activity,
        createdAt: args.timestamp,
        updatedAt: args.timestamp,
        lastPromptAt: args.timestamp,
        lastCompletedAt: args.status === "idle" ? args.timestamp : undefined,
        messageCount: 0,
      });

      return {
        threadId: args.threadId,
        status: args.status,
      };
    }

    await ctx.db.patch(thread._id, {
      sandboxId: args.sandboxId ?? thread.sandboxId,
      isMcp: thread.isMcp ?? args.isMcp ?? false,
      status: args.status,
      activity: args.activity,
      updatedAt: args.timestamp,
      lastPromptAt: args.status === "running" ? args.timestamp : thread.lastPromptAt,
      lastCompletedAt: args.status === "idle" ? args.timestamp : thread.lastCompletedAt,
    });

    return {
      threadId: args.threadId,
      status: args.status,
    };
  },
});
