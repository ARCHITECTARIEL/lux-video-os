# LUX Video OS — Developer Handoff (2026-09-21)

Read this first. The root `README.md` is stale (describes an old Python-based version of this app) — ignore it. This document is the real, current source of truth. It's organized by *topic*, not by session — if you want the blow-by-blow history of how this codebase got here, see "Project history" near the bottom; everything above that is simply "what's true right now."

## TL;DR

- **What it is**: an owner-facing AI video studio. Sign in, pick or create an authorized on-camera identity, submit a **Standard** (portrait photo + your own uploaded narration) or **Premium** (HeyGen presenter + cloned voice + script) video request, get a credit quote, render asynchronously, download only accepted output.
- **How far along**: **~65-70% built, 0% launched.** Nothing has ever been deployed to production, and no real paid render has produced the required launch-gate receipt. See "Current state by area" below for the honest per-area breakdown.
- **Where the code is**: GitHub repo (private) `ARCHITECTARIEL/lux-video-os`. `main` is at `3c70eb9`. This session's completed work is on `integration/session-2026-09-20` (6 commits, all tested, **PR #25 open against `main`, not yet merged** — review and merge that first). A second developer/agent has an *unmerged* branch, `codex/runpod-standard-adapter`, adding real GPU inference for Standard — see "In-flight work from another branch" below before touching that area.
- **Single biggest engineering gap**: no real GPU inference for the Standard tier yet (in progress on the branch above, not merged, has a known bug — see issue #23).
- **Immediate next steps**, in order: (1) review and merge PR #25, (2) fix the credit-release race in issue #23 before merging the RunPod branch, (3) finish the Vercel routing cleanup in issue #24, (4) pick up the operational watchdog or onboarding from the wish list.

## Tech stack

- **Frontend**: no framework — plain HTML/CSS/JS served as static files from `public/`. One shared design system (`public/studio.css`, custom CSS variables, no Tailwind/Bootstrap/etc.) used across every screen. `public/studio.js` is the main app's logic (~2,200 lines, vanilla DOM manipulation, no React/Vue).
- **Backend**: Vercel serverless functions (Node.js, ES modules). Routing is **not** Vercel's zero-config file-based routing — it's a legacy `vercel.json` `"routes"` array (`src`/`dest` regex pairs) that both real Vercel *and* a custom Node HTTP server (`server/index.js`, for VPS hosting) parse and execute identically, so the route table can't drift between the two hosting paths.
- **Database**: Postgres via **Neon** (serverless driver, `@neondatabase/serverless`), **Drizzle ORM** (`drizzle-orm` + `drizzle-kit`, schema in `db/schema.js`, migrations in `drizzle/`).
- **Object storage**: **Vercel Blob** for private media (portraits, narration audio, finished videos), behind a swappable driver interface (`lib/storage-drivers/`) — `STORAGE_DRIVER=fs` switches to local-disk storage for the VPS hosting path.
- **Async orchestration**: the **`workflow`** npm package (Vercel Workflow — durable step functions) for render dispatch on Vercel, with a hand-rolled polling worker daemon (`worker/render-worker.mjs`) that drives the *same* step functions directly for the VPS path (`WORKFLOW_DISPATCH_MODE=poll`).
- **Auth**: custom HMAC-signed session cookies (`lib/video-os-account.js`), three sign-in paths — Google OAuth (`lib/google-oauth.js`), magic-link email (via **Resend**), and workspace username/password. A completely separate admin cookie/login gates `/admin-console` only.
- **Render providers**: **HeyGen** (Premium tier — real, live, has produced a real render) via `services/heygen.js`. Standard tier currently uses `services/sadtalker-simulator.js`, an ffmpeg-only placeholder (composites the real portrait + audio into a real MP4, but does **no actual lip-sync inference** — see "Current state by area"). Real GPU inference (RunPod-based) is in progress on an unmerged branch.
- **Billing**: **Stripe** (Checkout Sessions + webhooks, `api/video-os-lite/checkout-v2.js` / `stripe-webhook-v2.js`).
- **Email**: **Resend** (magic-link sign-in, and this session's new render-complete notification).
- **Observability**: **Sentry** (`@sentry/node`), gated on `SENTRY_DSN` being set.
- **Video finishing**: ffmpeg (via `ffmpeg-static`) for Premium's film-grain/LUT color grading; an optional, disabled-by-default HyperFrames/Remotion path for a more advanced composition (`media/hyperframes/`).
- **Testing**: Node's built-in test runner (`node --test`, ~251 tests, most run live against the real dev Neon DB/Blob store — not mocks) for backend logic; **Playwright** (~105 specs) for frontend e2e, offline against a local static server; **Vitest** for one small validation suite; a **legacy pytest suite** (`tests/test_public_rendering_contract.py`) that partially tests dead frontend code — see "Known gotchas."
- **CI**: GitHub Actions (`.github/workflows/`) — a main CI workflow plus two custom gates: a CodeQL SARIF allowlist and a documented-exception `npm audit` gate (both explained in "Known gotchas").
- **Deployment targets**: **Vercel** (primary, historical path) or a **self-hosted VPS** (Hetzner/Hostinger-style — `deploy/` has systemd units, nginx config, and a deploy script). Neither has been exercised against a real production box; Vercel has now had a real *preview* deploy (this session), which is how several routing bugs got found — see "Known gotchas."

## Repo & branch state

| Branch | State | What's on it |
|---|---|---|
| `main` | `3c70eb9` | Everything through the 2026-09-19 session (frontend rebuild, Standard-tier backend rebuild, VPS hosting layer, Google sign-in, admin console, cinematic finishing, `/welcome` landing page skeleton). |
| `integration/session-2026-09-20` | 6 commits ahead of `main`, **PR #25 open, not merged** | This session's work — see "What's new" below. Fully tested (251 Node, 104 Playwright, 46 Python, all green). |
| `codex/runpod-standard-adapter` | 4 commits ahead of `main`, no PR | Another developer/agent's in-progress work: real RunPod-based GPU inference for Standard. **Reviewed, not merged, not modified.** Has a real correctness bug — see "In-flight work from another branch" below and GitHub issue #23 before merging it. |

Clone the real repo — don't work from a zip; a zip has no `.git` history and both branches above keep moving. Ask Ariel to add you as a collaborator if you don't have access.

## What's new this session (`integration/session-2026-09-20`, PR #25)

Six pieces of work, all independently tested and merged together (no file overlap between them):

1. **"Your video is ready" email notification** — `lib/video-os-notifications.js` + `lib/video-os-render-notify.js`, wired into both render workflows right after the job settles. Fires exactly once per job (idempotent across workflow-step retries via an additive `justCompleted` flag on `finalizeReadyJob`'s return), and a broken email provider is captured via Sentry and swallowed — never fails an already-finished render.
2. **`/welcome` landing page — brand accuracy, plus two real bugs found and fixed.** Retinted the hero shader and every button/accent to the actual LUX brand palette (was an unrelated invented blue). Rebuilt the shader itself from a glossy "liquid silk" specular-lit look into a diffuse volumetric mist with a periodic ripple, full-viewport height on both mobile and desktop, per direct product feedback. Redesigned the tracked-ALL-CAPS section labels into a chrome-tick + sentence-case device. **Found and fixed a real layout bug**: `<main>` was silently inheriting the authenticated app shell's sidebar-aware CSS (`margin-left: 232px`) even though this page has no sidebar — it had never actually been full-width or centered. **Found and fixed a real deployment bug** (see #6 below).
3. **Sign-in modal redesign.** The modal had **zero custom CSS anywhere** — the LUX wordmark, the Sign In/Sign Up toggle, and the Google button were all rendering off bare browser/generic `.button` defaults. Added a branded gradient header, a real segmented toggle, a properly-branded Google button (real 4-color "G" mark, standard OAuth button convention), and clearer visual grouping. No interactive behavior, hidden-state logic, or DOM order changed — the exact tab-order focus-trap test still passes unmodified.
4. **Moved admin/owner login off the customer-facing sign-in modal.** Previously, the *only* way to reach `/admin-console` was an "Owner" option inside the main consumer sign-in modal, which also silently minted the admin cookie as a side effect of the same endpoint a customer uses. Per direct product decision: the consumer `password-login` endpoint can no longer grant admin access at all (the request body's claimed access type is never read); `/admin-console` now has its own real login form, wired to `action=admin-login` (which already existed server-side but had no UI calling it).
5. **Renamed "Demo" to "Workspace" throughout the password-login path** — leftover MVP-era naming that stopped making sense once "Owner" moved off the same path (item 4). `VIDEO_OS_DEMO_*` env vars → `VIDEO_OS_WORKSPACE_*`, account role `'demo'` → `'workspace'`, display name "LUX Demo" → "LUX Workspace". **If you have `VIDEO_OS_DEMO_*` set anywhere (a deployed environment, a password manager), rename it — the old names are no longer read.**
6. **Two real Vercel-deployment routing bugs found and (partially) fixed.** `vercel build` flattens the entire `public/` directory to the output root — confirmed directly by inspecting `.vercel/output/static/`. Several `vercel.json` routes still pointed their `dest` at a stale `/public/`-prefixed path that doesn't exist in that flattened output, so they 404'd on a **real** Vercel deployment despite working fine against the local dev server (which resolves `dest` paths differently). `/welcome`, `/dashboard`, and `/admin-console` are fixed and confirmed live. **Still open** (see GitHub issue #24): the extension-catchall and final `index.html`-catchall routes have the same stale prefix — not visibly broken yet (requests happen to fall through to a filesystem-handle phase that serves the right file anyway), but not a *correct* route either.

**Sobering finding worth internalizing**: nothing in this repo had ever been proven to deploy correctly on Vercel before this session — only against the local dev server, which does not perfectly replicate Vercel's real static-file routing. Do a real `vercel deploy --prebuilt` (not just `npm run build:preview` locally) as a standard step before calling any `vercel.json` change "done."

Verified on `integration/session-2026-09-20`: full Node suite 251/251, Vitest 4/4, Playwright 104/105 (1 pre-existing unrelated skip), Python contract suite 46/47 (1 pre-existing unrelated skip), `check:imports` and `scan:client-privacy` clean, plus a live Vercel preview deploy with every route (`/`, `/welcome`, `/dashboard`, `/admin-console`, `/identity`) confirmed 200, and live in-browser verification of the workspace and admin sign-in flows end to end.

## In-flight work from another branch: `codex/runpod-standard-adapter`

Not part of this session's work, not merged, **not modified** — reviewed only. Adds a real `services/sadtalker-runpod.js` client and a Dockerized RunPod worker (`workers/sadtalker-runpod/`) for actual GPU inference on the Standard tier, replacing the ffmpeg simulator. This is the single biggest step toward closing the project's #1 remaining engineering gap.

**Before merging it**, read **GitHub issue #23**. The most important finding: a concurrent-submission race in `workflows/standard-render.js` can mark a job `failed` and release its reserved credits while the render may genuinely still be in flight on RunPod — the exact duplicate-charge/lost-render scenario the surrounding code comment claims to prevent. Six lower-severity findings are also filed there (dead code path, a `0`-coerced-to-`null` data-loss edge case, a ~7MB payload checkpointed into Workflow step state on every render, redundant double-decode of that payload, code duplicated from the simulator instead of shared, a CI trigger scoping gap).

## Current state by area

| Area | % done | Why |
|---|---|---|
| Frontend (main app) | ~95% | Fully built, well-tested. Only real gap: never proven against a fully-configured *live* deployment (all sign-in providers configured, a real render completing end to end on Vercel). |
| Landing page (`/welcome`) | ~90% | Built, brand-accurate, tested, deployed and verified live. Doesn't gate `/` yet (deliberate — see "Open product decisions"). |
| Premium/HeyGen backend | ~85% | Real lifecycle, has produced one real live render. Missing: the formal P0 production-receipt proof, an operational watchdog. |
| Standard/SadTalker backend | ~55-60% | Narration/consent/quote pipeline is real, tested, and correct. Real GPU inference exists on an unmerged branch with one bug to fix first (issue #23) — up from "doesn't exist at all" as of two sessions ago. |
| Admin console | ~90% | All 4 phases (overview/diagnostics, manual resolution/quarantine, billing, video ops) built and tested, plus its own dedicated login this session. Missing: an automated watchdog — a stalled job currently only surfaces via a human checking the "Needs attention" tab. |
| Sign-in / auth | ~90% | All three consumer paths (Google, magic link, workspace password) and the separate admin path are correctly built and separated. Gap is entirely credentials: Google and Resend need real values from Ariel to actually work anywhere (see "Credentials you'll need"). |
| Infra/deployment code | Code ~85%, proven live on a real box: **0%** | `deploy/` (VPS) scripts exist and pass tests but have never run against a real server. The Vercel path has now had real preview deploys (this session) — closer to trustworthy than before, but still not a production deploy. |
| Production launch readiness | ~10% | `docs/P0-RELEASE-GATE.md`'s 9-observation receipt has never been captured, for either tier, on any environment. |
| Premium VFX/cinematic differentiation | ~15% | ffmpeg grain/LUT shipped and real. The bigger "premium package" (an original overlay/title kit, a licensed-clean asset library) is researched only, nothing built. |
| Non-HeyGen providers (Argil, Tavus, D-ID) | 0% | UI stubs only, `configured: false` in `lib/video-os-account.js`'s `PROVIDERS`. |

## What's left, in priority order

1. **Merge the RunPod branch, after fixing issue #23's credit-release race.** This closes the single biggest remaining engineering gap (real Standard-tier GPU inference).
2. **Finish the Vercel routing cleanup** — GitHub issue #24, the extension-catchall and index.html-catchall routes.
3. **Prove `render-v2.js`'s actual render-POST dispatch at the HTTP layer** against a running workflow runtime — currently only proven at the repository level, not through the literal HTTP handler.
4. **Operational recovery/supervision (the watchdog)** — doesn't exist for either render tier. Both a reliability fix and a trust feature (silent failure is the worst failure mode for a paying customer). Also wish-list item #1 below.
5. **One real production proof run** — `docs/P0-RELEASE-GATE.md` is a hard, already-written gate: billing, hosted finishing, and launch stay blocked until one genuine paid render produces a full signed receipt (9 required observations, read the doc). Needs a live deployment and Ariel's explicit go-ahead; spends real money.
6. **Deploy somewhere real** — a production Vercel deploy, or exercise the VPS path (`deploy/`) against an actual box for the first time.
7. **Non-HeyGen providers are stubs** — Argil, Tavus, D-ID.
8. **Stale `DESIGN.md`** and the integrated-preview boundary proof (needs #6).

## Open product decisions (not engineering calls — ask Ariel)

- **Should `/welcome` gate `/`?** Right now an anonymous visitor can still reach the signed-out app shell directly at `/`. Wiring `/welcome` as an enforced front door changes the entry funnel — worth a product call, not a drive-by change.
- **Subscription tiers vs. one-time credit packs** — a better LTV lever than pay-as-you-go, if the business model calls for it. Not scoped.
- **White-label / per-client branding** — relevant only if this gets resold to agency clients rather than used directly by Ariel. Not scoped, everything is currently single-brand.

## Wish list — what would make this a better product, not just a finished one

In priority order, none of it scoped or built yet:

1. **The operational watchdog** (also "What's left" #4).
2. **Onboarding / first-run guidance** — the wizard is fine once you already know what "Standard" vs "Premium" means, but there's no explainer or example gallery for a brand-new signup.
3. Subscription tiers (see "Open product decisions").
4. White-label / per-client branding (see "Open product decisions").

## File & architecture map

```
api/video-os-lite/*.js      Serverless function handlers -- the actual routes referenced
api/video-os/talent.js      by vercel.json's "dest" values. Several handlers are fanned into
routes/video-os-lite/*.js   workspace.js/admin.js to stay under Vercel Hobby's serverless-
                             function-count budget (tests/foundation-contract.test.mjs pins
                             the exact count).

db/schema.js                 Drizzle table definitions.
db/repositories.js           The real business logic: reserveRender / claimWorkflowStart /
                             transitionJob / finalizeReadyJob / markJobFailedAndRelease --
                             fully provider-agnostic, shared by Premium and Standard.
db/standard-narration-*.js   Standard-tier-specific schema/repository (consent, quote, narration
                             binding) -- everything else in repositories.js is reused unchanged.
db/dto.js                    Shapes DB records into API response payloads.
db/client.js                 Neon connection + assertDatabaseConfigured().

lib/video-os-account.js      Session cookies, magic-link tokens, sendMagicEmail.
lib/video-os-security.js     publicOrigin(), media-URL allowlisting, auth guards.
lib/video-os-notifications.js  sendRenderReadyEmail (this session).
lib/video-os-render-notify.js  notifyRenderReady, shared by both render workflows (this session).
lib/storage-drivers/         Vercel Blob vs local-filesystem private storage, swappable via
                             STORAGE_DRIVER.
lib/google-oauth.js          Google OAuth exchange/profile fetch.

services/heygen.js            The real Premium (HeyGen) client -- submit/poll/error-handling.
services/sadtalker-simulator.js  Standard-tier ffmpeg-only placeholder (no real GPU inference).
services/sadtalker-runpod.js  Real RunPod client -- unmerged branch, see "In-flight work" above.
services/media-finisher.js    ffmpeg grain/LUT finishing for Premium.
services/hyperframes-finisher.js  Optional advanced composition path, disabled by default.

workflows/video-render.js     Premium render workflow (Vercel Workflow step functions).
workflows/standard-render.js  Standard render workflow.
worker/render-worker.mjs      VPS-hosting polling worker -- drives the same step functions
                             directly, for WORKFLOW_DISPATCH_MODE=poll.
server/index.js               Plain Node HTTP server for VPS hosting -- derives its entire
                             route table from vercel.json at startup, so it can't drift.

public/index.html+studio.*    The main authenticated app (sign in, create video, identities).
public/landing.html+landing.* The /welcome marketing page (this session's brand work).
public/admin-console.html+.*  /admin-console (this session added its own login form).
public/identity.html+.*       /identity, the Identity Studio.
public/copywriter.*           The AI Copywriter feature.
public/dashboard.html+app.js  A legacy "advanced cockpit" page, still routed, not part of the
                             main app's current design language -- check before building here.
public/lite.js, lite.css      Dead code. Nothing loads them. See "Known gotchas."

tests/*.test.mjs              Node --test backend suite (~251 tests).
tests/e2e/*.spec.js           Playwright frontend suite (~105 specs).
tests/*.py                    Legacy pytest suite -- partially tests dead code, see gotchas.
drizzle/                      SQL migrations + snapshots.
deploy/                       VPS deployment scaffolding (systemd, nginx, deploy.sh, env example).
docs/P0-RELEASE-GATE.md       The hard production-launch gate -- read before touching billing.
vercel.json                   THE route table. Read by real Vercel *and* by server/index.js at
                             startup (parsed directly from this file, not hand-duplicated).
```

## Credentials you'll need to obtain

None of these are in this handoff except where marked. Get the rest yourself or ask Ariel for the ones marked "(ask Ariel)":

| Service | Env var(s) | For |
|---|---|---|
| GPU inference (RunPod, per the in-progress branch) | none yet — new integration, see "In-flight work" above | Real Standard-tier rendering |
| HeyGen | `HEYGEN_API_KEY` (ask Ariel for prod; dev doesn't need it for simulated/mocked test paths) | Premium tier |
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_EXPECT_LIVEMODE`, `STRIPE_PRICE_ID_500/1000/2000` | Billing |
| Resend | `RESEND_API_KEY`, `AUTH_FROM_EMAIL` | Magic-link email delivery, and this session's render-complete email |
| Google Cloud OAuth client | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in (ask Ariel — already set up, just needs adding to whatever environment you're using) |
| Workspace password | `VIDEO_OS_WORKSPACE_USERNAME`, `VIDEO_OS_WORKSPACE_PASSWORD` | Customer-facing password sign-in (renamed from `VIDEO_OS_DEMO_*` this session) — pick your own values, not a third-party credential |
| Admin password | `VIDEO_OS_ADMIN_USERNAME`, `VIDEO_OS_ADMIN_PASSWORD` | `/admin-console` sign-in — separate from workspace, pick your own values |
| Neon Postgres | `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | Primary datastore — **dev credentials already in `.env.local` in this package**, pointing at a non-production Neon project (`lux-video-os-dev`) |
| Vercel Blob | `BLOB_READ_WRITE_TOKEN` | Private object storage — **dev token already in `.env.local`**, non-production store |
| Hetzner or Hostinger | n/a (used manually to provision) | VPS hosting, if that path is chosen (ask Ariel) |

`deploy/video-os.env.example` has the complete list of every env var the app reads, with comments on what each gates.

**`.env.local` contains live (but non-production) credentials — treat this package as sensitive from the moment you receive it, and don't commit `.env.local` to git (already gitignored).** Any `VERCEL_OIDC_TOKEN` included is short-lived and almost certainly expired by the time you read this — run `vercel link` / `vercel env pull` for a fresh one if needed. **Neither the workspace nor admin password is included** — this machine's local values were self-generated for testing, not shared credentials; pick your own and add them to `.env.local` and to Vercel's env (`vercel env add`) separately.

## Getting started

```bash
npm install
```

If `ffmpeg-static`'s binary doesn't download automatically (some npm configs block install scripts), run `node node_modules/ffmpeg-static/install.js` directly.

Run locally against the included dev database/storage:

```bash
node -r dotenv/config server/index.js dotenv_config_path=.env.local
```

Open `http://127.0.0.1:8080`. `/admin-console` needs its own admin credentials (see table above); `/identity` and rendering need sign-in (workspace password, magic-link, or Google, whichever you configure).

Run the render worker daemon (needed for a render to actually complete once submitted, since this local run isn't on Vercel):

```bash
node -r dotenv/config worker/render-worker.mjs dotenv_config_path=.env.local
```

## Testing

```bash
node --test tests/*.test.mjs      # ~251 tests, most run live against the dev Neon DB/Blob store in .env.local
npx vitest run
npx playwright test               # frontend e2e, runs offline against a local static server
python -m pytest -q               # legacy Python contract checks (see Known Gotchas)
npm run check:imports
npm run scan:client-privacy
npm run workflow:validate
node tools/enforce-npm-audit.mjs  # replaces `npm audit` directly — see its own comments
```

To run the Node test suite against the real dev DB/Blob store (recommended — many tests skip cleanly without it, but you'll want the real coverage):

```bash
node -r dotenv/config --test tests/*.test.mjs dotenv_config_path=.env.local
```

## Deployment

**Vercel** (primary path): `npm run build:preview` (or `build:production`) — this runs `vercel build`, then merges in routes from the `workflow` package, patches the build's `config.json`, and verifies function/workflow manifests. Deploy the *result* with `vercel deploy --prebuilt`, not a bare `vercel deploy` (a bare deploy skips that merge step and produces an incomplete route table). Requires `WORKFLOW_DISPATCH_MODE` unset or `vercel` (the default). **Always verify with a real preview deploy after any `vercel.json` change** — see "Known gotchas," the local dev server does not catch this class of routing bug.

**VPS** (untested on a real box yet): follow `deploy/deploy.sh` and the systemd/nginx configs in `deploy/`. Set `WORKFLOW_DISPATCH_MODE=poll` — without this, render dispatch silently falls back to an in-memory local queue not meant for production and will race the worker daemon.

## Governance — read before touching billing, real spend, or production

- `docs/P0-RELEASE-GATE.md` — the production launch gate (see "What's left" #5).
- This project uses an execution-mode ladder: **SIMULATION** (no real cost, current default for Standard-tier rendering) → **CANARY** (real, requires explicit owner authorization) → **PRODUCTION**. Never flip a real-money or real-provider-call code path live without Ariel's explicit go-ahead — he is "the owner" throughout this project's docs; product/security/spend decisions are owner-controlled, everything else is routine engineering.

## Known gotchas

- **`vercel build` flattens the entire `public/` directory to the output root** — there is no `public/` subdirectory in a real deployment. A `vercel.json` route with `dest: "/public/whatever.html"` will 404 on Vercel even though it works fine locally (`server/index.js`'s `staticFilePath()` deliberately strips a leading `/public/` before resolving against the real local `public/` directory, masking the mismatch). Write `dest` paths without the `/public/` prefix, matching how `/identity`, `/welcome`, `/dashboard`, and `/admin-console` are now written. See GitHub issue #24 for what's still unfixed.
- **`video_os_backend.py`** (repo root) is dead legacy Python code — a duplicate HeyGen client, completely disconnected from real routing. Don't build on it. Left in place because removing it also touches the legacy `tests/test_public_rendering_contract.py` suite (below) — worth a dedicated cleanup pass, not a drive-by deletion.
- **`public/lite.js` and `public/lite.css` are dead code.** No HTML page loads them (`public/index.html` loads `public/studio.js`) — an earlier frontend generation left in the tree. Several Python tests in `tests/test_public_rendering_contract.py` still check `lite.js`/`lite.css` content, which means they're not actually protecting the live frontend.
- **`npm install`/`npm ci` may block postinstall scripts** on some machines' npm config (`ffmpeg-static`'s binary download, in particular). If a test fails with `ENOENT` for an ffmpeg path, run `node node_modules/ffmpeg-static/install.js` directly.
- **CodeQL and `npm audit` both have small, explicit, commented exception lists** (`tools/enforce-codeql-sarif.mjs`'s `ALLOWED_FINDINGS`, `tools/enforce-npm-audit.mjs`'s `ACCEPTED_ADVISORIES`). Read the comments before assuming either gate is naive — both document exactly why each exception is safe, and both still fail hard on anything not explicitly listed.
- GitHub's inline `codeql[rule-id]` suppression comments **do not work in this repo's CI** (`.github/workflows/codeql.yml` sets `upload: never`) — extend the allowlist in `tools/enforce-codeql-sarif.mjs` instead.
- **`#auth-workspace-toggle`-shaped UI is gone**, but if you're reading old code/docs: the consumer sign-in modal used to have a button that claimed to reveal "workspace credentials" but didn't actually show/hide anything — it just flipped a Demo/Owner radio. Both the radio and the button were removed this session along with the Owner option; don't reintroduce that pattern.

## Project history (why this doesn't look like a from-scratch build)

The short version: an earlier developer sent frontend and backend handoff zips on 2026-09-18. The backend package turned out to be built on a git commit that never existed in this GitHub repo (verified via `git bundle verify` and a direct GitHub API lookup) — recovery was attempted and never landed, so by the owner's explicit call, the Standard-tier backend was rebuilt from scratch using that developer's own architecture/delivery-plan docs as the spec, not their code as the base. The frontend package's actual files *were* applied as real commits (they didn't exist in git at all before that). Net effect: the finished product matches what was asked for, but very little of the backend is literally that original code.

Since then (through this session): the Standard-tier narration/consent/quote pipeline, a VPS hosting layer, Google sign-in, a full 4-phase admin console, real Premium cinematic finishing, a public `/welcome` landing page, render-complete email notifications, a redesigned sign-in flow with admin login properly separated out, and (on an unmerged branch) real RunPod-based GPU inference for Standard.
