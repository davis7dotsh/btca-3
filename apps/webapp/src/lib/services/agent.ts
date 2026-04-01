import { OPENCODE_API_KEY, TCC_API_KEY } from "$env/static/private";
import { instrumentPiEventStream } from "@contextcompany/pi";
import {
  agentLoop,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentMessage,
  type AgentTool,
} from "@mariozechner/pi-agent-core";
import {
  getEnvApiKey,
  type Api,
  type AssistantMessage,
  type ImageContent,
  type Message,
  type Model,
  type Usage,
} from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { Id } from "@btca/convex/data-model";
import { Cause, Data, Effect, Layer, ServiceMap } from "effect";
import { api } from "@btca/convex/api";
import {
  addUsd,
  calculateExaContentCostUsd,
  calculateExaSearchCostUsd,
  createEmptyTurnCostBreakdown,
} from "$lib/billing/usage";
import { defaultAgentModelId, getAgentModel } from "$lib/models";
import { buildTaggedResourcesXml, extractTaggedResourceNames } from "$lib/resources";
import type {
  AgentRunMetrics,
  AgentPromptResult,
  PromptThreadAgentRequestInput,
  PromptThreadAgentStream,
  PromptThreadAgentInput,
  SandboxExecuteCommandResult,
  SandboxReadFileResult,
  StoredAgentThreadContext,
  StoredAgentThreadAttachment,
  StoredAgentThreadMessage,
} from "$lib/types/agent";
import { isPersistableAgentMessage } from "$lib/types/agent";
import type { TaggedResourcePromptResource } from "$lib/types/resources";
import { AutumnService } from "./autumn";
import { BoxService, BoxServiceError } from "./box";
import { ConvexError, ConvexPrivateService } from "./convex";
import {
  EXA_DATE_PATTERN,
  type ExaDef,
  type ExaGetWebContentInput,
  type ExaGetWebContentResult,
  type ExaSearchWebInput,
  type ExaSearchWebResult,
  ExaService,
  ExaServiceError,
  WEB_CONTENT_MAX_CHARACTERS,
} from "./exa";
import { RunControlService, RunKilledError } from "./runControl";
import {
  generateThreadTitle,
  getErrorMessage,
  getPromptPreview,
  getThreadTitleSourcePrompt,
  persistGeneratedThreadTitle,
} from "./threadTitle";

export class AgentError extends Data.TaggedError("AgentError")<{
  readonly message: string;
  readonly kind: string;
  readonly traceId: string;
  readonly timestamp: number;
  readonly operation: "promptThread";
  readonly cause?: unknown;
}> {}

const readFileSchema = Type.Object({
  path: Type.String({
    description: "Path to the text file inside the sandbox for the current thread.",
  }),
  startLine: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Optional 1-based starting line to read from the file.",
    }),
  ),
  endLine: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Optional 1-based ending line to read from the file.",
    }),
  ),
});

const execCommandSchema = Type.Object({
  command: Type.String({
    description: "Shell command to run inside the sandbox for the current thread.",
  }),
  cwd: Type.Optional(
    Type.String({
      description: "Optional working directory for the command.",
    }),
  ),
});

const searchWebSchema = Type.Object({
  query: Type.String({
    minLength: 2,
    description:
      "Search query for finding relevant web pages. Be specific enough to surface the right sources.",
  }),
  numResults: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 10,
      description: "Optional number of search results to return.",
    }),
  ),
  includeDomains: Type.Optional(
    Type.Array(Type.String(), {
      maxItems: 10,
      description: "Optional list of domains to include in the search.",
    }),
  ),
  excludeDomains: Type.Optional(
    Type.Array(Type.String(), {
      maxItems: 10,
      description: "Optional list of domains to exclude from the search.",
    }),
  ),
  startPublishedDate: Type.Optional(
    Type.String({
      pattern: EXA_DATE_PATTERN,
      description: "Optional start date filter in YYYY-MM-DD format.",
    }),
  ),
  endPublishedDate: Type.Optional(
    Type.String({
      pattern: EXA_DATE_PATTERN,
      description: "Optional end date filter in YYYY-MM-DD format.",
    }),
  ),
});

const getWebContentSchema = Type.Object({
  urls: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    maxItems: 10,
    description: "One or more URLs to expand into readable web content.",
  }),
  maxCharacters: Type.Optional(
    Type.Integer({
      minimum: 500,
      maximum: WEB_CONTENT_MAX_CHARACTERS,
      description:
        "Optional maximum amount of text to fetch per URL. Must be 6000 or less; omit it if you do not need a custom size.",
    }),
  ),
  summary: Type.Optional(
    Type.Boolean({
      description: "Whether Exa should return a generated summary for each URL.",
    }),
  ),
  highlightsQuery: Type.Optional(
    Type.String({
      description: "Optional query for extracting focused highlights from each page.",
    }),
  ),
  maxAgeHours: Type.Optional(
    Type.Integer({
      minimum: -1,
      maximum: 24 * 365,
      description: "Optional recency bound for the content fetch in hours.",
    }),
  ),
});

