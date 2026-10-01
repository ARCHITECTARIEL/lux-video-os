# Standard provider decision - photo-based output

Updated September 30, 2026. **Owner confirmed: the finished video must animate the uploaded photo.** Users provide a phone photo and a phone-recorded video. This supersedes the earlier recommendation to use the photo only as a thumbnail and the provisional direct-video LatentSync option B. The owner also confirmed one-time recording followed by scripts for BOTH Standard and Premium. HeyGen is now owner-selected for both MVP tiers; local enrollment and shared-script integration are implemented and verified in isolation; hosted/provider activation remains unverified. See the [runbook](PHONE-ENROLLMENT-RUNBOOK.md).

## Confirmed product roles

| Input | Role | Status |
|---|---|---|
| Uploaded photo | Visual source for the finished presenter: use the photo's appearance, including its clothing/look, rather than the phone video's appearance | Owner confirmed: "show the picture uploaded." |
| Phone-recorded video | One-time enrollment recording; its implemented local use is a reusable voice sample extracted internally under explicit subject consent | Record-once requirement confirmed; no new recording for each script, and no clone authority from upload alone |
| Script / generated speech | User enters a script for each Standard or Premium video; backend generates speech using the selected authorized voice | Owner confirmed scripts for both tiers; no per-video audio upload |

Concrete acceptance example: if the photo shows a suit and the phone video shows a T-shirt, the finished presenter should use **the suit/photo appearance**. The photo is not merely a thumbnail. This is an animated-photo/avatar outcome, not simply a relip-synced copy of the phone video.

## Phone-first intake

Ariel expects users to upload a photo from their cell phone and record a video from their cell phone. These are the two required user-facing media submissions. The local implementation includes bounded MP4/MOV/WebM handling, orientation metadata, guidance, media validation and capture controls. Real-device compatibility remains a hosted qualification task. Do not add a separate required audio upload solely because the current backend expects an audio asset.

## Architecture consequence

The existing LatentSync worker consumes video plus audio; it does not animate a still photo into a talking presenter by itself. It therefore cannot satisfy this selected outcome on its own. HeyGen is the selected photo-avatar provider for both MVP tiers; qualify the actual account and output before activation. LatentSync may be retained only if a necessary stage and its evidence justify it; it is not an owner-mandated engine.

Do not create a frozen video from the photo and call it real photo animation. Do not quietly substitute the phone video's appearance to fit the existing worker. Do not revive the legacy SadTalker transport without a real, qualified implementation and exact component review.

## Authority and remaining decisions

The latest explicit owner instruction controls. Historical commit `1c44925` and the prior provisional option B do not override it. [Machine-readable owner record](standard-provider-provenance/owner-decision.json).

Confirmed: record once, then use scripts for both tiers. Proposed video role: consented reusable voice enrollment, not visual appearance or motion transfer. Backend selected: HeyGen for both MVP tiers. Still open: supported photo engine and account economics/capabilities; the versioned input/output schema; commercial-use review; deployment and paid-inference authorization. No voice cloning, biometric verification, model training, image publication or deployment is implied by the capture requirement.

## Verified contract mismatch

- `services/sadtalker-runpod.js` constructs the provider request using `input.portrait` and `input.drivenAudio`.
- `workers/latentsync-runpod/handler.py` requires `input.sourceVideo` and `input.drivenAudio`; it explicitly rejects a portrait-only request. `runner.py` consumes a source-video file.
- `tests/sadtalker-runpod.test.mjs` protects the portrait envelope. Passing this test does not demonstrate LatentSync integration.
- The legacy `workers/sadtalker-runpod` path is transport/simulation scaffolding, not an independently verified replacement inference engine.
- LatentSync's handler hardcodes 512x512 response metadata and ignores the requested format; the pipeline can restore into source-sized frames. Neither establishes the application's required final dimensions. Any selected photo-animation pipeline needs a deliberate output-format/timing contract that passes actual decoded-media acceptance.

The audited mapping and missing contract work are captured in [the Prompt 5A execution note](execution-notes/20260930-prompt5a.md). The [provenance inventory](standard-provider-provenance/INVENTORY.md) separates local declarations, freshly verified publisher metadata, and unobserved deployed bytes.

## Upstream findings that affect the choice

SadTalker's upstream README describes a portrait-and-audio interface and announces Apache licensing, but the retained legacy manifest includes a Wav2Lip-derived checkpoint. Wav2Lip's upstream open-source section retains noncommercial-use restrictions. These records need reconciliation for the exact replacement model; neither a broad project announcement nor an old hash establishes clearance. See [the SadTalker/Wav2Lip record](standard-provider-provenance/RA-001-sadtalker-wav2lip-license.md), [SadTalker upstream](https://github.com/OpenTalker/SadTalker/blob/main/README.md) and [Wav2Lip upstream](https://github.com/Rudrabha/Wav2Lip/blob/master/README.md).

LatentSync's vendored code is Apache-2.0, while its checkpoint metadata identifies OpenRAIL++. Its maintainer points to CreativeML Open RAIL++-M terms, which include hosted-use conditions and use restrictions. The referenced terms are now archived with a verified upstream Git-blob match. They are **not owner/legal approval**. See [the checkpoint record](standard-provider-provenance/RA-002-latentsync-weights-openrail-license.md) and [maintainer clarification](https://huggingface.co/ByteDance/LatentSync/discussions/3).

## Next developer scope

1. Preserve the confirmed photo-based output and two-input phone capture requirement in the product contract.
2. Implement the confirmed record-once/script-driven contract. Design internal video-to-voice-sample extraction with explicit separate voice-cloning consent and immutable source/derived hashes; do not require a third user capture or assume motion transfer. Use the owner-selected HeyGen backend for both MVP tiers.
3. Qualify an actual photo-animation engine against the selected inputs, exact model/component terms, reproducible artifact identities and expected output quality. Existing LatentSync provenance remains useful research but does not establish suitability for this photo-based outcome.
4. Write the revised Prompt 5B implementation contract across browser, private uploads, consent, quote, source hashes, replay/recovery, adapter and worker. Bind the photo and any used video/audio to ownership and permission. Preserve final-media acceptance and exactly-once accounting.
5. Test the suit-photo/T-shirt-video example: final appearance must follow the photo. Also verify missing/changed inputs, revoked consent, model tampering, simulation rejection, duration/format correctness and cross-account denial.

This is a requirements update, not implementation or release evidence. No provider activation, GPU spend or production change is authorized here. The earlier A/B/C comparison remains historical in the Prompt 5A execution record; the current confirmed outcome above is the source of truth.

## Owner-selected MVP backend

Use HeyGen for both Standard and Premium. Continue low-cost/open-source alternatives as a separate, nonblocking ROI track; free license does not mean free compute. This decision permits local implementation planning/work, not live deployment, provider spend or a new customer-facing free plan. See [the execution plan](SCRIPTED-PHOTO-MVP-PLAN.md).
