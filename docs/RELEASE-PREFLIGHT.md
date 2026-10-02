# Release preparation and rollback

Updated September 30, 2026. These commands prepare evidence; none authorizes deployment, migrations, billing, or provider spend.

## Database checks

`npm run db:check` and `node tools/check-migrations.mjs --snapshot-only` check local Drizzle snapshots only. Neither verifies a live database.

`npm run db:verify -- --environment production --target-manifest config/database-target.production.json --receipt <private-receipt-path>` requires the canonical reviewed nonsecret target manifest and `DATABASE_URL` supplied through an approved credential channel. The production example is deliberately incomplete. Establish that the application's canonical secret maps to the independently observed Neon endpoint before populating it. Integration-prefixed URLs alone do not establish that mapping. Never print the connection string or commit an environment file.

For production, the checker validates the application canonical DATABASE_URL and any optional unpooled URL against the same reviewed target; an alternate good URL cannot mask a wrong application target. Production uses only the regular canonical config/database-schema.lock.json baseline. The checker compares URL host, port, database and role before connecting, then checks SQL database/user identity inside a repeatable-read, read-only transaction. Provider project/branch IDs are declared target metadata, not SQL attestation. External production manifests require a separately trusted expected digest supplied with `--expected-target-sha256` or `VIDEO_OS_DB_TARGET_MANIFEST_SHA256`; do not derive that approval value from the untrusted manifest itself. Receipts bind the manifest and validated connection identity. Missing URL, wrong identity, connectivity/query failures, missing journal, altered/missing/extra migrations and structural schema drift fail.

Drizzle's journal timestamps and SHA-256 of actual migration SQL must match every applied migration. Only exact LF/CRLF variants are accepted to accommodate Git's Windows checkout conversion; equal counts or sequential IDs cannot pass by themselves. The schema fingerprint includes columns/defaults/nullability, constraints, indexes, policies, triggers, views, routines, enums and sequence definitions. It excludes customer rows and sequence counters.

`config/database-schema.lock.json` now comes from the isolated verification database with eleven repository migrations and 27 tables, including the provider ledger and additive source-provenance guard. Its capture is not production verification. It is bound to migration, schema-module and manual guard-SQL source hashes. Recapture is permitted only on a distinct, explicitly isolated verification child branch/database; inspect changes before accepting a new lock. Never capture production drift and call it the expected schema. See the [bridge foundation evidence](execution-notes/20260930-bridge-foundation.md).

## Packaging

`npm run build:preview` performs diagnostic packaging with snapshot-only database status. CI uses this command and therefore does not establish production readiness.

`npm run build:production` requires exact live production verification before and after packaging, unchanged source/project identity, and a passing Workflow boundary check. It never pulls environment secrets or applies migrations automatically.

The HeyGen MVP now makes optional HyperFrames explicitly unavailable and removes its Sandbox SDK import graph. A fresh review build verified no known Sandbox class leakage. The scanner remains mandatory: a disabled feature flag alone does not eliminate emitted classes. Missing or malformed class metadata also fails; the scan covers all manifest keys and values, including SDK step entries. See [the investigation](execution-notes/20260930-prompt4-sandbox.md); an import-only workaround was not safe.

Read-only `--preflight-only` rejects an existing default prebuilt output; run full preparation to quarantine it. All completed packaging remains review-only. Outputs are moved to `.vercel/review-output-<timestamp>-<pid>`; rejected and previous outputs are preserved in analogous sibling directories. `.vercel/output` is absent afterward. The success marker outside the output directory says `releaseAuthorized:false`. Do not move an artifact back or run `vercel deploy --prebuilt` to bypass these gates. A future authorized release must refresh production/alias/storage/P0 checks and bind the final exact artifact.

`.vercel/release-build-manifest.json` records source file hashes, HEAD/dirty status, project-link hash, output file hashes, database evidence, Workflow boundary, rollback metadata and unresolved gates. For the selected HeyGen managed API, a worker image is inapplicable, while runtime scope/account/pricing/privacy/deletion/canary evidence remains unverified. Self-hosted selections still require an immutable image digest. This is a review manifest, never an approved P0 receipt. The old P0 verifier now exits 2 for every verification request; historical approved-looking receipts are not trusted.

## Rollback preparation

The read-only September 30 alias readback names deployment `dpl_AEUWrAaSPEyvNjkkZxCbDAg427WP` for production project `prj_jZYuVgIAk1cwx8MRKE5kGNxn4ItW`; recorded Git SHA is `a04e59513e7cbd5684bf56790311d2ab14676499`. Metadata expires after 24 hours and is not source-byte attestation. A bare `sourceByteAttestation:true` cannot clear the gate; an independent byte-attestation verifier is still required. `config/release-baseline.json` explicitly records that limit and the manifest retains a blocking gate.

Before an authorized release, refresh the stable alias and verify the prior deployment remains usable with the proposed database/storage format. Preserve a private schema/reference backup and exact migration plan. Prefer additive schema changes; do not automatically down-migrate or delete private media during rollback. App rollback selects the independently verified prior deployment only under the approved release scope, followed by owner/fresh-session/download and denial checks. This prompt ran no rollback or production mutation.

Storage copy/reference migration/deletion each requires a concrete reviewed scope. The [storage note](execution-notes/20260930-prompt4-storage.md) specifies inventory, immutable copy/hash comparison, transactional reference changes, denial checks and rollback. Production database references, 26 unclassified production objects and the preview credential binding remain unresolved; current private-store metadata does not prove old public references are absent.

## October 2 refresh transition (review only)

See [the refresh implementation and exact next steps](execution-notes/20261002-release-readiness.md). The source-pinned refresh document is intentionally empty until independently reviewed new provider observations exist. Production runtime resolution is read-only and exact-target checked; operator bootstrap remains forbidden inside deployed production. A refresh neither overwrites immutable DB evidence nor enables creation/billing or clears P0.

Separate operator workflows: [one-shot HeyGen reprobe](HEYGEN-SPACE-REPROBE.md) and [read-only private-media byte verification](PRIVATE-MEDIA-BYTE-VERIFICATION.md). Neither executes during packaging or clears production gates; the reprobe needs new explicit lifecycle approval and has no enforceable dollar cap.
