# ZIP forensic audit — 2026-09-29

Archive: `C:\Users\ariel\OneDrive\Documents\Desktop\lux-video-os-HANDOFF-2026-09-29.zip`

SHA-256: `430E5886B1363DEA553E49E8F0E11F5B0FA54ED4003A112E0B13D87BAC2F22DE`

This was a read-only inspection. The archive was opened as ZIP streams; no entry was executed and nothing was extracted over the checkout. `HANDOFF.md` was read before the comparison. The per-entry evidence is in [zip-inventory.json](zip-inventory.json).

Snapshot timing: the ZIP-to-worktree hashes and dirty-tree counts describe the initial capture made before the coordinating audit edited repository documentation or added other audit artifacts. Those later same-session edits are neither inherited ZIP deltas nor part of the counts below.

## Verdict

The ZIP is a useful documentation checkpoint for committed `main` at `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9`. It is not a recoverable source snapshot and it is no longer the complete project state.

- 15 entries, 60,364 archive bytes, 143,077 uncompressed bytes.
- Every entry is Markdown or JSON. The included `package.json` is a manifest snapshot, not an application source backup. There is no application source tree, Git history, `.env` file, executable/script payload, or developer execution-prompt pack.
- The ZIP has 12 snapshots of existing repository documents. At the initial pre-audit capture, all 12 equaled their worktree counterparts byte-for-byte and equaled their `HEAD` counterparts after CRLF/LF normalization. Only `docs/DEVELOPER_HANDOFF.md` was also byte-identical to the canonical Git blob; the remaining raw-hash differences were line endings, not content changes. Later same-session supersession banners added by the coordinating audit are intentionally outside this comparison baseline.
- Three entries exist only in the packet: `00-START-HERE.md`, `CREDENTIALS-AND-ACCESS-CHECKLIST.md`, and `reference-docs/merged-pr-history.json`.
- The correct handling is to retain the original ZIP and its hash as immutable evidence, cite the useful packet-only material in a new canonical handoff, and avoid copying the archive over the repository.

## Safety result

The central directory contains no absolute/traversal paths, case-insensitive duplicate paths, symlink entries, `.env`-named entries, or executable/script extensions. The maximum compression ratio is 3.76, so the package has no ZIP-bomb signal. A bounded scan found zero common high-signal secret-value patterns. That scan supports the packet's statement that it contains credential names and access requirements rather than values; it is not a general proof that arbitrary prose can never contain sensitive context.

## Git and worktree delta

At the initial pre-audit inspection, `HEAD`, `origin/main`, and the merge base were all `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9`; local `main` was 0 ahead and 0 behind. This confirms the ZIP's committed Git anchor.

The working tree already contained post-checkpoint work before this audit or the coordinating documentation pass wrote anything:

- 18 modified tracked files: 113 insertions and 123 deletions.
- 8 pre-existing untracked files under `docs/execution-notes/`, `lib/`, `tests/`, and `wiki/`.
- The changes form an authorization-repair candidate: persisted tier authorization, server-generated job authorization binding, worker-side rechecks, removal of process-memory authority, and regression scenarios/tests. Its detailed local evidence is recorded in [02-authorization-handoff.md](../execution-notes/02-authorization-handoff.md).

Those changes are absent from the ZIP. Concurrent audit outputs created elsewhere under `docs/audit-2026-09-29/` were excluded from the initial worktree counts above.

## Claim audit

| ZIP claim or implication | Current finding | Treatment |
|---|---|---|
| The packet is current for `main` at `1c6121f`. | Correct for the committed snapshot. | Keep the commit identity and archive hash. |
| This checkout is normally linked to non-production `lux-video-os-rebuild`. | False now. `.vercel/project.json` currently names the production project `lux-video-os`; the independent read-only Vercel audit reached the same result. | Replace with a mandatory live target readback before every build/deploy. See [vercel-audit.md](vercel-audit.md). |
| Four entitlement-leak recurrences were fixed and the surface was substantially closed. | Incomplete. The packet prudently requested another audit, and the later local audit found a further path: domain sign-in persisted a tester role that an admin listing could turn into future Premium authority. A local repair now exists but is not committed or deployed. | Treat the ZIP history as prior evidence, not a security completion claim. Preserve the newer authorization handoff and require review/live verification before merge or release. |
| Test totals were 374 total / 363 pass / 11 skip with a live local DB. | Historical, environment-dependent evidence. The current uncommitted repair reports a different full-suite shape and credential-gated skips. | Re-run the canonical test commands on the exact candidate; do not copy the old totals into the new handoff as current proof. |
| Production default is simulation; LatentSync is GPU-verified but unwired. | The archive itself contains no deploy/runtime proof. Current Vercel metadata shows production is older than current `main`, and hidden environment-name presence cannot prove effective provider mode. | Keep as an unverified operational claim until exact deployment/runtime evidence is collected. |
| Stripe is not configured in production. | Still supported by the current read-only Vercel environment-name inventory, which found no `STRIPE_*` names. | Keep as current evidence with the observation date; provisioning remains owner-controlled. |
| The repository is public. | Re-verified with `gh repo view`: visibility is `PUBLIC`. | Keep as a current fact and unresolved owner decision. |
| `README.md`, `ROADMAP.md`, `CHANGELOG.md`, and parts of `ENVIRONMENT.md` are stale. | Correct at the initial capture; the ZIP copies were exact snapshots of those files. Same-session supersession banners added later are outside the hash baseline. | Do not use the underlying stale content for orientation. Preserve the new redirect/supersession layer in the canonical documentation pass. |
| `docs/P0-RELEASE-GATE.md` is current and unmet. | The packet copy matches the repository document, but the ZIP contains no signed receipt or runtime observation. | Keep the gate as authoritative and unmet until a real receipt exists. |

## Useful packet-only material

`00-START-HERE.md` is the main unique value. It contains a clear product/stack summary, an 11-item backlog, re-verification commands, and the PR narrative through #83. It has no ready-to-run developer prompt series. Its priority order should be reconciled with the newer repository/Vercel/authorization evidence before becoming the next plan.

`CREDENTIALS-AND-ACCESS-CHECKLIST.md` is a secret-free access inventory. Preserve its system names and purposes, but re-check each current project/account identity before use.

`reference-docs/merged-pr-history.json` is a useful dated receipt for merged PRs through #83. It is historical output, not live GitHub state.

The remaining 12 entries add no unique bytes beyond the current working tree. In particular, importing the included `AGENTS.md`, stale root docs, handoff files, `package.json`, RunPod guides, Stripe guide, or P0 gate would only overwrite equivalent content or line endings.

## Handoff rule for the next developer

The next canonical handoff should state four states separately:

1. `HEAD`/GitHub committed state at `1c6121f`.
2. The uncommitted authorization-repair candidate and its verification limits.
3. The observed Vercel production/preview identities and configuration-name inventory.
4. Unmet owner-controlled gates: commercial model/license decisions, production configuration, legal review, paid canary/P0 proof, and any deployment/promotion.

Archive claims must not be promoted into current truth without their prescribed readbacks. The ZIP should remain referenced by its exact path and SHA-256 rather than extracted into the repo.
