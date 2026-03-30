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
