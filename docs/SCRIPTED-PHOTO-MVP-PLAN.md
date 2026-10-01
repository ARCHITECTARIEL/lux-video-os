# Scripted photo MVP: enroll once, use both tiers

Updated September 30, 2026. **Owner confirmed HeyGen for BOTH Standard and Premium for the MVP.** This plan supersedes the per-render Standard narration-upload direction. It does not authorize deployment, provider enrollment calls or paid inference.

## Confirmed experience

1. During setup, upload a phone photo and record one phone video.
2. The uploaded photo determines the visible presenter in the finished video. A suit in the photo remains the intended appearance even if the enrollment video shows a T-shirt.
3. After setup, enter a new script for each **Standard or Premium** video. Do not ask the user to record or upload narration again for each script.

Implemented local use of the setup recording: extract its audio privately as the reusable voice sample, with a distinct, explicit voice-cloning consent. The resulting `sourceVoiceAssetId` is an internal derived asset, not a third user upload. Bind original video and derived audio hashes to consent; a video upload alone never grants cloning authority. This does not imply motion imitation, biometric identity verification or a full video-trained digital twin.

## Provider screening

| Path | Documentation fit | Repository reuse / remaining qualification |
|---|---|---|
| **HeyGen photo avatar + instant voice clone** | Creates an avatar from the photo, a reusable voice from one recording, and future videos from script + avatar ID + voice ID | **Recommended first-MVP candidate for smallest implementation.** These v3 adapters already exist in `services/heygen.js`. Account availability, clone allowance, actual pricing, privacy terms and real output quality are unverified. The owner explicitly approved using HeyGen for Standard and Premium for the MVP; actual account pricing and limits still need verification before activation. |
| **Self-hosted audio-driven photo model** | InfiniteTalk documents image+audio generation; the newer LongCat-Video-Avatar-1.5 documents audio-image-to-video | Genuine candidates for the photo outcome, unlike direct LatentSync. Require separate reusable speech generation, complete component/model/license inventory, immutable images, GPU sizing, output-format integration and real quality/cost benchmarks. No model has been selected, downloaded or exercised here. |
| **LivePortrait** | Animates a photo from a driving video | A possible motion-transfer component, not a standalone solution for fresh scripts and speech. Reusing the original recording's mouth motion would not prove lip sync to new words. Additional speech/lip-sync stages and component rights need qualification. |
| **LatentSync alone** | Lip-syncs existing video to audio | Does not create the required animated photo. Keep its provenance research; do not force the selected product into this worker. |

