# Git and GitHub audit — 2026-09-29

Read-only audit of the local checkout and `ARCHITECTARIEL/lux-video-os`. No fetch, checkout, reset, merge, push, branch operation, issue/PR write, deployment, environment change, or production action was performed. GitHub timestamps below are UTC. The local worktree was inspected without changing its existing source edits.

## Executive findings

1. **Local, tracking, and remote `main` agree at `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9`.** GitHub records that merge commit at `2026-09-29T14:04:16Z` for PR #79. Local `git status --porcelain=v2 --branch` reported `+0 -0` against `origin/main`.
2. **The existing handoff is materially behind Git.** It says `main` is `1e1c72f` and four PRs (#43–46) are open. Current `main` is 61 commits beyond that SHA. `HANDOFF.md` itself was last committed at `a04e59513e7cbd5684bf56790311d2ab14676499` on `2026-09-24T21:02:33Z`; current `main` is 28 commits beyond that handoff commit.
3. **The GitHub repository is public.** `gh repo view` returned `visibility: PUBLIC` and `isPrivate: false`, contradicting `HANDOFF.md` line 21, which calls the repo private. Common secret-bearing paths (`.env*`, `.vercel`, PEM/P12/key and credential/secret filename patterns) are not tracked in the current index. This was not a full history or secret-scanning audit, so it does not prove that public exposure is harmless.
4. **`main` has no branch protection and no repository rulesets.** The branch-protection API returned `404 Branch not protected`; the rulesets API returned `[]`. Red post-merge checks therefore do not prevent more merges.
5. **The latest `main` CI is green, but the repository is not green overall.** CI run [36579873920](https://github.com/ARCHITECTARIEL/lux-video-os/actions/runs/36579873920) passed. CodeQL run [36579873886](https://github.com/ARCHITECTARIEL/lux-video-os/actions/runs/36579873886) failed its local SARIF gate. Scheduled Stripe reconciliation run [36589393600](https://github.com/ARCHITECTARIEL/lux-video-os/actions/runs/36589393600) failed because production returned HTTP 503 with `Stripe reconciliation is not configured. Add STRIPE_SECRET_KEY.` Watchdog run [36600961303](https://github.com/ARCHITECTARIEL/lux-video-os/actions/runs/36600961303) passed.
6. **The worktree contains a cohesive, uncommitted authorization repair.** It is not random dirt and must be preserved. At the `2026-09-29T16:21:39-04:00` snapshot, 18 tracked files had 113 insertions and 123 deletions; the tracked diff fingerprint from `git diff | git hash-object --stdin` was `d4b0e6f9ffd0fc5a5791661341bcfbf04ddc57b2`. New product/test files include `lib/video-os-render-authorization.js`, `tests/authorization-repair.test.mjs`, `tests/helpers/authorization-repair-scenario.mjs`, and `tests/render-authorization-policy.test.mjs`. There were no staged changes or unresolved index entries.

## Current Git identity

| Surface | Observed value |
|---|---|
| Local branch | `main` |
| Local `HEAD` | `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9` |
| Local `origin/main` | `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9` |
| GitHub `main` | `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9` |
| Commit time | `2026-09-29T14:04:16Z` |
| Commit | `Merge pull request #79 from ARCHITECTARIEL/beta-test/entitlement-authz-audit` |
| Origin | `https://github.com/ARCHITECTARIEL/lux-video-os.git` |
| Visibility | **PUBLIC** |
| Branch protection | None |
| Repository rulesets | None |
| Releases | None |
| Local tags | `ceo-demo-2026-07-16` only |

The GitHub Vercel status attached to `1c6121f` says “Deployment has completed,” but the deployment is a preview. The stable production alias remains on `a04e595`; see [vercel-audit.md](vercel-audit.md). GitHub status alone must not be used as proof that current `main` is live in production.

## Pull-request dispositions that supersede the handoff

| PR | Actual disposition | Merge commit / time | Check evidence |
|---|---|---|---|
| [#43](https://github.com/ARCHITECTARIEL/lux-video-os/pull/43) camera capture | **Merged** | `abe7860e6e090a49e3c4fccad0abbc5828301c1d`, `2026-09-23T13:47:50Z` | CI and CodeQL passed |
| [#44](https://github.com/ARCHITECTARIEL/lux-video-os/pull/44) generated Vercel Analytics | **Closed, unmerged** | `2026-09-23T13:48:26Z` | CI failed; superseded by #45 |
| [#45](https://github.com/ARCHITECTARIEL/lux-video-os/pull/45) hosted Vercel Analytics | **Merged** | `a0ff43eb5634771f320d4a08d1d5c2f0b93c31d4`, `2026-09-23T13:48:01Z` | CI and CodeQL passed; Vercel status failed on PR head |
| [#46](https://github.com/ARCHITECTARIEL/lux-video-os/pull/46) retire legacy dashboard | **Merged** | `71c7378c584a00aa0685160065354da9cd4f04ee`, `2026-09-23T13:48:11Z` | CI and CodeQL passed; Vercel status failed on PR head |
| [#79](https://github.com/ARCHITECTARIEL/lux-video-os/pull/79) render email authorization check | **Merged** | `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9`, `2026-09-29T14:04:16Z` | PR CI/CodeQL passed; Vercel failed; no GitHub review |
| [#80](https://github.com/ARCHITECTARIEL/lux-video-os/pull/80) admin-list authorization leak | **Merged** | `77858707ed8506734f180c19dfc5eb3e556e935e`, `2026-09-29T13:55:32Z` | PR CI/CodeQL passed; Vercel failed; no GitHub review |
| [#81](https://github.com/ARCHITECTARIEL/lux-video-os/pull/81) domain sign-in authorization leak | **Merged** | `6a9c0df64c1b32c9a56cc3e2c5f28b3de89df480`, `2026-09-29T13:48:12Z` | PR CI/CodeQL passed; Vercel failed; no GitHub review |
| [#82](https://github.com/ARCHITECTARIEL/lux-video-os/pull/82) copywriter error coverage | **Merged** | `e2781d51024a793eb8b5747d1ecf1c8393eaca32`, `2026-09-29T13:48:24Z` | PR CI/CodeQL passed; Vercel failed; no GitHub review |
| [#83](https://github.com/ARCHITECTARIEL/lux-video-os/pull/83) hold ambiguous provider submissions | **Merged** | `6ca47d09a456c12330799920e2fd0774c3a23058`, `2026-09-29T13:48:00Z` | PR CI/CodeQL passed; Vercel failed; no GitHub review |

The #79–83 PRs contain valuable fixes, but the pattern matters: all five were merged with failed Vercel PR statuses and no formal GitHub review, while `main` is unprotected. The later successful `main` preview does not retroactively prove each PR's product behavior.

Other important merges after the handoff include #74 (LatentSync worker), #75 (workflow `node:crypto` production-build repair), #76 (migration-gate enforcement), #77 (Standard activation-gate coverage), and #78 (domain Premium authorization restriction). PR #74's own description explicitly says the LatentSync worker is **not wired to the app** and uses a video input contract while the app uses a portrait. Its merge proves worker code and image-build presence, not a usable Standard product path.

## Open pull requests

The only open PRs are nine Dependabot updates, all created and last updated on September 23:

- #59 `docker/setup-buildx-action` 3 → 4
- #60 `hyperframes` 0.7.64 → 0.8.56
- #61 `@vercel/blob` 2.6.1 → 2.8.0
- #62 `vercel` 56.2.0 → 59.23.2
- #63 `zod` 4.4.3 → 4.6.5
- #64 `ws` 8.21.1 → 8.21.3
- #65 `docker/login-action` 3 → 4
- #66 `actions/checkout` 4 → 7
- #67 `docker/build-push-action` 6 → 7

Their September 23 CI and CodeQL checks passed, but every PR has a failed Vercel status and their checks predate 28 commits now on `main`. GitHub reported mergeability as `UNKNOWN` during this audit. These are maintenance items, not MVP launch blockers. Do not batch-merge them using week-old checks; refresh/rebase and review them individually after the release candidate is stable. #62, #63, and #60 deserve deliberate compatibility testing because they cross substantial version ranges.

## CI and automation evidence

### Latest `main` CI

Run [36579873920](https://github.com/ARCHITECTARIEL/lux-video-os/actions/runs/36579873920) completed successfully at `2026-09-29T14:08:04Z`:

- Node: 340 total, 300 passed, 0 failed, 40 skipped.
- Vitest: 4 passed.
- Python: 47 passed, 2 skipped.
- Playwright: 110 passed, 1 skipped.
- Import check, `db:check`, npm-audit enforcement, workflow validation, and production build all exited successfully.
- The build log explicitly said the live production database migration-drift check was **skipped** because a production `DATABASE_URL` could not be resolved. Green CI therefore proves snapshot/migration-file consistency, not live production schema parity.

### Current CodeQL failure

Run [36579873886](https://github.com/ARCHITECTARIEL/lux-video-os/actions/runs/36579873886) analyzed all files successfully but failed `tools/enforce-codeql-sarif.mjs` on:

```text
js/clear-text-logging severity=7.5 tools/setup-stripe-products.mjs:48
```

The finding is the log of a Stripe account identifier derived from `STRIPE_ACCOUNT_ID`. Resolve it by removing/reducing the log or by documenting and allowlisting it only after a security review establishes that it is safe. Do not merely ignore the red run.

The workflow also lacks `security-events: read`, so CodeQL repeatedly warns that its API/database upload is inaccessible. Those warnings were not the final failing step—the custom SARIF gate was—but the workflow permission mismatch should be repaired. The same SARIF finding has kept `main` CodeQL red since PR #57 landed on September 23.

### Stripe reconciliation failure

Run [36589393600](https://github.com/ARCHITECTARIEL/lux-video-os/actions/runs/36589393600) reached the live endpoint and received:

```json
{"ok":false,"error":"Stripe reconciliation is not configured. Add STRIPE_SECRET_KEY."}
```

The scheduled workflow is producing a real red operational signal, not an infrastructure flake. Either complete the authorized production Stripe configuration before paid launch or disable/retarget the schedule until billing is intentionally enabled. Repeated expected failures train operators to ignore red automation.

## Existing uncommitted authorization candidate

The inherited source diff supersedes the narrow, process-local authorization patches in #78–81. Its themes are coherent:

- replaces mutable in-memory tester registration as render authority with persisted, tier-specific entitlements;
- binds a server-generated authorization decision to a reserved job and rechecks current permission in both Standard and Premium workers;
- preserves admin-grant provenance across sign-in and revocation;
- canonicalizes Google/magic-link/admin identity resolution by normalized email;
- adds cold-worker, wrong-account/tier, expiry/disabled-grant, admin-list, and sign-in regressions.

Tracked edits cover two API handlers, two repositories, security/tester helpers, both render workflows, and ten existing test files. New tests and `docs/execution-notes/` describe the repair and its verification. No dependency, schema, migration, provider-worker, billing, or UI change is present in that candidate.

The candidate should be treated as owned work. Before any cleanup, checkout, or branch operation:

1. inventory the exact untracked files and tracked diff again because concurrent documentation work is present;
2. run its focused tests and the full CI-equivalent suite from a stable snapshot;
3. review the persistence/transaction behavior against a real non-production database, since its current local scenario tests mock persistence seams;
4. commit it on a dedicated branch with the repo's Lore trailers, then open a reviewable PR;
5. never overwrite it by resetting `main` or extracting the zip over this checkout.

## Open issues and stale issue state

- [#23](https://github.com/ARCHITECTARIEL/lux-video-os/issues/23) is partially stale. Finding #1 (concurrent Standard submission releasing credits) was fixed by PR #27, and the worker-image trigger now includes `main` via PR #69. The issue remains useful for unresolved lower-level findings: `0` becoming `null`, large Base64 output checkpointing, duplicate decode/hash work, and duplicated helpers. Update or split the issue so resolved and unresolved findings are clear.
- [#29](https://github.com/ARCHITECTARIEL/lux-video-os/issues/29) remains open. PR #58 removed stale `/public/` prefixes, but it did not establish a real consumer or serving path for `/exports/*` and `/uploads/*`. A focused source search found private blob namespaces and the upload API, but no frontend/static consumer of those public paths. Decide whether to delete the routes or implement an authenticated serving contract; do not close the issue solely because the prefix changed.

## Handoff claims contradicted or narrowed by current evidence

| Handoff claim | Current evidence / required wording |
|---|---|
| Repo is private | GitHub reports **PUBLIC**. Confirm whether that is intentional. |
| `main` is `1e1c72f` | Current local, tracking, and remote `main` are `1c6121f`; 61 commits later. |
| #43–46 are open | #43/#45/#46 merged; #44 closed unmerged. |
| There is no migration check in the deploy path | PRs #57/#76 added a strict migration-drift check to the production build. It still does not auto-run migrations, and CI skips the live check without a production DB URL. |
| GitHub pushes do nothing deployment-related | GitHub/Vercel now creates a `main` preview automatically. Stable production is still older and requires an explicit promotion/deploy. Say “no automatic production promotion,” not “nothing more.” |
| Issue #23 has six remaining findings including the CI trigger | The `main` trigger is fixed; the issue needs a current remainder list. |
| Real Standard inference code is merged, so activation is mainly credentials + flag | The new LatentSync worker is not integrated with the app's portrait contract, and its commercial-use/model evidence remains incomplete. A merge and image build do not close the Standard product contract. |
| Cold start is the leading explanation for the old consent hang | Later commits added DB timeouts and fixed readiness/error classification. The old symptom needs a fresh correlated reproduction; cold start remains an unverified historical theory. |

## Git/GitHub actions required before MVP release

1. **Preserve and review the authorization candidate.** It is the closest thing to an active release candidate and addresses recurring authorization defects that reappeared across #78–81.
2. **Return `main` to a fully green state.** Fix the CodeQL finding and workflow permission mismatch; rerun CI/CodeQL on the candidate. A green PR check is insufficient while full `main` analysis stays red.
3. **Decide repository visibility and enforce the decision.** If public is unintended, make the repo private and run a proper history/secret exposure review. If public is intended, document it and confirm all proprietary/model/license materials are suitable for public distribution.
4. **Protect `main`.** Require the verified CI and CodeQL checks, require an up-to-date branch, and require at least one review for authorization, billing, provider, database, or deployment changes. Configure the exact checks only after the currently red jobs are repaired.
5. **Stop expected-red operational schedules.** Configure Stripe as an owner-approved production step or pause/retarget reconciliation until billing is enabled.
6. **Refresh issue and PR hygiene.** Update #23/#29 and rebase or close stale Dependabot PRs. Keep dependency churn outside the MVP release candidate unless it fixes a release blocker.
7. **Anchor the release.** After the production proof gates pass, tag the exact promoted commit and create a GitHub release/receipt. The only current tag is the July CEO demo and does not identify the September MVP candidate.

## Reproduction commands

Key read-only commands used: `git status --porcelain=v2 --branch`; `git rev-parse HEAD`; `git diff --stat`; `git log`; `git ls-files`; `gh repo view`; `gh api repos/ARCHITECTARIEL/lux-video-os/commits/main`; `gh pr view/list`; `gh issue view/list`; `gh run view/list`; branch-protection and rulesets API reads. No credential values or private environment values were captured.
