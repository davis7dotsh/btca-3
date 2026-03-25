import { randomUUID } from "node:crypto";
import { env } from "$env/dynamic/private";
import { DAYTONA_API_KEY, DAYTONA_API_URL } from "$env/static/private";
import {
  Daytona,
  type CreateSandboxFromImageParams,
  type CreateSandboxFromSnapshotParams,
  type Sandbox,
  SandboxState,
} from "@daytonaio/sdk";
import { Data, Effect, Layer, ServiceMap } from "effect";

type DaytonaOperation =
  | "getClient"
  | "createSandbox"
  | "getSandbox"
  | "listSandboxes"
  | "deleteSandbox"
  | "createThreadSandbox"
  | "getThreadSandbox"
  | "ensureThreadSandbox"
  | "readFile"
  | "executeCommand";

const THREAD_ID_LABEL = "pi_land_thread_id";
const THREAD_KIND_LABEL = "pi_land_kind";
const THREAD_KIND_VALUE = "agent";
const DEFAULT_SANDBOX_TIMEOUT_SECONDS = 60;
const DEFAULT_PROCESS_TIMEOUT_SECONDS = 60;

export class DaytonaServiceError extends Data.TaggedError("DaytonaServiceError")<{
  readonly message: string;
  readonly kind: string;
  readonly traceId: string;
  readonly timestamp: number;
  readonly operation: DaytonaOperation;
  readonly cause?: unknown;
}> {}

export interface DaytonaListSandboxesInput {
  readonly labels?: Record<string, string>;
  readonly page?: number;
  readonly limit?: number;
}

export interface CreateThreadSandboxInput {
  readonly threadId: string;
  readonly snapshot?: string;
  readonly envVars?: Record<string, string>;
  readonly labels?: Record<string, string>;
  readonly language?: string;
  readonly timeout?: number;
  readonly autoStopInterval?: number;
  readonly autoArchiveInterval?: number;
  readonly autoDeleteInterval?: number;
}

export interface DaytonaReadFileInput {
  readonly threadId: string;
  readonly path: string;
  readonly encoding?: BufferEncoding;
  readonly startLine?: number;
  readonly endLine?: number;
}

export interface DaytonaReadFileResult {
  readonly sandboxId: string;
  readonly path: string;
  readonly content: string;
  readonly requestedStartLine?: number;
  readonly requestedEndLine?: number;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly totalLines: number;
}

export interface DaytonaExecuteCommandInput {
  readonly threadId: string;
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly timeout?: number;
}

