"""MediaPipe-based replacement for LatentSync's InsightFace face detector.

Why this exists: LatentSync's original `latentsync/utils/face_detector.py`
(vendored alongside, unused, as `face_detector.insightface-original.py`)
depends on `insightface.app.FaceAnalysis`'s default `buffalo_l` pack for
face detection and 106-point landmarks. InsightFace's own model-zoo notice
states "ALL models are available for non-commercial research purposes
only" with no carve-out for using only the detection/landmark sub-models
with recognition disabled -- a hard blocker for a paid commercial product,
the same category of problem that ruled out SadTalker's Wav2Lip dependency.

This module reimplements the same `__call__(frame) -> (bbox, landmark_2d_106)`
contract using MediaPipe's Face Landmarker task (Apache-2.0, genuinely
commercial-use model asset, no research-only restriction) instead.

It does NOT attempt a full anatomically-faithful reconstruction of
InsightFace's proprietary 106-point numbering scheme. It only populates the
~32 specific indices that LatentSync's own downstream code actually reads
(see `_LEFT_EYEBROW_106`/`_RIGHT_EYEBROW_106`/`_NOSE_106`/
`_NOSE_BRIDGE_TOP_106`/`_JAW_OVAL_106` below, and this file's own
`LMK_ADAPT_ORIGIN_ORDER`, both traced directly from
`latentsync/utils/image_processor.py`'s `affine_transform()` and the
original `face_detector.py`'s bounding-box refinement). Every other slot in
the 106-length array is left at (0, 0) because nothing in the pipeline ever
reads it -- confirmed by grepping the vendored source tree for every use of
`landmark_2d_106`/`lmk[`.

Correctness of the specific MediaPipe index choices below is NOT assumed
from memory -- it is verified visually by
`tools/verify_face_detector.py`, which draws every populated point on real
face frames. Re-run that tool after touching any index list here.
"""

from __future__ import annotations

import numpy as np
import mediapipe as mp
from mediapipe.tasks import python as mp_tasks
from mediapipe.tasks.python import vision as mp_vision


# --- Canonical MediaPipe Face Landmarker index groups (468-point mesh) ---
# Standard, widely-published canonical face-mesh landmark groups (MediaPipe's
# own FACEMESH_LEFT_EYEBROW / FACEMESH_RIGHT_EYEBROW / FACEMESH_FACE_OVAL
# connection sets, plus the well-known nose-tip/bridge indices). "Left"/
# "right" follow MediaPipe's own convention: the subject's left eyebrow,
# which appears on the *viewer's right* in a front-facing frame.
_MP_LEFT_EYEBROW = [276, 283, 282, 295, 285, 300, 293, 334, 296, 336]
_MP_RIGHT_EYEBROW = [46, 53, 52, 65, 55, 70, 63, 105, 66, 107]
_MP_NOSE_BRIDGE_TO_TIP = [168, 6, 197, 195, 5, 4, 1, 19, 94, 2]
_MP_FACE_OVAL = [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365,
    379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93,
    234, 127, 162, 21, 54, 103, 67, 109,
]

# The exact 106-indices LatentSync's own code reads (traced directly from
# image_processor.py's affine_transform() and face_detector.py's
# LMK_ADAPT_ORIGIN_ORDER), grouped by semantic role.
_LEFT_EYEBROW_106 = [43, 48, 49, 50, 51]
_RIGHT_EYEBROW_106 = [101, 102, 103, 104, 105]
_NOSE_106 = [74, 77, 83, 86]           # "nose center" 4-point mean
_NOSE_BRIDGE_TOP_106 = 73               # paired with 74 as a brow-line anchor
_JAW_OVAL_106 = [0, 1, 3, 5, 7, 10, 12, 14, 16, 17, 19, 21, 23, 26, 28, 30, 32]

LANDMARK_106_LENGTH = 106

# Same fixed list the original face_detector.py uses to bound the crop box.
LMK_ADAPT_ORIGIN_ORDER = [
    1, 10, 12, 14, 16, 3, 5, 7, 0, 23, 21, 19, 32, 30, 28, 26, 17,
    43, 48, 49, 51, 50, 102, 103, 104, 105, 101, 73, 74, 86,
]


def _sample(indices_pool: list[int], count: int) -> list[int]:
    """Evenly sample `count` indices out of an ordered canonical index list."""
    positions = np.linspace(0, len(indices_pool) - 1, count).round().astype(int)
    return [indices_pool[p] for p in positions]


