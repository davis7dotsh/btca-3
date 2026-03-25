#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Cli from "effect/unstable/cli";
import { promises as Fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import * as readline from "node:readline/promises";
import util from "node:util";
import {
  AUTH_FILE_PATH,
  AUTH_FILE_VERSION,
  getOAuthProvider,
  isAuthProviderId,
  type AuthProviderId,
  type AuthState,
  type OAuthLoginCallbacks,
  SUPPORTED_AUTH_PROVIDERS,
} from "@btca/server";
import { Server } from "./server.ts";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

type StoredApiKeyCredential = {
  readonly type: "api_key";
  readonly key: string;
};

type StoredOAuthCredential = {
  readonly type: "oauth";
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly metadata?: Readonly<Record<string, string>>;
};

type StoredCredential = StoredApiKeyCredential | StoredOAuthCredential;

type StoredAuthFile = Partial<Record<AuthProviderId, StoredCredential>>;

const AUTH_LOCK_DIRECTORY_PATH = `${AUTH_FILE_PATH}.lock`;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_DELAY_MS = 50;
const LOCK_RETRY_ATTEMPTS = 200;

const serverFlags = {
  debug: Cli.Flag.boolean("debug").pipe(
    Cli.Flag.withDescription("Print embedded server logs and request debugging output."),
  ),
  port: Cli.Flag.optional(
    Cli.Flag.integer("port").pipe(
      Cli.Flag.withDescription(
        "Start an embedded server on this port. Fails if the port is taken.",
      ),
    ),
  ),
  url: Cli.Flag.optional(
    Cli.Flag.string("url").pipe(
      Cli.Flag.withDescription(
        "Use an existing BTCA server at this URL instead of starting one locally.",
      ),
    ),
  ),
};

const authFileTemplate = (): StoredAuthFile => ({});

const serializeAuthFile = (value: StoredAuthFile) => `${JSON.stringify(value, null, 2)}\n`;

const parseStoredCredential = (value: unknown): StoredCredential | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  if (record.type === "api_key" && typeof record.key === "string" && record.key.trim().length > 0) {
    return {
      type: "api_key",
      key: record.key.trim(),
    };
  }

  if (
    record.type === "oauth" &&
    typeof record.access === "string" &&
    typeof record.refresh === "string" &&
    typeof record.expires === "number" &&
    Number.isFinite(record.expires)
  ) {
    const metadata =
      typeof record.metadata === "object" && record.metadata !== null
        ? Object.fromEntries(
            Object.entries(record.metadata).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : undefined;

    return {
      type: "oauth",
      access: record.access,
      refresh: record.refresh,
      expires: record.expires,
      metadata,
    };
  }

  return undefined;
};

const parseAuthFile = (content: string): StoredAuthFile => {
  if (content.trim().length === 0) {
    return authFileTemplate();
  }

  const parsed = JSON.parse(content) as unknown;

  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const flatProviders = Object.fromEntries(
      Object.entries(parsed).flatMap(([provider, value]) => {
        if (!isAuthProviderId(provider)) {
          return [];
        }

        const credential = parseStoredCredential(value);
        return credential ? ([[provider, credential]] as const) : [];
      }),
    ) as StoredAuthFile;

    if (Object.keys(flatProviders).length > 0) {
      return flatProviders;
    }
  }

  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "version" in parsed &&
    parsed.version === AUTH_FILE_VERSION &&
    "providers" in parsed &&
    typeof parsed.providers === "object" &&
    parsed.providers !== null
  ) {
    return Object.fromEntries(
      Object.entries(parsed.providers).flatMap(([provider, value]) => {
        if (!isAuthProviderId(provider)) {
          return [];
        }

        const credential = parseStoredCredential(value);
        return credential ? ([[provider, credential]] as const) : [];
      }),
    ) as StoredAuthFile;
  }

  return authFileTemplate();
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const acquireAuthFileLock = async () => {
  for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await Fs.mkdir(AUTH_LOCK_DIRECTORY_PATH);
      return;
    } catch (cause) {
      if (!(cause && typeof cause === "object" && "code" in cause && cause.code === "EEXIST")) {
        throw cause;
      }

      try {
        const stats = await Fs.stat(AUTH_LOCK_DIRECTORY_PATH);
        if (Date.now() - stats.mtimeMs > LOCK_STALE_MS) {
          await Fs.rm(AUTH_LOCK_DIRECTORY_PATH, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Ignore disappearing lock races and retry.
      }

      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }

  throw new Error("Timed out waiting for the BTCA auth file lock.");
};

const releaseAuthFileLock = () => Fs.rm(AUTH_LOCK_DIRECTORY_PATH, { recursive: true, force: true });

const withAuthFileLock = <A>(fn: (current: StoredAuthFile) => Promise<A>) =>
  Effect.tryPromise({
    try: async () => {
      await Fs.mkdir(path.dirname(AUTH_FILE_PATH), {
        recursive: true,
        mode: 0o700,
      });

      try {
        await Fs.access(AUTH_FILE_PATH);
      } catch (cause) {
        if (!(cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT")) {
          throw cause;
        }

        await Fs.writeFile(AUTH_FILE_PATH, serializeAuthFile(authFileTemplate()), {
          encoding: "utf8",
          mode: 0o600,
        });
      }

      await acquireAuthFileLock();

      try {
        const content = await Fs.readFile(AUTH_FILE_PATH, "utf8");
        const current = parseAuthFile(content);
        return await fn(current);
      } finally {
        await releaseAuthFileLock();
      }
    },
    catch: (cause) =>
      new Error(
        cause instanceof Error
          ? cause.message
          : `Failed to update credentials in ${AUTH_FILE_PATH}.`,
      ),
  });

const persistOAuthCredential = (provider: AuthProviderId, credentials: StoredOAuthCredential) =>
  withAuthFileLock(async (current) => {
    const next: StoredAuthFile = {
      ...current,
      [provider]: credentials,
    };

    const temporaryPath = `${AUTH_FILE_PATH}.${Date.now()}.tmp`;
    await Fs.writeFile(temporaryPath, serializeAuthFile(next), {
      encoding: "utf8",
      mode: 0o600,
    });
    await Fs.rename(temporaryPath, AUTH_FILE_PATH);
  });

const promptLine = (question: string) =>
  Effect.tryPromise({
    try: async () => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      try {
        return (await rl.question(question)).trim();
      } finally {
        rl.close();
      }
    },
    catch: (cause) =>
      new Error(cause instanceof Error ? cause.message : "Failed to read input from the terminal."),
  });

const promptSelection = <A>(
  title: string,
  options: readonly {
    readonly label: string;
    readonly value: A;
  }[],
) =>
  Effect.gen(function* () {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return yield* Effect.fail(
        new Error("The connect and disconnect commands require an interactive terminal."),
      );
    }

    yield* Console.log(title);

    for (const [index, option] of options.entries()) {
      yield* Console.log(`  ${index + 1}. ${option.label}`);
    }

    while (true) {
      const response = yield* promptLine("Choose a number: ");
      const selectedIndex = Number.parseInt(response, 10);

      if (
        Number.isInteger(selectedIndex) &&
        selectedIndex >= 1 &&
        selectedIndex <= options.length
      ) {
        return options[selectedIndex - 1]!.value;
      }

      yield* Console.log(`Enter a number between 1 and ${options.length}.`);
    }
  });

