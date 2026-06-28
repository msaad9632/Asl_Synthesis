# Project Context: Procedural ASL Avatar Synthesis Pipeline
**File Role**: Master Session State & Transition Document
**Last Updated**: 2026-06-28

---

## 1. Project Mandate & Core Requirement
The objective is to implement a production-grade, web-native (Three.js/WebGL) American Sign Language (ASL) procedural animation engine. The architecture is strictly **deterministic and calibration-driven**, rejecting machine-learning/stochastic generators to preserve linguistic fidelity and prevent rendering errors. 

The pipeline translates high-level linguistic descriptions (declarative JSON schemas specifying body-relative anchors, parametric curves, and handshape timelines) into real-time joint rotations and `THREE.AnimationClip` outputs.

---

## 2. Core Research Core Concepts (Paper Ingestion)
The architecture conforms to the core research paper: *"Procedural Synthesis of American Sign Language Avatars: A Deterministic Calibration-Driven Architecture"*. It structures the system into **9 distinct phases**:

1. **Phase 1: 3D Avatar Ingestion**: GLTF/glb import, skinned mesh isolation, and canonical bone map traversal.
2. **Phase 2: Handshape Preset Library**: Storing joint rotations as local quaternions for discrete phonological mapping.
3. **Phase 3: Human-in-the-Loop Preset Verification**: Visual sign quality verification gates.
4. **Phase 4: Trajectory Generators**: Parametric equations modeling transition paths.
5. **Phase 5: Sign Definition Schema**: Compiling trajectories, handshapes, palm orientation, and reference anchors.
6. **Phase 6: Verification and Calibration**: Visual loops verifying target collisions.
7. **Phase 7: Sign Library Accumulation**: Cataloging verified definitions (e.g. CUP, TEA, COFFEE).
8. **Phase 8: Non-Manual Markers (NMMs) Deferral**: Deferring facial blends to avoid the uncanny valley.
9. **Phase 9: Product Delivery**: Compiling sequence blocks into the lesson/learning software loop.

### Core Mathematical Formulations Implemented:
* **Linear Trajectory Easing**:
  $$P(t) = P_{\text{start}} + E(t) \cdot (P_{\text{end}} - P_{\text{start}})$$
* **Circular/Arc Parametric Plane Math**:
  $$P(t) = C + r \cos(\theta(t)) \cdot \mathbf{u} + r \sin(\theta(t)) \cdot \mathbf{v}$$
  *(where $\mathbf{u}$ and $\mathbf{v}$ are orthonormal basis vectors perpendicular to the plane normal)*
* **Damped Sinusoidal Oscillation**:
  $$P(t) = P_{\text{base}} + A \sin(2\pi f \cdot E(t)) \cdot e^{-\text{decay} \cdot E(t)} \cdot \mathbf{axis}$$
* **Analytical 2-Bone IK Solver (Law of Cosines)**:
  $$\cos(\theta_E) = \frac{L_1^2 + L_2^2 - D^2}{2 L_1 L_2}$$
  $$\cos(\theta_S) = \frac{D^2 + L_1^2 - L_2^2}{2 D L_1}$$

---

## 3. Work Accomplished So Far

### 3.1 Implemented Code Modules (`d:\asl-synthesis\`)
* **`ASL_ARCHITECTURE_SPEC.md`**: Detailed technical specification of the entire system architecture.
* **`AnalyticalIKSolver.js`**: Closed-form analytical solver that computes shoulder and elbow rotations in constant time. Features target clamping, pole vector swivel, and palm orientation overrides.
* **`KinematicCurves.js`**: Parametric trajectory classes (`LinearTrajectory`, `ArcTrajectory`, `OscillatoryTrajectory`), biological ease curves (linear, sine inout, cubic inout, back-out), and body-relative landmark anchors.
* **`SignAssemblyEngine.js`**: Orchestration engine that coordinates timelines, performs handshape blending (SLERP), runs IK, and compiles tracks into `THREE.AnimationClip` objects.
* **`handshapePresets.json`**: Preset library containing local quaternions for 13 distinct handshapes.

### 3.2 Verification and Testing
* **`package.json`**: Configured as an ES module package with `three` dependency.
* **`test_sign.js`**: A Node.js integration script that dynamically builds a 45-bone mock rig, loads the presets, parses the schemas, and successfully compiles animation clips for **CUP** (one-handed arc) and **TEA** (two-handed asymmetric oscillatory) with zero errors.

