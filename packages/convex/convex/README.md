# Convex functions

Use the folders in here by intent:

- `authed/`: functions called by the client and protected by WorkOS auth
- `private/`: functions called from the SvelteKit backend and protected by `CONVEX_PRIVATE_BRIDGE_KEY`

After editing anything in here, run:

```bash
bun run convex:gen
```