const promptApiKey = (providerLabel: string) =>
  promptLine(`API key for ${providerLabel}: `).pipe(
    Effect.flatMap((value) =>
      value.length > 0
        ? Effect.succeed(value)
        : Effect.fail(new Error("API key must not be empty.")),
    ),
  );

const providerStatusLabel = (auth: AuthState, provider: AuthProviderId) => {
  const state = auth.providers[provider];
  const status = state.configured ? `${state.source}` : "not connected";
  return `${state.label} (${state.kind}, ${status})`;
};

const buildOAuthCallbacks = (): OAuthLoginCallbacks => ({
  onAuth: ({ url, instructions }) =>
    Promise.resolve().then(() => {
      console.log("");
      console.log(`Open this URL to continue:\n${url}`);
      if (instructions) {
        console.log(instructions);
      }
      console.log("");
    }),
  onPrompt: ({ message, placeholder }) =>
    Effect.runPromise(promptLine(`${message}${placeholder ? ` (${placeholder})` : ""} `)),
  onProgress: (message) =>
    Promise.resolve().then(() => {
      console.log(message);
    }),
});

const connect = Cli.Command.make("connect", {}, () =>
  Effect.gen(function* () {
    const server = yield* Server;
    const auth = yield* server.getAuthState();
    const selectedProvider = yield* promptSelection(
      "Choose a provider to connect:",
      SUPPORTED_AUTH_PROVIDERS.map((provider) => ({
        value: provider,
        label: providerStatusLabel(auth, provider),
      })),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new Error(cause instanceof Error ? cause.message : "Failed to choose a provider."),
      ),
    );
    const providerState = auth.providers[selectedProvider];

    if (providerState.kind === "api_key") {
      const apiKey = yield* promptApiKey(providerState.label);
      yield* server.loginApiKey(selectedProvider, apiKey);
      yield* Console.log(`Connected ${providerState.label}.`);
      return;
    }

    const oauthProvider = getOAuthProvider(selectedProvider);

    if (!oauthProvider) {
      return yield* Effect.fail(new Error(`OAuth is not available for ${providerState.label}.`));
    }

    const credentials = yield* Effect.tryPromise({
      try: async () => oauthProvider.login(buildOAuthCallbacks()),
      catch: (cause) =>
        new Error(
          cause instanceof Error
            ? cause.message
            : `Failed to complete OAuth login for ${providerState.label}.`,
        ),
    });

    const metadataEntries = Object.entries(credentials).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "access" &&
        entry[0] !== "refresh" &&
        entry[0] !== "expires" &&
        typeof entry[1] === "string",
    );

    yield* persistOAuthCredential(selectedProvider, {
      type: "oauth",
      access: credentials.access,
      refresh: credentials.refresh,
      expires: credentials.expires,
      metadata: metadataEntries.length > 0 ? Object.fromEntries(metadataEntries) : undefined,
    });

    const refreshedAuth = yield* server.getAuthState();
    const refreshedProvider = refreshedAuth.providers[selectedProvider];

    if (!refreshedProvider.configured) {
      yield* Console.log(
        `Saved ${providerState.label} credentials to ${AUTH_FILE_PATH}, but the current server did not pick them up.`,
      );
      return;
    }

    yield* Console.log(`Connected ${providerState.label}.`);
  }),
).pipe(Cli.Command.withDescription("Connect an AI provider and store credentials in auth.json."));

