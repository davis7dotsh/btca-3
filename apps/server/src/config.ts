import { promises as Fs } from "node:fs";
import path from "node:path";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as ServiceMap from "effect/ServiceMap";
import { parse } from "jsonc-parser";

export const GLOBAL_CONFIG_DIR = "~/.config/btca";
export const GLOBAL_CONFIG_FILENAME = "btca.config.jsonc";
export const PROJECT_CONFIG_FILENAME = "btca.config.jsonc";
export const GLOBAL_DATA_DIR = "~/.local/share/btca";
export const CONFIG_SCHEMA_URL = "https://btca.dev/btca.schema.json";

export const DEFAULT_MODEL = "gpt-5.4-mini";
export const DEFAULT_PROVIDER = "openai";
export const DEFAULT_PROVIDER_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_STEPS = 40;

type ProviderOptions = {
  readonly baseURL?: string;
  readonly name?: string;
};

type ProviderOptionsMap = Record<string, ProviderOptions>;

type GitResource = {
  readonly type: "git";
  readonly name: string;
  readonly url: string;
  readonly branch?: string;
  readonly searchPath?: string;
  readonly searchPaths?: readonly string[];
  readonly specialNotes?: string;
};

type LocalResource = {
  readonly type: "local";
  readonly name: string;
  readonly path: string;
  readonly specialNotes?: string;
};

type NpmResource = {
  readonly type: "npm";
  readonly name: string;
  readonly package: string;
  readonly version?: string;
  readonly specialNotes?: string;
};

export type ResourceDefinition = GitResource | LocalResource | NpmResource;

type StoredConfig = {
  readonly $schema?: string;
  readonly dataDirectory?: string;
  readonly providerTimeoutMs?: number;
  readonly maxSteps?: number;
  readonly resources?: readonly ResourceDefinition[];
  readonly model?: string;
  readonly provider?: string;
  readonly providerOptions?: ProviderOptionsMap;
};

type ConfigScope = "default" | "global" | "local";

type ConfigSnapshot = {
  readonly startupDirectory: string;
  readonly globalConfigPath: string;
  readonly localConfigPath: string;
  readonly loadedConfigPaths: readonly string[];
  readonly dataDirectory: string;
  readonly providerTimeoutMs: number;
  readonly maxSteps: number;
  readonly model: string;
  readonly provider: string;
  readonly providerOptions: ProviderOptionsMap;
  readonly resources: readonly ResourceDefinition[];
  readonly scopes: {
    readonly model: ConfigScope;
    readonly resources: Readonly<Record<string, ConfigScope>>;
  };
};

type ConfigService = {
  readonly snapshot: Effect.Effect<ConfigSnapshot>;
  readonly getModel: Effect.Effect<{
    readonly provider: string;
    readonly model: string;
    readonly providerOptions: ProviderOptionsMap;
    readonly providerTimeoutMs: number;
    readonly maxSteps: number;
    readonly scope: ConfigScope;
  }>;
  readonly listResources: Effect.Effect<readonly ResourceDefinition[]>;
  readonly getResource: (name: string) => Effect.Effect<ResourceDefinition | undefined>;
  readonly getProviderOptions: (providerId: string) => Effect.Effect<ProviderOptions | undefined>;
  readonly addResource: (
    resource: ResourceDefinition,
    scope?: Exclude<ConfigScope, "default">,
  ) => Effect.Effect<ResourceDefinition, ConfigError>;
  readonly removeResource: (name: string) => Effect.Effect<void, ConfigError>;
  readonly reload: Effect.Effect<void, ConfigError>;
};

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly message: string;
  readonly path?: string;
  readonly cause?: unknown;
}> {}

export class Config extends ServiceMap.Service<Config, ConfigService>()("Config") {}

export const DEFAULT_RESOURCES: readonly ResourceDefinition[] = [
  {
    name: "svelte",
    specialNotes:
      "This is the svelte docs website repo, not the actual svelte repo. Focus on the content directory, it has all the markdown files for the docs.",
    type: "git",
    url: "https://github.com/sveltejs/svelte.dev",
    branch: "main",
    searchPath: "apps/svelte.dev",
  },
  {
    name: "tailwindcss",
    specialNotes:
      "This is the tailwindcss docs website repo, not the actual tailwindcss repo. Use the docs to answer questions about tailwindcss.",
    type: "git",
    url: "https://github.com/tailwindlabs/tailwindcss.com",
    searchPath: "src/docs",
    branch: "main",
  },
  {
    type: "git",
    name: "nextjs",
    url: "https://github.com/vercel/next.js",
    branch: "canary",
    searchPath: "docs",
    specialNotes:
      "These are the docs for the next.js framework, not the actual next.js repo. Use the docs to answer questions about next.js.",
  },
];

