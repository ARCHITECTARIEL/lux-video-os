# Video OS Lite Flagship MVP Audit Plan

Date: 2026-07-08

## Executive Verdict

Video OS Lite is a strong local MVP with a real differentiator: it can combine avatar generation with a production kit layer of LUTs, music, CTA, overlays, and format-specific exports. The current app can demonstrate the end-to-end idea, and one live HeyGen render has produced a final MP4 with selected avatar, selected voice, and kit metadata.

It is not yet a flagship consumer SaaS. The core gap is not visual polish alone. The repo is still built like a local single-user operator service with a consumer wizard on top. To beat ScaleWithClones-style products, Lux needs one-click completion, authoritative billing, provider lifecycle reliability, polished avatar onboarding, and a UI that feels like a premium creation tool rather than an admin cockpit.

## What Works Now

- Clear MVP surfaces exist: dashboard, create-video wizard, script assistant, avatar picker, voice picker, brand/kit selector, generation status, preview, export, result gallery, pricing/credits, avatar/digital-twin setup.
- HeyGen is the only provider with a proven live path. A prior end-to-end run created a finalized vertical MP4 and sidecar metadata.
- Finalization can apply the production kit after the provider render through FFmpeg.
- Results now expose recent final videos with provider, format, and kit metadata.
- Credits and pricing are visible in the product, which is better than hiding usage cost.
- The asset-routing and kit-selection logic is differentiated and should be treated as the Lux moat.

## P0 Problems Blocking Flagship Readiness

1. Consumer flow is still two-step: submit provider render, then manually finish the final MP4 later. The product promise should be one click from "Generate" to "Final MP4 ready."
2. Provider state is semantically muddy. "Submitted to HeyGen" and "video finished" can collapse into confusing statuses.
3. Non-HeyGen providers are submit adapters, not full lifecycle adapters. Argil, Tavus, and D-ID need submit, poll/webhook, normalize, retry, cancel, and finalize contracts.
4. Credits are local optimistic JSON state, not an authoritative billing ledger tied to Stripe webhooks.
5. There is no real user account, tenant, session, entitlement, or protected media model.
6. Uploads are base64/local-public-file oriented and not ready for consumer avatar/digital-twin intake.
7. The QA suite does not protect the provider render loop, finalization, credit debits/refunds, upload errors, or Stripe checkout.
8. The UI is understandable but too long and module-heavy. It reads more like a dashboard than a premium consumer creation product.
9. The render engine is still a fixed compositor. The kit layer is valuable, but it needs to become a scene/timeline renderer.
10. Generated artifacts and state mirrors are spread across SQLite, JSON files, public snapshots, job files, sidecars, uploads, and exports.

## Product Direction

The flagship experience should be:

1. Brief: "What do you want this video to do?"
2. Cast: choose or create presenter and voice, with a curated default.
3. Finish: Lux auto-selects kit, format, captions, CTA, music, background, and generates the final MP4.

Default UX rule: the user should never need to know whether HeyGen, Argil, Tavus, or D-ID is underneath unless they open advanced settings. Provider labels should become outcome labels:

- Best Quality
- Fast Render
- Photo Avatar
- Digital Twin
- Talking Head
- Real-Time Presenter

## 30-Day Plan: Make The Local MVP Trustworthy

Goal: protect the current working demo and remove the biggest trust breakers.

1. Collapse provider submit + finalization into an automatic job loop.
   - User clicks Generate once.
   - UI status advances: Submitted -> Avatar rendering -> Applying Lux kit -> Final MP4 ready.
   - Finalize automatically when provider output is ready.
   - Manual "Finish final MP4" becomes a fallback/retry action only.

2. Normalize render states.
   - Separate `submitted`, `provider_rendering`, `provider_ready`, `kit_rendering`, `ready`, `failed`, `refunded`, `needs_consent`.
   - Store provider job id, selected avatar, selected voice, kit, format, cost, and result url in one canonical result record.

