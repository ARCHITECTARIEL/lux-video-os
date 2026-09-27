"""Visual verification for face_detector_mediapipe.py's landmark mapping.

Standalone: only needs mediapipe, opencv, numpy (no torch/diffusers, no
GPU) so it can run on a laptop before anything touches the real pipeline.

Extracts a few real frames from LatentSync's own demo videos (Apache-2.0
repo assets, reused here only for this internal QA image, never shipped),
runs the new MediaPipe-based FaceDetector against them, and draws the
bounding box plus every populated landmark point (labeled by its 106-index)
onto the frame. Look at the output images under verify-output/ -- if the
eyebrow/nose/jawline dots don't land in visually sane places on the real
face, the index mapping in face_detector_mediapipe.py is wrong.

Usage:
    python tools/verify_face_detector.py <path-to-demo-video> [<path-to-demo-video> ...]
"""

from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from face_detector_mediapipe import FaceDetector, LMK_ADAPT_ORIGIN_ORDER  # noqa: E402


MODEL_ASSET_PATH = Path(__file__).resolve().parent.parent / ".." / ".." / ".scratch" / "mp-models" / "face_landmarker.task"
OUTPUT_DIR = Path(__file__).resolve().parent / "verify-output"

_JAW_OVAL_ONLY = [i for i in LMK_ADAPT_ORIGIN_ORDER if i not in (43, 48, 49, 50, 51, 73, 74, 101, 102, 103, 104, 105, 86)]
_EYEBROW_L = [43, 48, 49, 50, 51]
_EYEBROW_R = [101, 102, 103, 104, 105]
_NOSE = [74, 77, 83, 86, 73]

_COLORS = {
    "jaw": (255, 200, 0),      # cyan-ish (BGR)
    "eyebrow_l": (0, 140, 255),  # orange
    "eyebrow_r": (255, 0, 200),  # magenta
    "nose": (0, 255, 0),        # green
}


def _extract_frames(video_path: Path, count: int = 3) -> list[np.ndarray]:
    cap = cv2.VideoCapture(str(video_path))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if total <= 0:
        total = count * 10
    frames = []
    for i in range(count):
        frame_index = int((i + 1) * total / (count + 1))
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
        ok, frame_bgr = cap.read()
        if not ok:
            continue
        frames.append(cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB))
    cap.release()
    return frames


def _role_for_index(index: int) -> str:
    if index in _EYEBROW_L:
        return "eyebrow_l"
    if index in _EYEBROW_R:
        return "eyebrow_r"
    if index in _NOSE:
        return "nose"
    return "jaw"


def _annotate(frame_rgb: np.ndarray, bbox, lmk: np.ndarray) -> np.ndarray:
    canvas = cv2.cvtColor(frame_rgb, cv2.COLOR_RGB2BGR).copy()
    if bbox is not None:
        x1, y1, x2, y2 = bbox
        cv2.rectangle(canvas, (x1, y1), (x2, y2), (0, 0, 255), 2)
    if lmk is not None:
        populated = set(LMK_ADAPT_ORIGIN_ORDER) | set(_EYEBROW_L) | set(_EYEBROW_R) | set(_NOSE)
        for index in sorted(populated):
            x, y = int(lmk[index][0]), int(lmk[index][1])
            if x == 0 and y == 0:
                continue
            color = _COLORS[_role_for_index(index)]
            cv2.circle(canvas, (x, y), 3, color, -1)
            cv2.putText(canvas, str(index), (x + 4, y - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.35, color, 1, cv2.LINE_AA)
    return canvas


def main(video_paths: list[str]) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    detector = FaceDetector(device="cpu", model_asset_path=str(MODEL_ASSET_PATH))

    total_frames = 0
    total_detected = 0
    for video_path_str in video_paths:
        video_path = Path(video_path_str)
        frames = _extract_frames(video_path)
        for i, frame in enumerate(frames):
            total_frames += 1
            bbox, lmk = detector(frame)
            status = "DETECTED" if bbox is not None else "NO FACE"
            if bbox is not None:
                total_detected += 1
            print(f"{video_path.name} frame {i}: {status} bbox={bbox}")
            annotated = _annotate(frame, bbox, lmk)
            out_path = OUTPUT_DIR / f"{video_path.stem}_frame{i}.png"
            cv2.imwrite(str(out_path), annotated)
            print(f"  -> {out_path}")

    print(f"\n{total_detected}/{total_frames} frames had a face detected.")
    print(f"Annotated images written to {OUTPUT_DIR}")
    print("Legend: red=bbox, orange=left eyebrow(43,48,49,50,51), "
          "magenta=right eyebrow(101-105), green=nose(73,74,77,83,86), "
          "cyan=jaw/oval bounding points")


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        print("Usage: python verify_face_detector.py <video1> [<video2> ...]")
        sys.exit(1)
    main(args)
