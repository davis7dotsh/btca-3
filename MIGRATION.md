# Migration Notes

## Summary

Do not deploy the `btca-3` webapp to production yet. There are three migration blockers to resolve first:

1. `Clerk -> WorkOS` identity continuity is not safe as-is.
2. Convex thread data can be migrated, but only through a custom import.
3. Autumn subscriptions can be rolled over, but usage and customer identity need explicit handling.

## 1. Clerk -> WorkOS

The live app keys ownership off Clerk user IDs, while the new app keys ownership off WorkOS user IDs.

- Live app ownership is tied to `identity.subject === clerkId`.
- New app stores `WorkOS user.id` directly as `userId`.
- Same email does not automatically mean the same record in Convex or Autumn.

Risk:

- If we cut over without an identity-link strategy, existing users will appear as brand new users.
- Old data ownership and billing records will not line up with new auth identities.

What we need:

- A canonical identity map: `oldClerkId -> newWorkOSUserId`.
- New billing and migration logic should resolve users through that mapping instead of assuming raw WorkOS IDs are the canonical customer key.

Plan:

1. Export all current users from Clerk before go-live.
2. Import those users into WorkOS before launch instead of waiting for users to recreate accounts organically.
3. Preserve the Clerk user ID on each imported WorkOS user as the canonical legacy key:
   - `external_id = clerkUserId`
   - also store `clerkUserId` in metadata for debugging if useful
4. Create a local identity-link table in the new system with at least:
   - `clerkUserId`
   - `workosUserId`
   - `primaryEmail`
   - `migrationSource`
   - `createdAt`
   - `linkedAt`
   - `status`
5. Backfill that table immediately after import by reading imported WorkOS users and pairing:
   - `external_id -> clerkUserId`
   - `id -> workosUserId`
6. Update all migration code to resolve identity through that table instead of assuming:
   - old Convex data should attach to raw WorkOS IDs
   - Autumn customers should be keyed by raw WorkOS IDs
7. Use the legacy Clerk ID as the canonical migration key during rollout:
   - Convex import looks up old user-owned data by `clerkUserId`
   - Autumn lookup initially uses the old Clerk-based customer identity
   - new app resolves current WorkOS user to the linked Clerk identity before reading migrated data
8. Add a sign-in-time fallback linker for edge cases:
   - if a WorkOS user exists without a local link record
   - and the account email matches a known migrated Clerk user
   - create the missing link record
   - mark it as fallback-linked for auditability
9. Freeze or account for deltas between export and launch:
   - either schedule a short read-only window before cutover
   - or run a second delta export/import for users created after the first snapshot
10. Dry-run the full auth migration against a production snapshot and verify:

- total Clerk users exported
- total WorkOS users imported
- total identity links created
- duplicate emails
- users missing `external_id`
- users that fail fallback linking

Recommended implementation shape:

- Primary path: pre-import users from Clerk to WorkOS before launch.
- Secondary path: fallback linking on first sign-in for missed or late-created users.
- Do not use raw WorkOS user IDs as the new canonical billing key until the identity-link layer is in place.

Why this is the safest path:

- It lets migration happen before users arrive.
- It preserves a stable foreign key for Convex and Autumn.
- It avoids treating returning paid users as new free users.
- It gives us an auditable table for every identity decision made during cutover.

## 2. Convex Migrations / Old Threads

Old threads can be preserved, but they will not migrate automatically.

- Live app data shape is roughly `instances -> threads -> messages/threadResources`.
- New app data shape is roughly `agentThreads -> agentThreadMessages -> agentThreadAttachments`.
- New persisted messages are stored as raw pi-message JSON and validated by the new app when read.

Risk:

- We cannot safely copy rows table-to-table.
- Old messages need to be transformed into the new persisted message format the new UI and agent runtime expect.

Conclusion:

- Saving old threads is feasible.
- It requires a custom ETL/import pipeline and a production snapshot dry run before any cutover.

Plan:

1. Keep the existing production tables untouched as the rollback-safe legacy source.
2. Put all btca-3 webapp tables under a `v2_` prefix in the shared Convex deployment.
3. Leave the legacy table names unchanged:
   - `instances`
   - `projects`
   - `cachedResources`
   - `globalResources`
   - `userResources`
   - `githubConnections`
   - `threads`
   - `messages`
   - `threadResources`
   - `streamSessions`
   - `mcpQuestions`
   - `apiKeyUsage`
4. Route all new webapp work into `v2_*` tables only.
5. Add migration bookkeeping tables for idempotent imports and audits:
   - `v2_identityLinks`
   - `v2_migrationRuns`
   - `v2_migrationAudit`
   - optional per-entity mapping tables if we want explicit source-to-target IDs
6. Build internal migration functions inside the same Convex deployment so they can:
   - read legacy tables directly
   - resolve ownership through the identity-link layer
   - write transformed records into `v2_*`
   - rerun safely without duplicating data
7. Migrate threads as transcript imports, not raw row copies:
   - map legacy `threads` into `v2_agentThreads`
   - map legacy `messages` into valid persisted v2 message JSON
   - optionally carry thread resources forward into v2 resource structures where useful
8. Treat legacy-only concepts as legacy unless we explicitly need them in v2:
   - `instances`
   - `projects`
   - `cachedResources`
   - `githubConnections`
   - `streamSessions`
9. Run the migration in phases:
   - identity links
   - thread/message import
   - resource import
   - billing/customer reconciliation
10. Verify before cutover:

- thread counts per user
- message counts per thread
- sample transcript integrity
- duplicate import protection
- rollback remains possible because legacy tables are untouched

Current direction:

- We are using the same Convex deployment.
- We are preserving old production tables in place.
- We are namespacing btca-3 tables as `v2_*` so the migration is additive, reversible, and easier to audit.

## 3. Autumn Products / Active Subs

Subscriptions are partially compatible, but not automatically compatible.

- Product IDs line up for `free_plan` and `btca_pro`, which is good.
- Live app usage model is feature-based: `chat_messages`, `tokens_in`, `tokens_out`, `sandbox_hours`.
- New app usage model is dollar-wallet based: `usage_usd`.
- Live app Autumn customers are keyed by Clerk ID.
- New app Autumn customers are currently keyed by WorkOS user ID.

Risk:

- Paid users could accidentally get new free customers if we keep using raw WorkOS IDs for Autumn customer creation.
- Old per-feature balances do not map 1:1 onto the new `usage_usd` wallet.

Conclusion:

- Active subscriptions can be rolled forward.
- Usage rollover needs an explicit policy rather than an implicit migration.

Recommended policy:

- Preserve the active `btca_pro` subscription state.
- Resolve Autumn customers through a canonical customer ID, not raw WorkOS IDs.
- Grant a fresh, generous `usage_usd` balance at cutover instead of trying to perfectly convert old token and sandbox balances mid-cycle.

## Recommended Cutover Path

1. Add an identity-link layer from Clerk users to WorkOS users.
2. Make Autumn read and write through a canonical customer ID derived from that mapping.
3. Build a one-off thread import pipeline from old Convex data into the new thread/message format.
4. Run the migration against a production snapshot and verify:
   - auth mapping
   - subscription continuity
   - thread counts
   - transcript integrity for sampled users
5. Cut over only after the dry run passes.
