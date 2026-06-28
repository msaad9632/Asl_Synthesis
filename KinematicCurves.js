/**
 * @fileoverview Kinematic trajectory curves and easing utilities for ASL
 * procedural synthesis. Provides parametric trajectory classes that map
 * normalised time t ∈ [0,1] to world-space THREE.Vector3 positions, plus
 * biologically-motivated easing functions.
 *
 * @module KinematicCurves
 * @version 1.0.0
 */

import * as THREE from 'three';

// ─────────────────────────────────────────────────────────────────────────────
// Easing Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Linear easing — identity function.
 * @param {number} t - Normalised time in [0, 1].
 * @returns {number} The unchanged value of t.
 */
export function easeLinear(t) {
  return t;
}

/**
 * Sine-based ease-in-out — produces smooth biological-feel acceleration and
 * deceleration characteristic of natural limb motion (minimum-jerk profile
 * approximation).
 * @param {number} t - Normalised time in [0, 1].
 * @returns {number} Eased value in [0, 1].
 */
export function easeSineInOut(t) {
  return 0.5 * (1.0 - Math.cos(Math.PI * t));
}

/**
 * Cubic ease-in-out — S-curve with sharper transitions than sine.
 * Suitable for deliberate, emphatic ASL movements.
 * @param {number} t - Normalised time in [0, 1].
 * @returns {number} Eased value in [0, 1].
 */
export function easeCubicInOut(t) {
  return t < 0.5
    ? 4.0 * t * t * t
    : 1.0 - Math.pow(-2.0 * t + 2.0, 3) / 2.0;
}

/**
 * Quadratic ease-in-out — softer than cubic, useful for relaxed movements.
 * @param {number} t - Normalised time in [0, 1].
 * @returns {number} Eased value in [0, 1].
 */
export function easeQuadInOut(t) {
  return t < 0.5
    ? 2.0 * t * t
    : 1.0 - Math.pow(-2.0 * t + 2.0, 2) / 2.0;
}

/**
 * Back-out easing — slight overshoot before settling, producing a natural
 * "follow-through" effect found in biological motion.
 * @param {number} t - Normalised time in [0, 1].
 * @returns {number} Eased value (may slightly exceed 1.0 before settling).
 */
export function easeBackOut(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1.0;
  return 1.0 + c3 * Math.pow(t - 1.0, 3) + c1 * Math.pow(t - 1.0, 2);
}

// ─────────────────────────────────────────────────────────────────────────────
// LinearTrajectory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Straight-line interpolation between two points with configurable easing.
 *
 * Formula: `P(t) = start + E(t) · (end − start)`
 *
 * @example
 * const traj = new LinearTrajectory(
 *   new THREE.Vector3(0, 1, 0),
 *   new THREE.Vector3(0.5, 1.2, 0.3),
 *   easeSineInOut
 * );
 * const pos = traj.evaluate(0.5); // midpoint with eased timing
 */
export class LinearTrajectory {
  /**
   * @param {THREE.Vector3} startVec3 - Start position.
   * @param {THREE.Vector3} endVec3   - End position.
   * @param {function(number): number} [easingFn=easeLinear] - Easing function.
   */
  constructor(startVec3, endVec3, easingFn = easeLinear) {
    /** @type {THREE.Vector3} */ this._start = startVec3.clone();
    /** @type {THREE.Vector3} */ this._end = endVec3.clone();
    /** @type {THREE.Vector3} */ this._delta = new THREE.Vector3().subVectors(endVec3, startVec3);
    /** @type {function(number): number} */ this._easing = easingFn;

    // Pre-allocated scratch vectors to avoid per-frame GC pressure.
    /** @private */ this._scratchA = new THREE.Vector3();
    /** @private */ this._scratchB = new THREE.Vector3();
  }

