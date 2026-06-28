/**
 * @fileoverview Sign Assembly Engine
 *
 * Orchestration layer that ties together the analytical IK solver, kinematic
 * trajectory curves, and handshape presets to execute sign definitions
 * frame-by-frame. Capable of compiling the resulting bone animations into
 * a reusable `THREE.AnimationClip`.
 *
 * @module SignAssemblyEngine
 * @author ASL Synthesis Pipeline
 * @license MIT
 */

import * as THREE from 'three';
import { AnalyticalIKSolver } from './AnalyticalIKSolver.js';
import {
  LinearTrajectory,
  ArcTrajectory,
  OscillatoryTrajectory,
} from './KinematicCurves.js';

/* ------------------------------------------------------------------ */
/*  Scratch objects                                                     */
/* ------------------------------------------------------------------ */

const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();

/* ------------------------------------------------------------------ */
/*  Easing functions                                                   */
/* ------------------------------------------------------------------ */

/**
 * Built-in easing functions for timing control.
 * @private
 * @type {Object<string, function(number): number>}
 */
const EASING_FUNCTIONS = {
  linear: (t) => t,
  easeInQuad: (t) => t * t,
  easeOutQuad: (t) => t * (2 - t),
  easeInOutQuad: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  easeSineIn: (t) => 1 - Math.cos((t * Math.PI) / 2),
  easeSineOut: (t) => Math.sin((t * Math.PI) / 2),
  easeSineInOut: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  easeCubicIn: (t) => t * t * t,
  easeCubicOut: (t) => 1 - Math.pow(1 - t, 3),
  easeCubicInOut: (t) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
};

/* ================================================================== */
/*  SignAssemblyEngine                                                  */
/* ================================================================== */

/**
 * Orchestration engine for procedural ASL sign animation.
 *
 * Coordinates trajectory evaluation, analytical IK solving, handshape
 * preset application (with SLERP blending), and final animation-clip
 * compilation.
 *
 * @example
 * ```js
 * const engine = new SignAssemblyEngine(avatarMesh, handshapePresetsJSON);
 * engine.initialize();
 * engine.loadSignDefinition(signDef);
 *
 * // Real-time playback
 * function animate(time) {
 *   engine.executeFrame(time / signDef.timing.totalDuration);
 *   renderer.render(scene, camera);
 *   requestAnimationFrame(animate);
 * }
 *
 * // Or compile to a reusable AnimationClip
 * const clip = engine.compileToAnimationClip(30, 1.5);
 * const action = mixer.clipAction(clip);
 * action.play();
 * ```
 */
class SignAssemblyEngine {
  /* -------------------------------------------------------------- */
  /*  Construction                                                   */
  /* -------------------------------------------------------------- */

