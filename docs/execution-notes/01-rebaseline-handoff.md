# Prompt 1 rebaseline handoff

> CORRECTION (2026-09-29 continuation): Finding 1 below was incorrectly marked already repaired. Both sign-in paths persist domain-only users with role `tester`; `listAdminTesters()` registers these rows and the next entitlement calculation grants Premium. See `02-authorization-handoff.md` and its runnable local reproduction. The earlier chat summary claiming three repaired findings was also unsupported. Treat the original table as a historical audit with this correction taking precedence. The earlier test command did not capture a final summary/exit for the entire suite, so its completion claim is unverified. No missing environment variable should be inferred beyond the process used for that run.

Date: 2026-09-29
Expected audit SHA: `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9`

## Repository identity and safety

- Local HEAD: `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9`
- `origin/main`: `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9`
- Branch: `main`, tracking `origin/main`
- Remote: `https://github.com/ARCHITECTARIEL/lux-video-os.git`
- Initial worktree state: clean tracked tree; pre-existing untracked `wiki/` preserved and not modified. Final state additionally contains this required handoff note.
- No product code, workflows, secrets, production variables, databases, providers, billing, deployment, image publication, or history were changed.

## Finding classification

| # | Finding | Result | Evidence and interpretation |
|---:|---|---|---|
| 1 | Domain-only sign-in can gain Premium after an administrator lists testers | NOT REPRODUCED / already repaired | `lib/video-os-security.js` gives a pure domain match `standardRendering` and `tester`, not `liveRendering`; `db/repositories.js:listAdminTesters()` only registers rows whose persisted role is `tester`, not rows included by the domain visibility clause. Existing `mvp-tester-whitelist` and admin-route regressions cover the repaired path. |
| 2 | `standardRendering` users are rejected by the shared gate before tier selection | CONFIRMED | `api/video-os-lite/render-v2.js` calls `requireRenderAccountAuthorization(session.accountId, session.email)` before parsing whether the request is Standard or Premium. The shared gate is Premium containment authorization, while domain-only accounts receive Standard entitlement only. Standard users can therefore be blocked before the Standard-specific path. |
| 3 | App submits portrait while LatentSync requires `sourceVideo` | CONFIRMED | `services/sadtalker-runpod.js` builds the active RunPod envelope with `portrait`; `workers/latentsync-runpod/handler.py` requires `sourceVideo` and `drivenAudio`. The worker is present but the application adapter remains the legacy portrait contract. |
| 4 | `jobDto` omits `outputAccepted` and `tier` required by browser completion behavior | CONFIRMED | `db/dto.js:jobDto()` returns status, output metadata and URL but no `outputAccepted` or `tier`. `public/studio.js:resultAccepted()` requires `item.outputAccepted === true`; the fixture transport supplies the field, masking the real DTO gap. |
| 5 | Provider metadata omits `compositionAvailable`; HyperFrames ignores selected composition | CONFIRMED | `lib/video-os-account.js:providerList()` returns provider identity/configuration/cost only, with no `compositionAvailable`. `services/hyperframes-finisher.js` always loads `LUX_MARKETING_COMPOSITION_HTML`, fixed composition ID, and fixed 1920x1080 output; it does not consume the saved selection. Existing browser tests inject `compositionAvailable` manually. |
| 6 | Migration verification continues without database identity/URL | CONFIRMED | `tools/check-migrations.mjs` returns `{ skipped: true }` when no DB URL exists and `--strict` does not fail that branch. `tools/build-production.mjs` explicitly warns and continues when Vercel env pull cannot provide a production URL. Local proof: `npm run db:verify -- --strict` exited 0 after “No DATABASE_URL provided” behavior was bypassed only by the script’s no-URL path; it performed schema snapshot checking but no live verification. |
| 7 | Stripe reconciliation can report mismatches without failing workflow | CONFIRMED | `routes/video-os-lite/admin.js` always returns HTTP 200 with `{ ok: true, reconciliation }` after logging `mismatchCount`; `.github/workflows/stripe-reconciliation.yml` fails only for non-200 responses. Current workflow failure is instead configuration absence (`503`, `Stripe reconciliation is not configured. Add STRIPE_SECRET_KEY.`), proving the live production key is absent. |
| 8 | Final-media acceptance is weaker than full decode/stream/duration/frame validation | CONFIRMED | `services/media-finisher.js` checks nonempty output only; HyperFrames checks nonempty/size and MP4 `ftyp`; `db/repositories.js:finalizeReadyJob()` persists the artifact and charges credits without a shared ffprobe/decode contract. Existing empty-output regressions cover only the narrow zero-byte case. |
| 9 | Privacy copy denies third-party analytics while Vercel Analytics is loaded | CONFIRMED | `public/privacy.html` says “We do not run advertising trackers or third-party analytics,” while `public/privacy.html` and the main public pages load `/_vercel/insights/script.js`. `public/studio.js` also states “Both tiers are live,” which exceeds current provider and billing proof. |
| 10 | LatentSync checkpoint/VAE commercial-use evidence and immutable hashes are incomplete | CONFIRMED | `workers/latentsync-runpod/model-manifest.json` has `bytes: null` for all model entries, no SHA for the Stability VAE snapshot, unresolved `licenseRecord` paths for OpenRAIL++ weights and the VAE, and notes that exact revision/license evidence is still required. The handler passes a manifest path to `runner.py`, but the runtime contract does not yet establish complete artifact inventory/hash enforcement. |

## Current GitHub evidence

Current candidate checks for `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9`:

- CI run `36579873920`: success — <https://github.com/ARCHITECTARIEL/lux-video-os/actions/runs/36579873920>
- CodeQL run `36579873886`: failure — <https://github.com/ARCHITECTARIEL/lux-video-os/actions/runs/36579873886>
  - Analysis completed, but retained-SARIF enforcement found one non-allowed result: `js/clear-text-logging` at `tools/setup-stripe-products.mjs:48`.
  - The job log also reports CodeQL API upload permission warnings and ends with enforcement exit 1.
- Stripe reconciliation run `36589393600`: failure — <https://github.com/ARCHITECTARIEL/lux-video-os/actions/runs/36589393600>
  - The deployed endpoint returned HTTP 503 with redacted-safe message: Stripe reconciliation is not configured because `STRIPE_SECRET_KEY` is absent.
- Watchdog latest runs are successful but run against prior SHA `e3bb0de1dcadb9af812903fb3554fc7cd2569547`; they do not prove current-SHA behavior. Latest: <https://github.com/ARCHITECTARIEL/lux-video-os/actions/runs/36559444488>
- RunPod Standard worker-image latest successful run is prior SHA `db6e7a736c67f32a55ad5a423ac9b5d7288f7953`: <https://github.com/ARCHITECTARIEL/lux-video-os/actions/runs/35918011716>
- LatentSync worker-image latest successful run is prior SHA `0b9cfa672d85fc6a6a232eb94e49cdb1013fcbdc`: <https://github.com/ARCHITECTARIEL/lux-video-os/actions/runs/36444048386>
- No current-SHA worker-image or watchdog run was found in the queried recent history.

## Priority ordering

- **P0:** Prompt 2 authorization boundary (Standard must not be blocked by Premium gate), Prompt 5 shared media acceptance, Prompt 4 fail-closed promotion/migration gate, and Prompt 7 commercial provenance block. These affect security, economic correctness, release integrity, or legally unsafe enablement.
- **P1:** Prompt 3 real DTO/browser completed-output contract, Prompt 6 versioned Standard `sourceVideo` contract, Prompt 8 real composition capability/consumption.
- **P2:** Prompt 9 billing/product-truth copy, reconciliation reporting UX, analytics/privacy wording, and Copywriter persistence after the P0/P1 contracts are stable.

## Ownership and collision map

| Prompt | Primary ownership | Shared/integration-sensitive files |
|---:|---|---|
| 2 | auth/session, entitlement helpers, tester administration, render authorization/tests | `lib/video-os-security.js`, `db/repositories.js`, `api/video-os-lite/render-v2.js`, workflow authorization, auth tests |
| 3 | DTOs, results/history/finalize routes, My Videos rendering/tests | `db/dto.js`, `public/studio.js`, route contracts, shared job schema |
| 4 | build/release checks, CI, reconciliation workflow, manifests | `package.json`, `.github/workflows/*`, `tools/build-production.mjs`, `tools/check-migrations.mjs`, `routes/video-os-lite/admin.js` |
| 5 | media acceptance and finalization callers/tests | `services/media-finisher.js`, `services/hyperframes-finisher.js`, `workflows/*`, `db/repositories.js`, package tooling |
| 6 | Standard capture/upload/storage/provider contract | `public/studio.js`, `public/standard-contract.js`, Standard routes/repositories, `services/sadtalker-runpod.js`, worker envelope |
| 7 | LatentSync worker provenance/readiness only | `workers/latentsync-runpod/**`, provenance records, image workflow; do not publish or call GPU |
| 8 | Premium catalog/provider/renderer consumption | `public/premium-composition-catalog.js`, `lib/video-os-account.js`, `services/hyperframes-finisher.js`, `workflows/video-render.js` |
| 9 | billing reconciliation, privacy/legal/product copy, confidence UX | Stripe routes/workflow, `public/privacy.html`, `public/terms.html`, landing/studio copy, Copywriter persistence |

## Shared files reserved for integration owner

`db/schema.js`, `db/dto.js`, `db/repositories.js`, `api/video-os-lite/render-v2.js`, `routes/video-os-lite/admin.js`, `workflows/video-render.js`, `workflows/standard-render.js`, `package.json`, `package-lock.json`, `.github/workflows/*`, `vercel.json`, migrations, and the final release manifest.

## Owner decisions required before later prompts

1. Confirm Standard changes from still portrait + narration to short source video + narration.
2. Obtain written commercial-use decisions for LatentSync OpenRAIL++ weights and the Stability VAE, with immutable revision/hash evidence.
3. Decide whether the repository remains public.
4. Decide whether a Premium-only controlled pilot is acceptable if Standard licensing remains blocked.
5. Obtain legal approval for privacy/training/analytics language.
6. Set maximum spend for each preview/canary and decide whether live billing remains disabled during the pilot.

## Verification performed

- `node --test tests/mvp-tester-whitelist.test.mjs tests/entitlement-consistency-across-signin-methods.test.mjs tests/render-auth.test.mjs tests/job-dto-privacy.test.mjs tests/hyperframes-boundary.test.mjs tests/media-finisher-empty-output.test.mjs`: relevant local tests passed; DB-backed entitlement cases were skipped because `DATABASE_URL` and Blob credentials are unavailable in this checkout.
- `npm run db:verify -- --strict`: passed schema snapshot check but did not verify a live database because no DB URL was available; this is evidence of the fail-open defect, not release readiness.
- GitHub Actions logs were read for the current CodeQL and Stripe failures; no secrets or private payloads were retained here.

## Recommended next prompt

Prompt 2, after preserving this note. It must repair the Standard/Premium authorization ordering and remove process-memory authority, while retaining the already-fixed domain-only tester behavior. Prompt 5 should follow before enabling any real finisher/provider path.

Stop condition encountered: live target DB/Blob evidence is unavailable locally. This did not block the read-only rebaseline, but it prevents claiming database-backed regression coverage or release readiness.