const disconnect = Cli.Command.make("disconnect", {}, () =>
  Effect.gen(function* () {
    const server = yield* Server;
    const auth = yield* server.getAuthState();
    const connectedProviders = SUPPORTED_AUTH_PROVIDERS.filter(
      (provider) => auth.providers[provider].source === "auth-file",
    );

    if (connectedProviders.length === 0) {
      yield* Console.log("No providers are currently connected through auth.json.");
      return;
    }

    const selectedProvider = yield* promptSelection(
      "Choose a provider to disconnect:",
      connectedProviders.map((provider) => ({
        value: provider,
        label: providerStatusLabel(auth, provider),
      })),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new Error(cause instanceof Error ? cause.message : "Failed to choose a provider."),
      ),
    );

    yield* server.logout(selectedProvider);
    yield* Console.log(`Disconnected ${auth.providers[selectedProvider].label}.`);
  }),
).pipe(
  Cli.Command.withDescription("Disconnect a provider by removing its stored auth.json credential."),
);

const btca = Cli.Command.make("btca").pipe(
  Cli.Command.withDescription("BTCA command line tools."),
  Cli.Command.withSharedFlags(serverFlags),
);

const hello = Cli.Command.make("hello", {}, () =>
  Effect.gen(function* () {
    const server = yield* Server;
    const response = yield* server.hello("world");

    yield* Console.log(response.message);
  }),
).pipe(Cli.Command.withDescription("Print a friendly hello world."));

const serve = Cli.Command.make("serve", {}, () =>
  Effect.gen(function* () {
    const server = yield* Server;

    yield* Console.log(server.baseUrl);
    return yield* Effect.never;
  }),
).pipe(Cli.Command.withDescription("Start the local BTCA HTTP server and keep it running."));

const truncate = (value: string, max = 160) =>
  value.length <= max ? value : `${value.slice(0, max - 1)}...`;

const formatToolArgs = (value: unknown) => {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return truncate(value);
  }

  return truncate(
    util.inspect(value, {
      depth: 3,
      breakLength: 120,
      compact: true,
      sorted: true,
    }),
  );
};

const formatStart = (payload: Record<string, unknown>) => {
  const provider = typeof payload.provider === "string" ? payload.provider : "unknown";
  const modelId = typeof payload.modelId === "string" ? payload.modelId : "unknown";
  const threadId = typeof payload.threadId === "string" ? payload.threadId : "unknown";
  const workspaceDir = typeof payload.workspaceDir === "string" ? payload.workspaceDir : "unknown";
  const resourceNames = Array.isArray(payload.resourceNames)
    ? payload.resourceNames.filter((value): value is string => typeof value === "string")
    : [];

  return [
    "Agent ready",
    `  model: ${provider}/${modelId}`,
    `  thread: ${threadId}`,
    `  resources: ${resourceNames.join(", ") || "none"}`,
    `  workspace: ${workspaceDir}`,
    "",
  ].join("\n");
};

const parseSseEvent = (rawEvent: string) => {
  const lines = rawEvent.split(/\r?\n/);
  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  const rawData = dataLines.join("\n");
  const data =
    rawData.length === 0
      ? null
      : (() => {
          try {
            return JSON.parse(rawData) as unknown;
          } catch {
            return rawData;
          }
        })();

  return {
    eventName,
    data,
  };
};