### 3.3 Blender 5.1 Headless Rendering
* **`animate_coffee.py`**: A python script that keyframes and renders the ASL **COFFEE** sign using the modular robot avatar.
* **`COFFEE_frames/`**: 72 rendered high-contrast PNG frames.
* **`robot_COFFEE_animated.blend`**: The saved, fully-animated Blender file.

### 3.4 Live Three.js Web Previewer
* **`index.html`**, **`index.css`**, and **`main.js`**: Host an interactive, split-screen WebGL application served locally via Vite.
* Enables testing the procedural math on a visible skeletal rig (CUP, TEA) and the robot model (CUP, TEA, COFFEE) simultaneously.
* Server is active at: **`http://localhost:5173/`**

---

## 4. Critical Debugging Log & Resolutions

When resuming or continuing work, pay attention to these resolved bugs:

1. **The "Pretzel Arm" Matrix Update Bug**:
   * *Symptom*: Bones twisted into invalid angles because the elbow's local-space calculation read the shoulder's world matrix before the shoulder's new local rotation had propagated.
   * *Fix*: Inserted `this.upperArm.updateWorldMatrix(true, false);` inside `AnalyticalIKSolver.js` immediately after applying the shoulder's rotation.
2. **Trajectory API Signature Mismatch**:
   * *Symptom*: Engine crashed with `trajectory.evaluate is not a function` because the engine passed a single JSON config block to constructors expecting unpacked `Vector3` arguments.
   * *Fix*: Updated `_instantiateTrajectory()` in `SignAssemblyEngine.js` to parse arrays and extract parameters before instantiating.
3. **Preset Key Parsing Crash**:
   * *Symptom*: Engine crashed trying to read `boneData.rotation[x]` because `handshapePresets.json` stored rotations as flat arrays rather than objects.
   * *Fix*: Updated `_applyHandshape()` and `_applyHandshapeBlend()` in `SignAssemblyEngine.js` to handle both flat array and object schemas gracefully.
4. **Three.js SkinnedMesh Render Crash**:
   * *Symptom*: Browser rendering loop crashed on load with `TypeError: Cannot read properties of undefined (reading 'getX')` inside `SkinnedMesh.computeBoundingSphere`.
   * *Fix*: Removed the memory-only `mockSkinnedMesh` from the active scene graph (`scene.add` / `skeletonGroup.add`). This keeps it in memory for skeleton reference mapping while bypassing WebGL bounding volume calculations.
5. **Hardcoded Bone Name Flexibility**:
   * *Symptom*: Rig bone names did not match canonical naming conventions.
   * *Fix*: Added `customBoneNames` parameter to the `SignAssemblyEngine` constructor.
6. **Double Gravity Space Math (Bug 1)**:
   * *Symptom*: Arms shot off-screen or twisted because the engine added the anchor's world position to trajectory evaluations that had already resolved to world coordinates.
   * *Fix*: Standardized trajectories to return local offset vectors, and updated `_instantiateTrajectory` in `SignAssemblyEngine.js` to parse raw offsets rather than resolving them to world anchors during instantiation.
7. **Bone Naming Suffix Mismatch (Bug 2)**:
   * *Symptom*: Handshape presets silently failed to apply, leaving hands rigidly frozen because the rig joints were named with indices (e.g. `Thumb1`) while presets mapped to suffixes (e.g. `_Proximal`).
   * *Fix*: Corrected the joint creation loop in `main.js` and `test_sign.js` to use `_Proximal`, `_Intermediate`, and `_Distal` suffixes, and restored the default finger prefixes to `RightHand`/`LeftHand` in `SignAssemblyEngine.js`.
8. **Canonical Rig Axis Mismatches (Bug 3)**:
   * *Symptom*: Solver's pole-vector math was inverted, causing the elbow to bend backward into the ribs.
   * *Fix*: Realigned the dynamic 3D simulation skeleton in `main.js` and `test_sign.js` to point child segments along the local `+Y` axis, conforming to the solver's coordinate assumptions.

---

## 5. Next Steps & Active Debugging Context
1. **Verify Handshape Flexion**: Verify that fingers flex correctly into the `PINCH`, `C_SHAPE`, and `CUP_HAND` poses when playing **TEA** and **CUP**.
2. **Extend Sign Library**: Author additional signs by combining signs in a timeline.
3. **Implement Morph Target Blending**: If facial morphs are integrated in a future stage, implement a morph weight controller inside the engine loop.
4. **Model Integration**: If the modular robot model is replaced with a rigged SkinnedMesh model, import the `.glb`, pass it into the `AvatarIngestor`, and bind the active `SignAssemblyEngine` directly to it.
