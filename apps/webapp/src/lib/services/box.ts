import { randomUUID } from "node:crypto";
import { env } from "$env/dynamic/private";
import { Agent, Box, type Box as UpstashBox } from "@upstash/box";
import { Cause, Data, Effect, Layer, ServiceMap } from "effect";
import type {
  SandboxExecuteCommandInput,
  SandboxExecuteCommandResult,
  SandboxReadFileInput,
  SandboxReadFileResult,
} from "$lib/types/agent";

type BoxOperation =
  | "getClient"
  | "getBox"
  | "createThreadBox"
  | "ensureThreadBox"
  | "deleteBox"
  | "readFile"
  | "executeCommand";

const DEFAULT_BOX_TIMEOUT_MS = 10 * 60 * 1_000;
const BOX_RUNTIME = "node";
const BOX_WORKSPACE_CWD = "/workspace/home";
export const BOX_CODEX_MODEL = "openai/gpt-5.4-mini";

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

export interface BoxDef {
  getBox: (boxId: string) => Effect.Effect<UpstashBox, BoxServiceError>;
  createThreadBox: (input: EnsureThreadBoxInput) => Effect.Effect<UpstashBox, BoxServiceError>;
  ensureThreadBox: (
    input: EnsureThreadBoxInput,
  ) => Effect.Effect<{ box: UpstashBox; created: boolean }, BoxServiceError>;
  deleteBox: (boxId: string) => Effect.Effect<void, BoxServiceError>;
  readFile: (
    input: SandboxReadFileInput & { readonly boxId?: string },
  ) => Effect.Effect<SandboxReadFileResult, BoxServiceError>;
  executeCommand: (
    input: SandboxExecuteCommandInput & { readonly boxId?: string },
  ) => Effect.Effect<SandboxExecuteCommandResult, BoxServiceError>;
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
        message,
        kind,
        operation,
        cause,
      });

const parseReadFileResult = (
  content: string,
  input: SandboxReadFileInput,
  boxId: string,
): SandboxReadFileResult => {
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

    const deleteBox: BoxDef["deleteBox"] = (boxId) =>
      Effect.tryPromise({
        try: async () => {
          const box = await Box.get(boxId, getBoxConfig());
          await box.delete();
        },
        catch: (cause) =>
          toBoxServiceError({
            cause,
            operation: "deleteBox",
            message: `Failed to delete Upstash Box ${boxId}`,
            kind: "box_delete_error",
          }),
      });

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
            computeMs: run.cost?.computeMs,
            costUsd: run.cost?.totalUsd,
          } satisfies SandboxExecuteCommandResult;
        },
        catch: (cause) =>
          toBoxServiceError({
            cause,
            operation: "executeCommand",
            message: `Failed to execute command in Upstash Box for thread ${input.threadId}`,
            kind: "box_execute_command_error",
          }),
      });

    return {
      getBox,
      createThreadBox,
      ensureThreadBox,
      deleteBox,
      readFile,
      executeCommand,
    };
  });
}