const DEFAULT_CONFIG: StoredConfig = {
  $schema: CONFIG_SCHEMA_URL,
  dataDirectory: GLOBAL_DATA_DIR,
  providerTimeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
  maxSteps: DEFAULT_MAX_STEPS,
  model: DEFAULT_MODEL,
  provider: DEFAULT_PROVIDER,
  resources: DEFAULT_RESOURCES,
};

const expandHome = (value: string) => {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";

  if (value.startsWith("~/")) {
    return `${home}${value.slice(1)}`;
  }

  return value;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const failConfig = (message: string, configPath: string, cause?: unknown) =>
  Effect.fail(
    new ConfigError({
      message,
      path: configPath,
      cause,
    }),
  );

const ensureOptionalString = ({
  configPath,
  field,
  value,
}: {
  configPath: string;
  field: string;
  value: unknown;
}) =>
  Effect.gen(function* () {
    if (value === undefined || typeof value === "string") {
      return value;
    }

    return yield* failConfig(`Invalid config field "${field}": expected a string.`, configPath);
  });

const ensureOptionalPositiveInteger = ({
  configPath,
  field,
  value,
}: {
  configPath: string;
  field: string;
  value: unknown;
}): Effect.Effect<number | undefined, ConfigError> =>
  Effect.gen(function* () {
    if (value === undefined) {
      return undefined;
    }

    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return value;
    }

    return yield* failConfig(
      `Invalid config field "${field}": expected a positive integer.`,
      configPath,
    );
  });

const validateProviderOptions = ({
  configPath,
  value,
}: {
  configPath: string;
  value: unknown;
}): Effect.Effect<ProviderOptionsMap | undefined, ConfigError> =>
  Effect.gen(function* () {
    if (value === undefined) {
      return undefined;
    }

    if (!isRecord(value)) {
      return yield* failConfig(
        'Invalid config field "providerOptions": expected an object.',
        configPath,
      );
    }

    const entries = yield* Effect.forEach(Object.entries(value), ([providerId, options]) =>
      Effect.gen(function* () {
        if (!isRecord(options)) {
          return yield* failConfig(
            `Invalid providerOptions entry "${providerId}": expected an object.`,
            configPath,
          );
        }

        return [
          providerId,
          {
            baseURL: yield* ensureOptionalString({
              configPath,
              field: `providerOptions.${providerId}.baseURL`,
              value: options.baseURL,
            }),
            name: yield* ensureOptionalString({
              configPath,
              field: `providerOptions.${providerId}.name`,
              value: options.name,
            }),
          },
        ] satisfies [string, ProviderOptions];
      }),
    );

    return Object.fromEntries(entries);
  });

