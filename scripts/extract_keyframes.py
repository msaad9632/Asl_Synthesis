"""Stage 2 · step 3 — distill the filtered landmark stream into 3-4 critical keyframes.

We do NOT bake every frame. A sign is captured by a handful of poses:
  * start  — the settled pose where motion begins
  * peak   — the contact point / maximum extension (largest displacement from start)
  * end    — the settled pose where motion stops
  * hold   — (optional 4th) a mid-stroke direction reversal or pause, if the sign has one

Method: the dominant hand's WRIST path drives segmentation. Speed gates find motion onset/offset
(start/end); the farthest point from start is the peak; a clear velocity-direction reversal between
them yields the optional hold. Each chosen frame carries the full 21x3 hand pose so the next stage
can read handshape/orientation, plus the occlusion flag so a bad keyframe is surfaced, not used.

Run:
    python scripts/extract_keyframes.py --in landmarks/COFFEE.json --out keyframes/COFFEE.json
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

WRIST = 0
SPEED_GATE = 0.04   # shoulder-width units / frame; below this the hand is "settled"
MIN_HOLD_TURN = 0.5  # cos-angle threshold: velocity reversal sharper than ~60deg counts as a hold


def _series(frames: list[dict]):
    """Return (valid_indices, wrist[N,3], hands[N,21,3]) over frames that have a hand."""
    idxs, wrist, hands = [], [], []
    for i, fr in enumerate(frames):
        if fr["hand"] is None:
            continue
        h = np.asarray(fr["hand"], dtype=float)
        idxs.append(i)
        hands.append(h)
        wrist.append(h[WRIST])
    return np.array(idxs), np.asarray(wrist), np.asarray(hands)


def _settle_bounds(speed: np.ndarray) -> tuple[int, int]:
    """First and last samples where the hand is actually moving (speed over the gate)."""
    moving = np.where(speed > SPEED_GATE)[0]
    if moving.size == 0:
        return 0, len(speed)            # static sign: whole clip is the hold
    return int(moving[0]), int(moving[-1]) + 1


def _hold_frame(wrist: np.ndarray, lo: int, hi: int, peak: int) -> int | None:
    """Sharpest velocity-direction reversal in [lo,hi], excluding the peak itself."""
    if hi - lo < 4:
        return None
    v = np.diff(wrist[lo:hi], axis=0)
    n = np.linalg.norm(v, axis=1, keepdims=True)
    u = v / np.where(n == 0, 1, n)
    cos = np.sum(u[1:] * u[:-1], axis=1)        # turn angle between successive velocities
    j = int(np.argmin(cos))
    if cos[j] > MIN_HOLD_TURN:
        return None
    f = lo + j + 1
    return None if abs(f - peak) <= 1 else f


def extract(data: dict) -> dict:
    frames = data["frames"]
    idxs, wrist, hands = _series(frames)
    if idxs.size == 0:
        raise ValueError("no hand detected in any frame — cannot extract keyframes")

    speed = np.concatenate([[0.0], np.linalg.norm(np.diff(wrist, axis=0), axis=1)])
    lo, hi = _settle_bounds(speed)
    lo = min(lo, len(idxs) - 1)
    hi = max(hi, lo + 1)

    disp = np.linalg.norm(wrist - wrist[lo], axis=1)
    peak = int(np.argmax(disp))

    picks = [("start", lo), ("peak", peak), ("end", min(hi, len(idxs) - 1))]
    hold = _hold_frame(wrist, lo, min(hi, len(idxs)), peak)
    if hold is not None:
        picks.insert(1 if hold < peak else 2, ("hold", hold))

    seen, keyframes = set(), []
    for label, k in picks:
        src = int(idxs[k])
        if src in seen:
            continue
        seen.add(src)
        fr = frames[src]
        keyframes.append({
            "label": label,
            "src_frame": src,
            "t": fr["t"],
            "pose": fr["hand"],                  # 21x3 in body frame
            "flagged": bool(fr["flagged"]),
            "reason": fr["reason"],
        })

    return {
        "sign_id": data["sign_id"],
        "fps": data["fps"],
        "handedness": next((f["handedness"] for f in frames if f["handedness"]), None),
        "wrist_path": wrist.round(5).tolist(),   # full path -> movement classification in step 4
        "body_ref": next((f["body"] for f in frames if f["body"]), None),
        "keyframes": keyframes,
        "occlusion_flags": [k["src_frame"] for k in keyframes if k["flagged"]],
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Stage 2: extract 3-4 keyframes from filtered landmarks.")
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)

    data = json.loads(Path(args.inp).read_text(encoding="utf-8"))
    kf = extract(data)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(kf), encoding="utf-8")

    labels = ", ".join(f"{k['label']}@{k['src_frame']}" for k in kf["keyframes"])
    flag = f" — {len(kf['occlusion_flags'])} FLAGGED (needs hand-correction)" if kf["occlusion_flags"] else ""
    print(f"{kf['sign_id']}: {len(kf['keyframes'])} keyframes [{labels}]{flag} -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
