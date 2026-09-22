# Video OS pricing model

Real cost-per-render basis and credit pricing. Before this document, no dollar figure had ever been assigned to a credit anywhere in this codebase or its docs — the 90-credit flat charge was picked with no cost basis behind it. Full analysis and sourcing: see the "Video OS Unit Economics" artifact from the pricing-review session; this file is the durable summary.

## Decision

- **Rate: $0.06 per credit.**
- **Packages** (`checkout-v2.js`'s `PACKAGES`, unchanged): Starter 500 credits / Growth 1,000 credits / Studio 2,000 credits.
- **Package prices**: Starter **$30**, Growth **$48**, Studio **$96**.
  - Per-credit: $0.060 / $0.048 / $0.048. Growth deliberately sits at Studio's per-credit rate, not below it — a lower Growth rate than Studio's would let customers undercut the top tier by buying two Growth packs instead of one Studio pack.
- **Premium script cap: 900 characters** (`lib/video-os-validation.js`'s `PREMIUM_SCRIPT_MAX_CHARS`), down from 4,000. This is the actual fix -- flat per-render pricing cannot be made safe by choosing a rate; a 4,000-character script (~5 min) could cost up to $12.99 in real HeyGen spend against the same 90-credit charge as a 30-second video. Capping length keeps the worst case within reach of the typical case (~$3.03 max vs. ~$1.00-$2.60 typical) instead of pricing every render for the tail.
- The AI Copywriter's working-draft cap (`routes/video-os-lite/copywriter.js`, `services/copywriter.js`, and the frontend counters) was aligned to the same 900 characters, since an accepted draft is copied directly into the Premium script field -- a mismatched cap would let someone draft something they can't submit.

## Cost basis (HeyGen, Premium)

`services/heygen.js`'s video submission uses a plain `type: "avatar"` request with no digital-twin or photo-look fields -- strong evidence (read from the actual API call shape, not guessed) that these renders bill at HeyGen's **Avatar III** tier, not the pricier Avatar IV engine:

| Avatar III variant | Rate | 60 sec | 90 sec (max cap) |
|---|---|---|---|
| Digital Twin / Studio Avatar | $0.0167/sec | $1.00 | $1.50 |
| Photo Avatar | $0.0433/sec | $2.60 | $3.90 |

Worth one direct confirmation against the HeyGen dashboard before this anchors pricing further, but it's the working basis.

At $0.06/credit, a 90-credit render (90 × $0.06 = $5.40) covers the 900-character-capped worst case ($3.03) with room, and typical renders (~60 sec, $1.00-$2.60) at 53-81% gross margin.

## Standard tier (RunPod), once real

Projected, not measured -- the real SadTalker worker has never been deployed (`docs/runpod-standard-worker.md`); the checked-in image is infrastructure-only. RTX 4090 serverless (~$0.69-1.10/hr) against public SadTalker benchmarks (~4x realtime compute) projects to **~$0.07-0.15 per 60-second render**. At the same 90-credit flat charge as Premium, that's ~95%+ gross margin -- a real, deliberate cross-subsidy decision, worth revisiting once the GPU path is proven rather than before.

## Free trial exposure

180 trial credits = 2 renders, no card required to sign up. Worst case today (Photo Avatar, 900-char cap): 2 x $3.03 = **$6.06** per free signup -- down from $25.98 before the cap existed.

## Open before this is fully real

- Set up Stripe: secret key, webhook secret, and three Price objects matching $30 / $48 / $96, wired to `STRIPE_PRICE_ID_500` / `_1000` / `_2000`.
- Confirm Avatar III inference against the HeyGen dashboard.
- Fix `VIDEO_OS_ADMIN_USERNAME` (missing in production, unrelated to pricing but blocks visibility into all of this).
- Decide on Argil / Tavus / D-ID -- real API keys already exist in production for Tavus and D-ID with zero code using them.
