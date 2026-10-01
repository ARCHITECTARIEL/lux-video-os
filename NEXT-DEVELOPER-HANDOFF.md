# LUX Video OS — what's left to ship

**Written 2026-10-01, end of a long session. Start here if your job is "finish this and ship it."** This is not a replacement for `docs/CURRENT-MVP-HANDOFF.md` (the chronological session log — read it if you want the full blow-by-blow) or `HANDOFF.md` (older, mostly superseded). This document exists to answer one question: **what concretely stands between today and a real, live, billable product** — in priority order, with exact next actions.

Current production HEAD as of this writing: commit `02d5e46`, deployed and smoke-tested healthy at `https://lux-video-os.vercel.app`.

## TL;DR

- The product **works end to end in code**: sign-in, Identity Studio, Standard/Premium tiers, HeyGen Premium rendering, admin console, watchdog alerting, a real (if newly-built) release-authorization pipeline. All of it is live in production as of today.
- **Nothing customer-facing can actually render yet.** `providerCreationActivationStatus()` (`db/provider-reconciliation-repository.js`) is hardcoded `{ enabled: false }` — this is the single master switch gating both identity creation and render submission. Flip it and real HeyGen spend becomes possible; until then, the deployed app is inert on that front by design.
- **Billing is not built.** No Stripe keys in production, and the owner is reconsidering Stripe vs. Authorize.net — this decision is explicitly deferred, not scoped here.
- **The P0 launch gate has never been cleared**, and the two things it actually needs are both unbuilt (see #1 below) — not configuration, real engineering work.

## What's left, in priority order

### 1. The P0 production proof (`docs/P0-RELEASE-GATE.md`)

This is the actual gate standing between "the code works" and "we can launch." It requires one real, fully-observed paid render with a 9-point signed receipt. Two prerequisites for that receipt don't exist yet:

- **A real evidence collector.** `tools/verify-p0-release-gate.mjs` is permanently disabled by design — every invocation exits 2, on purpose, because there is no authenticated collector for the required observations (signed-in session, provider job completion, private artifact hash, fresh-session recovery, anonymous/wrong-account/direct-Blob denial checks). Building this means real browser-session automation (Playwright, most likely, given the existing e2e suite), not a script. **Do not** try to shortcut this with a self-asserted JSON receipt — a prior session already built and then explicitly disabled exactly that mistake.
- **Private storage migration**, explicitly found "not ready to execute" as of Sept 30: production has 77 Blob objects, **26 unclassified** (20MB). The reviewed migration procedure is 4 phases (freeze/inventory → copy-and-verify → reference migration → public-source removal), **each requiring its own separate production-write approval**, the last explicitly marked "destructive approval." Read `docs/execution-notes/20260930-prompt4-storage.md` for the exact procedure before touching any of this.

Full scoping writeup: `docs/execution-notes/20261001-p0-proof-scoping.md`. Treat this as its own multi-session project. Don't flip the activation switch (see #3) until an actual proof run is imminent — there's no reason to leave it on with nothing in progress.

### 2. Billing (owner decision pending: Stripe vs. Authorize.net)

Once decided: get real keys into production, wire the checkout/webhook routes (`api/video-os-lite/checkout-v2.js`, `stripe-webhook-v2.js` — note these are Stripe-specific; an Authorize.net choice means new integration code, not just new keys), and only then consider `VIDEO_OS_BILLING_ENABLED`. This stays unset through the entire P0 proof — billing activation is a separate step after P0 clears, not before.

### 3. The `providerCreationActivationStatus()` activation switch

A single hardcoded function in `db/provider-reconciliation-repository.js`:
```js
export function providerCreationActivationStatus() {
  return Object.freeze({ enabled: false, reason: 'verified_provider_account_binding_not_wired' });
}
```
This is checked independently at both identity submission (`routes/video-os-lite/identities.js`) and render submission (`workflows/video-render.js`) — flipping it is the literal moment real customers can trigger real HeyGen spend. The production HeyGen provider-space binding now exists (bootstrapped today, see `docs/execution-notes/20261001-production-heygen-binding.md`), so the binding-validity precondition is met — but flipping this switch should happen **immediately before and in service of the P0 proof run**, not as a standalone action. Treat it as owner-gated every single time, per this project's execution-mode ladder (SIMULATION → CANARY → PRODUCTION).

### 4. Standard tier: SIMULATION vs. real RunPod GPU inference

`VIDEO_OS_STANDARD_PROVIDER` defaults to `simulation` (ffmpeg-only compositing, no real lip-sync). Real RunPod code is merged (`services/sadtalker-runpod.js`) but needs `VIDEO_OS_RUNPOD_ENDPOINT_ID`/`RUNPOD_API_KEY` and an explicit flag flip — another owner-gated, real-cost decision. Premium (HeyGen) is the more mature tier; consider whether Standard needs to be real before launch or can stay simulation-only for a v1.

### 5. Legal review of `/privacy` and `/terms`

Built, live, AI-drafted, grounded in real data practices — **not lawyer-reviewed**. Get this done before any real scale, especially given Standard tier processes portraits/voice recordings (state biometric-privacy statutes may apply). An artifact with the current copy was prepared earlier for the owner's own read-through — check with the owner for that link if needed, or just review `public/privacy.html`/`public/terms.html` directly.

### 6. Housekeeping / lower priority

- **3 dependabot PRs stuck on merge conflicts** (`#59` docker/setup-buildx-action, `#60` hyperframes, `#63` zod) — wait for Dependabot's auto-rebase or resolve manually.
- **VPS hosting path** (`deploy/`) has never been exercised against a real box — code-only, tests pass, zero production proof.
- **Non-HeyGen providers** (Argil, Tavus, D-ID) are UI stubs only (`configured: false`).
- **Watchdog Slack alerting** is wired but inactive — needs a real `WATCHDOG_SLACK_WEBHOOK_URL` if you want a second alert channel beyond email.
- **Wish list** (not scoped/built): onboarding/first-run guidance for new signups, subscription tiers vs. pay-as-you-go, white-label/per-client branding, a real-time admin dashboard.

## How to actually deploy (the real, current process)

This project does **not** auto-deploy from GitHub pushes — every deploy is a deliberate manual action:

1. `npm run build:production` (needs `VIDEO_OS_DB_TARGET_MANIFEST=config/database-target.production.json` and a production `DATABASE_URL`/`DATABASE_URL_UNPOOLED` loaded via an approved credential channel — never commit or print these). This re-verifies production DB state and packages a build, then **always quarantines its own output** — this is deliberate, not a bug (`RELEASE-PREFLIGHT.md`: "Do not move an artifact back or run `vercel deploy --prebuilt` to bypass these gates").
2. `node tools/authorize-release.mjs --owner-authorized` (same env vars) — re-verifies source identity, output integrity, a fresh DB check, the Workflow sandbox boundary, and current-candidate CI (`verify`+`analyze` for the exact commit), then restores the quarantined output to `.vercel/output` **only if every check passes and `--owner-authorized` was explicitly passed**. This tool never claims full release authorization (`releaseAuthorized` stays `false` always) — it only clears what code can legitimately re-verify. See its own header comment for exactly which gates it can't and doesn't try to clear.
3. `vercel deploy --prebuilt --prod --yes --archive=tgz` — the `--archive=tgz` flag is required; a plain upload hits Vercel's 15,000-file limit on this project's output.
4. Smoke-test the live alias afterward. Update `config/release-baseline.json` to the new deployment.

Full worked example with real output: `docs/execution-notes/20261001-production-deploy.md`.

## Credentials and access

See `HANDOFF.md`'s "Credentials you'll need to obtain" table for the full list — it's still accurate for what's *missing* (Stripe, RunPod, Slack webhook). For what's already configured: `HEYGEN_API_KEY` was rotated today to a freshly-qualified key; Google OAuth, Resend, the workspace/admin passwords, and the Neon/Blob store credentials are all live. The production DB's protected read credential this session used lived at a temp path under `%TEMP%\lux-video-os-production-db-inspection-20261001\` — that's a point-in-time inspection credential, not guaranteed to still be valid; get a fresh one from the Vercel dashboard (`DATABASE_URL`/`DATABASE_URL_UNPOOLED`, both marked Sensitive) if it's gone.

## Known gotchas worth knowing before you dig in

- `drizzle-kit migrate` and the app's own DB tooling (`tools/check-migrations.mjs`, `tools/authorize-release.mjs`) are hardwired to the `@neondatabase/serverless` driver, which only connects via websocket to real Neon/Vercel/Supabase — none of it works against a plain local Postgres instance directly. If you need a truly fresh reference environment (we did, to fix a stale schema lock), you'll need to seed the `drizzle.__drizzle_migrations` journal table by hand and compute hashes via the project's own exported functions rather than its CLI.
- `config/database-schema.lock.json`'s `schemaSha256` was recaptured today (`docs/execution-notes/20261001-schema-lock-recapture.md`) after the original Sept 30 value proved unreproducible on two independent clean environments. If this check ever fails again, don't assume production drifted — verify against a fresh clean environment first.
- The HeyGen space-binding tooling (`db/heygen-space-binding-repository.js`, `tools/bind-heygen-space.mjs`) now supports a production target, but only with an explicit `--owner-authorized` CLI flag (which sets `VIDEO_OS_PRODUCTION_BINDING_CONFIRMED` to an exact phrase the repository checks) — requesting `--environment production` alone is deliberately insufficient. This tool also hard-refuses to run at all if `VERCEL_ENV === 'production'` — it's an operator CLI, never meant to execute inside the deployed app.
- `vercel build` flattens `public/` to the output root — a `vercel.json` route with a `/public/` prefix 404s on real Vercel even though it works locally. See `HANDOFF.md`'s "Known gotchas" for the full list of these (CodeQL allowlist mechanics, the dead `video_os_backend.py`/`public/lite.js` files, etc.) — still accurate.

## Where to find more detail

- `docs/CURRENT-MVP-HANDOFF.md` — the chronological session log, most-recent-first. Read its "Evidence index and authority order" section if two documents disagree.
- `docs/execution-notes/` — one file per significant piece of work, dated. The last several (2026-10-01) cover today's session in full: production migrations, the schema lock fix, the authorize-release tool, the HeyGen binding production path, and the P0 scoping assessment.
- `wiki/log.md` — a terser running log, one entry per session.
- `docs/P0-RELEASE-GATE.md`, `docs/RELEASE-PREFLIGHT.md` — the actual release gates. Read before touching billing, production deploys, or real spend.
