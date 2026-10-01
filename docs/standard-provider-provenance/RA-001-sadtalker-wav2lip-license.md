# RA-001 — Portrait-worker qualification caution

Recorded September 30, 2026. **Alternative-provider research only; no SadTalker worker or model selected or cleared.**

SadTalker's upstream README describes a portrait-plus-audio interface and announces Apache-2.0 licensing with removal of its earlier noncommercial restriction. That supports its relevance as a candidate for option A; it does not establish that this checkout's legacy component set is suitable for paid use. [SadTalker README](https://github.com/OpenTalker/SadTalker/blob/main/README.md).

The carried-over reference manifest declares the old `wav2lip.pth` checkpoint at SHA-256 `b78b681b68ad9fe6c6fb1debc6ff43ad05834a8af8a62ffc4167b7b34ef63c37`, alongside face-render and reconstruction components. This is a historical inventory, not a current approved runtime. [Local reference manifest](../video-os/research-carried-over/workers-sadtalker-reference/model-manifest.json).

Wav2Lip's current upstream README separately labels its open-source model noncommercial and describes a distinct commercial offering. This is a concrete reason to resolve the exact legacy checkpoint's rights rather than generalizing from SadTalker's project-wide announcement. It is not a legal conclusion about every SadTalker release. [Wav2Lip upstream](https://github.com/Rudrabha/Wav2Lip/blob/master/README.md).

Qualification must select an exact source/model profile, identify every inference-time third-party component, record the applicable terms/permissions and notices, pin and verify its bytes, and establish real worker behavior. Exclude disallowed components or obtain the required rights; do not rename or hide them. The checked-in `workers/sadtalker-runpod` image does not contain a verified real inference implementation, so changing an endpoint/image name alone cannot complete option A.
