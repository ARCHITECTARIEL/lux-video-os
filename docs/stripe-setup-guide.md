# Stripe Production Setup Guide

Target Account: `acct_1CW7vBJL3SekJtVV`  
Platform: LUX Video OS (`https://lux-video-os.vercel.app`)

---

## 1. Credit Pricing Model & Packages

LUX Video OS bills on a **$0.06 per credit** basis with tiered discount packages:

| Package | Credits | Price (USD) | Effective Rate | Estimated Videos |
|---|---|---|---|---|
| **Starter** | 500 | $30.00 | $0.060/credit | ~5 Standard / Premium |
| **Growth** | 1,000 | $48.00 | $0.048/credit | ~11 Standard / Premium |
| **Studio** | 2,000 | $96.00 | $0.048/credit | ~22 Standard / Premium |

---

## 2. Automated Product & Price Provisioning

You can generate all products and prices in one step using the helper script:

```powershell
# Set your Stripe Secret Key (sk_live_... or sk_test_...)
$env:STRIPE_SECRET_KEY = "sk_live_..."

# Run the provisioning script
node tools/setup-stripe-products.mjs
```

The script will idempotently create the products, associate one-time prices, and output the exact environment variables needed.

---

## 3. Stripe Webhook Configuration

1. In your **Stripe Dashboard** (for account `acct_1CW7vBJL3SekJtVV`), navigate to **Developers > Webhooks** (`https://dashboard.stripe.com/webhooks`).
2. Click **Add endpoint**.
3. **Endpoint URL**:
   ```
   https://lux-video-os.vercel.app/api/video-os-lite/stripe-webhook
   ```
4. **Events to listen to**:
   Select: `checkout.session.completed`
5. Click **Add endpoint**.
6. Under **Signing secret**, click **Reveal secret** and copy the `whsec_...` value.

---

## 4. Required Production Environment Variables

Add these variables to **Vercel Production** (`vercel env add` or via Vercel Project Settings > Environment Variables):

| Variable Name | Example Value | Description |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_live_...` | Live Secret Key for `acct_1CW7vBJL3SekJtVV` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` | Signing secret from Webhook endpoint |
| `STRIPE_EXPECT_LIVEMODE` | `true` | `true` for Live mode, `false` for Test mode |
| `STRIPE_PRICE_ID_500` | `price_...` | 500 Credits ($30) Price ID |
| `STRIPE_PRICE_ID_1000` | `price_...` | 1,000 Credits ($48) Price ID |
| `STRIPE_PRICE_ID_2000` | `price_...` | 2,000 Credits ($96) Price ID |
| `VIDEO_OS_BILLING_ENABLED` | `true` | Enables customer-facing Checkout and webhooks |

---

## 5. Security & Verification Mechanics

The webhook handler (`api/video-os-lite/stripe-webhook-v2.js`) enforces:
1. **Raw Payload HMAC Verification**: Cryptographically validates Stripe signature header before parsing.
2. **Economic Package Verification**: Re-retrieves session from Stripe API to verify price ID, single quantity, and `payment_status: 'paid'`.
3. **Account Binding Integrity**: Enforces `client_reference_id === session.metadata.accountId`.
4. **Idempotency & Replay Protection**: Stores SHA-256 payload digest and Stripe Event ID in `stripe_events` table with transactional debit/credit locks.
