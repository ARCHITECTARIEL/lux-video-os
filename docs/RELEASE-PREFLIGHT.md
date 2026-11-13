# Release preparation and rollback

Originally updated September 30, 2026; schema-lock status refreshed October 16. These commands prepare evidence; none authorizes deployment, migrations, billing, or provider spend.

## Database checks

`npm run db:check` and `node tools/check-migrations.mjs --snapshot-only` check local Drizzle snapshots only. Neither verifies a live database.

`npm run db:verify -- --environment production --target-manifest config/database-target.production.json --receipt <private-receipt-path>` requires the canonical reviewed nonsecret target manifest and `DATABASE_URL` supplied through an approved credential channel. The production example is deliberately incomplete. Establish that the application's canonical secret maps to the independently observed Neon endpoint before populating it. Integration-prefixed URLs alone do not establish that mapping. Never print the connection string or commit an environment file.

For production, the checker validates the application canonical DATABASE_URL and any optional unpooled URL against the same reviewed target; an alternate good URL cannot mask a wrong application target. Production uses only the regular canonical config/database-schema.lock.json baseline. The checker compares URL host, port, database and role before connecting, then checks SQL database/user identity inside a repeatable-read, read-only transaction. Provider project/branch IDs are declared target metadata, not SQL attestation. External production manifests require a separately trusted expected digest supplied with `--expected-target-sha256` or `VIDEO_OS_DB_TARGET_MANIFEST_SHA256`; do not derive that approval value from the untrusted manifest itself. Receipts bind the manifest and validated connection identity. Missing URL, wrong identity, connectivity/query failures, missing journal, altered/missing/extra migrations and structural schema drift fail.

Drizzle's journal timestamps and SHA-256 of actual migration SQL must match every applied migration. Only exact LF/CRLF variants are accepted to accommodate Git's Windows checkout conversion; equal counts or sequential IDs cannot pass by themselves. The schema fingerprint includes columns/defaults/nullability, constraints, indexes, policies, triggers, views, routines, enums and sequence definitions. It excludes customer rows and sequence counters.

`config/database-schema.lock.json` now binds 17 repository migrations (`0000–0016`) and 29 public tables. Its exact candidate was captured and strictly read back on a dedicated PostgreSQL 18.6 verification child, then independently reviewed; see the [0016 qualification](SCHEMA-LOCK-0016-QUALIFICATION-20261016.md). This is not production verification. The lock binds migration, schema-module and manual guard-SQL source hashes. Recapture is permitted only on a distinct, explicitly isolated verification child branch/database; inspect changes before accepting a new lock. Never capture production drift and call it the expected schema.

## Packaging

`npm run build:preview` performs diagnostic packaging with snapshot-only database status. CI uses this command. A successful preview package is not production readiness.

`npm run build:production` requires exact live production verification before and after packaging, unchanged source/project identity, and a passing Workflow boundary check. It never pulls environment secrets or applies migrations automatically.

The HeyGen MVP now makes optional HyperFrames explicitly unavailable and removes its Sandbox SDK import graph. A fresh review build verified no known Sandbox class leakage. The scanner remains mandatory: a disabled feature flag alone does not eliminate emitted classes. Missing or malformed class metadata also fails; the scan covers all manifest keys and values, including SDK step entries. See [the investigation](execution-notes/20260930-prompt4-sandbox.md); an import-only workaround was not safe.

Read-only `--preflight-only` rejects an existing default prebuilt output; run full preparation to quarantine it. Completed packaging stays review-only until a sanctioned restore. Outputs are moved to `.vercel/review-output-<timestamp>-<pid>`; rejected and previous outputs are preserved in analogous sibling directories. `.vercel/output` is absent afterward. The success marker outside the output directory says `releaseAuthorized:false`.

Production restore is `node tools/authorize-release.mjs --owner-authorized`. It re-checks the quarantined production manifest hash, source identity, a fresh production database verification, the workflow boundary, current-candidate CI, and space authority. It restores `.vercel/output` only when every one of those gates passes and `--owner-authorized` was passed. Moving a production artifact back by hand, or running `vercel deploy --prebuilt --prod`, bypasses those gates. A future authorized production release must still refresh production/alias/storage/P0 checks and bind the final exact artifact. Preview authorization does not clear them. `releaseAuthorized` stays false.

Preview restore is `npm run release:authorize-preview` (`node tools/authorize-preview.mjs --target=preview`, also reached by `node tools/authorize-release.mjs --target=preview`). It accepts only a quarantined `npm run build:preview` artifact. It re-checks the manifest bytes against the packaging receipt and re-hashes the output with the same inventory fingerprint the production tool uses. A production artifact, a production target, a missing manifest, or a manifest whose bytes or output hash do not match the receipt is refused. This path reads no production database credentials and opens no database connection. Before restoring, it requires `functions/.well-known/workflow/v1/flow.func`, `functions/.well-known/workflow/v1/step.func`, the three enrollment workspace routes (`/api/video-os-lite/enrollments`, `enrollment-upload`, `scripted-photo`), and the four identity-enrollment workflow ids in `diagnostics/workflows-manifest.json`. A missing piece fails the restore and leaves the artifact quarantined. On success it prints `vercel deploy --prebuilt --archive=tgz` and does not execute it. That command has no `--prod` flag.

`--archive=tgz` is required. Vercel rejects a prebuilt upload above 15,000 files, and this project's output is over that limit (about 15,071 files). `build:preview` and the preview restore warn when the inventoried file count is over 15,000. The archive flag is how that upload gets through the limit.

