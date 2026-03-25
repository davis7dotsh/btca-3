import { randomUUID } from "node:crypto";
import { env } from "$env/dynamic/private";
import { Agent, Box, type Box as UpstashBox } from "@upstash/box";
import { Cause, Data, Effect, Layer, ServiceMap } from "effect";
import type {
  DaytonaExecuteCommandInput,
  DaytonaExecuteCommandResult,
  DaytonaReadFileInput,
  DaytonaReadFileResult,
} from "./daytona";

type BoxOperation =
  | "getClient"
  | "getBox"
  | "createThreadBox"
  | "ensureThreadBox"
  | "readFile"
  | "executeCommand"
  | "runThreadAgent";

const DEFAULT_BOX_TIMEOUT_MS = 10 * 60 * 1_000;
const BOX_RUNTIME = "node";
const BOX_WORKSPACE_CWD = "/workspace/home";
export const BOX_CODEX_MODEL = "openai/gpt-5.4-mini";
export const BOX_AGENT_RUN_TIMEOUT_MS = 2 * 60 * 1_000;

const BOX_AGENT_INSTRUCTIONS = `
You are btca, an expert research agent. Your job is to answer questions from the user with the tools at your disposal.

You have access to a sandbox where you can clone git repos, install npm packages, run shell commands, execute Python, search the web, and read files.

When executing python code, keep the code very simple and fast. It is being executed in a sandbox with limited resources, prefer normal shell commands over python code whenever possible.

Use this ability to answer the user's question.

<resources_contract>
- Tool use order: git, npm, then web search. Always start with git or npm if possible, move on to web search only if necessary.
- Use "${BOX_WORKSPACE_CWD}" as the working directory for everything
- Clone repos and create fake npm projects to clone/explore packages from within "${BOX_WORKSPACE_CWD}"
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
- use the exa mcp to search the web
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

export class BoxServiceError extends Data.TaggedError("BoxServiceError")<{
  readonly message: string;
  readonly kind: string;
  readonly traceId: string;
  readonly timestamp: number;
  readonly operation: BoxOperation;
  readonly cause?: unknown;
}> {}

export interface EnsureThreadBoxInput {
  readonly threadId: string;
  readonly boxId?: string;
}

export interface RunThreadAgentInput extends EnsureThreadBoxInput {
  readonly prompt: string;
  readonly resourceXml?: string;
}

export interface BoxThreadAgentRunResult {
  readonly threadId: string;
  readonly boxId: string;
  readonly runId: string;
  readonly createdBox: boolean;
  readonly model: string;
  readonly output: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface BoxDef {
  getBox: (boxId: string) => Effect.Effect<UpstashBox, BoxServiceError>;
  createThreadBox: (input: EnsureThreadBoxInput) => Effect.Effect<UpstashBox, BoxServiceError>;
  ensureThreadBox: (
    input: EnsureThreadBoxInput,
  ) => Effect.Effect<{ box: UpstashBox; created: boolean }, BoxServiceError>;
  readFile: (
    input: DaytonaReadFileInput & { readonly boxId?: string },
  ) => Effect.Effect<DaytonaReadFileResult, BoxServiceError>;
  executeCommand: (
    input: DaytonaExecuteCommandInput & { readonly boxId?: string },
  ) => Effect.Effect<DaytonaExecuteCommandResult, BoxServiceError>;
  runThreadAgent: (
    input: RunThreadAgentInput,
  ) => Effect.Effect<BoxThreadAgentRunResult, BoxServiceError>;
}

const getRequiredValue = (value: string | undefined, key: string) => {
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }

  return value;
};

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const buildExecScript = ({
  command,
  cwd,
  env,
}: {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}) =>
  [
    cwd === undefined ? undefined : `cd ${shellQuote(cwd)}`,
    ...(env === undefined
      ? []
      : Object.entries(env).map(([key, value]) => `export ${key}=${shellQuote(value)}`)),
    command,
  ]
    .filter((part) => part !== undefined && part.length > 0)
    .join("\n");

const createBoxServiceError = ({
  message,
  kind,
  operation,
  cause,
}: {
  message: string;
  kind: string;
  operation: BoxOperation;
  cause?: unknown;
}) =>
  new BoxServiceError({
    message,
    kind,
    traceId: randomUUID(),
    timestamp: Date.now(),
    operation,
    cause,
  });

const toBoxServiceError = ({
  cause,
  operation,
  message,
  kind,
}: {
  cause: unknown;
  operation: BoxOperation;
  message: string;
  kind: string;
}) =>
  cause instanceof BoxServiceError
    ? cause
    : createBoxServiceError({
        message: cause instanceof Error ? cause.message : message,
        kind,
        operation,
        cause,
      });

const parseReadFileResult = (
  content: string,
  input: DaytonaReadFileInput,
  boxId: string,
): DaytonaReadFileResult => {
  if (
    input.startLine !== undefined &&
    input.endLine !== undefined &&
    input.endLine < input.startLine
  ) {
    throw new Error("endLine must be greater than or equal to startLine");
  }

  const allLines = content === "" ? [] : content.split(/\r?\n/u);
  const totalLines = allLines.length;
  const lineStart = input.startLine ?? 1;
  const requestedEndLine = input.endLine;
  const lineEnd =
    totalLines === 0
      ? Math.max(lineStart - 1, 0)
      : requestedEndLine === undefined
        ? totalLines
        : Math.min(requestedEndLine, totalLines);
  const selectedLines =
    totalLines === 0 || lineEnd < lineStart ? [] : allLines.slice(lineStart - 1, lineEnd);

  return {
    sandboxId: boxId,
    path: input.path,
    content: selectedLines.join("\n"),
    requestedStartLine: input.startLine,
    requestedEndLine,
    lineStart,
    lineEnd,
    totalLines,
  };
};

const prepareThreadBox = async (box: UpstashBox) => {
  if (box.cwd !== BOX_WORKSPACE_CWD) {
    await box.cd(BOX_WORKSPACE_CWD);
  }

  return box;
};

const buildThreadBoxPrompt = (prompt: string, resourceXml?: string) => {
  const appendix = resourceXml?.trim() ? `\n\n${resourceXml.trim()}` : "";
  return `${BOX_AGENT_INSTRUCTIONS}${appendix}\n\nUser request:\n${prompt.trim()}`;
};

export const buildBoxThreadAgentPrompt = (prompt: string, resourceXml?: string) =>
  buildThreadBoxPrompt(prompt, resourceXml);

const getBoxConfig = () => ({
  apiKey: getRequiredValue(env.UPSTASH_BOX_API_KEY, "UPSTASH_BOX_API_KEY"),
  baseUrl: env.UPSTASH_BOX_BASE_URL,
  timeout: DEFAULT_BOX_TIMEOUT_MS,
});

const createThreadBoxName = (threadId: string) => `thread-${threadId.slice(0, 12)}`;

export class BoxService extends ServiceMap.Service<BoxService, BoxDef>()("BoxService") {
  static readonly layer = Layer.sync(BoxService, () => {
    const getBox: BoxDef["getBox"] = (boxId) =>
      Effect.tryPromise({
        try: async () =>
          await Box.get(boxId, {
            apiKey: getRequiredValue(env.UPSTASH_BOX_API_KEY, "UPSTASH_BOX_API_KEY"),
            baseUrl: env.UPSTASH_BOX_BASE_URL,
            timeout: DEFAULT_BOX_TIMEOUT_MS,
          }),
        catch: (cause) =>
          toBoxServiceError({
            cause,
            operation: "getBox",
            message: `Failed to load Upstash Box ${boxId}`,
            kind: "box_get_error",
          }),
      });

    const createThreadBox: BoxDef["createThreadBox"] = (input) =>
      Effect.tryPromise({
        try: async () => {
          const exaApiKey = getRequiredValue(env.EXA_API_KEY, "EXA_API_KEY");
          const box = await Box.create({
            ...getBoxConfig(),
            runtime: BOX_RUNTIME,
            mcpServers: [
              {
                name: "exa",
                url: `https://mcp.exa.ai/mcp?exaApiKey=${exaApiKey}&tools=web_search_exa`,
              },
            ],
            agent: {
              provider: Agent.Codex,
              model: BOX_CODEX_MODEL,
              apiKey: getRequiredValue(env.OPENAI_API_KEY, "OPENAI_API_KEY"),
            },
            env: {
              PI_LAND_THREAD_ID: input.threadId,
              PI_LAND_THREAD_NAME: createThreadBoxName(input.threadId),
            },
          });

          console.log("Created Upstash Box for thread", {
            threadId: input.threadId,
            boxId: box.id,
            model: BOX_CODEX_MODEL,
          });

          return await prepareThreadBox(box);
        },
        catch: (cause) =>
          toBoxServiceError({
            cause,
            operation: "createThreadBox",
            message: `Failed to create Upstash Box for thread ${input.threadId}`,
            kind: "box_create_thread_box_error",
          }),
      });

    const ensureThreadBox: BoxDef["ensureThreadBox"] = (input) =>
      Effect.gen(function* () {
        if (input.boxId) {
          const existingExit = yield* Effect.exit(getBox(input.boxId));

          if (existingExit._tag === "Success") {
            return {
              box: yield* Effect.tryPromise({
                try: () => prepareThreadBox(existingExit.value),
                catch: (cause) =>
                  toBoxServiceError({
                    cause,
                    operation: "ensureThreadBox",
                    message: `Failed to prepare Upstash Box ${input.boxId}`,
                    kind: "box_prepare_thread_box_error",
                  }),
              }),
              created: false,
            };
          }

          console.warn("Failed to reuse Upstash Box, creating a fresh box instead", {
            threadId: input.threadId,
            boxId: input.boxId,
            error: Cause.squash(existingExit.cause),
          });
        }

        return {
          box: yield* createThreadBox(input),
          created: true,
        };
      }).pipe(
        Effect.mapError((cause) =>
          toBoxServiceError({
            cause,
            operation: "ensureThreadBox",
            message: `Failed to prepare Upstash Box for thread ${input.threadId}`,
            kind: "box_ensure_thread_box_error",
          }),
        ),
      );

    const readFile: BoxDef["readFile"] = (input) =>
      Effect.tryPromise({
        try: async () => {
          const prepared = await Effect.runPromise(
            ensureThreadBox({
              threadId: input.threadId,
              boxId: input.boxId,
            }),
          );
          const content = await prepared.box.files.read(input.path);

          return parseReadFileResult(content, input, prepared.box.id);
        },
        catch: (cause) =>
          toBoxServiceError({
            cause,
            operation: "readFile",
            message: `Failed to read ${input.path} from Upstash Box`,
            kind: "box_read_file_error",
          }),
      });

    const executeCommand: BoxDef["executeCommand"] = (input) =>
      Effect.tryPromise({
        try: async () => {
          const prepared = await Effect.runPromise(
            ensureThreadBox({
              threadId: input.threadId,
              boxId: input.boxId,
            }),
          );
          const run = await prepared.box.exec.command(
            buildExecScript({
              command: input.command,
              cwd: input.cwd,
              env: input.env,
            }),
          );
          const output = run.result.trimEnd();

          return {
            sandboxId: prepared.box.id,
            command: input.command,
            cwd: input.cwd,
            exitCode: run.exitCode ?? -1,
            stdout: output,
            stderr: "",
            output,
          } satisfies DaytonaExecuteCommandResult;
        },
        catch: (cause) =>
          toBoxServiceError({
            cause,
            operation: "executeCommand",
            message: `Failed to execute command in Upstash Box for thread ${input.threadId}`,
            kind: "box_execute_command_error",
          }),
      });

    const runThreadAgent: BoxDef["runThreadAgent"] = (input) =>
      Effect.gen(function* () {
        const prepared = yield* ensureThreadBox(input);
        const fullPrompt = buildThreadBoxPrompt(input.prompt, input.resourceXml);

        return yield* Effect.tryPromise({
          try: async () => {
            await prepared.box.configureModel(BOX_CODEX_MODEL);

            console.log("Starting Upstash Box agent run", {
              threadId: input.threadId,
              boxId: prepared.box.id,
              createdBox: prepared.created,
              model: BOX_CODEX_MODEL,
            });

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

            for await (const _chunk of streamRun) {
              void _chunk;
            }

            const output = streamRun.result.trim();

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

            return {
              threadId: input.threadId,
              boxId: prepared.box.id,
              runId: streamRun.id,
              createdBox: prepared.created,
              model: BOX_CODEX_MODEL,
              output,
              inputTokens: streamRun.cost.inputTokens,
              outputTokens: streamRun.cost.outputTokens,
            } satisfies BoxThreadAgentRunResult;
          },
          catch: (cause) =>
            toBoxServiceError({
              cause,
              operation: "runThreadAgent",
              message: `Failed to run the Upstash Box agent for thread ${input.threadId}`,
              kind: "box_run_thread_agent_error",
            }),
        });
      });

    return {
      getBox,
      createThreadBox,
      ensureThreadBox,
      readFile,
      executeCommand,
      runThreadAgent,
    };
  });
}
