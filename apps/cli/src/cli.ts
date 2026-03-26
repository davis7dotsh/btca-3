#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Cli from "effect/unstable/cli";
import { parse as parseJsonc } from "jsonc-parser";
import { spawn } from "node:child_process";
import { promises as Fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
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
import {
  getTelemetryStatus,
  runTrackedCliCommand,
  setTelemetryContext,
  setTelemetryEnabled,
  Telemetry,
} from "./telemetry.ts";

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

type ResourceScope = "local" | "global";

type GitResourceInput = {
  readonly type: "git";
  readonly name: string;
  readonly url: string;
  readonly branch?: string;
  readonly searchPath?: string;
  readonly searchPaths?: readonly string[];
  readonly specialNotes?: string;
  readonly scope?: ResourceScope;
};

type LocalResourceInput = {
  readonly type: "local";
  readonly name: string;
  readonly path: string;
  readonly specialNotes?: string;
  readonly scope?: ResourceScope;
};

type NpmResourceInput = {
  readonly type: "npm";
  readonly name: string;
  readonly package: string;
  readonly version?: string;
  readonly specialNotes?: string;
  readonly scope?: ResourceScope;
};

type ResourceInput = GitResourceInput | LocalResourceInput | NpmResourceInput;

type ResourceRecord =
  | Omit<GitResourceInput, "scope">
  | Omit<LocalResourceInput, "scope">
  | Omit<NpmResourceInput, "scope">;

type StoredCliConfig = {
  readonly resources?: readonly {
    readonly name?: unknown;
  }[];
  readonly model?: unknown;
  readonly provider?: unknown;
};

const AUTH_LOCK_DIRECTORY_PATH = `${AUTH_FILE_PATH}.lock`;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_DELAY_MS = 50;
const LOCK_RETRY_ATTEMPTS = 200;
const PROJECT_CONFIG_FILENAME = "btca.config.jsonc";
const GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".config", "btca", PROJECT_CONFIG_FILENAME);
const REFERENCES_DIR = "references";

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

const runTrackedEffectCommand = <A, E, R>(args: {
  readonly command: string;
  readonly mode: string;
  readonly eventName?: string;
  readonly startProperties?: Record<string, unknown>;
  readonly action: Effect.Effect<A, E, R>;
}) =>
  runTrackedCliCommand({
    command: args.command,
    mode: args.mode,
    eventName: args.eventName,
    startProperties: args.startProperties,
    action: args.action,
  });

const parseGitHubUrl = (url: string) => {
  const patterns = [
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(\.git)?$/,
    /^github\.com\/([^/]+)\/([^/]+?)(\.git)?$/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);

    if (match) {
      return {
        owner: match[1]!,
        repo: match[2]!,
      };
    }
  }

  return null;
};

const normalizeGitHubUrl = (url: string) => {
  const parts = parseGitHubUrl(url);

  if (!parts) {
    return url;
  }

  return `https://github.com/${parts.owner}/${parts.repo}`;
};

const NPM_PACKAGE_SEGMENT_REGEX = /^[a-z0-9][a-z0-9._-]*$/;
const NPM_VERSION_OR_TAG_REGEX = /^[^\s/]+$/;

const isValidNpmPackageName = (name: string) => {
  if (name.startsWith("@")) {
    const [scope, pkg, ...rest] = name.split("/");

    return (
      rest.length === 0 &&
      !!scope &&
      scope.length > 1 &&
      !!pkg &&
      NPM_PACKAGE_SEGMENT_REGEX.test(scope.slice(1)) &&
      NPM_PACKAGE_SEGMENT_REGEX.test(pkg)
    );
  }

  return !name.includes("/") && NPM_PACKAGE_SEGMENT_REGEX.test(name);
};

const splitNpmSpec = (spec: string) => {
  if (!spec) {
    return null;
  }

  if (spec.startsWith("@")) {
    const secondAt = spec.indexOf("@", 1);

    if (secondAt === -1) {
      return {
        packageName: spec,
      };
    }

    const packageName = spec.slice(0, secondAt);
    const version = spec.slice(secondAt + 1);
    return version ? { packageName, version } : null;
  }

  const at = spec.lastIndexOf("@");

  if (at <= 0) {
    return {
      packageName: spec,
    };
  }

  const packageName = spec.slice(0, at);
  const version = spec.slice(at + 1);
  return version ? { packageName, version } : null;
};

