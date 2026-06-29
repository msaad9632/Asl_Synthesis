// avatar_app.js — drives the REAL Ready Player Me avatar's own bones to perform ASL signs.
//
// This is the procedural-avatar pipeline (the PDF's Phases 2-5) applied to the actual GLB skeleton,
// not a stand-in stick rig:
//   * arms  -> analytical 2-bone IK (aim LeftArm/LeftForeArm so the hand reaches a world target),
//   * fingers -> handshape presets applied as local bone curls on the four-joint finger chains,
//   * motion -> per-frame wrist targets read from anim/<SIGN>.json, which is exported from the SAME
//               Python Sign schema the recognition verifier uses (single source of truth).
//
// Body-relative: every target is an offset (in shoulder-widths) from a reference bone, mapped into
// world space against the live skeleton, so it scales to any avatar. Exposes window.AvatarAPI for the
// headless capture script, and a small play/loop UI for interactive viewing.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ---- tunables (calibrated against the RPM rig) --------------------------------------------------
const TUNE = {
  // Fingers flex about the hand's KNUCKLE LINE (index-MCP -> pinky-MCP), computed live from the rig
  // rather than guessed, so all four fingers curl in parallel toward the palm and never converge.
  fingerCurlSign: { Left: 1, Right: 1 },        // both +1: curl direction handled by bind-pose knuckle axis
  fingerCurlGain: { Index: 2.4, Middle: 2.6, Ring: 2.8, Pinky: 2.9 },   // per-finger total radians
  jointWeights: [0.33, 0.42, 0.25],             // proximal / intermediate / distal share of the curl
  thumbCurlGain: 1.7,                            // thumb folds across the palm when not extended
};
const FINGERS = ['Index', 'Middle', 'Ring', 'Pinky'];

// ---- scene ---------------------------------------------------------------------------------------
const container = document.getElementById('canvas-container') || document.body;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f131b);

const camera = new THREE.PerspectiveCamera(32, window.innerWidth / window.innerHeight, 0.01, 100);
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xffffff, 0x35404f, 2.2));
const key = new THREE.DirectionalLight(0xffffff, 2.0); key.position.set(1.2, 2.5, 2.5); scene.add(key);
const rim = new THREE.DirectionalLight(0x9fd0ff, 0.8); rim.position.set(-2, 1.5, -2); scene.add(rim);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// ---- avatar state -------------------------------------------------------------------------------
const bones = {};
const fingerBind = {};               // uuid -> bind quaternion (fingers only; arms are IK-driven)
const armLen = { Left: {}, Right: {} };
let avatarReady = false;

const loader = new GLTFLoader();
loader.load('/readyplayer.me.glb', (gltf) => {
  const model = gltf.scene;
  scene.add(model);
  model.traverse((o) => { if (o.isBone) bones[o.name] = o; });
  model.updateMatrixWorld(true);

  for (const side of ['Left', 'Right']) {
    const arm = bones[side + 'Arm'], fore = bones[side + 'ForeArm'], hand = bones[side + 'Hand'];
    armLen[side].l1 = worldPos(arm).distanceTo(worldPos(fore));
    armLen[side].l2 = worldPos(fore).distanceTo(worldPos(hand));
    for (const f of FINGERS.concat(['Thumb'])) {
      for (let j = 1; j <= 3; j++) {
        const b = bones[`${side}Hand${f}${j}`];
        if (b) fingerBind[b.uuid] = b.quaternion.clone();
      }
    }
  }
  frameCamera();
  // rest pose: arms down in front so an un-driven hand isn't stuck in the T/A-pose
  restPose();
  avatarReady = true;
  AvatarAPI.ready = true;
  setStatus('avatar ready');
}, undefined, (err) => setStatus('GLB load failed: ' + err));

function worldPos(obj) { const v = new THREE.Vector3(); obj.getWorldPosition(v); return v; }

function frameCamera() {
  const chest = worldPos(bones.Spine2 || bones.Spine1 || bones.Spine);
  const sw = worldPos(bones.LeftArm).distanceTo(worldPos(bones.RightArm)) || 0.3;
  const target = chest.clone().add(new THREE.Vector3(0, 0.02, 0));
  camera.position.copy(target).add(new THREE.Vector3(0, 0.05, sw * 4.2));
  controls.target.copy(target);
  controls.update();
}

