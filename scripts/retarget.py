"""Motion-capture retargeting: turn captured arm joints into avatar bone directions.

Instead of synthesizing arm poses with IK to a guessed wrist target, this replays the REAL human
arm motion: for each frame it emits unit direction vectors for the upper arm (shoulder->elbow) and
forearm (elbow->wrist) of both arms, in the avatar body frame. The avatar aims its own bones along
those directions, so it mimics exactly how the signer moved -> human-like motion.

Fingers still come from the measured hand curl (measure_pose); palm facing is carried per sign.

    python scripts/retarget.py --in landmarks/HELLO.json --out D:/asl-synthesis/anim/HELLO.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, "E:/ASL_Game")
from core.handshape_presets import measure_pose  # noqa: E402

_PALM_FACE = {"PLEASE": [0, 0, -1], "THANK_YOU": [0, 0, -1], "WANT": [0, 1, 0], "COFFEE": [0, -1, 0]}


def _smooth(arr: np.ndarray, win: int = 5) -> np.ndarray:
    """Centered moving average along axis 0 to de-jitter the joint positions."""
    if len(arr) < win:
        return arr
    pad = win // 2
    padded = np.pad(arr, ((pad, pad), (0, 0)), mode="edge")
    ker = np.ones(win) / win
    return np.stack([np.convolve(padded[:, k], ker, mode="valid") for k in range(arr.shape[1])], axis=1)


def _unit(v: np.ndarray) -> list:
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    u = v / np.where(n == 0, 1, n)
    return u


def build_retarget(landmarks: dict) -> dict:
    name = landmarks["sign_id"].upper()
    frames = landmarks["frames"]
    # gather arm joints; hold last good when a frame is missing arms
    joints = {k: [] for k in ("l_sh", "l_el", "l_wr", "r_sh", "r_el", "r_wr")}
    last = None
    hand_poses = []
    for f in frames:
        a = f.get("arms")
        if a is None and last is None:
            continue
        if a is None:
            a = last
        last = a
        for k in joints:
            joints[k].append(a[k])
        hand_poses.append(f.get("hand"))

    J = {k: _smooth(np.asarray(v, dtype=float)) for k, v in joints.items()}
    n = len(J["r_sh"])

    # MediaPipe world-landmark x is +toward image-right = the signer's LEFT (they face the camera).
    # The avatar body frame's +x is its OWN right, so negate x to map signer-anatomy -> avatar-anatomy
    # (right arm drives right arm) while staying on the correct visual side.
    flip = np.array([-1.0, 1.0, 1.0])
    r_ua = _unit((J["r_el"] - J["r_sh"]) * flip)
    r_fa = _unit((J["r_wr"] - J["r_el"]) * flip)
    l_ua = _unit((J["l_el"] - J["l_sh"]) * flip)
    l_fa = _unit((J["l_wr"] - J["l_el"]) * flip)

    out_frames = []
    for i in range(n):
        out_frames.append({
            "rUA": [round(float(x), 4) for x in r_ua[i]],
            "rFA": [round(float(x), 4) for x in r_fa[i]],
            "lUA": [round(float(x), 4) for x in l_ua[i]],
            "lFA": [round(float(x), 4) for x in l_fa[i]],
        })

    # measured finger curl, averaged over the clean hand frames (same as the schema adapter)
    clean = [p for p in hand_poses if p is not None]
    measured = None
    if clean:
        flex = np.array([measure_pose(p)["flex"] for p in clean]).mean(axis=0)
        crisp = np.clip((flex - 0.12) * 1.7, 0.0, 1.0)
        measured = {"flex": [round(float(v), 3) for v in crisp]}

    handed = next((f["handedness"] for f in frames if f.get("handedness")), "Right")
    return {
        "name": name, "fps": landmarks["fps"], "mode": "retarget",
        "duration": round(n / landmarks["fps"], 3),
        "handedness": handed,
        "dom": {"measured": measured} if measured else {"ext": [1, 1, 1, 1], "thumb": 1.0},
        "palmFace": _PALM_FACE.get(name, [0, 0, 1]),
        "frames": out_frames,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Retarget captured arm joints -> avatar bone directions.")
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)
    lm = json.loads(Path(args.inp).read_text(encoding="utf-8"))
    anim = build_retarget(lm)
    Path(args.out).write_text(json.dumps(anim), encoding="utf-8")
    print(f"retargeted {anim['name']}: {len(anim['frames'])} frames -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
