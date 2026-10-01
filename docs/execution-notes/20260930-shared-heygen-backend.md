# Shared HeyGen backend foundation

September 30, 2026. **Backend foundation implemented locally and verified; not a release approval.** Owner selected HeyGen for both MVP tiers and asked to retain lower-cost research as a separate ROI track.

## Scope

This slice adds a contained, strict scripted-photo backend contract for an already enrolled, owned, consented identity. Tier authorization must remain independent of provider: Standard+HeyGen is still Standard, and it must never grant Premium access. Preserve legacy Premium and `standard-narration-v1` behavior. No frontend/enrollment/migration/dependency/provider-environment change is included in this slice.

New calls remain behind an explicit feature flag that defaults off. Standard's new credit price must be explicitly configured and validated, with no guessed default; existing Premium pricing remains unchanged. This is fixed-cost backend groundwork. A full quote/customer-price-acceptance contract, phone-video enrollment, derived-voice consent/storage and frontend integration remain necessary before rollout.

Files assigned to the implementation lane: strict validation/contract helper, render route, reservation/submission authorization, HeyGen workflow and job DTO, plus targeted regressions and a guarded isolated database test. The lead owns integration, live-test execution, final build evidence and documentation. Provider calls, deployments and production database changes are outside scope.

## Preserved baseline

HEAD remains `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9` with inherited uncommitted changes. Six affected source files were backed up before this slice to `%TEMP%\lux-shared-heygen-baseline-20260930T160639Z`; backup manifest SHA-256 is `93351a948fffa09109240daf0dfcb70e0094e8d69a57210fa15cbd8c545f5a18`.

The previous source-bound baseline is [the scripted-photo next-step receipt](scripted-photo-20260930/verification.json), source digest `f4ec2e4b83b5ef0dadf0d21c1cdeb27e150a8539bbfd67eda2f940f506132618`. Do not overwrite that historical evidence with this candidate's results.

## Independent ROI work

[LOW-COST-RENDERING-RESEARCH.md](../LOW-COST-RENDERING-RESEARCH.md) now tracks InfiniteTalk, current LongCat Avatar 1.5, LivePortrait as a component and legacy SadTalker constraints. It separates free-license claims from total GPU/TTS/retry/storage/review/engineering costs and defines cost per accepted minute and break-even measurement. It does not block the HeyGen MVP or authorize paid benchmarks, model downloads or a customer-facing free plan.

## Verification status

- Final `npm run test:unit`: exit 0, **392 Node passes / 43 credential-live skips / zero failures; four Vitest passes**. An intermediate run found two outdated static assertions (four DTO responses versus the new six, and hardcoded Premium authorization versus derived tier); they were updated without weakening the privacy/talent checks and the final full run passed.
- Guarded real isolated database scenario: **1 pass / zero failures / zero skips**. It verified Standard-only authorization using HeyGen, Premium denial, actual provider claim, consent-revocation lock ordering, quarantine rejection/release, and atomic protection against stale or generic-error refunds of claimed/unknown jobs. All 16 application tables and Blob store returned to zero. These are synthetic identity rows for database correctness, not real enrollment or provider-output proof. [Live receipt](shared-heygen-20260930/live-tier-consent.json).
- `npm run build:preview`: exit 0, 39 routes, 93 steps and two workflows. Output is quarantined and the default prebuilt path is absent. The known Sandbox warning remains; production is not cleared.
- Focused regressions, import checks, syntax and whitespace checks passed. No schema, migrations, package files or Vercel project link changed.
- [Verification receipt](shared-heygen-20260930/verification.json), [build summary](shared-heygen-20260930/build-review-summary.json) and [source ledger](shared-heygen-20260930/source-files.json) bind the exact candidate and private log hashes.


## Contract and containment

The new request version is `scripted-photo-v1`. Its client fields are limited to `contractVersion`, `tier` (`STANDARD` or `PREMIUM`), `projectId`, `identityId`, `idempotencyKey`, `title`, `script` and `format`. Provider IDs, avatar/voice selections, costs, consent proofs, source bindings, authorization objects and composition payloads are server-owned and rejected in this request shape.