  /**
   * Evaluate position along the trajectory.
   * @param {number} t - Normalised time in [0, 1].
   * @returns {THREE.Vector3} World-space position (new instance).
   */
  evaluate(t) {
    const e = this._easing(t);
    return this._scratchA
      .copy(this._delta)
      .multiplyScalar(e)
      .add(this._start)
      .clone();
  }

  /**
   * Numerical velocity approximation via central difference.
   * @param {number} t  - Normalised time in [0, 1].
   * @param {number} dt - Finite difference step (default 0.001).
   * @returns {THREE.Vector3} Approximate velocity vector (units per normalised-t).
   */
  evaluateVelocity(t, dt = 0.001) {
    const t0 = Math.max(0.0, t - dt * 0.5);
    const t1 = Math.min(1.0, t + dt * 0.5);
    const p0 = this.evaluate(t0);
    const p1 = this.evaluate(t1);
    const actualDt = t1 - t0;
    return p1.sub(p0).divideScalar(actualDt);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ArcTrajectory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Circular arc trajectory in an arbitrary plane. Useful for sign motions that
 * follow curved paths (e.g., the ASL sign "WORLD" traces an arc).
 *
 * The arc lies in the plane defined by `planeNormal`. Two orthonormal basis
 * vectors **u** and **v** are constructed automatically so that:
 *
 * `P(t) = center + r·cos(θ(t))·u + r·sin(θ(t))·v`
 *
 * where `θ(t) = startAngle + E(t)·(endAngle − startAngle)`.
 *
 * @example
 * const arc = new ArcTrajectory(
 *   new THREE.Vector3(0, 1.2, 0), // center
 *   0.15,                          // radius 15 cm
 *   0, Math.PI,                    // half-circle
 *   new THREE.Vector3(0, 0, 1),   // XY plane
 *   easeSineInOut
 * );
 */
export class ArcTrajectory {
  /**
   * @param {THREE.Vector3} center      - Center of the arc circle.
   * @param {number}        radius      - Radius of the arc.
   * @param {number}        startAngle  - Start angle in radians.
   * @param {number}        endAngle    - End angle in radians.
   * @param {THREE.Vector3} planeNormal - Normal vector of the arc plane.
   * @param {function(number): number} [easingFn=easeLinear] - Easing function.
   */
  constructor(center, radius, startAngle, endAngle, planeNormal, easingFn = easeLinear) {
    /** @type {THREE.Vector3} */ this._center = center.clone();
    /** @type {number} */        this._radius = radius;
    /** @type {number} */        this._startAngle = startAngle;
    /** @type {number} */        this._endAngle = endAngle;
    /** @type {number} */        this._angleDelta = endAngle - startAngle;
    /** @type {function(number): number} */ this._easing = easingFn;

    // Compute orthonormal basis {u, v} in the arc plane.
    const n = planeNormal.clone().normalize();

    // Choose a reference vector not parallel to n for cross-product stability.
    const ref = Math.abs(n.dot(new THREE.Vector3(0, 1, 0))) < 0.99
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(1, 0, 0);

    /** @type {THREE.Vector3} */ this._u = new THREE.Vector3().crossVectors(n, ref).normalize();
    /** @type {THREE.Vector3} */ this._v = new THREE.Vector3().crossVectors(n, this._u).normalize();

    // Pre-allocated scratch vectors.
    /** @private */ this._scratch = new THREE.Vector3();
  }

  /**
   * Evaluate position along the arc.
   * @param {number} t - Normalised time in [0, 1].
   * @returns {THREE.Vector3} World-space position (new instance).
   */
  evaluate(t) {
    const e = this._easing(t);
    const theta = this._startAngle + e * this._angleDelta;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);

    return this._scratch
      .copy(this._center)
      .addScaledVector(this._u, this._radius * cosT)
      .addScaledVector(this._v, this._radius * sinT)
      .clone();
  }

  /**
   * Numerical velocity approximation via central difference.
   * @param {number} t  - Normalised time in [0, 1].
   * @param {number} dt - Finite difference step (default 0.001).
   * @returns {THREE.Vector3} Approximate velocity vector.
   */
  evaluateVelocity(t, dt = 0.001) {
    const t0 = Math.max(0.0, t - dt * 0.5);
    const t1 = Math.min(1.0, t + dt * 0.5);
    const p0 = this.evaluate(t0);
    const p1 = this.evaluate(t1);
    const actualDt = t1 - t0;
    return p1.sub(p0).divideScalar(actualDt);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OscillatoryTrajectory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Damped sinusoidal oscillation for tapping, bouncing, and repeated-contact
 * motions (e.g., ASL "AGAIN", "HELP", repeated tapping classifiers).
 *
 * `P(t) = base + A · sin(2π · f · t) · e^(−decay · t) · axis`
 *
 * @example
 * const tap = new OscillatoryTrajectory(
 *   new THREE.Vector3(0, 1, 0.2),   // base position
 *   0.05,                             // 5 cm amplitude
 *   new THREE.Vector3(0, -1, 0),     // downward tapping axis
 *   3.0,                              // 3 Hz
 *   2.0,                              // decay rate
 *   easeSineInOut
 * );
 */
export class OscillatoryTrajectory {
  /**
   * @param {THREE.Vector3} basePosition - Rest / centre position.
   * @param {number}        amplitude    - Peak displacement magnitude.
   * @param {THREE.Vector3} axis         - Unit vector defining oscillation direction.
   * @param {number}        frequency    - Oscillation frequency in Hz.
   * @param {number}        decayRate    - Exponential decay coefficient (0 = no decay).
   * @param {function(number): number} [easingFn=easeLinear] - Easing applied to t
   *   before computing the oscillation (useful for fade-in/out envelopes).
   */
  constructor(basePosition, amplitude, axis, frequency, decayRate = 0.0, easingFn = easeLinear) {
    /** @type {THREE.Vector3} */ this._base = basePosition.clone();
    /** @type {number} */        this._amplitude = amplitude;
    /** @type {THREE.Vector3} */ this._axis = axis.clone().normalize();
    /** @type {number} */        this._frequency = frequency;
    /** @type {number} */        this._decayRate = decayRate;
    /** @type {function(number): number} */ this._easing = easingFn;

    /** @private */ this._scratch = new THREE.Vector3();
  }

  /**
   * Evaluate oscillatory position at time t.
   * @param {number} t - Normalised time in [0, 1] (or unbounded if used as
   *   a raw time parameter for continuous oscillation).
   * @returns {THREE.Vector3} World-space position (new instance).
   */
  evaluate(t) {
    const e = this._easing(t);
    const phase = Math.sin(2.0 * Math.PI * this._frequency * e);
    const envelope = Math.exp(-this._decayRate * e);
    const displacement = this._amplitude * phase * envelope;

    return this._scratch
      .copy(this._base)
      .addScaledVector(this._axis, displacement)
      .clone();
  }

  /**
   * Numerical velocity approximation via central difference.
   * @param {number} t  - Normalised time in [0, 1].
   * @param {number} dt - Finite difference step (default 0.001).
   * @returns {THREE.Vector3} Approximate velocity vector.
   */
  evaluateVelocity(t, dt = 0.001) {
    const t0 = Math.max(0.0, t - dt * 0.5);
    const t1 = Math.min(1.0, t + dt * 0.5);
    const p0 = this.evaluate(t0);
    const p1 = this.evaluate(t1);
    const actualDt = t1 - t0;
    return p1.sub(p0).divideScalar(actualDt);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BodyRelativeAnchor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves a world-space anchor point defined relative to a skeleton bone.
 * This is essential for ASL sign placement — signs are specified relative to
 * body landmarks (chin, chest, forehead, shoulder, etc.), and the actual
 * world-space coordinates must be derived from the animated skeleton at
 * runtime.
 *
 * @example
 * const chinAnchor = new BodyRelativeAnchor(
 *   'Head',                                  // reference bone name
 *   new THREE.Vector3(0, -0.08, 0.05)       // 8 cm below, 5 cm forward
 * );
 * // During animation loop:
 * skeleton.bones.forEach(b => b.updateWorldMatrix(true, false));
 * const worldPos = chinAnchor.resolve(skeleton);
 */
export class BodyRelativeAnchor {
  /**
   * @param {string}        referenceBone - Name of the skeleton bone to attach to.
   * @param {THREE.Vector3} localOffset   - Offset in the bone's local coordinate space.
   */
  constructor(referenceBone, localOffset) {
    /** @type {string} */        this._boneName = referenceBone;
    /** @type {THREE.Vector3} */ this._offset = localOffset.clone();

    // Cached references — populated lazily on first resolve().
    /** @private @type {THREE.Bone|null} */ this._boneRef = null;

    // Pre-allocated working objects.
    /** @private */ this._worldMatrix = new THREE.Matrix4();
    /** @private */ this._result = new THREE.Vector3();
  }

  /**
   * Resolve the anchor to a world-space position by reading the bone's
   * current world matrix.
   *
   * **Important**: Ensure `skeleton.bones` world matrices are up-to-date
   * (call `updateWorldMatrix(true, false)` on the root bone first).
   *
   * @param {THREE.Skeleton} skeleton - The skeleton to look up the bone from.
   * @returns {THREE.Vector3} World-space position (new instance).
   * @throws {Error} If the named bone is not found in the skeleton.
   */
  resolve(skeleton) {
    // Lazily cache the bone reference for performance.
    if (this._boneRef === null || this._boneRef.skeleton !== skeleton) {
      this._boneRef = this._findBone(skeleton);
    }

    this._worldMatrix.copy(this._boneRef.matrixWorld);
    this._result.copy(this._offset).applyMatrix4(this._worldMatrix);
    return this._result.clone();
  }

  /**
   * Look up the bone by name within the skeleton.
   * @private
   * @param {THREE.Skeleton} skeleton
   * @returns {THREE.Bone}
   */
  _findBone(skeleton) {
    const bone = skeleton.bones.find(b => b.name === this._boneName);
    if (!bone) {
      throw new Error(
        `BodyRelativeAnchor: bone "${this._boneName}" not found in skeleton. ` +
        `Available bones: [${skeleton.bones.map(b => b.name).join(', ')}]`
      );
    }
    return bone;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TrajectorySequence
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chains multiple trajectory segments into a seamless compound trajectory.
 * Each segment has an associated time range within the global [0, 1] interval.
 * `evaluate(globalT)` delegates to the correct segment and maps globalT to
 * that segment's local t ∈ [0, 1].
 *
 * This is the primary mechanism for composing multi-phase sign motions
 * (e.g., preparation → stroke → retraction).
 *
 * @example
 * const seq = new TrajectorySequence();
 * seq.addSegment(preparationTrajectory, 0.0, 0.3);   // 0–30%
 * seq.addSegment(strokeTrajectory,      0.3, 0.7);   // 30–70%
 * seq.addSegment(retractionTrajectory,  0.7, 1.0);   // 70–100%
 *
 * const pos = seq.evaluate(0.5); // maps to strokeTrajectory at local t=0.5
 */
export class TrajectorySequence {
  constructor() {
    /**
     * @type {Array<{trajectory: object, tStart: number, tEnd: number}>}
     * @private
     */
    this._segments = [];
  }

  /**
   * Append a trajectory segment.
   * @param {LinearTrajectory|ArcTrajectory|OscillatoryTrajectory|object} trajectory
   *   Any object implementing an `evaluate(t)` method.
   * @param {number} tStart - Segment start time in global [0, 1].
   * @param {number} tEnd   - Segment end time in global [0, 1].
   * @returns {TrajectorySequence} This instance (for chaining).
   * @throws {Error} If time range is invalid or overlaps existing segments.
   */
  addSegment(trajectory, tStart, tEnd) {
    if (tStart >= tEnd) {
      throw new Error(
        `TrajectorySequence.addSegment: tStart (${tStart}) must be less than tEnd (${tEnd}).`
      );
    }
    if (typeof trajectory.evaluate !== 'function') {
      throw new Error(
        'TrajectorySequence.addSegment: trajectory must implement an evaluate(t) method.'
      );
    }

    // Validate no overlaps with existing segments.
    for (const seg of this._segments) {
      if (tStart < seg.tEnd && tEnd > seg.tStart) {
        throw new Error(
          `TrajectorySequence.addSegment: time range [${tStart}, ${tEnd}] overlaps ` +
          `existing segment [${seg.tStart}, ${seg.tEnd}].`
        );
      }
    }

    this._segments.push({ trajectory, tStart, tEnd });

    // Keep segments sorted by start time for binary-search evaluation.
    this._segments.sort((a, b) => a.tStart - b.tStart);

    return this;
  }

  /**
   * Get the number of trajectory segments.
   * @returns {number}
   */
  get segmentCount() {
    return this._segments.length;
  }

  /**
   * Evaluate the compound trajectory at a global time.
   *
   * If `globalT` falls between segments, the nearest segment endpoint is used
   * (hold behaviour). If `globalT` is before all segments, the first segment's
   * start is used; if after all, the last segment's end.
   *
   * @param {number} globalT - Normalised time in [0, 1].
   * @returns {THREE.Vector3} World-space position.
   * @throws {Error} If the sequence has no segments.
   */
  evaluate(globalT) {
    if (this._segments.length === 0) {
      throw new Error('TrajectorySequence.evaluate: no segments have been added.');
    }

    // Clamp to valid range.
    const t = Math.max(0.0, Math.min(1.0, globalT));

    // Find the segment containing t.
    const seg = this._findSegment(t);

    // Map globalT → segment-local t in [0, 1].
    const segDuration = seg.tEnd - seg.tStart;
    const localT = Math.max(0.0, Math.min(1.0, (t - seg.tStart) / segDuration));

    return seg.trajectory.evaluate(localT);
  }

  /**
   * Numerical velocity at global time t.
   * @param {number} globalT - Normalised time in [0, 1].
   * @param {number} dt      - Finite difference step (default 0.001).
   * @returns {THREE.Vector3} Approximate velocity vector.
   */
  evaluateVelocity(globalT, dt = 0.001) {
    const t0 = Math.max(0.0, globalT - dt * 0.5);
    const t1 = Math.min(1.0, globalT + dt * 0.5);
    const p0 = this.evaluate(t0);
    const p1 = this.evaluate(t1);
    const actualDt = t1 - t0;
    return p1.sub(p0).divideScalar(actualDt);
  }

  /**
   * Find the segment that contains the given global time.
   * Falls back to nearest segment boundary for gaps.
   * @private
   * @param {number} t - Clamped global time.
   * @returns {{trajectory: object, tStart: number, tEnd: number}}
   */
  _findSegment(t) {
    // Direct hit — check each segment.
    for (const seg of this._segments) {
      if (t >= seg.tStart && t <= seg.tEnd) {
        return seg;
      }
    }

    // Before the first segment — hold at start.
    if (t < this._segments[0].tStart) {
      return this._segments[0];
    }

    // After the last segment — hold at end.
    const last = this._segments[this._segments.length - 1];
    if (t > last.tEnd) {
      return last;
    }

    // Between segments — find the nearest segment boundary.
    let bestSeg = this._segments[0];
    let bestDist = Infinity;
    for (const seg of this._segments) {
      const distToStart = Math.abs(t - seg.tStart);
      const distToEnd = Math.abs(t - seg.tEnd);
      const minDist = Math.min(distToStart, distToEnd);
      if (minDist < bestDist) {
        bestDist = minDist;
        bestSeg = seg;
      }
    }
    return bestSeg;
  }
}
