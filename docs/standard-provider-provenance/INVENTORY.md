# Standard worker and model provenance inventory

Audited September 30, 2026 for Prompt 5A. **Inventory complete for the inspected repository and publisher records; deployed model/image verification remains incomplete.** No worker code, runtime manifest, endpoint, model volume or image was changed. This document is not commercial-use approval or inference proof.

Later owner clarification: output must animate the uploaded photo, with a supporting phone video. This LatentSync inventory remains research evidence, not proof that LatentSync can satisfy that photo-animation outcome.

Decision: [Standard options and owner decision](../STANDARD-PROVIDER-DECISION.md). Machine-readable evidence: [artifact inventory](artifact-inventory.json), [actual local worker file hashes](local-worker-files.json), [upstream receipts and exact small-artifact checks](upstream-evidence.json).

## Source identity

The local LatentSync manifest declares ByteDance commit `a229c3948406bc2cf6eaf4873e662e70c6a04746` and profile `1.6-stage2_512-mediapipe-face-detector`. The source provenance document describes two intentional modifications: replacing InsightFace with MediaPipe and reusing the previous face transform after certain detection failures. These modifications mean the runtime is not an unmodified upstream tree.

The actual checked-out worker tree has 58 inventoried files. Each file's byte count and SHA-256 is recorded separately. The vendored Apache LICENSE was independently matched, after LF normalization, to the exact upstream Git blob at the declared commit. This checks the license copy; it is not an independent full-tree reproduction check. [Upstream code license](https://github.com/bytedance/LatentSync/blob/a229c3948406bc2cf6eaf4873e662e70c6a04746/LICENSE), [local provenance](../../workers/latentsync-runpod/source/PROVENANCE.md).

At repository HEAD, the worker Git tree is `cc0067d6a0d2317861867eec415b8f03aa580b61` and its `source/` subtree is `de08687566d1e579af1bf17c74b90cfe71d477a5`. Worker/image-workflow files remain unchanged from merge `0b9cfa672d85fc6a6a232eb94e49cdb1013fcbdc`. These Git identities and the local byte ledger serve different purposes: the ledger also captures actual checkout bytes, including line endings.

## Artifact identity and evidence levels

| Artifact | Expected bytes | Identity source | Current proof limit |
|---|---:|---|---|
| LatentSync U-Net | 5,072,222,488 | Pinned publisher LFS pointer; SHA-256 matches the existing declared `0a478e89...e98316d3` | No weight download/readback this session; old runtime manifest still has null byte count and mutable `main` URL |
| Whisper tiny | 75,572,083 | Pinned publisher LFS pointer; SHA-256 matches existing `65147644...0ce22b9` and the local Whisper upstream URL's hash | No mounted-file readback; runtime byte count remains null |
| VAE safetensors candidate | 334,643,276 | Pinned publisher LFS pointer, `a1d99348...42df5815` | Candidate format only; not the established deployed selection |
| VAE bin candidate | 334,707,217 | Pinned publisher LFS pointer, `1b4889b6...6377ddc` | Alternative format; do not silently permit either file as equivalent |
| VAE config | 547 | Exact retrieved bytes, Git blob and SHA-256 `92d3dfb7...2d62e7e` | Archived audit copy; not a mounted-runtime readback |
| MediaPipe face task | 3,758,596 | Existing local self-computed claim, `64184e22...e0bc9ff`; Docker build checks that hash | Blob not present in this checkout or re-downloaded; no current image/volume readback |