3. Add regression tests.
   - Mock provider success/failure.
   - Test avatar/voice/kit persistence.
   - Test ready:false finalization.
   - Test insufficient credits and refund behavior.
   - Test upload validation and unsupported files.

4. Fix the UX shape without a rewrite.
   - Compress wizard labels into Brief, Cast, Finish.
   - Move account/digital twin/admin setup out of the primary path.
   - Add inline "this render costs X credits" near Generate.
   - Make result preview the premium moment.

5. Clean up artifact/state boundaries.
   - Keep generated exports and test artifacts out of the main result gallery unless explicitly marked user-visible.
   - Add isolated test data roots so smoke/e2e does not contaminate shared local state.

## 60-Day Plan: Turn It Into A SaaS Control Plane

Goal: make it safe to sell.

1. Add authentication and tenant ownership.
   - User accounts.
   - Protected API routes.
   - Tenant-scoped projects, assets, credits, avatars, voices, and exports.

2. Move storage to a real object/media layer.
   - Signed upload URLs.
   - Virus/content checks.
   - Size, duration, codec, and mime validation.
   - Private source files and signed result downloads.

3. Replace local credits JSON with an authoritative ledger.
   - Stripe Checkout for credit packs and subscriptions.
   - Stripe Customer Portal.
   - Webhook reconciliation.
   - Idempotent credit grants.
   - Debit on accepted render job, refund/settlement on provider failure.

4. Build provider capability contracts.
   - HeyGen: avatar/video/voice quality path.
   - Tavus: digital twin / conversational path.
   - D-ID: photo/talking-head fallback.
   - Argil: only ship when full lifecycle is configured and tested.

5. Add operational visibility.
   - Job dashboard.
   - Failed render recovery.
   - Provider latency/cost tracking.
   - User-facing messages without stack traces.

## 90-Day Plan: Make It A Lux Flagship

Goal: create a product that sells itself in five minutes.

1. Build the Lux scene engine.
   - Scene-level pacing.
   - Brand kit enforcement.
   - Auto B-roll/background selection.
   - Captions as design, not subtitles only.
   - CTA variants.
   - Vertical, square, and landscape derivatives from one render.

2. Build first-run magic.
   - "Make my first video" path.
   - Three high-converting templates: Sales Video, Social Post, Product Demo.
   - Sample preview before payment.
   - One-click duplicate/remix from final result.

3. Make avatar creation a premium onboarding path.
   - Upload-first.
   - Consent capture.
   - Provider readiness warnings.
   - Status timeline.
   - "Your digital twin is ready" result card.

4. Add growth and sales polish.
   - Shareable result page.
   - Watermarked preview for free users.
   - Credit bundles with plain-language value.
   - Creator/team plan split only after core consumer flow is strong.

## QA Gates Before Public Launch

- `python -m py_compile server.py provider_gateway.py video_os_backend.py`
- `python scripts/video_os_lite_smoke.py`
- Mock provider test suite for submit, poll, finalize, failure, refund, and retry.
- One gated live HeyGen canary render.
- Final MP4 sidecar must match selected avatar, voice, kit, provider, format, and credit cost.
- No stuck project may have `status=rendering` with provider failure.
- All error paths must return useful user-facing messages.
- No public route may expose another user's upload, export, raw provider response, or secret.

## Competitive Positioning

ScaleWithClones-style products sell the "clone yourself and scale content" promise. Lux should sell a better promise:

"Make a polished avatar video that already looks edited."

That is stronger because it combines clone, script, voice, captions, music, LUT, CTA, format, and export. The winning product is not the one with the most provider logos. It is the one that gives the user a finished, saleable video with the least effort.

## Immediate Next Build Order

1. Automatic finalization loop after provider render.
2. Render state model cleanup.
3. Mock-provider regression tests.
4. Three-stage Brief/Cast/Finish UI compression.
5. Stripe webhook-backed credit ledger.
6. Account/auth/media ownership.
7. Provider lifecycle adapters for Tavus, D-ID, Argil.
8. Scene engine upgrade.

