import { randomUUID } from "node:crypto";
import { api } from "@btca/convex/api";
import type { Chunk } from "@upstash/box";
import type { Usage } from "@mariozechner/pi-ai";
import { Cause, Effect, Layer, ServiceMap } from "effect";
import type { AgentModelOption } from "$lib/models";
import { getAgentModel } from "$lib/models";
import { buildTaggedResourcesXml, extractTaggedResourceSlugs } from "$lib/resources";
import { runtime } from "$lib/runtime";
import type { AgentPromptStreamEvent, StoredAgentThreadContext } from "$lib/types/agent";
import type { TaggedResourcePromptResource } from "$lib/types/resources";
import {
  BOX_AGENT_RUN_TIMEOUT_MS,
  BOX_CODEX_MODEL,
  BoxService,
  type BoxDef,
  type BoxServiceError,
  buildBoxThreadAgentPrompt,
} from "./box";
import { ConvexError, ConvexPrivateService, type ConvexPrivateBridge } from "./convex";
import {
  generateThreadTitle,
  getErrorMessage,
  getPromptPreview,
  getThreadTitleSourcePromptFromStored,
  persistGeneratedThreadTitle,
} from "./threadTitle";

const BOX_TOOL_RESULT_NOTE =
  "Upstash Box streams tool invocation arguments, but it does not expose per-tool result payloads to this chat UI.";

export interface BoxThreadChatInput {
  readonly threadId: string;
  readonly userId: string;
  readonly prompt: string;
  readonly modelId?: string;
}

export interface BoxThreadChatStream {
  readonly threadId: string;
  readonly sandboxId: string;
  readonly model: AgentModelOption;
  readonly events: AsyncIterable<AgentPromptStreamEvent>;
}

interface BoxThreadChatDef {
  promptThreadBox: (
    input: BoxThreadChatInput,
  ) => Effect.Effect<
    BoxThreadChatStream,
    BoxServiceError | ConvexError,
    BoxService | ConvexPrivateService
  >;
}

const usageFromBoxTokens = (inputTokens: number, outputTokens: number): Usage => ({
  input: inputTokens,
  output: outputTokens,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: inputTokens + outputTokens,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
});

interface ActiveBoxToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
}

function mapChunkToStreamEvents(chunk: Chunk): AgentPromptStreamEvent[] {
  const timestamp = Date.now();

  switch (chunk.type) {
    case "text-delta":
      return [
        {
          type: "assistant_text_delta",
          delta: chunk.text,
          usage: null,
          timestamp,
        },
      ];
    case "reasoning":
      return [
        {
          type: "assistant_text_delta",
          delta: chunk.text,
          usage: null,
          timestamp,
        },
      ];
    default:
      return [];
  }
}

const createBoxToolCallStartEvent = (
  chunk: Extract<Chunk, { type: "tool-call" }>,
): {
  readonly event: AgentPromptStreamEvent;
  readonly activeToolCall: ActiveBoxToolCall;
} => {
  const timestamp = Date.now();
  const toolCallId = randomUUID();

  return {
    event: {
      type: "tool_call_start",
      toolType: "unknown",
      toolName: chunk.toolName,
      toolCallId,
      args: chunk.input,
      timestamp,
    },
    activeToolCall: {
      toolCallId,
      toolName: chunk.toolName,
      input: chunk.input,
    },
  };
};

const createBoxToolCallEndEvent = (
  toolCall: ActiveBoxToolCall,
  timestamp = Date.now(),
): AgentPromptStreamEvent => ({
  type: "tool_call_end",
  toolType: "unknown",
  toolName: toolCall.toolName,
  toolCallId: toolCall.toolCallId,
  isError: false,
  content: BOX_TOOL_RESULT_NOTE,
  details: {
    note: BOX_TOOL_RESULT_NOTE,
    input: toolCall.input,
  },
  timestamp,
  excludeFromPersistedCount: true,
});