  /**
   * Create a new SignAssemblyEngine.
   *
   * @param {THREE.SkinnedMesh} skinnedMesh     - The avatar mesh whose skeleton
   *                                              will be manipulated.
   * @param {Object}            handshapePresets - Parsed `handshapePresets.json` data.
   *                                              Keys are shape names; values are
   *                                              objects mapping finger-bone names
   *                                              to `{ rotation: [x, y, z, w] }`.
   * @throws {Error} If skinnedMesh is null or lacks a skeleton.
   */
  constructor(skinnedMesh, handshapePresets, customBoneNames = null) {
    if (!skinnedMesh || !skinnedMesh.skeleton) {
      throw new Error(
        'SignAssemblyEngine: a valid THREE.SkinnedMesh with an attached skeleton is required.'
      );
    }

    /** @type {THREE.SkinnedMesh} */
    this.skinnedMesh = skinnedMesh;

    /** @type {THREE.Skeleton} */
    this.skeleton = skinnedMesh.skeleton;

    /**
     * Handshape preset library.
     * @type {Object<string, Object<string, number[]>>}
     */
    this.handshapePresets = handshapePresets && handshapePresets.handshapes
      ? handshapePresets.handshapes
      : (handshapePresets || {});

    /**
     * Map of bone names → THREE.Bone references, built during
     * {@link SignAssemblyEngine#initialize}.
     * @type {Map<string, THREE.Bone>}
     * @private
     */
    this._boneMap = new Map();

    /**
     * Rest-pose quaternion cache. Keys are bone names.
     * @type {Map<string, THREE.Quaternion>}
     * @private
     */
    this._restPoses = new Map();

    /**
     * IK solver for the right arm.
     * @type {AnalyticalIKSolver|null}
     * @private
     */
    this._ikRight = null;

    /**
     * IK solver for the left arm.
     * @type {AnalyticalIKSolver|null}
     * @private
     */
    this._ikLeft = null;

    /**
     * Currently loaded sign execution plan.
     * @type {Object|null}
     * @private
     */
    this._executionPlan = null;

    /**
     * Whether {@link SignAssemblyEngine#initialize} has been called.
     * @type {boolean}
     * @private
     */
    this._initialized = false;

    /* ----- Conventional humanoid bone names ----------------------- */

    /**
     * Expected bone-name mappings for right arm.
     * @type {{shoulder: string, elbow: string, wrist: string}}
     * @private
     */
    this._rightArmNames = customBoneNames?.rightArm || {
      shoulder: 'RightUpperArm',
      elbow: 'RightForeArm',
      wrist: 'RightHand',
    };

    /**
     * Expected bone-name mappings for left arm.
     * @type {{shoulder: string, elbow: string, wrist: string}}
     * @private
     */
    this._leftArmNames = customBoneNames?.leftArm || {
      shoulder: 'LeftUpperArm',
      elbow: 'LeftForeArm',
      wrist: 'LeftHand',
    };

    /**
     * Finger bone name prefixes per side (right / left).
     * @type {Object<string, string>}
     * @private
     */
    this._fingerPrefixes = customBoneNames?.prefixes || {
      right: 'RightHand',
      left: 'LeftHand',
    };
  }

  /* -------------------------------------------------------------- */
  /*  Public API                                                     */
  /* -------------------------------------------------------------- */

  /**
   * Initialize the engine: traverse the skeleton, build bone lookup map,
   * capture rest poses, and instantiate IK solvers for both arms.
   *
   * Must be called once before {@link SignAssemblyEngine#loadSignDefinition}
   * or {@link SignAssemblyEngine#executeFrame}.
   *
   * @returns {void}
   * @throws {Error} If required arm bones cannot be found in the skeleton.
   */
  initialize() {
    // 1. Build bone map
    this._boneMap.clear();
    this._restPoses.clear();

    this.skeleton.bones.forEach((bone) => {
      this._boneMap.set(bone.name, bone);

      // Capture rest-pose quaternion
      this._restPoses.set(bone.name, bone.quaternion.clone());
    });

    // 2. Instantiate IK solvers
    this._ikRight = this._createIKSolver(this._rightArmNames);
    this._ikLeft = this._createIKSolver(this._leftArmNames);

    this._initialized = true;
  }

  /**
   * Parse a sign definition object and build an internal execution plan.
   *
   * @param {Object} signDef - Sign definition conforming to the schema:
   * ```js
   * {
   *   id: string,
   *   dominant:    { trajectory, handshapes, palmOrientation, anchor },
   *   nonDominant: { ... } | null,
   *   timing:      { totalDuration: number, easing: string },
   *   metadata:    { gloss: string, category: string }
   * }
   * ```
   *
   * @returns {void}
   * @throws {Error} If the engine has not been initialized or the definition
   *                 is malformed.
   */
  loadSignDefinition(signDef) {
    this._assertInitialized();
    this._validateSignDefinition(signDef);

    const plan = {
      id: signDef.id,
      totalDuration: signDef.timing.totalDuration,
      easing: EASING_FUNCTIONS[signDef.timing.easing] || EASING_FUNCTIONS.linear,
      dominant: this._buildHandPlan(signDef.dominant, 'right'),
      nonDominant: signDef.nonDominant
        ? this._buildHandPlan(signDef.nonDominant, 'left')
        : null,
      metadata: signDef.metadata || {},
    };

    this._executionPlan = plan;
  }

