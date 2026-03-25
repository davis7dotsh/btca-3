import { promises as Fs } from "node:fs";
import path from "node:path";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";

import { Config } from "../config.ts";
import type { LoadedResource } from "../resources/types.ts";
import { runProcess } from "../shared/process.ts";

const MAX_OUTPUT_LENGTH = 50_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

const shellForPlatform = () => {
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      argsPrefix: ["/d", "/s", "/c"],
    };
  }

  return {
    command: process.env.SHELL || "/bin/bash",
    argsPrefix: ["-lc"],
  };
};

const truncateOutput = (value: string) =>
  value.length <= MAX_OUTPUT_LENGTH ? value : `${value.slice(0, MAX_OUTPUT_LENGTH)}\n\n[truncated]`;

const sanitizePathSegment = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "resource";

const ensurePathInsideRoot = (rootPath: string, requestedPath: string) => {
  const resolvedPath = path.resolve(rootPath, requestedPath);
  const relative = path.relative(rootPath, resolvedPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path "${requestedPath}" escapes the workspace.`);
  }

  return resolvedPath;
};

const commandLooksDangerous = (command: string) => {
  const lower = command.toLowerCase();

  return (
    lower.includes("sudo ") ||
    lower.includes(" rm -rf /") ||
    lower.startsWith("rm -rf /") ||
    lower.includes("shutdown") ||
    lower.includes("reboot") ||
    lower.includes("mkfs") ||
    lower.includes("diskutil erase") ||
    lower.includes("format c:") ||
    lower.includes("../") ||
    /(^|[\s"'`])\/(users|home|etc|var|private|system|applications)\b/i.test(command) ||
    /(^|[\s"'`])[a-z]:\\/i.test(command)
  );
};

const readTextFileSlice = (contents: string, startLine?: number, endLine?: number) => {
  const lines = contents.split(/\r?\n/u);
  const start = startLine ? Math.max(1, startLine) : 1;
  const end = endLine ? Math.max(start, endLine) : lines.length;

  return lines.slice(start - 1, end).join("\n");
};