const printAskStream = (stream: ReadableStream<Uint8Array>) =>
  Effect.tryPromise({
    try: async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantLineOpen = false;

      const ensureTrailingBreak = () => {
        if (assistantLineOpen) {
          process.stdout.write("\n");
          assistantLineOpen = false;
        }
      };

      const printTool = (label: string, args: unknown) => {
        ensureTrailingBreak();
        const renderedArgs = formatToolArgs(args);
        process.stdout.write(renderedArgs.length > 0 ? `${label} ${renderedArgs}\n` : `${label}\n`);
      };

      const handleEvent = (eventName: string, data: unknown) => {
        if (eventName === "start" && data && typeof data === "object") {
          ensureTrailingBreak();
          process.stdout.write(`${formatStart(data as Record<string, unknown>)}`);
          return;
        }

        if (eventName === "done") {
          ensureTrailingBreak();
          process.stdout.write("\nDone.\n");
          return;
        }

        if (eventName === "error" && data && typeof data === "object") {
          ensureTrailingBreak();
          process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
          return;
        }

        if (!data || typeof data !== "object" || !("event" in data)) {
          return;
        }

        const outerEvent = data.event;

        if (!outerEvent || typeof outerEvent !== "object" || !("type" in outerEvent)) {
          return;
        }

        if (outerEvent.type === "message_update") {
          const assistantMessageEvent =
            "assistantMessageEvent" in outerEvent ? outerEvent.assistantMessageEvent : null;

          if (
            assistantMessageEvent &&
            typeof assistantMessageEvent === "object" &&
            "type" in assistantMessageEvent
          ) {
            if (assistantMessageEvent.type === "text_delta") {
              const delta =
                "delta" in assistantMessageEvent && typeof assistantMessageEvent.delta === "string"
                  ? assistantMessageEvent.delta
                  : "";

              if (!assistantLineOpen) {
                ensureTrailingBreak();
                process.stdout.write("Assistant: ");
                assistantLineOpen = true;
              }

              process.stdout.write(delta);
              return;
            }

            if (assistantMessageEvent.type === "toolcall_end") {
              const toolCall =
                "toolCall" in assistantMessageEvent ? assistantMessageEvent.toolCall : null;

              if (toolCall && typeof toolCall === "object" && "name" in toolCall) {
                const name = typeof toolCall.name === "string" ? toolCall.name : "tool";
                const args =
                  "arguments" in toolCall && toolCall.arguments !== null
                    ? toolCall.arguments
                    : undefined;
                printTool(`Tool: ${name}`, args);
              }
            }
          }

          return;
        }

        if (outerEvent.type === "message_end") {
          const message = "message" in outerEvent ? outerEvent.message : null;

          if (message && typeof message === "object" && "role" in message) {
            if (message.role === "assistant" && assistantLineOpen) {
              process.stdout.write("\n");
              assistantLineOpen = false;
            }
          }
        }
      };

      for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });

        while (true) {
          const boundaryIndex = buffer.indexOf("\n\n");

          if (boundaryIndex === -1) {
            break;
          }

          const rawEvent = buffer.slice(0, boundaryIndex).trim();
          buffer = buffer.slice(boundaryIndex + 2);

          if (rawEvent.length === 0) {
            continue;
          }

          const parsedEvent = parseSseEvent(rawEvent);
          handleEvent(parsedEvent.eventName, parsedEvent.data);
        }
      }

      buffer += decoder.decode();

      const remainingEvent = buffer.trim();

      if (remainingEvent.length > 0) {
        const parsedEvent = parseSseEvent(remainingEvent);
        handleEvent(parsedEvent.eventName, parsedEvent.data);
      }

      ensureTrailingBreak();
    },
    catch: (cause) =>
      new Error(
        cause instanceof Error ? cause.message : "Failed to print the /ask response stream.",
      ),
  });

const ask = Cli.Command.make(
  "ask",
  {
    question: Cli.Flag.string("question").pipe(
      Cli.Flag.withAlias("q"),
      Cli.Flag.withDescription("Question to send to the local BTCA agent."),
    ),
    resources: Cli.Flag.string("resource").pipe(
      Cli.Flag.withAlias("r"),
      Cli.Flag.atLeast(1),
      Cli.Flag.withDescription(
        "Configured resource name to load. Repeat -r for multiple resources.",
      ),
    ),
  },
  ({ question, resources }) =>
    Effect.gen(function* () {
      const server = yield* Server;
      const stream = yield* server.askStream({
        question,
        resourceNames: resources,
      });

      yield* printAskStream(stream);
    }),
).pipe(
  Cli.Command.withDescription(
    "Ask the local BTCA agent a question and print a readable live transcript.",
  ),
);

const app = btca.pipe(
  Cli.Command.withSubcommands([hello, serve, ask, connect, disconnect]),
  Cli.Command.provideEffect(Server, ({ port, url, debug }) => Server.make({ port, url, debug })),
);

const program = Effect.scoped(
  Cli.Command.run(app, {
    version,
  }),
);

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer), Effect.orDie));