  /**
   * Execute the currently loaded sign at a given normalised time.
   *
   * Evaluates trajectory curves, runs IK, applies handshape blending,
   * and optionally applies palm-orientation overrides.
   *
   * @param {number} t - Normalised time in the range [0, 1].
   * @returns {void}
   * @throws {Error} If no sign definition is loaded or engine is not initialised.
   */
  executeFrame(t) {
    this._assertInitialized();

    if (!this._executionPlan) {
      throw new Error('SignAssemblyEngine.executeFrame: no sign definition loaded.');
    }

    const plan = this._executionPlan;

    // Apply easing to normalised time
    const easedT = plan.easing(Math.max(0, Math.min(1, t)));

    // --- Dominant hand (right arm) --------------------------------
    this._executeHandFrame(plan.dominant, this._ikRight, 'right', easedT);

    // --- Non-dominant hand (left arm) -----------------------------
    if (plan.nonDominant) {
      this._executeHandFrame(plan.nonDominant, this._ikLeft, 'left', easedT);
    }

    // Ensure skeleton matrices are refreshed
    this.skeleton.update();
  }

  /**
   * Sample `executeFrame()` at regular intervals and compile all bone
   * keyframes into a `THREE.AnimationClip`.
   *
   * @param {number} fps             - Frames per second for sampling.
   * @param {number} durationSeconds - Total duration of the clip in seconds.
   * @returns {THREE.AnimationClip} The compiled animation clip.
   * @throws {Error} If no sign definition is loaded.
   */
  compileToAnimationClip(fps = 30, durationSeconds = 1.0) {
    this._assertInitialized();

    if (!this._executionPlan) {
      throw new Error(
        'SignAssemblyEngine.compileToAnimationClip: no sign definition loaded.'
      );
    }

    const totalFrames = Math.ceil(fps * durationSeconds);
    const dt = 1.0 / totalFrames;

    // Tracks: one QuaternionKeyframeTrack per bone
    /** @type {Map<string, { times: number[], values: number[] }>} */
    const trackData = new Map();

    // Initialise track data for each bone in the skeleton
    this.skeleton.bones.forEach((bone) => {
      trackData.set(bone.name, { times: [], values: [] });
    });

    // Reset all bones to rest pose before sampling
    this._resetToRestPose();

    for (let frame = 0; frame <= totalFrames; frame++) {
      const t = frame * dt;
      const timeSec = t * durationSeconds;

      // Reset to rest before each frame to ensure clean state
      this._resetToRestPose();

      // Execute the sign at normalised time t
      this.executeFrame(t);

      // Capture quaternion for every bone
      this.skeleton.bones.forEach((bone) => {
        const td = trackData.get(bone.name);
        td.times.push(timeSec);
        td.values.push(
          bone.quaternion.x,
          bone.quaternion.y,
          bone.quaternion.z,
          bone.quaternion.w
        );
      });
    }

    // Build keyframe tracks
    /** @type {THREE.KeyframeTrack[]} */
    const tracks = [];

    trackData.forEach((data, boneName) => {
      // Only include bones whose quaternion actually changed from rest
      if (this._hasKeyframeVariation(data.values)) {
        tracks.push(
          new THREE.QuaternionKeyframeTrack(
            `${boneName}.quaternion`,
            new Float32Array(data.times),
            new Float32Array(data.values)
          )
        );
      }
    });

    const clipName = this._executionPlan.id || 'ASL_Sign';
    return new THREE.AnimationClip(clipName, durationSeconds, tracks);
  }

  /* -------------------------------------------------------------- */
  /*  Private: Hand-frame execution                                  */
  /* -------------------------------------------------------------- */

  /**
   * Execute a single hand's frame: trajectory evaluation, IK solving,
   * handshape blending, and palm orientation.
   *
   * @param {Object}              handPlan - Built hand execution plan.
   * @param {AnalyticalIKSolver}  ikSolver - IK solver for this arm.
   * @param {string}              side     - 'right' or 'left'.
   * @param {number}              t        - Eased normalised time [0,1].
   * @private
   */
  _executeHandFrame(handPlan, ikSolver, side, t) {
    // --- 1. Evaluate trajectory to get wrist target position ------
    const wristTarget = handPlan.trajectory.evaluate(t);

    // Offset by anchor position
    const anchorPos = handPlan.anchorWorldPos;
    wristTarget.add(anchorPos);

    // --- 2. Compute pole target (elbow hint) ----------------------
    //     Default: offset behind and below the wrist target
    const poleTarget = this._computeDefaultPoleTarget(wristTarget, side);

    // --- 3. Resolve palm orientation (optional) -------------------
    let palmQuat = null;
    if (handPlan.palmOrientation) {
      palmQuat = this._resolvePalmOrientation(handPlan.palmOrientation, t);
    }

    // --- 4. Run IK solver -----------------------------------------
    ikSolver.solve(wristTarget, poleTarget, palmQuat);

    // --- 5. Apply handshape with SLERP blending -------------------
    this._evaluateHandshapeTimeline(handPlan.handshapes, side, t);
  }