function createBoxThreadChatEventIterable(params: {
  input: BoxThreadChatInput;
  convex: Pick<ConvexPrivateBridge, "query" | "mutation">;
  box: BoxDef;
  markThreadError: (error: unknown) => Effect.Effect<void, never, never>;
  streamModel: AgentModelOption;
}): AsyncIterable<AgentPromptStreamEvent> {
  const { input, convex, box, markThreadError, streamModel } = params;

  return (async function* (): AsyncGenerator<AgentPromptStreamEvent> {
    const promptPreview = getPromptPreview(input.prompt);
    const runStartedAt = Date.now();
    const activeToolCalls: ActiveBoxToolCall[] = [];

    try {
      await runtime.runPromise(
        convex.mutation({
          func: api.private.agentThreads.setThreadState,
          args: {
            threadId: input.threadId,
            userId: input.userId,
            timestamp: runStartedAt,
            status: "running",
            activity: promptPreview,
            isMcp: false,
          },
        }),
      );

      const persistedThread: StoredAgentThreadContext | null = await runtime.runPromise(
        convex.query({
          func: api.private.agentThreads.getThreadContext,
          args: {
            threadId: input.threadId,
            userId: input.userId,
          },
        }),
      );

      const taggedResourceSlugs = extractTaggedResourceSlugs(input.prompt);
      const taggedResources: TaggedResourcePromptResource[] =
        taggedResourceSlugs.length === 0
          ? []
          : await runtime.runPromise(
              convex.query({
                func: api.private.resources.getTaggedResources,
                args: {
                  userId: input.userId,
                  slugs: taggedResourceSlugs,
                },
              }),
            );

      const resourceXml =
        taggedResources.length === 0 ? undefined : buildTaggedResourcesXml(taggedResources);

      const shouldGenerateThreadTitle =
        persistedThread?.thread.title === null || persistedThread === null;
      const titleSourcePrompt = getThreadTitleSourcePromptFromStored(
        persistedThread?.messages ?? [],
        input.prompt,
      );

      if (shouldGenerateThreadTitle) {
        void runtime
          .runPromise(
            generateThreadTitle(input.threadId, titleSourcePrompt).pipe(
              Effect.flatMap((generatedThreadTitle) =>
                persistGeneratedThreadTitle({
                  setThreadTitle: (title) =>
                    convex.mutation({
                      func: api.private.agentThreads.setThreadTitle,
                      args: {
                        threadId: input.threadId,
                        userId: input.userId,
                        title,
                      },
                    }),
                  threadId: input.threadId,
                  title: generatedThreadTitle,
                }),
              ),
              Effect.catchCause((cause) =>
                Effect.sync(() => {
                  console.error("Failed to persist thread title in background", {
                    threadId: input.threadId,
                    error: getErrorMessage(Cause.squash(cause)),
                  });
                }),
              ),
            ),
          )
          .catch(() => {});
      }

      const existingBoxId = persistedThread?.thread.sandboxId ?? undefined;

      const prepared = await runtime.runPromise(
        box.ensureThreadBox({
          threadId: input.threadId,
          boxId: existingBoxId,
        }),
      );

      await prepared.box.configureModel(BOX_CODEX_MODEL);

      const fullPrompt = buildBoxThreadAgentPrompt(input.prompt, resourceXml);

      yield {
        type: "ready",
        threadId: input.threadId,
        sandboxId: prepared.box.id,
        model: streamModel,
        timestamp: Date.now(),
      };

      const streamRun = await prepared.box.agent.stream({
        prompt: fullPrompt,
        timeout: BOX_AGENT_RUN_TIMEOUT_MS,
        onToolUse: (tool) => {
          console.log("Box tool call", {
            threadId: input.threadId,
            boxId: prepared.box.id,
            toolName: tool.name,
            input: tool.input,
          });
        },
      });

      for await (const chunk of streamRun) {
        if (chunk.type === "tool-call") {
          const { event, activeToolCall } = createBoxToolCallStartEvent(chunk);
          activeToolCalls.push(activeToolCall);
          yield event;
          continue;
        }

        if (chunk.type === "finish") {
          const finishedAt = Date.now();

          while (activeToolCalls.length > 0) {
            const activeToolCall = activeToolCalls.shift();

            if (activeToolCall) {
              yield createBoxToolCallEndEvent(activeToolCall, finishedAt);
            }
          }

          continue;
        }

        for (const streamEvent of mapChunkToStreamEvents(chunk)) {
          yield streamEvent;
        }
      }

      if (activeToolCalls.length > 0) {
        const finishedAt = Date.now();

        while (activeToolCalls.length > 0) {
          const activeToolCall = activeToolCalls.shift();

          if (activeToolCall) {
            yield createBoxToolCallEndEvent(activeToolCall, finishedAt);
          }
        }
      }

      const output = streamRun.result.trim();
      const usage = usageFromBoxTokens(streamRun.cost.inputTokens, streamRun.cost.outputTokens);
      const completedAt = Date.now();
      const selectedModel = getAgentModel(input.modelId);

      const userMessage = {
        role: "user" as const,
        content: input.prompt,
        timestamp: runStartedAt,
      };

      const assistantMessage = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: output }],
        api: selectedModel.model.api,
        provider: selectedModel.model.provider,
        model: selectedModel.model.id,
        usage,
        stopReason: "stop" as const,
        timestamp: completedAt,
      };

      await runtime.runPromise(
        convex.mutation({
          func: api.private.agentThreads.appendThreadMessages,
          args: {
            threadId: input.threadId,
            userId: input.userId,
            sandboxId: prepared.box.id,
            isMcp: false,
            startedAt: runStartedAt,
            completedAt,
            promptPreview,
            messages: [
              {
                role: "user",
                timestamp: userMessage.timestamp,
                rawJson: JSON.stringify(userMessage),
              },
              {
                role: "assistant",
                timestamp: assistantMessage.timestamp,
                rawJson: JSON.stringify(assistantMessage),
              },
            ],
          },
        }),
      );

      yield {
        type: "assistant_message",
        content: output,
        usage,
        api: assistantMessage.api,
        provider: assistantMessage.provider,
        model: assistantMessage.model,
        timestamp: completedAt,
      };

      yield { type: "done", timestamp: Date.now() };

      console.log("Box run finished", {
        threadId: input.threadId,
        boxId: prepared.box.id,
        runId: streamRun.id,
        status: streamRun.status,
        inputTokens: streamRun.cost.inputTokens,
        outputTokens: streamRun.cost.outputTokens,
        outputLength: output.length,
      });

      try {
        const logs = await streamRun.logs();
        for (const entry of logs) {
          console.log("Box run log", {
            threadId: input.threadId,
            boxId: prepared.box.id,
            level: entry.level,
            message: entry.message,
            timestamp: entry.timestamp,
          });
        }
      } catch (error) {
        console.warn("Failed to fetch Box run logs", {
          threadId: input.threadId,
          boxId: prepared.box.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } catch (error) {
      await runtime.runPromise(markThreadError(error));
      throw error;
    }
  })();
}

