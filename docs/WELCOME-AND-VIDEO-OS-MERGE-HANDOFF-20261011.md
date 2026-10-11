# Welcome pages and Video OS integration handoff

## Local integration update — 2026-10-11 09:54 EDT (13:54 UTC)

The Welcome/credit-policy slice below was selectively committed on `codex/welcome-integration-20261011` as `624fcbe519a0c5e9afec806233baeb27858b8179`, then this documentation branch was merged locally as `c33a5d100350410e7f0572097f4917889b1922b2`. The root checkout and other worktrees were not merged. The new integration branch starts at remote-main `7533caaa12fa5e13fbee0609aa4402a41392415a`; no push, PR merge, deployment, provider call, billing action, or feature enablement occurred.

Checks on the isolated Welcome branch: `tests/no-free-video-policy.test.mjs` passed 1/1; landing Playwright passed 6/6; aggregate Node passed 751 with 47 live skips and zero failures; Vitest passed 4/4; import and client-privacy checks passed. The first aggregate attempt failed because this new worktree lacked the hardcoded local `node_modules/drizzle-kit/bin.cjs` path; a worktree-local junction to the existing repository dependencies resolved that test setup issue, and the full rerun passed. The junction is ignored local test plumbing, not a committed dependency. Browser tests used `/landing.html`; `/welcome` mapping was source-inspected in `vercel.json`, not verified on a deployed host. Media rights, captions, product claims, live DB, and production readback remain open review gates.

**Prepared:** 2026-10-11 09:42 EDT (13:42 UTC). **Purpose:** a local commit and merge packet for the next Codex operator. This packet records observations, not a claim that the pages or other dirty work have been committed, merged, deployed, or accepted. Refresh all branch, worktree, test, and deployment evidence before acting.

## Exact starting point

- Repository: `C:\Users\ariel\lux-video-os`. The root checkout was `codex/private-enrollment-canary-20261004` at `988e43ebe381c48631145914a8d37d866d5865ca` (committed 2026-10-06 11:37:58 EDT). It had **96 modified or untracked paths at 09:42 EDT; 97 at 09:45 EDT** as concurrent local work continued. Preserve every path, including untracked media. Do not use `git add .`, reset, clean, or merge that root branch wholesale.
- `origin/main` read back as `7533caaa12fa5e13fbee0609aa4402a41392415a` (committed 2026-10-05 08:20:38 EDT). Local `main` and old handoff prose may be stale. The root branch and remote main diverge at `fca64768495f01372622263961659bea9853bb5f`: root includes an alternate enrollment commit and a HyperFrames design-spec commit; remote main has its own enrollment commit. Reconcile by file, not branch name.
- This **documentation-only** packet lives in `.omx/worktrees/welcome-merge-handoff-20261011`, branch `codex/welcome-merge-handoff-20261011`, created from the verified remote-main commit. It contains no welcome implementation. The `enrollment-7533` worktree also has two generated vendor files with line-ending dirt; preserve them. The other listed worktrees were clean at inventory.
- `HANDOFF.md` points to `NEXT-DEVELOPER-HANDOFF.md` and `docs/CURRENT-MVP-HANDOFF.md`, but their old state claims are historical. Verify the current source and the newest dated, sealed qualification notes. The separate October 9 diagnostic abort is recorded at `docs/DIAGNOSTIC-PREALIAS-ABORT-20261009.md` on commit `885a31255fa1f91fabf294c6006426511d669935`.

## Dated provenance; do not conflate these events

| Date | Evidence | Meaning |
| --- | --- | --- |
| 2026-10-01 16:55 EDT | `8203d1f7c6777c0eda644170c017265f76ac552f` | Earlier `/welcome` How-it-works video change. This commit **is an ancestor** of `7533caaa`; do not cherry-pick it again. `/welcome` already routes to `/landing.html` in remote main. |
| 2026-10-05 08:20 EDT | `7533caaa12fa5e13fbee0609aa4402a41392415a` | Remote-main baseline observed on 2026-10-11; not a fresh production attestation. |
| 2026-10-06 11:37 EDT | `988e43ebe381c48631145914a8d37d866d5865ca` | Root checkout HEAD. Later working-tree edits are **uncommitted** and cannot inherit this commit date. |
| 2026-10-08 21:07-21:37 UTC | File `LastWriteTimeUtc` on pricing, landing HTML/CSS, and four MP4s | Approximate local edit/copy time only, not authorship, review, or commit proof. The owner update in `docs/pricing.md` is explicitly dated 2026-10-08. |
| 2026-10-09 19:40-20:13 UTC | Sealed diagnostic abort note above | A diagnostic-only unique deployment failed pre-alias source identity. No alias promotion or DB binding proof; the recorded restoration is as of October 9 only. Recheck live state before any release work. |
| 2026-10-11 09:42 EDT | This inventory and focused test | Current handoff observation. New October 11 readiness notes and LUXIFY edits were still changing; do not treat their internal status as sealed. |

