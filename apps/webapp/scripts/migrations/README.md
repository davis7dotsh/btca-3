# Clerk -> WorkOS Migration Scripts

These are one-off utilities for the migration described in [MIGRATION.md](/Users/davis/Developer/highmatter/btca-3/MIGRATION.md).

## Scripts

`clerk-export.ts`

- Exports Clerk users to a normalized JSON bundle.
- Optionally exports Clerk organizations and memberships too.

`workos-import.ts`

- Imports users from the Clerk export bundle into WorkOS.
- Preserves the original Clerk user ID as WorkOS `externalId`.
- Stores `clerkUserId` in WorkOS metadata.
- Optionally imports organizations and memberships.
- Optionally applies bcrypt password hashes from a CSV or JSON file.

`backfill-identity-links.ts`

- Reads the import report or scans WorkOS users by `externalId`.
- Upserts `v2_identityLinks` into Convex using the private bridge.

`reconcile-autumn-customers.ts`

- Renames WorkOS-keyed Autumn customers to the canonical Clerk ID when a matching identity link exists.
- Skips safely if the customer is already canonical or if both IDs already exist in Autumn.

`legacy-convex-import.ts`

- Starts a Convex Workflow-based migration for legacy resources and legacy thread/message data.
- Can run resources-only, threads-only, or both through one durable `migrate` workflow.
- Can optionally wait and poll until the workflow completes, then write the final workflow status to a report file.

## Environment

Export:

- `CLERK_SECRET_KEY`
- Optional: `CLERK_API_URL`

Import:

- `WORKOS_API_KEY`

Identity-link backfill:

- `PUBLIC_CONVEX_URL`
- `CONVEX_PRIVATE_BRIDGE_KEY`
- `WORKOS_API_KEY` when using `--workos-scan`

## Example Flow

1. Export users from Clerk:

```sh
vp run @btca/webapp#migrate:clerk:export -- --out=./tmp/clerk-export.json --include-organizations
```

2. Import users into WorkOS:

```sh
vp run @btca/webapp#migrate:workos:import -- --in=./tmp/clerk-export.json --import-organizations
```

3. Backfill Convex identity links from the import report:

```sh
vp run @btca/webapp#migrate:workos:backfill-links -- --from=./tmp/clerk-export.workos-import.json
```

4. Reconcile Autumn customers:

```sh
vp run @btca/webapp#migrate:autumn:reconcile -- --from=./tmp/clerk-export.workos-import.json --dry-run
```

5. Start the legacy Convex data migration workflow:

```sh
vp run @btca/webapp#migrate:convex:legacy -- --mode=all --wait
```

## Notes

- The import script uses the Clerk user ID as WorkOS `externalId`, which matches the continuity plan.
- New users created directly in WorkOS keep their WorkOS user ID as the canonical ID.
- Secondary email addresses are preserved in WorkOS metadata as a pipe-delimited string, not as separate WorkOS emails.
- If you have Clerk password digests, pass them in with `--passwords=PATH`. The script imports them as WorkOS `bcrypt` hashes.
- Organization roles are not blindly copied. If you want role preservation, pass `--role-map=PATH` with a JSON object like `{ "org:admin": "admin", "org:member": "member" }`.
- Autumn reconciliation uses `customers.update({ newCustomerId })` so any existing WorkOS-keyed customer can be renamed to the Clerk ID without changing the runtime billing flow.
