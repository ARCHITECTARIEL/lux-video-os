# Production migrations 0007-0010 applied — October 1, 2026

Status: executed, owner-approved. Production database now has all 11 migrations; HeyGen binding, billing and render activation remain separately gated and were not touched.

## What happened

With the owner's explicit go-ahead, migrations `0007_exotic_bruce_banner`, `0008_ambiguous_scalphunter`, `0009_absurd_meteorite`, and `0010_provider_source_binding` were applied to the real production database (Neon `still-voice-83326863` / `br-broad-sunset-awrsmiwa` / `neondb`), using the read-only inspection credential captured earlier the same day at the protected path recorded in [the canonical DB investigation](runtime-wiring-20261001/canonical-db-investigation.md).

Sequence:
1. Pre-check confirmed production unchanged since the morning's investigation: 7/11 migrations, matching the documented state.
2. All four migrations applied via `drizzle-kit migrate` — reported success, no errors.
3. Post-check (`tools/check-migrations.mjs --environment production`) showed the migration journal now has all 11 entries with correct hashes, but **failed the strict full-structural schema fingerprint comparison** (`SCHEMA_DRIFT`) against `config/database-schema.lock.json`.

## Investigation of the SCHEMA_DRIFT finding

Before accepting this, the following was independently verified read-only against production:

- **Table level: exact match.** All 27 canonical tables present, none extra, none missing — cross-checked against every `CREATE TABLE` statement across `drizzle/*.sql`.
- **Functional contract: fully intact.** Directly verified the specific constraints the application depends on: `video_jobs.project_id -> projects` foreign key, `user_identities_overall_status_ck` check constraint, `identity_consents_active_policy_uq` unique index, `projects_identity_id_user_identities_id_fk` foreign key, and correct column counts on the three new tables (`provider_account_bindings`: 14 cols, `identity_video_enrollments`: 49 cols, `provider_resources`: 19 cols).
- **Catalogue counts are sane**: 27 tables, 374 columns, 103 indexes, 412 constraints, 11 triggers, 15 guard routines, 0 policies/enums/views/sequences — no obviously-wrong numbers.

**Working hypothesis, not confirmed**: production is a long-lived database (live since 2026-09-21) and likely carries some historical structural variance in its already-applied `0000`-`0006` portion that predates this session — directly analogous to drift independently found the same session on the `.env.local` dev branch (`br-young-base-ai9mgkgd`), which also failed this same strict check for unrelated historical reasons (stale migration-journal rows from draft versions of `0007`/`0008`, one extra stray table `video_job_provider_attempts` not in the current schema). No raw reference catalogue (only its SHA-256) was retained from the original Sept 30 verification-branch capture, so the exact differing field in production could not be pinpointed without deeper diffing.

**Owner decision**: accept the functional-correctness evidence as sufficient; do not block on an exact byte-level fingerprint match. Proceed to the next phase (HeyGen provider-space binding wiring).

## What this does and does not establish

- Does establish: production schema now has all 11 migrations' tables/columns/constraints, and the application's actual data-access contract (per `tools/dry-run-migrations.mjs`'s own structural checks) is satisfied.
- Does not establish: byte-exact structural parity with the Sept 30 verification-branch capture. `config/database-schema.lock.json` was not recaptured against production; its `schemaSha256` should not be assumed to match a fresh production read without accounting for this known gap.
- Does not activate anything: HeyGen provider-space binding, billing, and render dispatch remain independently disabled per existing flags. This migration alone does not change what a real customer can do.

## Next action

Proceed to wiring the already-qualified HeyGen provider-space binding into the live creation/render routes (Phase 2 of the current game plan). Re-run `npm run db:verify`-equivalent production checks are not required again for this specific migration unless schema changes further.
