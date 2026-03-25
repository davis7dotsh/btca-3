import path from "node:path";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";

import { Config, type ResourceDefinition } from "../config.ts";
import type { LoadedResource } from "./types.ts";
import { materializeGitResource } from "./impls/git.ts";
import { materializeLocalResource } from "./impls/local.ts";
import { materializeNpmResource } from "./impls/npm.ts";

const toResourceKey = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "resource";

export class ResourceError extends Data.TaggedError("ResourceError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

type ResourcesServiceShape = {
  readonly listConfiguredResources: Effect.Effect<readonly ResourceDefinition[]>;
  readonly loadByName: (name: string) => Effect.Effect<LoadedResource, ResourceError>;
  readonly loadManyByName: (
    names: readonly string[],
  ) => Effect.Effect<readonly LoadedResource[], ResourceError>;
};

const buildInstructions = (resource: ResourceDefinition) => {
  const notes = resource.specialNotes?.trim();

  switch (resource.type) {
    case "git":
      return [`Git resource: ${resource.url} (${resource.branch})`, ...(notes ? [notes] : [])];
    case "local":
      return [`Local resource copied from: ${resource.path}`, ...(notes ? [notes] : [])];
    case "npm":
      return [
        `NPM resource: ${resource.package}${resource.version ? `@${resource.version}` : ""}`,
        ...(notes ? [notes] : []),
      ];
  }
};

export class ResourcesService extends ServiceMap.Service<ResourcesService, ResourcesServiceShape>()(
  "btca-server/ResourcesService",
) {
  static readonly layer = Layer.effect(
    ResourcesService,
    Effect.gen(function* () {
      const config = yield* Config;

      const listConfiguredResources = config.listResources;

      const loadDefinition = (definition: ResourceDefinition) =>
        config.snapshot.pipe(
          Effect.map((snapshot) => {
            const cacheRoot = path.join(snapshot.dataDirectory, "resource-cache", definition.type);
            const instructions = buildInstructions(definition);
            const name = toResourceKey(definition.name);

            const loadedResource: LoadedResource =
              definition.type === "git"
                ? {
                    kind: definition.type,
                    name,
                    definition,
                    instructions,
                    materialize: ({ targetDir }) =>
                      materializeGitResource({
                        resource: definition,
                        targetDir,
                        cacheRoot,
                      }).pipe(
                        Effect.mapError(
                          (cause) =>
                            new ResourceError({
                              message: `Failed to materialize git resource "${definition.name}".`,
                              cause,
                            }),
                        ),
                      ),
                  }
                : definition.type === "local"
                  ? {
                      kind: definition.type,
                      name,
                      definition,
                      instructions,
                      materialize: ({ targetDir }) =>
                        materializeLocalResource({
                          resource: definition,
                          targetDir,
                        }).pipe(
                          Effect.mapError(
                            (cause) =>
                              new ResourceError({
                                message: `Failed to materialize local resource "${definition.name}".`,
                                cause,
                              }),
                          ),
                        ),
                    }
                  : {
                      kind: definition.type,
                      name,
                      definition,
                      instructions,
                      materialize: ({ targetDir }) =>
                        materializeNpmResource({
                          resource: definition,
                          targetDir,
                          cacheRoot,
                        }).pipe(
                          Effect.mapError(
                            (cause) =>
                              new ResourceError({
                                message: `Failed to materialize npm resource "${definition.name}".`,
                                cause,
                              }),
                          ),
                        ),
                    };

            return loadedResource;
          }),
        );

      return {
        listConfiguredResources,
        loadByName: (name) =>
          Effect.gen(function* () {
            const definition = yield* config.getResource(name);

            if (definition === undefined) {
              return yield* Effect.fail(
                new ResourceError({
                  message: `Resource "${name}" was not found in the current config.`,
                }),
              );
            }

            return yield* loadDefinition(definition);
          }),
        loadManyByName: (names) =>
          Effect.gen(function* () {
            const uniqueNames = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
            return yield* Effect.forEach(uniqueNames, (name) =>
              Effect.gen(function* () {
                const definition = yield* config.getResource(name);

                if (definition === undefined) {
                  return yield* Effect.fail(
                    new ResourceError({
                      message: `Resource "${name}" was not found in the current config.`,
                    }),
                  );
                }

                return yield* loadDefinition(definition);
              }),
            );
          }),
      } satisfies ResourcesServiceShape;
    }),
  );
}
