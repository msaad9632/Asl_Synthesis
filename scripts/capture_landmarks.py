"""Stage 2 · step 1+2 — capture MediaPipe landmarks from OUR OWN footage, then 1€-filter them.

MediaPipe is used here ONLY as an authoring tool: it turns a recorded clip of a signer into a
normalized, de-jittered landmark stream that later stages distill into schema parameters. It never
runs at game-time and never drives recognition.

LICENSE RULE (hard): the input video must be footage WE recorded ourselves (or a signer we hired).
Never WLASL / How2Sign / ASL Citizen / any restricted-license dataset — the extracted movement
parameters end up inside the shipped schema either way.

Normalization (so a clip is independent of camera distance / framing): every landmark is expressed
in SHOULDER-WIDTH units in a body frame whose origin is the shoulder midpoint —
    x = subject-right (+),  y = up (+),  z = toward camera (+).
This matches the body frame `core/synthesis3d.py` renders into, so extracted anchors/offsets feed
straight back to the procedural avatar.

Output: <out>.json = {sign_id, fps, filter, frames:[{t, hand, handedness, body, flagged, reason}]}
where `hand` is 21x3 in body frame (or null), `body` carries the reference points the translator
needs (nose, mouth, shoulders, hips) in the same frame.

Run (uses the venv that already has mediapipe + opencv):
    E:/ASL_Game/.venv/Scripts/python.exe scripts/capture_landmarks.py \
        --video footage/COFFEE.mp4 --sign-id COFFEE --out landmarks/COFFEE.json
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

from oneeuro import OneEuroVector

# pose landmark indices (MediaPipe Pose, 33 pts)
NOSE, MOUTH_L, MOUTH_R = 0, 9, 10
L_SH, R_SH, L_HIP, R_HIP = 11, 12, 23, 24

DEFAULT_HAND_MODEL = "E:/ASL_Game/models/hand_landmarker.task"
DEFAULT_POSE_MODEL = "E:/ASL_Game/models/pose_landmarker_lite.task"

# a per-frame jump larger than this (in shoulder-width units, after filtering) reads as a
# MediaPipe depth collapse / tracking snap rather than real motion -> flag it for human review.
SNAP_THRESHOLD = 0.6
MIN_SHOULDER_VIS = 0.5


def _to_frame(landmarks, w: int, h: int, origin: np.ndarray, sw: float) -> np.ndarray:
    """N x 3 normalized-image landmarks -> body frame (shoulder-width units, y up, z toward cam)."""
    pts = np.array([[lm.x * w, lm.y * h, lm.z * w] for lm in landmarks], dtype=float)
    out = (pts - origin) / sw
    out[:, 1] *= -1.0   # image y grows downward -> flip so up is +
    out[:, 2] *= -1.0   # MediaPipe z is negative toward camera -> flip so forward(+) is toward cam
    return out


def _dominant_hand(result) -> tuple[int, str] | None:
    """Pick the signing hand: prefer 'Right' handedness; fall back to the first detected."""
    if not result.hand_landmarks:
        return None
    for i, cats in enumerate(result.handedness):
        if cats and cats[0].category_name == "Right":
            return i, "Right"
    return 0, (result.handedness[0][0].category_name if result.handedness[0] else "Unknown")


def capture(video: str, sign_id: str, hand_model: str, pose_model: str,
            min_cutoff: float, beta: float) -> dict:
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        raise FileNotFoundError(f"cannot open video: {video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0

    hand_opts = vision.HandLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=hand_model),
        running_mode=vision.RunningMode.VIDEO, num_hands=2,
        min_hand_detection_confidence=0.5, min_tracking_confidence=0.5)
    pose_opts = vision.PoseLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=pose_model),
        running_mode=vision.RunningMode.VIDEO, min_pose_detection_confidence=0.5)

    raw: list[dict] = []
    with vision.HandLandmarker.create_from_options(hand_opts) as hand_lm, \
            vision.PoseLandmarker.create_from_options(pose_opts) as pose_lm:
        idx = 0
        while True:
            ok, bgr = cap.read()
            if not ok:
                break
            h, w = bgr.shape[:2]
            ts = int(idx * 1000.0 / fps)
            mp_img = mp.Image(image_format=mp.ImageFormat.SRGB,
                              data=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
            pres = pose_lm.detect_for_video(mp_img, ts)
            hres = hand_lm.detect_for_video(mp_img, ts)

            rec: dict = {"t": round(ts / 1000.0, 4), "hand": None, "handedness": None,
                         "body": None, "flagged": False, "reason": None}

            if not pres.pose_landmarks:
                rec.update(flagged=True, reason="no_pose")
                raw.append(rec)
                idx += 1
                continue
            pose = pres.pose_landmarks[0]
            if min(pose[L_SH].visibility, pose[R_SH].visibility) < MIN_SHOULDER_VIS:
                rec.update(flagged=True, reason="low_shoulder_visibility")

            lsh = np.array([pose[L_SH].x * w, pose[L_SH].y * h, pose[L_SH].z * w])
            rsh = np.array([pose[R_SH].x * w, pose[R_SH].y * h, pose[R_SH].z * w])
            origin = (lsh + rsh) / 2.0
            sw = float(np.linalg.norm(lsh - rsh)) or 1.0
            rec["body"] = {
                name: _to_frame([pose[i]], w, h, origin, sw)[0].round(4).tolist()
                for name, i in (("nose", NOSE), ("mouth_l", MOUTH_L), ("mouth_r", MOUTH_R),
                                ("l_sh", L_SH), ("r_sh", R_SH), ("l_hip", L_HIP), ("r_hip", R_HIP))
            }

            pick = _dominant_hand(hres)
            if pick is None:
                rec.update(flagged=True, reason=rec["reason"] or "no_hand")
            else:
                hi, handed = pick
                rec["hand"] = _to_frame(hres.hand_landmarks[hi], w, h, origin, sw).round(5).tolist()
                rec["handedness"] = handed
            raw.append(rec)
            idx += 1
    cap.release()

    return _filter_stream(
        {"sign_id": sign_id.upper(), "fps": round(fps, 3),
         "filter": {"type": "1euro", "min_cutoff": min_cutoff, "beta": beta},
         "frames": raw})


def _filter_stream(data: dict) -> dict:
    """Apply the 1€ filter to the hand stream and flag post-filter snaps (occlusion tells)."""
    f = OneEuroVector(63, min_cutoff=data["filter"]["min_cutoff"], beta=data["filter"]["beta"])
    fps = data["fps"]
    prev: np.ndarray | None = None
    for rec in data["frames"]:
        vec = None if rec["hand"] is None else np.asarray(rec["hand"]).reshape(-1).tolist()
        sm = f(vec, 1.0 / fps)
        if sm is None:
            prev = None
            continue
        arr = np.asarray(sm).reshape(21, 3)
        if prev is not None:
            if float(np.linalg.norm(arr - prev, axis=1).max()) > SNAP_THRESHOLD:
                rec["flagged"] = True
                rec["reason"] = rec["reason"] or "tracking_snap"
        rec["hand"] = arr.round(5).tolist()
        prev = arr
    return data


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Stage 2: capture + 1€-filter MediaPipe landmarks.")
    ap.add_argument("--video", required=True, help="OUR-recorded clip only (license rule)")
    ap.add_argument("--sign-id", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--hand-model", default=DEFAULT_HAND_MODEL)
    ap.add_argument("--pose-model", default=DEFAULT_POSE_MODEL)
    ap.add_argument("--min-cutoff", type=float, default=1.2)
    ap.add_argument("--beta", type=float, default=0.03)
    args = ap.parse_args(argv)

    data = capture(args.video, args.sign_id, args.hand_model, args.pose_model,
                   args.min_cutoff, args.beta)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data), encoding="utf-8")
    n = len(data["frames"])
    flagged = sum(1 for r in data["frames"] if r["flagged"])
    print(f"{args.sign_id}: {n} frames ({flagged} flagged) -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
