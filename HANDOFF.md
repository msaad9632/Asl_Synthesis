# Handoff Note

**Date/Time**: 2026-06-29 (Claude Code, Opus session)
**Who was working**: Person A (Saad / msaad9632)

## ⚠️ READ FIRST — how this diverged from the combined prompt
We have a **working signing avatar**, but we got there by a **different path** than
`claude_code_combined_pipeline_prompt.md` describes. Know this before continuing:

1. **Avatar = `readyplayer.me.glb`** (Ready Player Me, the file Saad uploaded) — *not* Quaternius and
   *not* `robot.blend`. It passed Stage 0: full skeleton, 67 joints, 4-joint finger chains, separate
   Shoulder/Arm/ForeArm/Hand per side.
2. **Schema is PROCEDURAL, not MediaPipe-from-footage (Stage 2 divergence).** We did **not** capture
   recorded footage. Instead we generate the per-sign animation tracks from the existing **rule-based
   recognition schema** in the companion repo `E:\ASL_Game` (`core/synthesis3d.py`). This reuses one
   schema for both recognition and synthesis (single source of truth), needs no footage, and touches
   **zero** restricted datasets. The MediaPipe-footage path is still open if we want higher fidelity.
3. **Two folders, only one is on GitHub:**
   - `E:\ASL_Game` — recognition game (Python). On GitHub: `msaad9632/ASL_Game`. Holds the schema +
     the 3D exporter (`core/synthesis3d.py`, `tools/export_avatar_anim.py`, `tools/encode_avatar_clips.py`).
   - `D:\asl-synthesis` — the avatar viewer + GLB + capture pipeline (this folder). **NOT a git repo
     yet** → see Blockers.

## What was completed this session
- **Stage 0** confirmed RPM rig (bones `{Left,Right}{Shoulder,Arm,ForeArm,Hand}` + `…{Thumb,Index,Middle,Ring,Pinky}{1..4}`).
- Built `D:\asl-synthesis\avatar_app.js` — the procedural driver:
  - **Arms**: analytical 2-bone IK aims `…Arm`/`…ForeArm` so `…Hand` hits a body-relative target.
  - **Fingers**: flex about the **computed knuckle line** (index1→pinky1) **+ adduction** about the
    palm normal to close the RPM bind-pose finger fan (this fixed the "constant gaps between fingers").
    Per-finger `spread` supports the V handshape.
  - **Palm**: `orientPalm` wrist-roll; `palmFace` (+ `palmFaceN` for the non-dominant hand).
  - **Thumb**: left at bind (curling it about the finger axis made it jut out like a pointing finger).
  - Off-hand rests low at the side on one-handed signs.
- `viewer.html` (Stage 3 local preview: dropdown + play/loop) + `window.AvatarAPI` for capture.
- `capture.mjs` — headless render via **system Edge** (Playwright's bundled Chromium failed to install).
  Modes: default(all) / `--probe SIGN` / `--cal` / `--handcal` / `--shapes`.
- In `E:\ASL_Game`: `core/synthesis3d.py` + `tools/export_avatar_anim.py` → `anim/<SIGN>.json`
  (body-relative wrist targets + handshape + palmFace); `tools/encode_avatar_clips.py` (optional PNG→MP4).
- Exported + rendered the **12 coffee-shop signs only** (COFFEE PLEASE THANK_YOU HELLO WANT YES YOU
  LETTER_A/B/L/V/Y). Hospital signs are intentionally excluded — the collaborator owns those.

## Current stage status
- Stage 0 (confirm rig): **✅ complete** (RPM GLB)
- Stage 1 (finger gaps): **🔄 in progress** — solved *procedurally* via adduction (not Blender weight-paint). Fists/flat hands close; thumb artifact fixed. Needs human sign-off.
- Stage 2 (schema): **🔀 divergent** — procedural from recognition rules, not MediaPipe footage. Working.
- Stage 3 (local preview): **✅ complete** — `viewer.html` via static server.
- Stage 4 (calibration review): **⬜ not started** — do NOT self-approve sign quality.

## Last thing that ran
- File modified: `D:\asl-synthesis\avatar_app.js` (thumb→bind; per-hand `palmFace`).
- Command: `cd /d/asl-synthesis && node capture.mjs --probe COFFEE`
- Output: `launched browser via msedge … COFFEE wrote 2 frames`. Top fist no longer juts a thumb; two
  fists stack (top palm-down grinding over bottom palm-up). COFFEE is decent but not final.

## Exactly what to do next
1. **Resolve the repo (blocker).** `D:\asl-synthesis` is untracked. Decide: (a) new standalone GitHub
   repo per the combined prompt's layout, or (b) fold into `msaad9632/ASL_Game`. Then `git init`
   (if standalone) + `.gitignore` (`node_modules/`, `frames/`, `reference_clips/`, `*.log`,
   `install_*.log`, `recap*.log`, `capture_all.log`) + commit + push.
2. **Finish COFFEE in the LIVE preview** (combined prompt says no mp4-per-iteration):
   `cd D:\asl-synthesis && npx http-server -p 5188 .` → open `http://localhost:5188/viewer.html`, pick
   COFFEE. Tune in `E:\ASL_Game\core\synthesis3d.py`: `_NDOM_BASE` / `_dom_offset` (gap + x-align) and
   `_PALM_FACE` / `_PALM_FACE_N` (COFFEE), then `python -m tools.export_avatar_anim COFFEE` and refresh.
3. Eyeball all 12 handshapes in the preview — fists-together and the V spread especially. Curl tuning
   is in `avatar_app.js` `TUNE` (`fingerCurlGain` 2.6, `fingerCurlSign` both +1). The flex axis is
   **computed** from the rig — do not hardcode it.
4. Wire the `?sign=SIGN_ID` query param into `viewer.html` (combined prompt Stage 3 asks for it).
5. **STOP** → human review per Stage 4; log each sign in `calibration_log.md`. No self-approval.

## Open questions / blockers
- **`D:\asl-synthesis` is not on GitHub and has no remote** — collaborator cannot pull the avatar work
  until a repo is chosen + created (no `gh` CLI here, so a human must create the GitHub repo).
- **Pipeline divergence**: keep the procedural rules→schema path, or switch to the prompt's
  MediaPipe-footage→schema path? Different schema formats — reconcile before scaling vocabulary.
- `E:\ASL_Game` has ~14 uncommitted changes (the 3D exporter + the 2D synthesis pipeline). A prior note
  says push `ASL_Game` to **branches, not main** (teammate shares it); the combined prompt says push to
  **main**. Reconcile which applies to the avatar repo vs the recognition repo.

## Watch out for
- Headless render uses **system Edge** (`chromium.launch({ channel: 'msedge' })`). Playwright's bundled
  Chromium only downloaded a 2.3 MB stub (side-by-side config error) — don't rely on it.
- The **Bash working directory resets** between calls — always `cd /d/asl-synthesis` before `node capture.mjs`.
- No Python 3D libs (pyrender/trimesh/pygltflib) installed — all 3D runs through Three.js.
- Palm orientation is wrist-roll only (one DOF, approximate). Fine handshapes may need more.
- mp4 capture exists (`capture.mjs` + `encode_avatar_clips.py`) but the combined prompt prefers the
  **live preview loop** for iteration — use that, capture only for sharing/review.