export class BoxThreadChatService extends ServiceMap.Service<
  BoxThreadChatService,
  BoxThreadChatDef
>()("BoxThreadChatService") {
  static readonly layer = Layer.sync(BoxThreadChatService, () => {
    const promptThreadBox: BoxThreadChatDef["promptThreadBox"] = (input) =>
      Effect.gen(function* () {
        const convex = yield* ConvexPrivateService;
        const box = yield* BoxService;

        const markThreadError = (error: unknown) =>
          convex
            .mutation({
              func: api.private.agentThreads.setThreadState,
              args: {
                threadId: input.threadId,
                userId: input.userId,
                timestamp: Date.now(),
                status: "error",
                activity: getErrorMessage(error),
                isMcp: false,
              },
            })
            .pipe(Effect.catchCause(() => Effect.void));

        const selectedModel = getAgentModel(input.modelId);
        const streamModel = {
          id: selectedModel.id,
          label: selectedModel.label,
          description: selectedModel.description,
          pricingConfigured: selectedModel.pricingConfigured,
          provider: selectedModel.model.provider,
          api: selectedModel.model.api,
          modelId: selectedModel.model.id,
        } satisfies AgentModelOption;

        const events = createBoxThreadChatEventIterable({
          input,
          convex,
          box,
          markThreadError,
          streamModel,
        });

        return {
          threadId: input.threadId,
          sandboxId: "",
          model: streamModel,
          events,
        } satisfies BoxThreadChatStream;
      });

    return {
      promptThreadBox,
    };
  });
}