export interface DaytonaExecuteCommandResult {
  readonly sandboxId: string;
  readonly command: string;
  readonly cwd?: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly output: string;
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const shellArg = (value: string | number | undefined) =>
  value === undefined ? "''" : shellQuote(String(value));

const buildSessionCommand = ({
  command,
  cwd,
  env,
}: {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}) =>
  `bash -lc ${shellQuote(
    [
      cwd === undefined ? undefined : `cd ${shellQuote(cwd)}`,
      ...(env === undefined
        ? []
        : Object.entries(env).map(([key, value]) => `export ${key}=${shellQuote(value)}`)),
      command,
    ]
      .filter((part) => part !== undefined && part.length > 0)
      .join("\n"),
  )}`;

const readFileScript = `
(async () => {
	const fs = require('node:fs');
	const readline = require('node:readline');

	const [, path, startArg, endArg, encodingArg] = process.argv;

	const parseLineNumber = (value) => {
		if (value === '') {
			return undefined;
		}

		const parsed = Number(value);

		if (!Number.isInteger(parsed) || parsed < 1) {
			throw new Error(\`Invalid line number: \${value}\`);
		}

		return parsed;
	};

	const requestedStartLine = parseLineNumber(startArg);
	const requestedEndLine = parseLineNumber(endArg);

	if (requestedStartLine !== undefined && requestedEndLine !== undefined && requestedEndLine < requestedStartLine) {
		throw new Error('endLine must be greater than or equal to startLine');
	}

	const lineStart = requestedStartLine ?? 1;
	const lines = [];
	let totalLines = 0;

	const stream = fs.createReadStream(path, {
		encoding: encodingArg || 'utf8'
	});

	const rl = readline.createInterface({
		input: stream,
		crlfDelay: Infinity
	});

	for await (const line of rl) {
		totalLines += 1;

		if (totalLines >= lineStart && (requestedEndLine === undefined || totalLines <= requestedEndLine)) {
			lines.push(line);
		}
	}

	const lineEnd = lines.length === 0 ? Math.max(lineStart - 1, 0) : lineStart + lines.length - 1;

	process.stdout.write(JSON.stringify({
		content: lines.join('\\n'),
		requestedStartLine,
		requestedEndLine,
		lineStart,
		lineEnd,
		totalLines
	}));
})().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exit(1);
});
`.trim();

const buildReadFileCommand = (input: DaytonaReadFileInput) =>
  [
    "node",
    "-e",
    shellQuote(readFileScript),
    "--",
    shellArg(input.path),
    shellArg(input.startLine),
    shellArg(input.endLine),
    shellArg(input.encoding ?? "utf8"),
  ].join(" ");

export interface DaytonaDef {
  getClient: () => Effect.Effect<Daytona, DaytonaServiceError>;
  createSandbox: (
    params?: CreateSandboxFromSnapshotParams | CreateSandboxFromImageParams,
  ) => Effect.Effect<Sandbox, DaytonaServiceError>;
  getSandbox: (sandboxIdOrName: string) => Effect.Effect<Sandbox, DaytonaServiceError>;
  listSandboxes: (
    input?: DaytonaListSandboxesInput,
  ) => Effect.Effect<readonly Sandbox[], DaytonaServiceError>;
  deleteSandbox: (sandbox: Sandbox, timeout?: number) => Effect.Effect<void, DaytonaServiceError>;
  createThreadSandbox: (
    input: CreateThreadSandboxInput,
  ) => Effect.Effect<Sandbox, DaytonaServiceError>;
  getThreadSandbox: (threadId: string) => Effect.Effect<Sandbox, DaytonaServiceError>;
  ensureThreadSandbox: (
    input: CreateThreadSandboxInput,
  ) => Effect.Effect<Sandbox, DaytonaServiceError>;
  readFile: (
    input: DaytonaReadFileInput,
  ) => Effect.Effect<DaytonaReadFileResult, DaytonaServiceError>;
  executeCommand: (
    input: DaytonaExecuteCommandInput,
  ) => Effect.Effect<DaytonaExecuteCommandResult, DaytonaServiceError>;
}

const createDaytonaServiceError = ({
  message,
  kind,
  operation,
  cause,
}: {
  message: string;
  kind: string;
  operation: DaytonaOperation;
  cause?: unknown;
}) =>
  new DaytonaServiceError({
    message,
    kind,
    traceId: randomUUID(),
    timestamp: Date.now(),
    operation,
    cause,
  });

const toDaytonaServiceError = (
  cause: unknown,
  operation: DaytonaOperation,
  message: string,
  kind: string,
) =>
  cause instanceof DaytonaServiceError
    ? cause
    : createDaytonaServiceError({
        message: cause instanceof Error ? cause.message : message,
        kind,
        operation,
        cause,
      });

const withTimeout = async <Value>({
  operation,
  message,
  kind,
  timeoutSeconds,
  task,
}: {
  operation: DaytonaOperation;
  message: string;
  kind: string;
  timeoutSeconds: number;
  task: () => Promise<Value>;
}) => {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      task(),
      new Promise<Value>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(
            createDaytonaServiceError({
              message,
              kind,
              operation,
            }),
          );
        }, timeoutSeconds * 1000);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
};

const sanitizeThreadName = (threadId: string) => {
  const cleaned = threadId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return `agent-${cleaned.slice(0, 48) || "thread"}`;
};

const getThreadLabels = (threadId: string, labels?: Record<string, string>) => ({
  [THREAD_ID_LABEL]: threadId,
  [THREAD_KIND_LABEL]: THREAD_KIND_VALUE,
  ...labels,
});