  /* -------------------------------------------------------------- */
  /*  Private: Plan building                                         */
  /* -------------------------------------------------------------- */

  /**
   * Build an internal execution plan for one hand from a sign definition's
   * hand descriptor.
   *
   * @param {Object} handDef - The `dominant` or `nonDominant` block from the
   *                           sign definition.
   * @param {string} side    - 'right' or 'left'.
   * @returns {Object} Compiled hand execution plan.
   * @private
   */
  _buildHandPlan(handDef, side) {
    // --- Trajectory -----------------------------------------------
    const trajectory = this._instantiateTrajectory(handDef.trajectory);

    // --- Anchor ---------------------------------------------------
    let anchorWorldPos = new THREE.Vector3();
    if (handDef.anchor) {
      anchorWorldPos = this._resolveAnchor(handDef.anchor, this.skeleton);
    }

    // --- Handshapes timeline --------------------------------------
    const handshapes = this._normaliseHandshapeTimeline(handDef.handshapes || []);

    // --- Palm orientation -----------------------------------------
    const palmOrientation = handDef.palmOrientation || null;

    return {
      side,
      trajectory,
      anchorWorldPos,
      handshapes,
      palmOrientation,
    };
  }

  /**
   * Instantiate a trajectory object from its definition.
   *
   * @param {Object} trajDef - Trajectory definition with at least `type`.
   * @returns {Object} Trajectory instance with an `evaluate(t)` method.
   * @throws {Error} If the trajectory type is unknown.
   * @private
   */
  _instantiateTrajectory(trajDef) {
    if (!trajDef || !trajDef.type) {
      throw new Error(
        'SignAssemblyEngine: trajectory definition must include a "type" field.'
      );
    }

    switch (trajDef.type) {
      case 'linear': {
        const start = new THREE.Vector3().fromArray(trajDef.startOffset || [0, 0, 0]);
        const end = new THREE.Vector3().fromArray(trajDef.endOffset || [0, 0, 0]);
        const easing = EASING_FUNCTIONS[trajDef.easing] || EASING_FUNCTIONS.linear;
        return new LinearTrajectory(start, end, easing);
      }
      case 'arc': {
        const config = trajDef.config || {};
        // Use local offset vector to avoid double-addition of anchor position
        const center = new THREE.Vector3().fromArray(
          config.center ? (config.center.offset || [0, 0, 0]) : [0, 0, 0]
        );
        const radius = config.radius || 0.1;
        const startAngle = config.startAngle || 0;
        const endAngle = config.endAngle || 0;
        const planeNormal = new THREE.Vector3().fromArray(config.planeNormal || [0, 1, 0]);
        const easing = EASING_FUNCTIONS[config.easing] || EASING_FUNCTIONS.linear;
        return new ArcTrajectory(center, radius, startAngle, endAngle, planeNormal, easing);
      }
      case 'oscillatory': {
        const config = trajDef.config || {};
        // Use local offset vector to avoid double-addition of anchor position
        const base = new THREE.Vector3().fromArray(
          config.basePosition ? (config.basePosition.offset || [0, 0, 0]) : [0, 0, 0]
        );
        const amplitude = config.amplitude || 0.05;
        const axis = new THREE.Vector3().fromArray(config.axis || [0, 1, 0]);
        const frequency = config.frequency || 1.0;
        const decayRate = config.decayRate || 0.0;
        const easing = EASING_FUNCTIONS[config.easing] || EASING_FUNCTIONS.linear;
        return new OscillatoryTrajectory(base, amplitude, axis, frequency, decayRate, easing);
      }
      default:
        throw new Error(
          `SignAssemblyEngine: unknown trajectory type "${trajDef.type}". ` +
          'Expected "linear", "arc", or "oscillatory".'
        );
    }
  }