## Welcome and new-account-credit slice to integrate first

The root working tree changes `public/landing.html` and `public/landing.css`; `public/landing.js` is unchanged. The page replaces the free-first-video offer with credit-cost wording, a product preview, one Customer Q&A example, a How-to video, and Kristian's owner video with English captions. It removes the two tier-card videos. All **nine** newly referenced showcase files were present in the root checkout:

`public/assets/showcase/{product-preview.mp4,product-preview.webp,customer-qa.mp4,customer-qa.webp,how-to.mp4,how-to.webp,owner-kristian.mp4,owner-kristian.webp,owner-kristian.vtt}`.

The four MP4s passed a local `ffprobe` metadata read: product preview 18.09 s / 2,539,133 bytes; Customer Q&A 39.47 s / 4,166,944 bytes; How-to 58.84 s / 5,587,717 bytes; owner 54.60 s / 8,243,296 bytes; all H.264, 1280x720. This proves container readability, not content quality, rights, caption accuracy, or production provenance. The owner/copy reviewer must verify the imagery, speaker authorization, claims, and captions before publication. Re-hash media after transfer; if byte equality matters, the observed SHA-256 values were:

| MP4 | SHA-256 observed on 2026-10-11 |
| --- | --- |
| `customer-qa.mp4` | `482DD8AB417B1104295814346BD5FA776AD2DD7C3EF8ADE10A4626DFCC48DFFF` |
| `how-to.mp4` | `F3BCDB4D62F3FE596D5CFD4D7D526323F6E4877EC74E3093E9D0249A98A27482` |
| `owner-kristian.mp4` | `7D44F46FCF38A5DB7259429DF923503CD0598CB6CC49EA60FA26BE8CDA88DCE4` |
| `product-preview.mp4` | `EE634D3A97CD4FE3A890F8D48EC1E39F031F6F92B237C454A0C78EB874C2E075` |

The policy companion is `docs/pricing.md` plus **only the first hunk** in `lib/video-os-account.js` (`DEFAULT_TRIAL_CREDITS = 0`) and untracked `tests/no-free-video-policy.test.mjs`. The **second hunk** in `lib/video-os-account.js` changes `providerList()` and HyperFrames composition availability; it belongs in the Premium lane. Split by hunk, not by filename. Check all account-creation paths and existing-credit preservation. This is a product policy change, not just copy; owner acceptance of the October 8 policy should be confirmed from current evidence before merging it.

The committed `tests/e2e/landing.spec.js` is stale: it expects “Create my free video”/“Start free,” three example cards, and an “Examples” nav label. Update those assertions to the intended new page, including all CTA targets, one example card, media playback/poster/captions, mobile header, and FAQ. Keep the test meaningful. The focused `node --test tests/no-free-video-policy.test.mjs` **passed 1/1** on the dirty root on 2026-10-11; `node --check public/landing.js` passed. No browser run, aggregate suite, build, or accessibility/caption review was performed for this handoff.

**Suggested commit order in a fresh integration worktree from refreshed `origin/main`:**

1. Re-read `AGENTS.md`, this packet, `git status`, remote main, PR state, and the exact root-file diffs. Snapshot root status/hash before transfer. If the source files changed since this packet, re-review the delta instead of trusting the October 11 inventory.
2. Selectively copy the two landing files and nine media assets. Carry the October 8 credit-policy documentation, no-free test, and only the `DEFAULT_TRIAL_CREDITS` hunk. Use path-specific staging/`git add -p`; never stage the second account hunk or `public/index.html`/Studio files with Welcome. Update the landing browser test in the integration branch.
3. Run the focused Node test, landing Playwright tests at desktop and mobile widths, local route check for `/welcome`, media and caption checks, import/privacy checks, relevant aggregate tests, and a local preview build if dependencies/binding allow. Record passes, failures, skips, exact source commit, and artifact hashes. Do not claim simulated or local output is production proof.
4. Have a reviewer inspect the actual staged diff and media/copy rights. Make a Lore-format local commit (or two separable commits: policy/test, then page/media/browser tests). Publish or merge only after exact-head remote checks and the project's release approvals. A Git commit does not authorize deployment, provider calls, paid rendering, billing, or feature enablement.

