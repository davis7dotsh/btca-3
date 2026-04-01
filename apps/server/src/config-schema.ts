export const CONFIG_SCHEMA_URL = "https://btca.dev/btca.schema.json";

export const DEFAULT_MODEL = "gpt-5.4-mini";
export const DEFAULT_PROVIDER = "openai";
export const DEFAULT_PROVIDER_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_STEPS = 40;

export type ProviderOptions = {
  readonly baseURL?: string;
  readonly name?: string;
};

export type ProviderOptionsMap = Record<string, ProviderOptions>;

export type GitResource = {
  readonly type: "git";
  readonly name: string;
  readonly url: string;
  readonly branch?: string;
  readonly searchPath?: string;
  readonly searchPaths?: readonly string[];
  readonly specialNotes?: string;
};

export type LocalResource = {
  readonly type: "local";
  readonly name: string;
  readonly path: string;
  readonly specialNotes?: string;
};

export type NpmResource = {
  readonly type: "npm";
  readonly name: string;
  readonly package: string;
  readonly version?: string;
  readonly specialNotes?: string;
};

export type ResourceDefinition = GitResource | LocalResource | NpmResource;

export type StoredConfig = {
  readonly $schema?: string;
  readonly dataDirectory?: string;
  readonly providerTimeoutMs?: number;
  readonly maxSteps?: number;
  readonly resources?: readonly ResourceDefinition[];
  readonly model?: string;
  readonly provider?: string;
  readonly providerOptions?: ProviderOptionsMap;
};

export const DEFAULT_RESOURCES = [
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
] satisfies readonly ResourceDefinition[];

const PROVIDER_OPTIONS_SCHEMA = {
  type: "object",
  properties: {
    baseURL: {
      type: "string",
      description: "Optional provider base URL override.",
    },
    name: {
      type: "string",
      description: "Optional provider display or SDK identifier override.",
    },
  },
} as const;

const GIT_RESOURCE_SCHEMA = {
  type: "object",
  properties: {
    type: {
      const: "git",
      description: "Clone and search a Git repository.",
    },
    name: {
      type: "string",
      minLength: 1,
      description: "Unique resource name used in CLI references like @name.",
    },
    url: {
      type: "string",
      minLength: 1,
      description: "Git repository URL.",
    },
    branch: {
      type: "string",
      description: "Optional branch to clone.",
    },
    searchPath: {
      type: "string",
      description: "Optional primary path inside the repo to search.",
    },
    searchPaths: {
      type: "array",
      items: {
        type: "string",
      },
      description: "Optional list of repo paths to search.",
    },
    specialNotes: {
      type: "string",
      description: "Optional instructions shown to the agent.",
    },
  },
  required: ["type", "name", "url"],
} as const;

const LOCAL_RESOURCE_SCHEMA = {
  type: "object",
  properties: {
    type: {
      const: "local",
      description: "Search a local directory on disk.",
    },
    name: {
      type: "string",
      minLength: 1,
      description: "Unique resource name used in CLI references like @name.",
    },
    path: {
      type: "string",
      minLength: 1,
      description: "Path to the local directory or file.",
    },
    specialNotes: {
      type: "string",
      description: "Optional instructions shown to the agent.",
    },
  },
  required: ["type", "name", "path"],
} as const;

const NPM_RESOURCE_SCHEMA = {
  type: "object",
  properties: {
    type: {
      const: "npm",
      description: "Hydrate and search an npm package.",
    },
    name: {
      type: "string",
      minLength: 1,
      description: "Unique resource name used in CLI references like @name.",
    },
    package: {
      type: "string",
      minLength: 1,
      description: "npm package name.",
    },
    version: {
      type: "string",
      description: "Optional npm version or tag.",
    },
    specialNotes: {
      type: "string",
      description: "Optional instructions shown to the agent.",
    },
  },
  required: ["type", "name", "package"],
} as const;

export const BTCA_CONFIG_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: CONFIG_SCHEMA_URL,
  title: "BTCA Config",
  description: "Schema for btca.config.jsonc used by the BTCA CLI and local server.",
  type: "object",
  properties: {
    $schema: {
      type: "string",
      default: CONFIG_SCHEMA_URL,
      description: "Remote JSON Schema URL for editor support.",
    },
    dataDirectory: {
      type: "string",
      description:
        "Optional BTCA data directory. Relative paths resolve from the active config scope.",
    },
    providerTimeoutMs: {
      type: "integer",
      exclusiveMinimum: 0,
      default: DEFAULT_PROVIDER_TIMEOUT_MS,
      description: "Provider request timeout in milliseconds.",
    },
    maxSteps: {
      type: "integer",
      exclusiveMinimum: 0,
      default: DEFAULT_MAX_STEPS,
      description: "Maximum agent steps per run.",
    },
    model: {
      type: "string",
      description: "Default model ID to use.",
      default: DEFAULT_MODEL,
    },
    provider: {
      type: "string",
      description: "Default provider ID to use.",
      default: DEFAULT_PROVIDER,
    },
    providerOptions: {
      type: "object",
      description: "Optional provider-specific options keyed by provider ID.",
      additionalProperties: PROVIDER_OPTIONS_SCHEMA,
    },
    resources: {
      type: "array",
      description: "Configured resources available to BTCA.",
      default: DEFAULT_RESOURCES,
      items: {
        oneOf: [GIT_RESOURCE_SCHEMA, LOCAL_RESOURCE_SCHEMA, NPM_RESOURCE_SCHEMA],
      },
    },
  },
  $defs: {
    providerOptions: PROVIDER_OPTIONS_SCHEMA,
    gitResource: GIT_RESOURCE_SCHEMA,
    localResource: LOCAL_RESOURCE_SCHEMA,
    npmResource: NPM_RESOURCE_SCHEMA,
  },
} as const;
