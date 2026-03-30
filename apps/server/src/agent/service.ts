import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  agentLoop,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
} from "@mariozechner/pi-agent-core";
import {
  Type,
  getModels,
  getProviders,
  type KnownProvider,
  type Message,
  type Model,
} from "@mariozechner/pi-ai";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";

import { instrumentPiEventStream } from "@contextcompany/pi";

import { AuthService } from "../auth/service.ts";
import { Config } from "../config.ts";
import { ResourcesService } from "../resources/service.ts";
import { WorkspaceService } from "../workspace/service.ts";
import { AgentThreadStore, parsePersistedMessages } from "./threads.ts";

const MAX_TOOL_TEXT_LENGTH = 20_000;

const BASE_PROMPT = `
You are btca, a local code and documentation research agent.

You operate inside a managed workspace on disk that already contains the resources you should search.

Rules:
- Prefer searching the workspace over answering from memory.
- Use shell tools like rg, find, ls, cat, sed, head, and tail.
- Stay inside the workspace.
- Cite workspace-relative file paths in your answer when useful.
- Keep the workspace tidy and avoid destructive commands.
`;

const readFileSchema = Type.Object({
  path: Type.String({
    description: "Path to a text file inside the workspace.",
  }),
  startLine: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Optional 1-based starting line.",
    }),
  ),
  endLine: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Optional 1-based ending line.",
    }),
  ),
});

const execCommandSchema = Type.Object({
  command: Type.String({
    description: "Shell command to run inside the workspace.",
  }),
  cwd: Type.Optional(
    Type.String({
      description: "Optional working directory inside the workspace.",
    }),
  ),
});

const truncateText = (value: string) =>
  value.length <= MAX_TOOL_TEXT_LENGTH
    ? value
    : `${value.slice(0, MAX_TOOL_TEXT_LENGTH)}\n\n[truncated]`;

const toTextResult = (text: string) => [
  {
    type: "text" as const,
    text,
  },
];