  /**
   * Normalise and sort the handshape timeline entries.
   *
   * @param {Array<{time: number, shape: string}>} timeline - Raw timeline entries.
   * @returns {Array<{time: number, shape: string}>} Sorted shallow copies.
   * @private
   */
  _normaliseHandshapeTimeline(timeline) {
    if (!Array.isArray(timeline) || timeline.length === 0) {
      return [];
    }

    // Shallow-copy and sort by time ascending
    const sorted = timeline
      .map((entry) => ({ time: entry.time, shape: entry.shape }))
      .sort((a, b) => a.time - b.time);

    return sorted;
  }

  /* -------------------------------------------------------------- */
  /*  Private: Handshape application                                 */
  /* -------------------------------------------------------------- */

  /**
   * Evaluate the handshape timeline at normalised time `t`, computing
   * SLERP blending between adjacent keyframes, and apply the result.
   *
   * @param {Array<{time: number, shape: string}>} timeline - Sorted handshape timeline.
   * @param {string} side - 'right' or 'left'.
   * @param {number} t    - Normalised time [0,1].
   * @private
   */
  _evaluateHandshapeTimeline(timeline, side, t) {
    if (!timeline || timeline.length === 0) return;

    // Edge cases: before first or after last keyframe
    if (t <= timeline[0].time) {
      this._applyHandshape(side, timeline[0].shape, 1.0);
      return;
    }
    if (t >= timeline[timeline.length - 1].time) {
      this._applyHandshape(side, timeline[timeline.length - 1].shape, 1.0);
      return;
    }

    // Find bracketing keyframes
    let fromIdx = 0;
    for (let i = 0; i < timeline.length - 1; i++) {
      if (t >= timeline[i].time && t < timeline[i + 1].time) {
        fromIdx = i;
        break;
      }
    }

    const fromEntry = timeline[fromIdx];
    const toEntry = timeline[fromIdx + 1];
    const segmentDuration = toEntry.time - fromEntry.time;
    const blendFactor =
      segmentDuration > 1e-6 ? (t - fromEntry.time) / segmentDuration : 1.0;

    // Apply blended handshape
    this._applyHandshapeBlend(side, fromEntry.shape, toEntry.shape, blendFactor);
  }

  /**
   * Apply a single handshape preset to the finger bones of one hand.
   *
   * Uses SLERP blending between the bone's rest pose and the preset's
   * target rotation, controlled by `blendFactor`.
   *
   * @param {string} side        - 'right' or 'left'.
   * @param {string} shapeName   - Name of the handshape preset.
   * @param {number} blendFactor - Blend weight in [0, 1]. 0 = rest pose, 1 = full preset.
   * @returns {void}
   */
  _applyHandshape(side, shapeName, blendFactor) {
    const shape = this.handshapePresets[shapeName];
    if (!shape) {
      console.warn(
        `SignAssemblyEngine._applyHandshape: unknown preset "${shapeName}".`
      );
      return;
    }

    const bones = shape.bones || shape;
    const clampedBlend = Math.max(0, Math.min(1, blendFactor));

    for (const [boneSuffix, boneData] of Object.entries(bones)) {
      if (boneSuffix === 'description') continue;

      const boneName = this._fingerPrefixes[side] + boneSuffix;
      const bone = this._findBone(boneName);
      if (!bone) continue;

      const restQuat = this._restPoses.get(boneName);
      if (!restQuat) continue;

      const quatArray = Array.isArray(boneData) ? boneData : (boneData.rotation || boneData);
      if (!Array.isArray(quatArray) || quatArray.length < 4) continue;

      const targetQuat = _q.set(
        quatArray[0],
        quatArray[1],
        quatArray[2],
        quatArray[3]
      );

      // SLERP from rest pose to target
      bone.quaternion.copy(restQuat).slerp(targetQuat, clampedBlend);
    }
  }

