# Core schema qualification — October 8, 2026

## Scope and source boundary

Schema-source baseline: `4425a713a51edbb3b907000d27226e2cba16e330`. The branch has since received non-schema review work; set the release candidate to the final exact tip only after confirming the files below still produce the qualified hashes. This lane performed no production, provider, deployment, publication, or schema-lock mutation.

Bound files: `drizzle/*.sql`, `drizzle/meta/_journal.json`, `drizzle/meta/0011_snapshot.json`, `db/schema.js`, `db/standard-narration-schema.js`, and `db/provider-lifecycle-guards.sql`.

## Finding and repaired candidate

The canonical lock is internally valid for `0000`–`0010`, but stale for the candidate's repaired `0000`–`0011` source set. These are the only expected values for a future capture:

| Evidence | Qualified repaired value |
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

GitHub Actions run `37801033736` used the original schema-source baseline. It failed in `npm run test:unit` before `db:check`: the Workflow packaging test compared the old lock's `7c8b…` schema-source hash with the then-current `042c…` hash. This is historical `SCHEMA_LOCK_STALE` evidence, not catalogue-drift evidence; the repaired source now has the qualified hashes above.

## Disposable PostgreSQL evidence

PostgreSQL `18.6` replayed `0000` through `0011` from empty in journal order. Every migration and journal insert exited `0`; the repository's `assertMigrationRows` accepted all 12 exact LF checkout hashes and timestamps.

The repository's own `readSchemaCatalogue` plus `schemaDigest` produced:

- 27 tables, 374 columns, 412 constraints, and 103 indexes;
- 11 triggers and 15 routines; no policies, enums, views, or standalone sequences;
- schema SHA-256 `7b90ac84b43fe3458a2c2cc50dd02f25fcaaa14529aeba143260d48ebf376f8e`;
- `identity_consents_authorizations_ck` requires a non-null exact purpose in the hosted-consent v3 likeness-only branch; and
- `provider_lifecycle_operations_kind_ck` includes `avatar_consent_submit`.

The focused live regression accepted a valid hosted v3 row, rejected the same v3 row with `NULL` purpose on `identity_consents_authorizations_ck`, and accepted a non-v3 legacy row with `NULL` purpose and all required legacy authorizations. Each fixture ran inside a rollback-only transaction.

The historical null-semantics defect is repaired. `identity_consents.consent_purpose` remains globally nullable for legacy policies, while the v3 branch explicitly requires `consent_purpose IS NOT NULL` before the exact value check. `drizzle-kit check` passes with the matching `0011_snapshot.json` definition.

## Failed Vercel Preview

Deployment `dpl_863GRKTbnshQAJLsH1j53ZWT9QJc` is bound to source `4425a713…` and target `preview`. Vercel reports `BUILD_FAILED`, `Resource provisioning failed`, and `integrations.status=error`. No retained evidence shows an install or build command ran; both `vercel inspect --logs` and the deployment-events API returned no build events. The failing resource/integration is not identified by retained evidence. No provisioning retry was attempted.

## Supported trusted capture procedure — future approval only

Use the official `tools/check-migrations.mjs --capture-schema` path against a newly created, empty PostgreSQL 18.6 verification child database reachable by the Neon driver. The reviewed manifest must declare `environment: verification`, `isDefault: false`, distinct parent/child branch IDs, and a database named `mvp_verification_YYYYMMDD`. Apply exactly the frozen 12-entry journal, then capture to a new candidate file and private receipt; do not overwrite the canonical lock during capture.

Expected capture values are only the repaired 12-entry migration/source/catalogue hashes above and `tableCount: 27`. Independently read back 412 constraints, 103 indexes, the two named definitions, and zero application rows before presenting the lock diff.

Abort on any final-tip source change, dirty bound file, non-child/default/production target, PostgreSQL version mismatch, non-empty starting database, journal count/order/timestamp/hash mismatch, source-hash mismatch, catalogue hash/count/definition mismatch, application row presence, query/connectivity failure, or unexpected lock-field change. Before any later live `0011` migration, run a strict read-only compatibility query that treats the new authorization predicate as `IS NOT TRUE`; any legacy, false, or null-policy row requires owner review and a separately scoped data plan.

## Owner approval package

A later owner decision must separately authorize all of the following: creation of the named verification child database, applying `0000`–`0011` there, capture to a new candidate lock, review of the exact diff/receipt, and replacement of `config/database-schema.lock.json`. The package must name the final Git SHA and expected hashes/counts above. It must explicitly exclude production/default databases, deployment, provider actions, billing, feature activation, merge, and live `0011` migration.

## Reversal record

The disposable container `lux-core-schema-qualification-20261008` (`postgres:18`) and its single anonymous volume were removed with `docker rm --force --volumes`; exact-name `docker ps -a` readback was empty. There was no host bind. Deleting this note reverses the documentation change.

Invariant-repair reversal: revert the bounded edits to `db/schema.js`, `drizzle/0011_concerned_micromacro.sql`, `drizzle/meta/0011_snapshot.json`, and `tests/core-schema-null-purpose.test.mjs`. Each fresh `lux-core-schema-null-purpose-20261008` container and its single anonymous volume was removed with `docker rm --force --volumes`; final exact-name `docker ps -a` readback was empty. There was no host bind.
