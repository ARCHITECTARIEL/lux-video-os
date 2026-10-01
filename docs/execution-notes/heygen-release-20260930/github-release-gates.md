# HeyGen MVP GitHub and release gate audit

Audited: `2026-09-30T18:54:03Z`
Mode: read-only GitHub/local inspection; no commit, push, PR, comment, workflow dispatch, merge, deployment, environment change, provider call, payment action, or production-data access.

## Decision

The audited `4ed666…` checkpoint is **not publishable or releasable yet**, although its exact local verification package is strong. GitHub has no object or check suite for it because every implementation change remains uncommitted. While this audit was in progress, expected release-gate work changed four governed files and moved the live working fingerprint to `b2e7e583…`; that newer source is still in progress and does not yet have a final root-issued test/build summary. The `4ed666…` proof remains valid for its checkpoint, but it must not be attributed to the newer source. The minimum safe next external step is a curated **draft candidate PR**, not a merge or deployment, after root freezes the final fingerprint and the local publication-safety items below are closed.

This is a HeyGen MVP gate. LatentSync, RunPod, and self-hosted model/image proof are not prerequisites for the selected provider path. The `4ed666…` checkpoint still carried a generic worker-image gate and HyperFrames/Sandbox leakage. The in-progress `b2e7e583…` source contains target-scoping/removal repairs that require a fresh build manifest before they count as closed.

## Exact candidate identity