  /**
   * Apply a blended handshape between two presets using SLERP.
   *
   * For each finger bone, the resulting rotation is:
   * ```
   * result = SLERP(presetA[bone], presetB[bone], blendFactor)
   * ```
   *
   * @param {string} side        - 'right' or 'left'.
   * @param {string} shapeA      - Name of the "from" handshape preset.
   * @param {string} shapeB      - Name of the "to" handshape preset.
   * @param {number} blendFactor - SLERP weight in [0, 1]. 0 = shapeA, 1 = shapeB.
   * @private
   */
  _applyHandshapeBlend(side, shapeA, shapeB, blendFactor) {
    const presetA = this.handshapePresets[shapeA];
    const presetB = this.handshapePresets[shapeB];

    if (!presetA && !presetB) {
      console.warn(
        `SignAssemblyEngine._applyHandshapeBlend: both presets "${shapeA}" ` +
        `and "${shapeB}" are unknown.`
      );
      return;
    }

    // If only one preset is available, fall back to single apply
    if (!presetA) {
      this._applyHandshape(side, shapeB, blendFactor);
      return;
    }
    if (!presetB) {
      this._applyHandshape(side, shapeA, 1.0 - blendFactor);
      return;
    }

    const bonesA = presetA.bones || presetA;
    const bonesB = presetB.bones || presetB;

    // Collect the union of bone suffixes across both presets
    const allSuffixes = new Set([
      ...Object.keys(bonesA),
      ...Object.keys(bonesB),
    ]);

    const clampedBlend = Math.max(0, Math.min(1, blendFactor));

    for (const boneSuffix of allSuffixes) {
      if (boneSuffix === 'description') continue;

      const boneName = this._fingerPrefixes[side] + boneSuffix;
      const bone = this._findBone(boneName);
      if (!bone) continue;

      const restQuat = this._restPoses.get(boneName) || new THREE.Quaternion();

      const dataA = bonesA[boneSuffix];
      let quatA = restQuat;
      if (dataA) {
        const arr = Array.isArray(dataA) ? dataA : (dataA.rotation || dataA);
        if (Array.isArray(arr) && arr.length >= 4) {
          quatA = new THREE.Quaternion(arr[0], arr[1], arr[2], arr[3]);
        }
      }

      const dataB = bonesB[boneSuffix];
      let quatB = restQuat;
      if (dataB) {
        const arr = Array.isArray(dataB) ? dataB : (dataB.rotation || dataB);
        if (Array.isArray(arr) && arr.length >= 4) {
          quatB = new THREE.Quaternion(arr[0], arr[1], arr[2], arr[3]);
        }
      }

      bone.quaternion.copy(quatA).slerp(quatB, clampedBlend);
    }
  }

  /* -------------------------------------------------------------- */
  /*  Private: Anchor resolution                                     */
  /* -------------------------------------------------------------- */

  /**
   * Resolve a body-relative anchor definition to a world-space Vector3.
   *
   * An anchor definition specifies a reference bone and a local offset:
   * ```js
   * { bone: 'Spine1', offset: [0, 0.2, 0.15] }
   * ```
   *
   * The world position is computed as:
   * ```
   * anchorBone.worldPosition + anchorBone.worldQuaternion * offset
   * ```
   *
   * @param {Object}         anchorDef           - Anchor definition.
   * @param {string}         anchorDef.bone      - Name of the reference bone.
   * @param {number[]}       anchorDef.offset    - Local offset `[x, y, z]`.
   * @param {THREE.Skeleton} skeleton            - The avatar skeleton.
   * @returns {THREE.Vector3} Resolved world-space position.
   */
  _resolveAnchor(anchorDef, skeleton) {
    const bone = this._findBone(anchorDef.bone);
    if (!bone) {
      console.warn(
        `SignAssemblyEngine._resolveAnchor: bone "${anchorDef.bone}" not found. ` +
        'Using origin.'
      );
      return new THREE.Vector3();
    }

    bone.updateWorldMatrix(true, false);

    const worldPos = new THREE.Vector3();
    worldPos.setFromMatrixPosition(bone.matrixWorld);

    if (anchorDef.offset) {
      const offset = new THREE.Vector3(
        anchorDef.offset[0] || 0,
        anchorDef.offset[1] || 0,
        anchorDef.offset[2] || 0
      );

      // Transform offset by the bone's world rotation
      const boneWorldQuat = new THREE.Quaternion();
      bone.matrixWorld.decompose(
        _v3,       // position (discarded)
        boneWorldQuat,
        new THREE.Vector3() // scale (discarded)
      );
      offset.applyQuaternion(boneWorldQuat);

      worldPos.add(offset);
    }

    return worldPos;
  }

  /* -------------------------------------------------------------- */
  /*  Private: Pole target & palm orientation                        */
  /* -------------------------------------------------------------- */

