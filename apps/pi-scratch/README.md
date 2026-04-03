# pi-scratch

Scratch space for experimenting with a project-local custom pi setup.

This app is intended to:

- reuse the user's global pi auth
- keep btca-specific behavior isolated to this directory
- avoid changing the user's normal global pi setup

## Files

- `.pi/settings.json` — project-local pi settings
- `.pi/SYSTEM.md` — btca-specific system prompt additions/replacement scaffold
- `.pi/extensions/btca.ts` — starter extension for custom behavior

## Running

From this directory:

```bash
cd apps/pi-scratch
pi
```

Because this uses project-local `.pi/` config, the behavior here can differ from the user's normal pi usage while still reusing global auth from `~/.pi/agent/auth.json`.