// ---- body frame (right/up/forward) for mapping body-relative offsets to world ------------------
function bodyFrame() {
  const sR = worldPos(bones.RightArm), sL = worldPos(bones.LeftArm);
  const right = sR.clone().sub(sL).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  let fwd = new THREE.Vector3().crossVectors(right, up).normalize();
  if (fwd.z < 0) fwd.multiplyScalar(-1);          // ensure +z points toward the camera/front
  const sw = sR.distanceTo(sL) || 0.3;
  return { right, up, fwd, sw };
}

function targetWorld(anchorJoint, off) {
  const ref = bones[anchorJoint] || bones.Spine2;
  const { right, up, fwd, sw } = bodyFrame();
  return worldPos(ref)
    .addScaledVector(right, off[0] * sw)
    .addScaledVector(up, off[1] * sw)
    .addScaledVector(fwd, off[2] * sw);
}

function bodyToWorld(dir) {
  const { right, up, fwd } = bodyFrame();
  return new THREE.Vector3()
    .addScaledVector(right, dir[0]).addScaledVector(up, dir[1]).addScaledVector(fwd, dir[2]).normalize();
}

// ---- analytical 2-bone IK (Law of Cosines + pole), applied by aiming the GLB's own bones --------
function solveElbow(S, T, l1, l2, pole) {
  const toT = new THREE.Vector3().subVectors(T, S);
  let d = THREE.MathUtils.clamp(toT.length(), Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4);
  const axis = toT.clone().normalize();
  const cosA = THREE.MathUtils.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const alpha = Math.acos(cosA);
  const rel = new THREE.Vector3().subVectors(pole, S);
  let bend = rel.clone().addScaledVector(axis, -rel.dot(axis));
  if (bend.lengthSq() < 1e-8) bend = new THREE.Vector3(0, -1, 0).addScaledVector(axis, axis.y);
  bend.normalize();
  return S.clone().addScaledVector(axis, l1 * Math.cos(alpha)).addScaledVector(bend, l1 * Math.sin(alpha));
}

function aimBone(bone, child, targetW) {
  bone.updateWorldMatrix(true, false);
  const bp = worldPos(bone), cp = worldPos(child);
  const cur = cp.sub(bp).normalize();
  const des = targetW.clone().sub(bp).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(cur, des);
  const curW = new THREE.Quaternion(); bone.getWorldQuaternion(curW);
  const newW = q.multiply(curW);
  const parentW = new THREE.Quaternion(); bone.parent.getWorldQuaternion(parentW);
  bone.quaternion.copy(parentW.invert().multiply(newW));
  bone.updateMatrixWorld(true);
}

// Retargeting: aim a bone so its child points along a world-space DIRECTION (not a point target).
function aimBoneDir(bone, child, dirW) {
  const bp = worldPos(bone);
  aimBone(bone, child, bp.clone().addScaledVector(dirW, 1.0));
}

// Drive one arm directly from captured upper-arm + forearm directions (mocap retargeting).
function retargetArm(side, uaDir, faDir) {
  const arm = bones[side + 'Arm'], fore = bones[side + 'ForeArm'], hand = bones[side + 'Hand'];
  aimBoneDir(arm, fore, bodyToWorld(uaDir));
  aimBoneDir(fore, hand, bodyToWorld(faDir));
}

function poseArm(side, targetW) {
  const arm = bones[side + 'Arm'], fore = bones[side + 'ForeArm'], hand = bones[side + 'Hand'];
  const S = worldPos(arm);
  const { up, fwd } = bodyFrame();
  const l1 = armLen[side].l1, l2 = armLen[side].l2;
  const pole = S.clone().addScaledVector(up, -1.6 * l1).addScaledVector(fwd, 0.7 * l1);
  const elbow = solveElbow(S, targetW, l1, l2, pole);
  aimBone(arm, fore, elbow);
  aimBone(fore, hand, targetW);
}

