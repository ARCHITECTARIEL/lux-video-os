"""LatentSync inference runner, invoked by handler.py's _run_real().

CLI contract (unchanged from workers/sadtalker-runpod's runner convention,
just renamed env vars in handler.py -- see PROVENANCE.md):

    python runner.py --job <job.json> --manifest <model-manifest.json>
                     --model-dir <dir> --source-dir <dir>

`job.json` (written by handler.py) carries: jobId, sourceVideoPath,
audioPath, outputPath, timeoutSeconds.

Deliberate scope cut (documented, not an oversight): this still loads the
full model stack fresh on every invocation, because handler.py still spawns
this as a new subprocess per job (matching today's already-tested
contract). That means cold model-load cost (UNet + VAE + Whisper, several
GB) is paid on every single render, not once per warm RunPod worker -- a
real latency/cost multiplier flagged to the user as a known follow-up, not
fixed here to avoid mixing a bigger architectural change (subprocess-per-job
-> in-process-with-warm-cache) into this vendoring task and risking
breaking the one thing that already works. `load_pipeline()` and
`render_job()` are kept as separate, clearly-scoped functions specifically
so that refactor is a straightforward next step: a warm handler would just
call `load_pipeline()` once at startup and `render_job()` per job, instead
of this file's `main()` doing both every time.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _fail(message: str) -> "typing.NoReturn":  # noqa: F821 (typing import avoided on purpose)
    print(f"runner.py: {message}", file=sys.stderr)
    sys.exit(1)


def load_pipeline(model_dir: Path, source_dir: Path):
    """Build the LipsyncPipeline once. Heavy: imports torch/diffusers and
    loads several GB of weights onto the GPU. Kept separate from
    render_job() so a future warm-worker refactor can call this once and
    render_job() many times."""
    import torch
    from omegaconf import OmegaConf
    from diffusers import AutoencoderKL, DDIMScheduler

    sys.path.insert(0, str(source_dir))
    from latentsync.models.unet import UNet3DConditionModel
    from latentsync.pipelines.lipsync_pipeline import LipsyncPipeline
    from latentsync.whisper.audio2feature import Audio2Feature

    unet_config_path = source_dir / "configs" / "unet" / "stage2_512.yaml"
    if not unet_config_path.is_file():
        _fail(f"unet config not found at {unet_config_path}")
    config = OmegaConf.load(str(unet_config_path))

    unet_ckpt_path = model_dir / "latentsync_unet.pt"
    if not unet_ckpt_path.is_file():
        _fail(f"latentsync_unet.pt not found at {unet_ckpt_path} -- populate the model volume first")

    if config.model.cross_attention_dim == 768:
        whisper_model_path = model_dir / "whisper" / "small.pt"
    elif config.model.cross_attention_dim == 384:
        whisper_model_path = model_dir / "whisper" / "tiny.pt"
    else:
        _fail(f"unsupported cross_attention_dim {config.model.cross_attention_dim}")
    if not whisper_model_path.is_file():
        _fail(f"whisper checkpoint not found at {whisper_model_path} -- populate the model volume first")

    vae_local_dir = model_dir / "stabilityai" / "sd-vae-ft-mse"
    if not vae_local_dir.is_dir():
        _fail(
            f"VAE snapshot not found at {vae_local_dir} -- pre-cache "
            "stabilityai/sd-vae-ft-mse onto the model volume first "
            "(HF_HUB_OFFLINE=1 is set, so this will not fall back to a "
            "live Hub fetch)"
        )

    is_fp16_supported = torch.cuda.is_available() and torch.cuda.get_device_capability()[0] > 7
    dtype = torch.float16 if is_fp16_supported else torch.float32

    scheduler = DDIMScheduler.from_pretrained(str(source_dir / "configs"))

    audio_encoder = Audio2Feature(
        model_path=str(whisper_model_path),
        device="cuda",
        num_frames=config.data.num_frames,
        audio_feat_length=config.data.audio_feat_length,
    )

    vae = AutoencoderKL.from_pretrained(str(vae_local_dir), torch_dtype=dtype)
    vae.config.scaling_factor = 0.18215
    vae.config.shift_factor = 0

    unet, _ = UNet3DConditionModel.from_pretrained(
        OmegaConf.to_container(config.model),
        str(unet_ckpt_path),
        device="cpu",
    )
    unet = unet.to(dtype=dtype)

    pipeline = LipsyncPipeline(
        vae=vae,
        audio_encoder=audio_encoder,
        unet=unet,
        scheduler=scheduler,
    ).to("cuda")

    try:
        from DeepCache import DeepCacheSDHelper

        helper = DeepCacheSDHelper(pipe=pipeline)
        helper.set_params(cache_interval=3, cache_branch_id=0)
        helper.enable()
    except Exception as error:  # pragma: no cover -- best-effort perf optimization
        print(f"runner.py: DeepCache not enabled ({error}); continuing without it", file=sys.stderr)

    return pipeline, config, dtype


def render_job(pipeline, config, dtype, job: dict, source_dir: Path) -> None:
    import torch
    from accelerate.utils import set_seed

    video_path = Path(job["sourceVideoPath"])
    audio_path = Path(job["audioPath"])
    output_path = Path(job["outputPath"])
    if not video_path.is_file():
        _fail(f"source video not found at {video_path}")
    if not audio_path.is_file():
        _fail(f"audio not found at {audio_path}")

    seed = int(job.get("seed", 1247))
    if seed != -1:
        set_seed(seed)
    else:
        torch.seed()

    temp_dir = output_path.parent / "latentsync-temp"
    mask_image_path = source_dir / "latentsync" / "utils" / "mask.png"

    pipeline(
        video_path=str(video_path),
        audio_path=str(audio_path),
        video_out_path=str(output_path),
        num_frames=config.data.num_frames,
        num_inference_steps=20,
        guidance_scale=1.5,
        weight_dtype=dtype,
        width=config.data.resolution,
        height=config.data.resolution,
        mask_image_path=str(mask_image_path),
        temp_dir=str(temp_dir),
    )

    if not output_path.is_file():
        _fail("pipeline completed but produced no output file")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--source-dir", required=True)
    args = parser.parse_args()

    job_path = Path(args.job)
    manifest_path = Path(args.manifest)
    model_dir = Path(args.model_dir)
    source_dir = Path(args.source_dir)

    if not job_path.is_file():
        _fail(f"job file not found at {job_path}")
    if not manifest_path.is_file():
        _fail(f"model manifest not found at {manifest_path}")

    job = json.loads(job_path.read_text(encoding="utf-8"))

    try:
        pipeline, config, dtype = load_pipeline(model_dir, source_dir)
        render_job(pipeline, config, dtype, job, source_dir)
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001 -- deliberately broad: any failure here must fail the job clearly
        _fail(f"inference failed: {error}")


if __name__ == "__main__":
    main()