  /**
   * Compute a sensible default pole-vector target for elbow direction.
   *
   * For the right arm the pole target is placed behind and below the wrist;
   * for the left arm it is mirrored.
   *
   * @param {THREE.Vector3} wristTarget - Current wrist target position.
   * @param {string}        side        - 'right' or 'left'.
   * @returns {THREE.Vector3} Pole target in world space.
   * @private
   */
  _computeDefaultPoleTarget(wristTarget, side) {
    const offset = new THREE.Vector3(
      side === 'right' ? 0.15 : -0.15,
      -0.3,
      -0.25
    );
    return new THREE.Vector3().copy(wristTarget).add(offset);
  }

  /**
   * Resolve a palm orientation descriptor to a world-space quaternion.
   *
   * Supports either a static quaternion or an interpolated timeline.
   *
   * @param {Object} palmDef - Palm orientation definition.
   * @param {number} t       - Normalised time.
   * @returns {THREE.Quaternion|null} Resolved quaternion, or null.
   * @private
   */
  _resolvePalmOrientation(palmDef, t) {
    // Static quaternion
    if (palmDef.quaternion) {
      const q = palmDef.quaternion;
      return new THREE.Quaternion(q[0], q[1], q[2], q[3]);
    }

    // Timeline of quaternion keyframes
    if (palmDef.timeline && Array.isArray(palmDef.timeline)) {
      return this._interpolateQuaternionTimeline(palmDef.timeline, t);
    }

    // Euler-based specification
    if (palmDef.euler) {
      const e = palmDef.euler;
      return new THREE.Quaternion().setFromEuler(
        new THREE.Euler(e[0], e[1], e[2], e[3] || 'XYZ')
      );
    }

    return null;
  }

  /**
   * Interpolate a timeline of quaternion keyframes via SLERP.
   *
   * @param {Array<{time: number, quaternion: number[]}>} timeline - Sorted keyframes.
   * @param {number} t - Normalised time [0,1].
   * @returns {THREE.Quaternion} Interpolated quaternion.
   * @private
   */
  _interpolateQuaternionTimeline(timeline, t) {
    if (timeline.length === 0) return new THREE.Quaternion();

    if (t <= timeline[0].time) {
      const q = timeline[0].quaternion;
      return new THREE.Quaternion(q[0], q[1], q[2], q[3]);
    }

    if (t >= timeline[timeline.length - 1].time) {
      const q = timeline[timeline.length - 1].quaternion;
      return new THREE.Quaternion(q[0], q[1], q[2], q[3]);
    }

    // Find bracketing keyframes
    for (let i = 0; i < timeline.length - 1; i++) {
      if (t >= timeline[i].time && t < timeline[i + 1].time) {
        const segDuration = timeline[i + 1].time - timeline[i].time;
        const alpha = segDuration > 1e-6
          ? (t - timeline[i].time) / segDuration
          : 1.0;

        const qA = timeline[i].quaternion;
        const qB = timeline[i + 1].quaternion;

        const from = new THREE.Quaternion(qA[0], qA[1], qA[2], qA[3]);
        const to = new THREE.Quaternion(qB[0], qB[1], qB[2], qB[3]);

        return from.slerp(to, alpha);
      }
    }

    // Fallback
    const last = timeline[timeline.length - 1].quaternion;
    return new THREE.Quaternion(last[0], last[1], last[2], last[3]);
  }

  /* -------------------------------------------------------------- */
  /*  Private: Skeleton utilities                                    */
  /* -------------------------------------------------------------- */

  /**
   * Look up a bone by name from the internal bone map.
   *
   * @param {string} name - Bone name to search for.
   * @returns {THREE.Bone|null} The bone, or null if not found.
   */
  _findBone(name) {
    return this._boneMap.get(name) || null;
  }

  /**
   * Create an {@link AnalyticalIKSolver} for the arm defined by the given
   * bone-name mapping.
   *
   * @param {{shoulder: string, elbow: string, wrist: string}} names
   *   Bone name mapping.
   * @returns {AnalyticalIKSolver} Configured solver instance.
   * @throws {Error} If any of the required bones are not found.
   * @private
   */
  _createIKSolver(names) {
    const shoulder = this._findBone(names.shoulder);
    const elbow = this._findBone(names.elbow);
    const wrist = this._findBone(names.wrist);

    if (!shoulder || !elbow || !wrist) {
      throw new Error(
        `SignAssemblyEngine: could not find arm bones ` +
        `[${names.shoulder}, ${names.elbow}, ${names.wrist}] in skeleton. ` +
        `Available bones: ${[...this._boneMap.keys()].join(', ')}`
      );
    }

    return new AnalyticalIKSolver(shoulder, elbow, wrist);
  }

