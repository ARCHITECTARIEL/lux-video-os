# Video OS Lite Environment

## Local Run

```powershell
cd C:\Users\ariel\lux-video-os
python .\server.py
```

Open:

```text
http://127.0.0.1:8789/
http://127.0.0.1:8789/dashboard
```

## Launch Required Environment Variables

- `VIDEO_OS_SESSION_SECRET`: required before any public or client-facing deployment. Use a long random value, keep it server-side, and rotate it if exposed. Without this variable the app runs in local-dev session mode and the Account panel will show `Local only`.
## Optional Environment Variables

- `VIDEO_OS_IDENTITY_ALLOWED_ACCOUNT_IDS`: comma or whitespace separated account IDs authorized for provider-backed identity creation. Each ID must match `^[a-z0-9_-]{1,80}$` and is compared exactly. Invalid entries are ignored and counted in operator diagnostics; a whole-list quoted value is invalid and denies everyone. Empty or unset without a legacy pin denies every account, even when `VIDEO_OS_PROVIDER_CREATION_ENABLED=true`. A configured list overrides legacy pins.
- `VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID` and `VIDEO_OS_IDENTITY_PROVIDER_ACCOUNT_ID`: deprecated but honored when the new allowlist is empty or unset. If both are set, they must match; differing pins deny every account.
- `HEYGEN_API_KEY` or `HEYGEN_TOKEN`: enables HeyGen talent sync and live submission.
- `HEYGEN_SYNC_TALENT=1`: refreshes HeyGen avatar and voice inventory on startup.
- `HEYGEN_AVATARS_URL`: override for HeyGen avatar inventory endpoint.
- `HEYGEN_VOICES_URL`: override for HeyGen voice inventory endpoint.

HeyGen inventory defaults use `GET /v3/avatars/looks?ownership=public&limit=50` and `GET /v3/voices?type=private&limit=100`. The active talent route also reads private looks from `GET /v3/avatars/looks?ownership=private&limit=50`. Hosted avatar consent uses `POST /v3/avatars/{group_id}/consent`; group readback uses `GET /v3/avatars/{group_id}`. These paths are already implemented in `api/video-os/talent.js` and `services/heygen.js`.
- `VIDEO_OS_EMBEDDED_WORKER=0`: disables embedded worker loop.
- `VIDEO_OS_WORKER_INTERVAL`: worker poll interval in seconds.
- `VIDEO_OS_SCHEDULER=0`: disables scheduler loop.
- `VIDEO_OS_SCHEDULER_INTERVAL`: scheduler interval in seconds.

## Required Local Tools

- Python 3.
- FFmpeg for local MP4 draft export.

## Secret Handling

Do not commit API keys, tokens, `data/`, `.vercel`, or generated exports. Prefer environment variables for provider credentials. The local desktop key-file fallback exists for the current operator workflow only and should not be used for a public consumer deployment.

Session cookies are HMAC-signed with `VIDEO_OS_SESSION_SECRET`. The checked-in local fallback is for localhost development only; do not launch with the fallback secret.

## Provider rendering and credits

Video OS Lite now exposes provider routing through `/api/video-os-lite/providers` and `/api/video-os-lite/render`.

Required only for the providers you enable:

- `HEYGEN_API_KEY` or `HEYGEN_TOKEN` for HeyGen live avatar renders.
- `ARGIL_API_KEY` and `ARGIL_RENDER_URL` for Argil renders.
- `TAVUS_API_KEY` and `TAVUS_REPLICA_ID` for Tavus renders. Optional: `TAVUS_RENDER_URL`, `TAVUS_CALLBACK_URL`.
- `DID_API_KEY` and `DID_SOURCE_URL` for D-ID talking-head renders. Optional: `DID_RENDER_URL`, `DID_BASIC_AUTH`.
- `VIDEO_OS_STARTER_CREDITS` to set the first local credit balance. Defaults to `1530` for local MVP testing.

Contained durable rendering requires all of the following in the same non-production deployment:

- `VIDEO_OS_DURABLE_WORKFLOW_ENABLED=true`
- `VIDEO_OS_RENDER_ACCOUNT_ID`: one or more exact authorized account IDs, comma-separated; requests from every other account fail closed. Keep this list to explicitly trusted testers while `VIDEO_OS_BILLING_ENABLED` stays false -- every render an allowlisted account triggers is a real, unbilled provider cost.
- `VIDEO_OS_TRIAL_CREDITS`: optional override for the free trial credit balance every new account gets on first sign-in (any path -- Google, magic-link, or workspace password). Defaults to `180` (`lib/video-os-account.js`'s `DEFAULT_TRIAL_CREDITS`) if unset -- not zero. This single constant is the only place that default lives; every account-creation call site imports it rather than re-deriving its own fallback (a prior version of this codebase had that duplicated inconsistently, silently giving 0 credits on some sign-in paths and 180 on others).
- `VIDEO_OS_HOSTED_FINISHING_ENABLED=true` only when bounded finishing and private final storage are being explicitly tested.
- `VIDEO_OS_PROVIDER_MEDIA_HOSTS`: comma-separated exact provider media hostnames. Subdomain wildcards are not accepted.

## AI Copywriter

`/api/video-os-lite/copywriter` (`routes/video-os-lite/copywriter.js`, via `services/copywriter.js`) drafts, shortens, improves the hook of, or revises a working video script through the Vercel AI Gateway (`generateText` from the `ai` package -- no separate provider SDK).

- `AI_GATEWAY_API_KEY`: Gateway authentication option. Without this, the Vercel OIDC environment token, or the `x-vercel-oidc-token` request header, the endpoint reports `setup_required`.
- `VERCEL_OIDC_TOKEN`: alternate Gateway authentication supplied by Vercel when a Gateway API key is absent; do not set it in the env example.
- `VIDEO_OS_COPYWRITER_ENABLED`: optional owner kill-switch, independent of whether the Gateway key is set -- defaults to `true`. Set to `false` to turn generation off for cost control without unsetting the key.
- `VIDEO_OS_COPYWRITER_MODEL`: optional override for the Gateway model id. Defaults to `anthropic/claude-sonnet-4.6` (`services/copywriter.js`'s `DEFAULT_COPYWRITER_MODEL`).
- `VIDEO_OS_COPYWRITER_FALLBACK_MODEL`: optional secondary Gateway model id; unset means no fallback. Consider `anthropic/claude-haiku-4.5` after checking its availability and cost. One fallback attempt follows only a primary rate limit, upstream, or timeout failure. Refusals, billing, auth, model, forbidden, and invalid request failures do not fall back.
- `VIDEO_OS_COPYWRITER_MAX_OUTPUT_TOKENS`: optional output token cap, limited to 4096.
- `VIDEO_OS_COPYWRITER_HOURLY_LIMIT`: optional per-account request cap per rolling hour. Defaults to `30`. Backed by the existing `rate_limits` table (`db/repositories.js`'s `consumeRateLimit`) -- no new migration needed.
- `VIDEO_OS_COPYWRITER_GLOBAL_DAILY_LIMIT`: required positive integer model-run cap across accounts. The intended window is a fixed 24 hours from the first run, not a calendar day. A rolling 24-hour observation across adjacent windows can see up to twice the configured limit. The existing `rate_limits.account_id` is a required FK to `users` with cascading deletion, so it cannot safely host an account-independent global row. The production POST path fails closed with `copywriter_budget_unavailable` until Architecture & Data approves a schema change (nullable `account_id` or a separate table) and supplies an atomic global counter. Do not create a reserved system user.
- `VIDEO_OS_COPYWRITER_BLOCKED_TERMS`: required client names, separated by commas or newlines, or supplied as a JSON string array. The server rejects normalized names in both requests and generated results. Short or common-word client terms are risky: they can appear in unrelated language even with token-boundary checks. Review the list and generated copy with a human; indirect descriptions are not caught. An empty or invalid list makes the endpoint unavailable unless `VIDEO_OS_COPYWRITER_CLIENT_GUARD=off` is explicitly set.

Successful idempotent replays use the same `(accountId, idempotencyKey)` and parsed request body. They return `replayed: true` without generation or additional limit consumption. Version 1 replay storage is per-instance, in memory, with a 15-minute TTL and approximately 2,000-entry bound; it does not coordinate across instances or survive restarts.

Cross-instance and cold-start retries can generate again; a DB-backed idempotency claim is a follow-up. An output-guard 422 releases the idempotency key, so a retry can generate again and consume another model-run cap unit. The primary run consumes one cap unit before its call; an eligible fallback consumes another before its call. A spent shared deadline or a timeout with under three seconds remaining skips fallback before its budget check. The fallback has no SDK retries, and both calls share a 28-second deadline. The primary still has `maxRetries: 2`, so SDK internal retries can bill up to three attempts for its one counted run.

The workspace function has no explicit `maxDuration` in `vercel.json` or its API module. Confirm its effective deployment limit is greater than the 28-second generation deadline plus route overhead before enabling this feature.

Every new request that passes validation and both limits can make a billed AI Gateway call. Successful replays return the cached result; there is no simulation mode for this feature (unlike Standard-tier rendering).

Do not copy Production session, Blob, or provider credentials into Preview. Provision deployment-specific resources instead.

`SENTRY_DSN` is optional. When absent, Sentry stays dormant and builds, migrations, logs, and contained UI tests continue normally.

Stripe credit purchase setup:

- Easiest: set `STRIPE_PAYMENT_LINK_URL` to an existing Stripe Payment Link.
- Checkout Sessions: set `STRIPE_SECRET_KEY` and `STRIPE_CREDIT_PRICE_ID`.
- Optional public origin: `VIDEO_OS_PUBLIC_URL`.

Do not commit provider keys, Stripe keys, generated credit ledgers, or render outputs.

## Account and avatar builds

Video OS Lite includes a local MVP account surface at `/api/video-os-lite/account`.

Optional account variables:

- `VIDEO_OS_ACCOUNT_EMAIL`
- `VIDEO_OS_ACCOUNT_NAME`
- `VIDEO_OS_PLAN`
- `VIDEO_OS_PLAN_STATUS`
- `VIDEO_OS_PLAN_RENEWAL`
- `VIDEO_OS_PLAN_CREDITS`

Avatar creation uses HeyGen `POST /v3/avatars` through `/api/video-os-lite/avatar` and requires:

- `HEYGEN_API_KEY` or `HEYGEN_TOKEN`
- a public HTTPS image URL for photo avatars
- a public HTTPS training video URL for digital twins
- explicit user consent in the request

The starter asset libraries are linked from Google Drive and are intended as customer-facing production assets for music, motion backgrounds, LUTs, GIFs, and CTA overlays.

## Automatic production kit

/api/video-os-lite/assets/recommend selects music, background, LUT, CTA motion, and overlay assets from the starter Drive libraries based on video goal and tone. The Lite UI calls it during preview generation and carries the selected kit into the saved project/render payload.