Full hashes, immutable candidate revisions, pointer URLs, evidence methods and deployment-verification flags are in [artifact-inventory.json](artifact-inventory.json). U-Net/Whisper candidates use HF revision `c42c7e6c8e9c213626389fa7d9a3c444b8536353`; VAE candidates use `31f26fdeee1355a5c34592e401dd41e45d25a493`. These are **proposed pins discovered during research**, not changes to provisioned resources. [U-Net pointer](https://huggingface.co/ByteDance/LatentSync-1.6/raw/c42c7e6c8e9c213626389fa7d9a3c444b8536353/latentsync_unet.pt), [Whisper pointer](https://huggingface.co/ByteDance/LatentSync-1.6/raw/c42c7e6c8e9c213626389fa7d9a3c444b8536353/whisper/tiny.pt), [VAE record](RA-003-stability-vae-license.md).

No large model blob or VAE runtime directory was found in the inspected repository paths. Historical GPU/hash statements remain historical claims unless backed by their original receipts or a new exact readback. Publisher LFS metadata is stronger than an unreferenced local label, but it is not a self-computed hash of deployed bytes.

## License records

| Component | Evidence | Remaining review |
|---|---|---|
| LatentSync source | Vendored Apache-2.0 license matches pinned upstream Git blob | Preserve modification/attribution notices and audit retained third-party components |
| LatentSync U-Net | Model metadata: OpenRAIL++; maintainer points to CreativeML Open RAIL++-M. Exact referenced terms now archived | Applicability and hosted/downstream obligations for the chosen checkpoint and service. [RA-002](RA-002-latentsync-weights-openrail-license.md) |
| VAE | Pinned model card declares MIT; exact config and publisher weight identities captured | Complete license/attribution record and exact selected snapshot/format review. [RA-003](RA-003-stability-vae-license.md) |
| Whisper code and weights | OpenAI explicitly states both are MIT; exact license copy archived | Preserve MIT notice in the distributed image and review the retained LatentSync fork. [Upstream README](https://github.com/openai/whisper/blob/main/README.md#license), [archived MIT license](upstream/Whisper-MIT.LICENSE.txt) |
| MediaPipe task components | Official FaceDetector, FaceMesh-V2 and Blendshape model cards each identify Apache-2.0 | Bind those component records to the exact selected task bundle and preserve notices; current image bytes remain unverified |
| Legacy portrait alternative | SadTalker project announcement and Wav2Lip component restriction require exact-profile reconciliation | No blanket clearance or approved replacement. [RA-001](RA-001-sadtalker-wav2lip-license.md) |

MediaPipe evidence is based on the model cards, not the documentation footer's separate code-sample license: [official bundle mapping](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker), [FaceDetector card](https://storage.googleapis.com/mediapipe-assets/MediaPipe%20BlazeFace%20Model%20Card%20(Short%20Range).pdf), [FaceMesh-V2 card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Face%20Mesh%20V2.pdf), [Blendshape card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Blendshape%20V2.pdf).

The RA-002 and RA-003 records were absent when this audit began; they now exist here as **pending-review research records**. Their creation does not clear a release gate. Runtime manifest fields remain unchanged and are not interpreted as licenses by the worker.

## Runtime and image gaps

1. **Manifest existence is not verification.** Handler/runner check that a manifest file exists but do not parse and enforce its artifacts, hashes, bytes or revisions. Source/model/manifest directories are environment-overridable. Hash output video bytes does not establish which model produced them.
   The runtime also consumes the selected U-Net YAML, scheduler config, mask, Whisper tokenizer assets and mel filters. They are included in the local source ledger but omitted from the runtime `requiredArtifacts`; a complete identity contract must bind them too.
2. **Heavy models are external mutable files.** The runner loads U-Net/Whisper and an unversioned VAE directory from the model path. Offline mode only prevents Hub fallback. No complete mounted-file attestation/provisioning record was found.
3. **Build identity is incomplete.** Docker uses a version tag for the base image, not a digest. Direct Python dependencies are version-pinned, but apt packages and transitive dependencies lack a complete hash lock. CI emits `latest` and source-SHA tags, sets `provenance: false`, and records no deployment-bound digest/SBOM/signature in this checkout. A source-SHA tag is not immutable image-byte proof.
4. **No current deployed identity.** No readback of an active endpoint's selected digest or mounted weights was performed. The release manifest correctly retains `WORKER_IMAGE_IDENTITY_UNVERIFIED`.
5. **Output contract needs explicit integration.** The handler reports 512x512 metadata and does not consume requested aspect/format. The pipeline restores generated faces into original video frames, so this metadata is not proof of encoded output dimensions. No format-normalization contract is established. Final acceptance requires actual decoded 1920x1080, 1080x1920 or 1080x1080 bytes, plus the agreed timing/audio/hash checks. Do not weaken acceptance to make an incompatible worker pass.

## Required proof after the owner's choice

Before model loading, verify a versioned immutable manifest against every required file's bytes and SHA-256, selected source/config revision, declared model profile and complete file set. Reject missing, extra/substituted or mutated required artifacts, changed VAE format and unsupported configuration. Preserve original errors and never turn failure into simulation.

Bind the final image digest and model-manifest digest into private execution evidence, alongside source input hashes, provider job identity and final output hash. Exercise cold start, missing/tampered models, simulation rejection, adapter/handler schema compatibility, duration/format correctness and retry/idempotency behavior. The implementation lane should use local tests first; actual GPU/image publication/endpoint changes require the separately authorized scope.

Owner/legal review of the exact artifacts and hosted use, plus real provider and P0 proof, remain prerequisites. This inventory supplies the next developer with verifiable candidate identities; it does not activate a provider.