// Roll the wrist about the forearm axis so the palm faces `faceWorld` — makes the handshape
// readable to the viewer (fingerspelling is palm-out) without moving the hand off its IK target.
function orientPalm(side, faceWorld) {
  const hand = bones[side + 'Hand'];
  hand.updateWorldMatrix(true, false);
  const knuckle = worldPos(bones[`${side}HandIndex1`]).sub(worldPos(bones[`${side}HandPinky1`])).normalize();
  const rollAxis = worldPos(hand).sub(worldPos(bones[side + 'ForeArm'])).normalize();
  let palmN = new THREE.Vector3().crossVectors(rollAxis, knuckle).normalize();
  if (palmN.dot(faceWorld) < 0) palmN.negate();   // pick the outward palm normal
  const proj = (v) => v.clone().addScaledVector(rollAxis, -v.dot(rollAxis)).normalize();
  const cur = proj(palmN), tgt = proj(faceWorld);
  if (cur.lengthSq() < 1e-6 || tgt.lengthSq() < 1e-6) return;
  const q = new THREE.Quaternion().setFromUnitVectors(cur, tgt);
  const curW = new THREE.Quaternion(); hand.getWorldQuaternion(curW);
  const parentW = new THREE.Quaternion(); hand.parent.getWorldQuaternion(parentW);
  hand.quaternion.copy(parentW.invert().multiply(q.multiply(curW)));
  hand.updateMatrixWorld(true);
}

// ---- handshape presets as finger-bone curls -----------------------------------------------------
function _localAxis(bone, axisWorld) {
  const wq = new THREE.Quaternion(); bone.getWorldQuaternion(wq);
  return axisWorld.clone().applyQuaternion(wq.invert());
}

function _signedAngle(a, b, axis) {
  // Angle to rotate vector a onto b, measured about `axis` (right-handed).
  const cross = new THREE.Vector3().crossVectors(a, b).dot(axis);
  return Math.atan2(cross, a.dot(b));
}

// Pose a hand. A finger has TWO knuckle DOF: flexion (curl, about the knuckle line) AND
// abduction/adduction (spread, about the palm normal). The RPM bind pose fans the fingers apart, so
// for a closed fist or fingers-together flat hand we must adduct each finger to parallel before
// curling — otherwise constant gaps remain between the fingers. `shape.together` (0..1) controls how
// much the fan is closed; `shape.spread` adds a per-finger splay (e.g. the V handshape).
function setHand(side, shape, faceWorld = null) {
  for (const f of FINGERS.concat(['Thumb'])) {
    for (let j = 1; j <= 3; j++) { const b = bones[`${side}Hand${f}${j}`]; if (b) b.quaternion.copy(fingerBind[b.uuid]); }
  }
  bones[`${side}Hand`].updateMatrixWorld(true);

  const knuckle = worldPos(bones[`${side}HandIndex1`]).sub(worldPos(bones[`${side}HandPinky1`])).normalize();
  const midDir = worldPos(bones[`${side}HandMiddle2`]).sub(worldPos(bones[`${side}HandMiddle1`])).normalize();
  const palmN = new THREE.Vector3().crossVectors(knuckle, midDir).normalize();
  const sgn = TUNE.fingerCurlSign[side];
  const together = shape.together === undefined ? 1.0 : shape.together;
  const spread = shape.spread || [0, 0, 0, 0];

  // Curl axis: fingers must always fold TOWARD the palm. The palm faces `faceWorld` (set by
  // orientPalm), so the fingertip's curl motion is toward +faceWorld; the axis that produces that is
  // cross(faceWorld, midDir). This is orientation-independent — it no longer flips when a hand is
  // rolled palm-up (the COFFEE lower fist) or for the mirrored Left hand. Fall back to the raw
  // knuckle line + per-side sign only when the sign declares no palm facing.
  // Flex about the rig's own knuckle line. +rotation about `knuckle` moves the fingertip toward
  // palmN (=knuckle×midDir); a fist must close toward the side the palm faces (faceWorld). So the
  // sign is sign(palmN·faceWorld): +1 for the palm-down top fist, -1 for the palm-UP lower fist whose
  // knuckle line is reversed by the roll (this is what made the lower hand splay open).
  // palmN from cross(knuckle, midDir) can point either toward or away from the palm depending on
  // the wrist roll. When the hand is rolled palm-up (COFFEE lower fist), BOTH palmN AND the knuckle
  // axis flip together — so a constant curlSign produces opposite curl directions for palm-down vs
  // palm-up hands. Fix: if palmN points away from faceWorld, negate BOTH palmN and curlAxis so that
  // +rotation about the corrected axis always curls fingers toward the palm.
  const curlAxis = knuckle;
  if (faceWorld && palmN.dot(faceWorld) < 0) palmN.negate();
  const curlSign = sgn;

  const measured = shape.measured ? shape.measured.flex : null;
  FINGERS.forEach((f, fi) => {
    // Curl amount: prefer the REAL measured footage curl; fall back to the 0/1 preset extension.
    const close = measured ? measured[fi] : 1 - shape.ext[fi];
    const gain = TUNE.fingerCurlGain[f];
    // Full adduction closes the bind-pose fan so a flat hand (B / THANK_YOU) has its fingers TOGETHER
    // with no gaps. Fingers that must separate (V index/middle, Y pinky) get an explicit `spread`
    // below that overrides the closure.
    const tog = together;
    const j1 = bones[`${side}Hand${f}1`];
    const d = worldPos(bones[`${side}Hand${f}2`]).sub(worldPos(j1)).normalize();
    const adduct = _signedAngle(d, midDir, palmN) * tog + spread[fi];
    j1.quaternion.copy(fingerBind[j1.uuid])
      .multiply(new THREE.Quaternion().setFromAxisAngle(_localAxis(j1, palmN), adduct))
      .multiply(new THREE.Quaternion().setFromAxisAngle(_localAxis(j1, curlAxis), close * gain * TUNE.jointWeights[0] * curlSign));
    for (let j = 2; j <= 3; j++) {
      const b = bones[`${side}Hand${f}${j}`]; if (!b) continue;
      b.quaternion.copy(fingerBind[b.uuid])
        .multiply(new THREE.Quaternion().setFromAxisAngle(_localAxis(b, curlAxis), close * gain * TUNE.jointWeights[j - 1] * curlSign));
    }
  });

  // Thumb: graduated 0.0–1.0 control. 1.0 = fully at bind (extended), 0.0 = fully folded toward palm,
  // 0.5 = alongside index (A shape). Backward compatible with old boolean (true→1.0, false→0.0).
  const thumbExt = typeof shape.thumb === 'number' ? shape.thumb : (shape.thumb ? 1.0 : 0.0);
  if (thumbExt < 1.0) {
    const t1 = bones[`${side}HandThumb1`];
    if (t1) t1.quaternion.copy(fingerBind[t1.uuid]).multiply(
      new THREE.Quaternion().setFromAxisAngle(_localAxis(t1, palmN), TUNE.thumbCurlGain * (1.0 - thumbExt) * curlSign));
  }
  bones[`${side}Hand`].updateMatrixWorld(true);
}

