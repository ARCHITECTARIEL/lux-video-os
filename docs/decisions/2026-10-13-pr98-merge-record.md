# PR #98 merge record

**Status: Decided 2026-10-14 by Ariel: Option A (Option 1), keep #98 live.** QA's post-hoc review PASS is recorded; the remaining `/provider-consent` consent-page pass is still open. Evidence below was gathered with `gh` and read-only Vercel CLI on 2026-10-14. This record does not authorize a deployment, rollback, revert, or branch protection change.

## Summary

PR #98 was merged despite a title declaring it a draft and saying “do not merge.” The available checks passed, but the change was large and lacked human review before merge. The reported live LUXIFY quote versus 90-credit reservation mismatch is refuted by the inspected paths. Ariel chose to keep #98 live while finishing the `/provider-consent` pass.

## Verified facts

- Repository and PR: `ARCHITECTARIEL/lux-video-os` #98, titled `RC-001: Video OS release candidate (DRAFT, CI only, do not merge)`. GitHub reported `isDraft=false` and no labels. `ARCHITECTARIEL` authored and merged it at `2026-10-13T21:38:37Z` (2026-10-13 5:38:37 PM ET).
- Head: `3030bd6dfdff8253025998b2170640135061f521`. Merge commit: `0af887057ba2764632412dec2cc2a1d56595e153`.
- On the head, `verify`, `analyze`, and `Vercel Preview Comments` succeeded. On the merge commit, `verify`, `analyze`, and `sweep` succeeded. These checks do not constitute a human review or production behavior proof.
- On 2026-10-14, `main` required `verify` and `analyze` with `strict=false`, had `enforce_admins=false`, and required no PR reviews. Those settings allowed the admin self-merge.

## Deployments

| Deployment | When (ET) | Observed state |
| --- | --- | --- |
| `dpl_EwjL536pogEBKZqQt4u53Svww9XX` (`lux-video-ak2ihon6d`) | 2026-10-13 5:55 PM | Production, READY |
| `dpl_G5L6DcKNj8aWw67xqH1d2aFbSGgC` (`lux-video-4kyceqgpr`) | 2026-10-13 6:05 PM | Production, READY |
| `dpl_7zoJs5B8A54NYo32DXkpqmiuqv7m` (`lux-video-balwgbw2h`) | 2026-10-13 10:36 PM | Production, #99 main `2e3d75a` |
| `dpl_8MkL3VMMmHioo8mJcB3dQCZ1QGmc` (`lux-video-8xk9z06on`) | 2026-10-14 9:51:59 AM | Previous production deploy; rollback target, CLI deploy by `ariel-9388` |
| `dpl_5TYjuzQYWjkZhL83qj9iQpMAMvn2` | Not established here | Current production deploy |
| `dpl_Dts8X3d81fa4YH9xdi8t848AYRk9` (`lux-video-f8xr5r30i`) | 2026-10-09 3:43:49 PM | Pre-#98 production target, READY; not a rollback target because migration 0011 is applied and pre-#98 code is not verified against it |

**Current production deploy:** `dpl_5TYjuzQYWjkZhL83qj9iQpMAMvn2`. **Rollback target (previous production deploy):** `dpl_8MkL3VMMmHioo8mJcB3dQCZ1QGmc`.

The previous CLI deployment has no recorded Git source SHA. Saying it was built from main `2e3d75a` is an **inference**, not a verified source binding. It is verified that `0af8870` is an ancestor of `2e3d75a`. This record does not establish the current deployment's source SHA.

## Production read-only finding (2026-10-14)

The supplied production read-only finding reports migration 0011: 12 migration rows, latest hash prefix `e6a39681`. It found 0 v3 consent rows, 0 `avatar_consent_submit` operations, and no `identity_consents_hosted_v3_purpose_ck` constraint. These observations do not verify application compatibility with a pre-#98 rollback.

## Scope

GitHub and `git diff --shortstat` agree: 168 files, 26,311 additions, 597 deletions. Material changes include:

- `identity_consents_authorizations_ck` was introduced in `drizzle/0004_identity_studio_mvp.sql:14`. `drizzle/0009_absurd_meteorite.sql:153` introduced `provider_lifecycle_operations_kind_ck` with `url_probe`. `drizzle/0011_concerned_micromacro.sql:3-19` rewrites the identity authorization CHECK with the v3 branch (`policy identity-provider-subject-consent-v3`, `voice_authorization=false`) and adds `avatar_consent_submit` to the provider operation kind CHECK.
- `db/provider-subject-consent-repository.js` (+710), `db/repositories.js` (about 587 lines changed), `routes/video-os-lite/provider-consent.js`, `lib/provider-avatar-consent.js`, `api/video-os-lite/render-v2.js`, and `workflows/video-render.js` (168 lines changed).
- `vercel.json` (+16), including provider-consent and LUXIFY API aliases and the public `/provider-consent` page; approximately 20 MB of showcase MP4/WebP assets.

## Risk review (render / credits / consent / other)

