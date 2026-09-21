# Research carried over from the orphaned local branch (2026-09-21)

These files were salvaged from a stale, unpushed local checkout (`lux-video-os-ORPHANED-2026-09-10`) that diverged from `main` and was never part of this repo's real history. They are **reference material only** — diagnosis notes and pinned dependency versions from an earlier, abandoned attempt at real SadTalker GPU inference — not verified against the current codebase or the current `codex/runpod-standard-adapter` branch.

Relevant because: as of 2026-09-21, `codex/runpod-standard-adapter`'s worker (`workers/sadtalker-runpod/`) is still a thin RunPod-SDK stub — it does not yet do real GPU inference. These notes are a head start for whoever builds that out next.

- `facevid2vid-acquisition-diagnosis.md`, `wav2lip-checksum-mismatch-diagnosis.md` — confirms the canonical SadTalker checkpoint URLs/hashes are valid and healthy; earlier "corrupt download" concerns were transfer-interruption artifacts, not broken/moved assets.
- `pip-compile-stall-diagnosis.md` — confirms the target build env (Python 3.8, CUDA 11.3, `torch==1.12.1+cu113`) resolves cleanly; the earlier "stall" was just large-artifact download time.
- `musetalk-drift-scoping-brief.md` — MuseTalk was explored as an alternative and deliberately abandoned as a dead end; don't re-propose it without new cause.
- `workers-sadtalker-reference/` — a pinned model manifest and locked build-tool versions/hashes from a from-scratch SadTalker build attempt. A starting point, not a drop-in solution.

Everything else in the orphaned checkout (a GHCR container-publishing effort, a MuseTalk adapter stub, and ~90 "governance/receipts" commits) was reviewed and found to be either superseded by the real branch's approach or pure process overhead with no engineering content — not carried over.