export class WorkspaceError extends Data.TaggedError("WorkspaceError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

type PreparedWorkspace = {
  readonly threadId: string;
  readonly workspaceRoot: string;
  readonly resourcesRoot: string;
  readonly metadataPath: string;
};

type WorkspaceServiceShape = {
  readonly prepareThreadWorkspace: (args: {
    threadId: string;
    resources: readonly LoadedResource[];
  }) => Effect.Effect<PreparedWorkspace, WorkspaceError>;
  readonly getThreadWorkspace: (
    threadId: string,
  ) => Effect.Effect<PreparedWorkspace, WorkspaceError>;
  readonly execCommand: (args: {
    threadId: string;
    command: string;
    cwd?: string;
  }) => Effect.Effect<
    {
      command: string;
      cwd: string;
      exitCode: number;
      stdout: string;
      stderr: string;
    },
    WorkspaceError
  >;
  readonly readFile: (args: {
    threadId: string;
    path: string;
    startLine?: number;
    endLine?: number;
  }) => Effect.Effect<
    {
      path: string;
      content: string;
    },
    WorkspaceError
  >;
  readonly cleanupThreadWorkspace: (threadId: string) => Effect.Effect<void, WorkspaceError>;
};

export class WorkspaceService extends ServiceMap.Service<WorkspaceService, WorkspaceServiceShape>()(
  "btca-server/WorkspaceService",
) {
  static readonly layer = Layer.effect(
    WorkspaceService,
    Effect.gen(function* () {
      const config = yield* Config;

      const getWorkspacePaths = (threadId: string) =>
        config.snapshot.pipe(
          Effect.map((snapshot) => {
            const threadRoot = path.join(snapshot.dataDirectory, "agent-workspaces", threadId);
            const workspaceRoot = path.join(threadRoot, "workspace");
            const resourcesRoot = path.join(workspaceRoot, "resources");
            const metadataPath = path.join(workspaceRoot, "meta", "resources.json");

            return {
              threadId,
              workspaceRoot,
              resourcesRoot,
              metadataPath,
            } satisfies PreparedWorkspace;
          }),
        );

      return {
        prepareThreadWorkspace: ({ threadId, resources }) =>
          Effect.gen(function* () {
            const paths = yield* getWorkspacePaths(threadId);

            yield* Effect.tryPromise({
              try: async () => {
                await Fs.rm(paths.workspaceRoot, { recursive: true, force: true });
                await Fs.mkdir(paths.resourcesRoot, { recursive: true });
                await Fs.mkdir(path.dirname(paths.metadataPath), { recursive: true });
              },
              catch: (cause) =>
                new WorkspaceError({
                  message: `Failed to prepare workspace for thread "${threadId}".`,
                  cause,
                }),
            });

            const materialized = yield* Effect.forEach(resources, (resource) =>
              Effect.gen(function* () {
                const mountPath = path.join(
                  paths.resourcesRoot,
                  sanitizePathSegment(resource.name),
                );
                const result = yield* resource.materialize({ targetDir: mountPath }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new WorkspaceError({
                        message: `Failed to materialize resource "${resource.definition.name}".`,
                        cause,
                      }),
                  ),
                );

                return {
                  name: resource.definition.name,
                  kind: resource.kind,
                  mountPath: result.mountPath,
                  instructions: resource.instructions,
                };
              }),
            );

            yield* Effect.tryPromise({
              try: async () => {
                await Fs.writeFile(
                  paths.metadataPath,
                  JSON.stringify(materialized, null, 2),
                  "utf8",
                );
                await Fs.writeFile(
                  path.join(path.dirname(paths.metadataPath), "instructions.md"),
                  [
                    "# Workspace Resources",
                    "",
                    ...materialized.flatMap((resource) => [
                      `## ${resource.name}`,
                      `- kind: ${resource.kind}`,
                      `- mountPath: ${path.relative(paths.workspaceRoot, resource.mountPath)}`,
                      ...resource.instructions.map((instruction) => `- note: ${instruction}`),
                      "",
                    ]),
                  ].join("\n"),
                  "utf8",
                );
              },
              catch: (cause) =>
                new WorkspaceError({
                  message: `Failed to write workspace metadata for thread "${threadId}".`,
                  cause,
                }),
            });

            return paths;
          }),
        getThreadWorkspace: (threadId) =>
          Effect.gen(function* () {
            const paths = yield* getWorkspacePaths(threadId);

            const exists = yield* Effect.tryPromise({
              try: async () => {
                try {
                  const stats = await Fs.stat(paths.workspaceRoot);
                  return stats.isDirectory();
                } catch (cause) {
                  if (
                    cause &&
                    typeof cause === "object" &&
                    "code" in cause &&
                    cause.code === "ENOENT"
                  ) {
                    return false;
                  }

                  throw cause;
                }
              },
              catch: (cause) =>
                new WorkspaceError({
                  message: `Failed to inspect workspace for thread "${threadId}".`,
                  cause,
                }),
            });

            if (!exists) {
              return yield* Effect.fail(
                new WorkspaceError({
                  message: `Workspace for thread "${threadId}" does not exist yet.`,
                }),
              );
            }

            return paths;
          }),
        execCommand: ({ threadId, command, cwd }) =>
          Effect.gen(function* () {
            if (commandLooksDangerous(command)) {
              return yield* Effect.fail(
                new WorkspaceError({
                  message: "Command rejected by workspace safety policy.",
                }),
              );
            }

            const workspace = yield* getWorkspacePaths(threadId);
            const resolvedCwd = ensurePathInsideRoot(workspace.workspaceRoot, cwd ?? ".");
            const shell = shellForPlatform();
            const result = yield* runProcess({
              command: shell.command,
              args: [...shell.argsPrefix, command],
              cwd: resolvedCwd,
              timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
              env: {
                HOME: workspace.workspaceRoot,
                USERPROFILE: workspace.workspaceRoot,
                TMPDIR: path.join(workspace.workspaceRoot, ".tmp"),
                TEMP: path.join(workspace.workspaceRoot, ".tmp"),
                TMP: path.join(workspace.workspaceRoot, ".tmp"),
                BTCA_WORKSPACE_DIR: workspace.workspaceRoot,
              },
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new WorkspaceError({
                    message: "Failed to execute command in workspace.",
                    cause,
                  }),
              ),
            );

            return {
              command,
              cwd: resolvedCwd,
              exitCode: result.exitCode,
              stdout: truncateOutput(result.stdout),
              stderr: truncateOutput(result.stderr),
            };
          }),
        readFile: ({ threadId, path: filePath, startLine, endLine }) =>
          Effect.gen(function* () {
            const workspace = yield* getWorkspacePaths(threadId);
            const resolvedPath = ensurePathInsideRoot(workspace.workspaceRoot, filePath);

            const content = yield* Effect.tryPromise({
              try: async () => {
                const fullContents = await Fs.readFile(resolvedPath, "utf8");
                return readTextFileSlice(fullContents, startLine, endLine);
              },
              catch: (cause) =>
                new WorkspaceError({
                  message: `Failed to read "${filePath}" from the workspace.`,
                  cause,
                }),
            });

            return {
              path: resolvedPath,
              content,
            };
          }),
        cleanupThreadWorkspace: (threadId) =>
          Effect.gen(function* () {
            const workspace = yield* getWorkspacePaths(threadId);

            yield* Effect.tryPromise({
              try: () =>
                Fs.rm(path.dirname(workspace.workspaceRoot), { recursive: true, force: true }),
              catch: (cause) =>
                new WorkspaceError({
                  message: `Failed to clean up workspace for thread "${threadId}".`,
                  cause,
                }),
            });
          }),
      } satisfies WorkspaceServiceShape;
    }),
  );
}
