import { createHash } from "node:crypto";
import { promises as Fs } from "node:fs";
import path from "node:path";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { ResourceDefinition } from "../../config.ts";
import { runProcess } from "../../shared/process.ts";

const createCacheKey = (input: string) =>
  createHash("sha256").update(input).digest("hex").slice(0, 12);

const getPackageReference = (resource: Extract<ResourceDefinition, { type: "npm" }>) =>
  resource.version ? `${resource.package}@${resource.version}` : resource.package;

export class NpmResourceError extends Data.TaggedError("NpmResourceError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const ensurePackageCache = (args: {
  resource: Extract<ResourceDefinition, { type: "npm" }>;
  cacheRoot: string;
}) =>
  Effect.gen(function* () {
    const reference = getPackageReference(args.resource);
    const cacheKey = createCacheKey(reference);
    const packageCacheRoot = path.join(args.cacheRoot, `${args.resource.name}-${cacheKey}`);
    const installRoot = path.join(packageCacheRoot, "install");
    const packageDirectory = path.join(
      installRoot,
      "node_modules",
      ...args.resource.package.split("/"),
    );

    const exists = yield* Effect.tryPromise({
      try: async () => {
        try {
          const stats = await Fs.stat(packageDirectory);
          return stats.isDirectory();
        } catch (cause) {
          if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") {
            return false;
          }

          throw cause;
        }
      },
      catch: (cause) =>
        new NpmResourceError({
          message: `Failed to inspect the npm cache for "${args.resource.name}".`,
          cause,
        }),
    });

    if (!exists) {
      yield* Effect.tryPromise({
        try: async () => {
          await Fs.rm(packageCacheRoot, { recursive: true, force: true });
          await Fs.mkdir(installRoot, { recursive: true });
          await Fs.writeFile(
            path.join(installRoot, "package.json"),
            JSON.stringify(
              {
                name: "btca-resource-cache",
                private: true,
              },
              null,
              2,
            ),
            "utf8",
          );
        },
        catch: (cause) =>
          new NpmResourceError({
            message: `Failed to prepare the npm cache for "${args.resource.name}".`,
            cause,
          }),
      });

      const installResult = yield* runProcess({
        command: "npm",
        args: ["install", "--ignore-scripts", "--no-save", reference],
        cwd: installRoot,
        timeoutMs: 120_000,
        env: {
          npm_config_fund: "false",
          npm_config_audit: "false",
        },
      }).pipe(
        Effect.mapError(
          (cause) =>
            new NpmResourceError({
              message: `Failed to install npm resource "${args.resource.name}".`,
              cause,
            }),
        ),
      );

      if (installResult.exitCode !== 0) {
        return yield* Effect.fail(
          new NpmResourceError({
            message: `npm install failed for "${args.resource.name}": ${installResult.stderr || installResult.stdout}`,
          }),
        );
      }
    }

    return packageDirectory;
  });

export const materializeNpmResource = (args: {
  resource: Extract<ResourceDefinition, { type: "npm" }>;
  targetDir: string;
  cacheRoot: string;
}) =>
  Effect.gen(function* () {
    const packageDirectory = yield* ensurePackageCache({
      resource: args.resource,
      cacheRoot: args.cacheRoot,
    });

    yield* Effect.tryPromise({
      try: async () => {
        await Fs.mkdir(path.dirname(args.targetDir), { recursive: true });
        await Fs.cp(packageDirectory, args.targetDir, {
          recursive: true,
          force: true,
        });
      },
      catch: (cause) =>
        new NpmResourceError({
          message: `Failed to materialize npm resource "${args.resource.name}".`,
          cause,
        }),
    });

    return {
      mountPath: args.targetDir,
    };
  });
