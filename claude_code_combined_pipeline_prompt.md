ASL Avatar Animation Pipeline — Project Context & Instructions

What this project is

We are building a hybrid MediaPipe + 3D avatar pipeline to animate a stylized character
performing ASL (American Sign Language) signs. MediaPipe is used only as an authoring tool
to extract keyframes from recorded signer footage — it never runs at runtime or drives
recognition. The final output is a Sign Definition Schema (JSON) that drives a Three.js
avatar viewer.

Two-person setup

This project is worked on by two people on separate Claude Pro accounts.
When handing off, follow the Session Handoff Protocol at the bottom of this file.

Tech stack


Blender (headless via blender -b) — avatar rigging and mesh fixes
Python + MediaPipe — landmark capture and keyframe extraction
Node.js + Three.js — local glTF avatar preview server
GitHub — source of truth for all code, schema files, and handoff notes


GitHub repo


Fill this in before first session:
Repo URL: https://github.com/YOUR_USERNAME/YOUR_REPO
Branch: main




Environment requirements (install manually before starting)


 Blender 3.x or 4.x installed and accessible via blender in terminal
 Python 3.10+ with mediapipe, numpy, opencv-python installed
 Node.js 18+ for the Three.js preview server
 Git configured with access to the shared GitHub repo
 Avatar source file downloaded (Quaternius Universal Base Characters — CC0, recommended)



File structure (once set up)

/project-root
├── CLAUDE.md                  ← this file
├── HANDOFF.md                 ← written by Claude Code before each session ends
├── avatar/
│   ├── avatar.blend           ← source avatar file
│   ├── avatar_fixed.blend     ← post-fix (finger gaps resolved)
│   └── avatar_fixed.glb      ← exported for Three.js viewer
├── scripts/
│   ├── inspect_rig.py         ← Stage 0: bone hierarchy inspector
│   ├── fix_fingers.py         ← Stage 1: finger gap/weight paint fix
│   ├── capture_landmarks.py   ← Stage 2: MediaPipe landmark capture + 1Euro filter
│   ├── extract_keyframes.py   ← Stage 2: keyframe extractor (3-4 keys per sign)
│   └── schema_translator.py  ← Stage 2: converts keyframes → Sign Definition Schema
├── preview/
│   └── index.html             ← Stage 3: Three.js local viewer (run with `npm run dev`)
├── schema/
│   └── signs/                 ← one .json per sign, in Sign Definition Schema format
└── calibration_log.md         ← Stage 4: sign ID → reviewed → approved → notes


Stage status tracker


Update this every session before pushing. Use ⬜ Not started / 🔄 In progress / ✅ Done



Stage | What it does | Status
0 | Find + verify rigged avatar with finger bones | ✅ Done (RPM GLB, 67 joints)
1 | Finger correction via per-finger bone tuning (NOT blend shapes — avatar has none) | ✅ Done
2 | MediaPipe keyframe extractor -> schema | ✅ Done (COFFEE pilot)
2b | Batch self-record tool (batch_capture.py + batch_export.py) | ✅ Done
3 | Three.js local preview server | ✅ Done (viewer.html + ?sign= + auto-loop)
4 | Human calibration review loop | 🔄 In progress


Hard rules — read before doing anything


Do NOT use robot.blend — it has no armature and no finger geometry (already verified).
Do not attempt to rig or animate it. Wait for confirmed rig from Stage 0 first.
Video footage source: Only footage WE recorded ourselves (or a hired signer).
Never WLASL, How2Sign, ASL Citizen, or any restricted-license dataset — even for
authoring/testing. The output (calibrated movement parameters) ends up inside the
shipped schema either way.
STOP points are mandatory: At each STOP, report what was found/built, wait for
human confirmation. Do not self-approve and move to the next stage.
No self-approval on sign quality: Do not mark a sign as "looks human enough."
That judgment goes to the human reviewer. Log it, wait.
No mp4 renders per iteration: Use the Stage 3 local preview loop only.
If blocked: Don't keep retrying the same approach against a blocker that isn't
going to resolve itself. Report what's blocking and why, then wait.
If uncertain: Surface it — license questions, ambiguous schema values, whether
a motion looks linguistically right — ask rather than guess and move on.



