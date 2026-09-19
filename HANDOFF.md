# LUX Video OS — Developer Handoff (2026-09-19)

Read this first. It's the current, accurate picture of the project — the root `README.md` is stale (describes an old Python-based version of this app) and should not be trusted for architecture or setup.

## What this is

LUX Video OS is an owner-facing AI video studio: sign in, pick or create an authorized on-camera identity, submit a **Standard** (portrait photo + uploaded narration WAV) or **Premium** (HeyGen presenter + voice + script) video request, get a credit quote, render asynchronously, and download only accepted output.

- GitHub repo (private): `ARCHITECTARIEL/lux-video-os`, branch `main`. Ask Ariel to add you as a collaborator if you don't have access yet.
- This zip is a convenience snapshot of `main` as of commit `6a99a06` (merge of PR #22). Once you have GitHub access, `git clone` the real repo instead of continuing to edit inside this zip — the zip has no `.git` history.

## Current state — what's actually done and tested

Everything below is built, has real automated test coverage (not just claimed), and was verified against a live (non-production) Neon Postgres + Vercel Blob store, not mocks, unless noted otherwise.

- **Frontend** (`public/studio.js` + `public/index.html`, NOT `public/lite.js` — see Known Gotchas): create-video wizard (Standard + Premium tiers), identity studio, AI copywriter, results gallery with progressive disclosure, responsive across breakpoints. ~100 Playwright tests.
- **Auth**: magic-link email sign-in, Google OAuth sign-in (`lib/google-oauth.js`), demo/owner password access, admin login, one-time CEO access link. All issue the same session cookie and share one account-identity scheme (`accountIdForEmail`), so a user signing in via Google and via magic-link with the same address lands on the same account.
- **Premium (HeyGen) backend**: full submit → poll → finish lifecycle (`services/heygen.js`, `workflows/video-render.js`), credit reservation/settlement, Stripe checkout + webhook with idempotent grants. This path has previously produced one real live HeyGen render end-to-end.
- **Standard backend**: narration upload → identity → consent → quote → reserve → render → settlement (`db/standard-narration-repository.js`, `workflows/standard-render.js`). **The actual render step is simulated** (`services/sadtalker-simulator.js` composites the real uploaded portrait + audio into a real MP4 via ffmpeg) — this is not real GPU talking-head inference. See "What's left, #1" below.
- **VPS hosting layer** (built this session, so the app is no longer Vercel-locked):
  - `lib/storage-drivers/`: swappable private storage, Vercel Blob (default) or local filesystem (`STORAGE_DRIVER=fs`).
  - `worker/render-worker.mjs`: a polling daemon that drives render jobs through the same step functions Vercel Workflow uses, for hosting without Vercel's durable-execution runtime.
  - `server/index.js`: a plain Node HTTP server that replays `vercel.json`'s own route table, so it can never drift from what Vercel serves.
  - `deploy/`: systemd units, nginx reverse-proxy config, `deploy/video-os.env.example` (the full env var reference), and `deploy/deploy.sh`.
  - `WORKFLOW_DISPATCH_MODE=poll` env var is what actually switches render dispatch from "hand off to Vercel Workflow" to "let the worker daemon's poll loop drive it" — required for renders to complete off Vercel.
- **CI / security gates**: CodeQL (with a small, explicit, justified allowlist in `tools/enforce-codeql-sarif.mjs` for one confirmed false positive — see the file's comments), a documented-exception `npm audit` gate (`tools/enforce-npm-audit.mjs` — see "Known Gotchas"), Playwright, pytest, `check:imports`, `scan:client-privacy`.

## What's left, in priority order

1. **Real GPU inference for the Standard tier.** Researched this session — recommendation is **fal.ai's hosted SadTalker endpoint** (`fal-ai/sadtalker`): off-the-shelf, maintained, pay-per-request (no idle cost), and its submit/poll queue API maps directly onto the exact pattern already built for HeyGen (`submitHeygen`/`pollHeygen` in `services/heygen.js`) — this means writing one new `services/sadtalker.js` following that same shape, not a restructure. Fallback if fal proves limiting: RunPod serverless (same async submit/poll shape, but you'd containerize the model yourself). Note: SadTalker itself is a 2023 model; Hallo3 (2025) is a credible quality upgrade with the same audio-driven input shape, but has no ready-made hosted endpoint yet, so it means real deployment work rather than an API call — worth revisiting once fal/RunPod is live and quality becomes the differentiator worth chasing.
2. **One real production proof run.** `docs/P0-RELEASE-GATE.md` is a hard, already-written gate: billing, hosted finishing, pilot enrollment, and launch stay blocked until one genuine paid HeyGen render produces a full signed receipt (real session, real provider charge, private final file, verified download, cross-account-denial checks, exactly-one-debit reconciliation — 9 required observations, read the doc for the exact list). This spends real money and needs the owner's (Ariel's) explicit go-ahead, and requires an actual live deployment target to run against (see #3 — nothing is live yet post-merge).
3. **Deploy somewhere real.** Both paths are ready: Vercel (the historical path — `npm run build:production` builds it) or the VPS layer above. Vercel project access + a provisioned VPS (Hetzner/Hostinger, still pending Ariel's decision) are both needed depending on which path is chosen; either works via the `WORKFLOW_DISPATCH_MODE`/`STORAGE_DRIVER` flags.
4. **Non-HeyGen providers are stubs.** Argil, Tavus, D-ID appear in the UI picker but have no real API integration (`lib/video-os-account.js`'s `PROVIDERS` list marks them `configured: false`). Only HeyGen actually works today.
5. **Dependency hygiene.** 5 Dependabot PRs are open against `main` (sentry, playwright, stripe, and 5 GitHub Action version bumps — see PR list on GitHub). Two others (`vercel`, `workflow` version bumps) were tested and closed because they made `npm audit`'s vulnerability count *worse* (19 → 57), not better — see `tools/enforce-npm-audit.mjs`'s `ACCEPTED_ADVISORIES` for why the current pins are intentional, not neglect.
6. **Customer self-service signup** is actually done now (Google + magic-link both create accounts on the spot) — cross this off if you see it listed as outstanding anywhere older.

## Credentials / accounts you'll need to obtain

None of these are in this handoff. Get them yourself or ask Ariel for the ones marked "(ask Ariel)":

| Service | Env var(s) | For |
|---|---|---|
| GPU inference (fal.ai recommended, or RunPod) | none yet — new integration | Real Standard-tier rendering |
| HeyGen | `HEYGEN_API_KEY` (ask Ariel for prod; dev doesn't need it for simulated/mocked test paths) | Premium tier |
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_EXPECT_LIVEMODE`, `STRIPE_PRICE_ID_500/1000/2000` | Billing |
| Resend | `RESEND_API_KEY`, `AUTH_FROM_EMAIL` | Magic-link email delivery |
| Google Cloud OAuth client | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in (ask Ariel — he said Google Cloud is already set up) |
| Neon Postgres | `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | Primary datastore — **dev credentials for this are already in `.env.local` in this zip**, pointing at a non-production Neon project (`lux-video-os-dev`) |
| Vercel Blob | `BLOB_READ_WRITE_TOKEN` | Private object storage — **dev token already in `.env.local`**, non-production store |
| Hetzner or Hostinger | n/a (used manually to provision) | VPS hosting, if that path is chosen (ask Ariel) |

`deploy/video-os.env.example` has the complete list of every env var the app reads, with comments on what each gates.

**`.env.local` in this zip contains live (but non-production) credentials — treat this zip itself as sensitive from the moment you receive it, and don't commit `.env.local` to git (it's already gitignored).** The `VERCEL_OIDC_TOKEN` in there is short-lived and is almost certainly expired by the time you read this; ignore it unless you know you need it (run `vercel link` / `vercel env pull` to get a fresh one if so).

## Getting started

```bash
npm install
```

If `ffmpeg-static`'s binary doesn't download automatically (some npm configs block install scripts), run `node node_modules/ffmpeg-static/install.js` directly.

Run locally against the included dev database/storage:

```bash
node -r dotenv/config server/index.js dotenv_config_path=.env.local
```

Open `http://127.0.0.1:8080`. `/dashboard` needs an admin access code (ask Ariel); `/identity` and rendering need sign-in (magic-link or Google, whichever you configure).

Run the render worker daemon (needed for a render to actually complete once submitted, since this local run isn't on Vercel):

```bash
node -r dotenv/config worker/render-worker.mjs dotenv_config_path=.env.local
```

## Testing

```bash
node --test tests/*.test.mjs      # 200+ tests, most run live against the dev Neon DB/Blob store in .env.local
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

**VPS** (new this session, untested on a real box yet): follow `deploy/deploy.sh` and the systemd/nginx configs in `deploy/`. Set `WORKFLOW_DISPATCH_MODE=poll` — without this, render dispatch silently falls back to an in-memory local queue not meant for production and will race the worker daemon.

## Governance — read before touching billing, real spend, or production

- `docs/P0-RELEASE-GATE.md` — the production launch gate (see "What's left, #2").
- This project uses an execution-mode ladder: **SIMULATION** (no real cost, current default for Standard-tier rendering) → **CANARY** (real, requires explicit owner authorization) → **PRODUCTION**. Never flip a real-money or real-provider-call code path live without Ariel's explicit go-ahead — he is "the owner" throughout this project's docs; product/security/spend decisions are owner-controlled, everything else is routine engineering.

## Known gotchas

- **`public/lite.js` and `public/lite.css` are dead code.** No HTML page loads them (`public/index.html` loads `public/studio.js`) — they're an earlier frontend generation left in the tree. Several Python tests in `tests/test_public_rendering_contract.py` still check `lite.js`/`lite.css` content, which means they're not actually protecting the live frontend. Not urgent, but worth a cleanup pass so those tests test something real.
- **`npm install`/`npm ci` may block postinstall scripts** on some machines' npm config (`ffmpeg-static`'s binary download, in particular). If a test fails with an `ENOENT` for an ffmpeg path, run `node node_modules/ffmpeg-static/install.js` directly.
- **CodeQL and `npm audit` both have small, explicit, commented exception lists** (`tools/enforce-codeql-sarif.mjs`'s `ALLOWED_FINDINGS`, `tools/enforce-npm-audit.mjs`'s `ACCEPTED_ADVISORIES`). Read the comments before assuming either gate is naive — both document exactly why each exception is safe, and both still fail hard on anything not explicitly listed.
- GitHub's inline `codeql[rule-id]` suppression comments **do not work in this repo's CI** (`.github/workflows/codeql.yml` sets `upload: never`, so there's no Code Scanning backend to process them) — don't waste time on that approach if a new CodeQL finding needs an exception; extend the allowlist in `tools/enforce-codeql-sarif.mjs` instead.