## Other dirty Video OS work: separate reconciliation queue

The following are **working-tree changes**, not one reviewed feature or one commit. Compare each against its clean candidate/PR and reconcile only its own tests and dependencies. The root `vercel.json` and `api/video-os-lite/workspace.js` became dirty during the October 11 inventory; they appear to be LUXIFY routing and require a fresh review. Do not silently attach them to Welcome.

| Lane | Local paths / evidence to inspect | Integration rule |
| --- | --- | --- |
| LUXIFY / Studio identity | `public/index.html`, `public/studio.{js,css}`, `public/luxify-client.js`, `lib/luxify-*`, `db/luxify-repository.js`, `routes/video-os-lite/luxify.js`, `api/video-os-lite/workspace.js`, `api/video-os/talent.js`, `services/{heygen,luxify-finisher}.js`, `vercel.json`, `tests/luxify*`, `tests/heygen-luxify-adapter.test.mjs`, `tests/e2e/luxify.spec.js` | October 11 readiness note may predate the latest edits. Verify consent, legal, flags, schema, provider and voice authorization. Do not enable creation or rendering from a UI commit. |
| Premium HyperFrames | `media/hyperframes/premium-landscape/*`, `services/{hyperframes-finisher,final-media-validation}.js`, `api/video-os-lite/render-v2.js`, `workflows/video-render.js`, `tests/hyperframes*`, helper tests, and the second `lib/video-os-account.js` hunk | Clean `feat/premium-hyperframes-composition` worktree was at `9f36fb9cebc0863434679efbe03cc865c2224ab2`, but dirty root files were **not byte-identical**. Diff and review; do not overwrite either. |
| DB binding / maintenance | `lib/production-db-binding-diagnostic.js`, `routes/video-os-lite/admin.js`, `diagnostics/db-binding-standalone/*`, `.github/workflows/db-binding-diagnostic-ci.yml`, diagnostic tests and October 5/6 notes | Compare with clean `codex/app-maintenance-gate-20261006` at `2a2122c8c593c0c49e1ae52d6338f313709c5127` and draft PRs #88/#89. October 9 pre-alias abort remains a separate gate. No new diagnostic deployment is implied. |
| Canceled Standard job repair | `db/canceled-standard-job-repair.js`, `tools/reconcile-canceled-standard-job.mjs`, `tests/canceled-standard-job-repair.test.mjs`, isolated PG test | Local review only; no live job repair or credit release from a merge handoff. |
| P0 proof and readiness | `tools/p0-evidence/*`, `tests/p0-*`, `docs/QUIESCENCE-MVP-AUDIT-20261011.md`, October 11 P0/storage/provider/Seedance notes, `docs/CURRENT-MVP-HANDOFF.md`, `wiki/log.md` | Verify each note against current source and target. Keep skipped Blob/private-storage, schema-lock, rollback and live binding gaps visible. Do not fabricate receipts. |

At the October 11 read, draft GitHub PR #97 was the core release candidate; #89/#88/#87 were diagnostic/maintenance work on review bases, with separate evidence PRs #84/#85. Their presence does not imply merge readiness or exact-head CI success. Refresh with `gh pr list` and inspect each diff/check before any merge. The optional prompt identity worktree `feat/heygen-consent-bridge-20261007` was clean at `eb064412bc9a716a520353e68564a16873d383b0`; keep its creation/rendering held and separate from core Welcome.

## Stop conditions, evidence, and reversal

Stop selective integration if root source has changed without re-review, media/copy authorization is missing, a test fails, a branch introduces optional schema or provider activation unexpectedly, or source identities cannot be tied to the reviewed diff. Do not use the stale schema lock as a pass and do not recapture it in this lane. Do not infer that the October 9 restored alias, schedules, or database binding are still current on October 11. A production release needs its own current target, migration, rollback, private-media, owner QA, and billing/legal decisions.

**Reversal protocol:** this packet only created a new local worktree and this documentation file. Revert the documentation commit if the packet is wrong; remove the dedicated worktree/branch only after verifying its absolute path, clean status, and that no later work depends on it. For future integration commits, record exact input and output hashes; reverse a wrong selective commit with `git revert` on its integration branch, preserving the dirty root. Never use a root-wide reset or destructive cleanup to undo this handoff.