STAGE 0 — Confirm the avatar before doing any animation work

Find a 3D character model that meets ALL of these:


Full skeleton/armature included (not a static display mesh)
Individual finger bones — at least 3 joints per finger, not a single rigid hand
Separate shoulder, elbow, wrist bones per arm (for IK)
Commercial-use license (or CC0/free for prototyping)
Exportable as glTF (.glb) or FBX
Stylized/cartoon look, not photorealistic


Strong starting candidates: Quaternius "Universal Base Characters" (CC0, free).

Open the candidate file in Blender headless and actually list the bone hierarchy
and finger bone count — do not trust a marketplace description:

blender -b file.blend -P inspect_rig.py

The inspect script should output:


Full bone hierarchy (parent → child tree)
Count of finger bones per hand
Whether hand geometry is a single skinned mesh or separate rigid objects


⛔ STOP — Stage 0

Report the bone hierarchy and finger bone count back to the user.
Wait for confirmation before proceeding to Stage 1.
Do not move forward on an unconfirmed rig.


STAGE 1 — Fix the volume/clipping problem on the confirmed rig

Once we have a confirmed rig with real finger bones:


Load the confirmed avatar file.
Identify all finger bones in the armature
(search for: Thumb / Index / Middle / Ring / Pinky / Hand).
If hand parts are separate rigid mesh objects:
Iterate through them, identify which bone each belongs to (via parent or constraint),
and set each mesh's Object Origin to the world-space coordinate of its corresponding
bone head.
If it's a single skinned mesh:
Select it, enter Weight Paint mode, and run:


python   bpy.ops.object.vertex_group_normalize_all()
   bpy.ops.object.vertex_group_limit_total(limit=4)

on the finger vertex groups.
5. Save as avatar/avatar_fixed.blend
6. Export as avatar/avatar_fixed.glb
7. Run via:

   blender -b avatar.blend -P scripts/fix_fingers.py

⛔ STOP — Stage 1

Show a render or local preview (Stage 3) of a closed-fist pose before moving on.
Confirm the gap is actually fixed — not just that the script ran without error.


STAGE 2 — MediaPipe-as-authoring-tool keyframe extractor

This is the hybrid pipeline architecture. MediaPipe is used to author JSON schema data,
never to render at runtime, and never to drive recognition.

Build the following pipeline in order:

1. Capture
Source video is footage WE recorded ourselves (or a hired signer's footage) only.

2. Filter — apply BEFORE keyframe extraction
Apply a 1Euro Filter or Kalman Filter to the raw MediaPipe landmark stream to remove
jitter. Do this before any keyframe extraction, not after.

3. Keyframe extraction
Do not bake every frame. Write a Python script that identifies the 3-4 critical
keyframes per sign from the filtered landmark sequence:


Start pose
Peak extension / contact point
End pose
(optionally a 4th if the sign has a hold or direction change mid-movement)


4. Schema translation
Convert those keyframes into the Sign Definition Schema format (see reference below):


Handshape preset reference
Location anchor + offset
Movement type / pivot / threshold
Orientation
Do NOT output raw per-frame rotation data.


5. Occlusion failure flagging
If MediaPipe's depth estimate collapses during a keyframe (fingers "spaghetti" or snap
back due to occlusion — e.g. signs where hands cross or touch the chest):


Flag that frame instead of silently extracting bad data
Show the flagged frame so a human decides how to hand-correct it in the schema
Do NOT guess or auto-correct the flagged keyframe


⛔ STOP — Stage 2

Show the architecture and code for this pipeline before running it against real footage.
Wait for approval before executing.


STAGE 3 — Local preview loop instead of video files