const extractTaggedResourceNames = (value: string) => {
  const matches = value.matchAll(/(^|[\s([{"'])@([a-zA-Z0-9][a-zA-Z0-9-]*)/g);
  const names = new Set<string>();

  for (const match of matches) {
    if (match[2]) {
      names.add(match[2]);
    }
  }

  return [...names];
};

const extractAssistantText = (message: Message | undefined) => {
  if (!message || message.role !== "assistant") {
    return "";
  }

  return message.content
    .flatMap((part) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n\n");
};

const KNOWN_PROVIDERS = new Set<string>(getProviders());

const isKnownProvider = (value: string): value is KnownProvider => KNOWN_PROVIDERS.has(value);

const resolveModel = (args: { modelId: string; provider: string; baseUrl?: string }) => {
  if (!isKnownProvider(args.provider)) {
    return undefined;
  }

  const model = getModels(args.provider).find((candidate) => candidate.id === args.modelId);

  if (!model) {
    return undefined;
  }

  const baseUrl = args.baseUrl?.trim();

  return {
    ...model,
    baseUrl: baseUrl && baseUrl.length > 0 ? baseUrl : model.baseUrl,
  } satisfies Model<typeof model.api>;
};

const getEventTimestamp = (event: AgentEvent) =>
  "timestamp" in event && typeof event.timestamp === "number" ? event.timestamp : Date.now();

const buildRunMetrics = (args: {
  priceUsd: number;
  totalToolCalls: number;
  outputTokens: number;
  generationDurationMs: number;
}) => {
  const generationDurationMs = args.generationDurationMs > 0 ? args.generationDurationMs : null;
  const outputTokensPerSecond =
    generationDurationMs === null || args.outputTokens <= 0
      ? null
      : args.outputTokens / (generationDurationMs / 1000);

  return {
    priceUsd: args.priceUsd,
    totalToolCalls: args.totalToolCalls,
    outputTokens: args.outputTokens,
    generationDurationMs,
    outputTokensPerSecond,
  } satisfies AgentRunMetrics;
};

const buildSystemPrompt = (workspaceDir: string) =>
  [
    BASE_PROMPT.trim(),
    "",
    `Workspace root: ${workspaceDir}`,
    `Resources manifest: ${path.join(workspaceDir, "meta", "resources.json")}`,
    `Workspace instructions: ${path.join(workspaceDir, "meta", "instructions.md")}`,
  ].join("\n");

const buildPromptPreview = (prompt: string) => {
  const normalized = prompt.trim().replace(/\s+/g, " ");
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 117)}...`;
};

export class AgentError extends Data.TaggedError("AgentError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

type AgentRunMetrics = {
  readonly priceUsd: number;
  readonly totalToolCalls: number;
  readonly outputTokens: number;
  readonly generationDurationMs: number | null;
  readonly outputTokensPerSecond: number | null;
};

type RunAgentResult = {
  readonly threadId: string;
  readonly workspaceDir: string;
  readonly provider: string;
  readonly modelId: string;
  readonly resourceNames: readonly string[];
  readonly answer: string;
  readonly messages: readonly AgentMessage[];
  readonly runMetrics: AgentRunMetrics | null;
};

type StreamAgentResult = {
  readonly threadId: string;
  readonly workspaceDir: string;
  readonly provider: string;
  readonly modelId: string;
  readonly resourceNames: readonly string[];
  readonly events: AsyncIterable<AgentEvent>;
};

type AgentServiceShape = {
  readonly run: (args: {
    threadId?: string;
    prompt: string;
    modelId?: string;
    resourceNames?: readonly string[];
    quiet?: boolean;
  }) => Effect.Effect<RunAgentResult, AgentError>;
  readonly askStream: (args: {
    threadId?: string;
    question: string;
    modelId?: string;
    resourceNames: readonly string[];
    quiet?: boolean;
  }) => Effect.Effect<StreamAgentResult, AgentError>;
};

export class AgentService extends ServiceMap.Service<AgentService, AgentServiceShape>()(
  "btca-server/AgentService",
) {
  static readonly layer = Layer.effect(
    AgentService,
    Effect.gen(function* () {
      const config = yield* Config;
      const auth = yield* AuthService;
      const resources = yield* ResourcesService;
      const workspace = yield* WorkspaceService;
      const threads = yield* AgentThreadStore;

      const createReadFileTool = (threadId: string) =>
        ({
          label: "Read File",
          name: "read_file",
          description: "Read a text file from the thread workspace.",
          parameters: readFileSchema,
          execute: async (_toolCallId, args) => {
            const result = await Effect.runPromise(
              workspace.readFile({
                threadId,
                path: args.path,
                startLine: args.startLine,
                endLine: args.endLine,
              }),
            );

            return {
              content: toTextResult(truncateText(result.content)),
              details: result,
            };
          },
        }) satisfies AgentTool<typeof readFileSchema, { path: string; content: string }>;

      const createExecCommandTool = (threadId: string) =>
        ({
          label: "Exec Command",
          name: "exec_command",
          description: "Run a shell command inside the thread workspace.",
          parameters: execCommandSchema,
          execute: async (_toolCallId, args) => {
            const result = await Effect.runPromise(
              workspace.execCommand({
                threadId,
                command: args.command,
                cwd: args.cwd,
              }),
            );

            return {
              content: toTextResult(
                truncateText(
                  [
                    `exit_code=${result.exitCode}`,
                    result.stdout ? `stdout:\n${result.stdout}` : "",
                    result.stderr ? `stderr:\n${result.stderr}` : "",
                  ]
                    .filter(Boolean)
                    .join("\n\n"),
                ),
              ),
              details: result,
            };
          },
        }) satisfies AgentTool<
          typeof execCommandSchema,
          {
            command: string;
            cwd: string;
            exitCode: number;
            stdout: string;
            stderr: string;
          }
        >;

      const updateThreadState = (args: {
        threadId: string;
        status: "idle" | "running" | "error";
        activity?: string | null;
        workspaceDir?: string | null;
        modelId?: string | null;
        provider?: string | null;
        resourceNames?: readonly string[];
      }) =>
        threads.setThreadState(args).pipe(
          Effect.mapError(
            (cause) =>
              new AgentError({
                message: `Failed to update thread "${args.threadId}".`,
                cause,
              }),
          ),
        );

      const prepareAgentRun = (args: {
        threadId?: string;
        prompt: string;
        modelId?: string;
        resourceNames?: readonly string[];
        quiet?: boolean;
      }) =>
        Effect.gen(function* () {
          const trimmedPrompt = args.prompt.trim();

          if (trimmedPrompt.length === 0) {
            return yield* Effect.fail(
              new AgentError({
                message: "Prompt must not be empty.",
              }),
            );
          }

          const resolvedThreadId = args.threadId?.trim() || randomUUID();
          const configuredModel = yield* config.getModel;
          const selectedModelId = args.modelId?.trim() || configuredModel.model;
          const preview = buildPromptPreview(trimmedPrompt);
          const taggedResourceNames = extractTaggedResourceNames(trimmedPrompt);
          const configuredResources = yield* resources.listConfiguredResources;
          const selectedResourceNames =
            args.resourceNames && args.resourceNames.length > 0
              ? [...args.resourceNames]
              : taggedResourceNames.length > 0
                ? taggedResourceNames
                : configuredResources.map((resource) => resource.name);

          yield* updateThreadState({
            threadId: resolvedThreadId,
            status: "running",
            activity: preview,
          });

          if (args.quiet !== true) {
            console.debug("Agent resources starting to load", {
              threadId: resolvedThreadId,
              resourceNames: selectedResourceNames,
            });
          }

          const loadedResources = yield* resources.loadMany(selectedResourceNames).pipe(
            Effect.mapError(
              (cause) =>
                new AgentError({
                  message: "Failed to load the requested resources.",
                  cause,
                }),
            ),
          );

          if (args.quiet !== true) {
            console.debug("Agent resources loaded", {
              threadId: resolvedThreadId,
              resourceCount: loadedResources.length,
              resourceNames: loadedResources.map((resource) => resource.name),
            });
          }

          const preparedWorkspace = yield* workspace
            .prepareThreadWorkspace({
              threadId: resolvedThreadId,
              resources: loadedResources,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new AgentError({
                    message: "Failed to prepare the workspace.",
                    cause,
                  }),
              ),
            );

          const modelAuth = yield* auth
            .requireModelAuth({
              provider: configuredModel.provider,
              modelId: selectedModelId,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new AgentError({
                    message: "Failed to resolve provider authentication.",
                    cause,
                  }),
              ),
            );

          yield* updateThreadState({
            threadId: resolvedThreadId,
            status: "running",
            activity: preview,
            workspaceDir: preparedWorkspace.workspaceRoot,
            modelId: selectedModelId,
            provider: modelAuth.provider,
          });

          const persistedThread = yield* threads.loadThread(resolvedThreadId).pipe(
            Effect.mapError(
              (cause) =>
                new AgentError({
                  message: "Failed to load thread history.",
                  cause,
                }),
            ),
          );
          const persistedMessages = yield* parsePersistedMessages(persistedThread).pipe(
            Effect.mapError(
              (cause) =>
                new AgentError({
                  message: "Failed to parse thread history.",
                  cause,
                }),
            ),
          );

          const initialMessages: AgentMessage[] = [
            {
              role: "user",
              content: trimmedPrompt,
              timestamp: Date.now(),
            },
          ];

          const resolvedModel = resolveModel({
            modelId: selectedModelId,
            provider: modelAuth.provider,
            baseUrl: modelAuth.baseUrl,
          });

          if (!resolvedModel) {
            return yield* Effect.fail(
              new AgentError({
                message: `Unsupported model "${selectedModelId}" for provider "${modelAuth.provider}".`,
              }),
            );
          }

          const rawEvents = agentLoop(
            initialMessages,
            {
              systemPrompt: buildSystemPrompt(preparedWorkspace.workspaceRoot),
              messages: persistedMessages,
              tools: [
                createReadFileTool(resolvedThreadId),
                createExecCommandTool(resolvedThreadId),
              ],
            },
            {
              model: resolvedModel,
              sessionId: resolvedThreadId,
              getApiKey: () => modelAuth.token,
              convertToLlm: (messages) =>
                messages.filter(
                  (message) =>
                    message.role === "user" ||
                    message.role === "assistant" ||
                    message.role === "toolResult",
                ),
            },
          );

          return {
            threadId: resolvedThreadId,
            prompt: trimmedPrompt,
            preview,
            modelId: selectedModelId,
            provider: modelAuth.provider,
            resourceNames: selectedResourceNames,
            workspaceDir: preparedWorkspace.workspaceRoot,
            rawEvents,
          };
        });

      const createManagedEventStream = (args: {
        threadId: string;
        preview: string;
        modelId: string;
        provider: string;
        resourceNames: readonly string[];
        workspaceDir: string;
        rawEvents: AsyncIterable<AgentEvent>;
      }) =>
        (async function* () {
          let finalMessages: AgentMessage[] | null = null;
          let runMetrics: AgentRunMetrics | null = null;
          const toolCallIds = new Set<string>();
          let activeAssistantGenerationStartedAt: number | null = null;
          let assistantGenerationDurationMs = 0;
          let assistantOutputTokens = 0;

          try {
            const instrumentedEvents = instrumentPiEventStream(args.rawEvents, {
              sessionId: args.threadId,
              metadata: {
                provider: args.provider,
                modelId: args.modelId,
                resourceNames: args.resourceNames,
              },
            });

            for await (const event of instrumentedEvents) {
              const eventTimestamp = getEventTimestamp(event);

              if (event.type === "tool_execution_start") {
                toolCallIds.add(event.toolCallId);
              }

              if (event.type === "message_start" && event.message.role === "assistant") {
                activeAssistantGenerationStartedAt = eventTimestamp;
              }

              if (event.type === "message_end" && event.message.role === "assistant") {
                if (activeAssistantGenerationStartedAt !== null) {
                  assistantGenerationDurationMs += Math.max(
                    0,
                    eventTimestamp - activeAssistantGenerationStartedAt,
                  );
                  activeAssistantGenerationStartedAt = null;
                }

                assistantOutputTokens += event.message.usage.output;
              }

              if (event.type === "agent_end") {
                runMetrics = buildRunMetrics({
                  priceUsd: event.messages.reduce(
                    (total, message) =>
                      message.role === "assistant" ? total + message.usage.cost.total : total,
                    0,
                  ),
                  totalToolCalls: toolCallIds.size,
                  outputTokens: assistantOutputTokens,
                  generationDurationMs: assistantGenerationDurationMs,
                });

                const finalAssistantIndex = [...event.messages]
                  .map((message, index) => ({ message, index }))
                  .reverse()
                  .find(({ message }) => message.role === "assistant")?.index;

                finalMessages = event.messages.map((message, index) =>
                  finalAssistantIndex === index && message.role === "assistant"
                    ? ({ ...message, runMetrics } as AgentMessage)
                    : message,
                );

                yield { ...event, messages: finalMessages, runMetrics } as AgentEvent;
                continue;
              }

              yield event;
            }

            if (finalMessages === null) {
              await Effect.runPromise(
                updateThreadState({
                  threadId: args.threadId,
                  status: "error",
                  activity: args.preview,
                  workspaceDir: args.workspaceDir,
                  modelId: args.modelId,
                  provider: args.provider,
                  resourceNames: args.resourceNames,
                }),
              );
              throw new AgentError({
                message: "The agent run finished without returning final messages.",
              });
            }

            await Effect.runPromise(
              threads
                .appendMessages({
                  threadId: args.threadId,
                  messages: finalMessages.filter(
                    (message): message is Message =>
                      message.role === "user" ||
                      message.role === "assistant" ||
                      message.role === "toolResult",
                  ),
                  workspaceDir: args.workspaceDir,
                  provider: args.provider,
                  modelId: args.modelId,
                  resourceNames: args.resourceNames,
                })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new AgentError({
                        message: "Failed to persist the thread messages.",
                        cause,
                      }),
                  ),
                ),
            );

            await Effect.runPromise(
              updateThreadState({
                threadId: args.threadId,
                status: "idle",
                activity: args.preview,
                workspaceDir: args.workspaceDir,
                modelId: args.modelId,
                provider: args.provider,
                resourceNames: args.resourceNames,
              }),
            );
          } catch (cause) {
            await Effect.runPromise(
              updateThreadState({
                threadId: args.threadId,
                status: "error",
                activity: args.preview,
                workspaceDir: args.workspaceDir,
                modelId: args.modelId,
                provider: args.provider,
                resourceNames: args.resourceNames,
              }).pipe(Effect.orElseSucceed(() => undefined)),
            );

            throw cause;
          }
        })();

      return {
        run: ({ threadId, prompt, modelId, resourceNames, quiet }) =>
          Effect.gen(function* () {
            const prepared = yield* prepareAgentRun({
              threadId,
              prompt,
              modelId,
              resourceNames,
              quiet,
            });

            const finalMessages = yield* Effect.tryPromise({
              try: async () => {
                let messages: AgentMessage[] | null = null;

                for await (const event of createManagedEventStream({
                  threadId: prepared.threadId,
                  preview: prepared.preview,
                  modelId: prepared.modelId,
                  provider: prepared.provider,
                  resourceNames: prepared.resourceNames,
                  workspaceDir: prepared.workspaceDir,
                  rawEvents: prepared.rawEvents,
                })) {
                  if (event.type === "agent_end") {
                    messages = event.messages;
                  }
                }

                return messages;
              },
              catch: (cause) =>
                new AgentError({
                  message: "The agent run failed.",
                  cause,
                }),
            });

            if (finalMessages === null) {
              return yield* Effect.fail(
                new AgentError({
                  message: "The agent run finished without returning final messages.",
                }),
              );
            }

            const answer = extractAssistantText(
              [...finalMessages]
                .reverse()
                .find((message): message is Message => message.role === "assistant"),
            );
            const finalRunMetrics =
              [...finalMessages]
                .reverse()
                .find(
                  (message): message is Message & { runMetrics?: AgentRunMetrics } =>
                    message.role === "assistant",
                )?.runMetrics ?? null;

            return {
              threadId: prepared.threadId,
              workspaceDir: prepared.workspaceDir,
              provider: prepared.provider,
              modelId: prepared.modelId,
              resourceNames: prepared.resourceNames,
              answer,
              messages: finalMessages,
              runMetrics: finalRunMetrics,
            } satisfies RunAgentResult;
          }),
        askStream: ({ threadId, question, modelId, resourceNames, quiet }) =>
          Effect.gen(function* () {
            if (resourceNames.length === 0) {
              return yield* Effect.fail(
                new AgentError({
                  message: "At least one resource name is required.",
                }),
              );
            }

            const prepared = yield* prepareAgentRun({
              threadId,
              prompt: question,
              modelId,
              resourceNames,
              quiet,
            });

            return {
              threadId: prepared.threadId,
              workspaceDir: prepared.workspaceDir,
              provider: prepared.provider,
              modelId: prepared.modelId,
              resourceNames: prepared.resourceNames,
              events: createManagedEventStream({
                threadId: prepared.threadId,
                preview: prepared.preview,
                modelId: prepared.modelId,
                provider: prepared.provider,
                resourceNames: prepared.resourceNames,
                workspaceDir: prepared.workspaceDir,
                rawEvents: prepared.rawEvents,
              }),
            } satisfies StreamAgentResult;
          }),
      } satisfies AgentServiceShape;
    }),
  );
}
