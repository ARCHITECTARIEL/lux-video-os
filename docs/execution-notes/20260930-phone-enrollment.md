# One-time phone enrollment and shared script interface — September 30, 2026

Status: verified local implementation and isolated integration; review-only packaging complete. Real-provider and production activation remain blocked.

## Scope and source

Owner request: enroll once with a phone photo and video, explicitly authorize extraction of a reusable voice sample, then use scripts for Standard and Premium. HeyGen is the selected MVP provider for both tiers; free/open-source ROI research remains separate.

Repository: `C:\Users\ariel\lux-video-os`, branch main, HEAD `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9`. The inherited dirty checkout was preserved. No commit, push or deployment is part of this work.

## Implementation

- Versioned enrollment API, private direct multipart upload, source hashing, five separate permissions, bounded FFmpeg extraction, immutable derived voice asset, recoverable state, revocation and provider-reconciliation records.
- The original video is used only for consented audio extraction. The photo remains the visual source. Locally extracted audio does not imply successful provider voice cloning or verified speaker identity.
- Photo/Video/Consent/Creating/Ready interface with photo/video preview, explicit camera/microphone request, recording cleanup, mobile fallback, account-scoped recovery and no third voice upload.
- Shared owned-identity, title, script and format interface for Standard/Premium, with server-priced confirmation, signed idempotency-bound quotes and recovery. Unsupported Premium controls are unavailable. Existing history and accepted-output behavior remain versioned.
- New API URLs route through the existing workspace function, preserving the nine API plus three Workflow function budget. Existing tooling builds the browser Blob client and stages the Linux FFmpeg executable.

## Security review and verification approach

Independent review covers private-store admission before customer upload, source/consent provenance, derived-voice rebinding, provider submission during withdrawal, cleanup and quarantined reads. A separate review covers signed quote reuse, transaction lock order, expiry across lock waits, and crash recovery between reservation and workflow dispatch.

Real FFmpeg hostile-media checks enforce output limits during writes and one processing deadline, rather than checking only after extraction. Browser tests use controlled API responses and synthetic media; they cannot certify a real provider result.

## Isolated external changes

Only the existing dedicated verification resources were used: Neon project `dawn-scene-51988854`, child branch `br-wandering-violet-ai1egt3g`, database `mvp_verification_20260930`, private Blob store `store_8uyr0JDWkUyha8sy`.

Migration 0007 adds the enrollment and event tables. Migration 0008 adds dispatch/provider receipts and unique source/derived asset indexes. Both migrations were reviewed and applied in sequence; existing migration files were not rewritten. The exact nine-migration journal and18-table schema were independently read back. Evidence is under [enrollment-20260930](enrollment-20260930/).

Schema SHA-256: `6a9c414e122be3addff9d84a043b001f9959a341d05f559ce3b2129cbaaf9707`.
Migration-set SHA-256: `ac93933eaaf9a70d48a21513dc4c72cf0dd102b9d2810fee6c3a651ef2e1fc60`.

## Final verification

| Check | Result | Evidence |
|---|---|---|
| Full Node suite | 449 passed, 44 environment/guarded skips, zero failures; exit 0 | `enrollment-20260930/unit-final.log` |
| Vitest | Four passed; exit 0 | Same unit log |
| Full browser suite | 110 passed, one intentionally gated production-proof skip; exit 0 | `enrollment-20260930/e2e-verified.log`, `e2e-exit.txt` |
| Python | 48 passed, one Windows symlink-privilege skip; exit 0 | `enrollment-20260930/pytest.log` |
| Real isolated DB/Blob integration | Two passed, zero skips/failures; exit 0 | `enrollment-20260930/integration-final.json` and log |
| Isolated cleanup | All 18 application tables empty, zero Blob objects | `enrollment-20260930/cleanup-final.json` |
| Runtime npm audit | Zero vulnerabilities; gate exit 0 | `enrollment-20260930/runtime-audit.json`, `audit.log` |
| Imports, workflow validation, migration snapshots, whitespace | Passed | `imports.log`, `workflow-validate.log`, `db-check.log`; git diff check |
| Client and built-static privacy | Passed; 36 built static text files checked | `privacy.log`, `build-client-privacy.json` |
| Preview packaging | Exit 0; 42 routes, 98 steps, 6 workflows; quarantined/review-only | `build-preview.log`, `build-summary.json` |
| Visual review | 92/pass; 18 desktop/mobile captures, no page errors/overflow | `.design/qa-report.md`, `.design/browser-visual-checks.json` |

The ordinary Node suite intentionally skips live tests; the two new guarded integration tests were run separately against the pinned verification resources. The live run proves actual SDK multipart private upload, anonymous denial, hashing, real FFmpeg extraction, persisted identity, new-policy provider/render authorization and a shared script context. Synthetic provider-ready IDs are explicitly database-only fixtures. It also proves derived-voice rebind denial, durable orphan receipts after revoke, a real late upload after initial deletion being removed on the post-expiry check, and abandoned FAILED expiry/cleanup. Quote tests cover real concurrent reservation and a held credit-row lock crossing quote expiry with no debit/job mutation.

The first integration attempts caught SDK URL hostname-casing differences and an old-policy/new-policy authorization mismatch; both were repaired without weakening byte, ownership or consent checks. Independent provider tests verify actual route sequencing with mocked remote boundaries. The final security verdict is PASS for the contained implementation, with external provider deletion/reconciliation still an activation gate.

The initial review build exposed a real Workflow realm error. Cleanup policy now executes in a server step, and the legacy `driveStandardJob` poll helper has the missing `use step` directive. The installed compiler independently proved this removes the database/Node dependency graph from the workflow realm. Direct poller behavior and simulation regressions pass. The new real-SWC regression guards this boundary. Existing Sandbox serde leakage is a separate pre-existing release blocker; no release guard was weakened.

## Exact candidate

- HEAD: `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9`; dirty source preserved.
- Source SHA-256: `4ed666e9b465596427e7c7b20fe36df2364362310e6104f5dc06407624bd262b`.
- Output SHA-256: `215abfba2f5000e4247092ffeb0de4818f7f20a450955d32d459e5e4730456b0`.
- Source/project-link readback matches the build manifest; `.vercel/output` is absent.
- Full source and output file ledgers: `enrollment-20260930/source-files.json` and `output-files.json`.
- Machine-readable result: `enrollment-20260930/verification-summary.json`.

## Activation limits and next action

The enrollment, extraction and shared-render flags remain off by default. No HeyGen enrollment, voice-cloning, paid render, production migration, production data mutation, environment change or deployment occurred.

Read [the runbook](../PHONE-ENROLLMENT-RUNBOOK.md) for source ownership, flags, recovery and exact release prerequisites. Next release work requires provider account economics/privacy qualification, canonical production DB/private-store proof, the existing Workflow/Sandbox boundary repair, current-source CI and an explicitly bounded real-device/HeyGen canary. Local tests do not replace those observations.

