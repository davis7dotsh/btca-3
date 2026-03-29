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

const getUserMessageCount = (messages: readonly Doc<"agentThreadMessages">[]) =>
  messages.filter((message) => message.role === "user").length;

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
    const attachments = await ctx.db
      .query("agentThreadAttachments")
      .withIndex(
        "by_thread_created_at",
        (query: IndexRangeBuilder<Doc<"agentThreadAttachments">, ["threadId", "createdAt"]>) =>
          query.eq("threadId", args.threadId),
      )
      .collect();

    return {
      thread: {
        threadId: thread.threadId,
        userId: thread.userId,
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
        userMessageCount: getUserMessageCount(messages),
      },
      messages: messages.map((message: Doc<"agentThreadMessages">) => ({
        sequence: message.sequence,
        role: message.role,
        timestamp: message.messageTimestamp ?? null,
        rawJson: message.rawJson,
      })),
      attachments: attachments
        .sort(
          (a: Doc<"agentThreadAttachments">, b: Doc<"agentThreadAttachments">) =>
            a.createdAt - b.createdAt,
        )
        .map((attachment: Doc<"agentThreadAttachments">) => ({
          id: attachment._id,
          threadId: attachment.threadId,
          messageSequence: attachment.messageSequence ?? null,
          status: attachment.status,
          fileKey: attachment.fileKey,
          ufsUrl: attachment.ufsUrl,
          fileName: attachment.fileName,
          fileSize: attachment.fileSize,
          mimeType: attachment.mimeType,
          createdAt: attachment.createdAt,
          updatedAt: attachment.updatedAt,
        })),
    };
  },
});

export const resolvePromptAttachments = privateQuery({
  args: {
    threadId: v.string(),
    userId: v.string(),
    attachmentIds: v.array(v.id("agentThreadAttachments")),
  },
  handler: async (ctx, args) => {
    const resolved = [];

    for (const attachmentId of args.attachmentIds) {
      const attachment = await ctx.db.get(attachmentId);

      if (attachment === null) {
        throw new Error("Attachment not found.");
      }

      if (attachment.userId !== args.userId || attachment.threadId !== args.threadId) {
        throw new Error("Unauthorized attachment access");
      }

      if (attachment.status !== "pending" || attachment.messageSequence !== undefined) {
        throw new Error("Attachment is no longer pending.");
      }

      resolved.push({
        id: attachment._id,
        threadId: attachment.threadId,
        messageSequence: null,
        status: attachment.status,
        fileKey: attachment.fileKey,
        ufsUrl: attachment.ufsUrl,
        fileName: attachment.fileName,
        fileSize: attachment.fileSize,
        mimeType: attachment.mimeType,
        createdAt: attachment.createdAt,
        updatedAt: attachment.updatedAt,
      });
    }

    return resolved;
  },
});

export const appendThreadMessages = privateMutation({
  args: {
    threadId: v.string(),
    userId: v.string(),
    sandboxId: v.string(),
    selectedModelId: v.string(),
    isMcp: v.optional(v.boolean()),
    startedAt: v.number(),
    completedAt: v.number(),
    promptPreview: v.string(),
    messages: v.array(storedMessageValidator),
    attachmentIds: v.optional(v.array(v.id("agentThreadAttachments"))),
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
        selectedModelId: args.selectedModelId,
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

    if (args.attachmentIds && args.attachmentIds.length > 0) {
      for (const attachmentId of args.attachmentIds) {
        const attachment = await ctx.db.get(attachmentId);

        if (attachment === null) {
          throw new Error("Attachment not found.");
        }

        if (attachment.userId !== args.userId || attachment.threadId !== args.threadId) {
          throw new Error("Unauthorized attachment access");
        }

        if (attachment.status !== "pending" || attachment.messageSequence !== undefined) {
          throw new Error("Attachment is no longer pending.");
        }

        await ctx.db.patch(attachment._id, {
          messageSequence: baseSequence,
          status: "attached",
          updatedAt: args.completedAt,
        });
      }
    }

    const nextMessageCount = baseSequence + args.messages.length;
    const latestThread = await ctx.db.get(threadRef);
    const nextTitle = latestThread?.title ?? thread?.title ?? args.promptPreview;

    await ctx.db.patch(threadRef, {
      title: nextTitle,
      sandboxId: args.sandboxId,
      selectedModelId: args.selectedModelId,
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

export const createPendingAttachment = privateMutation({
  args: {
    threadId: v.string(),
    userId: v.string(),
    fileKey: v.string(),
    ufsUrl: v.string(),
    fileName: v.string(),
    fileSize: v.number(),
    mimeType: v.string(),
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

    const now = Date.now();
    const attachmentId = await ctx.db.insert("agentThreadAttachments", {
      threadId: args.threadId,
      threadRef: thread._id,
      userId: args.userId,
      messageSequence: undefined,
      status: "pending",
      fileKey: args.fileKey,
      ufsUrl: args.ufsUrl,
      fileName: args.fileName,
      fileSize: args.fileSize,
      mimeType: args.mimeType,
      createdAt: now,
      updatedAt: now,
    });

    return {
      id: attachmentId,
      threadId: args.threadId,
      messageSequence: null,
      status: "pending" as const,
      fileKey: args.fileKey,
      ufsUrl: args.ufsUrl,
      fileName: args.fileName,
      fileSize: args.fileSize,
      mimeType: args.mimeType,
      createdAt: now,
      updatedAt: now,
    };
  },
});

export const removePendingAttachment = privateMutation({
  args: {
    attachmentId: v.id("agentThreadAttachments"),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const attachment = await ctx.db.get(args.attachmentId);

    if (attachment === null) {
      throw new Error("Attachment not found.");
    }

    if (attachment.userId !== args.userId) {
      throw new Error("Unauthorized attachment access");
    }

    if (attachment.status !== "pending" || attachment.messageSequence !== undefined) {
      throw new Error("Only pending attachments can be removed.");
    }

    await ctx.db.delete(attachment._id);

    return {
      attachmentId: attachment._id,
      fileKey: attachment.fileKey,
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
    selectedModelId: v.optional(v.string()),
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
        selectedModelId: args.selectedModelId,
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
      selectedModelId: args.selectedModelId ?? thread.selectedModelId,
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
