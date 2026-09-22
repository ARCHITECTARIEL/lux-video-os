# LUX Video OS — Developer Handoff (updated 2026-09-22)

Read this first. The root `README.md` is stale (describes an old Python-based version of this app) — ignore it. This document is the real, current source of truth. It's organized by *topic*, not by session — if you want the blow-by-blow history of how this codebase got here, see "Project history" near the bottom; everything above that is simply "what's true right now."

## TL;DR

- **What it is**: an owner-facing AI video studio. Sign in (Google, magic-link email, or workspace password), pick or create an authorized on-camera identity, submit a **Standard** (portrait photo + your own uploaded narration) or **Premium** (HeyGen presenter + cloned voice + script) video request, get a credit quote, render asynchronously, download only accepted output.
- **How far along**: engineering is essentially feature-complete for both tiers, and a full click-through audit of the live production site on 2026-09-22 found the large majority of it genuinely works (see "Audit findings" below for the full list, and "Current state by area"). But that same audit found **two launch-blocking bugs that mean a real new customer cannot use the product at all right now** — read those first, they're not polish items. Google sign-in is live in production for real customers, the operational watchdog is built and actually alerts a human by email, and the Standard tier has real GPU inference code merged (currently running in SIMULATION mode by default). No real paid-render launch-gate receipt has ever been captured (`docs/P0-RELEASE-GATE.md`), and the VPS hosting path has never been exercised against a real box.
- **Where the code is**: GitHub repo (private) `ARCHITECTARIEL/lux-video-os`. `main` is at `286e9c4` — everything described in this document is merged into `main`; there is no other branch you need to track right now (see "Repo & branch state").
- **Immediate next steps, in order**: (1) fix the two launch-blocking bugs in "Audit findings" — a new signed-up customer gets 0 trial credits despite the marketing promise, and the Standard/Premium containment gate locks every real Google-sign-in customer out of Premium entirely; (2) work through the rest of "Audit findings"; (3) a real production proof run against `docs/P0-RELEASE-GATE.md` — needs Ariel's explicit go-ahead, spends real money; (4) get `/privacy` and `/terms` reviewed by an actual lawyer, not just AI-drafted; (5) pick something off the wish list.

## Tech stack

