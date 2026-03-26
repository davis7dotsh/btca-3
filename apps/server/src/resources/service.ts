import { createHash } from "node:crypto";
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
  readonly load: (reference: string) => Effect.Effect<LoadedResource, ResourceError>;
  readonly loadMany: (
    references: readonly string[],
  ) => Effect.Effect<readonly LoadedResource[], ResourceError>;
};

const createAnonymousSuffix = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 8);

const createAnonymousName = (prefix: string, label: string, reference: string) =>
  `${prefix}-${toResourceKey(label)}-${createAnonymousSuffix(reference)}`;

const trimTrailingGitSuffix = (value: string) => value.replace(/\/+$/, "").replace(/\.git$/i, "");

const getLastPathSegment = (value: string) => {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) ?? "resource";
};

const parseNpmReference = (
  reference: string,
): {
  readonly packageName: string;
  readonly version?: string;
} => {
  const spec = reference.slice("npm:".length).trim();

  if (spec.length === 0) {
    throw new Error('Anonymous npm resources must include a package after "npm:".');
  }

  const versionSeparatorIndex = spec.startsWith("@") ? spec.lastIndexOf("@") : spec.indexOf("@");

  if (versionSeparatorIndex <= 0) {
    return {
      packageName: spec,
    };
  }

  const packageName = spec.slice(0, versionSeparatorIndex).trim();
  const version = spec.slice(versionSeparatorIndex + 1).trim();

  if (packageName.length === 0) {
    throw new Error('Anonymous npm resources must include a package name after "npm:".');
  }

  return {
    packageName,
    version: version.length > 0 ? version : undefined,
  };
};

const parseAnonymousResource = (reference: string): ResourceDefinition | undefined => {
  const trimmedReference = reference.trim();

  if (trimmedReference.startsWith("file:")) {
    const filePath = trimmedReference.slice("file:".length).trim();

    if (filePath.length === 0) {
      throw new Error('Anonymous file resources must include a path after "file:".');
    }

    const resolvedPath = path.resolve(filePath);
    const label = getLastPathSegment(resolvedPath);

    return {
      type: "local",
      name: createAnonymousName("file", label, trimmedReference),
      path: resolvedPath,
    };
  }

  if (trimmedReference.startsWith("git:")) {
    const url = trimmedReference.slice("git:".length).trim();

    if (url.length === 0) {
      throw new Error('Anonymous git resources must include a URL after "git:".');
    }

    const label = getLastPathSegment(trimTrailingGitSuffix(url));

    return {
      type: "git",
      name: createAnonymousName("git", label, trimmedReference),
      url,
    };
  }

  if (trimmedReference.startsWith("npm:")) {
    const parsed = parseNpmReference(trimmedReference);
    const label = parsed.packageName.replace(/^@/, "").replace(/\//g, "-");

    return {
      type: "npm",
      name: createAnonymousName("npm", label, trimmedReference),
      package: parsed.packageName,
      version: parsed.version,
    };
  }

  return undefined;
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

      const loadResourceReference = (reference: string) =>
        Effect.gen(function* () {
          const trimmedReference = reference.trim();

          if (trimmedReference.length === 0) {
            return yield* Effect.fail(
              new ResourceError({
                message: "Resource reference must not be empty.",
              }),
            );
          }

          const anonymousDefinition = yield* Effect.try({
            try: () => parseAnonymousResource(trimmedReference),
            catch: (cause) =>
              new ResourceError({
                message: `Invalid resource reference "${trimmedReference}".`,
                cause,
              }),
          });

          if (anonymousDefinition) {
            return yield* loadDefinition(anonymousDefinition);
          }

          const configuredDefinition = yield* config.getResource(trimmedReference);

          if (configuredDefinition === undefined) {
            return yield* Effect.fail(
              new ResourceError({
                message: `Resource "${trimmedReference}" was not found in the current config.`,
              }),
            );
          }

          return yield* loadDefinition(configuredDefinition);
        });

      return {
        listConfiguredResources,
        load: loadResourceReference,
        loadMany: (references) =>
          Effect.gen(function* () {
            const uniqueReferences = [
              ...new Set(references.map((reference) => reference.trim()).filter(Boolean)),
            ];

            return yield* Effect.forEach(uniqueReferences, (reference) =>
              loadResourceReference(reference),
            );
          }),
      } satisfies ResourcesServiceShape;
    }),
  );
}