const safeDecodeUriComponent = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

const parseNpmFromUrl = (reference: string) => {
  let parsed: URL;

  try {
    parsed = new URL(reference);
  } catch {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();

  if (parsed.protocol !== "https:" || (hostname !== "npmjs.com" && hostname !== "www.npmjs.com")) {
    return null;
  }

  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);

  if (segments[0] !== "package") {
    return null;
  }

  const packageParts = segments[1]?.startsWith("@") ? segments.slice(1, 3) : segments.slice(1, 2);

  if (packageParts.length === 0 || packageParts.some((part) => !part)) {
    return null;
  }

  const decodedPackageParts = packageParts.map(safeDecodeUriComponent);

  if (decodedPackageParts.some((part) => !part)) {
    return null;
  }

  const packageName = decodedPackageParts.join("/");

  if (!isValidNpmPackageName(packageName)) {
    return null;
  }

  const remainder = segments.slice(1 + packageParts.length);

  if (remainder.length === 0) {
    return {
      packageName,
    };
  }

  if (remainder.length === 2 && remainder[0] === "v") {
    const version = safeDecodeUriComponent(remainder[1]!);

    if (!version || !NPM_VERSION_OR_TAG_REGEX.test(version)) {
      return null;
    }

    return {
      packageName,
      version,
    };
  }

  return null;
};

const parseNpmReference = (reference: string) => {
  const trimmed = reference.trim();

  if (!trimmed) {
    return null;
  }

  const fromUrl = parseNpmFromUrl(trimmed);

  if (fromUrl) {
    return fromUrl;
  }

  const spec = trimmed.startsWith("npm:") ? trimmed.slice(4) : trimmed;
  const parsed = splitNpmSpec(spec);

  if (!parsed || !isValidNpmPackageName(parsed.packageName)) {
    return null;
  }

  if (parsed.version && !NPM_VERSION_OR_TAG_REGEX.test(parsed.version)) {
    return null;
  }

  return parsed;
};

const parseResourceInput = (args: {
  readonly reference: string;
  readonly type?: string;
  readonly name?: string;
  readonly branch?: string;
  readonly searchPaths: readonly string[];
  readonly notes?: string;
  readonly scope?: ResourceScope;
}): ResourceInput => {
  const trimmedReference = args.reference.trim();
  const inferredType =
    args.type ??
    (parseGitHubUrl(trimmedReference) || trimmedReference.startsWith("git:")
      ? "git"
      : parseNpmReference(trimmedReference)
        ? "npm"
        : "local");

  if (inferredType === "git") {
    const gitReference = trimmedReference.startsWith("git:")
      ? trimmedReference.slice("git:".length).trim()
      : trimmedReference;
    const normalizedUrl = normalizeGitHubUrl(gitReference);
    const repoName = parseGitHubUrl(normalizedUrl)?.repo ?? path.basename(normalizedUrl);

    return {
      type: "git",
      name: args.name?.trim() || repoName,
      url: normalizedUrl,
      branch: args.branch?.trim() || undefined,
      searchPath: args.searchPaths.length === 1 ? args.searchPaths[0] : undefined,
      searchPaths: args.searchPaths.length > 1 ? args.searchPaths : undefined,
      specialNotes: args.notes?.trim() || undefined,
      scope: args.scope,
    };
  }

  if (inferredType === "npm") {
    const parsed = parseNpmReference(trimmedReference);

    if (!parsed) {
      throw new Error(`Invalid npm reference "${trimmedReference}".`);
    }

    return {
      type: "npm",
      name: args.name?.trim() || parsed.packageName,
      package: parsed.packageName,
      version: parsed.version,
      specialNotes: args.notes?.trim() || undefined,
      scope: args.scope,
    };
  }

  const resolvedPath = path.resolve(
    trimmedReference.startsWith("file:") ? trimmedReference.slice(5) : trimmedReference,
  );

  return {
    type: "local",
    name: args.name?.trim() || path.basename(resolvedPath),
    path: resolvedPath,
    specialNotes: args.notes?.trim() || undefined,
    scope: args.scope,
  };
};

const formatResourceLocation = (resource: ResourceRecord) => {
  if (resource.type === "git") {
    return `${resource.url}${resource.branch ? `#${resource.branch}` : ""}`;
  }

  if (resource.type === "local") {
    return resource.path;
  }

  return `${resource.package}${resource.version ? `@${resource.version}` : ""}`;
};