def _build_index_map() -> dict[int, int]:
    mapping: dict[int, int] = {}
    for dst, src in zip(_LEFT_EYEBROW_106, _sample(_MP_LEFT_EYEBROW, len(_LEFT_EYEBROW_106))):
        mapping[dst] = src
    for dst, src in zip(_RIGHT_EYEBROW_106, _sample(_MP_RIGHT_EYEBROW, len(_RIGHT_EYEBROW_106))):
        mapping[dst] = src
    for dst, src in zip(_NOSE_106, _sample(_MP_NOSE_BRIDGE_TO_TIP, len(_NOSE_106))):
        mapping[dst] = src
    # 73 is read alongside 74 (`np.mean([lmk[74], lmk[73]])`) as a brow-line
    # anchor for the crop's upper bound -- point it higher up the nose
    # bridge than 74 itself so that mean sits sensibly near the glabella.
    mapping[_NOSE_BRIDGE_TOP_106] = _MP_NOSE_BRIDGE_TO_TIP[0]
    for dst, src in zip(_JAW_OVAL_106, _sample(_MP_FACE_OVAL, len(_JAW_OVAL_106))):
        mapping[dst] = src
    return mapping


_INDEX_MAP = _build_index_map()


class FaceDetector:
    """Drop-in replacement for the original InsightFace-backed FaceDetector.

    Same public contract as the file this replaces:
    `__call__(frame, threshold=0.5) -> (bbox, landmark_2d_106)` where `bbox`
    is `[x1, y1, x2, y2]` ints (or None) and `landmark_2d_106` is a `(106, 2)`
    int array (or None) with only the indices this pipeline reads populated.

    `frame` is expected to be an RGB uint8 numpy array (H, W, 3), matching
    what `latentsync/utils/util.py`'s video reader hands to this class in
    the original pipeline.
    """

    def __init__(
        self,
        device: str = "cuda",
        model_asset_path: str = "checkpoints/auxiliary/face_landmarker.task",
    ):
        # `device` is accepted for interface parity with the file this
        # replaces (which used it to pick a CUDA execution provider for
        # onnxruntime). MediaPipe's Face Landmarker task runs on CPU here;
        # it is a tiny, fast model relative to the GPU-bound diffusion
        # pipeline it feeds into, so this is not expected to be a
        # bottleneck. Revisit only if profiling says otherwise.
        self._device = device
        base_options = mp_tasks.BaseOptions(model_asset_path=model_asset_path)
        options = mp_vision.FaceLandmarkerOptions(
            base_options=base_options,
            running_mode=mp_vision.RunningMode.IMAGE,
            num_faces=5,
            min_face_detection_confidence=0.5,
            min_face_presence_confidence=0.5,
        )
        self._landmarker = mp_vision.FaceLandmarker.create_from_options(options)

    def __call__(self, frame: np.ndarray, threshold: float = 0.5):
        # `threshold` is accepted for interface parity; MediaPipe's own
        # min_face_detection_confidence/min_face_presence_confidence
        # (set at construction) already perform this filtering.
        del threshold
        f_h, f_w = frame.shape[:2]
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(frame))
        result = self._landmarker.detect(mp_image)

        if not result.face_landmarks:
            return None, None

        best_face = None
        best_size = 0
        for face_landmarks in result.face_landmarks:
            xs = [pt.x * f_w for pt in face_landmarks]
            ys = [pt.y * f_h for pt in face_landmarks]
            x1, x2 = min(xs), max(xs)
            y1, y2 = min(ys), max(ys)
            w, h = x2 - x1, y2 - y1
            if w < 50 or h < 80:
                continue
            if w / h > 1.5 or w / h < 0.2:
                continue
            size_now = w * h
            if size_now > best_size:
                best_size = size_now
                best_face = (face_landmarks, (x1, y1, x2, y2))

        if best_face is None:
            return None, None

        face_landmarks, (bx1, by1, bx2, by2) = best_face

        lmk = np.zeros((LANDMARK_106_LENGTH, 2), dtype=np.float64)
        for dst_index, src_index in _INDEX_MAP.items():
            point = face_landmarks[src_index]
            lmk[dst_index] = (point.x * f_w, point.y * f_h)
        lmk = np.round(lmk).astype(np.int_)

        # From here down, this mirrors the original face_detector.py's
        # bounding-box refinement exactly, just fed from our populated lmk.
        sub_lmk = lmk[LMK_ADAPT_ORIGIN_ORDER]
        halk_face_coord = np.mean([lmk[74], lmk[73]], axis=0)
        halk_face_dist = np.max(sub_lmk[:, 1]) - halk_face_coord[1]
        upper_bond = halk_face_coord[1] - halk_face_dist

        x1, y1, x2, y2 = (
            int(np.min(sub_lmk[:, 0])), int(upper_bond),
            int(np.max(sub_lmk[:, 0])), int(np.max(sub_lmk[:, 1])),
        )

        if y2 - y1 <= 0 or x2 - x1 <= 0 or x1 < 0:
            x1, y1, x2, y2 = int(bx1), int(by1), int(bx2), int(by2)

        y2 += int((x2 - x1) * 0.1)
        x1 -= int((x2 - x1) * 0.05)
        x2 += int((x2 - x1) * 0.05)

        x1 = max(0, x1)
        y1 = max(0, y1)
        x2 = min(f_w, x2)
        y2 = min(f_h, y2)

        return [x1, y1, x2, y2], lmk