Do not generate mp4 renders per iteration. Instead:


Serve the avatar viewer (Three.js / glTF) via a local dev server.
Make it loop the currently-selected sign's animation continuously.
When a schema value changes, the preview should reflect it on refresh/hot-reload.
No re-render or re-export step needed to see the result.


Run with:

cd preview && npm run dev

The viewer should accept a ?sign=SIGN_ID query param to load a specific sign's animation.


STAGE 4 — Calibration review

For every sign generated through this pipeline:


Render it in the Stage 3 local preview loop.
A human reviews it against the four parameters:

Handshape
Location
Movement
Orientation
This is the user, or a fluent/Deaf signer if available.
The agent does not self-approve a sign as "looking human enough."



Log the result in calibration_log.md:


Sign IDReviewedApprovedReviewerNotes


A sign does not get marked done until it has been through this review —
not until the script stops throwing errors.



Sign Definition Schema format (reference)

Each sign lives in schema/signs/<sign_id>.json:

json{
  "sign_id": "EXAMPLE",
  "handshape": "ASL_B",
  "location": {
    "anchor": "chin",
    "offset": { "x": 0, "y": -0.05, "z": 0.1 }
  },
  "movement": {
    "type": "arc",
    "pivot": "wrist",
    "threshold": 0.03
  },
  "orientation": {
    "palm_facing": "away",
    "fingers_pointing": "up"
  },
  "keyframes": [
    { "frame": 0, "pose": "start" },
    { "frame": 12, "pose": "peak" },
    { "frame": 24, "pose": "end" }
  ],
  "occlusion_flags": [],
  "review": {
    "reviewed": false,
    "approved": false,
    "notes": ""
  }
}


Working style


Work through stages in order.
At each STOP point: report what was found/built and what (if anything) didn't work,
then wait for go-ahead.
Don't keep retrying the same approach against a blocker that isn't going to resolve.
If something genuinely uncertain — a license question, an ambiguous schema value,
whether a generated motion looks linguistically right — surface it rather than
guessing and moving on.



⚡ SESSION HANDOFF PROTOCOL


Run this at the end of every session — especially when the context is getting long
or you're about to hit a natural stopping point. Both users share one GitHub repo
and pick up from each other's sessions.



Step 1 — Write HANDOFF.md

Create or overwrite HANDOFF.md in the project root with this exact structure:

markdown# Handoff Note

**Date/Time**: [now]
**Who was working**: [Person A / Person B]

## What was completed this session
- [bullet: every file created, script written, command successfully run]

## Current stage status
- Stage 0: [complete / in progress / blocked]
- Stage 1: [complete / in progress / blocked]
- Stage 2: [complete / in progress / blocked]
- Stage 3: [complete / in progress / blocked]
- Stage 4: [complete / in progress / blocked]

## Last thing that ran
- File modified: [filename]
- Command run: [exact command]
- Output: [paste key output or error message]

## Exactly what to do next
1. [Precise next step — specific file, specific command, not vague]
2. [Step after that]
3. [Continue until the next STOP point]

## Open questions / blockers
- [Anything unresolved the next person needs to decide or investigate]

## Watch out for
- [Any environment gotchas discovered — wrong Python path, Blender version quirk, etc.]

Step 2 — Update the Stage status tracker

Update the Stage status table at the top of this CLAUDE.md file before committing.

Step 3 — Commit and push everything

bashgit add -A
git commit -m "SESSION HANDOFF: [one-line summary of where things are]"
git push origin main

Step 4 — Confirm to the user

Tell the user: "Handoff complete. Your collaborator can pull the repo, read HANDOFF.md,
and pick up from step [N] in Stage [X]."


Picking up someone else's session


git pull origin main
Read HANDOFF.md first — it tells you exactly where to go
Check the Stage status table above
Continue from the "Exactly what to do next" list in HANDOFF.md
When your session ends, repeat the Session Handoff Protocol above