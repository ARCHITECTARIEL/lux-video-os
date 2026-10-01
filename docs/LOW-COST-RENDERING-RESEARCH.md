# Low-cost rendering research

Updated September 30, 2026. **This is a separate ROI research track.** The owner selected HeyGen for both Standard and Premium for the MVP. That decision remains the implementation path and is not blocked or replaced by this backlog. This document authorizes no provider change, model download, GPU run, image publication, endpoint mutation, production action, or spend.

“Free” and “open source” describe license or distribution claims only. They do not mean zero operating cost, commercial clearance, a free customer tier, or acceptable output. GPU time, speech generation, storage, egress, failed renders, human review, engineering, security, maintenance, and support all remain costs.

## Contract every alternative must preserve

Any candidate must fit the owner-confirmed product contract before cost can make it viable:

- Enrollment has exactly two user media submissions: one phone photo and one phone video.
- The photo defines the presenter’s visible appearance. A suit in the photo must remain the intended appearance even when the phone video shows a T-shirt.
- Audio may be derived privately from the enrollment video only under a distinct, explicit voice-cloning authorization bound to both the video hash and derived-audio hash. Uploading a video alone grants no voice-cloning right.
- After enrollment, both Standard and Premium take a new script. Neither tier asks for a new recording per video.
- Enrollment ownership, consent and revocation, account isolation, tier entitlements, idempotency, accepted-private-output rules, and exactly-once accounting survive a provider swap.
- A cheaper provider must never silently change the selected appearance, voice, tier, output format, privacy boundary, or release scope.

The canonical decision record is [owner-decision.json](standard-provider-provenance/owner-decision.json). It records `heygen_for_standard_and_premium_mvp`, keeps lower-cost research off the MVP critical path, and explicitly says that neither a customer free plan nor paid benchmarks are authorized.

## Evidence boundary

This scorecard uses the primary-source snapshot indexed in [provider-screening-evidence.json](execution-notes/scripted-photo-20260930/provider-screening-evidence.json) and the prior [Standard provenance inventory](standard-provider-provenance/INVENTORY.md). The private raw responses named by the index were read locally; they remain outside Git. The initial scorecard used those existing receipts; the dated R1 update below adds fresh primary-source metadata and exact code-license evidence.

The snapshot proves what the cited publisher pages said when captured. It does not prove current terms, complete dependency rights, installed bytes, deployed images, actual hardware needs, output quality, throughput, reliability, or cost. Refresh and pin evidence before a later decision.

## Candidate scorecard

No row is a quality ranking or legal approval.

