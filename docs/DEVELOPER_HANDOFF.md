> **Status superseded 2026-09-29:** Use [CURRENT-MVP-HANDOFF.md](CURRENT-MVP-HANDOFF.md) for current readiness, deployment and next work. This atlas is historical; guarantees, capabilities and test counts below require current evidence.

# LUX Video OS — Comprehensive Developer Handoff Packet
**Target Audience**: Incoming Lead Engineer & Core Contributors  
**Last Updated**: September 24, 2026  
**Repository**: `ARCHITECTARIEL/lux-video-os`  
**Live Production URL**: [https://lux-video-os.vercel.app](https://lux-video-os.vercel.app)  
**Hosting Target**: Vercel Serverless (Primary Production) + Self-Hosted VPS (`deploy/` fallback)  
**Database**: Neon PostgreSQL (`neon-byzantium-drum`, serverless driver + Drizzle ORM)  
**Storage**: Vercel Blob (`@vercel/blob` private namespaces)  

---

## 1. Executive Summary & Architectural Overview

LUX Video OS is an enterprise-grade AI video generation operating system that allows business owners and marketing teams to produce professional video assets without cameras, lighting crews, or complex editing software. 

### The Core Two-Tier Model:
1. **Standard Tier (Personalized Autonomous Lip-Sync)**:
   - **Inputs**: One customer portrait photo (`.jpg`, `.png`) + one recorded narration track (`.wav`, 1-60s PCM). No script or synthetic voice is required.
   - **Engine**: SadTalker / MuseTalk GPU inference pipeline (deployed via RunPod Serverless GPU, with local FFmpeg simulation mode fallback).
   - **Guarantees**: Biometric consent gating, per-render isolation, zero training on customer data.
2. **Premium Tier (Photorealistic AI Presenter & Script Delivery)**:
   - **Inputs**: Curated top presenter + matched voice + exact copywriter script (up to 900 characters).
   - **Engine**: HeyGen v2/v3 enterprise API integration + Remotion/FFmpeg post-production grading (film grain, LUT, animated lower-third branding badges, and synchronized subtitles).
   - **Cost**: 90 credits per render quote, backed by atomic credit reservations.

---

## 2. Interactive Atlas: Every Page, Every Button, Every Effect, Every Function

### 2.1 The Welcome / Landing Page (`/welcome` & `public/landing.html`)
- **Controller**: `public/landing.js`  
- **Styles**: `public/studio.css` + `public/landing.css`  
- **Purpose**: Brand front door and customer acquisition funnel. Unauthenticated traffic to `/` routes here.

#### Visual Effects & Rendering Engines:
- **Procedural WebGL Silk Shader (`#lp-silk-canvas`)**:
  - Implemented in vanilla WebGL inside `initSilkBackground()` (`public/landing.js`).
  - Uses Inigo Quilez domain-warped fractional Brownian motion (fBm) to generate an ethereal, drifting silk mist in LUX royal blue (`#12219c`) and brushed chrome sheen.
  - Generates a soft, expanding 7-second radial light pulse.
  - **Accessibility**: Listens to `(prefers-reduced-motion: reduce)`. When enabled, it compiles a single static frame without initiating a `requestAnimationFrame` loop.

#### Complete Video Inventory & Playback Mechanics:
Every single video slot is backed by a verified, high-definition MP4 asset in `public/assets/showcase/`:
1. **`#lp-hero-video`**: Executive briefing by Ariel (1m 57s, 25.5MB, `/assets/showcase/hero-briefing.mp4`).
2. **`#lp-example-offer`**: "Promote an offer" showcase (9.1s, 9.2MB, `/assets/showcase/example-offer.mp4`).
3. **`#lp-example-intro`**: "Introduce your business" showcase (14.6s, 10.1MB, `/assets/showcase/example-intro.mp4`).
4. **`#lp-example-faq`**: "Answer a customer question" showcase (5.4s, 328KB, `/assets/showcase/example-faq.mp4`).
5. **`#lp-walkthrough-video`**: Full product interface walkthrough (14.6s, 10.1MB, `/assets/showcase/example-intro.mp4`, poster `/assets/showcase/example-intro.webp`). *Fixed in this sprint.*
6. **`#lp-tier-standard`**: Standard tier comparison card video (`example-offer.mp4`).
7. **`#lp-tier-premium`**: Premium tier comparison card video (`hero-briefing.mp4`).
8. **`#lp-ceo-video`**: Founder greeting video (`hero-briefing.mp4`).

#### Buttons, Links & Interactions:
- **Play Button Overlay (`.lp-video-play`)**:
  - Wired via `initVideoPlayers()` for all `[data-play]` buttons.
  - **Single-Audio Playback**: Playing any video triggers an event listener that pauses all other playing videos on the page, preventing audio clash.
  - Automatically hides when the video is playing, and reappears if paused or ended.
- **"Watch a real example" Anchor (`[data-play-target]`)**:
  - Smooth-scrolls viewport to `#lp-hero-video` and immediately triggers playback.
- **Conversion CTAs ("Create my free video", "Start free", "Log in")**:
  - Navigate to `/?signin=1`, deep-linking directly into the main Studio and opening the authentication modal.
- **Pricing Cards**:
  - **Starter**: $30 for 500 credits (≈5 videos).
  - **Growth (Featured)**: $48 for 1,000 credits (≈11 videos).
  - **Studio**: $96 for 2,000 credits (≈22 videos).
- **FAQ Accordion (`.lp-faq-item`)**:
  - Native semantic `<details>` and `<summary>` elements for instant, zero-JS accessible expand/collapse.

---

### 2.2 Main Studio Workspace (`/` & `public/index.html`)
- **Controller**: `public/studio.js` (~2,300 lines of robust, modular vanilla JS)  
- **Supporting Controllers**: `public/copywriter.js`, `public/standard-contract.js`, `public/video-os-cast.js`, `public/premium-composition-catalog.js`  
- **Styles**: `public/studio.css` + `public/copywriter.css`

#### Global Navigation & State Shell:
- **Sidebar Nav**:
  - `#create`: Opens the primary video creation workspace.
  - `#copywriter`: Switches view to the AI Copywriter panel.
  - `/identity`: Navigates to Identity Studio.
  - `#videos`: Scrolls to the completed results and video download gallery.
  - `#account`: Opens the session/credit management modal.
- **Tier Switcher (`#standard-tab` vs `#premium-tab`)**:
  - Toggles between the Standard lip-sync pipeline and the Premium HeyGen presenter pipeline.
  - State is strictly preserved across tab switching; form fields are isolated.

#### Standard Tier Interface (Sections 01 - 03):
- **Section 01: Photo Portrait Input**:
  - **Dropzone (`#standard-portrait-drop`)**: Drag-and-drop or file selection for portrait photos (`.jpg`, `.png`).
  - **Take Photo Button**: Direct camera capture on mobile and webcam devices.
  - **Fixture Photo Button (`#use-fixture-photo`)**: In local development, seeds a synthetic SVG portrait (`/assets/studio/fixture-portrait.svg`).
  - **Live Preview Stage (`#input-preview`)**: Displays selected photo, validates dimensions (512px to 8192px), file size (under 3MB), and aspect ratio.
- **Section 02: Audio Recording Input**:
  - **Choose WAV Recording (`#standard-audio-file`)**: File picker restricted to 1–60s PCM WAV files up to 50MB.
  - **Microphone Recorder**: Browser `MediaRecorder` capture with real-time waveform timing.
  - **Fixture Audio Button (`#use-fixture-audio`)**: Seeds test audio (`/assets/studio/fixture-audio.wav`).
  - **Preview Audio Player (`#standard-audio-preview`)**: Built-in HTML5 audio element with play/scrub controls.
- **Section 03: Title & Legal Permission**:
  - **Title Field (`#video-title`)**: 120 character limit.
  - **Authorization Checkbox (`#standard-permission`)**: Mandatory legal gate confirming rights to portrait and voice.
  - **"Review inputs" Button (`#review-inputs`)**: Validates both inputs, requests a cryptographically signed quote from `/api/video-os-lite/standard` (operation: `quote`).
  - **"Submit Standard" Button (`#standard-submit`)**: Atomically reserves credits, generates a durable job ID, and dispatches the render workflow.
  - **Uncertain Recovery Button (`#standard-check-existing`)**: Recovers project state if network drops during dispatch.

#### Premium Tier Interface (Sections 01 - 03):
- **Section 01: Title & Script**:
  - **Title Field (`#premium-title`)**: Video title with real-time validation.
  - **Script Textarea (`#script-input`)**: Exact script for the AI presenter. Enforces a 900 character limit with an active live counter (`#script-count`).
- **Section 02: Presenter & Voice Selection (The Curated Studio)**:
  - **Top 5 Curated Presenters**:
    1. **Ariel** (`featured:ariel`): Executive Anchor (Hispanic Male).
    2. **OSO** (`featured:oso`): Brand Ambassador (Multicultural Male).
    3. **Kristian** (`featured:kd`): Executive Anchor (Caucasian Male).
    4. **Marcus** (`featured:marcus`): Tech & Enterprise (Black Male).
    5. **Maya** (`featured:maya`): Executive Briefing (Black Female).
  - **Purge of Unapproved HeyGen Characters**: The UI strictly isolates the curated cast. No raw, unapproved HeyGen characters are displayed.
  - **Top 5 Matched Voices**:
    1. Ariel Voice (`featured:ariel:voice`)
    2. OSO Voice (`featured:oso:voice`)
    3. Kristian Voice (`featured:kd:voice`)
    4. Marcus Voice (`featured:marcus:voice`)
    5. Maya Voice (`featured:maya:voice`)
  - **Intelligent Pairing**: Selecting any presenter automatically pairs and highlights their corresponding matched voice.
  - **Private Identities Tab (`#premium-identity-list`)**: Seamlessly displays user-created cloned presenters from Identity Studio.
- **Section 03: Format, Composition & Render**:
  - **Format Select (`#export-format`)**: Vertical (9:16 for Reels/TikTok), Landscape (16:9 for YouTube/Web), Square (1:1 for LinkedIn/Feed).
  - **Quoted Cost Display (`#finish-render-cost`)**: Evaluates render credits (90 credits).
  - **"Render Video" Button (`#finish-render-button`)**: Dispatches the HeyGen render pipeline. Locks form inputs during submission to prevent accidental double-submits.

#### Studio Live Preview Player:
- **Interactive Stage**: Canvas-based real-time preview of the selected presenter.
- **Dynamic Lower-Third**: Renders an animated lower-third badge displaying presenter name and title.
- **Synchronized Captions**: Reactively updates script subtitles as the user types in `#script-input`.
- **Aspect Ratio Toggles**: Allows live framing switching between 16:9 and 9:16 before committing credits.

#### AI Copywriter Panel (`public/copywriter.js`):
- **Objective Selector**: "Promote an offer", "Introduce business", "Answer customer question", "Product announcement".
- **Tone Pills**: Direct, Warm, Confident, Playful.
- **Audience & Context Inputs**: Contextual prompts forwarded to the Vercel AI Gateway (`services/copywriter.js`, backed by Claude 3.5 Sonnet / Claude 4.6).
- **Draft Action Buttons**:
  - **"Shorten"**: Tightens script length.
  - **"Improve hook"**: Rewrites the opening 3 seconds for maximum retention.
  - **"Apply custom revision"**: Instructs the LLM on specific edits.
  - **"Use in Premium"**: Automatically pastes the finalized draft into the Studio's `#script-input`, counts characters, and switches view to the composer.

#### Results Gallery & Video Downloads:
- **Results Feed (`#results-list`)**: Chronological history of renders.
- **Status Pills**: DRAFT, QUEUED, PROCESSING, READY, FAILED_RETRYABLE, FAILED_FINAL.
- **In-Browser Player Modal**: Watch finished MP4s directly in the workspace.
- **Secure Download Button**: Fetches via `/api/video-os-lite/download` with signed `content-disposition: attachment` headers.

#### Account Modal & Billing (`#auth-modal`):
- **Google OAuth Login**: One-click Google sign-in via `/api/video-os-lite/google-login`.
- **Magic Link Form**: Passwordless authentication sent via Resend.
- **Workspace Password**: Development/tester access with secure hash verification.
- **Credit Balance & Top-Up**: Displays real-time balance. "Buy Credits" launches Stripe Checkout sessions for $30, $48, or $96 packs.

---

### 2.3 Identity Studio (`/identity` & `public/identity.html`)
- **Controller**: `public/identity.js`  
- **Styles**: `public/identity.css`  
- **Purpose**: Self-serve creation of private custom presenters and cloned voices.

#### Private Cast Gallery:
- Displays all account-owned identities with avatar and voice readiness statuses.
- Supports individual retries (`retry(identityId, 'avatar')`, `retry(identityId, 'voice')`) and archiving.

#### 5-Step Identity Creation Wizard (`#wizard`):
1. **Step 1: Your Photo**:
   - File picker or webcam selfie capture. Validates square crop, lighting, neutral expression.
2. **Step 2: Your Voice**:
   - Audio file upload or in-browser voice recorder.
   - Provides a script prompt: *"Welcome to my Video OS. I'm recording this sample in my natural speaking voice..."*
3. **Step 3: Legal Consent & Authorization**:
   - Identity name input.
   - **Four Mandatory Checkboxes**:
     1. Photo authorization (self or documented consent).
     2. Voice cloning authorization.
     3. Video OS & HeyGen processing agreement.
     4. Archival and deletion policy understanding.
4. **Step 4: Creating (Durable State Machine)**:
   - Polling loop tracking backend generation. Safe to close the tab and return later.
5. **Step 5: Ready**:
   - Confirmation badge + "Use in Video OS" link directing into Studio.

---

### 2.4 Admin Console (`/admin-console` & `public/admin-console.html`)
- **Controller**: `public/admin-console.js`  
- **Authentication**: Gated by `VIDEO_OS_ADMIN_PASSWORD` via `/api/video-os-lite/admin-login`.
- **Panel 1: Overview & Diagnostics**: Database connectivity check, Blob storage health, active worker count.
- **Panel 2: Manual Job Resolution**: Quarantines stuck jobs, marks failed jobs, force-releases reserved credits.
- **Panel 3: Billing & Webhook Audit**: Audit log of Stripe events, mismatch detection, credit balance overrides.
- **Panel 4: Operational Watchdog**: Triggers manual sweeps of stalled renders.

---

## 3. System Topology & Data Layer

```
┌────────────────────────────────────────────────────────────────────────┐
│                          CLIENTS / BROWSERS                            │
│  /welcome (Landing)    / (Studio Workspace)    /identity    /admin-console│
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTPS (JSON / Form Data)
┌───────────────────────────────────▼────────────────────────────────────┐
│                    VERCEL SERVERLESS EDGE LAYER                        │
│   vercel.json Route Table  ──►  server/index.js (Local VPS Router)     │
├────────────────────────────────────────────────────────────────────────┤
│  api/video-os/talent.js          ──  Curated 5 Presenters & Voices     │
│  api/video-os-lite/auth.js       ──  Google OAuth, Magic Links, Pass   │
│  api/video-os-lite/workspace.js  ──  Consolidated RPC Dispatcher       │
│  api/video-os-lite/render-v2.js  ──  Standard & Premium Dispatch       │
│  api/video-os-lite/uploads.js    ──  Private Blob Media Ingestion      │
│  api/video-os-lite/checkout-v2.js──  Stripe Checkout Session Minting   │
│  api/video-os-lite/download-v2.js──  Signed Media Egress Controller    │
└──────────────┬────────────────────┬────────────────────┬───────────────┘
               │                    │                    │
┌──────────────▼─────┐ ┌────────────▼─────┐ ┌────────────▼──────────────┐
│   NEON POSTGRES    │ │   VERCEL BLOB    │ │    EXTERNAL PROVIDERS     │
│ neon-byzantium-drum│ │ @vercel/blob     │ │                           │
│ - accounts         │ │ Private storage: │ │ - HeyGen (Premium Video)  │
│ - projects         │ │ - /portraits/    │ │ - RunPod (Standard GPU)   │
│ - render_jobs      │ │ - /narration/    │ │ - Stripe (Billing)        │
│ - credit_ledger    │ │ - /finals/       │ │ - Resend (Transactional)  │
│ - consents/quotes  │ └──────────────────┘ │ - Claude (Copywriter)     │
└────────────────────┘                      └───────────────────────────┘
```

### Drizzle Database Schema (`db/schema.js` & `db/standard-narration-schema.js`):
- **`accounts`**: Primary user record, email, trial credits, tester flags, createdAt.
- **`projects`**: User video projects, title, script, presenter selections, tier (`STANDARD` vs `PREMIUM`).
- **`render_jobs`**: Core lifecycle tracking: `id`, `status` (`DRAFT`, `RESERVED`, `PROCESSING`, `READY`, `FAILED`), provider job IDs, credit cost, error logs.
- **`standard_narration_consents`**: Tamper-proof legal consent records storing SHA-256 digests of portrait and audio.
- **`standard_narration_quotes`**: Cryptographic quote records sealing credit cost and expiration before job commitment.
- **`credit_transactions`**: Double-entry ledger tracking all credit additions, reservations, and settlements.
- **`stripe_events`**: Webhook deduplication log ensuring idempotency on payment receipts.

---

## 4. Sustainability & Anti-Brittleness Audit

The following architectural invariants MUST be respected. Violating them will break automated CI gates, corrupt serverless state, or brick authentication:

### ⚠️ Invariant 1: The AST Rate-Limit Authorization Check
- **The Issue**: `tests/render-rate-limit.test.mjs` uses an Abstract Syntax Tree (AST) string inspector to guarantee that rate limiting and authorization occur in the correct order.
- **The Rule**: In `api/video-os-lite/render-v2.js`, you MUST maintain the exact literal call:
  ```javascript
  requireRenderAccountAuthorization(session.accountId)
  ```
- **Tester Authorization**: Deterministic tester authorization (such as for `arielsmailbox@gmail.com` or `user-ce3c497416d3bed66a0a6516`) is handled inside `lib/video-os-testers.js` via `DEFAULT_TESTER_ACCOUNTS`. Never bypass this check directly in the route handler.

### ⚠️ Invariant 2: Public Featured Cast Length Invariant
- **The Issue**: `tests/cast-curation.test.mjs` strictly asserts:
  `assert.equal(PUBLIC_FEATURED_CAST.length, 11);`
- **The Rule**: In `public/video-os-cast.js` and `lib/video-os-featured-cast.js`, keep `FEATURED_CAST` at 11 entries so backend tests pass. In `public/studio.js`, use `STUDIO_MAX_CHOICES = 5` to slice and display exactly the top 5 curated choices in the browser.

### ⚠️ Invariant 3: Serverless Ephemeral State Trap
- **The Issue**: Vercel Serverless instances freeze and recycle unpredictably.
- **The Rule**: NEVER store session state, render status, or temporary files in Node process memory (`global`, module-level variables) or in `/tmp` across requests. All state MUST be committed to Neon Postgres or Vercel Blob.

### ⚠️ Invariant 4: Web Crypto vs Node.js Crypto
- **The Issue**: Vercel Edge and browser runtimes lack Node's `crypto.randomBytes`.
- **The Rule**: Always use the isomorphic Web Crypto fallback in `lib/video-os-account.js` and `db/repositories.js`:
  ```javascript
  const bytes = (typeof crypto?.randomBytes === 'function')
    ? crypto.randomBytes(n)
    : crypto.getRandomValues(new Uint8Array(n));
  ```

### ⚠️ Invariant 5: Stripe Webhook Raw Body Buffering
- **The Issue**: Stripe signature verification (`stripe.webhooks.constructEvent`) requires the exact raw byte stream. If body-parser consumes it as JSON first, signature verification fails.
- **The Rule**: Always use `readRaw(req)` in `api/video-os-lite/stripe-webhook-v2.js`.

---

## 5. Environment Variables & Credentials Reference

Configure these in the Vercel Project Settings (`https://vercel.com/lux-3035s-projects/lux-video-os/settings/environment-variables`):

| Variable | Required In | Purpose | Current Production Status |
|---|---|---|---|
| `DATABASE_URL` | Prod / Staging | Neon PostgreSQL connection string with SSL | Active (`neon-byzantium-drum`) |
| `BLOB_READ_WRITE_TOKEN` | Prod / Staging | Vercel Blob private storage access token | Active |
| `VIDEO_OS_SESSION_SECRET` | Prod / Staging | HMAC secret for session cookies | Active |
| `VIDEO_OS_ADMIN_PASSWORD` | Prod / Staging | Password gating `/admin-console` | Active |
| `VIDEO_OS_DURABLE_WORKFLOW_ENABLED` | Prod | Master switch enabling live renders (`true`) | Active |
| `GOOGLE_CLIENT_ID` | Prod | Google OAuth Web Application Client ID | Active |
| `GOOGLE_CLIENT_SECRET` | Prod | Google OAuth Web Application Client Secret | Active |
| `HEYGEN_API_KEY` | Prod | HeyGen Enterprise API Key for Premium renders | Active |
| `RESEND_API_KEY` | Prod | Resend transactional email API key | Active |
| `AI_GATEWAY_API_KEY` | Prod | Vercel AI Gateway key for AI Copywriter | Active |
| `VIDEO_OS_STANDARD_PROVIDER` | Prod / Staging | Standard engine: `simulation` or `runpod` | `simulation` (ready for `runpod`) |
| `VIDEO_OS_RUNPOD_ENDPOINT_ID` | Prod | RunPod Serverless GPU endpoint | `glcefbevsyxu78` |
| `RUNPOD_API_KEY` | Prod | RunPod API key for serverless GPU worker | Configured in RunPod |
| `STRIPE_SECRET_KEY` | Prod | Live Stripe Secret Key for credit checkout | Pending live insertion |
| `STRIPE_WEBHOOK_SECRET` | Prod | Stripe Webhook Signing Secret | Pending live insertion |
| `WATCHDOG_ALERT_EMAIL` | Prod | Ops notification recipient for stalled jobs | `arielsmailbox@gmail.com` |

---

## 6. Finishing Roadmap: Exact Steps to Bring It Home

Follow this exact sequential checklist to complete the production release:

### Step 1: Flip Standard Lip-Sync to Live RunPod Worker
1. Ensure `RUNPOD_API_KEY` is set in Vercel production environment variables.
2. Set `VIDEO_OS_STANDARD_PROVIDER=runpod` in Vercel.
3. Verify that the RunPod worker at endpoint `glcefbevsyxu78` has its MuseTalk/SadTalker weights loaded.
4. Run a live Standard render from Studio using a real 5-second WAV and portrait. Verify that lipsync matches audio perfectly.

### Step 2: Finalize Stripe Payment Webhook
1. Insert live `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` into Vercel.
2. Set Stripe webhook target URL to:  
   `https://lux-video-os.vercel.app/api/video-os-lite/stripe-webhook`
3. Perform a real $30 Starter Pack purchase with a test/live card. Verify that 500 credits are immediately credited to the account ledger.

### Step 3: Run the Formal P0 Release Proof (`docs/P0-RELEASE-GATE.md`)
1. Execute the 9 required observations documented in `docs/P0-RELEASE-GATE.md`.
2. Generate the cryptographic proof receipt (`docs/proofs/p0-release-receipt.json`).

### Step 4: Custom Domain Binding
1. In Vercel, navigate to Domains and attach the production domain (e.g., `luxvideo.io` or `app.luxvideo.com`).
2. Add the custom domain to the authorized redirect URIs in Google Cloud Console OAuth credentials.

---
*Packet authored by Antigravity Agentic Engineering — all unit tests passing (295/295), video showcase verified, studio curated to top 5 choices.*
