# Handoff Note

**Date/Time**: 2026-06-29 (Claude Code, Opus session)
**Who was working**: Person A (Saad / msaad9632)

## 🚀 FOR THE COLLABORATOR — clone BOTH repos, recognition side is on a BRANCH
The work spans **two GitHub repos** that depend on each other:

| Repo | What it holds | Branch to use |
|------|---------------|---------------|
| **`msaad9632/Asl_Synthesis`** (this repo, → `D:/asl-synthesis`) | Avatar viewer, GLB, Stage-2 scripts (`scripts/`), schema output (`schema/signs/`), anim clips | `main` |
| **`msaad9632/ASL_Game`** (→ `E:/ASL_Game`) | Recognition engine + the shared `core/synthesis3d.py` renderer, the `tools/schema_to_anim.py` adapter, and the MediaPipe **model files** (`models/*.task`) | **`claude/avatar-synthesis-pipeline`** ← not `main` |

Setup:
1. `git clone` both repos. In `ASL_Game`: `git checkout claude/avatar-synthesis-pipeline`.
2. Python deps live in `ASL_Game/.venv` (mediapipe + opencv + numpy; scipy NOT needed). Run all
   Stage-2 Python with that interpreter.
3. **Path gotcha:** the Stage-2 scripts default model paths to `E:/ASL_Game/models/*.task` and the
   adapter writes to `D:/asl-synthesis/anim`. If your clones live elsewhere, pass `--hand-model`,
   `--pose-model`, `--out` (all are CLI args) or edit the `DEFAULT_*` constants.
4. Avatar = **Ready Player Me** GLB (committed). Footage / `landmarks/` / `keyframes/` are gitignored
   (never commit video — license + repo size). `schema/signs/*.json` IS committed.
5. Read the rest of this file, then `claude_code_combined_pipeline_prompt.md` (the staged plan) and
   `calibration_log.md` (per-sign review state). Scope = **12 coffee-shop signs only**; hospital is
   a different collaborator's.

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
  got `ASL_S` / `chest` / `circular` correctly.
- Added the **Stage 2→3 adapter** `E:/ASL_Game/tools/schema_to_anim.py`: renders the authoritative
  `Sign` (so two-handedness / the relational OTHER_HAND anchor — which monocular capture can't see —
  stay correct) and prints a footage-vs-authored **calibration report**; never auto-overwrites.
- **Ran the COFFEE pilot on REAL footage** (two takes Saad recorded). Take B (6% frames flagged,
  correct `ASL_S`) is committed as `schema/signs/coffee.json`; take A was rounder but tracked worse.
  Footage confirmed S-hand + chest. Movement read `repeated` (flat take); **human decision = keep
  `circular`** (canonical). Fixed a classifier bug found here: a circle projected onto one axis
  looked like a 1D oscillation, so `classify_movement` now uses the path aspect ratio (s2/s1) to
  separate circular (2D loop) from repeated (thin line).

## Current stage status
- Stage 0 (confirm rig): **✅** — Ready Player Me rig (67 joints, real finger chains). Blender not
  installed, so the prompt's `inspect_rig.py` path is N/A; rig was confirmed via Three.js instead.
- Stage 1 (finger gaps): **🔄** — solved procedurally (adduction in `avatar_app.js`), not Blender
  weight-paint. Needs human sign-off in Stage 4.
- Stage 2 (MediaPipe → schema): **✅ built + run on COFFEE footage** (pilot). 11 other signs await footage.
- Stage 3 (local preview): **✅** — `viewer.html` + `?sign=` + auto-loop.
- Stage 4 (calibration review): **🔄** — COFFEE logged as in-progress, pending Saad's visual sign-off
  in the preview. Do NOT self-approve sign quality.

## Last thing that ran
- Commands (real COFFEE footage, take B):
  ```
  py=E:/ASL_Game/.venv/Scripts/python.exe
  $py scripts/capture_landmarks.py --video footage/_coffee_b.mp4 --sign-id COFFEE --out landmarks/coffee_b.json
  $py scripts/extract_keyframes.py --in landmarks/coffee_b.json --out keyframes/coffee_b.json
  $py scripts/schema_translator.py --in keyframes/coffee_b.json --out schema/signs/coffee.json
  (cd E:/ASL_Game) $py -m tools.schema_to_anim --in D:/asl-synthesis/schema/signs/coffee.json
  ```
- Output: `COFFEE: ASL_S @ chest / repeated` → `anim/COFFEE.json`; report flagged
  `movement footage='repeated' vs authored='circular'` → human kept circular. Avatar plays COFFEE.

## Exactly what to do next
1. **COFFEE visual sign-off (pending).** `npx http-server -p 5188 .` → `viewer.html?sign=COFFEE`.
   Saad confirms the avatar's COFFEE looks right → flip `calibration_log.md` COFFEE row to ✅ approved.
2. **Process the remaining 11 coffee-shop signs** once footage exists. Record each (license rule:
   our own video only — never WLASL/How2Sign/ASL Citizen), drop `footage/<SIGN>.mp4`, then per sign:
   ```
   py=E:/ASL_Game/.venv/Scripts/python.exe          # run from D:/asl-synthesis
   $py scripts/capture_landmarks.py --video footage/PLEASE.mp4 --sign-id PLEASE --out landmarks/PLEASE.json
   $py scripts/extract_keyframes.py --in landmarks/PLEASE.json --out keyframes/PLEASE.json
   $py scripts/schema_translator.py --in keyframes/PLEASE.json --out schema/signs/please.json
   (cd E:/ASL_Game) $py -m tools.schema_to_anim --in D:/asl-synthesis/schema/signs/please.json
   ```
   Then review in the preview + log it. **No self-approval.**
3. **Optional fidelity upgrade:** the adapter currently renders the *authored* sign and only reports
   footage divergences. To make footage actually *tune* geometry, thread the measured
   `movement.threshold` / `location.offset` into `core/synthesis3d.py` (radius/amplitude/anchor).
   Saad chose to keep canonical motion for now, so this is deferred, not required.

## Open questions / blockers
- **11 signs await footage** — only COFFEE has been recorded + processed. Not a blocker for COFFEE.
- **Blender not installed** — the prompt's Stage 0/1 Blender scripts can't run; we use the RPM rig
  + procedural finger fix instead (Saad confirmed: keep this, don't install Blender).
- **Two-handedness is invisible to monocular capture** — the schema/translator only track the
  dominant hand, so the adapter relies on the authoritative `Sign` for two-handed structure. Fine
  for now; revisit if we add a second-hand capture path.

## Watch out for
- Run the Python scripts with `E:/ASL_Game/.venv/Scripts/python.exe` (it has mediapipe+opencv+numpy;
  scipy is NOT needed). Model files: `E:/ASL_Game/models/{hand_landmarker,pose_landmarker_lite}.task`.
- `scripts/capture_landmarks.py` imports cv2+mediapipe at module top; `extract_keyframes.py` and
  `schema_translator.py` are pure-numpy and can be imported/tested without a camera or footage.
- Headless render still uses **system Edge** (`channel:'msedge'`); Bash cwd resets — `cd /d/asl-synthesis` first.
- Handshape signatures in `schema_translator._SIG` MUST stay in sync with
  `E:/ASL_Game/core/handshape_presets.py` (single source of truth).