const BASE_PROMPT = `
You are btca, an expert research agent. Your job is to answer questions from the user with the tools at your disposal.

You have access to a sandbox where you can clone git repos, install npm packages, run shell commands, execute Python, search the web, and read files.

When executing python code, keep the code very simple and fast. It is being executed in a sandbox with limited resources, prefer normal shell commands over python code whenever possible.

Use this ability to answer the user's question.

<resources_contract>
- Tool use order: git, npm, then web search. Always start with git or npm if possible, move on to web search only if necessary.
- Use "__WORKSPACE_DIR__" as the working directory for everything
- Clone repos and create fake npm projects to clone/explore packages from within "__WORKSPACE_DIR__"
- You are free to organize the workspace as you see fit, but keep it tidy and easy to navigate
- If you are searching in a github repo, do not try and get blobs directly from github.com. Clone and search the repo instead.
</resources_contract>

<personality_and_writing_controls>
- Persona: an expert professional researcher
- Channel: internal
- Emotional register: direct, calm, and concise
- Formatting: bulleted/numbered lists are good + codeblocks
- Length: be thorough with your response, don't let it get too long though
- Default follow-through: don't ask permission to do the research, just do it and answer the question. ask for clarifications + suggest good follow up if needed
- When you are about to do a set of tool calls, output a very concise explanation of what you are going to do and why.
</personality_and_writing_controls>

<parallel_tool_calling>
- When multiple retrieval or lookup steps are independent, prefer parallel tool calls to reduce wall-clock time.
- Do not parallelize steps that have prerequisite dependencies or where one result determines the next action.
- After parallel retrieval, pause to synthesize the results before making more calls.
- Prefer selective parallelism: parallelize independent evidence gathering, not speculative or redundant tool use.
</parallel_tool_calling>

<web_research_guidance>
- Use searchWeb to find candidate sources with lightweight metadata.
- Use getWebContent to expand the most relevant URLs into readable content.
- If the user gives a specific URL, you can skip searchWeb and go straight to getWebContent.
- If you set getWebContent.maxCharacters, it must be 6000 or less. Prefer omitting it unless you need a specific smaller limit.
- When a git or npm resource is available, use it to answer the question
- Keep the number of web searches to a minimum, be very precise with your queries and don't overuse the tool
</web_research_guidance>

<tool_persistence_rules>
- Use tools whenever they materially improve correctness, completeness, or grounding.
- Do NOT stop early to save tool calls.
- Keep calling tools until either:
	1) the task is complete
	2) you've hit a doom loop where none of the tools function or something is missing
- If a tool returns empty/partial results, retry with a different strategy (query, filters, alternate source).
</tool_persistence_rules>

<completeness_contract>
- Treat the task as incomplete until you have a complete answer to the user's question that's grounded
- If any item is blocked by missing data, mark it [blocked] and state exactly what is missing.
</completeness_contract>

<dig_deeper_nudge>
- Don't stop at the first plausible answer.
- Look for second-order issues, edge cases, and missing constraints.
</dig_deeper_nudge>

<output_contract>
- Return a thorough answer to the user's question with real code examples
- Always output in proper markdown format
- Always include sources for your answer:
	- For git resources, source links must be full github blob urls
	- In "Sources", format git citations as markdown links: - [repo/relative/path.ext](https://github.com/.../blob/.../repo/relative/path.ext)".'
	- For local resources cite local file paths
	- For npm resources cite the path in the npm package
</output_contract>
`;

const buildBasePrompt = (workspaceDir: string) =>
  BASE_PROMPT.replaceAll("__WORKSPACE_DIR__", workspaceDir);

const TCC_PROD_BASE_URL = "https://api.thecontext.company";
const TCC_DEV_BASE_URL = "https://dev.thecontext.company";

const resolveTccEndpoint = (apiKey: string) =>
  apiKey.startsWith("dev_") ? TCC_DEV_BASE_URL : TCC_PROD_BASE_URL;

const getSerializedSizeBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

type SandboxServiceError = BoxServiceError;
type ToolCallArguments = Record<string, unknown> | string | null | undefined;

interface AgentDef {
  promptThread: (
    input: PromptThreadAgentInput,
  ) => Effect.Effect<
    PromptThreadAgentStream,
    SandboxServiceError | ExaServiceError | AgentError | ConvexError | RunKilledError,
    BoxService | ConvexPrivateService | ExaService | AutumnService | RunControlService
  >;
}

interface SandboxAdapter {
  readonly providerLabel: string;
  readonly defaultModelId?: string;
  readonly resolve: () => Effect.Effect<ResolvedSandboxAdapter, SandboxServiceError, BoxService>;
}

