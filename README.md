# btca 3

WARNING: this is a temp dev repo that will eventually replace what's currently in: https://github.com/davis7dotsh/better-context

This is a full rebuild (backwards compat) around:

- pi agent sdk
- vp & node instead of bun to help with windows compat
- ground up redo of the webapp

## Development

- Check everything is ready:

```bash
vp run ready
```

- Run the tests:

```bash
vp run test -r
```

- Build the monorepo:

```bash
vp run build -r
```

- Run the development server:

```bash
vp run dev
```