export class DaytonaService extends ServiceMap.Service<DaytonaService, DaytonaDef>()(
  "DaytonaService",
) {
  static readonly layer = Layer.sync(DaytonaService, () => {
    const createClient = () => {
      try {
        return new Daytona({
          apiKey: DAYTONA_API_KEY,
          apiUrl: DAYTONA_API_URL,
        });
      } catch (cause) {
        throw createDaytonaServiceError({
          message: cause instanceof Error ? cause.message : "Failed to initialize Daytona client",
          kind: "daytona_client_error",
          operation: "getClient",
          cause,
        });
      }
    };

    const getSnapshotName = (snapshot?: string) => snapshot ?? env.DAYTONA_AGENT_SNAPSHOT;

    const ensureSandboxReady = async (
      sandbox: Sandbox,
      timeout = DEFAULT_SANDBOX_TIMEOUT_SECONDS,
    ) => {
      await withTimeout({
        operation: "ensureThreadSandbox",
        message: `Timed out while refreshing sandbox ${sandbox.id}`,
        kind: "daytona_refresh_sandbox_timeout",
        timeoutSeconds: timeout,
        task: () => sandbox.refreshData(),
      });

      if (sandbox.state === SandboxState.STARTED) {
        return sandbox;
      }

      if (sandbox.state === SandboxState.STOPPED) {
        await withTimeout({
          operation: "ensureThreadSandbox",
          message: `Timed out while starting sandbox ${sandbox.id}`,
          kind: "daytona_start_sandbox_timeout",
          timeoutSeconds: timeout,
          task: () => sandbox.start(timeout),
        });
        return sandbox;
      }

      if (sandbox.state === SandboxState.ERROR) {
        if (sandbox.recoverable) {
          await withTimeout({
            operation: "ensureThreadSandbox",
            message: `Timed out while recovering sandbox ${sandbox.id}`,
            kind: "daytona_recover_sandbox_timeout",
            timeoutSeconds: timeout,
            task: () => sandbox.recover(timeout),
          });
          return sandbox;
        }

        throw createDaytonaServiceError({
          message: `Sandbox ${sandbox.id} is in an unrecoverable error state`,
          kind: "daytona_sandbox_unrecoverable_error",
          operation: "ensureThreadSandbox",
        });
      }

      await withTimeout({
        operation: "ensureThreadSandbox",
        message: `Timed out while waiting for sandbox ${sandbox.id} to start`,
        kind: "daytona_wait_for_sandbox_timeout",
        timeoutSeconds: timeout,
        task: () => sandbox.waitUntilStarted(timeout),
      });
      return sandbox;
    };

    const getThreadSandboxInstance = async (threadId: string) => {
      const sandboxes = await withTimeout({
        operation: "getThreadSandbox",
        message: `Timed out while listing sandboxes for thread ${threadId}`,
        kind: "daytona_list_thread_sandbox_timeout",
        timeoutSeconds: DEFAULT_SANDBOX_TIMEOUT_SECONDS,
        task: () => createClient().list(getThreadLabels(threadId), 1, 10),
      });
      const sandbox = sandboxes.items[0];

      if (!sandbox) {
        throw createDaytonaServiceError({
          message: `No Daytona sandbox found for thread ${threadId}`,
          kind: "daytona_thread_sandbox_not_found",
          operation: "getThreadSandbox",
        });
      }

      return sandbox;
    };

    const createThreadSandboxInstance = async (input: CreateThreadSandboxInput) => {
      const timeoutSeconds = input.timeout ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS;
      const sandbox = await withTimeout({
        operation: "createThreadSandbox",
        message: `Timed out while creating sandbox for thread ${input.threadId}`,
        kind: "daytona_create_thread_sandbox_timeout",
        timeoutSeconds,
        task: () =>
          createClient().create(
            {
              name: sanitizeThreadName(input.threadId),
              snapshot: getSnapshotName(input.snapshot),
              labels: getThreadLabels(input.threadId, input.labels),
              envVars: input.envVars,
              language: input.language ?? "typescript",
              autoStopInterval: input.autoStopInterval ?? 3,
              autoArchiveInterval: input.autoArchiveInterval,
              autoDeleteInterval: input.autoDeleteInterval,
            },
            {
              timeout: timeoutSeconds,
            },
          ),
      });

      return ensureSandboxReady(sandbox, timeoutSeconds);
    };

    const ensureThreadSandboxInstance = async (input: CreateThreadSandboxInput) => {
      try {
        const sandbox = await getThreadSandboxInstance(input.threadId);

        return await ensureSandboxReady(sandbox, input.timeout ?? 60);
      } catch (cause) {
        if (
          cause instanceof DaytonaServiceError &&
          cause.kind === "daytona_thread_sandbox_not_found"
        ) {
          return createThreadSandboxInstance(input);
        }

        throw cause;
      }
    };

    const getClient = () =>
      Effect.try({
        try: () => createClient(),
        catch: (cause) =>
          toDaytonaServiceError(
            cause,
            "getClient",
            "Failed to initialize Daytona client",
            "daytona_client_error",
          ),
      });

    const createSandbox = (
      params?: CreateSandboxFromSnapshotParams | CreateSandboxFromImageParams,
    ) =>
      Effect.tryPromise({
        try: async () => {
          const sandbox = await createClient().create(params);
          return ensureSandboxReady(sandbox);
        },
        catch: (cause) =>
          toDaytonaServiceError(
            cause,
            "createSandbox",
            "Failed to create Daytona sandbox",
            "daytona_create_sandbox_error",
          ),
      });

    const getSandbox = (sandboxIdOrName: string) =>
      Effect.tryPromise({
        try: async () => createClient().get(sandboxIdOrName),
        catch: (cause) =>
          toDaytonaServiceError(
            cause,
            "getSandbox",
            `Failed to load Daytona sandbox ${sandboxIdOrName}`,
            "daytona_get_sandbox_error",
          ),
      });

    const listSandboxes = (input?: DaytonaListSandboxesInput) =>
      Effect.tryPromise({
        try: async () => {
          const response = await createClient().list(input?.labels, input?.page, input?.limit);

          return response.items;
        },
        catch: (cause) =>
          toDaytonaServiceError(
            cause,
            "listSandboxes",
            "Failed to list Daytona sandboxes",
            "daytona_list_sandboxes_error",
          ),
      });

    const deleteSandbox = (sandbox: Sandbox, timeout?: number) =>
      Effect.tryPromise({
        try: async () => {
          await sandbox.delete(timeout);
        },
        catch: (cause) =>
          toDaytonaServiceError(
            cause,
            "deleteSandbox",
            `Failed to delete Daytona sandbox ${sandbox.id}`,
            "daytona_delete_sandbox_error",
          ),
      });

    const createThreadSandbox = (input: CreateThreadSandboxInput) =>
      Effect.tryPromise({
        try: async () => createThreadSandboxInstance(input),
        catch: (cause) =>
          toDaytonaServiceError(
            cause,
            "createThreadSandbox",
            `Failed to create Daytona sandbox for thread ${input.threadId}`,
            "daytona_create_thread_sandbox_error",
          ),
      });

    const getThreadSandbox = (threadId: string) =>
      Effect.tryPromise({
        try: async () => getThreadSandboxInstance(threadId),
        catch: (cause) =>
          toDaytonaServiceError(
            cause,
            "getThreadSandbox",
            `Failed to load Daytona sandbox for thread ${threadId}`,
            "daytona_get_thread_sandbox_error",
          ),
      });

    const ensureThreadSandbox = (input: CreateThreadSandboxInput) =>
      Effect.tryPromise({
        try: async () => ensureThreadSandboxInstance(input),
        catch: (cause) =>
          toDaytonaServiceError(
            cause,
            "ensureThreadSandbox",
            `Failed to prepare Daytona sandbox for thread ${input.threadId}`,
            "daytona_ensure_thread_sandbox_error",
          ),
      });

    const readFile = (input: DaytonaReadFileInput) =>
      Effect.tryPromise({
        try: async () => {
          if (
            input.startLine !== undefined &&
            input.endLine !== undefined &&
            input.endLine < input.startLine
          ) {
            throw createDaytonaServiceError({
              message: "endLine must be greater than or equal to startLine",
              kind: "daytona_read_file_invalid_range",
              operation: "readFile",
            });
          }

          const sandbox = await ensureThreadSandboxInstance({
            threadId: input.threadId,
          });
          const sessionId = `read-${randomUUID()}`;
          const timeoutSeconds = DEFAULT_PROCESS_TIMEOUT_SECONDS;

          await withTimeout({
            operation: "readFile",
            message: `Timed out while creating a read session for thread ${input.threadId}`,
            kind: "daytona_read_file_create_session_timeout",
            timeoutSeconds,
            task: () => sandbox.process.createSession(sessionId),
          });

          try {
            const result = await withTimeout({
              operation: "readFile",
              message: `Timed out while reading ${input.path} from sandbox ${sandbox.id}`,
              kind: "daytona_read_file_timeout",
              timeoutSeconds,
              task: () =>
                sandbox.process.executeSessionCommand(
                  sessionId,
                  {
                    command: buildReadFileCommand(input),
                  },
                  timeoutSeconds,
                ),
            });
            const stdout = result.stdout ?? result.output ?? "";
            const stderr = result.stderr ?? "";

            if ((result.exitCode ?? -1) !== 0) {
              throw new Error(stderr || stdout || `Unable to read ${input.path}`);
            }

            const parsed = JSON.parse(stdout) as Omit<DaytonaReadFileResult, "sandboxId" | "path">;

            return {
              sandboxId: sandbox.id,
              path: input.path,
              content: parsed.content,
              requestedStartLine: parsed.requestedStartLine,
              requestedEndLine: parsed.requestedEndLine,
              lineStart: parsed.lineStart,
              lineEnd: parsed.lineEnd,
              totalLines: parsed.totalLines,
            } satisfies DaytonaReadFileResult;
          } finally {
            void withTimeout({
              operation: "readFile",
              message: `Timed out while deleting read session ${sessionId}`,
              kind: "daytona_read_file_delete_session_timeout",
              timeoutSeconds: 10,
              task: () => sandbox.process.deleteSession(sessionId),
            }).catch(() => undefined);
          }
        },
        catch: (cause) =>
          toDaytonaServiceError(
            cause,
            "readFile",
            `Failed to read ${input.path} from Daytona sandbox`,
            "daytona_read_file_error",
          ),
      });

    const executeCommand = (input: DaytonaExecuteCommandInput) =>
      Effect.tryPromise({
        try: async () => {
          const sandbox = await ensureThreadSandboxInstance({
            threadId: input.threadId,
          });
          const sessionId = `exec-${randomUUID()}`;
          const timeoutSeconds = input.timeout ?? DEFAULT_PROCESS_TIMEOUT_SECONDS;

          await withTimeout({
            operation: "executeCommand",
            message: `Timed out while creating a command session for thread ${input.threadId}`,
            kind: "daytona_execute_command_create_session_timeout",
            timeoutSeconds,
            task: () => sandbox.process.createSession(sessionId),
          });

          try {
            const result = await withTimeout({
              operation: "executeCommand",
              message: `Timed out while executing command in sandbox ${sandbox.id}`,
              kind: "daytona_execute_command_timeout",
              timeoutSeconds,
              task: () =>
                sandbox.process.executeSessionCommand(
                  sessionId,
                  {
                    command: buildSessionCommand({
                      command: input.command,
                      cwd: input.cwd,
                      env: input.env,
                    }),
                  },
                  timeoutSeconds,
                ),
            });
            const stdout = result.stdout ?? "";
            const stderr = result.stderr ?? "";
            const output = result.output ?? [stdout, stderr].filter(Boolean).join("\n");

            return {
              sandboxId: sandbox.id,
              command: input.command,
              cwd: input.cwd,
              exitCode: result.exitCode ?? -1,
              stdout,
              stderr,
              output,
            } satisfies DaytonaExecuteCommandResult;
          } finally {
            void withTimeout({
              operation: "executeCommand",
              message: `Timed out while deleting command session ${sessionId}`,
              kind: "daytona_execute_command_delete_session_timeout",
              timeoutSeconds: 10,
              task: () => sandbox.process.deleteSession(sessionId),
            }).catch(() => undefined);
          }
        },
        catch: (cause) =>
          toDaytonaServiceError(
            cause,
            "executeCommand",
            `Failed to execute command in Daytona sandbox for thread ${input.threadId}`,
            "daytona_execute_command_error",
          ),
      });

    return {
      getClient,
      createSandbox,
      getSandbox,
      listSandboxes,
      deleteSandbox,
      createThreadSandbox,
      getThreadSandbox,
      ensureThreadSandbox,
      readFile,
      executeCommand,
    };
  });
}
