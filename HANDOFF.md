# LUX Video OS — Developer Handoff (2026-09-19, rev. 2)

Read this first. The root `README.md` is stale (describes an old Python-based version of this app) and should not be trusted for architecture or setup. **If you're the developer who sent the original frontend and backend handoff zips on 2026-09-18: this doc is written for you specifically** — it explains what happened to your two packages, what changed, and what's genuinely new since you last touched this.

## Why this doesn't look like a direct continuation of your branches

Your backend package was built on top of a base commit (`bfb0f8c...`) that turned out not to exist anywhere in `ARCHITECTARIEL/lux-video-os` on GitHub — verified with `git bundle verify` against a fresh clone and a direct GitHub API lookup, both came back negative. Recovery was attempted (asked for a push from the machine that might still have it) but never landed. Ariel's call: stop waiting, rebuild what's missing from your spec/architecture docs instead. So:

- **Your frontend package's actual file contents were applied as real commits** on top of the true (and, it turned out, ~6-weeks-stale) `main` — your `studio.js`, `copywriter.js`, `standard-contract.js` etc. didn't exist in git at all before that.
- **Your backend package's code could not be reused** (the git history gap meant almost none of it survived intact) — the Standard tier was rebuilt from scratch, using your `ARCHITECTURE.md`/`DELIVERY_PLAN.md`/`AUDIT.md` as the spec, not your code as the base. Details below.

Net effect: the finished product matches what you were both asked to build, but very little of the backend is literally your original code, and the frontend integration points (esp. Standard tier submission) had to be re-verified against the rebuilt backend rather than your original one.

## What this is

LUX Video OS is an owner-facing AI video studio: sign in, pick or create an authorized on-camera identity, submit a **Standard** (portrait photo + uploaded narration WAV) or **Premium** (HeyGen presenter + voice + script) video request, get a credit quote, render asynchronously, and download only accepted output.

- GitHub repo (private): `ARCHITECTARIEL/lux-video-os`, branch `main`, currently at `095ac48`. Ask Ariel to add you as a collaborator if you don't have access yet — clone the real repo rather than working from a zip; a zip has no `.git` history and `main` keeps moving.

## Part 1 — what closed out of your frontend package

Every item below maps to a specific finding in your own `FRONTEND-AUDIT.md`:

- **Auth modal dead controls** (your finding: Sign In/Sign Up toggle, credential-type toggle, and Show-password had no handlers, plus a broken focus trap) — **fixed**, with the focus-restoration behavior your audit specifically called out.
- **Standard price auto-submit** (your finding: a quote was fetched then submitted immediately with no owner confirmation step) — **fixed**: there's now an explicit confirmation dialog between quote and submit.
- **Identity uncertain-write recovery** and **identity polling exhaustion** (your findings: chained writes with no reconciliation path; a 45-round poll cutoff with no resume) — **both fixed**, and the same uncertain-write containment pattern was extended to Standard's upload/consent stages, which your audit noted only the final render retry had.
- **Release tooling** (your finding: a spawn-EPERM blocker on `check:imports`/`scan:client-privacy`/`workflow:validate`) — doesn't reproduce on the current machine/CI; all three run clean.

All of the above have real Playwright coverage, not just claimed fixes — suite grew from your documented 82/83 baseline through 89/89 and now sits at **101/102** (1 pre-existing unrelated skip) after this session's admin console work, verified stable across repeated full-suite reruns.

**Still open from your audit**, genuinely, not by oversight:
- **Integrated-preview boundary** — your audit flagged that signed-in persistence, real quotes, and private delivery need a *live, deployed* backend to prove, not local testing. A real backend now exists (Part 2), but nothing has been deployed yet, so this proof still hasn't run.
- **Documentation drift** — `DESIGN.md` in your package is stale relative to the shipped UI; not touched this round.

## Part 2 — what got rebuilt of your backend package

