# Dependency repair and isolated live DB/Blob verification

Date: 2026-09-30. Status: **requested advisories repaired; isolated live verification passed**.
Source HEAD remains `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9`; inherited work is preserved and uncommitted. No deployment, production database/environment change, or paid render/provider call occurred.

## Dependency outcome

All five requested advisory IDs are absent from the **full development-inclusive** dependency graph. The additional discovered critical `tar` finding was also repaired. `npm audit --omit=dev` exits 0 with **zero vulnerabilities**. The existing audit gate passes without new exceptions or weakened policy.

Changes: Workflow 4.8.9, patched same-major Undici/Nano ID/decompression/brace-expansion resolutions, plus tar 7.5.22. See [dependency repair detail](20260930-dependency-repair.md) for exact paths, compatibility rationale and backups.

The unrestricted `npm audit` still exits 1 for **43 other development-tool package findings: 24 high, 18 moderate, 1 low, zero critical**. These are not any of the five requested IDs and do not enter the production graph. This is not a claim that the entire development dependency graph is vulnerability-free. [Independent audit receipt](live-verification-20260930/dependency-audit.json).

## Isolated resources and safety

| Resource | Verified identity |
|---|---|
| Neon project | `dawn-scene-51988854` |
| New nondefault branch | `br-wandering-violet-ai1egt3g`, `codex-mvp-verification-20260930` |
| Test endpoint | `ep-lingering-fire-aitvfm3y` |
| New initially empty database | `mvp_verification_20260930` |
| New private Blob store | `store_8uyr0JDWkUyha8sy`, `lux-video-os-verification-20260930`, iad1 |
| Undeployed test-only Vercel project | `prj_vbZKWodyUtKSJMhgLUiTSjoVnlQB`, `lux-video-os-verification-20260930` |
| Store connection | Test project **development** environment only |

The branch was copied from the default branch, but tests ran only in the separately created empty database, not the copied default database. Neither parent/default database nor existing Blob store was used for writes. The repository's Vercel link was not changed.

The runner pins the exact test host/database/store, checks SQL `current_database()`, blocks default targets and clears real provider/email/billing credentials from child processes. Test credentials are outside the repository at `%TEMP%/lux-mvp-live-20260930/live.env`; do not copy this file into Git, logs or handoff packets. The temporary directory has its own test-project link, separate from the production-linked checkout.

The original dirty state was backed up under `%TEMP%/lux-live-verification-baseline-20260930T133833Z`; the dependency specialist also backed up both manifests before editing.

## Evidence

- [Preflight](live-verification-20260930/preflight.json): empty DB/store, private Blob upload/read SHA match, anonymous 403, temporary object deleted, zero objects afterward.
- [Migrations](live-verification-20260930/migrations.json): seven repository migrations applied only to the empty test DB; every applied journal hash equals its source SQL SHA-256. Sixteen application tables initially had zero rows.
- [Live application suite](live-verification-20260930/application-tests.json): **102 passed, zero failed, zero skipped**, exit 0, across ten explicitly listed files. Real database and Blob operations cover Standard consent/quote/reservation/render/settlement, auth entitlements, admin operations, notifications with mocked email provider, watchdog behavior and recovery.
- [Detailed live proof](live-verification-20260930/application-tests.detail.json): real MP4 decode and storage, canonical immutable reuse, two concurrent finalizations → **one debit, one final asset, one completion event**. Balance 500→410, reserved 0, spent 90. Owner download 200 with equal SHA; anonymous 401; wrong account 404; direct private Blob 403. Corrupt output rejected without additional charge. A real Postgres lock wait was observed and a committed revocation blocked the waiting submission claim with ENTITLEMENT.
- [Cleanup](live-verification-20260930/final-cleanup.json): removed 17 remaining test objects and residual test rows; **zero Blob objects and zero rows in all 16 application tables**. Migration metadata remains. Test resources are retained for repeatable verification; no other resources were removed.

The live MP4 proof was 17,599 bytes, H.264/AAC, 1920x1080, 998 ms; SHA-256 `59ae892737b42779926d07b57c8fb201d93c779cdd5ac9c20edf1375fe0a24ad`. SQL and Blob are real. Video generation is local FFmpeg, and external Google/email/provider boundaries remain test doubles. This is not paid provider or production P0 evidence.

## Problems found and corrected during verification

1. A test process stayed alive after database activity ended. The scoped runner now has a 120-second test timeout, Node's force-exit-after-tests option, incremental credential-redacted logs, and recorded child exit codes. It does not force unresolved test assertions to pass.
2. The new concurrency test initially reused one synthetic provider ID for two jobs and correctly hit the real unique constraint. Each synthetic provider ID is now job-specific. The failed [first attempt](live-verification-20260930/final-acceptance-attempt1.json) remains recorded.
3. The old missing-narration test tried to delete FK-protected metadata and expected the pre-Prompt-3 simulation uncertainty behavior. It now removes only its owned Blob bytes, retains protected consent/metadata, and proves deterministic failure releases the reservation. The happy path now resumes a genuinely persisted `provider_submitted` stage. The prior [100-pass/1-fail batch](live-verification-20260930/application-tests-attempt1.json) and cleanup evidence are retained.

No production constraint or business rule was relaxed to make these tests pass.

## Final local checks and files

- `npm run test:unit`: exit 0; Node **336 pass / 0 fail / 41 credential-gated skips**, Vitest **4 pass**. The separate live run above is the credentialed evidence; do not count offline skips as passes.
- Audit-gate tests: 7 pass. Workflow validation/imports pass. Workflow build: exit 0, 93 steps/two workflows, with the previously recorded Sandbox serialization warning.
- `npm ci --dry-run --ignore-scripts --no-audit --no-fund` and `git diff --check`: exit 0.

Changed in this continuation: `package.json`, `package-lock.json`, `tests/render-worker.test.mjs`; new `tests/live-final-acceptance.test.mjs`, `tools/verify-isolated-live.mjs`; execution notes/evidence, current handoff, plan and work log. No new product feature or schema migration was added.

Simplification: one guarded runner handles explicit test targets, migration fingerprint checks, scoped test execution and verified test-data cleanup; no production credential reuse or broad audit exceptions.

## Resume

The requested dependency blocker and isolated DB/Blob evidence gaps are resolved for the tested paths. Continue the remaining **Prompt 4** release-integrity work: fail-closed production target/migration verification, real P0 proof tooling, current-source CodeQL, operational reconciliation and Sandbox runtime warning. Address the unrelated development-tool advisories through separately reviewed compatible upgrades. Hosted runtime capacity, real provider inference, live billing, production migration state and the full production P0 receipt remain unverified.

For another isolated test run, load the external test env file and set `VIDEO_OS_LIVE_REPORT` to a new receipt path, then run `node --env-file=<external-test-env> tools/verify-isolated-live.mjs tests <explicit tests/*.test.mjs files>`. Do not repoint its hard guards at a default database or an existing production Blob store. Cleanup applies only to this initially empty, dedicated test target.
