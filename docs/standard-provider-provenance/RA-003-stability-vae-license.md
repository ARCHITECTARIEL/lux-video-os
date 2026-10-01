# RA-003 — Stability VAE evidence

Recorded September 30, 2026. **Publisher license declaration verified; exact service-use review and deployed snapshot verification pending.** This is a research record, not approval.

The model card for `stabilityai/sd-vae-ft-mse` at revision `31f26fdeee1355a5c34592e401dd41e45d25a493` declares `license: mit`. Its README bytes were recovered and matched publisher Git blob `61d3c7cf571c574a406544612b857ac1b26f4439` / 6,844 bytes. The repository listing has no standalone LICENSE file; a request for `/raw/main/LICENSE` returned no usable page. Preserve the distinction between a model-card declaration and an archived license/attribution record for the selected artifact. Do not copy LatentSync's OpenRAIL++ label onto this separately sourced component. [Pinned model card](https://huggingface.co/stabilityai/sd-vae-ft-mse/blob/31f26fdeee1355a5c34592e401dd41e45d25a493/README.md), [publisher file metadata](https://huggingface.co/api/models/stabilityai/sd-vae-ft-mse?blobs=true).

Verified publisher candidates at that revision:

| File | Bytes | SHA-256 |
|---|---:|---|
| `diffusion_pytorch_model.safetensors` | 334,643,276 | `a1d993488569e928462932c8c38a0760b874d166399b14414135bd9c42df5815` |
| `diffusion_pytorch_model.bin` | 334,707,217 | `1b4889b6b1d4ce7ae320a02dedaeff1780ad77d415ea0d744b476155c6377ddc` |
| `config.json` | 547 | `92d3dfb746fca211a2c9e019e285f8597412211728dce3c5bcf4eda0f2d62e7e` |

The two weight rows come from [the pinned safetensors pointer](https://huggingface.co/stabilityai/sd-vae-ft-mse/raw/31f26fdeee1355a5c34592e401dd41e45d25a493/diffusion_pytorch_model.safetensors) and [the pinned bin pointer](https://huggingface.co/stabilityai/sd-vae-ft-mse/raw/31f26fdeee1355a5c34592e401dd41e45d25a493/diffusion_pytorch_model.bin); no weight bytes were fetched. The small [archived config](upstream/vae-config.json) was actually retrieved and hashed, with exact publisher Git-blob match `0db26717579be63eb0ddbf15b43faa43700dfe5a`.

The active worker loads an unversioned local VAE directory via `AutoencoderKL.from_pretrained`. Neither filename above is established as the deployed selection. Select the format explicitly, lock the complete required file set, and verify actual mounted bytes before loading. `HF_HUB_OFFLINE=1` prevents a network fallback; it does not prove identity or prevent altered local files.

The old manifest's `NOT_APPLICABLE_HF_SNAPSHOT` hash label is not an adequate integrity policy: a snapshot can and should have per-file hashes plus a deterministic aggregate manifest. Prompt 5A leaves the runtime manifest unchanged. Prompt 5B must replace that gap after the owner chooses the Standard contract.