| Candidate | Documented fit to the product | License evidence currently held | Required surrounding system | Material unknowns | Current R&D disposition |
|---|---|---|---|---|---|
| **InfiniteTalk** | Its publisher README says it supports image-to-video generation driven by image plus audio, which is directionally compatible with photo-defined appearance after authorized speech audio exists. It documents 480p/720p operation and warns that image-to-video runs beyond one minute can show more color shift. | Exact repository `LICENSE.txt` was captured at Git blob `261eeb9e9f8b2b4b0d119366dda99c6fd7d35c64` and is Apache-2.0. The README says the repository’s models are Apache-2.0. This does not cover the complete runtime merely because the top-level project uses Apache-2.0. | Script-to-speech generation using the enrolled voice; Wan2.1-I2V-14B base model; a Chinese Wav2Vec2 audio encoder; InfiniteTalk weights; finishing, validation, private storage, and the existing Video OS job/accounting envelope. | Exact revisions, bytes and terms for every model/dependency; whether the voice path can meet the owner contract; GPU/VRAM, cold start, throughput, failure rate, format normalization, long-run drift, and total accepted-output cost. | **Read-only qualification candidate.** Do not download or benchmark until its complete bill of materials and benchmark envelope are approved. |
| **LongCat-Video-Avatar-1.5** | The current publisher README documents Audio-Image-to-Video, 480p/720p modes, single-audio input, eight-step distillation, and an INT8 option. This is directionally compatible with photo plus generated speech audio. | The captured README displays an MIT license badge and says model weights and repository contributions are MIT unless otherwise stated. The later R1 capture below adds the exact repository MIT license and publisher model-file inventory at a recorded revision. Foundation/encoder/TTS dependency review, installed bytes and runtime qualification remain incomplete. | Script-to-speech generation using the enrolled voice; LongCat foundation and Avatar 1.5 artifacts; Whisper-large-v3 audio encoder path; multi-stage finishing and the Video OS control plane. Publisher examples for Avatar 1.5 use distributed launch arguments, which are not a measured minimum deployment requirement. | Exact runnable artifact graph, actual minimum GPU topology/VRAM, quantized-output tradeoffs, cold/warm latency, duration limits, format/output contract, dependency terms, failure rate, and accepted-output cost. | **Read-only qualification candidate.** Use the current `meituan-longcat/LongCat-Video` path; do not mistake the older announcement repository for a pinned runtime. |
| **LivePortrait as a component** | Its publisher README documents animating a source image from a driving video or motion template. The enrollment phone video could potentially contribute motion while the photo remains the visual source. LivePortrait alone does not turn arbitrary new scripts into matching speech and lip sync. | The initial screening receipt contains only the publisher README at Git blob `436a2aae0d0d3f5afd3c3f44c45f5724f5c3985b`. It does not contain an exact code license, weight license, or dependency inventory. No license conclusion is recorded here. | Authorized script-to-speech, an audio/lip-sync stage, motion-template governance, finishing, and the Video OS control plane. The design must prevent the enrollment video’s clothing or background from replacing the photo-defined appearance. | Exact licenses and weights; whether its motion can be reused safely across arbitrary scripts; lip-sync integration; temporal/identity stability; GPU/runtime profile; and whether the extra stages erase any cost advantage. | **Component-only research.** Do not compare its standalone runtime to an end-to-end HeyGen render; compare a complete pipeline that produces accepted scripted output. |
| **Legacy SadTalker profile** | The upstream project describes portrait-plus-audio generation, so its shape is relevant once authorized speech audio exists. | The project README announces Apache-2.0, but the retained legacy manifest includes a Wav2Lip-derived checkpoint whose upstream open-source record says noncommercial use. [RA-001](standard-provider-provenance/RA-001-sadtalker-wav2lip-license.md) explains why a project-level license label does not clear this exact component set. | Script-to-speech, a real worker, a fully reconciled model/component profile, immutable image/model identity, finishing, and the Video OS control plane. The checked-in SadTalker worker is transport/simulation scaffolding rather than a verified inference engine. | Whether a commercially usable exact profile exists without the restricted component; current quality and maintenance; full artifact graph; GPU profile; failure rate; and accepted-output cost. | **Hold/caution.** Do not revive the legacy image or rename its components. Resume only after an exact profile removes or separately clears every blocker. |

LatentSync alone is not on the scorecard because it lip-syncs an existing video and does not create the required animated-photo appearance. Its prior provenance work remains useful if a future multi-stage pipeline can justify it, but presence in the repository is not a reason to force it into this product contract.

## R1 progress - September 30