| Identity | Observed value | Meaning |
|---|---|---|
| Repository | [`ARCHITECTARIEL/lux-video-os`](https://github.com/ARCHITECTARIEL/lux-video-os), currently **PUBLIC** | Any pushed branch, PR diff, committed evidence, or comment must be safe for public disclosure. |
| Local branch / Git HEAD | `main` / `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9` | Local Git ancestry is still the September 29 merge commit. |
| Live GitHub `main` | [`1c6121f83dd455fc8fbac4c96332a284dd9e0bb9`](https://github.com/ARCHITECTARIEL/lux-video-os/commit/1c6121f83dd455fc8fbac4c96332a284dd9e0bb9) | Local HEAD, `origin/main`, and live GitHub main match. |
| Audited checkpoint content hash | `4ed666e9b465596427e7c7b20fe36df2364362310e6104f5dc06407624bd262b` across 383 governed source files | This is a file-content fingerprint, not a Git commit SHA. GitHub cannot check or deploy it directly. |
| Working fingerprint at audit close | `b2e7e583a660823f76d32fda8c3f6d4befa2238846d4fc7cba69c7af1743a7f5` across the same 383 governed paths | Expected concurrent release-gate edits changed `services/hyperframes-finisher.js`, `tests/hyperframes-boundary.test.mjs`, `tests/release-build-gates.test.mjs`, and `tools/release-build-manifest.mjs`. Root has not declared the final freeze hash yet. |
| Linked Vercel project | `prj_jZYuVgIAk1cwx8MRKE5kGNxn4ItW`; project-link SHA-256 `12fd6ef128686d8ed4918a6f214780ca46ba87a9397892f46ec55356f75054f2` | Identifies the production project link; it grants no deployment authority. |
| Review build | Output SHA-256 `215abfba2f5000e4247092ffeb0de4818f7f20a450955d32d459e5e4730456b0`; `REVIEW_ONLY`; quarantined | Diagnostic preview proof only. Default `.vercel/output` is absent. |

The `4ed666…` source/output identity and verification totals are recorded in [the exact-candidate verification summary](../enrollment-20260930/verification-summary.json). Adding this audit note does not change governed source fingerprints because release source capture intentionally excludes `docs/`. A new summary is required for `b2e7e583…` or any later root-frozen source.

## Live GitHub state

- `gh repo view` reported `isPrivate:false`, default branch `main`, and current viewer permission `ADMIN`.
- The main branch has **no branch protection**: the branch-protection API returned `404 Branch not protected`.
- The repository has **no repository rulesets**: the rulesets API returned `[]`.
- Active workflows are CI, CodeQL, LatentSync worker image, RunPod Standard worker image, Stripe reconciliation, Watchdog sweep, and Dependabot Updates. Worker-image workflows are separate maintenance surfaces and do not become HeyGen MVP gates.
- Nine open PRs remain, all unrelated Dependabot updates [#59–#67](https://github.com/ARCHITECTARIEL/lux-video-os/pulls?q=is%3Apr+is%3Aopen+author%3Aapp%2Fdependabot). Their September 23 checks are stale for this candidate and their merge states are `UNSTABLE`; do not fold them into the MVP candidate.

### Checks on current remote main

| Check | Live result | What it proves |
|---|---|---|
| CI `verify` | [Run 36579873920](https://github.com/ARCHITECTARIEL/lux-video-os/actions/runs/36579873920) succeeded on `1c6121f…` | The old committed main passed its then-current CI. It says nothing about `4ed666…`. |
| CodeQL `analyze` | [Run 36579873886](https://github.com/ARCHITECTARIEL/lux-video-os/actions/runs/36579873886) failed on `1c6121f…` | The retained-SARIF gate found `js/clear-text-logging` at `tools/setup-stripe-products.mjs:48`. The local candidate removes that flow, but no CodeQL scan has verified the repair. |
| Stripe reconciliation | [Run 36737902157](https://github.com/ARCHITECTARIEL/lux-video-os/actions/runs/36737902157) failed | Production returned HTTP 503 because `STRIPE_SECRET_KEY` is absent. This remains a paid-launch blocker, not a reason to activate billing during candidate publication. |
| Watchdog sweep | [Run 36755826774](https://github.com/ARCHITECTARIEL/lux-video-os/actions/runs/36755826774) succeeded | The deployed old-main watchdog endpoint answered. It is not candidate render proof. |
| Vercel commit status | `success` for the `1c6121f…` preview status | A prior preview deployed. It is not stable-production alias readback or candidate-byte evidence. |

Because branch protection and rulesets are absent, GitHub presently requires none of these checks before a direct main update or merge. The PR template contains useful manual release checkboxes, but it is advisory rather than enforced.

## `4ed666…` checkpoint local evidence

| Evidence | Current result | Epistemic limit |
|---|---|---|
| Node/Vitest | 449 Node passes, 44 explicit skips, zero failures; 4 Vitest passes | Strong local and isolated-fixture evidence, not hosted proof. |
| Browser | 110 passes, one explicit production-proof skip, zero failures | Mocked/local browser behavior and acceptance/history gates; no real provider output. |
| Python | 48 passes, one Windows symlink skip | Local worker/tool behavior only. |
| Isolated integration | 2 passes; all 18 tables and Blob objects cleaned to zero | Dedicated verification DB/private Blob target, never production. |
| Runtime audit | Zero runtime vulnerabilities | Does not clear unrelated dev-tool findings or CodeQL. |
| Preview packaging | Exit 0; 42 routes, 98 steps, 6 workflows | Review-only output; production gates intentionally remain closed. |
| Visual review | 92 / pass | Local reference-based UI review; no real-device/provider-output acceptance. |

These figures remain valid for `4ed666…` in [verification-summary.json](../enrollment-20260930/verification-summary.json). They are not evidence for `b2e7e583…` and are not substitutes for GitHub CI/CodeQL on a commit SHA.

## Gate matrix

| Gate | State at audit close | Evidence / required closure |
|---|---|---|
| Exact source inventory | **PASS for `4ed666…`; current source UNFROZEN** | The 383-file checkpoint fingerprint was exact at 18:48. Expected release-gate edits later produced `b2e7e583…`; root must issue the final source identity. |
| Local automated verification | **PASS for `4ed666…`; REPROOF REQUIRED for current source** | Exact-checkpoint summary above; full browser run is 110/1/0. Re-run the affected/full checks and review build after final freeze. |
| Public-repository publication safety | **BLOCKED — local engineering/review** | The worktree contains many tracked edits and untracked docs, screenshots, receipts, generated test directories, and private-evidence pointers. Stage from an explicit allowlist; never use blanket `git add -A`. Run a current secret/privacy scan on the proposed Git index and review every public artifact. |
| Candidate Git commit identity | **MISSING** | `4ed666…` is not a Git object. A clean branch commit must reproduce its governed file fingerprint. |
| Current-candidate CI | **MISSING** | CI is green only for old `1c6121f…`. A candidate branch/PR must produce a green `CI / verify` check on its exact commit. |
| Current-candidate CodeQL | **MISSING / remote main red** | The old account-log finding is removed locally. Only a fresh `CodeQL / analyze` result and retained-SARIF gate on the candidate can clear it. |
| Main protection / required reviews | **VERIFIED RISK / RECOMMENDED HARDENING** | Live main is unprotected and has no rulesets. No existing GitHub rule makes branch protection a release gate. The project still requires current-candidate CI, CodeQL and review; branch protection is the recommended way to enforce those existing requirements rather than a newly invented prerequisite. |
| P0 verifier integrity | **PASS fail-closed; proof MISSING** | [`verify-p0-release-gate.mjs`](../../../tools/verify-p0-release-gate.mjs) exits 2 for every verification attempt and writes nothing. No P0 release receipt exists. Preserve this behavior until an authenticated collector or reviewed manual private evidence process exists. |
| Production database identity/schema | **BLOCKED** | Verification tooling is fail-closed, but canonical production `DATABASE_URL` mapping is not independently established and migrations 0007/0008 are not proven applied to production. No automatic migration is allowed. |
| Private storage/reference proof | **BLOCKED** | The production store is private, but 26/77 objects are unclassified; production DB references and legacy/public sources remain unknown. See [storage readiness](../20260930-prompt4-storage.md). |
| Workflow/Sandbox boundary | **REPAIR PRESENT IN `b2e7e583…`; REPROOF REQUIRED** | Current source makes HyperFrames explicitly unavailable for the HeyGen MVP and removes its Sandbox SDK import from the finisher. [Focused boundary evidence](sandbox-provider-boundary.md) is 30/30; a fresh Workflow build/manifest must still prove zero leakage. Do not suppress the scanner. |
| Provider image/model identity | **SCOPE REPAIR PRESENT IN `b2e7e583…`; REPROOF REQUIRED** | Current release-manifest code marks the HeyGen managed API as having no applicable worker image and emits explicit HeyGen account/capability/pricing/privacy/deletion/canary gates. [Focused boundary evidence](sandbox-provider-boundary.md) passes. A fresh manifest must bind the final source. |
| Rollback identity | **BLOCKED** | `config/release-baseline.json` identifies `dpl_AEUWrAaSPEyvNjkkZxCbDAg427WP`, but `sourceByteAttestation:false`. `rollbackGates()` deliberately always returns `ROLLBACK_SOURCE_BYTES_UNATTESTED` because no verifier exists. Metadata/recorded SHA is not byte proof and the observation expires after 24 hours. |
| Stripe paid-launch readiness | **BLOCKED for paid launch** | Scheduled reconciliation is red because production Stripe is unconfigured. A contained non-paid candidate can keep billing disabled; a paid launch requires separately authorized keys/webhook/product setup plus green reconciliation. |
| HeyGen capability/economics/privacy | **BLOCKED external evidence** | Provider choice is settled. The exact production account must still prove applicable avatar/voice/render capability, price/margin, privacy/retention terms, and successful provider-resource reconciliation. |
| Feature activation | **PASS fail-closed / not enabled** | New enrollment and scripted-photo flags default off. No environment activation has occurred. |
| Production build | **BLOCKED** | The `4ed666…` preview passed. Current source still cannot clear DB, storage, rollback, P0, owner, and current-candidate-CI gates; the Sandbox/provider-scope repairs require a fresh build before their state is known. |
| Production deploy + canary + P0 | **NOT AUTHORIZED / MISSING** | Requires a dated exact-candidate approval envelope, bounded spend/retry limit, deployed identity readback, real device/enrollment, one job per enabled tier, accepted private output, fresh-session/history/download/denial and single-debit/event proof. |

## Remaining local engineering

These items can be completed without mutating GitHub or production:

### Before a candidate branch is published

1. Wait for root to finish current release-gate edits, then freeze and record the new exact source list. Use the `4ed666…` ledger as historical comparison, not as the current source claim.
2. Produce a public-safe staging allowlist. Exclude `.vercel/`, `test-results*`, raw private manifests, temp paths, environment files, credentials, customer identifiers/media, and generated browser artifacts. Curate which execution notes and screenshots belong in a public repository.
3. Review the full candidate diff by concern and prepare Lore-compliant commit boundaries. A single blanket commit of the shared dirty checkout is not reviewable.
4. Recompute the root-declared final fingerprint in a clean worktree based on live `origin/main`; any difference requires a new manifest and renewed review.

### May proceed in a draft PR, but must close before release

1. Verify and retain the new target-aware HeyGen release-manifest posture. It must keep self-hosted worker-image proof inapplicable while emitting explicit external-provider account/config/privacy/deletion/canary gates.
2. Verify the new HyperFrames/Sandbox removal with a fresh Workflow build and production-boundary manifest. Keep the feature unavailable until that evidence passes.
3. Define a real rollback byte-attestation procedure and verifier. Do not flip `sourceByteAttestation` manually.
4. Prepare the nonsecret production DB target manifest, exact 0007/0008 migration plan, rollback compatibility analysis, and private-storage reference query package; execution waits for owner-authorized credentials and target confirmation.
5. Keep the P0 CLI disabled. Prepare a separate authenticated/private evidence collector or a reviewed manual receipt template that binds deployed commit/build, account hash, proof/correlation/provider/job IDs, accepted artifact hash, denial checks, and exactly one reservation/debit/final event.

## Owner-authorized external actions still required

These are separate approvals; publishing a branch does not authorize any later item:

1. **GitHub publication:** authorize the exact branch name and commit set, push, and draft PR. Because the repository is public, approval should reference the curated staging inventory/fingerprint.
2. **Optional governance hardening:** consider enabling branch protection/ruleset enforcement for `CI / verify`, `CodeQL / analyze`, up-to-date branches, and review. This reduces bypass risk but is not asserted here as an existing release requirement.
3. **Production identity reads:** authorize the approved credential channel needed to prove canonical production DB identity and query storage references. Read authority does not imply migration authority.
4. **Provider qualification:** authorize read-only account/plan/privacy checks and, separately, a bounded real HeyGen enrollment/render canary with an explicit spend/retry ceiling.
5. **Production writes:** separately authorize migrations, any storage copy/reference change, environment flags/secrets, deployment/promotion, rollback action, and stable-alias changes.
6. **Paid launch only:** authorize Stripe setup, webhook/product configuration, billing activation, and reconciliation proof. Keep disabled for a non-paid contained pilot.
7. **P0 production proof:** authorize the exact deployed candidate, test account, enabled tiers, device/browser, private receipt destination, job count, spend, retry limit, and containment/rollback trigger.

## Minimum candidate publication and proof proposal

This is a proposal, not an approval request or executed action.

### A. Publish a reviewable candidate only

1. Create an isolated clean worktree from live `origin/main` at `1c6121f…`.
2. Apply only the curated source allowlist and curated public documentation. Recompute the source ledger; it must equal the final root-declared fingerprint.
3. Run the same local exact-candidate suite in that clean worktree and write a new private/local verification summary tied to the eventual commit content.
4. Create Lore-compliant commits, then—only after explicit publication authorization—push a candidate branch and open a **draft PR**. Do not push directly to main.
5. Require green `CI / verify` and `CodeQL / analyze` on the exact candidate commit. Treat the first failure as diagnostic; do not merge around it. Scheduled watchdog/Stripe runs on old main do not satisfy candidate checks.
6. Manually require the existing current-candidate CI, CodeQL and review gates before merge. Branch-protection/ruleset automation is recommended but not required by a currently observed repository rule. Leave feature flags off and do not deploy from the PR.

### B. Turn a green GitHub candidate into a release candidate

1. Prove the new Sandbox removal and HeyGen-targeted provider gates in a fresh final-source build manifest.
2. With separately authorized read access, prove canonical production DB/store identity and references. Transaction-test migrations, then apply only under a distinct write approval and capture fresh pre/post receipts.
3. Refresh and independently byte-attest the rollback deployment; verify schema/storage compatibility.
4. Build from the clean committed SHA. Require source fingerprint, Git SHA, project link, database proof and output hash to agree; keep the artifact quarantined until execution approval.
5. Prepare the dated release envelope naming commit, build/output hash, Vercel project/team/alias, enabled tiers, exact flags/env changes, migrations, rollback deployment, receipt location, spend and retry ceiling.

### C. Produce real acceptance proof

1. After owner approval, deploy only the envelope candidate and re-read the stable alias/deployed identity.
2. Run the smallest real-device/HeyGen canary: one fresh enrollment and at most one render per enabled tier. Keep billing disabled unless the separately approved scope is a paid launch.
3. Capture all required P0 observations privately: browser input/session, unique provider job, validated private MP4, original and fresh-session history, matching downloaded bytes, anonymous/wrong-account/direct-store denial, and one reservation/debit/final event.
4. If any invariant fails, contain the affected tier and stop. Do not generate an approved receipt from IDs alone and do not spend on an unapproved retry.

## Read-only commands used

- `gh repo view`, `gh workflow list`, `gh run list`, `gh run view --log-failed`, `gh pr list`
- GitHub REST reads for `commits/main`, check runs, combined status, branch protection, and repository rulesets
- Local `git status`, HEAD/origin comparison, release manifest/preflight/P0/storage evidence reads, and source fingerprint recomputation

All observed live GitHub facts are time-bound to this audit. Re-read them immediately before any candidate publication or release decision.

## Integration readback - 2026-09-30T19:41:26.076702+00:00

Root sealed source `b2e7e583a660823f76d32fda8c3f6d4befa2238846d4fc7cba69c7af1743a7f5` and output `b8a3b7dcfe1705b19b5c9a065a78cafb725021485e201b79efcf25476fcca47e`. Full unit451+four Vitest passed. Review-only build42 routes/29 steps/six workflows passed, with `NO_KNOWN_SANDBOX_CLASS_LEAK`; source/project-link matches and default prebuilt output is absent. Earlier pending local packaging statements above are superseded by this readback. External/provider/P0/database/storage/CI/rollback gates remain open. See verification-summary.json and build-summary.json.