interface ResolvedSandboxAdapter {
  readonly providerLabel: string;
  readonly defaultModelId?: string;
  readonly workspaceDir: string;
  readonly ensureThreadSandbox: (
    threadId: string,
    boxId?: string,
  ) => Effect.Effect<{ id: string }, SandboxServiceError>;
  readonly readFile: (input: {
    threadId: string;
    boxId?: string;
    path: string;
    startLine?: number;
    endLine?: number;
  }) => Effect.Effect<SandboxReadFileResult, SandboxServiceError>;
  readonly executeCommand: (input: {
    threadId: string;
    boxId?: string;
    command: string;
    cwd?: string;
  }) => Effect.Effect<SandboxExecuteCommandResult, SandboxServiceError>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseToolCallArguments = (value: ToolCallArguments) => {
  if (typeof value !== "string") {
    return isRecord(value) ? value : null;
  }

  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const toExaSearchInput = (value: ToolCallArguments): ExaSearchWebInput | null => {
  const parsed = parseToolCallArguments(value);
  return parsed && typeof parsed.query === "string"
    ? (parsed as unknown as ExaSearchWebInput)
    : null;
};

const toExaGetWebContentInput = (value: ToolCallArguments): ExaGetWebContentInput | null => {
  const parsed = parseToolCallArguments(value);
  return parsed && Array.isArray(parsed.urls) ? (parsed as unknown as ExaGetWebContentInput) : null;
};

const serializeMessageContent = (content: unknown) => {
  if (content === undefined) {
    return null;
  }

  if (typeof content === "string") {
    return content;
  }

  return JSON.stringify(content);
};

const toTextResult = (text: string) => [
  {
    type: "text" as const,
    text,
  },
];

const truncateText = (value: string, maxLength = 20_000) =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n\n[truncated]`;

const buildSystemPrompt = (
  workspaceDir: string,
  taggedResources: readonly TaggedResourcePromptResource[],
) => `${buildBasePrompt(workspaceDir)}\n\n${buildTaggedResourcesXml(taggedResources)}`;

const toPersistedMessage = (message: Message): Message => {
  if (message.role !== "user" || typeof message.content === "string") {
    return message;
  }

  return {
    ...message,
    content: message.content.filter((part) => part.type !== "image"),
  };
};

const mergeMessageAttachments = (
  storedMessages: readonly StoredAgentThreadMessage[],
  parsedMessages: readonly Message[],
  attachmentsBySequence: ReadonlyMap<number, readonly ImageContent[]>,
) => {
  return parsedMessages.map((message, index) => {
    const storedMessage = storedMessages[index];

    if (!storedMessage || message.role !== "user") {
      return message;
    }

    const messageAttachments = attachmentsBySequence.get(storedMessage.sequence) ?? [];

    if (messageAttachments.length === 0) {
      return message;
    }

    const imageParts = [...messageAttachments];

    if (typeof message.content === "string") {
      return {
        ...message,
        content: [{ type: "text" as const, text: message.content }, ...imageParts],
      };
    }

    return {
      ...message,
      content: [...message.content, ...imageParts],
    };
  });
};

const fetchAttachmentContent = (
  attachment: Pick<StoredAgentThreadAttachment, "ufsUrl" | "mimeType">,
) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(attachment.ufsUrl);

      if (!response.ok) {
        throw new Error(`Failed to fetch attachment: ${response.status}`);
      }

      const bytes = await response.arrayBuffer();

      return {
        type: "image" as const,
        data: Buffer.from(bytes).toString("base64"),
        mimeType: attachment.mimeType,
      } satisfies ImageContent;
    },
    catch: (cause) =>
      new AgentError({
        message: "Failed to fetch an uploaded attachment.",
        kind: "agent_attachment_fetch_error",
        traceId: crypto.randomUUID(),
        timestamp: Date.now(),
        operation: "promptThread",
        cause,
      }),
  });

const parsePersistedMessage = (
  threadId: string,
  message: StoredAgentThreadMessage,
): Effect.Effect<Message, AgentError> =>
  Effect.try({
    try: () => JSON.parse(message.rawJson),
    catch: (cause) =>
      new AgentError({
        message: `Failed to parse stored message ${message.sequence} for thread ${threadId}`,
        kind: "agent_thread_message_parse_error",
        traceId: crypto.randomUUID(),
        timestamp: Date.now(),
        operation: "promptThread",
        cause,
      }),
  }).pipe(
    Effect.flatMap((parsed) =>
      isPersistableAgentMessage(parsed)
        ? Effect.succeed(parsed)
        : Effect.fail(
            new AgentError({
              message: `Stored message ${message.sequence} for thread ${threadId} is not a valid pi message`,
              kind: "agent_thread_message_invalid_shape",
              traceId: crypto.randomUUID(),
              timestamp: Date.now(),
              operation: "promptThread",
              cause: parsed,
            }),
          ),
    ),
  );

const serializePersistedMessage = (
  threadId: string,
  message: AgentMessage,
  options?: { runMetrics?: AgentRunMetrics },
): Effect.Effect<
  { role: "user" | "assistant" | "toolResult"; timestamp: number; rawJson: string },
  AgentError
> =>
  Effect.try({
    try: () => {
      if (!isPersistableAgentMessage(message)) {
        throw new Error("Unsupported message shape");
      }

      return {
        role: message.role,
        timestamp: message.timestamp,
        rawJson: JSON.stringify(
          options?.runMetrics && message.role === "assistant"
            ? { ...toPersistedMessage(message), runMetrics: options.runMetrics }
            : toPersistedMessage(message),
        ),
      };
    },
    catch: (cause) =>
      new AgentError({
        message: `Failed to serialize agent message for thread ${threadId}`,
        kind: "agent_thread_message_serialize_error",
        traceId: crypto.randomUUID(),
        timestamp: Date.now(),
        operation: "promptThread",
        cause,
      }),
  });

const getEventTimestamp = (event: AgentEvent) =>
  "timestamp" in event && typeof event.timestamp === "number" ? event.timestamp : Date.now();

const getFinalAssistantMessage = (messages: readonly AgentMessage[]) =>
  [...messages].reverse().find((message) => message.role === "assistant");

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

const isRunKilledError = (error: unknown): error is RunKilledError =>
  error instanceof RunKilledError;
const createEmptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
});
const cloneMessage = <T extends Message>(message: T): T => structuredClone(message);
const createCanceledAssistantMessage = (args: {
  partialAssistant: AssistantMessage | null;
  selectedModel: ReturnType<typeof getAgentModel>;
  timestamp: number;
}) => {
  if (args.partialAssistant) {
    return {
      ...cloneMessage(args.partialAssistant),
      stopReason: "aborted" as const,
      errorMessage: "Canceled",
      timestamp: args.timestamp,
    } satisfies AssistantMessage;
  }

  return {
    role: "assistant",
    content: [],
    api: args.selectedModel.model.api,
    provider: args.selectedModel.model.provider,
    model: args.selectedModel.model.id,
    usage: createEmptyUsage(),
    stopReason: "aborted",
    errorMessage: "Canceled",
    timestamp: args.timestamp,
  } satisfies AssistantMessage;
};

const createReadFileTool = (
  sandbox: ResolvedSandboxAdapter,
  threadId: string,
  throwIfRunAborted: () => void,
) =>
  ({
    label: "Read File",
    name: "read_file",
    description: `Read a text file from the ${sandbox.providerLabel} sandbox for the current thread.`,
    parameters: readFileSchema,
    execute: async (_toolCallId, args) => {
      throwIfRunAborted();
      const result = await Effect.runPromise(
        sandbox.readFile({
          threadId,
          path: args.path,
          startLine: args.startLine,
          endLine: args.endLine,
        }),
      );
      throwIfRunAborted();

      return {
        content: toTextResult(truncateText(result.content)),
        details: result,
      };
    },
  }) satisfies AgentTool<typeof readFileSchema, SandboxReadFileResult>;

const createExecCommandTool = (
  sandbox: ResolvedSandboxAdapter,
  threadId: string,
  throwIfRunAborted: () => void,
) =>
  ({
    label: "Exec Command",
    name: "exec_command",
    description: `Run a shell command in the ${sandbox.providerLabel} sandbox for the current thread.`,
    parameters: execCommandSchema,
    execute: async (_toolCallId, args) => {
      throwIfRunAborted();
      const result = await Effect.runPromise(
        sandbox.executeCommand({
          threadId,
          command: args.command,
          cwd: args.cwd,
        }),
      );
      throwIfRunAborted();

      return {
        content: toTextResult(
          truncateText(
            [
              `exit_code=${result.exitCode}`,
              result.stdout ? `stdout:\n${result.stdout}` : "",
              result.stderr ? `stderr:\n${result.stderr}` : "",
              !result.stdout && !result.stderr && result.output ? `output:\n${result.output}` : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
          ),
        ),
        details: result,
      };
    },
  }) satisfies AgentTool<typeof execCommandSchema, SandboxExecuteCommandResult>;

const createSearchWebTool = (exa: ExaDef, throwIfRunAborted: () => void) =>
  ({
    label: "Search Web",
    name: "searchWeb",
    description:
      "Find candidate web pages for a query. Returns metadata only so you can expand selected URLs later with getWebContent.",
    parameters: searchWebSchema,
    execute: async (_toolCallId, args) => {
      throwIfRunAborted();
      try {
        const result = await Effect.runPromise(exa.searchWeb(args));
        throwIfRunAborted();

        return {
          content: toTextResult(truncateText(JSON.stringify(result, null, 2))),
          details: result,
        };
      } catch (error) {
        const result = {
          error: error instanceof Error ? error.message : String(error),
          query: args.query,
          results: [] as [],
          count: 0,
        };

        return {
          content: toTextResult(JSON.stringify(result, null, 2)),
          details: result,
        };
      }
    },
  }) satisfies AgentTool<
    typeof searchWebSchema,
    ExaSearchWebResult | { error: string; query: string; results: []; count: 0 }
  >;

const createGetWebContentTool = (exa: ExaDef, throwIfRunAborted: () => void) =>
  ({
    label: "Get Web Content",
    name: "getWebContent",
    description:
      "Expand one or more URLs into readable content. Use this after searchWeb or when the user already provided a specific URL. If you pass maxCharacters, it must be 6000 or less.",
    parameters: getWebContentSchema,
    execute: async (_toolCallId, args) => {
      throwIfRunAborted();
      try {
        const result = await Effect.runPromise(exa.getWebContent(args));
        throwIfRunAborted();

        return {
          content: toTextResult(truncateText(JSON.stringify(result, null, 2))),
          details: result,
        };
      } catch (error) {
        const result = {
          error: error instanceof Error ? error.message : String(error),
          urls: [...args.urls],
          results: [] as [],
        };

        return {
          content: toTextResult(truncateText(JSON.stringify(result, null, 2))),
          details: result,
        };
      }
    },
  }) satisfies AgentTool<
    typeof getWebContentSchema,
    ExaGetWebContentResult | { error: string; urls: string[]; results: [] }
  >;

const createThreadContext = (
  sandbox: ResolvedSandboxAdapter,
  exa: ExaDef,
  threadId: string,
  messages: Message[],
  taggedResources: readonly TaggedResourcePromptResource[],
  throwIfRunAborted: () => void,
) => ({
  systemPrompt: buildSystemPrompt(sandbox.workspaceDir, taggedResources),
  messages,
  tools: [
    createReadFileTool(sandbox, threadId, throwIfRunAborted),
    createExecCommandTool(sandbox, threadId, throwIfRunAborted),
    createSearchWebTool(exa, throwIfRunAborted),
    createGetWebContentTool(exa, throwIfRunAborted),
  ],
});

const createThreadConfig = (threadId: string, model: Model<Api>) =>
  ({
    model,
    sessionId: threadId,
    getApiKey: (provider) =>
      provider === "opencode" || provider === "opencode-go"
        ? OPENCODE_API_KEY
        : getEnvApiKey(provider),
    ...(model.reasoning ? { reasoning: "medium" as const } : {}),
    ...(model.api === "openai-responses" ? { reasoningSummary: "concise" as const } : {}),
    convertToLlm: (messages: AgentMessage[]) =>
      messages.flatMap((message) => {
        if (
          message.role !== "user" &&
          message.role !== "assistant" &&
          message.role !== "toolResult"
        ) {
          return [];
        }

        if (message.role === "assistant" && "runMetrics" in message) {
          const { runMetrics: _runMetrics, ...assistantMessage } = message;
          return [assistantMessage];
        }

        return [message];
      }),
  }) satisfies AgentLoopConfig & {
    reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh";
    reasoningSummary?: "auto" | "detailed" | "concise" | null;
  };

const buildPromptResult = (
  input: PromptThreadAgentRequestInput,
  sandboxId: string,
  messages: AgentMessage[],
) => {
  const lastMessage = messages.at(-1);

  return {
    ok: true as const,
    threadId: input.threadId,
    sandboxId,
    timestamp: Date.now(),
    messageCount: messages.length,
    lastMessage: lastMessage === undefined ? null : serializeMessageContent(lastMessage.content),
  } satisfies AgentPromptResult;
};

const createPromptThread =
  (sandbox: SandboxAdapter): AgentDef["promptThread"] =>
  (input) =>
    Effect.gen(function* () {
      const exa = yield* ExaService;
      const autumn = yield* AutumnService;
      const runControl = yield* RunControlService;
      const convex = yield* ConvexPrivateService;
      const runSignal = runControl.getSignal(input.runId);
      const promptPreview = getPromptPreview(input.prompt);
      const runStartedAt = Date.now();
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
              isMcp: input.isMcp,
            },
          })
          .pipe(Effect.catchCause(() => Effect.void));
      const stopRun = (message = "The agent run was stopped.") =>
        convex
          .mutation({
            func: api.private.agentThreads.setThreadState,
            args: {
              threadId: input.threadId,
              userId: input.userId,
              timestamp: Date.now(),
              status: "idle",
              activity: message,
              isMcp: input.isMcp,
            },
          })
          .pipe(Effect.catchCause(() => Effect.void));
      const throwIfRunAborted = (message?: string) =>
        runControl.throwIfAborted({
          runId: input.runId,
          threadId: input.threadId,
          ...(message ? { message } : {}),
        });
      const persistCanceledRun = (args: {
        promptMessage: Message;
        sandboxId: string;
        selectedModel: ReturnType<typeof getAgentModel>;
        completedMessages: Message[];
        partialAssistant: AssistantMessage | null;
      }) =>
        Effect.gen(function* () {
          const persistedMessages = [
            args.promptMessage,
            ...args.completedMessages,
            createCanceledAssistantMessage({
              partialAssistant: args.partialAssistant,
              selectedModel: args.selectedModel,
              timestamp: Date.now(),
            }),
          ];
          const storedMessages = yield* Effect.all(
            persistedMessages.map((message) => serializePersistedMessage(input.threadId, message)),
          );

          yield* convex.mutation({
            func: api.private.agentThreads.appendThreadMessages,
            args: {
              threadId: input.threadId,
              userId: input.userId,
              sandboxId: args.sandboxId,
              selectedModelId: args.selectedModel.id,
              isMcp: input.isMcp,
              startedAt: runStartedAt,
              completedAt: Date.now(),
              promptPreview,
              messages: storedMessages,
              attachmentIds:
                input.attachmentIds && input.attachmentIds.length > 0
                  ? (input.attachmentIds as Id<"v2_agentThreadAttachments">[])
                  : undefined,
            },
          });
        });

      return yield* Effect.gen(function* () {
        throwIfRunAborted();
        yield* convex.mutation({
          func: api.private.agentThreads.setThreadState,
          args: {
            threadId: input.threadId,
            userId: input.userId,
            timestamp: runStartedAt,
            status: "running",
            activity: promptPreview,
            isMcp: input.isMcp,
          },
        });

        const loadMessageAttachmentContent = (
          attachments: readonly StoredAgentThreadAttachment[],
        ) =>
          Effect.gen(function* () {
            const resolvedAttachments = yield* Effect.all(
              attachments.flatMap((attachment) =>
                attachment.messageSequence === null
                  ? []
                  : [
                      fetchAttachmentContent(attachment).pipe(
                        Effect.map((content) => ({
                          sequence: attachment.messageSequence as number,
                          content,
                        })),
                      ),
                    ],
              ),
            );
            const attachmentsBySequence = new Map<number, ImageContent[]>();

            for (const attachment of resolvedAttachments) {
              const current = attachmentsBySequence.get(attachment.sequence) ?? [];
              current.push(attachment.content);
              attachmentsBySequence.set(attachment.sequence, current);
            }

            return attachmentsBySequence;
          });

        throwIfRunAborted();
        const taggedResourceNames = extractTaggedResourceNames(input.prompt);
        const persistedThread: StoredAgentThreadContext | null = yield* convex.query({
          func: api.private.agentThreads.getThreadContext,
          args: {
            threadId: input.threadId,
            userId: input.userId,
          },
        });
        const parsedPersistedMessages =
          persistedThread === null
            ? []
            : yield* Effect.all(
                persistedThread.messages.map((message: StoredAgentThreadMessage) =>
                  parsePersistedMessage(input.threadId, message),
                ),
              );
        const persistedAttachmentContent =
          persistedThread === null
            ? new Map<number, ImageContent[]>()
            : yield* loadMessageAttachmentContent(persistedThread.attachments);
        const persistedMessages =
          persistedThread === null
            ? []
            : mergeMessageAttachments(
                persistedThread.messages,
                parsedPersistedMessages,
                persistedAttachmentContent,
              );
        const promptAttachments =
          input.attachmentIds && input.attachmentIds.length > 0
            ? yield* convex.query({
                func: api.private.agentThreads.resolvePromptAttachments,
                args: {
                  threadId: input.threadId,
                  userId: input.userId,
                  attachmentIds: input.attachmentIds as Id<"v2_agentThreadAttachments">[],
                },
              })
            : [];
        const promptAttachmentContent =
          promptAttachments.length === 0
            ? []
            : yield* Effect.all(
                promptAttachments.map((attachment) => fetchAttachmentContent(attachment)),
              );
        const taggedResources: TaggedResourcePromptResource[] =
          taggedResourceNames.length === 0
            ? []
            : yield* convex.query({
                func: api.private.resources.getTaggedResources,
                args: {
                  userId: input.userId,
                  names: taggedResourceNames,
                },
              });
        const shouldGenerateThreadTitle =
          persistedThread?.thread.title === null || persistedThread === null;
        const titleSourcePrompt = getThreadTitleSourcePrompt(persistedMessages, input.prompt);

        if (shouldGenerateThreadTitle) {
          yield* Effect.forkDetach(
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
          );
        }

        const resolvedSandbox = yield* sandbox.resolve();
        const ensuredSandbox = yield* resolvedSandbox.ensureThreadSandbox(
          input.threadId,
          persistedThread?.thread.sandboxId ?? undefined,
        );
        runControl.setSandboxId(input.runId, ensuredSandbox.id);
        throwIfRunAborted();
        const threadSandbox: ResolvedSandboxAdapter = {
          ...resolvedSandbox,
          ensureThreadSandbox: () => Effect.succeed(ensuredSandbox),
          readFile: (toolInput) =>
            resolvedSandbox.readFile({
              ...toolInput,
              boxId: ensuredSandbox.id,
            }),
          executeCommand: (toolInput) =>
            resolvedSandbox.executeCommand({
              ...toolInput,
              boxId: ensuredSandbox.id,
            }),
        };
        const selectedModel = getAgentModel(input.modelId ?? resolvedSandbox.defaultModelId);

        yield* convex.mutation({
          func: api.private.agentThreads.setThreadState,
          args: {
            threadId: input.threadId,
            userId: input.userId,
            timestamp: Date.now(),
            status: "running",
            activity: promptPreview,
            sandboxId: ensuredSandbox.id,
            selectedModelId: selectedModel.id,
            isMcp: input.isMcp,
          },
        });

        console.log("Agent run started", {
          threadId: input.threadId,
          sandboxId: ensuredSandbox.id,
          sandboxProvider: threadSandbox.providerLabel,
          modelId: selectedModel.id,
          providerModelId: selectedModel.model.id,
          persistedMessageCount: persistedMessages.length,
          taggedResourceCount: taggedResources.length,
        });

        const messages: AgentMessage[] = [
          {
            role: "user",
            content:
              promptAttachmentContent.length === 0
                ? input.prompt
                : [{ type: "text" as const, text: input.prompt }, ...promptAttachmentContent],
            timestamp: Date.now(),
          },
        ];
        const promptMessage = cloneMessage(messages[0] as Message);
        const turnCost = createEmptyTurnCostBreakdown();
        const pendingToolCalls = new Map<string, { toolName: string; args: ToolCallArguments }>();
        const toolCallIds = new Set<string>();
        const completedMessages: Message[] = [];
        let partialAssistantMessage: AssistantMessage | null = null;
        let activeAssistantGenerationStartedAt: number | null = null;
        let assistantGenerationDurationMs = 0;
        let assistantOutputTokens = 0;
        let tccRunStartedAt: number | null = null;
        const tccToolExecutions: Array<{
          toolCallId: string;
          toolName: string;
          args: unknown;
          isError: boolean;
          startTimestamp: number;
          endTimestamp?: number;
          result?: unknown;
        }> = [];
        const tccCollectedMessages: AgentMessage[] = [];
        const tccEndpoint = resolveTccEndpoint(TCC_API_KEY);
        const tccMetadata = {
          provider: selectedModel.model.provider,
          modelId: selectedModel.id,
          resourceNames: taggedResources.map((resource) => resource.name),
        };
        const events = agentLoop(
          messages,
          createThreadContext(
            threadSandbox,
            exa,
            input.threadId,
            persistedMessages,
            taggedResources,
            throwIfRunAborted,
          ),
          createThreadConfig(input.threadId, selectedModel.model),
          runSignal ?? undefined,
        );
        const instrumentedEvents = instrumentPiEventStream(events, {
          apiKey: TCC_API_KEY,
          sessionId: input.threadId,
          metadata: tccMetadata,
          debug: true,
        });

        return {
          threadId: input.threadId,
          sandboxId: ensuredSandbox.id,
          model: {
            id: selectedModel.id,
            label: selectedModel.label,
            description: selectedModel.description,
            pricingConfigured: selectedModel.pricingConfigured,
            provider: selectedModel.model.provider,
            api: selectedModel.model.api,
            modelId: selectedModel.model.id,
          },
          events: (async function* () {
            try {
              for await (const event of instrumentedEvents) {
                throwIfRunAborted();

                if (event.type === "agent_start") {
                  tccRunStartedAt = Date.now();
                  console.log("[TCC Debug] Agent run started", {
                    threadId: input.threadId,
                    endpoint: tccEndpoint,
                    sessionId: input.threadId,
                    runId: instrumentedEvents.getLastRunId(),
                    ...tccMetadata,
                  });
                }

                if (event.type === "message_update" && event.message.role === "assistant") {
                  partialAssistantMessage = cloneMessage(event.message);
                }

                if (event.type === "message_end") {
                  tccCollectedMessages.push(event.message);

                  if (event.message.role === "assistant") {
                    const completedAssistant = cloneMessage(event.message);
                    completedMessages.push(completedAssistant);
                    partialAssistantMessage = null;
                  }

                  if (event.message.role === "toolResult") {
                    completedMessages.push(cloneMessage(event.message));
                  }
                }

                const eventTimestamp = getEventTimestamp(event);

                if (event.type === "tool_execution_start") {
                  toolCallIds.add(event.toolCallId);
                  tccToolExecutions.push({
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    args: event.args,
                    isError: false,
                    startTimestamp: Date.now(),
                  });
                  pendingToolCalls.set(event.toolCallId, {
                    toolName: event.toolName,
                    args: event.args,
                  });
                }

                if (event.type === "tool_execution_end") {
                  const pendingToolCall = pendingToolCalls.get(event.toolCallId);
                  const tccToolExecution = tccToolExecutions.find(
                    (toolExecution) =>
                      toolExecution.toolCallId === event.toolCallId &&
                      toolExecution.endTimestamp === undefined,
                  );

                  if (tccToolExecution) {
                    tccToolExecution.endTimestamp = Date.now();
                    tccToolExecution.result = event.result;
                    tccToolExecution.isError = event.isError === true;
                  }

                  if (event.toolName === "exec_command" && !event.isError) {
                    const result = isRecord(event.result?.details)
                      ? (event.result.details as SandboxExecuteCommandResult)
                      : null;

                    turnCost.boxUsd = addUsd(turnCost.boxUsd, result?.costUsd ?? 0);
                    turnCost.boxComputeMs += result?.computeMs ?? 0;
                  }

                  if (event.toolName === "searchWeb" && !event.isError) {
                    turnCost.exaUsd = addUsd(
                      turnCost.exaUsd,
                      calculateExaSearchCostUsd(toExaSearchInput(pendingToolCall?.args)),
                    );
                    turnCost.exaSearchRequests += 1;
                  }

                  if (event.toolName === "getWebContent" && !event.isError) {
                    const exaContentInput = toExaGetWebContentInput(pendingToolCall?.args);
                    const resultCount =
                      isRecord(event.result?.details) &&
                      typeof event.result.details.count === "number"
                        ? event.result.details.count
                        : 0;

                    turnCost.exaUsd = addUsd(
                      turnCost.exaUsd,
                      calculateExaContentCostUsd({
                        input: exaContentInput,
                        pageCount: resultCount,
                      }),
                    );
                    turnCost.exaContentPages += resultCount;
                    if (exaContentInput?.summary) {
                      turnCost.exaSummaryPages += resultCount;
                    }
                    if (exaContentInput?.highlightsQuery) {
                      turnCost.exaHighlightPages += resultCount;
                    }
                  }

                  pendingToolCalls.delete(event.toolCallId);
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
                  turnCost.modelUsd = addUsd(turnCost.modelUsd, event.message.usage.cost.total);
                }

                if (event.type === "agent_end") {
                  throwIfRunAborted();
                  const tccPayload = {
                    runId: instrumentedEvents.getLastRunId(),
                    startTimestamp: tccRunStartedAt,
                    endTimestamp: Date.now(),
                    messages:
                      tccCollectedMessages.length > 0
                        ? tccCollectedMessages
                        : (event.messages ?? []),
                    toolExecutions: tccToolExecutions,
                    sessionId: input.threadId,
                    metadata: tccMetadata,
                  };

                  console.log("[TCC Debug] Agent run ended", {
                    threadId: input.threadId,
                    endpoint: tccEndpoint,
                    runId: instrumentedEvents.getLastRunId(),
                    messageCount: tccPayload.messages.length,
                    toolExecutionCount: tccPayload.toolExecutions.length,
                    payloadBytes: getSerializedSizeBytes(tccPayload),
                    ...tccMetadata,
                  });
                  turnCost.totalUsd = addUsd(turnCost.modelUsd, turnCost.boxUsd, turnCost.exaUsd);
                  const runMetrics = buildRunMetrics({
                    priceUsd: turnCost.totalUsd,
                    totalToolCalls: toolCallIds.size,
                    outputTokens: assistantOutputTokens,
                    generationDurationMs: assistantGenerationDurationMs,
                  });
                  const finalAssistantIndex = [...event.messages]
                    .map((message, index) => ({ message, index }))
                    .reverse()
                    .find(({ message }) => message.role === "assistant")?.index;
                  const storedMessages = await Effect.runPromise(
                    Effect.all(
                      event.messages.map((message: AgentMessage, index) =>
                        serializePersistedMessage(input.threadId, message, {
                          runMetrics: finalAssistantIndex === index ? runMetrics : undefined,
                        }),
                      ),
                    ),
                  );

                  await Effect.runPromise(
                    convex.mutation({
                      func: api.private.agentThreads.appendThreadMessages,
                      args: {
                        threadId: input.threadId,
                        userId: input.userId,
                        sandboxId: ensuredSandbox.id,
                        selectedModelId: selectedModel.id,
                        isMcp: input.isMcp,
                        startedAt: runStartedAt,
                        completedAt: Date.now(),
                        promptPreview,
                        messages: storedMessages,
                        attachmentIds:
                          input.attachmentIds && input.attachmentIds.length > 0
                            ? (input.attachmentIds as Id<"v2_agentThreadAttachments">[])
                            : undefined,
                      },
                    }),
                  );

                  await Effect.runPromise(
                    autumn
                      .trackUsage({
                        userId: input.userId,
                        valueUsd: turnCost.totalUsd,
                        idempotencyKey: `${input.threadId}:${runStartedAt}`,
                        properties: {
                          threadId: input.threadId,
                          sandboxId: ensuredSandbox.id,
                          modelId: selectedModel.id,
                          providerModelId: selectedModel.model.id,
                          modelUsd: turnCost.modelUsd,
                          boxUsd: turnCost.boxUsd,
                          exaUsd: turnCost.exaUsd,
                          exaSearchRequests: turnCost.exaSearchRequests,
                          exaContentPages: turnCost.exaContentPages,
                          exaSummaryPages: turnCost.exaSummaryPages,
                          exaHighlightPages: turnCost.exaHighlightPages,
                          boxComputeMs: turnCost.boxComputeMs,
                        },
                      })
                      .pipe(
                        Effect.catchCause((cause) =>
                          Effect.sync(() => {
                            console.error("Failed to track Autumn usage for agent run", {
                              threadId: input.threadId,
                              userId: input.userId,
                              error: getErrorMessage(Cause.squash(cause)),
                            });
                          }),
                        ),
                      ),
                  );

                  const result = buildPromptResult(input, ensuredSandbox.id, event.messages);
                  const finalAssistantMessage = getFinalAssistantMessage(event.messages);

                  console.log("Agent run finished", {
                    threadId: input.threadId,
                    sandboxId: ensuredSandbox.id,
                    sandboxProvider: threadSandbox.providerLabel,
                    modelId: selectedModel.id,
                    providerModelId: selectedModel.model.id,
                    stopReason: finalAssistantMessage?.stopReason ?? null,
                    errorMessage: finalAssistantMessage?.errorMessage ?? null,
                    costUsd: turnCost.totalUsd,
                    totalToolCalls: runMetrics.totalToolCalls,
                    outputTokensPerSecond: runMetrics.outputTokensPerSecond,
                    modelUsd: turnCost.modelUsd,
                    boxUsd: turnCost.boxUsd,
                    exaUsd: turnCost.exaUsd,
                    messageCount: result.messageCount,
                    totalPersistedMessages:
                      (persistedThread?.thread.messageCount ?? 0) + storedMessages.length,
                  });

                  yield {
                    ...event,
                    runMetrics,
                  } as AgentEvent;
                  continue;
                }

                yield event;
              }
            } catch (error) {
              if (isRunKilledError(error)) {
                await Effect.runPromise(
                  persistCanceledRun({
                    promptMessage,
                    sandboxId: ensuredSandbox.id,
                    selectedModel,
                    completedMessages,
                    partialAssistant: partialAssistantMessage,
                  }),
                );
                await Effect.runPromise(stopRun(error.message));
                throw error;
              }

              await Effect.runPromise(markThreadError(error));
              throw error;
            }
          })(),
        } satisfies PromptThreadAgentStream;
      }).pipe(
        Effect.tapError((error: unknown) => {
          if (isRunKilledError(error)) {
            return stopRun(error.message);
          }

          return markThreadError(error);
        }),
      );
    });

const boxSandboxAdapter: SandboxAdapter = {
  providerLabel: "Upstash Box",
  defaultModelId: defaultAgentModelId,
  resolve: () =>
    Effect.gen(function* () {
      const box = yield* BoxService;

      return {
        providerLabel: "Upstash Box",
        defaultModelId: defaultAgentModelId,
        workspaceDir: "/workspace/home",
        ensureThreadSandbox: (threadId: string, boxId?: string) =>
          box
            .ensureThreadBox({ threadId, boxId })
            .pipe(Effect.map((resolved) => ({ id: resolved.box.id }))),
        readFile: (input) =>
          box.readFile({
            threadId: input.threadId,
            boxId: input.boxId,
            path: input.path,
            startLine: input.startLine,
            endLine: input.endLine,
          }),
        executeCommand: (input) =>
          box.executeCommand({
            threadId: input.threadId,
            boxId: input.boxId,
            command: input.command,
            cwd: input.cwd,
          }),
      } satisfies ResolvedSandboxAdapter;
    }),
};

export class AgentService extends ServiceMap.Service<AgentService, AgentDef>()("AgentService") {
  static readonly layer = Layer.sync(AgentService, () => ({
    promptThread: createPromptThread(boxSandboxAdapter),
  }));
}
