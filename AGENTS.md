Project guidelines:

- app boundaries:
- `apps/cli` is the local CLI distributed to users as part of the npm package
- `apps/server` is the local server that runs on the user's machine for the npm package/CLI
- `apps/webapp` is a separate hosted web app with a different agent implementation; do not assume server/cli architecture applies there

- use `vp` as the package manager and command runner
- when installing new packages, use `vp install` instead of manually editing `package.json`
- use modern svelte and sveltekit patterns and primitives
- avoid `as any` at all costs, lean on inference and real types
- when defining convex actions, queries, and mutations that are exposed to the client use the `authed` setup in `src/convex/authed`
- when defining convex actions, queries, and mutations that are called from the backend use the `private` setup in `src/convex/private`
- use effect v4 for backend code
- use the convex service for calling convex queries, actions, and mutations from the backend
- use tailwindcss for styling whenever possible, only fall back to custom css when needed
- every svelte component should have `lang="ts"`
- when making changes in effect, use the effect generator syntax whenever possible. if you need to call an async function use `Effect.tryPromise`. helper functions should be generators, the backend should be composed of effects
- after changes, format, lint, and check the package/app you touched:

Root
check: vp run -r check
fmt: vp fmt . --write
fmt-check: vp fmt --check
lint: vp lint

@btca/cli
check: vp run @btca/cli#check
lint: vp lint apps/cli
fmt: vp fmt apps/cli --write
fmt-check: vp fmt apps/cli --check

@btca/server
check: vp run @btca/server#check
lint: vp lint apps/server
fmt: vp fmt apps/server --write
fmt-check: vp fmt apps/server --check

@btca/webapp
check: vp run @btca/webapp#check
lint: vp lint apps/webapp
fmt: vp fmt apps/webapp --write
fmt-check: vp fmt apps/webapp --check

@btca/docs
check: vp run @btca/docs#check

@btca/autumn
check: vp run @btca/autumn#check
lint: vp lint packages/autumn
fmt: vp fmt packages/autumn --write
fmt-check: vp fmt packages/autumn --check

@btca/convex
check: vp run @btca/convex#check
lint: vp lint packages/convex
fmt: vp fmt packages/convex --write
fmt-check: vp fmt packages/convex --check

Shortcuts
apps: vp run --filter ./apps/_ check
packages: vp run --filter ./packages/_ check