  /**
   * Reset all bones to their captured rest-pose quaternions.
   *
   * @private
   */
  _resetToRestPose() {
    this._restPoses.forEach((restQuat, boneName) => {
      const bone = this._findBone(boneName);
      if (bone) {
        bone.quaternion.copy(restQuat);
      }
    });
  }

  /* -------------------------------------------------------------- */
  /*  Private: Validation                                            */
  /* -------------------------------------------------------------- */

  /**
   * Assert that `initialize()` has been called.
   *
   * @throws {Error} If the engine is not initialised.
   * @private
   */
  _assertInitialized() {
    if (!this._initialized) {
      throw new Error(
        'SignAssemblyEngine: engine has not been initialized. ' +
        'Call initialize() before using the engine.'
      );
    }
  }

  /**
   * Validate the structure of a sign definition object.
   *
   * @param {Object} signDef - The sign definition to validate.
   * @throws {Error} If the definition is invalid.
   * @private
   */
  _validateSignDefinition(signDef) {
    if (!signDef || typeof signDef !== 'object') {
      throw new Error(
        'SignAssemblyEngine.loadSignDefinition: signDef must be a non-null object.'
      );
    }

    if (!signDef.id || typeof signDef.id !== 'string') {
      throw new Error(
        'SignAssemblyEngine.loadSignDefinition: signDef.id must be a non-empty string.'
      );
    }

    if (!signDef.dominant || typeof signDef.dominant !== 'object') {
      throw new Error(
        'SignAssemblyEngine.loadSignDefinition: signDef.dominant is required.'
      );
    }

    if (
      !signDef.dominant.trajectory ||
      typeof signDef.dominant.trajectory.type !== 'string'
    ) {
      throw new Error(
        'SignAssemblyEngine.loadSignDefinition: signDef.dominant.trajectory ' +
        'must include a "type" field.'
      );
    }

    if (!signDef.timing || typeof signDef.timing !== 'object') {
      throw new Error(
        'SignAssemblyEngine.loadSignDefinition: signDef.timing is required.'
      );
    }

    if (
      typeof signDef.timing.totalDuration !== 'number' ||
      signDef.timing.totalDuration <= 0
    ) {
      throw new Error(
        'SignAssemblyEngine.loadSignDefinition: signDef.timing.totalDuration ' +
        'must be a positive number.'
      );
    }

    // Validate non-dominant (optional)
    if (signDef.nonDominant && typeof signDef.nonDominant === 'object') {
      if (
        !signDef.nonDominant.trajectory ||
        typeof signDef.nonDominant.trajectory.type !== 'string'
      ) {
        throw new Error(
          'SignAssemblyEngine.loadSignDefinition: signDef.nonDominant.trajectory ' +
          'must include a "type" field.'
        );
      }
    }
  }

  /* -------------------------------------------------------------- */
  /*  Private: Keyframe helpers                                      */
  /* -------------------------------------------------------------- */

  /**
   * Check whether a flat array of quaternion values `[x,y,z,w, x,y,z,w, …]`
   * contains any meaningful variation (i.e. the bone actually moved).
   *
   * Used during animation clip compilation to prune static bones.
   *
   * @param {number[]} values - Flat quaternion array.
   * @returns {boolean} `true` if any value differs from the first keyframe.
   * @private
   */
  _hasKeyframeVariation(values) {
    if (values.length < 8) return false; // Need at least 2 keyframes

    const threshold = 1e-5;
    const x0 = values[0], y0 = values[1], z0 = values[2], w0 = values[3];

    for (let i = 4; i < values.length; i += 4) {
      if (
        Math.abs(values[i] - x0) > threshold ||
        Math.abs(values[i + 1] - y0) > threshold ||
        Math.abs(values[i + 2] - z0) > threshold ||
        Math.abs(values[i + 3] - w0) > threshold
      ) {
        return true;
      }
    }

    return false;
  }
}

export { SignAssemblyEngine };
export default SignAssemblyEngine;
