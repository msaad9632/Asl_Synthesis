# Procedural Synthesis of American Sign Language Avatars: Technical Implementation Specification

**Version**: 1.0.0  
**Architecture Class**: Deterministic Calibration-Driven Pipeline  
**Runtime Target**: WebGL 2.0 / WebGPU via Three.js (r160+)  
**Document Status**: Production-Ready Specification  

---

## Table of Contents

1. [Core Architectural Paradigms](#1-core-architectural-paradigms)
2. [Avatar Setup and Anatomical Rig Constraints](#2-avatar-setup-and-anatomical-rig-constraints)
3. [Handshape Preset Engine & Quaternion Preservation](#3-handshape-preset-engine--quaternion-preservation)
4. [3D Trajectory Math and Easing Generators](#4-3d-trajectory-math-and-easing-generators)
5. [Analytical Upper-Limb Inverse Kinematics](#5-analytical-upper-limb-inverse-kinematics)
6. [The Sign Assembly Script](#6-the-sign-assembly-script)
7. [Quality Assurance, Verification Loops, and Human-in-the-Loop Calibration Gates](#7-quality-assurance-verification-loops-and-human-in-the-loop-calibration-gates)
8. [NMM Blending Deferral Strategy](#8-nmm-blending-deferral-strategy)
9. [Applied Case Study Schemas](#9-applied-case-study-schemas)
10. [System Lifecycle Sequencing](#10-system-lifecycle-sequencing)

---

## 1. Core Architectural Paradigms

### 1.1 The Deterministic Imperative

This system **categorically rejects** stochastic machine-learning layers (GANs, diffusion models, neural motion synthesis) as the foundation for sign language avatar animation. The engineering rationale is threefold:

1. **Linguistic Fidelity**: ASL is a fully grammatical language where handshape, palm orientation, movement, location, and non-manual markers each carry phonemic significance. A stochastic model that produces a "most likely" output cannot guarantee that every phonemic parameter is precisely correct. A single incorrect finger joint angle can change the meaning of a sign or render it unintelligible.

2. **Deterministic Reproducibility**: Given identical input parameters (sign definition, avatar rig, calibration data), the system must produce **byte-identical** output on every execution. This is a hard requirement for accessibility certification, QA pipelines, and educational deployment.

3. **Calibration Transparency**: Every output parameter must be traceable to an explicit input. When a sign renders incorrectly, the debugging path must be a direct lookup into the sign definition schema and calibration data — not a black-box investigation into model weights.

### 1.2 Pipeline Phase Architecture

The system is organized into **9 sequential phases**, each with strict input/output contracts:

| Phase | Name | Input | Output |
|-------|------|-------|--------|
| 1 | Avatar Ingestion | `.glb`/`.gltf` file | Validated `THREE.SkinnedMesh` + bone map |
| 2 | Handshape Preset Authoring | Artistic reference + rig | `handshapePresets.json` |
| 3 | Preset Verification | Preset JSON + rig | Per-shape visual pass/fail log |
| 4 | Trajectory Authoring | Sign linguistic description | Parametric curve definitions |
| 5 | Sign Definition Compilation | Trajectories + presets + anchors | Sign definition JSON schema |
| 6 | Integration Verification | Assembled sign + avatar | Per-sign QA pass/fail log |
| 7 | Library Accumulation | Verified sign schemas | Searchable sign dictionary |
| 8 | NMM Deferral Acknowledgment | — | Architectural constraint record |
| 9 | Product Delivery | Full pipeline | Runtime playback system |

### 1.3 Execution Model

The runtime executes as a **pure function pipeline**:

```
SignDefinition × AvatarRig × CalibrationData → AnimationClip
```

There is no hidden state, no learned parameters, no randomness. The `SignAssemblyEngine` reads a declarative sign definition, resolves body-relative spatial anchors against the current avatar's skeleton, generates parametric trajectory curves, solves analytical inverse kinematics at each sampled frame, applies handshape presets to finger bone quaternions, and emits a `THREE.AnimationClip` or drives bones in real-time.

### 1.4 Technology Stack Constraints

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| 3D Runtime | Three.js r160+ | Mature WebGL/WebGPU abstraction with robust skeletal animation |
| Asset Format | glTF 2.0 Binary (`.glb`) | Industry standard, single-file, lossless skeleton/mesh/material packaging |
| Rotation Encoding | Quaternions `[x, y, z, w]` | Gimbal-lock-free, SLERP-interpolable, composable via Hamilton product |
| Coordinate System | Right-handed Y-up | glTF specification default, Three.js native |
| Module System | ES Modules (`import`/`export`) | Tree-shakeable, native browser support |

---

## 2. Avatar Setup and Anatomical Rig Constraints

### 2.1 Mesh Format Requirements

The avatar must be delivered as a **glTF 2.0 Binary** (`.glb`) file containing:

- **Exactly one `THREE.SkinnedMesh`** (or a clearly identified primary mesh if multiple exist).
- **A complete humanoid skeleton** with a minimum of 52 bones covering: spine chain (3+), neck, head, bilateral shoulder/arm/forearm/hand chains, bilateral thumb (3 bones each), bilateral index/middle/ring/pinky fingers (3 bones each), and bilateral leg chains (optional for seated avatars).
- **Bind-pose (T-pose or A-pose)** with consistent rest quaternions stored as identity or near-identity rotations on all bones.
- **Proper skin weights** — max 4 influences per vertex, normalized to sum to 1.0.

### 2.2 Skeleton Hierarchy and Naming Convention

The system requires a **canonical bone naming map** to decouple the avatar's internal bone names from the engine's expectations. The mapping is resolved during Phase 1 (Avatar Ingestion).

**Required canonical bone names:**

```
Root
├── Hips
│   ├── Spine
│   │   ├── Spine1
│   │   │   ├── Spine2
│   │   │   │   ├── Neck
│   │   │   │   │   └── Head
│   │   │   │   ├── LeftShoulder
│   │   │   │   │   └── LeftUpperArm
│   │   │   │   │       └── LeftForeArm
│   │   │   │   │           └── LeftHand
│   │   │   │   │               ├── LeftThumb_Proximal
│   │   │   │   │               │   ├── LeftThumb_Intermediate
│   │   │   │   │               │   │   └── LeftThumb_Distal
│   │   │   │   │               ├── LeftIndex_Proximal
│   │   │   │   │               │   ├── LeftIndex_Intermediate
│   │   │   │   │               │   │   └── LeftIndex_Distal
│   │   │   │   │               ├── LeftMiddle_Proximal  ...
│   │   │   │   │               ├── LeftRing_Proximal    ...
│   │   │   │   │               └── LeftPinky_Proximal   ...
│   │   │   │   └── RightShoulder
│   │   │   │       └── (mirrored right-side hierarchy)
│   │   │   └── ...
```

### 2.3 GLTF Hierarchy Traversal and Bone Map Extraction

The following production code demonstrates the Phase 1 ingestion process — loading a `.glb` file, isolating the `THREE.SkinnedMesh`, and building the canonical bone lookup map:

```javascript
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * AvatarIngestor — Phase 1 pipeline stage.
 * Loads a .glb avatar file, extracts the SkinnedMesh,
 * and builds a canonical bone name → THREE.Bone lookup map.
 */
export class AvatarIngestor {
  constructor() {
    /** @type {THREE.SkinnedMesh|null} */
    this.skinnedMesh = null;

    /** @type {Map<string, THREE.Bone>} */
    this.boneMap = new Map();

    /** @type {THREE.Skeleton|null} */
    this.skeleton = null;

    /** @type {Map<string, THREE.Quaternion>} */
    this.restPoses = new Map();

    /** @type {Object} */
    this.boneLengths = { leftUpperArm: 0, leftForeArm: 0, rightUpperArm: 0, rightForeArm: 0 };
  }

  /**
   * Load and process a .glb avatar file.
   * @param {string} url — URL or path to the .glb file.
   * @param {Object} [nameMapping=null] — Optional map of avatar bone names → canonical names.
   * @returns {Promise<AvatarIngestor>}
   */
  async load(url, nameMapping = null) {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(url);

    // Step 1: Isolate the SkinnedMesh
    this.skinnedMesh = this._findSkinnedMesh(gltf.scene);
    if (!this.skinnedMesh) {
      throw new Error('[AvatarIngestor] No THREE.SkinnedMesh found in the loaded glTF scene.');
    }

    this.skeleton = this.skinnedMesh.skeleton;
    if (!this.skeleton || this.skeleton.bones.length === 0) {
      throw new Error('[AvatarIngestor] SkinnedMesh has no skeleton or zero bones.');
    }

    // Step 2: Build the canonical bone map
    this._buildBoneMap(nameMapping);

    // Step 3: Capture rest poses
    this._captureRestPoses();

    // Step 4: Measure arm segment lengths
    this._measureArmLengths();

    console.log(`[AvatarIngestor] Loaded avatar with ${this.skeleton.bones.length} bones.`);
    console.log(`[AvatarIngestor] Bone map entries: ${this.boneMap.size}`);

    return this;
  }

  /**
   * Recursively find the first SkinnedMesh in the scene graph.
   * @param {THREE.Object3D} root
   * @returns {THREE.SkinnedMesh|null}
   */
  _findSkinnedMesh(root) {
    let result = null;
    root.traverse((child) => {
      if (!result && child.isSkinnedMesh) {
        result = child;
      }
    });
    return result;
  }

  /**
   * Build a Map<canonicalName, THREE.Bone> from the skeleton.
   * If a nameMapping is provided, translates avatar names to canonical names.
   * Otherwise, uses the bone names directly.
   * @param {Object|null} nameMapping — { avatarBoneName: canonicalName }
   */
  _buildBoneMap(nameMapping) {
    this.boneMap.clear();
    for (const bone of this.skeleton.bones) {
      const canonicalName = nameMapping ? (nameMapping[bone.name] || bone.name) : bone.name;
      this.boneMap.set(canonicalName, bone);
    }
  }

  /**
   * Capture the rest-pose (bind-pose) quaternion for every bone.
   * These are stored so we can restore the skeleton to its default state.
   */
  _captureRestPoses() {
    this.restPoses.clear();
    for (const [name, bone] of this.boneMap) {
      this.restPoses.set(name, bone.quaternion.clone());
    }
  }

  /**
   * Measure upper arm and forearm bone lengths for IK.
   * Uses the world-space distance between parent and child joints.
   */
  _measureArmLengths() {
    this.skeleton.bones.forEach(b => b.updateWorldMatrix(true, false));

    const measure = (parentName, childName) => {
      const parent = this.boneMap.get(parentName);
      const child = this.boneMap.get(childName);
      if (parent && child) {
        const pPos = new THREE.Vector3();
        const cPos = new THREE.Vector3();
        parent.getWorldPosition(pPos);
        child.getWorldPosition(cPos);
        return pPos.distanceTo(cPos);
      }
      return 0;
    };

    this.boneLengths.leftUpperArm = measure('LeftUpperArm', 'LeftForeArm');
    this.boneLengths.leftForeArm = measure('LeftForeArm', 'LeftHand');
    this.boneLengths.rightUpperArm = measure('RightUpperArm', 'RightForeArm');
    this.boneLengths.rightForeArm = measure('RightForeArm', 'RightHand');
  }

  /**
   * Get a bone by its canonical name.
   * @param {string} name
   * @returns {THREE.Bone}
   * @throws {Error} if bone is not found
   */
  getBone(name) {
    const bone = this.boneMap.get(name);
    if (!bone) {
      throw new Error(`[AvatarIngestor] Bone "${name}" not found in bone map.`);
    }
    return bone;
  }

  /**
   * Reset all bones to their captured rest poses.
   */
  resetToRestPose() {
    for (const [name, restQuat] of this.restPoses) {
      const bone = this.boneMap.get(name);
      if (bone) {
        bone.quaternion.copy(restQuat);
      }
    }
  }
}
```

### 2.4 Handling the Uncanny Valley

The architecture deliberately **separates** the concerns that contribute to the uncanny valley:

1. **Geometric fidelity** — Handled by the artist-authored avatar mesh. The system places no constraints on polygon count, texture resolution, or shading model. Stylized (cartoon/low-poly) avatars are explicitly supported and may be preferable for early deployment.

2. **Kinematic correctness** — Handled by the deterministic pipeline (IK solver, trajectory curves). This is the system's core competency and is mathematically exact.

3. **Facial animation / Non-Manual Markers** — **Deliberately deferred** (see Section 8). Poorly executed facial animation is the #1 contributor to the uncanny valley. By deferring it, the system avoids the single largest risk.

4. **Motion naturalness** — Achieved through biologically-inspired easing curves (Section 4) rather than motion capture data. Sine-based ease-in-out curves model the acceleration/deceleration profile of real human limb movement.

---

## 3. Handshape Preset Engine & Quaternion Preservation

### 3.1 The Phonological Handshape Layer

In ASL linguistics, **handshape** is one of the five core phonemic parameters (alongside location, movement, palm orientation, and non-manual markers). There are approximately 80+ distinct handshapes in ASL when including allophonic variants. For the initial production tier, the system targets approximately 30 high-frequency base shapes sufficient to cover the core conversational vocabulary.

### 3.2 Local-Space Isolation Principle

All handshape quaternion values are stored and applied in **bone-local space**. This is a critical architectural invariant:

- **Bone-local quaternions** represent the rotation of a bone *relative to its parent bone's coordinate frame*.
- They are **independent of the arm's global pose**. A fist looks the same whether the hand is above the head or at the waist.
- They are **composable**: applying a handshape is a simple `bone.quaternion.copy(presetQuaternion)` operation. No matrix decomposition or world-space conversion is required.
- They are **SLERP-interpolable**: transitioning between handshapes during a sign is a straightforward `bone.quaternion.slerp(targetQuat, blendFactor)`.

### 3.3 Quaternion Encoding Convention

All quaternions in the system use the **`[x, y, z, w]` component order**, matching Three.js's `THREE.Quaternion` internal representation.

- **Identity quaternion**: `[0, 0, 0, 1]` — no rotation from the parent frame.
- **90° flexion around local X-axis**: `[0.7071, 0, 0, 0.7071]` — typical of a fully curled proximal phalanx.
- **45° flexion around local X-axis**: `[0.3827, 0, 0, 0.9239]` — partial curl.
- **Abduction/adduction** (finger spread) is encoded as rotation around the local Z-axis.
- **Thumb opposition** involves compound rotations around multiple axes and is encoded directly as the resulting quaternion.

### 3.4 Preset JSON Specification

The `handshapePresets.json` file is the **canonical database** for all handshape definitions. Its structure:

```json
{
  "metadata": {
    "version": "1.0.0",
    "format": "quaternion_xyzw",
    "space": "bone_local",
    "convention": "right_hand_y_up",
    "description": "ASL handshape preset library. Bone names omit side prefix (Left/Right); prefix is applied at runtime."
  },
  "handshapes": {
    "FIST": {
      "description": "ASL 'S' — All fingers tightly curled into palm, thumb wrapped across index/middle.",
      "bones": {
        "Thumb_Proximal":       [0.260, 0.270, -0.400, 0.835],
        "Thumb_Intermediate":   [0.350, 0.000,  0.000, 0.937],
        "Thumb_Distal":         [0.300, 0.000,  0.000, 0.954],
        "Index_Proximal":       [0.707, 0.000,  0.000, 0.707],
        "Index_Intermediate":   [0.707, 0.000,  0.000, 0.707],
        "Index_Distal":         [0.500, 0.000,  0.000, 0.866],
        "Middle_Proximal":      [0.707, 0.000,  0.000, 0.707],
        "Middle_Intermediate":  [0.707, 0.000,  0.000, 0.707],
        "Middle_Distal":        [0.500, 0.000,  0.000, 0.866],
        "Ring_Proximal":        [0.707, 0.000,  0.000, 0.707],
        "Ring_Intermediate":    [0.707, 0.000,  0.000, 0.707],
        "Ring_Distal":          [0.500, 0.000,  0.000, 0.866],
        "Pinky_Proximal":       [0.707, 0.000,  0.000, 0.707],
        "Pinky_Intermediate":   [0.707, 0.000,  0.000, 0.707],
        "Pinky_Distal":         [0.500, 0.000,  0.000, 0.866]
      }
    },
    "OPEN_PALM": {
      "description": "ASL '5' / 'B' — All fingers extended and spread, thumb abducted.",
      "bones": {
        "Thumb_Proximal":       [0.000, 0.000, -0.383, 0.924],
        "Thumb_Intermediate":   [0.000, 0.000,  0.000, 1.000],
        "Thumb_Distal":         [0.000, 0.000,  0.000, 1.000],
        "Index_Proximal":       [0.000, 0.000,  0.044, 0.999],
        "Index_Intermediate":   [0.000, 0.000,  0.000, 1.000],
        "Index_Distal":         [0.000, 0.000,  0.000, 1.000],
        "Middle_Proximal":      [0.000, 0.000,  0.000, 1.000],
        "Middle_Intermediate":  [0.000, 0.000,  0.000, 1.000],
        "Middle_Distal":        [0.000, 0.000,  0.000, 1.000],
        "Ring_Proximal":        [0.000, 0.000, -0.044, 0.999],
        "Ring_Intermediate":    [0.000, 0.000,  0.000, 1.000],
        "Ring_Distal":          [0.000, 0.000,  0.000, 1.000],
        "Pinky_Proximal":       [0.000, 0.000, -0.087, 0.996],
        "Pinky_Intermediate":   [0.000, 0.000,  0.000, 1.000],
        "Pinky_Distal":         [0.000, 0.000,  0.000, 1.000]
      }
    }
  }
}
```

> **Note**: The bone names in the preset file are **side-agnostic** (no `Left`/`Right` prefix). The `SignAssemblyEngine` prepends the appropriate side prefix at runtime based on which hand is being configured.

### 3.5 Preset Application Routine

```javascript
/**
 * Apply a handshape preset to a hand's finger bones.
 * @param {Map<string, THREE.Bone>} boneMap — The avatar's canonical bone map.
 * @param {'Left'|'Right'} side — Which hand to apply to.
 * @param {Object} shapeData — The handshape entry from handshapePresets.json.
 * @param {number} [blendFactor=1.0] — SLERP factor (0 = current pose, 1 = full preset).
 */
function applyHandshape(boneMap, side, shapeData, blendFactor = 1.0) {
  const targetQuat = new THREE.Quaternion();

  for (const [boneSuffix, quatArray] of Object.entries(shapeData.bones)) {
    const fullBoneName = `${side}${boneSuffix}`;
    const bone = boneMap.get(fullBoneName);

    if (!bone) {
      console.warn(`[applyHandshape] Bone "${fullBoneName}" not found. Skipping.`);
      continue;
    }

    targetQuat.set(quatArray[0], quatArray[1], quatArray[2], quatArray[3]);

    if (blendFactor >= 1.0) {
      bone.quaternion.copy(targetQuat);
    } else {
      bone.quaternion.slerp(targetQuat, blendFactor);
    }
  }
}
```

### 3.6 Handshape Transition Model

During sign execution, handshape transitions are governed by:

1. **Instantaneous snap** — When the sign definition specifies a discrete shape change (e.g., from `OPEN_PALM` to `FIST` at a specific keyframe). Blend factor jumps from 0 to 1.

2. **SLERP blend** — When a `transitionDuration` is specified, the engine interpolates between the current shape and the target shape over the given time window. The blend factor follows the sign's easing function:

$$\text{blendFactor}(t) = E\left(\frac{t - t_{\text{start}}}{t_{\text{end}} - t_{\text{start}}}\right)$$

where $E$ is the easing function (typically `easeSineInOut` for biological motion).

---

## 4. 3D Trajectory Math and Easing Generators

### 4.1 Biological Easing Functions

Human limb movement does not follow constant-velocity trajectories. Real arms accelerate from rest, cruise at peak velocity, and decelerate to a stop. This profile is modeled by mathematical easing functions.

#### 4.1.1 Sine Ease-In-Out (Primary Biological Model)

$$E_{\text{sine}}(t) = -\frac{1}{2}\left(\cos(\pi t) - 1\right)$$

This produces an S-curve that closely matches the velocity profile of a reaching movement measured via motion capture.

```javascript
function easeSineInOut(t) {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}
```

#### 4.1.2 Cubic Ease-In-Out

$$E_{\text{cubic}}(t) = \begin{cases} 4t^3 & \text{if } t < 0.5 \\ 1 - \frac{(-2t + 2)^3}{2} & \text{otherwise} \end{cases}$$

```javascript
function easeCubicInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
```

#### 4.1.3 Quadratic Ease-In-Out

$$E_{\text{quad}}(t) = \begin{cases} 2t^2 & \text{if } t < 0.5 \\ 1 - \frac{(-2t + 2)^2}{2} & \text{otherwise} \end{cases}$$

```javascript
function easeQuadInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
```

#### 4.1.4 Back Ease-Out (Overshoot for Natural Settling)

$$E_{\text{back}}(t) = 1 + c_3(t - 1)^3 + c_1(t - 1)^2$$

where $c_1 = 1.70158$ and $c_3 = c_1 + 1$.

```javascript
function easeBackOut(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}
```

### 4.2 Linear Biological Easing Vector Trajectory

The most common trajectory type in ASL signing: a straight-line path from one spatial anchor to another, with biological easing applied to the parametric variable.

**Mathematical formulation:**

$$P(t) = \mathbf{p}_{\text{start}} + E(t) \cdot (\mathbf{p}_{\text{end}} - \mathbf{p}_{\text{start}})$$

where:
- $\mathbf{p}_{\text{start}}, \mathbf{p}_{\text{end}} \in \mathbb{R}^3$ are the start and end positions (world-space or body-relative).
- $E(t): [0, 1] \rightarrow [0, 1]$ is the easing function.
- $t \in [0, 1]$ is the normalized time parameter.

**Implementation:**

```javascript
class LinearTrajectory {
  /**
   * @param {THREE.Vector3} start — Start position.
   * @param {THREE.Vector3} end — End position.
   * @param {Function} easingFn — Easing function E(t): [0,1] → [0,1].
   */
  constructor(start, end, easingFn = easeSineInOut) {
    this.start = start.clone();
    this.end = end.clone();
    this.easingFn = easingFn;
    this._delta = new THREE.Vector3().subVectors(end, start);
  }

  /**
   * Evaluate position at normalized time t.
   * @param {number} t — Normalized time [0, 1].
   * @returns {THREE.Vector3}
   */
  evaluate(t) {
    const eased = this.easingFn(Math.max(0, Math.min(1, t)));
    return new THREE.Vector3().copy(this.start).addScaledVector(this._delta, eased);
  }
}
```

### 4.3 3D Circular/Arc Parametric Plane Tracking

For signs involving arcing, circular, or semi-circular hand movements (e.g., "YEAR", "EARTH"), the trajectory follows a parametric arc on an arbitrary plane in 3D space.

**Mathematical formulation:**

$$P(t) = \mathbf{C} + r \cos(\theta(t)) \cdot \mathbf{u} + r \sin(\theta(t)) \cdot \mathbf{v}$$

where:
- $\mathbf{C} \in \mathbb{R}^3$ is the center of the arc.
- $r > 0$ is the radius.
- $\mathbf{u}, \mathbf{v} \in \mathbb{R}^3$ are orthonormal basis vectors spanning the arc plane.
- $\theta(t) = \theta_{\text{start}} + E(t) \cdot (\theta_{\text{end}} - \theta_{\text{start}})$ is the eased angular parameter.

**Orthonormal basis construction from a plane normal:**

Given a plane normal $\mathbf{n}$, the basis vectors $\mathbf{u}$ and $\mathbf{v}$ are computed as:

1. Choose a reference vector $\mathbf{r}$ not parallel to $\mathbf{n}$ (use $\mathbf{r} = [1,0,0]$ if $|\mathbf{n} \cdot [1,0,0]| < 0.9$, otherwise $\mathbf{r} = [0,1,0]$).
2. $\mathbf{u} = \text{normalize}(\mathbf{r} \times \mathbf{n})$
3. $\mathbf{v} = \text{normalize}(\mathbf{n} \times \mathbf{u})$

**Implementation:**

```javascript
class ArcTrajectory {
  /**
   * @param {THREE.Vector3} center — Center of the arc.
   * @param {number} radius — Radius of the arc.
   * @param {number} startAngle — Start angle in radians.
   * @param {number} endAngle — End angle in radians.
   * @param {THREE.Vector3} planeNormal — Normal vector of the arc plane.
   * @param {Function} easingFn — Easing function.
   */
  constructor(center, radius, startAngle, endAngle, planeNormal, easingFn = easeSineInOut) {
    this.center = center.clone();
    this.radius = radius;
    this.startAngle = startAngle;
    this.endAngle = endAngle;
    this.easingFn = easingFn;

    // Build orthonormal basis for the arc plane
    const n = planeNormal.clone().normalize();
    const ref = Math.abs(n.dot(new THREE.Vector3(1, 0, 0))) < 0.9
      ? new THREE.Vector3(1, 0, 0)
      : new THREE.Vector3(0, 1, 0);

    this.u = new THREE.Vector3().crossVectors(ref, n).normalize();
    this.v = new THREE.Vector3().crossVectors(n, this.u).normalize();
  }

  /**
   * Evaluate position at normalized time t.
   * @param {number} t — Normalized time [0, 1].
   * @returns {THREE.Vector3}
   */
  evaluate(t) {
    const eased = this.easingFn(Math.max(0, Math.min(1, t)));
    const theta = this.startAngle + eased * (this.endAngle - this.startAngle);

    return new THREE.Vector3()
      .copy(this.center)
      .addScaledVector(this.u, this.radius * Math.cos(theta))
      .addScaledVector(this.v, this.radius * Math.sin(theta));
  }
}
```

### 4.4 Trigonometric Oscillatory / Tapping Formulations

For signs involving repeated contact or tapping motions (e.g., "TEA", "NAME"), the trajectory oscillates around a base position with optional exponential decay.

**Mathematical formulation:**

$$P(t) = \mathbf{p}_{\text{base}} + A \cdot \sin(2\pi f t) \cdot e^{-\lambda t} \cdot \hat{\mathbf{a}}$$

where:
- $\mathbf{p}_{\text{base}} \in \mathbb{R}^3$ is the resting position.
- $A > 0$ is the peak displacement amplitude (in world units).
- $f > 0$ is the oscillation frequency (cycles per normalized time unit).
- $\lambda \geq 0$ is the exponential decay rate ($\lambda = 0$ for sustained oscillation).
- $\hat{\mathbf{a}} \in \mathbb{R}^3$ is the unit direction vector of oscillation.

**Implementation:**

```javascript
class OscillatoryTrajectory {
  /**
   * @param {THREE.Vector3} basePosition — Rest position.
   * @param {number} amplitude — Peak displacement.
   * @param {THREE.Vector3} axis — Direction of oscillation (will be normalized).
   * @param {number} frequency — Cycles per unit time.
   * @param {number} [decayRate=0] — Exponential decay rate.
   */
  constructor(basePosition, amplitude, axis, frequency, decayRate = 0) {
    this.base = basePosition.clone();
    this.amplitude = amplitude;
    this.axis = axis.clone().normalize();
    this.frequency = frequency;
    this.decayRate = decayRate;
  }

  /**
   * Evaluate position at normalized time t.
   * @param {number} t — Normalized time [0, 1].
   * @returns {THREE.Vector3}
   */
  evaluate(t) {
    const displacement = this.amplitude
      * Math.sin(2 * Math.PI * this.frequency * t)
      * Math.exp(-this.decayRate * t);

    return new THREE.Vector3()
      .copy(this.base)
      .addScaledVector(this.axis, displacement);
  }
}
```

### 4.5 Body-Relative Anchor Transformations

Sign language locations are defined **relative to the signer's body**, not in absolute world-space coordinates. A sign performed at "chin height" must remain at chin height regardless of the avatar's global position, rotation, or scale.

**Anchor resolution algorithm:**

1. Read the **reference bone's world matrix** (e.g., `Spine1`, `Head`, `LeftShoulder`).
2. Construct a `THREE.Vector3` from the **local offset** defined in the sign schema.
3. Transform the local offset into world-space by applying the bone's world matrix.

$$\mathbf{p}_{\text{world}} = \mathbf{M}_{\text{bone}}^{\text{world}} \cdot \mathbf{p}_{\text{local\_offset}}$$

```javascript
class BodyRelativeAnchor {
  /**
   * @param {string} referenceBoneName — Canonical name of the reference bone.
   * @param {THREE.Vector3} localOffset — Offset in the bone's local coordinate frame.
   */
  constructor(referenceBoneName, localOffset) {
    this.referenceBoneName = referenceBoneName;
    this.localOffset = localOffset.clone();
  }

  /**
   * Resolve this anchor to a world-space position.
   * @param {Map<string, THREE.Bone>} boneMap — The avatar's bone map.
   * @returns {THREE.Vector3} — World-space position.
   */
  resolve(boneMap) {
    const bone = boneMap.get(this.referenceBoneName);
    if (!bone) {
      throw new Error(`[BodyRelativeAnchor] Reference bone "${this.referenceBoneName}" not found.`);
    }

    bone.updateWorldMatrix(true, false);
    const worldPos = this.localOffset.clone();
    worldPos.applyMatrix4(bone.matrixWorld);
    return worldPos;
  }
}
```

### 4.6 Trajectory Sequencing

Complex signs often involve multiple sequential movement phases (e.g., move to location A, then arc to location B). These are modeled as a **trajectory sequence** — a chain of trajectory segments with defined time ranges.

```javascript
class TrajectorySequence {
  /**
   * @param {Array<{trajectory: Object, startTime: number, endTime: number}>} segments
   */
  constructor(segments) {
    this.segments = segments.sort((a, b) => a.startTime - b.startTime);
  }

  /**
   * Evaluate the active trajectory segment at global time t.
   * @param {number} t — Global normalized time [0, 1].
   * @returns {THREE.Vector3}
   */
  evaluate(t) {
    const clamped = Math.max(0, Math.min(1, t));

    for (const segment of this.segments) {
      if (clamped >= segment.startTime && clamped <= segment.endTime) {
        const localT = (clamped - segment.startTime) / (segment.endTime - segment.startTime);
        return segment.trajectory.evaluate(localT);
      }
    }

    // If past all segments, return the last segment's end position
    const last = this.segments[this.segments.length - 1];
    return last.trajectory.evaluate(1.0);
  }
}
```

---

## 5. Analytical Upper-Limb Inverse Kinematics

### 5.1 Problem Definition

The IK problem for sign language animation is: given a **desired wrist position** in world-space (from the trajectory curve), compute the **shoulder and elbow joint rotations** that place the wrist at that position while maintaining a natural elbow orientation.

This is a **2-bone IK chain**: Shoulder → Elbow → Wrist, with:
- $L_1$ = upper arm length (shoulder-to-elbow distance)
- $L_2$ = forearm length (elbow-to-wrist distance)
- $D$ = distance from shoulder to target position

### 5.2 Why Analytical (Not Iterative)

The system uses a **closed-form analytical solver**, not an iterative solver (CCD, FABRIK):

1. **Determinism**: The closed-form solution produces identical results for identical inputs. Iterative solvers may converge to different poses depending on iteration count, convergence threshold, or initial state.
2. **Performance**: The analytical solution involves a fixed number of trigonometric operations (3 `acos`, 2 `atan2`, a handful of multiplies). No iteration loop.
3. **Guaranteed convergence**: The analytical solution always produces a result (with clamping for out-of-reach targets). Iterative solvers may fail to converge.

### 5.3 Target Clamping (Reachability Enforcement)

Before computing joint angles, the solver must ensure the target is within the reachable workspace — the spherical shell between the minimum and maximum reach distances:

$$D_{\min} = |L_1 - L_2|, \quad D_{\max} = L_1 + L_2$$

**Clamping rules:**

- If $D > D_{\max}$: The target is **beyond full extension**. Clamp to $D_{\max} - \epsilon$ (where $\epsilon = 0.001$) to avoid the degenerate fully-extended singularity.
- If $D < D_{\min}$: The target is **inside the minimum reach**. Clamp to $D_{\min} + \epsilon$.

$$D_{\text{clamped}} = \text{clamp}(D, \; |L_1 - L_2| + \epsilon, \; L_1 + L_2 - \epsilon)$$

After clamping $D$, the target position is moved along the shoulder→target direction to the clamped distance:

$$\mathbf{p}_{\text{clamped}} = \mathbf{p}_{\text{shoulder}} + D_{\text{clamped}} \cdot \hat{\mathbf{d}}$$

where $\hat{\mathbf{d}} = \text{normalize}(\mathbf{p}_{\text{target}} - \mathbf{p}_{\text{shoulder}})$.

### 5.4 Elbow Interior Angle ($\theta_E$) — Law of Cosines

The triangle formed by the shoulder, elbow, and wrist has sides $L_1$, $L_2$, and $D$. The interior angle at the elbow is:

$$\cos(\theta_E) = \frac{L_1^2 + L_2^2 - D^2}{2 \cdot L_1 \cdot L_2}$$

$$\theta_E = \arccos\left(\text{clamp}\left(\frac{L_1^2 + L_2^2 - D^2}{2 L_1 L_2}, -1, 1\right)\right)$$

The **elbow bend angle** (the angle by which the forearm bends away from the upper arm's axis) is:

$$\theta_{\text{bend}} = \pi - \theta_E$$

A fully extended arm has $\theta_E = \pi$ (interior angle = 180°), yielding $\theta_{\text{bend}} = 0$. A fully curled arm approaches $\theta_E \approx 0$, yielding $\theta_{\text{bend}} \approx \pi$.

### 5.5 Shoulder Offset Angle ($\theta_S$) — Law of Cosines

The interior angle at the shoulder (the angle between the shoulder→target direction and the upper arm) is:

$$\cos(\theta_S) = \frac{D^2 + L_1^2 - L_2^2}{2 \cdot D \cdot L_1}$$

$$\theta_S = \arccos\left(\text{clamp}\left(\frac{D^2 + L_1^2 - L_2^2}{2 D L_1}, -1, 1\right)\right)$$

The shoulder must rotate to point the upper arm not directly at the target, but $\theta_S$ radians **away** from the target direction, so that when the forearm bends at $\theta_{\text{bend}}$, the wrist lands on the target.

### 5.6 Pole Vector Constraint Tracking

The 2-bone IK problem has one remaining degree of freedom after computing $\theta_E$ and $\theta_S$: the **twist** of the shoulder-to-target axis, which controls the plane in which the elbow bends. This is resolved by the **pole vector** — a world-space point that the elbow should "aim toward".

**Pole vector algorithm:**

1. Compute the **shoulder-to-target axis**: $\hat{\mathbf{d}} = \text{normalize}(\mathbf{p}_{\text{target}} - \mathbf{p}_{\text{shoulder}})$
2. Compute the **initial elbow position** (before twist) by rotating the upper arm direction by $\theta_S$ around an arbitrary perpendicular axis.
3. **Project** the pole target onto the plane perpendicular to $\hat{\mathbf{d}}$, passing through the shoulder.
4. Compute the **angle** between the projected initial elbow direction and the projected pole target direction.
5. Apply this angle as a **twist rotation** around $\hat{\mathbf{d}}$.

### 5.7 Global-to-Local Transformation

The IK solver computes rotations in **world space**, but Three.js bones require rotations in **parent-local space**. The conversion is:

$$\mathbf{q}_{\text{local}} = (\mathbf{q}_{\text{parent}}^{\text{world}})^{-1} \cdot \mathbf{q}_{\text{computed}}^{\text{world}}$$

This is a quaternion multiplication where $(\mathbf{q}_{\text{parent}}^{\text{world}})^{-1}$ is the conjugate of the parent bone's accumulated world quaternion.

### 5.8 Palm Orientation Override

For signs where palm orientation carries phonemic meaning (e.g., "GIVE" vs. "RECEIVE"), the hand bone's world rotation is explicitly set:

$$\mathbf{q}_{\text{hand}}^{\text{local}} = (\mathbf{q}_{\text{forearm}}^{\text{world}})^{-1} \cdot \mathbf{q}_{\text{palm}}^{\text{desired\_world}}$$

### 5.9 Complete Analytical IK Solver Implementation

```javascript
import * as THREE from 'three';

/**
 * AnalyticalIKSolver — Closed-form 2-bone IK for upper-limb chains.
 *
 * Solves Shoulder → Elbow → Wrist using the Law of Cosines.
 * Handles target clamping, pole vector alignment, and palm orientation.
 */
export class AnalyticalIKSolver {
  /**
   * @param {THREE.Bone} upperArm — The shoulder/upper-arm bone.
   * @param {THREE.Bone} lowerArm — The elbow/forearm bone.
   * @param {THREE.Bone} hand     — The hand/wrist bone.
   */
  constructor(upperArm, lowerArm, hand) {
    this.upperArm = upperArm;
    this.lowerArm = lowerArm;
    this.hand = hand;

    /** @type {number} Upper arm length (shoulder to elbow) */
    this.L1 = 0;
    /** @type {number} Forearm length (elbow to wrist) */
    this.L2 = 0;
    /** @type {boolean} Whether bone lengths have been measured */
    this._initialized = false;

    // Reusable temporaries to avoid GC pressure
    this._shoulderPos = new THREE.Vector3();
    this._elbowPos = new THREE.Vector3();
    this._wristPos = new THREE.Vector3();
    this._targetDir = new THREE.Vector3();
    this._tempQuat = new THREE.Quaternion();
    this._tempQuat2 = new THREE.Quaternion();
    this._tempVec = new THREE.Vector3();
    this._tempMat = new THREE.Matrix4();
  }

  /**
   * Clamp a value between min and max.
   * @param {number} val
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  static clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  /**
   * Get the world-space position of a bone.
   * @param {THREE.Bone} bone
   * @returns {THREE.Vector3}
   */
  _getWorldPosition(bone) {
    const pos = new THREE.Vector3();
    bone.getWorldPosition(pos);
    return pos;
  }

  /**
   * Get the world-space quaternion of a bone.
   * @param {THREE.Bone} bone
   * @returns {THREE.Quaternion}
   */
  _getWorldQuaternion(bone) {
    const quat = new THREE.Quaternion();
    bone.getWorldQuaternion(quat);
    return quat;
  }

  /**
   * Initialize bone lengths on first call.
   */
  _initialize() {
    if (this._initialized) return;

    this.upperArm.updateWorldMatrix(true, true);
    this.lowerArm.updateWorldMatrix(true, true);
    this.hand.updateWorldMatrix(true, true);

    const shoulderPos = this._getWorldPosition(this.upperArm);
    const elbowPos = this._getWorldPosition(this.lowerArm);
    const wristPos = this._getWorldPosition(this.hand);

    this.L1 = shoulderPos.distanceTo(elbowPos);
    this.L2 = elbowPos.distanceTo(wristPos);

    if (this.L1 <= 0 || this.L2 <= 0) {
      throw new Error(
        `[AnalyticalIKSolver] Invalid bone lengths: L1=${this.L1}, L2=${this.L2}. ` +
        `Ensure bones are not co-located.`
      );
    }

    this._initialized = true;
    console.log(`[AnalyticalIKSolver] Initialized: L1=${this.L1.toFixed(4)}, L2=${this.L2.toFixed(4)}`);
  }

  /**
   * Solve the IK chain for a given target position, pole target, and optional palm orientation.
   *
   * @param {THREE.Vector3} targetPosition  — World-space wrist target.
   * @param {THREE.Vector3} poleTarget      — World-space pole vector target (elbow direction hint).
   * @param {THREE.Quaternion} [palmOrientation=null] — Desired world-space palm rotation.
   */
  solve(targetPosition, poleTarget, palmOrientation = null) {
    this._initialize();

    // Update world matrices
    this.upperArm.updateWorldMatrix(true, true);

    // --- Step 1: Get shoulder world position ---
    const shoulderPos = this._getWorldPosition(this.upperArm);

    // --- Step 2: Compute and clamp reach distance ---
    let D = shoulderPos.distanceTo(targetPosition);
    const EPSILON = 0.001;
    const Dmax = this.L1 + this.L2 - EPSILON;
    const Dmin = Math.abs(this.L1 - this.L2) + EPSILON;
    D = AnalyticalIKSolver.clamp(D, Dmin, Dmax);

    // Compute clamped target position
    this._targetDir.subVectors(targetPosition, shoulderPos).normalize();
    const clampedTarget = new THREE.Vector3()
      .copy(shoulderPos)
      .addScaledVector(this._targetDir, D);

    // --- Step 3: Law of Cosines — Elbow angle ---
    const cosElbow = (this.L1 * this.L1 + this.L2 * this.L2 - D * D) / (2 * this.L1 * this.L2);
    const elbowInteriorAngle = Math.acos(AnalyticalIKSolver.clamp(cosElbow, -1, 1));
    const elbowBendAngle = Math.PI - elbowInteriorAngle;

    // --- Step 4: Law of Cosines — Shoulder offset angle ---
    const cosShoulder = (D * D + this.L1 * this.L1 - this.L2 * this.L2) / (2 * D * this.L1);
    const shoulderOffsetAngle = Math.acos(AnalyticalIKSolver.clamp(cosShoulder, -1, 1));

    // --- Step 5: Build shoulder world rotation ---
    // Direction from shoulder to target
    const dirToTarget = this._targetDir.clone();

    // Get the shoulder's parent world quaternion for local conversion
    const parentWorldQuat = this.upperArm.parent
      ? this._getWorldQuaternion(this.upperArm.parent)
      : new THREE.Quaternion();

    // Base rotation: align upper arm direction toward target
    // We need a rotation that points the upper arm's local forward axis toward dirToTarget
    const upperArmRestDir = new THREE.Vector3(0, -1, 0); // Typical: bone points down Y in rest pose
    // Adjust based on your rig — this assumes Y-down bone axis

    const shoulderBaseQuat = new THREE.Quaternion().setFromUnitVectors(
      upperArmRestDir,
      dirToTarget
    );

    // Apply shoulder offset: rotate the upper arm away from target by shoulderOffsetAngle
    // The rotation axis is perpendicular to the direction-to-target, in the IK plane
    const perpAxis = new THREE.Vector3();
    const refUp = new THREE.Vector3(0, 1, 0);
    perpAxis.crossVectors(dirToTarget, refUp);
    if (perpAxis.lengthSq() < 0.0001) {
      perpAxis.set(1, 0, 0); // Fallback if target is straight up/down
    }
    perpAxis.normalize();

    const shoulderOffsetQuat = new THREE.Quaternion().setFromAxisAngle(perpAxis, shoulderOffsetAngle);
    const shoulderWorldQuat = shoulderBaseQuat.clone().premultiply(shoulderOffsetQuat);

    // --- Step 6: Pole Vector twist ---
    if (poleTarget) {
      // Project pole target onto plane perpendicular to dirToTarget
      const shoulderToElbow = new THREE.Vector3(0, -this.L1, 0)
        .applyQuaternion(shoulderWorldQuat);
      const currentElbowPos = new THREE.Vector3().addVectors(shoulderPos, shoulderToElbow);

      // Project current elbow and pole target onto the perpendicular plane
      const elbowProj = new THREE.Vector3().subVectors(currentElbowPos, shoulderPos);
      const poleProj = new THREE.Vector3().subVectors(poleTarget, shoulderPos);

      // Remove component along dirToTarget
      elbowProj.addScaledVector(dirToTarget, -elbowProj.dot(dirToTarget));
      poleProj.addScaledVector(dirToTarget, -poleProj.dot(dirToTarget));

      if (elbowProj.lengthSq() > 0.0001 && poleProj.lengthSq() > 0.0001) {
        elbowProj.normalize();
        poleProj.normalize();

        let twistAngle = Math.acos(AnalyticalIKSolver.clamp(elbowProj.dot(poleProj), -1, 1));
        const cross = new THREE.Vector3().crossVectors(elbowProj, poleProj);
        if (cross.dot(dirToTarget) < 0) twistAngle = -twistAngle;

        const twistQuat = new THREE.Quaternion().setFromAxisAngle(dirToTarget, twistAngle);
        shoulderWorldQuat.premultiply(twistQuat);
      }
    }

    // --- Step 7: Convert shoulder to local space ---
    const shoulderLocalQuat = parentWorldQuat.clone().invert().multiply(shoulderWorldQuat);
    this.upperArm.quaternion.copy(shoulderLocalQuat);

    // --- Step 8: Apply elbow bend ---
    const elbowBendAxis = new THREE.Vector3(1, 0, 0); // Bend around local X (adjust per rig)
    const elbowLocalQuat = new THREE.Quaternion().setFromAxisAngle(elbowBendAxis, elbowBendAngle);
    this.lowerArm.quaternion.copy(elbowLocalQuat);

    // --- Step 9: Palm orientation (optional) ---
    if (palmOrientation) {
      this.upperArm.updateWorldMatrix(true, true);
      this.lowerArm.updateWorldMatrix(true, true);

      const forearmWorldQuat = this._getWorldQuaternion(this.lowerArm);
      const handLocalQuat = forearmWorldQuat.clone().invert().multiply(palmOrientation);
      this.hand.quaternion.copy(handLocalQuat);
    }

    // Force matrix updates
    this.upperArm.updateWorldMatrix(false, true);
  }
}
```

---

## 6. The Sign Assembly Script

### 6.1 Orchestration Overview

The `SignAssemblyEngine` is the **central orchestration layer** that ties together all subsystems (trajectory curves, IK solver, handshape presets) into a frame-by-frame animation compiler. It operates as a deterministic state machine:

```
Input:  SignDefinition + AvatarRig + CalibrationData
Output: THREE.AnimationClip | Real-time bone state updates
```

### 6.2 Execution Pipeline (Per-Frame)

For each sampled time $t \in [0, 1]$:

1. **Anchor Resolution**: Resolve all body-relative anchors to world-space positions using the current skeleton state.
2. **Trajectory Evaluation**: Evaluate each hand's trajectory curve at time $t$ to obtain wrist target positions.
3. **IK Solve**: Run the `AnalyticalIKSolver` for each active arm chain (dominant, non-dominant) with the computed wrist target, pole vector, and palm orientation.
4. **Handshape Application**: Determine the active handshape at time $t$ from the handshape timeline. If a transition is in progress, compute the SLERP blend factor and apply the interpolated handshape.
5. **Matrix Propagation**: Call `skeleton.update()` to propagate all bone transformations through the hierarchy.

### 6.3 Sign Definition Schema

The sign definition is a declarative JSON structure that fully specifies the visual realization of a sign:

```json
{
  "id": "SIGN_NAME",
  "metadata": {
    "gloss": "SIGN_NAME",
    "category": "noun|verb|adjective|...",
    "handedness": "one-handed|two-handed-symmetric|two-handed-asymmetric",
    "source": "ASL dictionary reference"
  },
  "timing": {
    "totalDuration": 1.0,
    "easing": "easeSineInOut",
    "fps": 30
  },
  "dominant": {
    "anchor": {
      "bone": "Spine1",
      "offset": [0.0, 0.2, 0.15]
    },
    "trajectory": {
      "type": "linear",
      "startOffset": [0.15, 0.3, 0.25],
      "endOffset": [0.15, 0.1, 0.20],
      "easing": "easeSineInOut"
    },
    "handshapes": [
      { "time": 0.0, "shape": "C_SHAPE" },
      { "time": 1.0, "shape": "C_SHAPE" }
    ],
    "palmOrientation": {
      "type": "fixed",
      "quaternion": [0.0, 0.707, 0.0, 0.707]
    },
    "poleVector": {
      "bone": "Spine1",
      "offset": [0.3, -0.5, 0.0]
    }
  },
  "nonDominant": null
}
```

### 6.4 Frame Sampling and AnimationClip Compilation

The engine compiles sign definitions into `THREE.AnimationClip` objects by sampling the execution pipeline at regular intervals:

```javascript
/**
 * Compile a sign definition into a THREE.AnimationClip.
 * @param {Object} signDef — The sign definition schema.
 * @param {number} fps — Frames per second for sampling.
 * @returns {THREE.AnimationClip}
 */
compileToAnimationClip(signDef, fps = 30) {
  const duration = signDef.timing.totalDuration;
  const frameCount = Math.ceil(duration * fps) + 1;
  const dt = 1.0 / (frameCount - 1);

  // Keyframe tracks per bone
  const tracks = new Map(); // boneName → { times: [], quaternions: [] }

  // Collect all bones involved
  const involvedBones = this._getInvolvedBones(signDef);
  for (const boneName of involvedBones) {
    tracks.set(boneName, { times: [], values: [] });
  }

  // Sample each frame
  for (let i = 0; i < frameCount; i++) {
    const t = i * dt;
    const timeSec = t * duration;

    // Execute the frame (sets bone quaternions)
    this.executeFrame(t);

    // Record bone quaternions
    for (const [boneName, track] of tracks) {
      const bone = this._findBone(boneName);
      if (bone) {
        track.times.push(timeSec);
        track.values.push(
          bone.quaternion.x,
          bone.quaternion.y,
          bone.quaternion.z,
          bone.quaternion.w
        );
      }
    }

    // Reset to rest pose for next frame
    this._resetToRest();
  }

  // Build THREE.QuaternionKeyframeTrack objects
  const clipTracks = [];
  for (const [boneName, track] of tracks) {
    const bone = this._findBone(boneName);
    if (bone && track.times.length > 0) {
      clipTracks.push(
        new THREE.QuaternionKeyframeTrack(
          `${bone.name}.quaternion`,
          track.times,
          track.values
        )
      );
    }
  }

  return new THREE.AnimationClip(signDef.id, duration, clipTracks);
}
```

### 6.5 Real-Time Playback Mode

For interactive applications, the engine can also drive bones in real-time without pre-compiling an animation clip:

```javascript
// In the render loop:
const clock = new THREE.Clock();
const signDuration = 1.0; // seconds

function animate() {
  requestAnimationFrame(animate);

  const elapsed = clock.getElapsedTime();
  const t = Math.min(elapsed / signDuration, 1.0); // Normalized time

  engine.executeFrame(t);
  renderer.render(scene, camera);
}
```

---

## 7. Quality Assurance, Verification Loops, and Human-in-the-Loop Calibration Gates

### 7.1 The Verification Imperative

ASL is a natural language with minimal phonemic tolerance. An incorrectly oriented palm, a missing finger curl, or a trajectory that misses its target anchor can change the meaning of a sign or render it incomprehensible. The system therefore enforces **mandatory human verification gates** at two critical pipeline stages:

1. **Phase 3: Preset Verification** — Every handshape preset must be visually verified on the target avatar rig before it can be used in sign definitions.
2. **Phase 6: Integration Verification** — Every assembled sign must be visually verified as a complete animation before it enters the sign library.

### 7.2 Verification Is Not Optional

These are **blocking gates**. A sign cannot advance from Phase 5 (definition authoring) to Phase 7 (library accumulation) without a Phase 6 pass. This is enforced by the testing log structure.

### 7.3 Phase 3 — Preset Verification Protocol

For each handshape preset:

1. Load the avatar in T-pose / A-pose.
2. Apply the preset to the dominant hand.
3. Rotate the camera to capture 3 reference views: front, three-quarter, and side.
4. A human verifier compares the rendered handshape against the ASL reference photograph.
5. The verifier records a **PASS** or **FAIL** with optional calibration notes.

### 7.4 Phase 6 — Integration Verification Protocol

For each assembled sign:

1. Load the avatar and play the compiled `AnimationClip`.
2. Record/review the animation from the front view (the signer's perspective).
3. A human verifier evaluates:
   - **Handshape correctness** — Is the hand forming the right shape at each keyframe?
   - **Location accuracy** — Does the hand reach the correct body-relative location?
   - **Movement fidelity** — Does the trajectory match the expected path (straight, arc, oscillatory)?
   - **Palm orientation** — Is the palm facing the correct direction?
   - **Timing/rhythm** — Does the sign's temporal profile feel natural?
4. The verifier records a **PASS** or **FAIL** with notes.

### 7.5 Testing Log Structure

The verification log is a structured JSON file that tracks the state of every preset and sign through the QA pipeline:

```json
{
  "metadata": {
    "version": "1.0.0",
    "avatarId": "avatar_v3_stylized",
    "lastUpdated": "2025-01-15T14:30:00Z"
  },
  "presetVerifications": [
    {
      "presetId": "FIST",
      "status": "PASS",
      "verifier": "calibrator_jane",
      "timestamp": "2025-01-10T10:00:00Z",
      "avatarId": "avatar_v3_stylized",
      "notes": "All fingers properly curled. Thumb position across index confirmed.",
      "referenceScreenshots": [
        "screenshots/FIST_front.png",
        "screenshots/FIST_3quarter.png",
        "screenshots/FIST_side.png"
      ],
      "calibrationAdjustments": []
    },
    {
      "presetId": "C_SHAPE",
      "status": "FAIL",
      "verifier": "calibrator_jane",
      "timestamp": "2025-01-10T10:15:00Z",
      "avatarId": "avatar_v3_stylized",
      "notes": "Thumb abduction insufficient. Middle finger not curving enough.",
      "referenceScreenshots": [
        "screenshots/C_SHAPE_front.png"
      ],
      "calibrationAdjustments": [
        {
          "bone": "Thumb_Proximal",
          "field": "z_rotation",
          "oldValue": -0.300,
          "newValue": -0.400,
          "reason": "Increase thumb opposition angle for C curvature"
        },
        {
          "bone": "Middle_Proximal",
          "field": "x_rotation",
          "oldValue": 0.350,
          "newValue": 0.450,
          "reason": "Increase proximal flexion for tighter C curve"
        }
      ]
    }
  ],
  "signVerifications": [
    {
      "signId": "CUP",
      "status": "PASS",
      "verifier": "calibrator_ahmed",
      "timestamp": "2025-01-12T09:00:00Z",
      "avatarId": "avatar_v3_stylized",
      "notes": "C-shape hand tilts toward mouth correctly. Movement arc is natural.",
      "checklist": {
        "handshape": "PASS",
        "location": "PASS",
        "movement": "PASS",
        "palmOrientation": "PASS",
        "timing": "PASS"
      },
      "issues": []
    },
    {
      "signId": "TEA",
      "status": "FAIL",
      "verifier": "calibrator_ahmed",
      "timestamp": "2025-01-12T09:30:00Z",
      "avatarId": "avatar_v3_stylized",
      "notes": "Non-dominant hand C-shape is correct but dominant hand PINCH insertion is too shallow.",
      "checklist": {
        "handshape": "PASS",
        "location": "FAIL",
        "movement": "PASS",
        "palmOrientation": "PASS",
        "timing": "PASS"
      },
      "issues": [
        {
          "component": "dominant.trajectory",
          "description": "Dominant hand pinch does not descend far enough into non-dominant C-shape opening.",
          "suggestedFix": "Adjust dominant.trajectory.oscillationBase Y offset from 0.25 to 0.22"
        }
      ]
    }
  ]
}
```

### 7.6 Calibration Workflow State Machine

Each preset and sign progresses through a strict state machine:

```
AUTHORED → UNDER_REVIEW → [PASS → VERIFIED] | [FAIL → CALIBRATING → AUTHORED]
```

- **AUTHORED**: Initial creation complete. Ready for review.
- **UNDER_REVIEW**: Human verifier is evaluating.
- **PASS / VERIFIED**: Approved. Can be used in sign definitions (presets) or added to the sign library (signs).
- **FAIL**: Rejected. Requires calibration adjustments.
- **CALIBRATING**: Adjustments being made to quaternion values (presets) or trajectory/anchor parameters (signs). Returns to AUTHORED for re-review.

---

## 8. NMM Blending Deferral Strategy

### 8.1 What Are Non-Manual Markers?

Non-Manual Markers (NMMs) are the **facial expressions, head tilts, eye gaze directions, mouth morphemes, and shoulder shifts** that carry grammatical information in ASL. They include:

- **Eyebrow raise/furrow** — Marks yes/no questions and topic markers.
- **Head tilt/nod/shake** — Negation, affirmation, conditional clauses.
- **Mouth morphemes** — Adverbial modifiers (e.g., "MM" = regularly, "CHA" = large).
- **Eye gaze** — Pronominal reference, verb agreement.
- **Shoulder shift** — Role shift (quoting/acting as another person).

NMMs are **not optional** in full ASL grammar. A syntactically complete ASL sentence often requires NMMs to convey its full meaning.

### 8.2 Why Defer NMMs?

The architectural decision to defer NMM implementation is driven by three engineering constraints:

1. **Uncanny Valley Risk**: Facial animation is the single highest-risk factor for the uncanny valley. Poorly executed facial blendshapes (morph targets) will immediately undermine user trust, regardless of how accurate the manual signing is. The risk/reward ratio is unfavorable for early tiers.

2. **Morph Target Dependency**: NMMs require **blendshape/morph target** support on the avatar mesh. This adds requirements to the avatar production pipeline (artist must author blendshapes for ~20+ facial expressions) and the runtime system (blendshape interpolation, weight management). This is a significant scope expansion.

3. **Linguistic Complexity**: NMM timing is **suprasegmental** — it spans across multiple signs and operates on a different temporal layer than manual signing. Integrating NMMs requires a higher-level sentence/phrase-level orchestration system that is architecturally distinct from the sign-level assembly engine.

### 8.3 Deferral Boundary

The explicit scope boundary:

| In Scope (Current Tiers) | Out of Scope (Deferred) |
|--------------------------|------------------------|
| Handshape (finger bone rotations) | Eyebrow blendshapes |
| Location (body-relative anchors) | Mouth morpheme blendshapes |
| Movement (trajectory curves) | Eye gaze bone/blendshape |
| Palm orientation (wrist rotation) | Head tilt overlays |
| Manual signing timing | Shoulder shift overlays |
| Upper body posture | Role shifting |

### 8.4 Future Integration Path

When NMMs are introduced in a future tier, they will be implemented as a **parallel blending layer** that operates independently of the manual signing pipeline:

1. **NMM definitions** will be attached to sentence/phrase-level schemas, not individual sign schemas.
2. **Blendshape weights** will be driven by their own timeline, evaluated in parallel with the sign assembly engine.
3. **Head/eye bone rotations** will be additively blended on top of the rest pose, not interfering with arm/hand IK.

---

## 9. Applied Case Study Schemas

### 9.1 Sign: "CUP"

**Linguistic description**: One-handed sign. Dominant hand forms a C-shape and tips toward the mouth in a short arc, miming the action of drinking from a cup. Non-dominant hand forms a flat base (B-flat) below the dominant hand for some variants; in the common single-hand variant, the non-dominant hand is idle.

**Phonemic parameters**:
- **Handshape**: C_SHAPE (maintained throughout)
- **Location**: Starts at chin height, slightly forward; arcs toward the mouth
- **Movement**: Short tipping arc (approximately 30° rotation of the trajectory)
- **Palm orientation**: Palm facing left (for right-hand dominant), tilting upward during the arc
- **Handedness**: One-handed (dominant only)

**Complete sign definition schema:**

```json
{
  "id": "CUP",
  "metadata": {
    "gloss": "CUP",
    "category": "noun",
    "handedness": "one-handed",
    "source": "ASL-LEX / Gallaudet Dictionary",
    "difficulty": "beginner"
  },
  "timing": {
    "totalDuration": 0.8,
    "easing": "easeSineInOut",
    "fps": 30
  },
  "dominant": {
    "anchor": {
      "bone": "Head",
      "offset": [0.0, -0.15, 0.18]
    },
    "trajectory": {
      "type": "arc",
      "config": {
        "center": {
          "bone": "Head",
          "offset": [0.0, -0.12, 0.10]
        },
        "radius": 0.10,
        "startAngle": 0.0,
        "endAngle": -0.52,
        "planeNormal": [1.0, 0.0, 0.0],
        "easing": "easeSineInOut"
      }
    },
    "handshapes": [
      {
        "time": 0.0,
        "shape": "C_SHAPE",
        "transition": "snap"
      },
      {
        "time": 1.0,
        "shape": "C_SHAPE",
        "transition": "hold"
      }
    ],
    "palmOrientation": {
      "type": "interpolated",
      "keyframes": [
        {
          "time": 0.0,
          "quaternion": [0.0, 0.707, 0.0, 0.707]
        },
        {
          "time": 1.0,
          "quaternion": [0.259, 0.659, -0.109, 0.696]
        }
      ]
    },
    "poleVector": {
      "bone": "Spine1",
      "offset": [0.25, -0.3, 0.0]
    }
  },
  "nonDominant": null
}
```

### 9.2 Sign: "TEA"

**Linguistic description**: Two-handed asymmetric sign. The non-dominant hand forms a C-shape (or O-shape) representing the cup. The dominant hand forms a pinch (F-shape) representing the tea bag, and dips/stirs into the non-dominant hand's opening with an oscillatory (stirring/dipping) motion.

**Phonemic parameters**:
- **Dominant handshape**: PINCH (maintained throughout; represents the tea bag string)
- **Non-dominant handshape**: C_SHAPE or O_SHAPE (maintained throughout; represents the cup)
- **Location**: Both hands at mid-torso height, slightly forward
- **Movement**: Dominant hand performs oscillatory dipping/stirring into the non-dominant hand's opening
- **Palm orientation**: Dominant palm down; non-dominant palm facing right (opening toward dominant hand)
- **Handedness**: Two-handed asymmetric

**Complete sign definition schema:**

```json
{
  "id": "TEA",
  "metadata": {
    "gloss": "TEA",
    "category": "noun",
    "handedness": "two-handed-asymmetric",
    "source": "ASL-LEX / Gallaudet Dictionary",
    "difficulty": "beginner"
  },
  "timing": {
    "totalDuration": 1.2,
    "easing": "easeSineInOut",
    "fps": 30
  },
  "dominant": {
    "anchor": {
      "bone": "Spine1",
      "offset": [0.0, 0.15, 0.22]
    },
    "trajectory": {
      "type": "oscillatory",
      "config": {
        "basePosition": {
          "bone": "Spine1",
          "offset": [0.08, 0.15, 0.22]
        },
        "amplitude": 0.04,
        "axis": [0.0, -1.0, 0.0],
        "frequency": 3.0,
        "decayRate": 0.5
      }
    },
    "handshapes": [
      {
        "time": 0.0,
        "shape": "PINCH",
        "transition": "snap"
      },
      {
        "time": 1.0,
        "shape": "PINCH",
        "transition": "hold"
      }
    ],
    "palmOrientation": {
      "type": "fixed",
      "quaternion": [0.707, 0.0, 0.0, 0.707]
    },
    "poleVector": {
      "bone": "Spine1",
      "offset": [0.3, -0.4, 0.0]
    }
  },
  "nonDominant": {
    "anchor": {
      "bone": "Spine1",
      "offset": [0.0, 0.12, 0.20]
    },
    "trajectory": {
      "type": "linear",
      "config": {
        "startOffset": [-0.08, 0.12, 0.20],
        "endOffset": [-0.08, 0.12, 0.20],
        "easing": "easeLinear"
      }
    },
    "handshapes": [
      {
        "time": 0.0,
        "shape": "C_SHAPE",
        "transition": "snap"
      },
      {
        "time": 1.0,
        "shape": "C_SHAPE",
        "transition": "hold"
      }
    ],
    "palmOrientation": {
      "type": "fixed",
      "quaternion": [0.0, 0.707, 0.0, 0.707]
    },
    "poleVector": {
      "bone": "Spine1",
      "offset": [-0.3, -0.4, 0.0]
    }
  }
}
```

### 9.3 Schema Analysis: CUP vs. TEA

| Property | CUP | TEA |
|----------|-----|-----|
| Handedness | One-handed | Two-handed asymmetric |
| Dominant shape | `C_SHAPE` (static) | `PINCH` (static) |
| Non-dominant | `null` (idle) | `C_SHAPE` (static hold) |
| Trajectory type | Arc (tipping) | Oscillatory (dipping/stirring) |
| Duration | 0.8s | 1.2s (longer due to oscillation) |
| Location anchor | `Head` (chin area) | `Spine1` (mid-torso) |
| Palm orientation | Interpolated (tilts) | Fixed per hand |
| Repetition | None | 3 cycles (via frequency=3.0) |

These two signs demonstrate the schema's ability to express both simple single-hand motions and complex two-handed asymmetric signs with distinct trajectory types per hand.

---

## 10. System Lifecycle Sequencing

### 10.1 Absolute Application Roadmap

The system is deployed in strict sequential tiers. Each tier must be **complete and verified** before the next begins.

#### Tier 0: Foundation (Weeks 1–2)

**Objective**: Establish the avatar pipeline and core runtime.

| Task | Deliverable | Gate |
|------|------------|------|
| Source/commission avatar `.glb` file | `avatar_v1.glb` | File loads in Three.js without errors |
| Implement `AvatarIngestor` | `AvatarIngestor.js` | All bones extracted, arm lengths measured |
| Implement `AnalyticalIKSolver` | `AnalyticalIKSolver.js` | Unit test: wrist reaches target ±0.01 units |
| Implement `KinematicCurves` | `KinematicCurves.js` | Visual test: curves render correctly in debug view |
| Build Three.js scene scaffold | `main.js` / `index.html` | Avatar visible, orbit controls functional |

#### Tier 1: Handshape Authoring (Weeks 3–4)

**Objective**: Author and verify the initial handshape preset library.

| Task | Deliverable | Gate |
|------|------------|------|
| Author 15 core handshape presets | `handshapePresets.json` | JSON valid, loads without error |
| Build preset preview UI | Preset viewer tool | Can apply any preset and visually inspect |
| Phase 3 verification sweep | Verification log entries | All 15 presets PASS on target avatar |
| Calibration iteration loop | Updated quaternion values | Failed presets re-authored and re-verified |

#### Tier 2: First Signs (Weeks 5–7)

**Objective**: Author, assemble, and verify the first 10 signs.

| Task | Deliverable | Gate |
|------|------------|------|
| Implement `SignAssemblyEngine` | `SignAssemblyEngine.js` | Can load and execute a sign definition |
| Author sign definitions: CUP, TEA, WATER, HELLO, THANK-YOU, YES, NO, NAME, PLEASE, SORRY | 10 `.json` sign files | All parse without error |
| Phase 6 verification sweep | Verification log entries | All 10 signs PASS |
| Build sign playback UI | Sign player tool | Select and play any verified sign |

#### Tier 3: Vocabulary Expansion (Weeks 8–12)

**Objective**: Scale to 100+ verified signs.

| Task | Deliverable | Gate |
|------|------------|------|
| Author additional handshape presets as needed | Updated `handshapePresets.json` | All presets Phase 3 verified |
| Author 90+ sign definitions | Sign definition library | All Phase 6 verified |
| Build sign dictionary search | Dictionary UI | Searchable by gloss, category |
| Performance optimization | Profiling report | 60 FPS on mid-tier hardware |

#### Tier 4: NMM Integration (Future)

**Objective**: Add facial expression and head movement support.

| Task | Deliverable | Gate |
|------|------------|------|
| Commission avatar blendshapes | Updated `.glb` with morph targets | Blendshapes functional in Three.js |
| Implement NMM blending layer | `NMMBlender.js` | Facial expressions render correctly |
| Author sentence-level NMM schemas | NMM definition library | Phase verification passed |
| Integrate with sign assembly pipeline | Updated `SignAssemblyEngine` | NMMs play alongside manual signs |

### 10.2 Product Manager Guidelines

1. **Never skip a tier.** The verification gates exist because ASL is a real language used by real people. Shipping incorrect signs is worse than shipping no signs.

2. **Never skip Phase 6 verification.** Every sign must be reviewed by a human who understands ASL before it enters the production library. Automated testing can catch crashes and out-of-range values, but only a human can verify linguistic correctness.

3. **Prioritize sign vocabulary by frequency.** The first 100 signs should be the most commonly used in everyday ASL conversation (greetings, pronouns, common nouns/verbs, question words).

4. **Budget for calibration loops.** Initial handshape presets will rarely pass on the first attempt. Budget 2–3 calibration iterations per preset and 1–2 per sign.

5. **Treat the avatar mesh as a dependency, not a product.** The avatar's visual quality (polygon count, textures, materials) is outside this pipeline's scope. The pipeline produces animations; the avatar is an input.

6. **Version control everything.** Sign definitions, handshape presets, verification logs, and calibration notes must all be tracked in version control. A sign that worked on avatar v2 may need recalibration for avatar v3.

### 10.3 Risk Registry

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Avatar rig bone names don't match canonical names | High | Medium | Name mapping layer in `AvatarIngestor` |
| Handshape presets need per-avatar calibration | High | High | Abstract presets from avatar; calibration log per avatar ID |
| IK solver edge cases (target at exact reach limit) | Medium | Low | Epsilon clamping in solver |
| Performance degradation with 100+ signs loaded | Low | Medium | Lazy-load sign definitions; compile clips on demand |
| NMM deferral causes user/stakeholder frustration | Medium | Medium | Clear roadmap communication; Tier 4 plan documented |
| Uncanny valley effects from stylistic avatar choice | Medium | High | Support stylized/cartoon avatars; avoid hyperrealism |

---

## Appendix A: Mathematical Reference

### A.1 Quaternion Operations

**Hamilton product** (quaternion multiplication):

$$\mathbf{q}_1 \otimes \mathbf{q}_2 = \begin{bmatrix} w_1 w_2 - x_1 x_2 - y_1 y_2 - z_1 z_2 \\ w_1 x_2 + x_1 w_2 + y_1 z_2 - z_1 y_2 \\ w_1 y_2 - x_1 z_2 + y_1 w_2 + z_1 x_2 \\ w_1 z_2 + x_1 y_2 - y_1 x_2 + z_1 w_2 \end{bmatrix}$$

**Conjugate (inverse of unit quaternion)**:

$$\mathbf{q}^{-1} = \overline{\mathbf{q}} = [-x, -y, -z, w]$$

**SLERP (Spherical Linear Interpolation)**:

$$\text{SLERP}(\mathbf{q}_0, \mathbf{q}_1, t) = \frac{\sin((1-t)\Omega)}{\sin\Omega} \mathbf{q}_0 + \frac{\sin(t\Omega)}{\sin\Omega} \mathbf{q}_1$$

where $\Omega = \arccos(\mathbf{q}_0 \cdot \mathbf{q}_1)$.

### A.2 Law of Cosines (IK Application)

For a triangle with sides $a$, $b$ and included angle $C$:

$$c^2 = a^2 + b^2 - 2ab\cos(C)$$

Solving for angle:

$$C = \arccos\left(\frac{a^2 + b^2 - c^2}{2ab}\right)$$

In IK context:
- $a = L_1$ (upper arm), $b = L_2$ (forearm), $c = D$ (shoulder-to-target) → gives elbow angle
- $a = D$, $b = L_1$, $c = L_2$ → gives shoulder offset angle

### A.3 Coordinate Space Conventions

| Convention | Value |
|-----------|-------|
| Handedness | Right-handed |
| Up axis | +Y |
| Forward axis | -Z (camera looks down -Z) |
| Right axis | +X |
| Rotation order | Quaternion (order-independent) |
| Angle units | Radians (all internal math) |

---

*End of Technical Implementation Specification*  
*Document version: 1.0.0*  
*Architecture: Deterministic Calibration-Driven Pipeline*  
*Target runtime: Web-native Three.js (WebGL 2.0 / WebGPU)*