Fresh read-only LongCat qualification captured publisher revision `92016c71d5d318d0f5d84e4db30015a571484ab6` and 57 file records with reported sizes and available LFS SHA-256 values. The repository MIT license was retrieved and its 1063 bytes matched publisher Git blob `072123c866e9553f926e0e7bbcea9b8f29688641`. [Evidence and file inventory](standard-provider-provenance/roi-longcat-20260930/publisher-inventory.json), [archived code license](standard-provider-provenance/roi-longcat-20260930/LongCat-MIT.LICENSE.txt), [publisher model metadata](https://huggingface.co/api/models/meituan-longcat/LongCat-Video-Avatar-1.5?blobs=true).

The listed standard DiT shard group totals **31,706,008,384 bytes**; the alternative INT8 group totals **15,880,382,936 bytes**. These are storage-size observations, not measured VRAM requirements, total runtime downloads or cost estimates. Foundation, encoder, optional variants and speech-generation components still need a complete selected-runtime inventory. No model weight was downloaded and no GPU run occurred. This is useful qualification progress, not commercial clearance or a provider-switch recommendation.

## Cost per accepted output minute

Compare candidates only after applying the same acceptance contract and retention horizon. For a benchmark or operating period, calculate:

```text
cost_per_accepted_output_minute =
  (gpu_success
   + gpu_failed_and_retried
   + speech_generation
   + enrollment_compute_amortized
   + storage_and_retention
   + network_egress
   + finishing_and_validation
   + human_review
   + monitoring_support_and_incident_cost
   + engineering_security_and_compliance_amortized)
  / accepted_output_minutes
```

Rules for the calculation:

- The denominator includes only final minutes that pass media validation and the owner-approved likeness, voice, lip-sync, and usability review.
- Every failed, rejected, timed-out, duplicated, retried, or manually repaired attempt remains in the numerator.
- Cold starts, idle GPU reservation, model loading, intermediate files, output retention, download egress, and cleanup belong in the measured cost.
- Enrollment/avatar/voice setup cost is amortized over the accepted minutes actually produced by that identity, not an optimistic lifetime.
- “Self-hosted” does not remove speech-generation cost. Record a paid speech API charge or allocate its GPU/runtime cost, including failed synthesis.
- Engineering and review may be reported separately for operational visibility, but they must be included when deciding whether the alternative improves ROI.
- Use actual invoices, metering, logs, storage/egress records, and timed human review. Do not substitute advertised peak throughput or a license label.

The same formula applies to the HeyGen baseline using actual provider charges and the same local storage, finishing, validation, review, and failure accounting. This document does not estimate that baseline and does not set customer pricing.

## Break-even with unknown inputs

Let:

- `H` = measured HeyGen cost per accepted output minute under the same contract.
- `V` = measured alternative variable cost per accepted output minute, including failures, speech, GPU, storage, egress, finishing, and review.
- `F` = one-time qualification/integration/security/compliance cost plus fixed operating cost over the chosen comparison horizon.
- `N` = accepted output minutes over that horizon.

When `H > V`, the simple accepted-minute break-even is:

```text
N_break_even = F / (H - V)
```

When `H <= V`, there is no cost break-even in that horizon. A candidate may still have another strategic benefit, but that must be stated separately rather than relabeled as savings. Recalculate with low/base/high demand and failure-rate scenarios after the inputs are measured. Do not choose a candidate from this equation if it fails the product, consent, security, reliability, or quality gates.

## Benchmark acceptance contract

Before any paid run, write the exact thresholds and reviewer rubric into the authorization envelope. At minimum, every candidate must satisfy these non-negotiable gates:

1. **Product fidelity:** two user captures only; photo controls the visible presenter; derived voice is separately authorized; new scripts work without new recordings in both tiers.
2. **Appearance:** the suit-photo/T-shirt-video case retains the photo’s suit and appearance. The phone video may not silently become the visual source.
3. **Authorization:** exact photo, video, derived-audio, consent-version, account, entitlement, script, provider resource, and job bindings survive retries and fresh sessions; revocation blocks new work.
4. **Provider integrity:** immutable source, dependency, image and model identities are checked at runtime; simulation or a different model cannot satisfy real-inference proof.
5. **Media:** accepted bytes fully decode with the required audio/video streams, codecs, dimensions, duration tolerance, size, hash, private pathname, download match, and access denial.
6. **Reliability:** one logical request produces at most one provider submission and debit; timeouts, cold starts, failures, retries, cleanup, and manual-review frequency are measured.
7. **Human acceptance:** the authorized subject reviews appearance, voice, intelligibility, lip sync, temporal drift and visible artifacts using a rubric fixed before the run. Mock outputs and publisher demos do not satisfy this gate.
8. **Economics:** metering is complete enough to populate every material term in the accepted-minute formula. Missing cost data is a failed economic benchmark, not zero cost.

No quality score or pass percentage is prefilled here. Those thresholds must be chosen before seeing paid benchmark outputs so the result cannot be moved after the fact.

## R&D backlog

### Phase R0 — establish the comparable MVP baseline

- Instrument the selected HeyGen MVP so enrollment, render, failure/retry, finishing, storage/egress, review time, accepted duration, and provider charges can be correlated without logging secrets or customer media.
- Keep Standard and Premium labels separate from provider engine names and record the exact engine used by each accepted output.
- Collect enough accepted production-like evidence to calculate `H`; a configured account or successful API response is not a baseline.

### Phase R1 — read-only qualification

For each alternative, without downloading weights or starting compute:

- Pin repository commits, model-card revisions, file lists, byte counts, hashes, source URLs, and modification history.
- Inventory every inference-time model and dependency, including base models, audio encoders, face detectors, speech/TTS or voice-clone components, preprocessors, postprocessors, system packages, and model-downloading code paths.
- Archive exact code/model license texts and notices. Separate publisher labels from complete artifact review and record unresolved hosted-service, redistribution, patent, trademark, privacy, biometric, and acceptable-use questions for the appropriate reviewer.
- Trace the real input/output contract, resolution/aspect behavior, duration/chunking, audio muxing, expected GPU topology, VRAM guidance, quantization, cold-start behavior, and failure modes from pinned source.
- Design a provider-neutral adapter mapping that preserves the existing enrollment IDs, source/consent hashes, entitlements, job state, final-media acceptance, and rollback boundary.
- Produce an immutable candidate manifest, benchmark fixture plan, measurement worksheet, cleanup plan, and exact spend/retry envelope.

Candidate-specific read-only questions:

- **InfiniteTalk:** reconcile the Apache top-level/model statements with Wan2.1, Wav2Vec2, quantization and all transitive artifacts; pin the exact image-to-video command and duration strategy.
- **LongCat 1.5:** capture the exact LICENSE and model-card snapshots; determine the complete base/avatar/Whisper artifact graph and whether the documented distributed commands reflect a hard minimum or an example.
- **LivePortrait:** obtain exact code, weight and dependency terms; prove the role of a motion template and specify the complete speech-plus-lip-sync pipeline before estimating cost.
- **SadTalker:** either define a new exact profile with the restricted legacy component removed, or obtain the required rights; then prove that a real maintained worker exists before any benchmark request.

### Phase R2 — separately authorized paid benchmark

This phase requires a dated approval naming the candidate source/image/model digests, isolated target, GPU type/count, authorized private or synthetic fixtures, maximum jobs, maximum retries, time limit, spend ceiling, receipt location, cleanup, and stop conditions. Approval for the HeyGen MVP does not authorize this phase.

The benchmark should:

- Run outside production and leave production routing unchanged.
- Use the same authorized photo/video enrollment and derived-voice policy across candidates.
- Exercise predeclared script lengths, output formats, cold and warm starts, one controlled retry/failure case, and the suit-photo/T-shirt-video appearance case.
- Record GPU seconds and utilization, VRAM, model-load and render latency, speech-generation cost, attempt count, failure category, output/intermediate bytes, storage/egress, finishing time, review time, accepted duration, image/model identity, and cleanup evidence.
- Preserve private raw outputs and receipts outside the public repository; keep only safe hashes and references here.
- Stop on an unapproved dependency/model download, identity mismatch, consent ambiguity, simulated output, spend/retry limit, or inability to prove exact source/model identity.

### Phase R3 — decision

- Calculate the HeyGen and alternative accepted-minute costs over the same horizon and show sensitivity to demand, failure rate, retention, engineering amortization, and review load.
- Report contract/quality results separately from economics. A cheaper rejected output has no accepted minute.
- Recommend `continue`, `hold`, or `reject` with evidence. Do not silently promote a benchmark image or endpoint.
- Any provider migration needs its own reviewed implementation, data/resource migration, rollback plan, current-source CI/security proof, isolated integration, owner approval, and P0 acceptance.

## Provider-swap invariants

A future provider adapter may change. These product records and behaviors may not:

- The enrolled photo remains the appearance authority; the phone video and derived voice retain their distinct roles and consents.
- Existing source hashes, consent history, revocation, account ownership, archive state, and Standard/Premium entitlements remain authoritative.
- Provider resources are stored as provider-scoped derivatives of the same enrolled identity; they never replace the canonical source assets.
- User-facing identity and history remain stable. A migration must not create a second visible person, change wardrobe/appearance, substitute a stock voice, or require repeat enrollment without an explicit migration decision.
- The server owns provider selection, tier capabilities, pricing, input binding, idempotency, and artifact acceptance. No client flag can opt into an unapproved backend.
- Failure rolls back to the prior known provider/resource mapping without losing consent, history, credits, or accepted outputs.

## Source snapshot

- InfiniteTalk README: Git blob `8a8b242a496f3e7722194e1a6e04d686e953dd00`; exact Apache-2.0 `LICENSE.txt`: Git blob `261eeb9e9f8b2b4b0d119366dda99c6fd7d35c64`.
- Current LongCat-Video README containing Avatar 1.5 guidance: Git blob `9d6e54ad0c5ad07e66840f23349efca828f5b86f`.
- LivePortrait README: Git blob `436a2aae0d0d3f5afd3c3f44c45f5724f5c3985b`.
- Legacy SadTalker/Wav2Lip evidence: [RA-001](standard-provider-provenance/RA-001-sadtalker-wav2lip-license.md).

These identities are evidence anchors for this September 30 screen, not approved runtime pins.