An owned saved project must already carry matching `settings.contractVersion`, `settings.tier`, title, script and identity. This slice does not create those projects or enroll a phone-video identity through the current UI. An existing ready/consented owned identity is the backend test prerequisite; these database fixtures are not real enrollment or photo/voice likeness proof.

`VIDEO_OS_SCRIPTED_PHOTO_ENABLED` defaults off. The new Standard path additionally requires a positive safe-integer `VIDEO_OS_STANDARD_SCRIPTED_CREDITS`; there is no price default. The isolated test value of 37 credits is synthetic and is not a production price decision. Existing Premium remains 90 credits. These conditions are tested locally only; no environment was changed on Vercel. Do not activate the new route before the remaining quote, enrollment, frontend and release prerequisites are complete.

## Review-driven repairs

The independent review and lead inspection found credit-safety gaps at concurrent/failed submission boundaries. Repairs cover losing claims, known local configuration failures before dispatch, and failure to persist an ambiguous provider outcome. Failure cleanup now has an atomic expected-status guard under the job row lock so a stale HTTP or workflow invocation cannot refund an already-claimed winner. Source quarantine, media kind/type and classification are rechecked under the same source locks as consent/hash binding.

Installed Workflow 4.8.9 persists failed-step message/stack and reconstructs `FatalError(message)`, discarding custom fields. Evidence: `node_modules/@workflow/core/dist/runtime/step-handler.js` failed-step event, `dist/step.js` failure reconstruction, and `dist/serialization.js` generic Error reducer. Therefore submission ambiguity and preclaim failure classification use versioned server-authored message codes that survive reconstruction; custom JavaScript properties alone are insufficient. Tests reconstruct the error without custom properties. Machine markers are removed from the stored customer-facing failure message. **Do not remove these codes during cleanup without proving equivalent durable behavior.** Logging and best-effort unknown-state persistence must never replace a possible-submission marker with a raw error that would permit refund/resubmission.

## Exact changed source/test paths for this slice

- `api/video-os-lite/render-v2.js`
- `db/dto.js`
- `db/repositories.js`
- `lib/scripted-photo-contract.js`
- `lib/video-os-operations.js`
- `lib/video-os-validation.js`
- `tests/helpers/authorization-repair-scenario.mjs`
- `tests/helpers/scripted-photo-backend-scenario.mjs`
- `tests/job-dto-privacy.test.mjs`
- `tests/job-output-acceptance.test.mjs`
- `tests/render-request-validation.test.mjs`
- `tests/scripted-photo-backend.test.mjs`
- `tests/scripted-photo-contract.test.mjs`
- `tests/scripted-photo-live.test.mjs`
- `tests/talent-inventory.test.mjs`
- `workflows/video-render.js`

Source digest: `b32f99ea492053741483bee31894523bba5a6c8005691f40203b13c9c8ca8ede`. Output digest: `003910e3194239a01b606057dd38e29a7a19c9c8d32a8647127deb7b2aca1d93`.

## Closure review and next work

Independent bounded closure review: **PASS**, with 10/10 focused tests and no remaining material finding in this scope. The lead additionally verified the final full suite, isolated database cleanup and packaged candidate. Production remains unapproved: the new route stays disabled and the known Sandbox/production DB/storage/provider/P0 gates remain unresolved.

Next: implement private phone-video enrollment and consent-bound derived voice assets, versioned project creation, quote/customer price acceptance and the phone-first script interface. Do not repeat the provider choice; HeyGen is selected for both MVP tiers. Keep the separate ROI research moving without changing this MVP path. Its latest read-only LongCat capture records 57 publisher files and an exact MIT code-license copy; model/runtime/commercial qualification and actual savings remain unproven.

No provider generation or clone request, model-weight download, GPU benchmark, production data mutation, commit, push or deployment was performed in this slice. Test-only Neon/Blob verification was cleaned to zero rows/objects.
