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

- `HEYGEN_API_KEY` or `HEYGEN_TOKEN`: enables HeyGen talent sync and live submission.
- `HEYGEN_SYNC_TALENT=1`: refreshes HeyGen avatar and voice inventory on startup.
- `HEYGEN_AVATARS_URL`: override for HeyGen avatar inventory endpoint.
- `HEYGEN_VOICES_URL`: override for HeyGen voice inventory endpoint.
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

- `AI_GATEWAY_API_KEY`: required for the feature to report `ready`. Without it, the endpoint stays reachable and honest (`setup_required`) rather than failing at generation time.
- `VIDEO_OS_COPYWRITER_ENABLED`: optional owner kill-switch, independent of whether the Gateway key is set -- defaults to `true`. Set to `false` to turn generation off for cost control without unsetting the key.
- `VIDEO_OS_COPYWRITER_MODEL`: optional override for the Gateway model id. Defaults to `anthropic/claude-sonnet-4.6` (`services/copywriter.js`'s `DEFAULT_COPYWRITER_MODEL`).
- `VIDEO_OS_COPYWRITER_HOURLY_LIMIT`: optional per-account request cap per rolling hour. Defaults to `30`. Backed by the existing `rate_limits` table (`db/repositories.js`'s `consumeRateLimit`) -- no new migration needed.

Every request is a real, billed AI Gateway call once configured -- there is no simulation mode for this feature (unlike Standard-tier rendering).

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