Primary sources: [HeyGen Photo Avatar](https://developers.heygen.com/photo-avatar.md), [HeyGen Instant Clone](https://developers.heygen.com/docs/voices/instant-voice-clone.md), [InfiniteTalk](https://github.com/MeiGen-AI/InfiniteTalk), [current LongCat-Video/Avatar repository](https://github.com/meituan-longcat/LongCat-Video), [LivePortrait](https://github.com/KlingAIResearch/LivePortrait). This is a documentation-fit screen, not production qualification. Publisher license labels do not replace an exact dependency/model review.

HeyGen's current docs support photo avatars on Avatar III and IV; they do not advertise Photo Avatar support on Avatar V. Read each look's `supported_api_engines` before routing. Do not equate a provider engine's marketing name with our Standard/Premium tiers. Preserve explicit output dimensions rather than blindly using provider `auto` aspect ratio. [Models and compatibility](https://developers.heygen.com/models.md), [create-video schema](https://developers.heygen.com/reference/create-video.md).

The photo-avatar API has no digital-twin consent API step, but the provider explicitly still requires the subject's permission. Keep application consent and revocation checks. Voice enrollment remains separately consented. A provider account's ability to accept uploaded digital-twin consent is not evidence that this photo-avatar path needs, or is entitled to bypass, that different process. [Photo enrollment](https://developers.heygen.com/docs/avatar-from-photo.md), [provider consent distinctions](https://developers.heygen.com/docs/avatar-consent.md).

## Existing implementation to reuse

- `public/identity.html` / `public/identity.js`: current photo and voice capture, preview, enrollment status. Extend the capture contract to a phone video; do not create an unrelated enrollment UI.
- `lib/identity-upload.js`, `api/video-os-lite/uploads.js`: private asset storage and hashes. The current generic video path is not sufficient identity-video validation, and base64 JSON is not a suitable transport for typical phone clips.
- `db/schema.js`, `db/repositories.js`: account-owned identities, asset references, consent versions, provider readiness, retry/reservation and revocation. Add the source-video/derived-audio relationship and provider-resource/source binding.
- `routes/video-os-lite/identities.js`, `services/heygen.js`: async photo-avatar and voice provisioning. Keep photo bytes exclusive to visual enrollment; pass only authorized derived audio to voice enrollment.
- `workflows/video-render.js`, `db/repositories.js`, `services/final-media-validation.js`: durable script rendering, accepted private media, output hashes, exactly-once debit and recovery.
- `db/standard-narration-repository.js`: useful quote, replay and source-binding patterns. Preserve v1 history; implement the new script contract as a new version rather than reinterpreting old rows.

## Current implementation checkpoint

The local enrollment and shared-script implementation now covers the capture, consent, derived audio, owned project, quote, recovery and UI slices. Real isolated DB/Blob/FFmpeg evidence and browser checks are recorded in [the execution note](execution-notes/20260930-phone-enrollment.md); operational details are in [the runbook](PHONE-ENROLLMENT-RUNBOOK.md). All activation flags remain off by default. Existing HeyGen adapters are integrated with consent, source and provider-receipt guards, but no live provider enrollment or rendering was executed. The ordered slices below remain the design contract; do not mistake their imperative wording for missing local implementation. Hosted/device/provider acceptance and release prerequisites are the next work.

## Ordered implementation slices

### 1. Repair the current Premium request boundary

The browser sends `tier: PREMIUM`, while the strict Premium request schema omitted it. Accept only that optional literal and canonicalize it away so legacy requests and idempotency payloads retain the same shape. Continue rejecting Standard/unknown/null tiers and all unrelated/server-controlled fields. Preserve existing authorization and voice-selection policy.

### 2. Add the two-input enrollment contract without provider calls

Add a dedicated private identity-video upload with bounded transport and decoded validation for supported phone formats, dimensions, duration, audio presence and SHA-256. Establish actual codec/orientation support before promising all phone files will work. Extract and validate the voice sample in a bounded background operation using existing media tooling where supported. Persist source-video ID/hash, derived-audio ID/hash, extraction version and account ownership. Never use generic shallow MP4 signature checking as enrollment proof.

Consent must explicitly cover photo animation and reusable voice generation, reference the exact source/derived assets and policy version, and remain revocable. Replacing a source invalidates old readiness/consent bindings. An interruption must resume existing enrollment rather than create duplicate provider resources. Existing Standard/Premium entitlement separation remains intact; access to shared enrollment must not silently grant Premium rendering.

### 3. Connect one-time provisioning to the chosen backend

For the HeyGen candidate, reuse private asset uploads, photo-avatar creation, instant voice clone submission and polling. Persist provider resource IDs against the exact source hashes and consent record. Readiness requires successful avatar and voice components. Do not recreate them for each script, silently substitute a stock voice, or retry ambiguous remote submissions without reconciliation. Existing explicit shared-voice selections remain a separate policy choice and are not removed by this plan.

For a self-hosted Standard path, add provider-scoped resource records and a separately qualified speech-generation adapter. Do not overload HeyGen IDs or assume a clone can be exported to another model. Pin every required model/config file and image digest before any real inference.

### 4. Introduce a shared script-driven request contract

Client references should include identity, script, title, format, tier, idempotency key and a server-issued quote. The server resolves permitted avatar/voice resources and backend selection. Bind script hash, identity/consent version, provider-resource identity, format, pricing version and expiry into reservation/replay handling. Reject client-controlled provider IDs, costs, readiness flags and artifact proofs. Final authorization is checked again when claiming provider work.

No per-video narration upload is required. If the provider renders directly from script and voice ID, do not add a redundant paid TTS call merely to imitate the old narration workflow. If a self-hosted model needs audio, generate it once in a durable, authorized, idempotent step and bind its resulting bytes to that job.

### 5. Migrate Standard and retain Premium behavior

Add a new scripted-photo Standard contract, leaving `standard-narration-v1` data explicitly versioned and historical. Both tiers use the same ready enrolled presenter by default and accept new scripts. Tier-specific capabilities, limits and prices remain server-owned; do not invent a higher-tier engine or advertise unsupported finishing options. Standard/Premium differentiation and margins must be checked against the chosen backend's actual pricing before activation.

### 6. Update the phone-first interface after backend contracts exist

Use the reference-first UI workflow before changing screens. Show photo upload and one video recording during setup, explicit consent, processing/retry state and a reviewable presenter/voice preview. After setup, both tiers expose scripts, not repeated audio capture. Refresh/re-login must recover enrollment and jobs from persisted state. Provider details belong in diagnostics rather than the customer flow.

### 7. Verify the complete contract locally and on isolated resources

- Upload rejection: malformed/truncated media, missing audio, unsupported formats, orientation/size/duration boundaries, cross-account references and replay.
- Consent: exact photo/video/derived-audio hashes; replacement, revocation and archived identity block provisioning and subsequent rendering.
- Enrollment: photo alone drives appearance; only consented derived audio enters voice cloning; no provider calls while gates are closed; interruption/retry produces one logical avatar and voice enrollment.
- Render: enroll once, then submit different scripts through Standard and Premium without another recording. Assert script/quote tampering rejection, correct default enrolled voice, explicit voice-override policy, proper tier entitlement and one reservation/submission/debit.
- Media: suit-photo/T-shirt-video appearance check, supported format/duration/audio, full decode and matching private download bytes. Mock payloads cannot establish real likeness/voice quality; the later authorized canary must include subject review.

### 8. Prepare a separately authorized rollout

Require account capability/clone allowance/pricing verification, current-source CI/CodeQL, migrations and storage proof, the existing Sandbox boundary repair, exact candidate identity and all P0 evidence. Prepare a one-time enrollment and bounded per-tier render proposal with spend ceiling and rollback; do not activate calls from this plan alone.

## Backend decision and separate ROI track

**Owner decision: use HeyGen for Standard and Premium for the MVP.** Do not ask this choice again or route new Standard scripts to the legacy RunPod worker. Implement the shared HeyGen contract locally behind explicit containment; external enrollment, rendering and deployment still require the bounded release scope.

Keep evaluating free/open-source models and self-hosted rendering as a separate ROI track. Compare total cost per accepted output minute, including GPU/TTS, cold starts, retries, storage, egress, operator work and engineering amortization. A free model license is not zero operating cost. Do not introduce a customer-facing free plan, prices or credits from this research request. A later provider swap must preserve the photo appearance, reusable voice, consent, ownership, tier entitlements and acceptance/accounting guarantees.

[Lower-cost research backlog](LOW-COST-RENDERING-RESEARCH.md) tracks candidate screening and benchmark gates independently of MVP delivery.

Before release, scope the release manifest to the actual enabled providers. RunPod image/model/license proofs are not prerequisites for a strictly HeyGen-only MVP once legacy RunPod submission paths are proven disabled. They remain mandatory for any later self-hosted activation. The current conservative manifest still emits a generic worker-image gate; do not silently clear it or claim a HeyGen release is ready until the rollout scope and disabled legacy paths are verified.

Evidence: [provider screening receipts](execution-notes/scripted-photo-20260930/provider-screening-evidence.json), [current owner decision](standard-provider-provenance/owner-decision.json).
