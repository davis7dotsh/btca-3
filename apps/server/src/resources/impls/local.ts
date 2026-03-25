import { promises as Fs } from "node:fs";
import path from "node:path";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { ResourceDefinition } from "../../config.ts";

const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".turbo",
  ".next",
  ".svelte-kit",
  ".cache",
  "coverage",
  "dist",
  "build",
  "out",
  "node_modules",
]);

export class LocalResourceError extends Data.TaggedError("LocalResourceError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const shouldIgnorePath = (sourcePath: string) =>
  sourcePath
    .split(path.sep)
    .some((segment) => segment.length > 0 && IGNORED_DIRECTORY_NAMES.has(segment));

export const materializeLocalResource = (args: {
  resource: Extract<ResourceDefinition, { type: "local" }>;
  targetDir: string;
}) =>
  Effect.tryPromise({
    try: async () => {
      const resolvedSource = path.resolve(args.resource.path);
      await Fs.mkdir(args.targetDir, { recursive: true });
      await Fs.cp(resolvedSource, args.targetDir, {
        recursive: true,
        force: true,
        filter: (sourcePath) => !shouldIgnorePath(sourcePath),
      });

      return {
        mountPath: args.targetDir,
      };
    },
    catch: (cause) =>
      new LocalResourceError({
        message: `Failed to materialize local resource "${args.resource.name}".`,
        cause,
      }),
  });