Your `DELIVERY_PLAN.md` (D1–D8) assumed a partially-built GPU worker stack already existed in WIP form: SSH/SFTP transport to a RunPod-hosted SadTalker queue, a Python queue controller, a watchdog, pinned CUDA/Python Docker images. **None of that survived the git-history gap.** Here's what actually happened instead, mapped to your plan:

- **D1 (restore + isolate)** — moot; there was nothing recoverable to restore. Rebuilt clean.
- **D2 (one real job to accepted output)** — satisfied differently than planned: real Neon Postgres + real Vercel Blob integration test proves the full reserve → consent → quote → render → settlement sequence end to end, plus a real HTTP-layer test for the readiness/consent/quote/revoke surface. **Not yet proven**: the literal render-POST HTTP handler's dispatch to a running workflow runtime (it calls the real `workflow` package's `start()`, which needs a live workflow runtime this rebuild never had running) — the repository-level correctness is proven, the HTTP-to-workflow wire hasn't been.
- **D3 (failure/authorization cases)** — quote expiry, quote mismatch, replay, and consent revocation are covered by tests. Standard-specific cross-account/lost-acknowledgement cases weren't separately enumerated the way D3 asked.
- **D4 (operational recovery/supervision — your watchdog)** — **not done.** No supervisor/watchdog process exists for the Standard render path.
- **D5 (production prerequisites — DB/storage/access)** — satisfied for non-production: a real dev Neon project and a real dev Vercel Blob store were provisioned and used throughout (see credentials table below).
- **D6 (commit + CI)** — satisfied: merged to `main`, full CI green, plus two new CI gates that didn't exist before (Part 3).
- **D7 (real hosted GPU acceptance)** — **explicitly not done.** `services/sadtalker-simulator.js` composites the real uploaded portrait + audio into a real MP4 via plain ffmpeg — no lip-sync inference, no GPU. Every place it's referenced says so in comments. This is the single largest carryover from your original AUDIT.md's own top blocker (your B07/B08): **there is still no real Standard-tier GPU inference anywhere in this codebase.**
- **D8 (full release gate / tenancy)** — not attempted; out of scope for this rebuild, unchanged from before.

**The key discovery that changed the plan:** `main` already had a complete, working Premium/HeyGen job and credit lifecycle (`reserveRender`/`claimWorkflowStart`/`transitionJob`/`finalizeReadyJob`/`markJobFailedAndRelease` in `db/repositories.js`) that's fully provider-agnostic — reusable for Standard unchanged just by passing `provider: 'sadtalker'`. So the actual gap was much narrower than your `DELIVERY_PLAN.md` implied: only the Standard-specific narration/consent/quote pieces (`db/standard-narration-schema.js`, `db/standard-narration-repository.js`, `routes/video-os-lite/standard.js`) needed building, not a parallel dispatcher — the real dispatcher (`api/video-os-lite/render-v2.js`) was extended with a Standard branch alongside the existing Premium one, not rebuilt from zero.

## Part 3 — what got built that was never in either of your packages

None of this was asked for in your original scope. It's here because Ariel asked for it directly during this engagement:

- **A VPS hosting layer**, so the app is no longer Vercel-locked: a swappable private-storage driver (`lib/storage-drivers/` — Vercel Blob or local filesystem via `STORAGE_DRIVER=fs`), a polling worker daemon (`worker/render-worker.mjs`) that drives jobs through the same step functions Vercel Workflow uses, a plain Node HTTP server (`server/index.js`) that derives its entire route table directly from `vercel.json` at startup (so it can't drift), and deployment scaffolding (`deploy/` — systemd units, nginx config, env reference, deploy script). Gated behind `WORKFLOW_DISPATCH_MODE`.
- **Google OAuth sign-in**, alongside the pre-existing magic-link auth — same session/account scheme either way.
- **Two new CI gates**: a CodeQL SARIF allowlist (`tools/enforce-codeql-sarif.mjs`) for one confirmed false positive, since GitHub's own inline suppression comments don't work in this repo's CI (`upload: never` means no Code Scanning backend to process them); and a documented-exception `npm audit` gate (`tools/enforce-npm-audit.mjs`) after discovering the "obvious" fix (bumping `vercel`/`workflow`) actually made the vulnerability count *worse* (19 → 57), not better.
- **Dependency hygiene**: 8 Dependabot PRs merged (Sentry, Playwright, Stripe, 5 GitHub Action bumps); 2 others (`vercel`, `workflow`) tested and deliberately closed for the reason above.
- **Real cinematic finishing for Premium**: film grain via ffmpeg's native `noise` filter (zero licensing exposure — procedurally generated) and optional LUT color grading (`services/media-finisher.js`'s `cinematicFinishingFilterGraph`), replacing the previous bare color-correction-only grade.
- **VFX/asset licensing research** (not yet code, informs a future premium package): confirmed the mainstream "free for commercial use" stock/template sites (MotionElements, ProductionCrate/Footage Crate) explicitly prohibit baking their assets into automated multi-customer SaaS output — Enterprise licensing required. Clean paths identified: CC0 LUTs/music, and commissioning an *original* overlay/title kit in Jitter.video rendered through the existing HyperFrames/Remotion pipeline, since original work carries no redistribution risk. Nothing built yet.
- **A full admin console** (`/admin-console`, gated by the existing `VIDEO_OS_ADMIN_TOKEN`/admin cookie), built in 4 phases, none of it in either original package:
  1. **Overview & diagnostics** — real sign-in tracking (the `auth_sessions` table existed but was never written to before this), account/job stats, a reconciliation banner (stuck jobs, ready-jobs-missing-their-asset — both driven by a pre-existing `reconciliationSummary()` function that was built but never called before this).
  2. **Manual resolution & quarantine** — force a stuck job to `failed` with credit release and an audited note; quarantine a media asset (the `quarantinedAt` column existed but was never settable before this).
  3. **Billing visibility** — credit ledger and Stripe event viewers.
  4. **Video operations** — stream any customer's video for admin preview, approve (a tracking flag only, zero pipeline effect), delete a video (removes the private Blob file, keeps the job row and full event history for audit), and retry a render (re-reserves the job's own already-authorized input under a new job, charges credits normally — restricted to HeyGen jobs only, because a Standard/sadtalker job's reservation consumes a one-time narration-consent quote that a generic retry can't safely replay without creating a render with no matching consent record).

  All 4 phases have real DB/Blob integration tests (not mocks), Playwright coverage, and were manually verified live in-browser against the real dev database, including one real Vercel Workflow dispatch.

## How far along is this, really

Two different numbers, kept separate on purpose:

**~65-70% built. 0% launched.** Nothing has been deployed anywhere, and nothing has passed the P0 production-receipt proof (see "What's left, #4") — that's true regardless of how much code exists.

| Area | % done | Why |
|---|---|---|
| Frontend | ~95% | Fully built, 101/102 Playwright tests pass. Only gap: never proven against a *live* backend. |
| Premium/HeyGen backend | ~85% | Real lifecycle, has produced one real live render. Missing: the formal P0 receipt, operational watchdog. |
| Standard/SadTalker backend | ~50-55% | Narration/consent/quote pipeline is real and tested — but **even once a RunPod pod + Docker image + inference model are stood up, the application-side client code that talks to them doesn't exist yet.** Zero hits for "RUNPOD" anywhere in application code (confirmed by direct grep) — only doc mentions. Standing up infrastructure is not the same as writing `services/sadtalker.js` (the `services/heygen.js`-shaped submit/poll/error-handling/cost-accounting client) and wiring it into `workflows/standard-render.js` in place of the ffmpeg simulator. That client is comparable in size to the HeyGen integration — budget real engineering time for it, not a config change. |
| Admin console / ops tooling | ~90% | All 4 phases done and tested. Missing: an automated watchdog — right now a stalled job only surfaces via a human checking the admin console's "Needs attention" tab. |
| Infra/deployment code | Code ~80%, proven live: **0%** | `deploy/` scripts and the Vercel path both exist and pass tests, neither has run against a real box or a real production deploy. |
| Production launch readiness | ~10% | `docs/P0-RELEASE-GATE.md`'s 9-observation receipt has never been captured, for either tier, on any environment. |
| Premium VFX/cinematic differentiation | ~15% | ffmpeg grain/LUT shipped and real. The bigger "premium package" (original overlay/title kit, licensed-clean asset library) is researched only. |
| Non-HeyGen providers | 0% | UI stubs only. |