const selectResourceName = (resources: readonly ResourceRecord[]) =>
  promptSelection(
    "Choose a resource to remove:",
    resources.map((resource) => ({
      label: `${resource.name} (${formatResourceLocation(resource)})`,
      value: resource.name,
    })),
  );

const trimTrailingSlashes = (value: string) => value.replace(/[\\/]+$/, "");

const extractRepoName = (reference: string) => {
  const trimmed = reference.trim();

  if (!trimmed) {
    throw new Error("Repository argument is required.");
  }

  const normalized = trimTrailingSlashes(trimmed).replace(/\.git$/, "");
  const splitIndex = ["/", "\\", ":"].reduce(
    (index, separator) => Math.max(index, normalized.lastIndexOf(separator)),
    -1,
  );
  const repoName = (splitIndex >= 0 ? normalized.slice(splitIndex + 1) : normalized).trim();

  if (!repoName || repoName === "." || repoName === "..") {
    throw new Error(`Could not determine repository name from reference: ${reference}`);
  }

  return repoName;
};

const resolveGitRoot = async (cwd: string) => {
  const result = await Effect.runPromise(
    Effect.tryPromise({
      try: () =>
        new Promise<string | null>((resolve) => {
          const proc = spawn("git", ["rev-parse", "--show-toplevel"], {
            cwd,
            stdio: ["ignore", "pipe", "ignore"],
          });

          let output = "";

          proc.stdout?.on("data", (chunk) => {
            output += chunk.toString();
          });

          proc.on("close", (code) => {
            resolve(code === 0 ? output.trim() || null : null);
          });
        }),
      catch: () => null,
    }),
  );

  return result;
};

const ensureReferencesExclude = async (cwd: string, referencesDir: string) => {
  const gitRoot = await resolveGitRoot(cwd);

  if (!gitRoot) {
    return {
      kind: "not-git-repo" as const,
    };
  }

  const excludePath = path.join(gitRoot, ".git", "info", "exclude");
  await Fs.mkdir(path.dirname(excludePath), { recursive: true });
  const relative = path
    .relative(gitRoot, referencesDir)
    .replace(/\\/g, "/")
    .replace(/^\.\/?/, "")
    .replace(/\/+$/, "");
  const excludePattern = relative.length > 0 ? `${relative}/` : `${REFERENCES_DIR}/`;

  let existing = "";

  try {
    existing = await Fs.readFile(excludePath, "utf8");
  } catch {
    existing = "";
  }

  const lines = existing.split("\n").map((line) => line.trim());
  const patterns = [excludePattern.replace(/\/$/, ""), excludePattern, `${excludePattern}*`];

  if (lines.some((line) => line.length > 0 && !line.startsWith("#") && patterns.includes(line))) {
    return {
      kind: "already-excluded" as const,
      pattern: excludePattern,
    };
  }

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await Fs.writeFile(excludePath, `${existing}${prefix}${excludePattern}\n`, "utf8");

  return {
    kind: "added-exclude" as const,
    pattern: excludePattern,
  };
};

const cloneReference = (repo: string, destination: string) =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn("git", ["clone", repo, destination], {
          stdio: "inherit",
        });

        child.on("close", (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`git clone failed with exit code ${code}`));
          }
        });
      }),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

