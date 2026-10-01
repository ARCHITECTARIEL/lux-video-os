# Vercel audit — 2026-09-29

Read-only observations from Vercel CLI 58.9.0, team `lux-3035s-projects`. No deploy, relink, environment change, database operation, or render was performed.

## Deployment identity

| Surface | Observed state |
|---|---|
| Local `.vercel/project.json` | **Production project** `lux-video-os`, `prj_jZYuVgIAk1cwx8MRKE5kGNxn4ItW` (contradicts September 23 orientation) |
| Stable production alias | `https://lux-video-os.vercel.app` |
| Alias deployment | `dpl_AEUWrAaSPEyvNjkkZxCbDAg427WP`, READY, production |
| Immutable URL | `https://lux-video-nztminlu3-lux-3035s-projects.vercel.app` |
| Created | 2026-09-24 21:02:50 UTC |
| Recorded commit | `a04e59513e7cbd5684bf56790311d2ab14676499`; API gitSource null |
| Latest observed main preview | `dpl_DLi3r7gP11RoanJLpVeTVW6k86wy`, READY, CLI identifies Preview |
| Preview URL | `https://lux-video-aypocwqwi-lux-3035s-projects.vercel.app` |
| Preview git source | `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9`, GitHub main |
| Preview alias | `https://lux-video-os-git-main-lux-3035s-projects.vercel.app` |

`git rev-list --count a04e59513e7cbd5684bf56790311d2ab14676499..HEAD` returned 28. This is commit history distance, not 28 independently verified deployed changes. Metadata is not a source-content attestation, especially for manual deployments. The dirty authorization repair is outside both commit identities.

## Configuration inventory

`vercel env ls production --scope lux-3035s-projects` listed RunPod key, endpoint, provider selector, simulated-output flag, Standard activation/policy/schema/pricing flags, durable workflow flag, database, Blob, HeyGen, Google, Resend, watchdog and session configuration names. Values were not inspected or retained.

No `STRIPE_*`, `VIDEO_OS_BILLING_ENABLED`, or `VIDEO_OS_HOSTED_FINISHING_ENABLED` names appeared in this current project inventory. This does not retrospectively attest a deployment's effective environment. Hidden RunPod values do not prove `runpod` selection, real inference, or simulated-output rejection.

## Interpretation and remaining proof

- READY proves build/deployment readiness, not successful sign-in, consent, inference, acceptance, billing, or private download.
- Production is older than main. Main preview readiness does not prove production promotion or the uncommitted repair.
- The previous handoff's claim that this checkout is linked to `lux-video-os-rebuild` is false now. Verify target before every later build/deploy operation.
- Historical consent timeout remains a symptom to retest against the repaired candidate with correlated telemetry; cold start is not an established root cause.
- This audit did not log into the app, inspect private jobs, run a production DB check, or generate a paid render. Runtime provider mode and complete P0 acceptance remain unverified.

## Reproduction

Read-only commands: `vercel ls lux-video-os --scope lux-3035s-projects`; `vercel inspect https://lux-video-os.vercel.app --scope lux-3035s-projects`; `vercel inspect https://lux-video-aypocwqwi-lux-3035s-projects.vercel.app --scope lux-3035s-projects`; `vercel api /v13/deployments/<observed-id> --scope lux-3035s-projects`. Retain only selected deployment metadata, never environment values.

Selected API evidence: [vercel-deployments.json](vercel-deployments.json).