const validateResource = ({
  configPath,
  index,
  value,
}: {
  configPath: string;
  index: number;
  value: unknown;
}): Effect.Effect<ResourceDefinition, ConfigError> =>
  Effect.gen(function* () {
    if (!isRecord(value)) {
      return yield* failConfig(
        `Invalid resource at index ${index}: expected an object.`,
        configPath,
      );
    }

    const name = yield* ensureOptionalString({
      configPath,
      field: `resources[${index}].name`,
      value: value.name,
    });

    if (!name?.trim()) {
      return yield* failConfig(
        `Invalid resource at index ${index}: "name" is required.`,
        configPath,
      );
    }

    const specialNotes = yield* ensureOptionalString({
      configPath,
      field: `resources[${index}].specialNotes`,
      value: value.specialNotes,
    });

    switch (value.type) {
      case "git": {
        const url = yield* ensureOptionalString({
          configPath,
          field: `resources[${index}].url`,
          value: value.url,
        });
        const branch = yield* ensureOptionalString({
          configPath,
          field: `resources[${index}].branch`,
          value: value.branch,
        });
        const searchPath = yield* ensureOptionalString({
          configPath,
          field: `resources[${index}].searchPath`,
          value: value.searchPath,
        });

        if (value.searchPaths !== undefined && !isStringArray(value.searchPaths)) {
          return yield* failConfig(
            `Invalid config field "resources[${index}].searchPaths": expected an array of strings.`,
            configPath,
          );
        }

        if (!url?.trim()) {
          return yield* failConfig(
            `Invalid git resource "${name}": "url" is required.`,
            configPath,
          );
        }

        return {
          type: "git",
          name: name.trim(),
          url: url.trim(),
          branch: branch?.trim() || undefined,
          searchPath: searchPath?.trim() || undefined,
          searchPaths: value.searchPaths?.map((entry) => entry.trim()).filter(Boolean),
          specialNotes: specialNotes?.trim() || undefined,
        };
      }
      case "local": {
        const resourcePath = yield* ensureOptionalString({
          configPath,
          field: `resources[${index}].path`,
          value: value.path,
        });

        if (!resourcePath?.trim()) {
          return yield* failConfig(
            `Invalid local resource "${name}": "path" is required.`,
            configPath,
          );
        }

        return {
          type: "local",
          name: name.trim(),
          path: resourcePath.trim(),
          specialNotes: specialNotes?.trim() || undefined,
        };
      }
      case "npm": {
        const packageName = yield* ensureOptionalString({
          configPath,
          field: `resources[${index}].package`,
          value: value.package,
        });
        const version = yield* ensureOptionalString({
          configPath,
          field: `resources[${index}].version`,
          value: value.version,
        });

        if (!packageName?.trim()) {
          return yield* failConfig(
            `Invalid npm resource "${name}": "package" is required.`,
            configPath,
          );
        }

        return {
          type: "npm",
          name: name.trim(),
          package: packageName.trim(),
          version: version?.trim() || undefined,
          specialNotes: specialNotes?.trim() || undefined,
        };
      }
      default:
        return yield* failConfig(
          `Invalid resource "${name}": unsupported type "${String(value.type)}".`,
          configPath,
        );
    }
  });

const validateStoredConfig = ({
  configPath,
  value,
}: {
  configPath: string;
  value: unknown;
}): Effect.Effect<StoredConfig, ConfigError> =>
  Effect.gen(function* () {
    if (!isRecord(value)) {
      return yield* failConfig("Invalid config file: expected a top-level object.", configPath);
    }

    if (value.resources !== undefined && !Array.isArray(value.resources)) {
      return yield* failConfig('Invalid config field "resources": expected an array.', configPath);
    }

    return {
      $schema: yield* ensureOptionalString({
        configPath,
        field: "$schema",
        value: value.$schema,
      }),
      dataDirectory: yield* ensureOptionalString({
        configPath,
        field: "dataDirectory",
        value: value.dataDirectory,
      }),
      providerTimeoutMs: yield* ensureOptionalPositiveInteger({
        configPath,
        field: "providerTimeoutMs",
        value: value.providerTimeoutMs,
      }),
      maxSteps: yield* ensureOptionalPositiveInteger({
        configPath,
        field: "maxSteps",
        value: value.maxSteps,
      }),
      model: yield* ensureOptionalString({
        configPath,
        field: "model",
        value: value.model,
      }),
      provider: yield* ensureOptionalString({
        configPath,
        field: "provider",
        value: value.provider,
      }),
      providerOptions: yield* validateProviderOptions({
        configPath,
        value: value.providerOptions,
      }),
      resources: value.resources
        ? yield* Effect.forEach(value.resources, (resource, index) =>
            validateResource({
              configPath,
              index,
              value: resource,
            }),
          )
        : undefined,
    };
  });

const readConfigFile = (configPath: string) =>
  Effect.tryPromise({
    try: async () => {
      let text: string;

      try {
        text = await Fs.readFile(configPath, "utf8");
      } catch (cause) {
        if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") {
          return null;
        }

        throw cause;
      }

      const errors: Parameters<typeof parse>[1] = [];
      const parsed = parse(text, errors, {
        allowTrailingComma: true,
        disallowComments: false,
      });

      if (errors.length > 0) {
        return await Effect.runPromise(
          failConfig(`Failed to parse config file "${configPath}".`, configPath, errors),
        );
      }

      return await Effect.runPromise(
        validateStoredConfig({
          configPath,
          value: parsed,
        }),
      );
    },
    catch: (cause) => {
      if (cause instanceof ConfigError) {
        return cause;
      }

      return new ConfigError({
        message: `Failed to read config file "${configPath}".`,
        path: configPath,
        cause,
      });
    },
  });