function restPose() {
  for (const side of ['Left', 'Right']) {
    setHand(side, { ext: [1, 1, 1, 1], thumb: true });
    const x = side === 'Right' ? 0.10 : -0.10;
    poseArm(side, targetWorld('Spine2', [x, -0.05, 0.55]));
  }
}

// ---- animation playback -------------------------------------------------------------------------
let anim = null;

function applyFrame(i) {
  if (!anim) return;
  bones.Spine2 && bones.Spine2.parent && scene.updateMatrixWorld(true);
  const fr = anim.frames[i];
  const face = anim.palmFace ? bodyToWorld(anim.palmFace) : null;
  const faceN = anim.palmFaceN ? bodyToWorld(anim.palmFaceN) : face;   // non-dominant may differ

  if (anim.mode === 'retarget') {
    // Replay the real captured arm motion: aim both arms along the recorded joint directions, then
    // shape the dominant hand from the measured finger curl. The signer is mirrored (their right
    // hand is the avatar's, recorded as 'Right'); we drive avatar Right from r* and Left from l*.
    retargetArm('Right', fr.rUA, fr.rFA);
    retargetArm('Left', fr.lUA, fr.lFA);
    setHand('Right', anim.dom, null);
    if (face) orientPalm('Right', face);
    setHand('Left', anim.ndom || { ext: [1, 1, 1, 1], thumb: 1.0 }, null);
    return;
  }
  // Order matters: IK first, then curl fingers (using the pre-roll knuckle axis), THEN roll the
  // wrist so the palm faces the target. Fingers ride along with the roll and stay closed correctly
  // regardless of the final palm orientation. This avoids the per-side / per-roll curl sign issues.
  poseArm('Right', targetWorld(anim.anchorJoint, fr.dom));
  setHand('Right', anim.dom, null);
  if (face) orientPalm('Right', face);
  if (anim.two_handed && fr.ndom) {
    poseArm('Left', targetWorld(anim.anchorJoint, fr.ndom));
    setHand('Left', anim.ndom || anim.dom, null);
    if (faceN) orientPalm('Left', faceN);
  } else {
    poseArm('Left', targetWorld('LeftArm', [-0.55, -1.15, 0.45]));   // off-arm hangs OUT to the side, clear of the torso
    setHand('Left', { ext: [1, 1, 1, 1], thumb: true });
  }
}

