# `apps/server` Agent Architecture Draft

This is the first draft for the local agent that will live in `apps/server`.

The goal is to keep the system simple, portable, and easy to ship inside a global npm install while still giving the agent a "normal filesystem + bash" experience over tagged resources.

## Goals

- Run locally as part of the npm-distributed CLI/server package.
- Use Pi's TypeScript SDK for the agent loop.
- Keep provider auth simple at first:
  - OpenAI only
  - API-key based only
- Load tagged resources into a managed workspace the agent can search with shell commands.
- Avoid heavyweight or external sandbox dependencies.
- Keep the system structured as Effect services.

## Non-goals

- Strong OS-level sandboxing in v1.
- Multi-provider auth in v1.
- Rich browser/session auth in `apps/server`.
- A fake in-memory filesystem.

## Core idea

Instead of building a custom virtual filesystem runtime, the agent should operate on a real workspace directory on disk.

The server will:

1. Resolve the tagged resources for a request.
2. Materialize those resources into a managed thread workspace.
3. Run the Pi agent with tools that operate only inside that workspace.
4. Persist thread state and messages separately.

This gives the agent a normal shell-centric environment while keeping the implementation portable across macOS, Windows, and Linux.

## Top-level services

### `AuthService`

Purpose: provider auth and model authorization only.

Initial scope:

- OpenAI only
- API key only
- No browser sign-in flow
- No provider switching

Responsibilities:

- Read the OpenAI API key from config or environment.
- Report whether auth is configured.
- Resolve model access for agent runs.
- Return the Pi-compatible auth/config needed to run a model.

Suggested shape:

```ts
type AuthService = {
  getAuthState: () => Effect.Effect<{
    provider: "openai";
    configured: boolean;
  }>;
  requireModelAuth: (args: { provider: "openai"; modelId: string }) => Effect.Effect<
    {
      provider: "openai";
      modelId: string;
      apiKey: string;
    },
    AuthError
  >;
};
```

Notes:

- This service should not know about threads, prompts, resources, or workspaces.
- If we add more providers later, this service can grow without forcing changes into the agent orchestration code.

### `ResourcesService`

Purpose: central contract for loading and materializing resources.

Responsibilities:

- Resolve resource references into a normalized contract.
- Support multiple resource kinds through separate implementations.
- Materialize resources into a target directory.
- Return resource metadata/instructions the agent can use.

Initial resource kinds:

- `git`
- `local`
- `npm`

Possible later kinds:

- `website`
- `docs-snapshot`

Suggested normalized contract:

```ts
type LoadedResource = {
  id: string;
  kind: "git" | "local" | "npm";
  name: string;
  description?: string;
  instructions?: string;
  source: Record<string, unknown>;
  materialize: (args: { targetDir: string }) => Effect.Effect<
    {
      mountPath: string;
      filesMaterialized?: number;
    },
    ResourceError
  >;
};
```

Suggested service shape:

```ts
type ResourcesService = {
  load: (reference: ResourceReference) => Effect.Effect<LoadedResource, ResourceError>;
  loadMany: (
    references: readonly ResourceReference[],
  ) => Effect.Effect<readonly LoadedResource[], ResourceError>;
};
```

Implementation notes:

- `git` resources should reuse a local cache when possible.
- `npm` resources should unpack or cache package contents in a deterministic location.
- `local` resources can be copied or symlinked into the workspace depending on platform and safety rules.
- This service should remain resource-centric, not thread-centric.

### `WorkspaceService`

Purpose: build and manage the fake sandbox the agent sees.

This is the key service for the local agent.

Instead of a custom VFS, this service creates a real directory tree that acts like the agent's world.

Responsibilities:

- Create a per-thread workspace directory.
- Materialize loaded resources into that workspace.
- Write workspace metadata files.
- Execute commands inside the workspace with policy checks.
- Read files inside the workspace safely.
- Refresh and clean up workspaces.

Suggested workspace layout:

```txt
<data-dir>/agent-workspaces/<threadId>/
  workspace/
    resources/
      <resource-name>/
    meta/
      resources.json
      instructions.md
```

Suggested service shape:

```ts
type WorkspaceService = {
  prepareThreadWorkspace: (args: {
    threadId: string;
    resources: readonly LoadedResource[];
  }) => Effect.Effect<
    {
      threadId: string;
      workspaceDir: string;
      resourcesDir: string;
      metadataPath: string;
    },
    WorkspaceError
  >;
  execCommand: (args: { threadId: string; command: string; cwd?: string }) => Effect.Effect<
    {
      exitCode: number;
      stdout: string;
      stderr: string;
    },
    WorkspaceError
  >;
  readFile: (args: {
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
  cleanupThreadWorkspace: (args: { threadId: string }) => Effect.Effect<void, WorkspaceError>;
};
```

Policy notes for v1:

- Commands always run with cwd inside the thread workspace.
- The workspace is the only supported filesystem root for tool calls.
- We should reject obviously dangerous commands and path escapes.
- We should cap execution time and output size.
- We should strip or explicitly control the environment passed to subprocesses.

Important limitation:

- This is a managed workspace, not a strong OS sandbox.
- It is intended to prevent accidental access, not defend against a malicious model with arbitrary host execution power.

### `AgentService`

Purpose: orchestrate agent runs.

Responsibilities:

- Load prior thread context/messages.
- Extract tagged resources from the prompt.
- Resolve and load those resources.
- Prepare the thread workspace.
- Build the system prompt.
- Start the Pi agent loop.
- Expose streaming events.
- Persist final messages and thread state.

Suggested service shape:

```ts
type AgentService = {
  promptThread: (args: {
    userId: string;
    threadId: string;
    prompt: string;
    modelId?: string;
  }) => Effect.Effect<
    {
      threadId: string;
      workspaceDir: string;
      model: {
        provider: "openai";
        modelId: string;
      };
      events: AsyncIterable<AgentEvent>;
    },
    AgentError
  >;
};
```

This service depends on:

- `AuthService`
- `ResourcesService`
- `WorkspaceService`
- thread persistence helpers/services

## Thread persistence

The server agent will likely need a thread store, but it does not need to be its own top-level concept yet.

For v1, thread persistence can live behind a small internal service or module used by `AgentService`.

Responsibilities:

- load thread context
- load prior messages
- set thread status
- append final persisted messages

The intended storage model should stay aligned with the existing Convex thread data in `packages/convex`.

## Agent tools

The initial tool surface should stay intentionally small:

- `exec_command`
- `read_file`

That is enough if the workspace is well structured and the prompt tells the model to rely on standard shell tools like:

- `rg`
- `find`
- `ls`
- `cat`
- `sed`
- `head`
- `tail`
- `grep`

We should avoid adding higher-level search tools until the shell-driven workflow proves insufficient.

## Prompting approach

The server prompt should reflect the local workspace model.

Key guidance:

- The tagged resources are already loaded into the workspace.
- Prefer searching the workspace over answering from memory.
- Stay inside the workspace.
- Use shell tools for discovery and file inspection.
- Cite workspace-relative paths in responses.

We should also write a small `meta/instructions.md` file into the workspace so the agent has a concrete, inspectable description of what was loaded.

## Execution flow

Proposed `promptThread` flow:

1. Load prior thread state/messages.
2. Extract tagged resource references from the prompt.
3. Resolve those references through `ResourcesService`.
4. Prepare the thread workspace through `WorkspaceService`.
5. Resolve model auth through `AuthService`.
6. Build the Pi system prompt and tool set.
7. Start the Pi agent loop.
8. Stream events to the caller.
9. Persist final messages and thread status.

## Initial implementation boundaries

### v1 included

- OpenAI API-key auth only
- Pi agent loop
- thread workspace creation
- `git`, `local`, `npm` resources
- `exec_command` and `read_file`
- thread persistence

### v1 excluded

- browser-based auth
- multiple providers
- external container sandboxing
- website snapshotting
- generalized tool ecosystem

## Recommended folder layout

```txt
apps/server/src/
  agent/
    service.ts
    prompt.ts
    tools.ts
    threads.ts
  auth/
    service.ts
  resources/
    service.ts
    types.ts
    impls/
      git.ts
      local.ts
      npm.ts
  workspace/
    service.ts
    exec.ts
    paths.ts
    manifest.ts
```

This keeps orchestration separate from provider auth, resource loading, and workspace mechanics.

## Design decisions

### Why not a custom VFS

A fake in-memory filesystem makes normal shell tooling harder, not easier.

The agent wants a normal filesystem surface. A real workspace directory is cheaper, simpler, and more compatible with shell-based exploration.

### Why keep auth simple

`apps/server` should not start with session or browser auth complexity.

OpenAI API-key auth is enough to unblock the agent architecture and validate the service boundaries first.

### Why `WorkspaceService` is separate

If command execution, path enforcement, file reads, and workspace layout all live inside `AgentService`, that service will become too broad.

Keeping workspace management separate gives us a better place for:

- path safety checks
- subprocess policy
- workspace refresh/cleanup
- later sandbox backends

## Future extensions

- additional providers in `AuthService`
- stronger optional sandbox backends for Linux users
- resource hydration from websites/docs snapshots
- per-resource refresh policies
- optional workspace reuse and invalidation
- richer tool telemetry

## Current recommendation

Build around four boundaries:

- `AuthService`
- `ResourcesService`
- `WorkspaceService`
- `AgentService`

Keep v1 narrow:

- OpenAI only
- API key only
- shell-first workspace exploration
- no heavyweight sandbox dependency

That should give `apps/server` a clean, shippable architecture without overcommitting to sandbox machinery too early.
