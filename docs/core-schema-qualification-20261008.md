# Core schema qualification — October 8, 2026

## October 8 lineage inspection and additive repair hold

The original `0011_concerned_micromacro.sql` and its snapshot have been restored from introducing commit `14d871e` byte-for-byte. Its accepted hashes are LF `28c76bf7bf2b56694e6fd91ffbcce85e44f3c3f9d24af9b9c6b31852261b1b2b` and CRLF `e6a3968178b60fb7854b7c44c9ea1cf1628c5d549ead42796c4eb40517fc92c1`. The previously repaired `0011` hashes and catalogue below are **historical rehearsal evidence, not capture targets**. The null-safe final schema now declares a separately named hosted-v3 purpose guard; its SQL is an **unnumbered review proposal** at `docs/hosted-v3-purpose-guard.proposed.sql`. It is not in the Drizzle journal and must not be applied to a persistent database.

Authenticated Neon inventory covered two known projects and 14 listed branches. Every SQL inspection below ran inside a transaction explicitly reporting `transaction_read_only=on`; database and role matched Neon metadata. Journal comparisons used full hash and timestamp pairs against both versions of `0011` and all optional `0012`–`0015` migrations. No customer row was returned.

| Sanitized target | PostgreSQL | Ordered journal | Hosted `0011` / optional `0012`–`0015` | Aggregate purpose-guard precheck |
| --- | --- | --- | --- | --- |
| Production default | 18.6 | Exact `0000`–`0010` (11 rows) | Absent | 0 incompatible; 0 null-policy |
| Ready retained Preview | 18.6 | Exact `0000`–`0010` (11 rows) | Absent | 0 incompatible; 0 null-policy |
| Named verification database | 17.11 | Exact `0000`–`0010` (11 rows) | Absent | 0 incompatible; 0 null-policy |
| Development default | 17.11 | Exact `0000`–`0010` plus one unmatched older draft row (12 rows) | Absent | 0 incompatible; 0 null-policy |
| Inherited default database on verification branch | 17.11 | Exact `0000`–`0006` plus the same draft row (8 rows) | Absent | Not evaluable: `consent_purpose` absent |

All five retain the pre-v3 consent constraint and have no prompt tables. The zero counts applied the **entire proposed purpose-guard predicate with `IS NOT TRUE` across all consent rows**, not just v3 rows, on the four databases with the required column. They are point-in-time data checks, not full catalogue equivalence or future-write proof. Development's unmatched draft journal row needs a separate drift plan; the inherited verification database is incomplete. The named verification database is PostgreSQL 17.11 and cannot satisfy this note's 18.6 capture contract.

Ten archived Preview branches (eight in the production project and two in the verification project) were listed but not queried to avoid reactivating compute. Account-wide project discovery was unavailable, and Vercel integration-configuration inspection returned 403. Project-level production and Preview database-variable metadata does not prove the active deployment's secret-to-target binding. Eight Preview deployments since October 7 failed during resource provisioning; the integration side effect and target mapping are unknown. **No project-wide or fleet-wide absence claim is made.**

The repository's `db:migrate` is an explicit command. CI and Preview packaging check snapshots; they do not invoke it, and runtime has no migration path. The installed Drizzle migrator selects unapplied files using only the latest journal `created_at`, so development's older unknown row could remain while a later migration is applied. Do not run a migration there. Vercel integration provisioning remains outside this repository-controlled runner analysis.

**Reversal for this local phase:** revert only the bounded source, proposal, test, and note edits made after clean commit `40877467b63069a5110bb40115ea7f12bfec3c57`; preserve the separate prompt worktree and canonical lock. Dispose each synthetic PostgreSQL container and its anonymous volume after readback. No persistent target is an execution target for this phase.

## Unnumbered guard and local rehearsal

The core journal remains `0000`–`0011` with the original `0011` SHA-256 (LF `28c76bf7…`, CRLF `e6a39681…`) and migration-set digest `414d884abacd185c72e744b5c8858791df5d7bbcb2bf6931ac03bab1e09916ea`. Its `0011_snapshot.json` is also identical to the introducing commit. `db/schema.js` declares the intended final state as the original authorizations CHECK plus a separate `identity_consents_hosted_v3_purpose_ck`; the unnumbered proposal adds and validates that guard after an `IS NOT TRUE` existing-row precheck. The proposal is outside `drizzle/` and has no journal entry. `drizzle-kit check` passes, but no source migration or schema-lock capture is qualified by that snapshot check.