A plain git deployment, `vercel deploy`, or `vercel redeploy` of this project builds only `api/**` as configured in `vercel.json`. Those deploys do not create `.well-known/workflow/v1` flow and step functions, so enrollment workflows do not run on Preview. Use `npm run build:preview` and the preview restore above.

The preview restore prints the checkout's changed paths. A clean checkout is accepted. A dirty checkout is accepted only when the changed paths are exactly these five tooling files: `tools/authorize-preview.mjs`, `tools/preview-upload-limit.mjs`, `tools/authorize-release.mjs`, `tools/build-production.mjs`, and `package.json`. Any other dirty path, including an uncommitted `lib/` edit on top of that overlay, refuses the restore.

## Preview of an unmerged branch

This is the sanctioned way to deploy a Preview that contains workflow `flow.func` and `step.func`. It does not merge the branch, and it does not touch production. Example below: PR #139, commit `d647c7467e384501c1d2f571acb7a5ad4b13f7ef`, plus the preview-restore tooling. Do the overlay before `npm run build:preview`, and do not edit the tree again before `npm run release:authorize-preview`. The restore checks that the source hash still matches the manifest.

```bash
git fetch origin cursor/desktop-capture-duration-3ccc cursor/preview-restore-path-38b7
git worktree add --detach /tmp/lux-pr-139-preview d647c7467e384501c1d2f571acb7a5ad4b13f7ef
cd /tmp/lux-pr-139-preview
for f in tools/authorize-preview.mjs tools/preview-upload-limit.mjs tools/authorize-release.mjs tools/build-production.mjs package.json; do
  git show "origin/cursor/preview-restore-path-38b7:$f" > "$f"
done
```

A fresh worktree has no `.vercel/project.json`. Packaging then fails with ENOENT. Link this worktree to the real project `lux-video-os`. Do not link PR previews to `lux-video-os-rebuild`.

```bash
vercel link --yes --project lux-video-os --scope lux-3035s-projects
vercel pull --environment=preview
```

`vercel pull --environment=preview` writes non-sensitive environment values into the gitignored `.vercel/` directory, including `.vercel/.env.preview.local`. Delete those env files after the deploy. Do not copy them into another checkout.

`npm ci` when `node_modules` is absent. `npm run build:preview` downloads a Linux ffmpeg binary when its cache is empty, so that step needs network access. Then restore and deploy. The restore needs no production `DATABASE_URL`. Run the command it prints. That command is `vercel deploy --prebuilt --archive=tgz`. Do not add `--prod`. `--archive=tgz` is required because the output is over the 15,000-file upload limit.

```bash
npm ci
npm run build:preview
npm run release:authorize-preview
vercel deploy --prebuilt --archive=tgz
test -f .vercel/output/functions/.well-known/workflow/v1/flow.func/.vc-config.json
test -f .vercel/output/functions/.well-known/workflow/v1/flow.func/index.js
test -f .vercel/output/functions/.well-known/workflow/v1/step.func/.vc-config.json
test -f .vercel/output/functions/.well-known/workflow/v1/step.func/index.js
```

The URL printed by `vercel deploy` is a Preview on `lux-video-os`. The two `test` commands confirm the uploaded output still contains the workflow flow and step functions. A plain git or CLI redeploy does not.

Moving that deployment onto the production alias is a separate step and needs its own explicit approval. This recipe does not alias the preview.

Cleanup, from the worktree and then from the main checkout:

```bash
rm -f .vercel/.env.preview.local .vercel/.env.development.local .vercel/.env.production.local
cd -
git worktree remove --force /tmp/lux-pr-139-preview
```

`.vercel/release-build-manifest.json` records source file hashes, HEAD/dirty status, project-link hash, output file hashes, database evidence, Workflow boundary, rollback metadata and unresolved gates. For the selected HeyGen managed API, a worker image is inapplicable, while runtime scope/account/pricing/privacy/deletion/canary evidence remains unverified. Self-hosted selections still require an immutable image digest. This is a review manifest, never an approved P0 receipt. The old P0 verifier now exits 2 for every verification request; historical approved-looking receipts are not trusted.

## Rollback preparation

The read-only September 30 alias readback names deployment `dpl_AEUWrAaSPEyvNjkkZxCbDAg427WP` for production project `prj_jZYuVgIAk1cwx8MRKE5kGNxn4ItW`; recorded Git SHA is `a04e59513e7cbd5684bf56790311d2ab14676499`. Metadata expires after 24 hours and is not source-byte attestation. A bare `sourceByteAttestation:true` cannot clear the gate; an independent byte-attestation verifier is still required. `config/release-baseline.json` explicitly records that limit and the manifest retains a blocking gate.

Before an authorized release, refresh the stable alias and verify the prior deployment remains usable with the proposed database/storage format. Preserve a private schema/reference backup and exact migration plan. Prefer additive schema changes; do not automatically down-migrate or delete private media during rollback. App rollback selects the independently verified prior deployment only under the approved release scope, followed by owner/fresh-session/download and denial checks. This prompt ran no rollback or production mutation.

Storage copy/reference migration/deletion each requires a concrete reviewed scope. The [storage note](execution-notes/20260930-prompt4-storage.md) specifies inventory, immutable copy/hash comparison, transactional reference changes, denial checks and rollback. Production database references, 26 unclassified production objects and the preview credential binding remain unresolved; current private-store metadata does not prove old public references are absent.
