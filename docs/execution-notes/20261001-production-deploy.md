# Production deploy — October 1, 2026

Status: executed, owner-approved. This is a routine code deploy, not a launch -- no provider creation/render activation or billing flag changed.

## What happened

With the owner's explicit go-ahead, commit `c424b82c025b412778f5057a5a451dcb1daeca69` (today's consolidated WIP merge, production migrations, schema-lock recapture, and the new `authorize-release.mjs` tool itself, plus two bug fixes it surfaced -- see below) was deployed to real production.

Sequence:
1. `npm run build:production` packaged a fresh, quarantined candidate against this exact commit.
2. `tools/authorize-release.mjs --owner-authorized` re-verified, immediately before deploy: source identity unchanged and clean since packaging, quarantined-output integrity, a fresh production DB check (11/11 migrations, 27/27 tables, matches what was packaged), the Workflow sandbox boundary, and current-candidate CI (`verify` + `analyze`, both green on GitHub). All passed; `routineDeployAuthorized: true`. `releaseAuthorized` remained `false` throughout, as designed -- see "What this does and does not establish" below.
3. The tool restored the quarantined output to `.vercel/output`.
4. `vercel deploy --prebuilt --prod --yes --archive=tgz` deployed it. (`--archive=tgz` was required: the plain upload path rejected the 15,972-file output with `missing_archive`/`files should NOT have more than 15000 items`. The first archived attempt hit a transient `fetch failed` after a full 366.3MB upload; the immediate retry succeeded.)
5. Deployment `dpl_DwnBbSCn8wwQrMzBgc6o8UQGwHJE` reached `READY` and was aliased to the stable production URL, `https://lux-video-os.vercel.app`.
6. Smoke-tested `/welcome` and `/api/video-os-lite/workspace` on the live alias: both returned `200`.
7. `config/release-baseline.json` was updated to this new deployment as the current rollback baseline; the prior baseline (`dpl_AEUWrAaSPEyvNjkkZxCbDAg427WP`, Sept 24) is preserved under `previousBaseline` for reference, not deleted from Vercel's own history.

## Two real bugs this process caught and fixed along the way

Building `authorize-release.mjs` and actually running it against a live candidate surfaced:

- A cross-platform test bug (`tests/inventory-release-storage.test.mjs`) hardcoding a Windows temp path, which only ever ran on Windows locally before today -- this was the first time this test executed on GitHub's Linux CI runner, since it was part of today's merge.
- 5 CodeQL findings on the same first-ever-Linux-CI-run commit, reviewed and allowlisted with specific reasoning (see `tools/enforce-codeql-sarif.mjs` and that commit's message) -- none were exploitable on inspection.
- A bug in `authorize-release.mjs` itself: its first `outputInventory()` implementation omitted the `bytes` field present in `release-build-manifest.mjs`'s own version, causing `outputIntegrityIntact` to report `false` even though a file-by-file diff showed zero actual differences -- a silent JSON-shape mismatch, not a real integrity problem. Fixed, with a regression test asserting the exact record shape.

Each of these required its own commit, its own CI run, and a fresh rebuild before the deploy could proceed -- consistent with the tool correctly failing closed on "source changed since packaging" each time.

## What this does and does not establish

- Does establish: this exact, reviewed, CI-passing commit is now the live production code. Production's database and code are both current.
- Does not establish: the P0/launch release gate. `providerCreationActivationStatus()` (`db/provider-reconciliation-repository.js`) remains hardcoded `{ enabled: false }` -- no HeyGen provider creation or render submission is possible from this deployment. Billing, the HeyGen provider-space binding bootstrap, and the real paid-render P0 proof are all separate, still-outstanding, owner-gated steps (`outstandingLaunchGates` in every `authorize-release.mjs` run: `PRODUCTION_P0_RECEIPT`, the six HeyGen provider gates, `ROLLBACK_SOURCE_BYTES_UNATTESTED`, etc.).
- Does not establish: rollback byte-attestation. `config/release-baseline.json`'s `sourceByteAttestation` remains `false`, as it has throughout this project -- no independent verifier for this exists yet.

## Next action

Resume the HeyGen provider-space binding wiring (bootstrap a real production binding using the rotated `HEYGEN_API_KEY`, now live in this deployment) -- this was the original Phase 2 goal, paused when the deploy-blocking gaps above were discovered and fixed. The activation switch itself remains a separate, later, explicitly owner-gated decision.
