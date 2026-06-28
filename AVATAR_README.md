# Procedural ASL Avatar — driving the Ready Player Me GLB

This makes the **actual `readyplayer.me.glb` avatar** perform ASL signs (not a stand-in skeleton):
arms by analytical 2-bone IK, fingers by handshape presets applied as bone curls, motion from
trajectory tracks exported from the Python `Sign` schema (the same schema the recognition verifier
uses — one source of truth for both directions).

## Files added

| File | Role |
|---|---|
| `avatar_app.js` | The driver: loads the GLB, poses its own bones (2-bone arm IK + finger curls), plays per-sign tracks, exposes `window.AvatarAPI`. |
| `viewer.html` | Minimal interactive viewer (sign dropdown + Play/Pause). Open it to watch the avatar sign live. |
| `anim/<SIGN>.json` | 24 animation tracks (body-relative wrist targets + handshape) exported from the Python schema. |
| `capture.mjs` | Headless render → one PNG per frame into `frames/<SIGN>/` (drives the system Edge via Playwright). |
| `reference_clips/<SIGN>.mp4` | Stored, looped, slowed clips (encoded from the PNGs). |

## Watch it live

```bash
npx http-server -p 5188 .      # or any static server rooted at this folder
# then open  http://localhost:5188/viewer.html  and pick a sign
```
(Live view needs a static server because of ES-module + GLB fetch; opening the file directly won't load modules.)

## Regenerate the stored clips

```bash
# 1. (in the Python repo) re-export tracks if a sign/schema changed:
#    E:\ASL_Game>  .venv\Scripts\python -m tools.export_avatar_anim
# 2. render every sign's frames headlessly:
node capture.mjs                      # or:  node capture.mjs COFFEE WATER
# 3. encode PNG sequences -> reference_clips/*.mp4:
#    E:\ASL_Game>  .venv\Scripts\python -m tools.encode_avatar_clips
```

`node capture.mjs --cal` renders a finger-curl axis calibration sweep; `--probe <SIGN>` renders only
the first and middle frame (fast sanity check). Calibration constants live at the top of
`avatar_app.js` (`TUNE`): finger curl axis/sign/gain, thumb, etc.

## How a sign is posed (per frame)

1. Read the body-relative wrist target offset for each hand from `anim/<SIGN>.json`.
2. Map it to world space against the live skeleton (right/up/forward from the shoulders, scaled by
   shoulder width) → a 3D wrist target.
3. Analytical 2-bone IK aims `…Arm` and `…ForeArm` so `…Hand` lands on the target.
4. Apply the handshape preset as local curls on the four-joint finger chains.

Corrections are data, not code: adjust the schema/anchor offsets in the Python `core/synthesis3d.py`
(or `TUNE` for rig-specific curl), re-export, re-capture — never hand-edit the IK.