// ---- public API for headless capture ------------------------------------------------------------
const AvatarAPI = {
  ready: false,
  signs: [],
  fps: 30,
  async prepare(name) {
    anim = await fetch(`/anim/${name}.json`).then((r) => r.json());
    this.fps = anim.fps;
    return anim.frames.length;
  },
  frameCount() { return anim ? anim.frames.length : 0; },
  showFrame(i) { applyFrame(i); renderer.render(scene, camera); },
  snapshot() { return renderer.domElement.toDataURL('image/png'); },
  // Orbit the camera `deg` around the body (0 = front, 90 = left side) and snapshot — for catching
  // depth clipping (arm through torso) that a front view hides.
  orbitSnapshot(i, deg) {
    applyFrame(i);
    const t = controls.target.clone();
    const r = Math.hypot(camera.position.x - t.x, camera.position.z - t.z);
    const rad = deg * Math.PI / 180;
    camera.position.set(t.x + r * Math.sin(rad), camera.position.y, t.z + r * Math.cos(rad));
    camera.lookAt(t);
    renderer.render(scene, camera);
    const url = this.snapshot();
    frameCamera();   // restore
    return url;
  },
  // Close-up of the RIGHT hand from a 3/4 side angle so the finger-curl profile is visible.
  // The flex axis is computed from the rig; `sign` (curl direction) and `gain` are the tunables.
  handCal(sign, gain = 2.7, shape = { ext: [0, 0, 0, 0], thumb: false }) {
    TUNE.fingerCurlSign.Right = sign;
    TUNE.fingerCurlGain = gain;
    scene.updateMatrixWorld(true);
    setHand('Left', { ext: [1, 1, 1, 1], thumb: true });
    poseArm('Left', targetWorld('Spine1', [-0.45, -0.45, 0.3]));   // park left hand low/away
    poseArm('Right', targetWorld('Spine1', [0.18, 0.0, 0.9]));     // hand forward, clear of body
    setHand('Right', shape);
    scene.updateMatrixWorld(true);
    const hp = worldPos(bones.RightHand);
    camera.position.set(hp.x + 0.26, hp.y + 0.10, hp.z + 0.16);    // 3/4 side, slightly above
    camera.lookAt(hp.x - 0.02, hp.y - 0.02, hp.z + 0.04);
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL('image/png');
  },
};
window.AvatarAPI = AvatarAPI;

// ---- interactive UI + render loop ---------------------------------------------------------------
let playing = false, frame = 0, last = 0;
const sel = document.getElementById('sign');
const status = document.getElementById('status');
function setStatus(t) { if (status) status.textContent = t; }

fetch('/anim/index.json').then((r) => r.json()).then((idx) => {
  AvatarAPI.signs = idx.signs;
  // Stage 3: ?sign=SIGN_ID picks the initial clip (case-insensitive); falls back to the first sign.
  const qs = new URLSearchParams(location.search);
  const want = (qs.get('sign') || '').toUpperCase();
  const initial = idx.signs.includes(want) ? want : idx.signs[0];
  if (sel) {
    idx.signs.forEach((s) => {
      const o = document.createElement('option'); o.value = o.textContent = s;
      if (s === initial) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => { AvatarAPI.prepare(sel.value).then(() => { frame = 0; }); });
  }
  // Loop continuously by default so a refresh immediately shows the (updated) motion.
  AvatarAPI.prepare(initial).then(() => { frame = 0; playing = true; });
});

document.getElementById('play')?.addEventListener('click', () => { playing = !playing; });

function loop(t) {
  requestAnimationFrame(loop);
  controls.update();
  if (avatarReady && anim && playing) {
    const dt = (t - last) / 1000;
    if (dt >= 1 / AvatarAPI.fps) {
      last = t;
      applyFrame(frame);
      frame = (frame + 1) % anim.frames.length;
    }
  }
  renderer.render(scene, camera);
}
requestAnimationFrame(loop);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