const writeConfigFile = ({ configPath, value }: { configPath: string; value: StoredConfig }) =>
  Effect.tryPromise({
    try: async () => {
      await Fs.mkdir(path.dirname(configPath), { recursive: true });
      await Fs.writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    },
    catch: (cause) =>
      new ConfigError({
        message: `Failed to write config file "${configPath}".`,
        path: configPath,
        cause,
      }),
  });

const mergeResources = (
  layers: readonly {
    readonly scope: ConfigScope;
    readonly resources: readonly ResourceDefinition[];
  }[],
) => {
  const resourceMap = new Map<string, ResourceDefinition>();
  const scopes: Record<string, ConfigScope> = {};

  for (const layer of layers) {
    for (const resource of layer.resources) {
      resourceMap.set(resource.name, resource);
      scopes[resource.name] = layer.scope;
    }
  }

  return {
    resources: [...resourceMap.values()],
    scopes,
  };
};

const findNearestLocalConfigPath = async (startupDirectory: string): Promise<string | null> => {
  let currentDirectory = startupDirectory;

  while (true) {
    const candidatePath = path.join(currentDirectory, PROJECT_CONFIG_FILENAME);

    try {
      const stats = await Fs.stat(candidatePath);
      if (stats.isFile()) {
        return candidatePath;
      }
    } catch (cause) {
      if (!(cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT")) {
        throw cause;
      }
    }

    const parentDirectory = path.dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      return null;
    }

    currentDirectory = parentDirectory;
  }
};

const resolveDataDirectory = ({
  startupDirectory,
  globalConfigPath,
  localConfigPath,
  dataDirectory,
  scope,
}: {
  startupDirectory: string;
  globalConfigPath: string;
  localConfigPath: string;
  dataDirectory: string;
  scope: ConfigScope;
}) => {
  const expanded = expandHome(dataDirectory);

  if (path.isAbsolute(expanded)) {
    return expanded;
  }

  const baseDirectory =
    scope === "local"
      ? path.dirname(localConfigPath)
      : scope === "global"
        ? path.dirname(globalConfigPath)
        : startupDirectory;

  return path.resolve(baseDirectory, expanded);
};

const loadSnapshot = (startupDirectory: string) =>
  Effect.gen(function* () {
    const globalConfigPath = path.join(expandHome(GLOBAL_CONFIG_DIR), GLOBAL_CONFIG_FILENAME);
    const localConfigPath =
      (yield* Effect.tryPromise({
        try: () => findNearestLocalConfigPath(startupDirectory),
        catch: (cause) =>
          new ConfigError({
            message: "Failed to discover the local project config.",
            cause,
          }),
      })) ?? path.join(startupDirectory, PROJECT_CONFIG_FILENAME);

    const globalConfig = yield* readConfigFile(globalConfigPath);
    const localConfig = yield* readConfigFile(localConfigPath);

    const modelScope = localConfig?.model ? "local" : globalConfig?.model ? "global" : "default";
    const dataDirectoryScope = localConfig?.dataDirectory
      ? "local"
      : globalConfig?.dataDirectory
        ? "global"
        : "default";

    const providerOptions = {
      ...DEFAULT_CONFIG.providerOptions,
      ...globalConfig?.providerOptions,
      ...localConfig?.providerOptions,
    };
    const mergedResources = mergeResources([
      { scope: "default", resources: DEFAULT_CONFIG.resources ?? [] },
      { scope: "global", resources: globalConfig?.resources ?? [] },
      { scope: "local", resources: localConfig?.resources ?? [] },
    ]);

    return {
      startupDirectory,
      globalConfigPath,
      localConfigPath,
      loadedConfigPaths: [
        ...(globalConfig ? [globalConfigPath] : []),
        ...(localConfig ? [localConfigPath] : []),
      ],
      dataDirectory: resolveDataDirectory({
        startupDirectory,
        globalConfigPath,
        localConfigPath,
        dataDirectory:
          localConfig?.dataDirectory ??
          globalConfig?.dataDirectory ??
          DEFAULT_CONFIG.dataDirectory ??
          GLOBAL_DATA_DIR,
        scope: dataDirectoryScope,
      }),
      providerTimeoutMs:
        localConfig?.providerTimeoutMs ??
        globalConfig?.providerTimeoutMs ??
        DEFAULT_CONFIG.providerTimeoutMs ??
        DEFAULT_PROVIDER_TIMEOUT_MS,
      maxSteps:
        localConfig?.maxSteps ??
        globalConfig?.maxSteps ??
        DEFAULT_CONFIG.maxSteps ??
        DEFAULT_MAX_STEPS,
      model: localConfig?.model ?? globalConfig?.model ?? DEFAULT_CONFIG.model ?? DEFAULT_MODEL,
      provider:
        localConfig?.provider ??
        globalConfig?.provider ??
        DEFAULT_CONFIG.provider ??
        DEFAULT_PROVIDER,
      providerOptions,
      resources: mergedResources.resources,
      scopes: {
        model: modelScope,
        resources: mergedResources.scopes,
      },
    } satisfies ConfigSnapshot;
  });