## Wish list — what would make this a better product, not just a finished one

None of this is scoped or built. In priority order:

1. **A real marketing/paywall front door.** Landing page skeleton now exists — see "New: a landing page" below.
2. **"Your video is ready" notifications.** Renders are async and there is currently no email/webhook when a job finishes — a customer has to remember to come back and check the gallery. Resend is already wired in for magic-link auth; reuse it for job-completion email.
3. **The operational watchdog** (also listed under "What's left" — it's both a reliability fix and a trust feature: silent failure is the worst failure mode for a paying customer).
4. **Onboarding / first-run guidance** — the wizard is fine once you know what "Standard" vs "Premium" means, but there's no explainer or example gallery for a brand-new signup.
5. **Subscription tiers, not just one-time credit packs** — better LTV lever than pay-as-you-go, if the business model calls for it.
6. **White-label / per-client branding** — relevant if this gets resold to agency clients rather than used directly; right now everything is single-brand.

Items 5-6 are business-model decisions, not engineering ones — surface them to whoever owns pricing/positioning before building either.

## New: a landing page (`/welcome`, `public/landing.html`)

Built this session, addressing wish-list item #1 above — a real public marketing page in front of the app (the app itself, at `/`, is unchanged and still works exactly as before). Includes:

- A hero with a from-scratch procedural "silk" WebGL background (domain-warped fBm + ridged-multifractal creases + finite-difference normals for the sheen — the same well-known technique behind most procedural-cloth shader demos, implemented fresh here, zero AI/GPU cost, respects `prefers-reduced-motion`, degrades to a plain dark background with no JS/WebGL at all).
- A CEO welcome-video slot, wired and ready — **drop a real `.mp4` into the empty `<source>` in `public/landing.html`'s `#lp-ceo-video`** and it works; currently shows a "coming soon" placeholder instead of erroring.
- A two-tier explainer (Standard vs Premium), a feature-comparison table positioned against generic "typical avatar platforms" (deliberately not making unverifiable specific claims about any named competitor's current pricing), a pricing section using real credit-pack sizes (500/1000/2000 — matching `checkout-v2.js`'s actual `PACKAGES`) with **dollar amounts intentionally left as "pricing shown in-app"** rather than invented, and an FAQ.
- Every "Get started" / "Log in" CTA links to `/?signin=1`, which already auto-opens the real, existing, tested auth modal (magic link + Google) — no new auth code, no duplicate sign-up form. Verified live in-browser.
- Real Playwright coverage: `tests/e2e/landing.spec.js` (hero renders, every CTA points at the real sign-in flow, tier/pricing/compare counts, FAQ accordion, nav scroll).
- **Not done**: this page is additive only — it doesn't gate `/`, so an anonymous visitor can still reach the signed-out app shell directly. Wiring it as an enforced front door (redirect anonymous root traffic to `/welcome`) is a deliberate next decision, not an oversight — it changes the entry funnel and is worth a product call, not a drive-by change on a handoff.

## Cleanup items found while preparing this handoff

- **`video_os_backend.py`** (repo root) is a **legacy, dead Python HeyGen client** — duplicate `heygen_submit`/`heygen_poll`/`fetch_heygen_collection` logic, completely disconnected from real routing (nothing in `vercel.json`/`server/index.js` calls it). `services/heygen.js` is the one real HeyGen client. Left in place for this handoff since removing it also touches the legacy `tests/test_public_rendering_contract.py` pytest suite (which already tests dead frontend code — see Known Gotchas) — worth a dedicated cleanup pass, not a drive-by deletion.
- **Stray zips in `Downloads/`**: `lux-video-os-handoff-2026-09-19.zip` is a stale snapshot from earlier the same day (predates the current HEAD by ~2 hours) and bundles `.env.local` — don't reuse it. The original `LUX-frontend-developer-handoff-2026-09-18.zip` / `wetransfer_video_os_backend_handoff...zip` (plus a duplicate) are the source packages, already fully absorbed into the repo. All four are safe to archive or delete once you've confirmed nothing else is needed from them — nothing on this machine's drive outside the repo is newer or unique.
- Confirmed via direct filesystem audit: **RunPod has zero real integration** anywhere in the code — it's mentioned only in comments/docs as a future option. **Vercel routing is clean and test-enforced** (`tests/foundation-contract.test.mjs` pins the exact serverless function count against the Hobby-plan budget). **HyperFrames has exactly one composition**, invoked through a sandboxed subprocess, opt-in and disabled by default.

## What's left, in priority order

1. **Real GPU inference for the Standard tier** — still the single biggest gap, unchanged in substance from your original AUDIT.md's top blocker. Recommendation from this session's research: **fal.ai's hosted SadTalker endpoint** (`fal-ai/sadtalker`) — off-the-shelf, maintained, pay-per-request, and its submit/poll queue API maps directly onto the exact pattern already built for HeyGen (`services/heygen.js`), meaning one new `services/sadtalker.js` in the same shape, not a restructure. Fallback: RunPod serverless (same async shape, but you containerize the model yourself — closer to your original architecture). We also evaluated HeyGem.ai, Tencent HunyuanVideo-Avatar, and LivePortrait as alternatives — verdict was no on all three (licensing MAU caps, GPU cost/scale mismatch, or wrong problem shape respectively) — details available if useful, not repeated here.
2. **Prove `render-v2.js`'s actual render-POST dispatch at the HTTP layer** against a running workflow runtime — currently only proven at the repository level.
3. **Operational recovery/supervision** for the render pipeline (your D4/watchdog) — doesn't exist yet for either tier.
4. **One real production proof run** — `docs/P0-RELEASE-GATE.md` is a hard, already-written gate: billing, hosted finishing, pilot enrollment, and launch stay blocked until one genuine paid HeyGen render produces a full signed receipt (9 required observations — read the doc). Needs a live deployment target and Ariel's explicit go-ahead; spends real money.
5. **Deploy somewhere real** — both paths are ready (Vercel via `npm run build:production`, or the VPS layer via `deploy/`), neither has been exercised against a live box yet.
6. **Non-HeyGen providers are stubs** — Argil, Tavus, D-ID appear in the UI picker with no real API integration (`configured: false` in `lib/video-os-account.js`'s `PROVIDERS`).
7. **Frontend structural items still open**: the integrated-preview boundary proof (needs the live deployment from #5) and stale `DESIGN.md`.

## Credentials / accounts you'll need to obtain

None of these are in this handoff except where marked. Get the rest yourself or ask Ariel for the ones marked "(ask Ariel)":

| Service | Env var(s) | For |
|---|---|---|
| GPU inference (fal.ai recommended, or RunPod) | none yet — new integration | Real Standard-tier rendering |
| HeyGen | `HEYGEN_API_KEY` (ask Ariel for prod; dev doesn't need it for simulated/mocked test paths) | Premium tier |
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_EXPECT_LIVEMODE`, `STRIPE_PRICE_ID_500/1000/2000` | Billing |
| Resend | `RESEND_API_KEY`, `AUTH_FROM_EMAIL` | Magic-link email delivery |
| Google Cloud OAuth client | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in (ask Ariel — already set up) |
| Neon Postgres | `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | Primary datastore — **dev credentials already in `.env.local` in this package**, pointing at a non-production Neon project (`lux-video-os-dev`) |
| Vercel Blob | `BLOB_READ_WRITE_TOKEN` | Private object storage — **dev token already in `.env.local`**, non-production store |
| Hetzner or Hostinger | n/a (used manually to provision) | VPS hosting, if that path is chosen (ask Ariel) |

`deploy/video-os.env.example` has the complete list of every env var the app reads, with comments on what each gates.

**`.env.local` contains live (but non-production) credentials — treat this package as sensitive from the moment you receive it, and don't commit `.env.local` to git (already gitignored).** Any `VERCEL_OIDC_TOKEN` included is short-lived and almost certainly expired by the time you read this — run `vercel link` / `vercel env pull` for a fresh one if needed.

## Getting started

```bash
npm install
```

If `ffmpeg-static`'s binary doesn't download automatically (some npm configs block install scripts), run `node node_modules/ffmpeg-static/install.js` directly.

Run locally against the included dev database/storage:

```bash
node -r dotenv/config server/index.js dotenv_config_path=.env.local
```

Open `http://127.0.0.1:8080`. `/admin-console` needs an admin access code (ask Ariel); `/identity` and rendering need sign-in (magic-link or Google, whichever you configure).

Run the render worker daemon (needed for a render to actually complete once submitted, since this local run isn't on Vercel):

```bash
node -r dotenv/config worker/render-worker.mjs dotenv_config_path=.env.local
```

## Testing

```bash
node --test tests/*.test.mjs      # 245+ tests, most run live against the dev Neon DB/Blob store in .env.local
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

**Vercel** (historical path): `npm run build:production`, deploy via `vercel deploy`. Requires `WORKFLOW_DISPATCH_MODE` unset or `vercel` (the default).

**VPS** (untested on a real box yet): follow `deploy/deploy.sh` and the systemd/nginx configs in `deploy/`. Set `WORKFLOW_DISPATCH_MODE=poll` — without this, render dispatch silently falls back to an in-memory local queue not meant for production and will race the worker daemon.

## Governance — read before touching billing, real spend, or production

- `docs/P0-RELEASE-GATE.md` — the production launch gate (see "What's left, #4").
- This project uses an execution-mode ladder: **SIMULATION** (no real cost, current default for Standard-tier rendering) → **CANARY** (real, requires explicit owner authorization) → **PRODUCTION**. Never flip a real-money or real-provider-call code path live without Ariel's explicit go-ahead — he is "the owner" throughout this project's docs; product/security/spend decisions are owner-controlled, everything else is routine engineering.

## Known gotchas

- **`video_os_backend.py`** (repo root) is dead legacy Python code — see Cleanup items above. Don't build on it.
- **`public/lite.js` and `public/lite.css` are dead code.** No HTML page loads them (`public/index.html` loads `public/studio.js`) — an earlier frontend generation left in the tree. Several Python tests in `tests/test_public_rendering_contract.py` still check `lite.js`/`lite.css` content, which means they're not actually protecting the live frontend.
- **`npm install`/`npm ci` may block postinstall scripts** on some machines' npm config (`ffmpeg-static`'s binary download, in particular). If a test fails with an `ENOENT` for an ffmpeg path, run `node node_modules/ffmpeg-static/install.js` directly.
- **CodeQL and `npm audit` both have small, explicit, commented exception lists** (`tools/enforce-codeql-sarif.mjs`'s `ALLOWED_FINDINGS`, `tools/enforce-npm-audit.mjs`'s `ACCEPTED_ADVISORIES`). Read the comments before assuming either gate is naive — both document exactly why each exception is safe, and both still fail hard on anything not explicitly listed.
- GitHub's inline `codeql[rule-id]` suppression comments **do not work in this repo's CI** (`.github/workflows/codeql.yml` sets `upload: never`) — extend the allowlist in `tools/enforce-codeql-sarif.mjs` instead.
