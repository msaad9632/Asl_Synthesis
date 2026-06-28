"""Stage 2 · step 4 — translate keyframes into the Sign Definition Schema (semantic, not raw).

Output is the format the pipeline prompt fixes: handshape preset + location anchor/offset +
movement type/pivot/threshold + orientation. We deliberately emit PARAMETERS, never a per-frame
rotation stream — the procedural engine (core/synthesis3d.py -> avatar_app.js) renders those
parameters, so footage calibrates the numbers and the existing renderer animates them.

Three classifiers read the keyframe poses:
  * handshape  — per-finger tip-vs-knuckle reach ratio -> nearest preset signature
  * location   — dominant wrist height vs the signer's own face/torso reference points -> anchor
  * movement   — geometry of the full wrist path -> none / linear / arc / circular / repeated
  * orientation— palm normal + finger direction -> nearest body axis

Anything the monocular capture can't pin down confidently (palm-normal sign, two-handed contact,
occlusion-flagged keyframes) is written through with a `review.notes` warning rather than guessed —
the human resolves it in Stage 4.

NOTE: the handshape signatures below MUST stay in sync with the single source of truth,
E:/ASL_Game/core/handshape_presets.py (SHAPE_SPECS). Kept inline so this repo runs standalone.

Run:
    python scripts/schema_translator.py --in keyframes/COFFEE.json --out schema/signs/coffee.json
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

W, T_TIP, I_MCP, I_TIP, M_MCP, M_TIP, P_MCP = 0, 4, 5, 8, 9, 12, 17
FINGERS = {"index": (5, 8), "middle": (9, 12), "ring": (13, 16), "pinky": (17, 20)}

# (index, middle, ring, pinky, thumb) extended bits. First match wins on a tie (dict order).
_SIG = {
    "s": (0, 0, 0, 0, 0), "a": (0, 0, 0, 0, 1), "b": (1, 1, 1, 1, 1),
    "1": (1, 0, 0, 0, 0), "v": (1, 1, 0, 0, 0), "w": (1, 1, 1, 0, 0),
    "l": (1, 0, 0, 0, 1), "y": (0, 0, 0, 1, 1), "middle": (0, 1, 0, 0, 0),
}
_AXES = [((1, 0, 0), "right"), ((-1, 0, 0), "left"), ((0, 1, 0), "up"),
         ((0, -1, 0), "down"), ((0, 0, 1), "away"), ((0, 0, -1), "toward")]


def _axis_label(v: np.ndarray) -> str:
    n = float(np.linalg.norm(v))
    if n == 0:
        return "unknown"
    u = v / n
    return max(_AXES, key=lambda a: float(np.dot(u, a[0])))[1]


def classify_handshape(pose: np.ndarray) -> tuple[str, dict]:
    p = np.asarray(pose)
    scale = float(np.linalg.norm(p[M_MCP] - p[W])) or 1.0
    bits, ratios = [], {}
    for name, (mcp, tip) in FINGERS.items():
        reach = np.linalg.norm(p[tip] - p[W]) / (np.linalg.norm(p[mcp] - p[W]) or 1.0)
        ratios[name] = round(float(reach), 3)
        bits.append(1 if reach > 1.2 else 0)
    thumb_spread = float(np.linalg.norm(p[T_TIP] - p[I_MCP])) / scale
    bits.append(1 if thumb_spread > 0.6 else 0)
    sig = tuple(bits)
    name = min(_SIG, key=lambda k: sum(a != b for a, b in zip(_SIG[k], sig)))
    dist = sum(a != b for a, b in zip(_SIG[name], sig))
    return name, {"signature": sig, "reach_ratios": ratios,
                  "thumb_spread": round(thumb_spread, 3), "ambiguous": dist > 0}


def classify_location(wrist: np.ndarray, body: dict | None) -> tuple[str, dict]:
    y = float(wrist[1])
    if body is None:                      # no reference -> coarse height bands only
        anchor = ("forehead" if y > 0.9 else "chin" if y > 0.5 else
                  "chest" if y > 0.0 else "belly")
        return anchor, {"x": round(float(wrist[0]), 3), "y": round(y, 3), "z": round(float(wrist[2]), 3)}
    nose_y = body["nose"][1]
    mouth_y = (body["mouth_l"][1] + body["mouth_r"][1]) / 2.0
    hip_y = (body["l_hip"][1] + body["r_hip"][1]) / 2.0
    if y >= nose_y - 0.1:
        anchor, ref = "forehead", body["nose"]
    elif y >= mouth_y - 0.1:
        anchor, ref = "chin", [(body["mouth_l"][i] + body["mouth_r"][i]) / 2.0 for i in range(3)]
    elif y >= (hip_y + 0.2):
        anchor, ref = "chest", [0.0, 0.0, 0.0]
    else:
        anchor, ref = "belly", [0.0, hip_y, 0.0]
    if abs(float(wrist[0])) > 0.7 and anchor in ("chest", "belly"):
        anchor, ref = "neutral", [0.0, 0.0, 0.0]
    off = (np.asarray(wrist) - np.asarray(ref)).round(3)
    return anchor, {"x": float(off[0]), "y": float(off[1]), "z": float(off[2])}


def classify_movement(path: np.ndarray) -> dict:
    p = np.asarray(path)
    if len(p) < 3:
        return {"type": "none", "pivot": "wrist", "threshold": 0.0, "_aspect": 0.0}
    seg = np.linalg.norm(np.diff(p, axis=0), axis=1)
    length = float(seg.sum())
    net = float(np.linalg.norm(p[-1] - p[0]))
    if length < 0.15:
        return {"type": "none", "pivot": "wrist", "threshold": round(length, 3), "_aspect": 0.0}

    centered = p - p.mean(axis=0)
    U, S, Vt = np.linalg.svd(centered, full_matrices=False)
    s1 = float(S[0]) or 1.0
    aspect = float(S[1]) / s1            # ~1 = fills a 2D plane (loops); ~0 = thin 1D line
    proj = centered @ Vt[0]              # extent along the principal axis
    reversals = int(np.sum(np.diff(np.sign(np.diff(proj))) != 0))
    straightness = net / length

    # A circle projected onto one axis oscillates like a line — so check 2D-ness (aspect) FIRST.
    if straightness > 0.8 and aspect < 0.2:
        mtype, thr = "linear", round(net, 3)
    elif aspect >= 0.35 and (reversals >= 2 or net < 0.4 * length):
        mtype, thr = "circular", round(float(np.linalg.norm(centered, axis=1).mean()), 3)
    elif reversals >= 2:
        mtype, thr = "repeated", round(float(proj.max() - proj.min()), 3)
    elif net < 0.35 * length:
        mtype, thr = "circular", round(float(np.linalg.norm(centered, axis=1).mean()), 3)
    else:
        mtype, thr = "arc", round(length, 3)
    return {"type": mtype, "pivot": "wrist", "threshold": thr, "_aspect": round(aspect, 3)}


def classify_orientation(pose: np.ndarray) -> dict:
    p = np.asarray(pose)
    normal = np.cross(p[I_MCP] - p[W], p[P_MCP] - p[W])
    point = p[M_TIP] - p[M_MCP]
    return {"palm_facing": _axis_label(normal), "fingers_pointing": _axis_label(point)}


def translate(kf: dict) -> dict:
    keyframes = kf["keyframes"]
    by_label = {k["label"]: k for k in keyframes}
    defining = by_label.get("peak", keyframes[-1])
    pose = np.asarray(defining["pose"])

    handshape, hs_dbg = classify_handshape(pose)
    anchor, offset = classify_location(pose[W], kf.get("body_ref"))
    movement = classify_movement(np.asarray(kf["wrist_path"]))
    aspect = movement.pop("_aspect", None)        # keep the schema's movement block clean
    orientation = classify_orientation(pose)

    notes = []
    if hs_dbg["ambiguous"]:
        notes.append(f"handshape '{handshape}' is a nearest-match (signature {hs_dbg['signature']}) — verify")
    if kf.get("occlusion_flags"):
        notes.append(f"occlusion-flagged keyframes {kf['occlusion_flags']} — hand-correct before approving")
    notes.append("palm_facing sign & two-handed contact are monocular estimates — confirm in calibration")

    return {
        "sign_id": kf["sign_id"],
        "handshape": f"ASL_{handshape.upper()}",
        "handedness": kf.get("handedness"),
        "location": {"anchor": anchor, "offset": offset},
        "movement": movement,
        "orientation": orientation,
        "keyframes": [{"frame": k["src_frame"], "pose": k["label"]} for k in keyframes],
        "calibration_poses": {k["label"]: k["pose"] for k in keyframes},  # sparse, review-only
        "occlusion_flags": kf.get("occlusion_flags", []),
        "review": {"reviewed": False, "approved": False, "reviewer": "", "notes": "; ".join(notes)},
        "_debug": {"handshape": hs_dbg, "movement_aspect": aspect},
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Stage 2: keyframes -> Sign Definition Schema.")
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)

    kf = json.loads(Path(args.inp).read_text(encoding="utf-8"))
    schema = translate(kf)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(schema, indent=2), encoding="utf-8")
    print(f"{schema['sign_id']}: {schema['handshape']} @ {schema['location']['anchor']} "
          f"/ {schema['movement']['type']} -> {out}")
    if schema["occlusion_flags"]:
        print(f"  ⚠ {len(schema['occlusion_flags'])} flagged keyframe(s) need hand-correction")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
