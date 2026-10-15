# FIX-002 users.role write audit

Source: `codex/fix-002` at `abb2c27`, reviewed 2026-10-15. The table lists writes or entry points; line numbers refer to this worktree after FIX-002 edits. `role` here is `users.role`, not cast member labels, deployment roles, or HTTP accessibility roles.

| Path:line | Value written | Customer reachable? | Fix |
| --- | --- | --- | --- |
| `db/repositories.js:94-99` `ensureAccount` | DB default `customer` on insert | Yes | Default remains; no update on conflict. |
| `db/repositories.js:102-111` `updateAuthenticatedAccount` | `customer` or `tester` on insert; no role on conflict | Yes, via sign-in | Closed `ROLE` enum and throws on other values; existing `ceo`/`workspace` survives later sign-ins. |
| `api/video-os-lite/auth.js:97` workspace password | `workspace` via dedicated `setAccountRoleTx` | Yes, credential gated | Explicit `system_bootstrap` actor; role and entitlement writes share one transaction. |
| `api/video-os-lite/auth.js:131` CEO token | `ceo` via dedicated `setAccountRoleTx` | Yes, credential gated | Explicit `system_bootstrap` actor; role and entitlement writes share one transaction. |
| `api/video-os-lite/auth.js:211` magic-link verify | Server computed `tester` or `customer` | Yes | Request body `role` ignored; existing privileged role preserved. |
| `api/video-os-lite/auth.js:257` Google callback | Server computed `tester` or `customer` | Yes | Request input `role` ignored; existing privileged role preserved. |
| `db/repositories.js:125-129` active tester-grant reapply | `tester` | Yes, at sign-in after admin grant | `setAccountRoleTx` with actor `system_grant` and transaction-local setting. |
| `db/repositories.js:2311-2332` `registerAdminTester` | `tester` insert/upsert | No; admin console | Transaction-local setting precedes insert/upsert. |
| `db/repositories.js:2403-2409` `revokeAdminTester` | `customer` | No; admin console | Transaction-local setting precedes update. |
| `db/repositories.js:46-63` `setAccountRole` | Closed enum role | No direct customer route; exported repository function | Requires explicit `admin` or `system_bootstrap` actor and transaction-local setting. Internal `system_grant` is limited to `tester`. |
| `drizzle/0000_clear_blackheart.sql:70` | Default `customer` | No | New 0014 CHECK and trigger. |
| `tools/dry-run-identity-migration.mjs:24` | Implicit DB default `customer` | No; local dry-run tool | No explicit role write; covered by CHECK/default. |

Comparison with §R's ten sites: all ten were found. The dedicated `setAccountRole` function is new. The dry-run tool is one additional implicit-default INSERT outside §R; it does not write a specified role. No other production `users.role` writer was found in `api/`, `routes/`, `db/`, `scripts/`, `tools/`, or migrations. Presenter `role` fields in `api/video-os/talent.js` are not account roles.

## Migration and verification status

`drizzle/0014_pre_role_guard.sql` is a new, hand-written migration with an unknown-value pre-check, `users_role_ck`, `users_role_guard()`, and `users_role_guard_tg`. The journal lists 15 migrations; `0014_snapshot.json` chains to 0013 and adds only the users CHECK to Drizzle's schema snapshot. Allowed values are `customer`, `tester`, `workspace`, `ceo`; `admin` is deliberately absent. The new opt-in PostgreSQL test requires a loopback URL, throwaway database name, and explicit opt-in; it was not run in this session. No migration was applied.

`config/database-schema.lock.json` was recaptured (FIX-002b) on a fresh, throwaway PostgreSQL 18.6 instance bound to 127.0.0.1 with 0000-0014 applied from empty via psql, from both LF and CRLF copies of the SQL: `schemaSha256` `b9a94a75763c04f15340fa75ef2ec9d4858323e0c8db8233fe48eec76a8ab82b`, `migrationSetSha256` `e503d184287f690e5534e8f0e82d17cdbcc21a7f4b0250f32fccfdad611add09`, 28 tables, `db/schema.js` `d7e617bd...`. Control: 0000-0013 on the same instance reproduced the MIG-0013 `schemaSha256` `fe9a67f3...` exactly. `tests/role-write-guard.pg.test.mjs` passed 1/1 with its opt-in against a throwaway loopback database on that instance (its psql helper now passes the URL with `-d`; `PGDATABASE` does not expand URIs, so it previously could not connect). No hosted or production database was used.

The 0014 SQL SHA-256 values computed offline are LF `b39da5ea73ca86d0f86a0b909cd1c32e19351348c8a2610542519b7cdad47c26` and CRLF `a98e3a5397eb8aea76e69b1042a7bf56544a6d4410abf0dbc80bf9d43b5ba8d5`. They identify migration source bytes; they are not proof that any database applied the migration.

The supplied brief identifies the canonical Neon deployment as using the single `neondb_owner` role; this was not rechecked against a live database in FIX-002. A column `REVOKE UPDATE(role)` from that same owner would not enforce separation. The trigger is the applicable guard; introduce REVOKE only if a distinct app role and migration owner role are deployed.

## Render-mode confirmation for §2f

At `abb2c27`, `video_jobs` has `provider text NOT NULL` and `input jsonb NOT NULL DEFAULT '{}'`, with no `render_mode` column. Its other columns are id, account_id, project_id, idempotency_key, workflow_run_id, correlation_id, provider_job_id, status, title, format, cost_credits, provider_cost_usd, output, failure_category, created_at, updated_at, completed_at, reviewed_at, and video_deleted_at (`db/schema.js:69-99`). `input->>'renderMode'` carries `luxify_cinematic_v1` (`lib/luxify-contract.js:4`) or `premium_presenter_v1` (`db/repositories.js:233`); standard and legacy rows can omit it. Tier is derived from provider (`heygen` premium, `sadtalker` standard) in `lib/scripted-photo-contract.js:63-90`. Scripted-photo stores `input->>'tier'`. These findings agree with §2f; 0015 must handle historical rows and verify actual scripted-photo tier values before a backfill.

## Follow-ups outside FIX-002

De-allowlisted tester accounts can retain `users.role = 'tester'`: later sign-in no longer resets an existing role. Rendering access follows current entitlements, while this role supplies DTO labels and the admin tester listing. Removing an allowlist entry alone does not revoke an existing entitlement; use the entitlement revocation path when access should end. Admin tester registration now refuses an existing `ceo` or `workspace` account before writing, so it cannot demote a privileged identity.

- §R gap d: review the customer-facing shared workspace password and its render entitlements.
- §R gap e: review domain-based starting credits separately from account roles.
- Staff tables planned for 0014 are outside this role guard migration.

## Scripted-photo `input->>'tier'` values (for 0016 render_mode)

Scripted-photo jobs (`input.contractVersion` = scripted-photo contract) store `input.tier` as `STANDARD` or `PREMIUM` only (`lib/scripted-photo-contract.js:14-17`), and **both run on `provider = 'heygen'`** (`renderTierForReservation`/`renderTierForJob` require heygen; `api/video-os-lite/render-v2.js:661` labels `STANDARD` as "Standard"). The effective tier is `input.tier` lowercased, not the provider. A backfill that maps `provider = 'heygen'` to `premium` would mislabel scripted-photo STANDARD jobs; it needs a branch such as `WHEN input->>'contractVersion' = <scripted-photo version> AND input->>'tier' = 'STANDARD' THEN 'standard'` before the heygen branch. Standard-narration projects use `settings.tier = 'STANDARD'` (`db/repositories.js:1768`). Premium scripted-photo jobs may also carry `renderMode = premium_presenter_v1`.