Two empty databases in one disposable PostgreSQL 18.6 container replayed the original `0000`–`0011` files in order. Each of the 12 applied SQL file hashes matched the repository plan, and each journal contained exactly the matching hash/timestamp pairs. The proposal passed on an empty fresh-install database and as an upgrade with an existing valid hosted v3 row or compatible legacy row. A pre-existing v3 row with `NULL` purpose failed the `IS NOT TRUE` precheck before the new constraint was added; a new v3 `NULL` row failed the named guard after validation. The guard reported validated inside the transaction. Final readback after the rollback and failure cases found 12 unchanged journal rows, zero synthetic users, and no persistent proposed guard. These are disposable rehearsal results, not proof on a persistent target.

The optional worktree's journal already assigns `0012`–`0015` at increasing timestamps to first-party consent capture, derived looks, synthetic identities, and a derived-look extension. `0013` references the `0012` capture table; `0015` extends `0013` and references capture. Its snapshots descend from the original unguarded `0011`. A new numbered core migration between `0011` and optional `0012` would collide with the next journal index/snapshot slot and require an explicit rethread of optional snapshots. A target already past that timestamp would skip an inserted earlier migration because Drizzle selects work after the latest `created_at`. **No core-only migration number is assigned.** The exact decision is whether the optional lineage may be deliberately rebased after a new core guard, with proof that none of its `0012`–`0015` hashes reached any retained target, or whether a target-specific convergence plan is required. Until then, the SQL remains an unnumbered proposal and capture preparation stops.

The two local databases and their synthetic data were destroyed with the exact `lux-core-additive-guard-20261008` container and its anonymous volume. Exact-name Docker readback returned no container. The future bounded capture scope begins only after the ordering decision: freeze a numbered, reviewed migration and snapshot; replay fresh and original-`0011` upgrade paths; verify journal, catalogue, and existing-row checks; then request a separately authorized empty PostgreSQL 18.6 verification target and candidate-lock capture. Neither this proposal nor the historical repaired-in-place hashes qualify a lock today.

## Scope and source boundary

Schema-source baseline: `4425a713a51edbb3b907000d27226e2cba16e330`. The branch has since received non-schema review work; set the release candidate to the final exact tip only after confirming the files below still produce the qualified hashes. This lane performed no production, provider, deployment, publication, or schema-lock mutation.

Bound files: `drizzle/*.sql`, `drizzle/meta/_journal.json`, `drizzle/meta/0011_snapshot.json`, `db/schema.js`, `db/standard-narration-schema.js`, and `db/provider-lifecycle-guards.sql`.

## Historical repaired-in-place rehearsal — superseded

The canonical lock is internally valid for `0000`–`0010`. The table below records the superseded **repaired-in-place `0011` rehearsal** and must not be used as a future capture target:

| Evidence | Historical repaired-in-place value |
| --- | --- |
| Journal entries | 12 |
| Migration-set SHA-256 | `d282ca6017de68ea543bb50c7c5fd6784df170b21afd044b7ee2cbf0e82fef4d` |
| `0011` LF SHA-256 | `91189712bc754a98c958496ec774961cbf088188295bd0da67cbb4a8e928dc02` |
| `0011` accepted CRLF SHA-256 | `0fb886fb21b7c4197f64f57d58aa510c3e117af8c4b730d117a4934549442a19` |
| `db/schema.js` SHA-256 | `984666df0f66e595e4d239cce14d2934f480c7bd1f43578288b50904136b0ea8` |
| `db/standard-narration-schema.js` SHA-256 | `be1b5caa8040685ddae706b0e3c7d7357deb8753d917528d3defb88af11b0efd` |
| `db/provider-lifecycle-guards.sql` SHA-256 | `dbbfe7a06b596283e62f58d3cb050a30d42e489dcd781d1523547aacc897c3df` |
| Schema catalogue SHA-256 | `7b90ac84b43fe3458a2c2cc50dd02f25fcaaa14529aeba143260d48ebf376f8e` |
| Catalogue counts | 27 tables, 374 columns, 412 constraints, 103 indexes, 11 triggers, 15 routines |

