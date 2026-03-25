import { createHash } from "node:crypto";
import { promises as Fs } from "node:fs";
import path from "node:path";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { ResourceDefinition } from "../../config.ts";
import { runProcess } from "../../shared/process.ts";

const createCacheKey = (input: string) =>
  createHash("sha256").update(input).digest("hex").slice(0, 12);

const normalizeSearchPaths = (
  resource: Extract<ResourceDefinition, { type: "git" }>,
): readonly string[] =>
  [...(resource.searchPaths ?? []), ...(resource.searchPath ? [resource.searchPath] : [])]
    .map((entry) => entry.trim())
    .filter(Boolean);

const resolveSafeSubpath = (rootPath: string, relativePath: string) => {
  const resolvedPath = path.resolve(rootPath, relativePath);
  const relative = path.relative(rootPath, resolvedPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Search path "${relativePath}" escapes the repository root.`);
  }

  return resolvedPath;
};

export class GitResourceError extends Data.TaggedError("GitResourceError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const ensureGitCache = (args: {
  resource: Extract<ResourceDefinition, { type: "git" }>;
  cacheRoot: string;
}) =>
  Effect.gen(function* () {
    const cacheKey = createCacheKey(`${args.resource.url}#${args.resource.branch}`);
    const repoCachePath = path.join(args.cacheRoot, `${args.resource.name}-${cacheKey}`);
    const gitDirectory = path.join(repoCachePath, ".git");

    const hasRepo = yield* Effect.tryPromise({
      try: async () => {
        try {
          const stats = await Fs.stat(gitDirectory);
          return stats.isDirectory();
        } catch (cause) {
          if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") {
            return false;
          }

          throw cause;
        }
      },
      catch: (cause) =>
        new GitResourceError({
          message: `Failed to inspect the git cache for "${args.resource.name}".`,
          cause,
        }),
    });

    if (!hasRepo) {
      yield* Effect.tryPromise({
        try: async () => {
          await Fs.rm(repoCachePath, { recursive: true, force: true });
          await Fs.mkdir(args.cacheRoot, { recursive: true });
        },
        catch: (cause) =>
          new GitResourceError({
            message: `Failed to prepare the git cache for "${args.resource.name}".`,
            cause,
          }),
      });

      const cloneResult = yield* runProcess({
        command: "git",
        args: [
          "clone",
          "--depth",
          "1",
          "--branch",
          args.resource.branch,
          args.resource.url,
          repoCachePath,
        ],
        timeoutMs: 120_000,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new GitResourceError({
              message: `Failed to clone git resource "${args.resource.name}".`,
              cause,
            }),
        ),
      );

      if (cloneResult.exitCode !== 0) {
        return yield* Effect.fail(
          new GitResourceError({
            message: `Git clone failed for "${args.resource.name}": ${cloneResult.stderr || cloneResult.stdout}`,
          }),
        );
      }

      return repoCachePath;
    }

    const fetchResult = yield* runProcess({
      command: "git",
      args: ["fetch", "--depth", "1", "origin", args.resource.branch],
      cwd: repoCachePath,
      timeoutMs: 120_000,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new GitResourceError({
            message: `Failed to update git resource "${args.resource.name}".`,
            cause,
          }),
      ),
    );

    if (fetchResult.exitCode !== 0) {
      return yield* Effect.fail(
        new GitResourceError({
          message: `Git fetch failed for "${args.resource.name}": ${fetchResult.stderr || fetchResult.stdout}`,
        }),
      );
    }

    const checkoutResult = yield* runProcess({
      command: "git",
      args: ["checkout", "--force", "FETCH_HEAD"],
      cwd: repoCachePath,
      timeoutMs: 120_000,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new GitResourceError({
            message: `Failed to check out the latest revision for "${args.resource.name}".`,
            cause,
          }),
      ),
    );

    if (checkoutResult.exitCode !== 0) {
      return yield* Effect.fail(
        new GitResourceError({
          message: `Git checkout failed for "${args.resource.name}": ${checkoutResult.stderr || checkoutResult.stdout}`,
        }),
      );
    }

    return repoCachePath;
  });

export const materializeGitResource = (args: {
  resource: Extract<ResourceDefinition, { type: "git" }>;
  targetDir: string;
  cacheRoot: string;
}) =>
  Effect.gen(function* () {
    const repoCachePath = yield* ensureGitCache({
      resource: args.resource,
      cacheRoot: args.cacheRoot,
    });

    yield* Effect.tryPromise({
      try: async () => {
        await Fs.mkdir(args.targetDir, { recursive: true });

        const searchPaths = normalizeSearchPaths(args.resource);

        if (searchPaths.length === 0) {
          await Fs.cp(repoCachePath, args.targetDir, {
            recursive: true,
            force: true,
            filter: (sourcePath) => !sourcePath.split(path.sep).includes(".git"),
          });
          return;
        }

        for (const relativePath of searchPaths) {
          const sourcePath = resolveSafeSubpath(repoCachePath, relativePath);
          const destinationPath = path.join(args.targetDir, relativePath);
          await Fs.mkdir(path.dirname(destinationPath), { recursive: true });
          await Fs.cp(sourcePath, destinationPath, {
            recursive: true,
            force: true,
            filter: (sourcePath) => !sourcePath.split(path.sep).includes(".git"),
          });
        }
      },
      catch: (cause) =>
        new GitResourceError({
          message: `Failed to materialize git resource "${args.resource.name}".`,
          cause,
        }),
    });

    return {
      mountPath: args.targetDir,
    };
  });