- **Frontend**: no framework — plain HTML/CSS/JS served as static files from `public/`. One shared design system (`public/studio.css`, custom CSS variables, no Tailwind/Bootstrap/etc.) used across every screen. `public/studio.js` is the main app's logic (~2,200 lines, vanilla DOM manipulation, no React/Vue). `/welcome` (marketing landing), `/privacy`, and `/terms` share a second stylesheet, `public/landing.css`, layered on top of `studio.css`.
- **Backend**: Vercel serverless functions (Node.js, ES modules). Routing is **not** Vercel's zero-config file-based routing — it's a legacy `vercel.json` `"routes"` array (`src`/`dest` regex pairs) that both real Vercel *and* a custom Node HTTP server (`server/index.js`, for VPS hosting) parse and execute identically, so the route table can't drift between the two hosting paths.
- **Database**: Postgres via **Neon** (serverless driver, `@neondatabase/serverless`), **Drizzle ORM** (`drizzle-orm` + `drizzle-kit`, schema in `db/schema.js`, migrations in `drizzle/`).
- **Object storage**: **Vercel Blob** for private media (portraits, narration audio, finished videos), behind a swappable driver interface (`lib/storage-drivers/`) — `STORAGE_DRIVER=fs` switches to local-disk storage for the VPS hosting path.
- **Async orchestration**: the **`workflow`** npm package (Vercel Workflow — durable step functions) for render dispatch on Vercel, with a hand-rolled polling worker daemon (`worker/render-worker.mjs`) that drives the *same* step functions directly for the VPS path (`WORKFLOW_DISPATCH_MODE=poll`).
- **Auth**: custom HMAC-signed session cookies (`lib/video-os-account.js`), three consumer sign-in paths — **Google OAuth** (`lib/google-oauth.js`, fully configured and **published to production** — see "Credentials"), magic-link email (via Resend), and workspace username/password. A completely separate admin cookie/login gates `/admin-console` only.
- **Render providers**: **HeyGen** (Premium tier — real, live, has produced a real render) via `services/heygen.js`. Standard tier has two implementations behind `VIDEO_OS_STANDARD_PROVIDER`: `services/sadtalker-simulator.js` (the default — ffmpeg-only, composites the real portrait + audio into a real MP4 but does **no actual lip-sync inference**) and `services/sadtalker-runpod.js` (real GPU inference via a Dockerized RunPod worker, `workers/sadtalker-runpod/` — merged into `main`, but not the active default yet; needs `VIDEO_OS_RUNPOD_ENDPOINT_ID`/`RUNPOD_API_KEY` and an explicit env flip to `runpod` to go live).
- **Billing**: **Stripe** (Checkout Sessions + webhooks, `api/video-os-lite/checkout-v2.js` / `stripe-webhook-v2.js`).
- **Email**: **Resend** — magic-link sign-in, render-complete notifications, and the watchdog's ops-alert email (see next bullet).
- **Operational alerting**: `lib/video-os-watchdog.js` sweeps for stalled render jobs every 15 min on Vercel (`.github/workflows/watchdog-sweep.yml`, GitHub Actions cron) or every 5 min on the VPS path (`worker/render-worker.mjs`'s own loop). It attempts one automatic recovery for jobs with a confirmed provider job ID, fails-and-releases-credits for ones that don't recover, and alert-only for more ambiguous stuck states. Every notable sweep (something recovered, timed out, or needs a human) now sends a summary via **email** (`WATCHDOG_ALERT_EMAIL`, live in production) and optionally **Slack** (`WATCHDOG_SLACK_WEBHOOK_URL`, wired in code but no real webhook configured yet) — `lib/video-os-watchdog-notify.js` — on top of the Sentry logging that already existed. A clean sweep stays silent.
- **Observability**: **Sentry** (`@sentry/node`), gated on `SENTRY_DSN` being set. Error events are sanitized (auth headers/cookies stripped) before being sent.
- **Video finishing**: ffmpeg (via `ffmpeg-static`) for Premium's film-grain/LUT color grading; an optional, disabled-by-default HyperFrames/Remotion path for a more advanced composition (`media/hyperframes/`).
- **Testing**: Node's built-in test runner (`node --test`, ~260 tests, most run live against the real dev Neon DB/Blob store — not mocks) for backend logic; **Playwright** (~105 specs) for frontend e2e, offline against a local static server; **Vitest** for one small validation suite; a **legacy pytest suite** (`tests/test_public_rendering_contract.py`) that partially tests dead frontend code — see "Known gotchas."
- **CI**: GitHub Actions (`.github/workflows/`) — a main CI workflow, a watchdog-sweep cron, a RunPod worker-image build, plus two custom gates: a CodeQL SARIF allowlist and a documented-exception `npm audit` gate (both explained in "Known gotchas").
- **Deployment targets**: **Vercel** (primary, live) or a **self-hosted VPS** (Hetzner/Hostinger-style — `deploy/` has systemd units, nginx config, and a deploy script). The Vercel path has now had multiple real **production** deploys (not just previews) — see "Deployment" below for the exact manual-deploy workflow, since this project is **not** wired to auto-deploy from GitHub pushes. The VPS path is still code-only, never exercised against a real box.

## Repo & branch state

`main` (`286e9c4`) has everything described in this document — the Standard-tier RunPod GPU inference branch, the operational watchdog, Google sign-in, and the new privacy/terms pages are all merged. There is currently **no other branch with real, unmerged work you need to know about** for day-to-day development.

Two things worth knowing if you look at branch history:
- A handful of `agent/*`, `backend/*`, `frontend/*`, `integration/*`, and `fix/issue-*` branches still exist on GitHub from earlier sessions' work. They're either already merged into `main` (safe to ignore/delete) or genuinely abandoned — don't assume a branch's existence means it has unmerged value. **Branch ancestry in `git log` is not reliable for "is this merged?" in this repo** (at least one fix landed on `main` via a path that doesn't show the feature branch as a git ancestor, likely a rebase/squash somewhere along the way) — if in doubt, `git diff` the specific files against `main` directly rather than trusting `git log --oneline branch..main`.
- Clone the real repo — don't work from a zip; a zip has no `.git` history.

## Current state by area

| Area | % done | Why |
|---|---|---|
| Frontend (main app) | ~95% | Fully built, well-tested, live in production. |
| Landing page (`/welcome`) | 100% | Built, brand-accurate, tested, deployed, and confirmed live as the actual front door: an anonymous visit to `/` now redirects to `/welcome` (verified in a real browser against production) — the one open product decision from an earlier version of this doc is resolved. |
| Legal pages (`/privacy`, `/terms`) | Built and live, **not yet lawyer-reviewed** | Added to unblock publishing the Google OAuth consent screen. Content is grounded in this codebase's actual data practices (every real sub-processor, no fabricated claims), not generic boilerplate — but it's AI-drafted. Get real legal review before leaning on it at scale, especially given Standard-tier processes portraits and voice recordings (state biometric-privacy statutes may apply depending on customer location). |
| Premium/HeyGen backend | ~85% | Real lifecycle, has produced one real live render. Missing: the formal P0 production-receipt proof. |
| Standard/SadTalker backend | ~85% | Narration/consent/quote pipeline is real, tested, and correct. Real RunPod GPU inference code is merged and tested, but **SIMULATION is still the default** (`VIDEO_OS_STANDARD_PROVIDER=simulation`) — flipping it to `runpod` in production needs real RunPod credentials and, per this project's execution-mode ladder, explicit owner authorization before it touches real spend. |
| Admin console | ~90% | All 4 phases (overview/diagnostics, manual resolution/quarantine, billing, video ops) built and tested, plus its own dedicated login. |
| Sign-in / auth | Sign-in itself ~95%, but **new accounts can't actually use the product** | All three consumer paths (Google, magic link, workspace password) and the separate admin path are correctly built, separated, and configured with real credentials in production. But two launch-blocking gaps sit right behind sign-in — see "Audit findings" #1 and #2 — that mean a brand-new customer who successfully signs in still can't render anything. Fix those before treating auth as "done." |
| Operational watchdog / alerting | 100% for the built scope | Stalled-job sweep + auto-recovery + email alerting all live in production. Slack alerting is wired but inactive (needs a real `WATCHDOG_SLACK_WEBHOOK_URL`). |
| Infra/deployment code | Code ~85%, proven live on a real box: **0%** | `deploy/` (VPS) scripts exist and pass tests but have never run against a real server. The Vercel path now has multiple real **production** deploys behind it (this session), which is meaningfully more proven than "preview deploy only." |
| Production launch readiness | ~15% | `docs/P0-RELEASE-GATE.md`'s 9-observation receipt has never been captured, for either tier, on any environment. This is the actual remaining gate to a real launch — everything else above it is now in reasonable shape. |
| Premium VFX/cinematic differentiation | ~15% | ffmpeg grain/LUT shipped and real. The bigger "premium package" (an original overlay/title kit, a licensed-clean asset library) is researched only, nothing built. |
| Non-HeyGen providers (Argil, Tavus, D-ID) | 0% | UI stubs only, `configured: false` in `lib/video-os-account.js`'s `PROVIDERS`. |

## Audit findings (full click-through of production + admin console, 2026-09-22)

A systematic audit against the original 2026-07-13 CEO brief's launch checklist, plus a live click-through of every reachable tab/button on `https://lux-video-os.vercel.app` and the local admin console. Most of the product genuinely works — sign-in (all three paths), anonymous-render blocking, the Standard/Premium tab switch, Identity Studio's full 5-step creation wizard with real validation, the Premium presenter/voice grid (18 real curated presenters, ~2,958 real voices, live HeyGen data), the quote/review step, My Videos' empty state, and `/welcome`/`/privacy`/`/terms` all checked out clean. These didn't:

1. **🔴 Launch-blocking: new sign-ups get 0 trial credits.** The landing page promises "Free trial credits included on sign-up," but a fresh Google sign-in verified in a real browser gets **0 credits** — every render costs 90 credits, so a brand-new real customer cannot create a single video. Look at `VIDEO_OS_TRIAL_CREDITS` (defaults to `0` in `api/video-os-lite/auth.js`'s google-callback handler if unset) and whatever grants trial credits on other sign-in paths — decide the real number and set it, or fix the promise on the landing page if trial credits aren't actually the plan.
2. **🔴 Launch-blocking: the containment gate locks every real Google customer out of Premium.** `requireRenderAccountAuthorization()` (`lib/video-os-security.js`) only allowlists one account ID via `VIDEO_OS_RENDER_ACCOUNT_ID` — a deliberate pre-launch safety gate. It made sense while Google sign-in was in Testing mode; now that it's published for real customers, anyone who actually signs in via Google gets a flat `403` on HeyGen talent (`api/video-os/talent.js`) and can't use Premium at all. Either widen this gate's intent (a real allowlist/entitlement model) before real customers arrive, or knowingly keep Google sign-in soft-launched and communicate that.
3. ~~**AI Copywriter has no backend anywhere.**~~ **Fixed.** `routes/video-os-lite/copywriter.js` (via `services/copywriter.js`) now backs `/api/video-os-lite/copywriter` for real, routed through `workspace.js` and `vercel.json` like the other consolidated endpoints. Generation runs through the Vercel AI Gateway (`generateText` from the `ai` package, model configurable via `VIDEO_OS_COPYWRITER_MODEL`, default `anthropic/claude-sonnet-4.6`) -- no separate provider SDK or account needed. Per-account rate limiting reuses the previously-unused `rate_limits` table via `db/repositories.js`'s `consumeRateLimit`, no migration required. Requires `AI_GATEWAY_API_KEY` in production to report `ready` instead of `setup_required` -- not yet set (see "Credentials you'll need to obtain").
4. **Standard tier's submit button reads "Sign in to submit Standard" even when genuinely signed in.** `public/studio.js:704` sets the label from `state.signedIn`, which is stale/desynced on this particular render path — confirmed reproducible, not a timing fluke. Premium's equivalent button doesn't have this bug (correctly reads "Create Premium video" when signed in), so this is Standard-specific — compare the two code paths.
5. **"Compare tiers" dialog shows stale, actively-wrong copy.** `showTierComparison()` (`public/studio.js:304`) says "Standard live rendering is not available yet" — no longer true, and actively discourages customers from using a tier that works. Update the copy.
6. **`/dashboard` is live on the real production domain, gated by a hardcoded `1111` access code in plain-text JS** (`public/app.js:3`, `const gateCode = '1111'`), and once "unlocked" shows a completely disconnected legacy prototype UI (`public/app.js`/`dashboard.html`) that labels itself "Hosted MVP Mode" and isn't wired to the real database at all — it was the original Python-era operator cockpit, never removed. Either genuinely secure and reconnect it, or take it down before anyone finds it by guessing four digits.
7. **Admin console has no sign-out button anywhere.** Confirmed by reading `public/admin-console.html`/`.js` — no sign-out wiring exists. An admin has to clear cookies manually to end a session.

Not fully testable without spending real money or having real render history to inspect: avatar/voice/script fidelity in a finished video, live processing-state transitions, and the leave/return/download recovery flow (all need a real paid render — deliberately not triggered during this audit).

## What's left, in priority order

1. **Fix the two launch-blocking bugs above** (trial credits, containment gate) — until these are fixed, a real new customer cannot use this product at all, regardless of how finished everything else is.
2. **Work through the rest of "Audit findings"** — the stale "Standard not available" copy was directly customer-facing (fixed). The AI Copywriter backend is now built (fixed) but needs a real `AI_GATEWAY_API_KEY` set in production before it reports `ready` instead of `setup_required`.
3. **Take `/dashboard`'s hardcoded-gate legacy prototype off production**, or secure and reconnect it for real — it's the single most embarrassing thing a curious visitor could stumble into right now.
4. **One real production proof run** — `docs/P0-RELEASE-GATE.md` is a hard, already-written gate: billing, hosted finishing, and launch stay blocked until one genuine paid render produces a full signed receipt (9 required observations, read the doc). Needs Ariel's explicit go-ahead; spends real money. Do this only after #1 and #2 above are fixed, or the proof run will fail on the same gates a real customer would hit.
5. **Get `/privacy` and `/terms` reviewed by a real lawyer**, not just this AI-drafted (if accurate) version — see "Current state by area."
6. **Prove `render-v2.js`'s actual render-POST dispatch at the HTTP layer** against a running workflow runtime — currently only proven at the repository level, not through the literal HTTP handler.
7. **Flip Standard tier to real RunPod inference in production** (currently SIMULATION by default) — needs real RunPod credentials and owner authorization per the execution-mode ladder (see "Governance"). GitHub issue #23's 6 remaining lower-severity findings (dead code path, a `0`→`null` data-loss edge case, an inefficient ~7MB payload checkpointed into workflow state, redundant double-decode, duplicated helper code, a CI trigger scoping gap) are worth cleaning up before or shortly after this, though none are launch-blocking.
8. **GitHub issue #29** — `vercel.json`'s `/exports` and `/uploads` static routes may be dead on both the Vercel and VPS paths. Not yet investigated.
9. **Exercise the VPS path** (`deploy/`) against an actual box for the first time — code exists and passes tests, never proven live.
10. **Non-HeyGen providers are stubs** — Argil, Tavus, D-ID.
11. **Add a real Slack webhook** for watchdog alerts if you want a second alert channel beyond email — the code path already exists (`WATCHDOG_SLACK_WEBHOOK_URL`), just needs a real incoming-webhook URL.
12. **Stale `DESIGN.md`** and the integrated-preview boundary proof (needs #9).

## Open product decisions (not engineering calls — ask Ariel)

- **Subscription tiers vs. one-time credit packs** — a better LTV lever than pay-as-you-go, if the business model calls for it. Not scoped.
- **White-label / per-client branding** — relevant only if this gets resold to agency clients rather than used directly by Ariel. Not scoped, everything is currently single-brand.

## Wish list — what would make this a better product, not just a finished one

In priority order, none of it scoped or built yet:

1. **Onboarding / first-run guidance** — the wizard is fine once you already know what "Standard" vs "Premium" means, but there's no explainer or example gallery for a brand-new signup.
2. Subscription tiers (see "Open product decisions").
3. White-label / per-client branding (see "Open product decisions").
4. A real-time/live admin dashboard — the admin console is currently manual-refresh only (no polling/websockets); combined with the new watchdog email alerts this is less urgent than it used to be, but still a gap for anyone actively monitoring.

## File & architecture map

```
api/video-os-lite/*.js      Serverless function handlers -- the actual routes referenced
api/video-os/talent.js      by vercel.json's "dest" values. Several handlers are fanned into
routes/video-os-lite/*.js   workspace.js/admin.js to stay under Vercel Hobby's serverless-
                             function-count budget (tests/foundation-contract.test.mjs pins
                             the exact count).

db/schema.js                 Drizzle table definitions.
db/repositories.js           The real business logic: reserveRender / claimWorkflowStart /
                             transitionJob / finalizeReadyJob / markJobFailedAndRelease /
                             listStalledActionableJobs / listStalledAmbiguousJobs (watchdog
                             queries) -- fully provider-agnostic, shared by Premium and Standard.
db/standard-narration-*.js   Standard-tier-specific schema/repository (consent, quote, narration
                             binding) -- everything else in repositories.js is reused unchanged.
db/dto.js                    Shapes DB records into API response payloads.
db/client.js                 Neon connection + assertDatabaseConfigured().

lib/video-os-account.js      Session cookies, magic-link tokens, sendMagicEmail.
lib/video-os-security.js     publicOrigin(), media-URL allowlisting, auth guards.
lib/video-os-notifications.js  sendRenderReadyEmail, sendWatchdogAlertEmail, postWatchdogAlertSlack.
lib/video-os-render-notify.js  notifyRenderReady, shared by both render workflows.
lib/video-os-watchdog.js     runWatchdogSweep() -- stalled-job recovery/alerting, see Tech stack.
lib/video-os-watchdog-notify.js  Composes and sends the watchdog's email/Slack summary.
lib/video-os-render-driver.js  driveJobSafely -- shared poll/finish/fail logic used by both the
                             watchdog and worker/render-worker.mjs's own poll loop.
lib/storage-drivers/         Vercel Blob vs local-filesystem private storage, swappable via
                             STORAGE_DRIVER.
lib/google-oauth.js          Google OAuth exchange/profile fetch.

services/heygen.js            The real Premium (HeyGen) client -- submit/poll/error-handling.
services/copywriter.js        AI Copywriter's Vercel AI Gateway client -- prompt building + generateText.
services/sadtalker-simulator.js  Standard-tier ffmpeg-only placeholder (no real GPU inference,
                             still the default -- see VIDEO_OS_STANDARD_PROVIDER).
services/sadtalker-runpod.js  Real RunPod client -- merged, not yet the default in production.
services/media-finisher.js    ffmpeg grain/LUT finishing for Premium.
services/hyperframes-finisher.js  Optional advanced composition path, disabled by default.

workflows/video-render.js     Premium render workflow (Vercel Workflow step functions).
workflows/standard-render.js  Standard render workflow -- branches on VIDEO_OS_STANDARD_PROVIDER.
worker/render-worker.mjs      VPS-hosting polling worker -- drives the same step functions
                             directly, for WORKFLOW_DISPATCH_MODE=poll. Also runs the watchdog
                             sweep on its own timer in that mode.
workers/sadtalker-runpod/     Dockerized RunPod worker image (Python) for real GPU inference.
server/index.js               Plain Node HTTP server for VPS hosting -- derives its entire
                             route table from vercel.json at startup, so it can't drift.

public/index.html+studio.*    The main authenticated app (sign in, create video, identities).
public/landing.html+landing.* The /welcome marketing page, plus shared .lp-* nav/footer chrome
                             reused by privacy.html and terms.html.
public/privacy.html           /privacy -- grounded in real data practices, not lawyer-reviewed.
public/terms.html             /terms -- same caveat.
public/admin-console.html+.*  /admin-console, with its own dedicated login form.
public/identity.html+.*       /identity, the Identity Studio.
public/copywriter.*           The AI Copywriter feature.
public/dashboard.html+app.js  A legacy "advanced cockpit" page, still routed, not part of the
                             main app's current design language -- check before building here.
public/lite.js, lite.css      Dead code. Nothing loads them. See "Known gotchas."

tests/*.test.mjs              Node --test backend suite (~260 tests).
tests/e2e/*.spec.js           Playwright frontend suite (~105 specs).
tests/*.py                    Legacy pytest suite -- partially tests dead code, see gotchas.
drizzle/                      SQL migrations + snapshots.
deploy/                       VPS deployment scaffolding (systemd, nginx, deploy.sh, env example).
docs/P0-RELEASE-GATE.md       The hard production-launch gate -- read before touching billing.
vercel.json                   THE route table. Read by real Vercel *and* by server/index.js at
                             startup (parsed directly from this file, not hand-duplicated).
```

## Credentials you'll need to obtain

Get the rest yourself or ask Ariel for the ones marked "(ask Ariel)":

| Service | Env var(s) | For | Status |
|---|---|---|---|
| RunPod | `VIDEO_OS_RUNPOD_ENDPOINT_ID`, `RUNPOD_API_KEY` | Real Standard-tier GPU inference (code merged, not yet the active default) | Not obtained yet |
| HeyGen | `HEYGEN_API_KEY` (ask Ariel for prod; dev doesn't need it for simulated/mocked test paths) | Premium tier | Set in production |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | AI Copywriter (`/api/video-os-lite/copywriter`) | Not obtained yet -- feature reports `setup_required` until this is set |
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_EXPECT_LIVEMODE`, `STRIPE_PRICE_ID_500/1000/2000` | Billing | Set in production |
| Resend | `RESEND_API_KEY`, `AUTH_FROM_EMAIL` | Magic-link email, render-complete email, watchdog alert email | Set in production |
| Google Cloud OAuth client | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in | **Set in production and published ("In production" status, not Testing)**. The Google Cloud project is `video-os-509400`, owned by the `ariel@luxmarketingcompany.com` Google account specifically — **not** `arielsmailbox@gmail.com`, which is a different account that happens to be Chrome's default signed-in profile on Ariel's machine. Always check which account is active before touching `console.cloud.google.com` for this project. The OAuth client is named "LUX Video OS production," redirect URI `https://lux-video-os.vercel.app/api/video-os-lite/google-callback`. If you ever regenerate the client secret: **copy or download it the moment it's shown** — Google's console only displays a newly-created secret once, and closing that dialog without copying it permanently hides it (you'd have to generate a new one and disable the old, harmless but avoidable). |
| Watchdog alert email | `WATCHDOG_ALERT_EMAIL` | Who gets the ops-alert email when the watchdog finds something | **Set in production** (Ariel's email) |
| Watchdog Slack webhook | `WATCHDOG_SLACK_WEBHOOK_URL` | Optional second alert channel | Not obtained yet |
| Workspace password | `VIDEO_OS_WORKSPACE_USERNAME`, `VIDEO_OS_WORKSPACE_PASSWORD` | Customer-facing password sign-in | Pick your own values, not a third-party credential |
| Admin password | `VIDEO_OS_ADMIN_USERNAME`, `VIDEO_OS_ADMIN_PASSWORD` | `/admin-console` sign-in — separate from workspace | Pick your own values |
| Neon Postgres | `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | Primary datastore | Dev credentials in `.env.local`; production has its own separate Neon project |
| Vercel Blob | `BLOB_READ_WRITE_TOKEN` | Private object storage | Dev token in `.env.local`; production has its own separate store |
| Hetzner or Hostinger | n/a (used manually to provision) | VPS hosting, if that path is chosen (ask Ariel) | Not obtained yet |

`deploy/video-os.env.example` has the complete list of every env var the app reads, with comments on what each gates.

**`.env.local` contains live (but non-production) credentials** — treat this package as sensitive from the moment you receive it, and don't commit `.env.local` to git (already gitignored). Any `VERCEL_OIDC_TOKEN` included is short-lived and almost certainly expired by the time you read this — run `vercel link` / `vercel env pull` for a fresh one if needed.

## Getting started

```bash
npm install
```

If `ffmpeg-static`'s binary doesn't download automatically (some npm configs block install scripts), run `node node_modules/ffmpeg-static/install.js` directly.

Run locally against the included dev database/storage:

```bash
node -r dotenv/config server/index.js dotenv_config_path=.env.local
```

Open `http://127.0.0.1:8080`. `/admin-console` needs its own admin credentials (see table above); `/identity` and rendering need sign-in (workspace password, magic-link, or Google, whichever you configure). Note: `/welcome` gating `/` is skipped automatically on `localhost`/`127.0.0.1`, so local dev still lands on the app shell directly like before.

Run the render worker daemon (needed for a render to actually complete once submitted, since this local run isn't on Vercel):

```bash
node -r dotenv/config worker/render-worker.mjs dotenv_config_path=.env.local
```

## Testing

```bash
node --test tests/*.test.mjs      # ~260 tests, most run live against the dev Neon DB/Blob store in .env.local
npx vitest run
npx playwright test               # frontend e2e, runs offline against a local static server
python -m pytest -q               # legacy Python contract checks (see Known Gotchas)
npm run check:imports
npm run scan:client-privacy
npm run workflow:validate
node tools/enforce-npm-audit.mjs  # replaces `npm audit` directly -- see its own comments
```

To run the Node test suite against the real dev DB/Blob store (recommended — many tests skip cleanly without it, but you'll want the real coverage):

```bash
node -r dotenv/config --test tests/*.test.mjs dotenv_config_path=.env.local
```

## Deployment

**This project does NOT auto-deploy from GitHub pushes.** Pushing to `main` updates the repo, nothing more — a real deploy is always a manual step. This tripped up "is X actually live" assumptions more than once; don't assume a merge means production changed.

**Vercel** (primary, live path): there are two Vercel projects under the `lux-3035s-projects` team —
- `lux-video-os` — the **real production** project, serving `https://lux-video-os.vercel.app`.
- `lux-video-os-rebuild` — a non-production sandbox, what this checkout is normally `vercel link`-ed to by default.

To deploy to real production: `vercel link --yes --project lux-video-os --scope lux-3035s-projects` (temporarily relinks this checkout), then `npm run build:production` to verify locally, then `vercel deploy --prod --yes`. **Relink back to `lux-video-os-rebuild` afterward** so this checkout's default state matches what everyone expects (`vercel link --yes --project lux-video-os-rebuild --scope lux-3035s-projects`) — don't leave a shared checkout pointed at the production project by accident. `.vercel/` and `.env*` are gitignored either way, so this never touches git.

`npm run build:preview` / `build:production` runs `vercel build`, then merges in routes from the `workflow` package, patches the build's `config.json`, and verifies function/workflow manifests. Deploy the *result* with `vercel deploy --prebuilt` (or plain `vercel deploy --prod`, which runs the build itself) — a bare `vercel deploy` that skips the build-then-deploy sequence above can produce an incomplete route table. Requires `WORKFLOW_DISPATCH_MODE` unset or `vercel` (the default). **Always verify with a real deploy after any `vercel.json` change** — the local dev server does not perfectly replicate Vercel's real static-file routing (see "Known gotchas").

**VPS** (untested on a real box yet): follow `deploy/deploy.sh` and the systemd/nginx configs in `deploy/`. Set `WORKFLOW_DISPATCH_MODE=poll` — without this, render dispatch silently falls back to an in-memory local queue not meant for production and will race the worker daemon.

## Governance — read before touching billing, real spend, or production

- `docs/P0-RELEASE-GATE.md` — the production launch gate (see "What's left" #1).
- This project uses an execution-mode ladder: **SIMULATION** (no real cost, current default for Standard-tier rendering) → **CANARY** (real, requires explicit owner authorization) → **PRODUCTION**. Never flip a real-money or real-provider-call code path live without Ariel's explicit go-ahead — he is "the owner" throughout this project's docs; product/security/spend decisions are owner-controlled, everything else is routine engineering.
- Publishing the Google OAuth consent screen, deploying to the real `lux-video-os` Vercel project, and adding new production env vars are all things that were done this session with Ariel's direct, explicit, in-the-moment approval each time — treat those as owner-controlled actions too, not routine engineering, even though the mechanics are simple.

## Known gotchas

- **`vercel build` flattens the entire `public/` directory to the output root** — there is no `public/` subdirectory in a real deployment. A `vercel.json` route with `dest: "/public/whatever.html"` will 404 on Vercel even though it works fine locally (`server/index.js`'s `staticFilePath()` deliberately strips a leading `/public/` before resolving against the real local `public/` directory, masking the mismatch). Write `dest` paths without the `/public/` prefix — GitHub issue #24 (the last known instance of this) is closed, but GitHub issue #29 asks whether `/exports` and `/uploads` still have a version of this problem; not yet investigated.
- **This project does not auto-deploy from GitHub.** See "Deployment" above — don't assume a merge is live.
- **Branch `git log` ancestry is not reliable for "is this merged into `main`?"** in this repo — diff the actual files against `main` directly if a branch's status is unclear (see "Repo & branch state").
- **`video_os_backend.py`** (repo root) is dead legacy Python code — a duplicate HeyGen client, completely disconnected from real routing. Don't build on it.
- **`public/lite.js` and `public/lite.css` are dead code.** No HTML page loads them (`public/index.html` loads `public/studio.js`) — an earlier frontend generation left in the tree. Several Python tests in `tests/test_public_rendering_contract.py` still check `lite.js`/`lite.css` content, which means they're not actually protecting the live frontend.
- **`npm install`/`npm ci` may block postinstall scripts** on some machines' npm config (`ffmpeg-static`'s binary download, in particular). If a test fails with `ENOENT` for an ffmpeg path, run `node node_modules/ffmpeg-static/install.js` directly.
- **CodeQL and `npm audit` both have small, explicit, commented exception lists** (`tools/enforce-codeql-sarif.mjs`'s `ALLOWED_FINDINGS`, `tools/enforce-npm-audit.mjs`'s `ACCEPTED_ADVISORIES`). Read the comments before assuming either gate is naive.
- GitHub's inline `codeql[rule-id]` suppression comments **do not work in this repo's CI** (`.github/workflows/codeql.yml` sets `upload: never`) — extend the allowlist in `tools/enforce-codeql-sarif.mjs` instead.
- **A real Vercel production build still prints a benign esbuild warning** about Node.js builtins being reachable in the Workflow bundle ("These will fail at runtime in the workflow sandbox"). This looks alarming but is expected/tolerated at the current state — the specific functions that actually need it already have `'use step'` directives; the warning is about the underlying `import` statements still being visible to the bundler's static analysis, not an actual runtime failure. Don't treat this warning alone as a regression.

## Project history (why this doesn't look like a from-scratch build)

The short version: an earlier developer sent frontend and backend handoff zips on 2026-09-18. The backend package turned out to be built on a git commit that never existed in this GitHub repo (verified via `git bundle verify` and a direct GitHub API lookup) — recovery was attempted and never landed, so by the owner's explicit call, the Standard-tier backend was rebuilt from scratch using that developer's own architecture/delivery-plan docs as the spec, not their code as the base. The frontend package's actual files *were* applied as real commits (they didn't exist in git at all before that). Net effect: the finished product matches what was asked for, but very little of the backend is literally that original code.

Since then: the Standard-tier narration/consent/quote pipeline, a VPS hosting layer, a full 4-phase admin console, real Premium cinematic finishing, a public `/welcome` landing page, render-complete email notifications, a redesigned sign-in flow with admin login properly separated out, real RunPod-based GPU inference for Standard (merged, not yet the active default), an operational watchdog with real email alerting, and — as of this update — Google sign-in fully configured and published to production, `/welcome` confirmed live as the actual front door for `/`, and real `/privacy` and `/terms` pages built and linked from the OAuth consent screen.
