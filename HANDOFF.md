# Handoff Note

**Date/Time**: 2026-06-29 (Claude Code, Opus session)
**Who was working**: Person A (Saad / msaad9632)

## ⚠️ READ FIRST — how the two halves fit together
We now have BOTH halves of the pipeline, and they **compose** rather than compete:

- **Stage 2 (NEW, this session)** = MediaPipe-as-authoring-tool. It turns OUR recorded footage into
  **schema parameters** (handshape, location anchor/offset, movement type/threshold, orientation).
  It deliberately emits *parameters*, never a per-frame rotation stream — exactly what
  `claude_code_combined_pipeline_prompt.md` specifies.
- **Procedural engine (EXISTING)** = `E:/ASL_Game/core/synthesis3d.py` → `D:/asl-synthesis/avatar_app.js`.
  It **renders** those parameters on the Ready Player Me avatar (analytical IK + finger curl/adduction).

So footage **calibrates the numbers**; the procedural renderer **animates them**. The earlier
procedural work is not thrown away — Stage 2 feeds it.

## What was completed this session
- Wired Stage 3: `viewer.html` / `avatar_app.js` accept `?sign=SIGN_ID` and auto-loop. (pushed)
- Built the **Stage 2 pipeline** under `scripts/` (runs on the venv that has mediapipe+opencv,
  `E:/ASL_Game/.venv`):
  - `scripts/oneeuro.py` — 1€ filter (pure math, no scipy), applied to the landmark stream
    **before** keyframe extraction.
  - `scripts/capture_landmarks.py` — MediaPipe **Tasks API** HandLandmarker+PoseLandmarker over a
    video; normalizes every landmark into **shoulder-width body-frame units** (origin = shoulder
    midpoint; x=subject-right, y=up, z=toward camera); flags occlusion (no hand / low shoulder
    visibility / post-filter tracking snaps) instead of silently emitting bad data.
  - `scripts/extract_keyframes.py` — wrist-speed segmentation → 3–4 keyframes (start / peak /
    end / optional hold at a velocity reversal); carries occlusion flags forward.
  - `scripts/schema_translator.py` — classifies handshape (tip-vs-knuckle reach → nearest preset
    signature, kept in sync with `E:/ASL_Game/core/handshape_presets.py`), location anchor (wrist
    height vs the signer's own face/torso refs), movement (path geometry → none/linear/arc/
    circular/repeated), orientation; writes `schema/signs/<id>.json` in the prompt's schema format.
    Monocular-uncertain fields (palm-normal sign, two-handed contact) are written through with a
    `review.notes` warning, never guessed.
- `calibration_log.md` (Stage 4 table, 12 coffee-shop signs) + `schema/signs/.gitkeep`.
- `.gitignore`: ignore `footage/`, `landmarks/`, `keyframes/` (intermediates); `schema/signs/` IS committed.
- **Smoke-tested** the whole `extract → translate` chain on SYNTHETIC landmarks (a fist circling):
  got `ASL_S` / `chest` / `circular` correctly. No footage touched (respects the Stage 2 STOP).

## Current stage status
- Stage 0 (confirm rig): **✅** — Ready Player Me rig (67 joints, real finger chains). Blender not
  installed, so the prompt's `inspect_rig.py` path is N/A; rig was confirmed via Three.js instead.
- Stage 1 (finger gaps): **🔄** — solved procedurally (adduction in `avatar_app.js`), not Blender
  weight-paint. Needs human sign-off in Stage 4.
- Stage 2 (MediaPipe → schema): **✅ built + unit-smoke-tested / ⛔ not yet run on footage** (STOP).
- Stage 3 (local preview): **✅** — `viewer.html` + `?sign=` + auto-loop.
- Stage 4 (calibration review): **⬜** — do NOT self-approve sign quality.

## Last thing that ran
- Command: `E:/ASL_Game/.venv/Scripts/python.exe scratchpad/smoke.py`
- Output: `KEYFRAMES: [('start',0),('peak',18),('end',35)]` then a schema with
  `handshape ASL_S, anchor chest, movement circular (threshold 0.12)`. Passed.

## Exactly what to do next (Stage 2 STOP — needs the human)
1. **Record footage WE own** of the 12 coffee-shop signs (license rule: only our own video —
   never WLASL/How2Sign/ASL Citizen). One clear front-facing clip per sign, ~2 s, good light,
   hands fully in frame. Drop them in `footage/<SIGN_ID>.mp4` (gitignored).
2. For each clip, run the pipeline (venv with mediapipe+opencv):
   ```
   py=E:/ASL_Game/.venv/Scripts/python.exe
   $py scripts/capture_landmarks.py --video footage/COFFEE.mp4 --sign-id COFFEE --out landmarks/COFFEE.json
   $py scripts/extract_keyframes.py --in landmarks/COFFEE.json --out keyframes/COFFEE.json
   $py scripts/schema_translator.py --in keyframes/COFFEE.json --out schema/signs/coffee.json
   ```
3. **Adapter (small, TODO):** map `schema/signs/<id>.json` → the viewer's `anim/<SIGN>.json` so the
   renderer animates the footage-calibrated parameters. (The viewer currently reads `anim/`.)
4. Review each sign in the live preview (`npx http-server -p 5188 .` → `viewer.html?sign=COFFEE`);
   log result in `calibration_log.md`. **STOP for human review — no self-approval.**

## Open questions / blockers
- **No footage yet** — Stage 2 cannot RUN until we record the 12 signs ourselves. This is the gate.
- **Blender not installed** — the prompt's Stage 0/1 Blender scripts can't run; we used the RPM rig
  + procedural finger fix instead. Reinstall Blender only if we decide to weight-paint the mesh.
- **Schema reconciliation**: Stage 2 emits the prompt's schema (`schema/signs/`); the renderer reads
  `anim/`. Need the small adapter in step 3 (or teach the viewer to read `schema/signs/` directly).

## Watch out for
- Run the Python scripts with `E:/ASL_Game/.venv/Scripts/python.exe` (it has mediapipe+opencv+numpy;
  scipy is NOT needed). Model files: `E:/ASL_Game/models/{hand_landmarker,pose_landmarker_lite}.task`.
- `scripts/capture_landmarks.py` imports cv2+mediapipe at module top; `extract_keyframes.py` and
  `schema_translator.py` are pure-numpy and can be imported/tested without a camera or footage.
- Headless render still uses **system Edge** (`channel:'msedge'`); Bash cwd resets — `cd /d/asl-synthesis` first.
- Handshape signatures in `schema_translator._SIG` MUST stay in sync with
  `E:/ASL_Game/core/handshape_presets.py` (single source of truth).
