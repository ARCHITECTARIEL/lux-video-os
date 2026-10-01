# Schema lock recapture — October 1, 2026

Status: `config/database-schema.lock.json` replaced after independent reproduction. Root cause: the 2026-09-30 capture, not production.

## What happened

After applying migrations `0007`-`0010` to production (see [the production migration note](20261001-production-migration-applied.md)), the production build pipeline's strict schema check (`tools/check-migrations.mjs --environment production`, invoked by `tools/build-production.mjs`) failed with `SCHEMA_DRIFT`: production's live structural fingerprint did not match `config/database-schema.lock.json`'s recorded `schemaSha256` (`2338bdba6521eb...`, captured 2026-09-30). This blocked deployment outright, escalating what had been accepted as a non-blocking finding into an actual release gate failure.

## Investigation

1. **Table-level check**: every `CREATE TABLE` across `drizzle/*.sql` was enumerated (27 names) and matched exactly against production's live `pg_tables` listing. No extra or missing tables.
2. **Functional-contract check**: directly verified against production the specific constraints the application depends on (`video_jobs.project_id -> projects` FK, `user_identities_overall_status_ck`, `identity_consents_active_policy_uq`, `projects_identity_id_user_identities_id_fk`, correct column counts on all three new tables). All present and correct.
3. **Independent reproduction**: production runs PostgreSQL 18.6. A disposable local PostgreSQL 18 Docker container was created, all 11 migrations were applied to it from empty (raw SQL, in migration order), and its schema catalogue was computed using the exact same `readSchemaCatalogue`/`schemaDigest` functions the real tool uses (`tools/check-migrations.mjs`, imported directly -- not reimplemented).
4. **Full structural diff**: production's full catalogue (tables, columns, indexes, constraints, triggers, routines, policies, enums, views, sequences) was byte-for-byte diffed against the fresh container's catalogue. Every section was identical -- zero differences, not even formatting.
5. **Conclusion**: production and a from-empty fresh install of the exact same migration set agree perfectly with each other. Neither matches the 2026-09-30 lock. Since `migrationSetSha256` and `sourceHashes` in the old lock both still matched the current repository (ruling out migration/schema-source changes since the capture), the capture itself -- not production, not the migrations -- is the stale artifact. The most likely explanation is that the verification tooling's own catalogue-reading logic (`readSchemaCatalogue`) changed after 2026-09-30 in some way not covered by `sourceHashes` (which only covers `db/schema.js`, `db/standard-narration-schema.js`, and `db/provider-lifecycle-guards.sql`, not `tools/check-migrations.mjs` itself) -- not independently confirmed, since the original raw catalogue from 2026-09-30 was never retained, only its hash.

## What changed

`config/database-schema.lock.json`'s `schemaSha256` was replaced with the now-twice-independently-reproduced value (`f599f7f1f428cf966e3f7c111aef926e4991efe5fd2664258570e992a6472c36`), computed via the project's own exported `migrationPlan()`/`schemaSourceHashes()` functions (not hand-typed). `migrationSetSha256` and `sourceHashes` are unchanged from the prior lock -- only `schemaSha256`, `provenance`, and `capturedAt` differ.

Note: the official `--capture-schema` CLI path could not be used directly, because `checkDatabaseMigrations` (and `drizzle-kit migrate`) are both hardwired to the `@neondatabase/serverless` driver, which only connects via websocket to real Neon/Vercel/Supabase endpoints -- it cannot reach a plain local Postgres container. The replacement value was instead computed by importing and calling the tool's own hashing functions directly against a manually-seeded, drizzle-journal-compatible local database, which exercises the identical canonicalization/hashing logic without the driver's transport layer.

## Owner approval

The owner reviewed this finding and approved writing the recaptured lock, after independent evidence from two separate clean environments (production itself, and a from-scratch local Postgres 18 instance) agreed with each other.