export const ConfigLive = Layer.effect(
  Config,
  Effect.gen(function* () {
    const startupDirectory = process.cwd();
    const initialSnapshot = yield* loadSnapshot(startupDirectory);
    const ref = yield* Ref.make(initialSnapshot);

    const reloadSnapshot = Effect.gen(function* () {
      const nextSnapshot = yield* loadSnapshot(startupDirectory);
      yield* Ref.set(ref, nextSnapshot);
      return nextSnapshot;
    });

    const getMutableConfigPath = ({
      snapshot,
      scope,
    }: {
      snapshot: ConfigSnapshot;
      scope: Exclude<ConfigScope, "default">;
    }) => (scope === "global" ? snapshot.globalConfigPath : snapshot.localConfigPath);

    return {
      snapshot: Ref.get(ref),
      getModel: Ref.get(ref).pipe(
        Effect.map((snapshot) => ({
          provider: snapshot.provider,
          model: snapshot.model,
          providerOptions: snapshot.providerOptions,
          providerTimeoutMs: snapshot.providerTimeoutMs,
          maxSteps: snapshot.maxSteps,
          scope: snapshot.scopes.model,
        })),
      ),
      listResources: Ref.get(ref).pipe(Effect.map((snapshot) => snapshot.resources)),
      getResource: (name) =>
        Ref.get(ref).pipe(
          Effect.map((snapshot) => snapshot.resources.find((resource) => resource.name === name)),
        ),
      getProviderOptions: (providerId) =>
        Ref.get(ref).pipe(Effect.map((snapshot) => snapshot.providerOptions[providerId])),
      addResource: (resource, scope = "local") =>
        Effect.gen(function* () {
          const snapshot = yield* Ref.get(ref);
          const existingScope = snapshot.scopes.resources[resource.name];

          if (existingScope) {
            return yield* failConfig(
              `Resource "${resource.name}" already exists in the ${existingScope} config.`,
              getMutableConfigPath({ snapshot, scope }),
            );
          }

          const configPath = getMutableConfigPath({ snapshot, scope });
          const currentConfig = (yield* readConfigFile(configPath)) ?? {
            $schema: CONFIG_SCHEMA_URL,
          };
          const nextConfig: StoredConfig = {
            ...currentConfig,
            $schema: currentConfig.$schema ?? CONFIG_SCHEMA_URL,
            resources: [...(currentConfig.resources ?? []), resource],
          };

          yield* writeConfigFile({
            configPath,
            value: nextConfig,
          });

          yield* reloadSnapshot;
          return resource;
        }),
      removeResource: (name) =>
        Effect.gen(function* () {
          const snapshot = yield* Ref.get(ref);
          const scope = snapshot.scopes.resources[name];

          if (!scope) {
            return yield* failConfig(
              `Resource "${name}" does not exist.`,
              snapshot.localConfigPath,
            );
          }

          if (scope === "default") {
            return yield* failConfig(
              `Resource "${name}" is built in and cannot be removed.`,
              snapshot.localConfigPath,
            );
          }

          const configPath = getMutableConfigPath({ snapshot, scope });
          const currentConfig = yield* readConfigFile(configPath);

          if (!currentConfig) {
            return yield* failConfig(`Config file "${configPath}" does not exist.`, configPath);
          }

          const nextResources = (currentConfig.resources ?? []).filter(
            (resource) => resource.name !== name,
          );

          if (nextResources.length === (currentConfig.resources ?? []).length) {
            return yield* failConfig(
              `Resource "${name}" was not found in "${configPath}".`,
              configPath,
            );
          }

          yield* writeConfigFile({
            configPath,
            value: {
              ...currentConfig,
              $schema: currentConfig.$schema ?? CONFIG_SCHEMA_URL,
              resources: nextResources,
            },
          });

          yield* reloadSnapshot;
        }),
      reload: Effect.asVoid(reloadSnapshot),
    } satisfies ConfigService;
  }),
);
