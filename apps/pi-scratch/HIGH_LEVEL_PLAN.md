# High Level Plan

## Goal

Turn `apps/pi-scratch` into an experimental custom pi-powered agent experience that keeps pi's existing TUI, reuses the user's global pi auth, and gives the agent a dedicated "agent box" to work in.

We want two execution modes:

- **safe**: commands run inside a container and operate on a mounted persistent workspace
- **unsafe**: commands run directly on the host in a dedicated workspace directory, with no hard isolation

The first implementation focus is **safe mode**.

---

## Core Product Idea

Use pi as the UI shell and session/auth layer, but replace direct host tool usage with a custom sandbox backend.

The agent gets a persistent workspace where it can:

- clone repos
- install npm packages
- fetch websites with `curl`
- search with `rg`
- run normal shell workflows inside the workspace

This workspace can be messy and long-lived. We are not optimizing for strict cleanup or session management right now.

---

## Constraints and Design Decisions

### Reuse user's global pi auth

We want to reuse the user's normal pi auth from their global install, instead of creating a separate auth store for btca.

That means:

- keep project-specific behavior inside `apps/pi-scratch/.pi`
- do **not** override `PI_CODING_AGENT_DIR`
- do **not** write to the user's global pi settings unless explicitly intended

### Keep pi's TUI

We do not want to rebuild pi's TUI. The plan is to customize behavior around it.

### Keep the model simple

We want a stupidly simple mental model:

- there is one persistent "agent box"
- the agent can use it however it wants
- safe mode uses Docker/podman-backed execution
- unsafe mode uses direct host execution in the box directory

---

## Workspace Model

Persistent workspace directory on the host:

- `~/.btca/agent-box`

This is the canonical backing store for agent work.

### Safe mode

- Host path: `~/.btca/agent-box`
- Mounted into container as: `/workspace`
- Commands run with working directory `/workspace`
- Implementation should start with **ephemeral command containers** plus the persistent mounted workspace

### Unsafe mode

- Commands run directly on the host
- Working directory rooted at `~/.btca/agent-box`
- No strong isolation guarantees

---

## Required Agent Capabilities

The agent should be able to use real versions of these commands:

- `git`
- `npm`
- `curl`
- `rg`

This is one reason we are not using `just-bash` as the main backend for this implementation.

---

## Execution Backend Abstraction

We should implement a backend interface that supports both safe and unsafe modes behind one API.

Suggested shape:

```ts
interface AgentBoxBackend {
  mode: "safe" | "unsafe";
  workspacePath: string;
  initialize(): Promise<void>;
  exec(
    command: string,
    options?: { cwd?: string; timeoutMs?: number },
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
}
```

Initial implementations:

- `DockerAgentBoxBackend`
- `HostAgentBoxBackend`

---

## Pi Integration Plan

Project-local pi config lives in:

- `apps/pi-scratch/.pi/settings.json`
- `apps/pi-scratch/.pi/SYSTEM.md`
- `apps/pi-scratch/.pi/extensions/btca.ts`

The extension should eventually:

- initialize or connect to the agent box workspace
- select the configured backend mode
- disable or avoid direct host mutation tools
- provide a custom tool for running commands in the agent box
- steer the system prompt toward using the box as the primary workspace

---

## Initial Tooling Plan

Keep the first version minimal.

### First custom tool

A single tool is enough for the first end-to-end version:

- `agent_box_bash`

This tool should:

- ensure the workspace exists
- execute the provided command in the selected backend
- return stdout, stderr, and exit code

This may be sufficient at first because real shell access covers many file operations naturally.

Later we can decide whether to add dedicated helpers for reading files, applying patches, or inspecting workspace state.

---

## Safe Mode Plan

This is the first implementation target.

### Runtime

Use Docker first. Podman can be added later or supported via a pluggable runtime choice.

### Container strategy

Start with:

- ephemeral containers (`docker run --rm ...`)
- persistent mounted workspace (`~/.btca/agent-box` -> `/workspace`)

Why:

- simpler lifecycle
- fewer moving parts
- workspace persists even though containers are one-shot

### Container image requirements

Base image should include:

- `bash`
- `git`
- `node`
- `npm`
- `curl`
- `rg`

Potentially useful later:

- `jq`
- `python3`
- `tar`
- `gzip`
- `unzip`

---

## Unsafe Mode Plan

Unsafe mode exists for users who do not want to install Docker/podman.

### Behavior

- run commands directly on the host
- use `~/.btca/agent-box` as the workspace root
- present this honestly as non-isolated execution

### Messaging

Unsafe mode must be clearly described as:

- convenient
- real host execution
- not strongly isolated
- capable of escaping the intended workspace if the agent chooses to do so

---

## Configuration Direction

We will likely need an `agentBox` config section.

Possible shape:

```json
{
  "agentBox": {
    "mode": "safe",
    "runtime": "docker",
    "workspaceDir": "~/.btca/agent-box"
  }
}
```

Possible future mode values:

- `safe`
- `unsafe`
- `auto`

For now, the focus is implementing and validating `safe`.

---

## UX Direction

Preferred user experience:

- same familiar pi TUI
- btca-specific prompt and extension behavior only inside `apps/pi-scratch`
- reuse the user's normal global pi auth
- no accidental changes to the user's normal pi setup

The agent should understand that it operates primarily inside the agent box workspace and should organize work there.

---

## Immediate Next Step

Implement **safe mode** first because it is the harder architecture and establishes the right boundary.

### Immediate build order

1. define the Docker-backed backend interface in code
2. create the container image / Dockerfile with required tools
3. implement `agent_box_bash`
4. wire the extension to use the safe backend
5. test basic flows:
   - `git clone`
   - `npm install`
   - `curl`
   - `rg`

Once safe mode works, add unsafe mode as the simpler fallback.