const readConfigFile = (configPath: string) =>
  Effect.tryPromise({
    try: async () => {
      try {
        const content = await Fs.readFile(configPath, "utf8");
        return parseJsonc(content) as StoredCliConfig;
      } catch (cause) {
        if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") {
          return null;
        }

        throw cause;
      }
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

const listResourceNames = (config: StoredCliConfig | null) =>
  Array.isArray(config?.resources)
    ? config.resources.flatMap((resource) =>
        resource && typeof resource === "object" && typeof resource.name === "string"
          ? [resource.name]
          : [],
      )
    : [];

const trackServerModelContext = (server: {
  readonly getConfig: () => Effect.Effect<
    {
      readonly model: {
        readonly provider: string;
        readonly model: string;
      };
    },
    unknown
  >;
}) =>
  Effect.gen(function* () {
    const config = yield* server.getConfig().pipe(Effect.option);

    if (config._tag === "Some") {
      yield* setTelemetryContext({
        model: config.value.model.model,
        provider: config.value.model.provider,
      });
    }
  });

const formatTelemetryStatus = (status: {
  readonly envDisabled: boolean;
  readonly enabled: boolean;
  readonly distinctId: string | null;
}) => {
  if (status.envDisabled) {
    return "Telemetry is disabled via BTCA_TELEMETRY=0.";
  }

  if (!status.enabled) {
    return "Telemetry is disabled.";
  }

  return `Telemetry is enabled.\nAnonymous ID: ${status.distinctId ?? "pending"}`;
};

const connect = Cli.Command.make("connect", {}, () =>
  runTrackedEffectCommand({
    command: "connect",
    mode: "connect",
    action: Effect.gen(function* () {
      const server = yield* Server;
      yield* trackServerModelContext(server);
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
  }),
).pipe(Cli.Command.withDescription("Connect an AI provider and store credentials in auth.json."));

const disconnect = Cli.Command.make("disconnect", {}, () =>
  runTrackedEffectCommand({
    command: "disconnect",
    mode: "disconnect",
    action: Effect.gen(function* () {
      const server = yield* Server;
      yield* trackServerModelContext(server);
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
  }),
).pipe(
  Cli.Command.withDescription("Disconnect a provider by removing its stored auth.json credential."),
);

const btca = Cli.Command.make("btca").pipe(
  Cli.Command.withDescription("BTCA command line tools."),
  Cli.Command.withSharedFlags(serverFlags),
);

const hello = Cli.Command.make("hello", {}, () =>
  runTrackedEffectCommand({
    command: "hello",
    mode: "hello",
    action: Effect.gen(function* () {
      const server = yield* Server;
      const response = yield* server.hello("world");

      yield* Console.log(response.message);
    }),
  }),
).pipe(Cli.Command.withDescription("Print a friendly hello world."));

const serve = Cli.Command.make("serve", {}, () =>
  Effect.gen(function* () {
    const server = yield* Server;

    yield* Console.log(server.baseUrl);
    return yield* Effect.never;
  }),
).pipe(Cli.Command.withDescription("Start the local BTCA HTTP server and keep it running."));

const add = Cli.Command.make(
  "add",
  {
    reference: Cli.Flag.string("reference").pipe(
      Cli.Flag.withDescription("Git URL, local path, or npm reference to add."),
    ),
    name: Cli.Flag.optional(
      Cli.Flag.string("name").pipe(Cli.Flag.withDescription("Override the resource name.")),
    ),
    type: Cli.Flag.optional(
      Cli.Flag.string("type").pipe(
        Cli.Flag.withDescription('Resource type override: "git", "local", or "npm".'),
      ),
    ),
    branch: Cli.Flag.optional(
      Cli.Flag.string("branch").pipe(Cli.Flag.withDescription("Git branch to pin.")),
    ),
    searchPaths: Cli.Flag.string("search-path").pipe(
      Cli.Flag.atLeast(0),
      Cli.Flag.withDescription("Optional git subdirectory to focus on. Repeat for multiple."),
    ),
    notes: Cli.Flag.optional(
      Cli.Flag.string("notes").pipe(Cli.Flag.withDescription("Optional notes for the resource.")),
    ),
    global: Cli.Flag.boolean("global").pipe(
      Cli.Flag.withDescription("Save this resource in the global config instead of the local one."),
    ),
  },
  ({ reference, name, type, branch, searchPaths, notes, global }) =>
    runTrackedEffectCommand({
      command: "add",
      mode: "add",
      startProperties: {
        global,
        type: type._tag === "Some" ? type.value : undefined,
      },
      action: Effect.gen(function* () {
        const server = yield* Server;
        yield* trackServerModelContext(server);
        const resource = parseResourceInput({
          reference,
          name: name._tag === "Some" ? name.value : undefined,
          type: type._tag === "Some" ? type.value : undefined,
          branch: branch._tag === "Some" ? branch.value : undefined,
          searchPaths,
          notes: notes._tag === "Some" ? notes.value : undefined,
          scope: global ? "global" : "local",
        });

        yield* server.addResource(resource);
        yield* Console.log(`Added resource: ${resource.name}`);
      }),
    }),
).pipe(Cli.Command.withDescription("Add a git, local, or npm resource to BTCA config."));

const resources = Cli.Command.make("resources", {}, () =>
  runTrackedEffectCommand({
    command: "resources",
    mode: "resources",
    action: Effect.gen(function* () {
      const server = yield* Server;
      const response = yield* server.getResources();

      if (response.resources.length === 0) {
        yield* Console.log("No resources configured.");
        return;
      }

      yield* Console.log("Configured resources:");

      for (const resource of response.resources) {
        yield* Console.log(`- ${resource.name} (${resource.type})`);

        if (resource.type === "git") {
          yield* Console.log(`  URL: ${resource.url}`);
          if (resource.branch) {
            yield* Console.log(`  Branch: ${resource.branch}`);
          }
          if (resource.searchPaths && resource.searchPaths.length > 0) {
            yield* Console.log(`  Search Paths: ${resource.searchPaths.join(", ")}`);
          } else if (resource.searchPath) {
            yield* Console.log(`  Search Path: ${resource.searchPath}`);
          }
        } else if (resource.type === "local") {
          yield* Console.log(`  Path: ${resource.path}`);
        } else {
          yield* Console.log(
            `  Package: ${resource.package}${resource.version ? `@${resource.version}` : ""}`,
          );
        }

        if ("specialNotes" in resource && resource.specialNotes) {
          yield* Console.log(`  Notes: ${resource.specialNotes}`);
        }
      }
    }),
  }),
).pipe(Cli.Command.withDescription("List configured BTCA resources."));

const remove = Cli.Command.make(
  "remove",
  {
    name: Cli.Flag.optional(
      Cli.Flag.string("name").pipe(Cli.Flag.withDescription("Resource name to remove.")),
    ),
  },
  ({ name }) =>
    runTrackedEffectCommand({
      command: "remove",
      mode: "remove",
      startProperties: {
        hasName: name._tag === "Some",
      },
      action: Effect.gen(function* () {
        const server = yield* Server;
        yield* trackServerModelContext(server);
        const resourcesResponse = yield* server.getResources();

        if (resourcesResponse.resources.length === 0) {
          yield* Console.log("No resources configured.");
          return;
        }

        const selectedName =
          name._tag === "Some"
            ? name.value
            : yield* selectResourceName(resourcesResponse.resources);

        yield* server.removeResource(selectedName);
        yield* Console.log(`Removed resource: ${selectedName}`);
      }),
    }),
).pipe(Cli.Command.withDescription("Remove a configured BTCA resource."));

const reference = Cli.Command.make(
  "reference",
  {
    repo: Cli.Flag.string("repo").pipe(Cli.Flag.withDescription("Repository URL to clone.")),
  },
  ({ repo }) =>
    runTrackedEffectCommand({
      command: "reference",
      mode: "reference",
      startProperties: {
        repo,
      },
      action: Effect.gen(function* () {
        const cwd = process.cwd();
        const repoName = extractRepoName(repo);
        const referencesDir = path.join(cwd, REFERENCES_DIR);
        const destination = path.join(referencesDir, repoName);

        const exists = yield* Effect.tryPromise({
          try: async () => {
            try {
              await Fs.access(destination);
              return true;
            } catch {
              return false;
            }
          },
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        });

        if (exists) {
          return yield* Effect.fail(
            new Error(`Reference destination already exists: ${destination}`),
          );
        }

        yield* Effect.tryPromise({
          try: () => Fs.mkdir(referencesDir, { recursive: true }),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        });

        const excludeStatus = yield* Effect.tryPromise({
          try: () => ensureReferencesExclude(cwd, referencesDir),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        });

        yield* Console.log(`Cloning ${repo} into ${destination}...`);
        yield* cloneReference(repo, destination);
        yield* Console.log(`Reference cloned: ${destination}`);

        if (excludeStatus.kind === "added-exclude") {
          yield* Console.log(`Added '${excludeStatus.pattern}' to .git/info/exclude`);
        } else if (excludeStatus.kind === "already-excluded") {
          yield* Console.log(`'${excludeStatus.pattern}' is already present in .git/info/exclude`);
        } else {
          yield* Console.log(
            "Warning: current directory is not a git repository, so .git/info/exclude was not updated.",
          );
        }
      }),
    }),
).pipe(
  Cli.Command.withDescription("Clone a repository into ./references for local reference use."),
);

const status = Cli.Command.make("status", {}, () =>
  runTrackedEffectCommand({
    command: "status",
    mode: "status",
    action: Effect.gen(function* () {
      const server = yield* Server;
      const [configResponse, auth, globalConfig, projectConfig] = yield* Effect.all([
        server.getConfig(),
        server.getAuthState(),
        readConfigFile(GLOBAL_CONFIG_PATH),
        readConfigFile(path.join(process.cwd(), PROJECT_CONFIG_FILENAME)),
      ]);

      const activeProvider = auth.providers[configResponse.model.provider as AuthProviderId];

      yield* Console.log("BTCA status");
      yield* Console.log(`- Model: ${configResponse.model.model}`);
      yield* Console.log(
        `- Provider: ${configResponse.model.provider} (${configResponse.model.scope})`,
      );
      yield* Console.log(`- Data directory: ${configResponse.config.dataDirectory}`);
      yield* Console.log(
        `- Loaded config paths: ${configResponse.config.loadedConfigPaths.join(", ") || "none"}`,
      );
      yield* Console.log(`- Resource count: ${configResponse.config.resources.length}`);

      if (activeProvider) {
        yield* Console.log(
          `- Active provider auth: ${activeProvider.configured ? `${activeProvider.source}` : "not connected"}`,
        );
      }

      const globalResources = listResourceNames(globalConfig);
      const projectResources = listResourceNames(projectConfig);

      yield* Console.log(
        `- Global resources: ${globalResources.length > 0 ? globalResources.join(", ") : "none"}`,
      );
      yield* Console.log(
        `- Project resources: ${projectResources.length > 0 ? projectResources.join(", ") : "none"}`,
      );
    }),
  }),
).pipe(Cli.Command.withDescription("Print current BTCA config and resource status."));

const telemetry = Cli.Command.make("telemetry").pipe(
  Cli.Command.withSubcommands([
    Cli.Command.make("on", {}, () =>
      runTrackedEffectCommand({
        command: "telemetry",
        mode: "telemetry:on",
        eventName: "telemetry_on",
        action: Effect.gen(function* () {
          const config = yield* setTelemetryEnabled(true);
          yield* Console.log("Telemetry enabled.");
          yield* Console.log(`Anonymous ID: ${config.distinctId}`);
        }),
      }),
    ),
    Cli.Command.make("off", {}, () =>
      runTrackedEffectCommand({
        command: "telemetry",
        mode: "telemetry:off",
        eventName: "telemetry_off",
        action: Effect.gen(function* () {
          yield* setTelemetryEnabled(false);
          yield* Console.log("Telemetry disabled.");
        }),
      }),
    ),
    Cli.Command.make("status", {}, () =>
      runTrackedEffectCommand({
        command: "telemetry",
        mode: "telemetry:status",
        eventName: "telemetry_status",
        action: Effect.gen(function* () {
          const telemetryStatus = yield* getTelemetryStatus;
          yield* Console.log(formatTelemetryStatus(telemetryStatus));
        }),
      }),
    ),
  ]),
);

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

const formatRunMetrics = (value: unknown) => {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const priceUsd = typeof record.priceUsd === "number" ? record.priceUsd : null;
  const totalToolCalls = typeof record.totalToolCalls === "number" ? record.totalToolCalls : null;
  const outputTokensPerSecond =
    typeof record.outputTokensPerSecond === "number" ? record.outputTokensPerSecond : null;

  if (priceUsd === null && totalToolCalls === null && outputTokensPerSecond === null) {
    return null;
  }

  return [
    "Run metrics",
    `  price: ${priceUsd === null ? "n/a" : `$${priceUsd.toFixed(4)}`}`,
    `  tool calls: ${totalToolCalls === null ? "n/a" : totalToolCalls}`,
    `  output tps: ${outputTokensPerSecond === null ? "n/a" : outputTokensPerSecond.toFixed(1)}`,
  ].join("\n");
};

const summarizeResources = (payload: Record<string, unknown>) => {
  const resourceNames = Array.isArray(payload.resourceNames)
    ? payload.resourceNames.filter((value): value is string => typeof value === "string")
    : [];

  if (resourceNames.length === 0) {
    return "resources";
  }

  if (resourceNames.length === 1) {
    return resourceNames[0]!;
  }

  return `${resourceNames[0]} +${resourceNames.length - 1} more`;
};

const getCompactToolStep = (toolName: string) => {
  switch (toolName) {
    case "read_file":
      return "Reading files";
    case "exec_command":
      return "Searching workspace";
    default:
      return "Working";
  }
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

const printAskStream = ({
  stream,
  debug,
}: {
  stream: ReadableStream<Uint8Array>;
  debug: boolean;
}) =>
  Effect.tryPromise({
    try: async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantLineOpen = false;
      let failedMessage: string | null = null;
      let compactStatus: string | null = null;
      let startedAssistantOutput = false;

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

      const setCompactStatus = (nextStatus: string) => {
        if (debug || startedAssistantOutput || compactStatus === nextStatus) {
          return;
        }

        process.stdout.write(`${nextStatus}...\n`);
        compactStatus = nextStatus;
      };

      const handleEvent = (eventName: string, data: unknown) => {
        if (eventName === "start" && data && typeof data === "object") {
          ensureTrailingBreak();
          if (debug) {
            process.stdout.write(`${formatStart(data as Record<string, unknown>)}`);
          } else {
            setCompactStatus(`Loading ${summarizeResources(data as Record<string, unknown>)}`);
          }
          return;
        }

        if (eventName === "done") {
          ensureTrailingBreak();
          if (failedMessage === null && debug) {
            process.stdout.write("\nDone.\n");
          }
          return;
        }

        if (eventName === "error" && data && typeof data === "object") {
          ensureTrailingBreak();
          const message =
            "message" in data && typeof data.message === "string"
              ? data.message
              : JSON.stringify(data, null, 2);

          if (failedMessage !== message) {
            failedMessage = message;
            process.stdout.write(`Error: ${message}\n`);
          }
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

              startedAssistantOutput = true;

              if (!assistantLineOpen) {
                ensureTrailingBreak();
                if (debug) {
                  process.stdout.write("Assistant: ");
                }
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
                if (debug) {
                  printTool(`Tool: ${name}`, args);
                } else {
                  setCompactStatus(getCompactToolStep(name));
                }
              }
            }
          }

          return;
        }

        if (outerEvent.type === "message_end") {
          const message = "message" in outerEvent ? outerEvent.message : null;

          if (message && typeof message === "object" && "role" in message) {
            if (
              message.role === "assistant" &&
              "stopReason" in message &&
              message.stopReason === "error"
            ) {
              const errorMessage =
                "errorMessage" in message && typeof message.errorMessage === "string"
                  ? message.errorMessage
                  : "The model request failed.";

              ensureTrailingBreak();
              if (failedMessage !== errorMessage) {
                failedMessage = errorMessage;
                process.stdout.write(`Error: ${errorMessage}\n`);
              }
              return;
            }

            if (message.role === "assistant" && assistantLineOpen) {
              process.stdout.write("\n");
              assistantLineOpen = false;
            }
          }
        }

        if (outerEvent.type === "agent_end") {
          const metrics =
            "runMetrics" in outerEvent ? formatRunMetrics(outerEvent.runMetrics) : null;

          if (metrics && debug) {
            ensureTrailingBreak();
            process.stdout.write(`${metrics}\n`);
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
        'Configured resource name to load, or an anonymous "file:", "git:", or "npm:" reference. Repeat -r for multiple resources.',
      ),
    ),
  },
  ({ question, resources }) =>
    runTrackedEffectCommand({
      command: "ask",
      mode: "ask",
      startProperties: {
        resourceCount: resources.length,
      },
      action: Effect.gen(function* () {
        const server = yield* Server;
        yield* trackServerModelContext(server);
        const stream = yield* server.askStream({
          question,
          resourceNames: resources,
        });

        yield* printAskStream({
          stream,
          debug: !server.quiet,
        });
      }),
    }),
).pipe(
  Cli.Command.withDescription(
    "Ask the local BTCA agent a question and print a readable live transcript.",
  ),
);

const app = btca.pipe(
  Cli.Command.withSubcommands([
    hello,
    serve,
    ask,
    connect,
    disconnect,
    add,
    reference,
    remove,
    resources,
    status,
    telemetry,
  ]),
  Cli.Command.provideEffect(Telemetry, () => Telemetry.make({ cliVersion: version })),
  Cli.Command.provideEffect(Server, ({ port, url, debug }) => Server.make({ port, url, debug })),
);

const program = Effect.scoped(
  Cli.Command.run(app, {
    version,
  }),
);

const main = program.pipe(Effect.provide(NodeServices.layer), Effect.orDie) as Effect.Effect<
  never,
  never,
  never
>;

NodeRuntime.runMain(main);