GitHub Actions run `37801033736` used the original schema-source baseline. It failed in `npm run test:unit` before `db:check`: the Workflow packaging test compared the old lock's `7c8b…` schema-source hash with the then-current `042c…` hash. This is historical `SCHEMA_LOCK_STALE` evidence, not catalogue-drift evidence. The repaired-in-place hashes above no longer describe the current source.

## Disposable PostgreSQL evidence

PostgreSQL `18.6` replayed `0000` through `0011` from empty in journal order. Every migration and journal insert exited `0`; the repository's `assertMigrationRows` accepted all 12 exact LF checkout hashes and timestamps.

The repository's own `readSchemaCatalogue` plus `schemaDigest` produced:

- 27 tables, 374 columns, 412 constraints, and 103 indexes;
- 11 triggers and 15 routines; no policies, enums, views, or standalone sequences;
- schema SHA-256 `7b90ac84b43fe3458a2c2cc50dd02f25fcaaa14529aeba143260d48ebf376f8e`;
- that historical `identity_consents_authorizations_ck` required a non-null exact purpose in the hosted-consent v3 likeness-only branch; and
- `provider_lifecycle_operations_kind_ck` includes `avatar_consent_submit`.

The focused live regression accepted a valid hosted v3 row, rejected the same v3 row with `NULL` purpose on `identity_consents_authorizations_ck`, and accepted a non-v3 legacy row with `NULL` purpose and all required legacy authorizations. Each fixture ran inside a rollback-only transaction.

That historical repaired-in-place variant rejected the null-semantics defect but changed the original `0011` identity. It has been reverted. The current original `0011` still permits a v3 `NULL` purpose; the separate unnumbered proposal above is the only local repair candidate. `drizzle-kit check` passes with the restored original `0011_snapshot.json`.

## Failed Vercel Preview

Deployment `dpl_863GRKTbnshQAJLsH1j53ZWT9QJc` is bound to source `4425a713…` and target `preview`. Vercel reports `BUILD_FAILED`, `Resource provisioning failed`, and `integrations.status=error`. No retained evidence shows an install or build command ran; both `vercel inspect --logs` and the deployment-events API returned no build events. The failing resource/integration is not identified by retained evidence. No provisioning retry was attempted.

## Superseded capture procedure — do not execute

The earlier procedure below assumed that rewriting `0011` in place was safe. The lineage inspection has not established that across archived or undiscovered targets, so this procedure is held pending a separately reviewed additive migration identity and fresh qualification hashes.

Use the official `tools/check-migrations.mjs --capture-schema` path against a newly created, empty PostgreSQL 18.6 verification child database reachable by the Neon driver. The reviewed manifest must declare `environment: verification`, `isDefault: false`, distinct parent/child branch IDs, and a database named `mvp_verification_YYYYMMDD`. Apply exactly the frozen 12-entry journal, then capture to a new candidate file and private receipt; do not overwrite the canonical lock during capture.

The repaired 12-entry hashes above are historical and **not** expected capture values. A future capture must use newly qualified hashes from the additive lineage and independently read back its constraints, indexes, definitions, and zero application rows.

Abort on any final-tip source change, dirty bound file, non-child/default/production target, PostgreSQL version mismatch, non-empty starting database, journal count/order/timestamp/hash mismatch, source-hash mismatch, catalogue hash/count/definition mismatch, application row presence, query/connectivity failure, or unexpected lock-field change. Before any later live additive guard migration, run a strict read-only compatibility query that treats the proposed purpose predicate as `IS NOT TRUE`; any incompatible row requires owner review and a separately scoped data plan.

## Owner approval package

A later owner decision must separately authorize any child-database capture only after additive ordering, final Git SHA, and new expected hashes are reviewed. This phase does not authorize canonical lock replacement, production/default databases, deployment, provider actions, billing, feature activation, merge, or a live migration.

## Reversal record

The disposable container `lux-core-schema-qualification-20261008` (`postgres:18`) and its single anonymous volume were removed with `docker rm --force --volumes`; exact-name `docker ps -a` readback was empty. There was no host bind. Deleting this note reverses the documentation change.

Invariant-repair reversal: revert the bounded edits to `db/schema.js`, `drizzle/0011_concerned_micromacro.sql`, `drizzle/meta/0011_snapshot.json`, and `tests/core-schema-null-purpose.test.mjs`. Each fresh `lux-core-schema-null-purpose-20261008` container and its single anonymous volume was removed with `docker rm --force --volumes`; final exact-name `docker ps -a` readback was empty. There was no host bind.