- **Render:** Scripted-photo renders now call `observeProviderAvatarConsent` with a provider read before reservation (`render-v2.js:570-578`). `repositories.js:681-685` enforces freshness under `lib/provider-avatar-consent.js:103-122`. This adds provider dependency and latency; the failure mode is fail-closed.
- **Credits:** The inspected LUXIFY and scripted-photo paths validate configured cost and quotes before reservation. The generic premium path still reserves literal 90 without a quote token. That pre-existing duplication can drift and deserves a follow-up.
- **Consent:** The public `/provider-consent` page and consent URL storage and cleanup are new public surface. QA's post-hoc review passed, while the consent-page pass remains open. Migration 0011 is not undone by a Vercel rollback; compatibility of pre-#98 code with its constraint is unverified.
- **Other:** `serverRenderCorrelationId` replaces the client request id in `render-v2.js`; clients or logs expecting an echoed id may break (assessed low risk). A self-declared do-not-merge PR with 168 files merged without human review, beyond a reviewable size.

## Credit mismatch finding

The claimed live “quote versus hardcoded 90-credit `reserveRender`” mismatch is **refuted as a #98 defect** by the inspected paths; no live mismatch was observed.

- LUXIFY: `render-v2.js:252` computes `currentCost = configuredLuxifyCredits(resolution, env)`. Lines 258-264 reject a verified quote whose `luxCredits` differ with 409 `LUXIFY_COST_MISMATCH`; line 286 reserves `costCredits: currentCost`. `db/repositories.js:345-346` reasserts configured cost and lines 695-696 reverify quote credits in the transaction. `lib/luxify-quote.js:74-86` fails closed with 503 `LUXIFY_QUOTE_CONFIG_MISSING` if `VIDEO_OS_LUXIFY_720P/1080P_LUX_CREDITS` is unset.
- Scripted photo: `render-v2.js:588` uses `activation.costCredits`. `repositories.js:671` and `:702` check it; lines 705-708 verify the scripted-photo quote credits.
- Generic premium: `render-v2.js:665` reserves `costCredits: 90` without a quote token. The literal was already at line 327 of `0af8870^1`; #98 changed only `correlationId` on that line. The value matches displayed provider cost 90 in `lib/video-os-account.js:6` and `public/lite.js:34`, including fallbacks at `public/lite.js:979,1002`.

Residual risk: literal 90 and the provider list are duplicated sources of truth, and generic premium is not quote-bound. Deriving its cost from `providerList` or a quote is a follow-up, not a verified live mismatch fix.

## Decision and considered options

1. **Option A (Option 1), chosen 2026-10-14: Keep #98 live.** QA's post-hoc review passed. Finish the `/provider-consent` consent-page pass, add the guard and proposed protections, and fix the premium cost source of truth in a follow-up. This preserves #99, which builds on `0af8870`.
2. **Rollback target if separately authorized:** Previous production deploy `dpl_8MkL3VMMmHioo8mJcB3dQCZ1QGmc`; current production deploy `dpl_5TYjuzQYWjkZhL83qj9iQpMAMvn2`. Migration 0011 remains applied. The earlier pre-#98 deployment `dpl_Dts8X3d81fa4YH9xdi8t848AYRk9` is not a rollback target because its code has not been verified against migration 0011.
3. **Revert merge `0af8870` on main via PR and redeploy.** This most consistently aligns source and production, but conflicts with #99.

Option A is Ariel's decision to keep #98 live; it does not authorize a deployment, rollback, or branch protection change.

## Guard added

`tools/merge-intent-guard.mjs` rejects GitHub draft state and whole-word `DRAFT`, `WIP`, or `do-not-merge`/`do not merge` markers in title or labels. `.github/workflows/merge-intent-guard.yml` runs it for main-targeting PR edits and state/label changes, with untrusted PR data passed through environment variables. It checks out `github.event.pull_request.base.sha` and runs only base-branch guard code. The check context remains `merge-intent-guard`.

`.github/CODEOWNERS` assigns `@ARCHITECTARIEL` to `/.github/`, the guard and its tests, and `/CODEOWNERS`. With a single maintainer, required code-owner review is off, so CODEOWNERS is advisory. With `pull_request_target`, the workflow definition and checked-out guard code always come from main (the base), so a PR editing either cannot affect its own check. No PR-head code is checked out or run, and the token is read-only. Guard changes take effect only after merging to main; admins can still edit protection settings. Under `pull_request_target` the workflow does not run on the REL-004 PR itself, because main has no workflow yet, so no `merge-intent-guard` check appears; it starts on the first PR after the merge.

## Branch protection proposal (NOT applied)

The chosen variant keeps solo merges possible while enforcing checks for admins. Apply only after REL-004 is merged to main and one PR shows `merge-intent-guard`, `verify`, and `analyze` all green. These are the proposed Bash and PowerShell commands, **not executed**:

```bash
gh api -X PUT repos/ARCHITECTARIEL/lux-video-os/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": {"strict": true, "checks": [{"context": "merge-intent-guard"}, {"context": "verify"}, {"context": "analyze"}]},
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
```

```powershell
@'
{
  "required_status_checks": {"strict": true, "checks": [{"context": "merge-intent-guard"}, {"context": "verify"}, {"context": "analyze"}]},
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
'@ | gh api -X PUT repos/ARCHITECTARIEL/lux-video-os/branches/main/protection --input -
```

This branch protection change remains unapplied.

## Open items

- Finish the `/provider-consent` consent-page pass; QA's post-hoc review already passed.
- Verify rollback compatibility with migration 0011 before any separately authorized rollback.
- Premium cost source-of-truth follow-up and correlation-id client/log impact check.
- After REL-004 is merged, observe all three checks green on one PR, then separately apply the chosen branch protection variant if authorized; review `.github/` diffs because CODEOWNERS is advisory.
- Confirm the current production deployment's exact source if a source-bound release decision is needed.
