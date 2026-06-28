/**
 * @fileoverview Analytical 2-Bone Inverse Kinematics Solver
 *
 * Implements a closed-form (non-iterative) IK solution for upper-limb chains
 * (Shoulder → Elbow → Wrist) using the Law of Cosines for exact angle
 * computation, pole-vector alignment for elbow direction control, and optional
 * palm orientation overrides.
 *
 * This solver is deterministic and suitable for real-time procedural animation
 * of humanoid sign-language avatars.
 *
 * @module AnalyticalIKSolver
 * @author ASL Synthesis Pipeline
 * @license MIT
 */

import * as THREE from 'three';

/* ------------------------------------------------------------------ */
/*  Re-usable scratch objects (allocated once, mutated in-place)       */
/* ------------------------------------------------------------------ */

const _v3A = new THREE.Vector3();
const _v3B = new THREE.Vector3();
const _v3C = new THREE.Vector3();
const _v3D = new THREE.Vector3();
const _v3E = new THREE.Vector3();

const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _q4 = new THREE.Quaternion();

const _mat4 = new THREE.Matrix4();

/**
 * Analytical 2-Bone IK solver for a three-joint chain (e.g. Shoulder →
 * Elbow → Wrist).
 *
 * Unlike iterative solvers (CCD, FABRIK) this solver computes the exact
 * joint rotations in constant time using the Law of Cosines, guaranteeing
 * frame-deterministic results with zero convergence jitter.
 *
 * @example
 * ```js
 * const ik = new AnalyticalIKSolver(shoulderBone, elbowBone, handBone);
 * ik.solve(
 *   new THREE.Vector3(0.3, 1.4, 0.1),   // wrist target
 *   new THREE.Vector3(0.2, 1.0, -0.3),  // pole target (elbow hint)
 *   new THREE.Quaternion()                // optional palm orientation
 * );
 * ```
 */
class AnalyticalIKSolver {

  /* -------------------------------------------------------------- */
  /*  Construction                                                   */
  /* -------------------------------------------------------------- */

  /**
   * Create a new AnalyticalIKSolver for the given bone chain.
   *
   * @param {THREE.Bone} upperArm  - The shoulder / upper-arm bone (root of the chain).
   * @param {THREE.Bone} lowerArm  - The elbow / forearm bone (middle joint).
   * @param {THREE.Bone} hand      - The wrist / hand bone (end effector).
   * @throws {Error} If any of the bone references are null or undefined.
   */
  constructor(upperArm, lowerArm, hand) {
    if (!upperArm || !lowerArm || !hand) {
      throw new Error(
        'AnalyticalIKSolver: all three bones (upperArm, lowerArm, hand) are required.'
      );
    }

    /** @type {THREE.Bone} Root joint (shoulder). */
    this.upperArm = upperArm;

    /** @type {THREE.Bone} Middle joint (elbow). */
    this.lowerArm = lowerArm;

    /** @type {THREE.Bone} End effector (hand / wrist). */
    this.hand = hand;

    /**
     * Upper-arm segment length (shoulder → elbow).
     * Measured once on the first call to `solve()` and cached.
     * @type {number|null}
     * @private
     */
    this._L1 = null;

    /**
     * Forearm segment length (elbow → wrist).
     * Measured once on the first call to `solve()` and cached.
     * @type {number|null}
     * @private
     */
    this._L2 = null;

    /**
     * Small epsilon used for clamping to avoid degenerate (fully
     * extended / fully collapsed) configurations.
     * @type {number}
     * @private
     */
    this._epsilon = 0.001;

    /**
     * Cached rest-pose local quaternion of the upper arm bone.
     * Captured on first `solve()` call before any IK modifications.
     * @type {THREE.Quaternion|null}
     * @private
     */
    this._upperArmRestLocal = null;

    /**
     * Cached rest-pose local quaternion of the lower arm bone.
     * Captured on first `solve()` call before any IK modifications.
     * @type {THREE.Quaternion|null}
     * @private
     */
    this._lowerArmRestLocal = null;
  }

  /* -------------------------------------------------------------- */
  /*  Public API                                                     */
  /* -------------------------------------------------------------- */

  /**
   * Solve the IK chain so that the hand (end effector) reaches
   * `targetPosition` with the elbow oriented toward `poleTarget`.
   *
   * The solver writes directly to the `quaternion` property of each bone.
   * After calling this method you should call
   * `skinnedMesh.skeleton.update()` (or let the render loop do it) to
   * propagate the changes.
   *
   * @param {THREE.Vector3}      targetPosition  - Desired wrist position in world space.
   * @param {THREE.Vector3}      poleTarget      - World-space pole-vector target
   *                                               controlling elbow direction.
   * @param {THREE.Quaternion}   [palmOrientation] - Optional desired world-space palm rotation.
   * @returns {void}
   */
  solve(targetPosition, poleTarget, palmOrientation) {
    /* ----- Step 0: Ensure world matrices are current --------------- */
    this.upperArm.updateWorldMatrix(true, true);

    /* ----- Step 1: Measure & cache bone lengths (first call only) -- */
    if (this._L1 === null || this._L2 === null) {
      this._measureBoneLengths();
    }

    const L1 = this._L1;
    const L2 = this._L2;

    /* ----- Step 2: Compute reach distance D ----------------------- */
    const shoulderPos = this._getBoneWorldPosition(this.upperArm);
    const targetDir = _v3A.copy(targetPosition).sub(shoulderPos);
    let D = targetDir.length();

    /* ----- Step 3: Clamp target if outside reachable envelope ------ */
    const maxReach = L1 + L2 - this._epsilon;
    const minReach = Math.abs(L1 - L2) + this._epsilon;

    if (D > maxReach) {
      D = maxReach;
      targetDir.normalize().multiplyScalar(D);
    } else if (D < minReach) {
      D = minReach;
      targetDir.normalize().multiplyScalar(D);
    }

    // Clamped target in world space
    const clampedTarget = _v3B.copy(shoulderPos).add(targetDir);

    /* ----- Step 4: Elbow interior angle via Law of Cosines -------- */
    const cosElbow = AnalyticalIKSolver.clamp(
      (L1 * L1 + L2 * L2 - D * D) / (2.0 * L1 * L2),
      -1.0,
      1.0
    );
    const thetaElbow = Math.acos(cosElbow);
    // Actual bend: supplement of the interior triangle angle
    const elbowBendAngle = Math.PI - thetaElbow;

    /* ----- Step 5: Shoulder offset angle via Law of Cosines ------- */
    const cosShoulder = AnalyticalIKSolver.clamp(
      (D * D + L1 * L1 - L2 * L2) / (2.0 * D * L1),
      -1.0,
      1.0
    );
    const thetaShoulder = Math.acos(cosShoulder);

    /* ----- Step 6 & 7: Build shoulder world rotation -------------- */
    const shoulderWorldQuat = this._computeShoulderRotation(
      shoulderPos,
      clampedTarget,
      poleTarget,
      thetaShoulder
    );

    /* ----- Step 8: Build elbow world rotation --------------------- */
    const elbowWorldQuat = this._computeElbowRotation(
      shoulderWorldQuat,
      elbowBendAngle
    );

    /* ----- Step 9: Convert to bone-local space & apply ------------ */
    this._applyLocalRotation(this.upperArm, shoulderWorldQuat);
    
    // Update the parent's world matrix now that it has moved,
    // otherwise the lowerArm local-space inversion will use stale geometry data!
    this.upperArm.updateWorldMatrix(true, false);
    
    this._applyLocalRotation(this.lowerArm, elbowWorldQuat);

    /* ----- Step 10: Optional palm orientation ---------------------- */
    if (palmOrientation) {
      this._applyPalmOrientation(palmOrientation, elbowWorldQuat);
    }
  }

  /* -------------------------------------------------------------- */
  /*  Private helpers                                                */
  /* -------------------------------------------------------------- */

  /**
   * Measure and cache the bone segment lengths from the skeleton's
   * current world-space poses. Called once and cached.
   *
   * @private
   */
  _measureBoneLengths() {
    // Snapshot rest-pose local quaternions before any IK mutation
    this._upperArmRestLocal = this.upperArm.quaternion.clone();
    this._lowerArmRestLocal = this.lowerArm.quaternion.clone();

    const pShoulder = this._getBoneWorldPosition(this.upperArm);
    const pElbow = this._getBoneWorldPosition(this.lowerArm);
    const pWrist = this._getBoneWorldPosition(this.hand);

    this._L1 = pShoulder.distanceTo(pElbow);
    this._L2 = pElbow.distanceTo(pWrist);

    if (this._L1 < 1e-6 || this._L2 < 1e-6) {
      throw new Error(
        `AnalyticalIKSolver: Degenerate bone lengths (L1=${this._L1}, L2=${this._L2}). ` +
        'Ensure the skeleton is properly bound and has non-zero segment lengths.'
      );
    }
  }

  /**
   * Compute the shoulder's world-space quaternion that:
   *   1. Points the upper arm toward the target (aiming).
   *   2. Offsets by θ_S to account for the triangle geometry.
   *   3. Twists around the aim axis so the elbow points toward the pole target.
   *
   * @param {THREE.Vector3} shoulderPos   - World position of shoulder joint.
   * @param {THREE.Vector3} targetPos     - Clamped world target position.
   * @param {THREE.Vector3} poleTarget    - World-space pole target.
   * @param {number}        thetaShoulder - Shoulder offset angle (radians).
   * @returns {THREE.Quaternion} The computed world-space shoulder quaternion.
   * @private
   */
  _computeShoulderRotation(shoulderPos, targetPos, poleTarget, thetaShoulder) {
    // --- Direction from shoulder to target (normalised)
    const aimDir = _v3C.copy(targetPos).sub(shoulderPos).normalize();

    // --- Determine the initial bone direction in world space.
    //     We use the rest-pose world quaternion of the upper arm to find
    //     its natural forward axis. By convention in most humanoid rigs
    //     the bone points along its local +Y axis (toward the child).
    const shoulderWorldQ = this._getBoneWorldQuaternion(this.upperArm);

    // The rest direction of the upper arm in world space
    const restDir = _v3D.set(0, 1, 0).applyQuaternion(shoulderWorldQ).normalize();

    // --- Quaternion that rotates restDir → aimDir
    const aimQuat = _q1.setFromUnitVectors(restDir, aimDir);
    const baseQuat = _q2.copy(aimQuat).multiply(shoulderWorldQ);

    // --- Apply shoulder offset angle (θ_S) around an axis perpendicular
    //     to the aim direction, lying in the shoulder–elbow–target plane.
    //     We pick an arbitrary perpendicular axis and then correct via pole.
    const worldUp = _v3E.set(0, 1, 0);
    let bendAxis = _v3C.crossVectors(aimDir, worldUp);
    if (bendAxis.lengthSq() < 1e-8) {
      // aimDir is nearly parallel to world-up; fall back to world-X
      bendAxis.set(1, 0, 0);
    }
    bendAxis.normalize();

    const shoulderOffsetQ = _q3.setFromAxisAngle(bendAxis, thetaShoulder);
    const shoulderQuat = _q4.copy(shoulderOffsetQ).multiply(baseQuat);

    // --- Pole-vector twist -----------------------------------------
    //     Project both the current elbow position (as implied by the
    //     un-twisted shoulder rotation) and the pole target onto the
    //     plane perpendicular to aimDir, then twist around aimDir to
    //     align them.

    // Predicted elbow position without twist
    const predictedElbowDir = _v3D
      .set(0, 1, 0)
      .applyQuaternion(shoulderQuat)
      .normalize()
      .multiplyScalar(this._L1);
    const predictedElbow = _v3E.copy(shoulderPos).add(predictedElbowDir);

    // Project predicted elbow onto the plane ⊥ aimDir through shoulderPos
    const projElbow = this._projectOntoPlane(predictedElbow, shoulderPos, aimDir);
    const projPole = this._projectOntoPlane(poleTarget, shoulderPos, aimDir);

    const fromVec = _v3C.copy(projElbow).sub(shoulderPos).normalize();
    const toVec = _v3D.copy(projPole).sub(shoulderPos).normalize();

    // Guard: if either projection collapses, skip twist
    if (fromVec.lengthSq() > 1e-8 && toVec.lengthSq() > 1e-8) {
      // Signed angle around aimDir
      let twistAngle = Math.acos(
        AnalyticalIKSolver.clamp(fromVec.dot(toVec), -1.0, 1.0)
      );
      const cross = _v3E.crossVectors(fromVec, toVec);
      if (cross.dot(aimDir) < 0) {
        twistAngle = -twistAngle;
      }

      const twistQuat = _q1.setFromAxisAngle(aimDir, twistAngle);
      shoulderQuat.premultiply(twistQuat);
    }

    return shoulderQuat.clone();
  }

  /**
   * Compute the elbow's world-space quaternion.
   *
   * The elbow inherits the shoulder's world rotation and then bends
   * around its local X axis (the typical bend axis for humanoid elbows).
   *
   * @param {THREE.Quaternion} shoulderWorldQuat - Resolved shoulder world rotation.
   * @param {number}           bendAngle         - Elbow bend angle in radians.
   * @returns {THREE.Quaternion} The computed world-space elbow quaternion.
   * @private
   */
  _computeElbowRotation(shoulderWorldQuat, bendAngle) {
    // The elbow's world rotation starts as the shoulder rotation
    // (since the forearm inherits the upper arm's orientation) plus
    // the rest-pose local rotation of the elbow bone.
    const elbowRestLocal = this._lowerArmRestLocal || new THREE.Quaternion();

    // Parent world quat for elbow = shoulder world quat
    // Child world quat (before bend) = parent * restLocal
    const elbowWorldBase = _q1.copy(shoulderWorldQuat).multiply(elbowRestLocal);

    // Bend around local X axis (negative for typical humanoid elbow flexion)
    const bendQuat = _q2.setFromAxisAngle(
      _v3A.set(1, 0, 0),
      -bendAngle
    );

    // Apply bend in local space: worldBase * bend
    const elbowWorldQuat = _q3.copy(elbowWorldBase).multiply(bendQuat);

    return elbowWorldQuat.clone();
  }

  /**
   * Convert a computed world-space quaternion to bone-local space and
   * assign it to the bone's `.quaternion` property.
   *
   * ```
   * localQuat = parentWorldQuat.inverse() * computedWorldQuat
   * ```
   *
   * @param {THREE.Bone}       bone      - Target bone.
   * @param {THREE.Quaternion} worldQuat - Desired world-space rotation.
   * @private
   */
  _applyLocalRotation(bone, worldQuat) {
    const parent = bone.parent;
    if (parent) {
      const parentWorldQuat = this._getBoneWorldQuaternion(parent);
      const parentInverse = _q1.copy(parentWorldQuat).invert();
      bone.quaternion.copy(parentInverse).multiply(worldQuat);
    } else {
      // No parent → world == local
      bone.quaternion.copy(worldQuat);
    }
  }

  /**
   * Apply an optional palm orientation to the hand bone.
   *
   * ```
   * handLocalQuat = elbowWorldQuat.inverse() * palmOrientation
   * ```
   *
   * @param {THREE.Quaternion} palmOrientation - Desired world-space palm rotation.
   * @param {THREE.Quaternion} elbowWorldQuat  - Current elbow world quaternion.
   * @private
   */
  _applyPalmOrientation(palmOrientation, elbowWorldQuat) {
    const elbowInv = _q1.copy(elbowWorldQuat).invert();
    this.hand.quaternion.copy(elbowInv).multiply(palmOrientation);
  }

  /**
   * Project a point onto the plane perpendicular to `normal` that passes
   * through `planePoint`.
   *
   * @param {THREE.Vector3} point      - The point to project.
   * @param {THREE.Vector3} planePoint - A point on the plane.
   * @param {THREE.Vector3} normal     - Unit normal of the plane.
   * @returns {THREE.Vector3} Projected point (new vector).
   * @private
   */
  _projectOntoPlane(point, planePoint, normal) {
    const v = _v3A.copy(point).sub(planePoint);
    const dist = v.dot(normal);
    return new THREE.Vector3().copy(point).sub(
      _v3B.copy(normal).multiplyScalar(dist)
    );
  }

  /* -------------------------------------------------------------- */
  /*  Bone-world-transform helpers                                   */
  /* -------------------------------------------------------------- */

  /**
   * Get the world-space position of a bone.
   *
   * Ensures the bone's world matrix is up-to-date before extracting
   * the position component.
   *
   * @param {THREE.Bone} bone - The bone to query.
   * @returns {THREE.Vector3} World-space position (newly allocated).
   */
  _getBoneWorldPosition(bone) {
    bone.updateWorldMatrix(true, false);
    const pos = new THREE.Vector3();
    pos.setFromMatrixPosition(bone.matrixWorld);
    return pos;
  }

  /**
   * Get the world-space quaternion of a bone.
   *
   * Ensures the bone's world matrix is up-to-date before decomposing
   * the rotation component.
   *
   * @param {THREE.Bone} bone - The bone to query.
   * @returns {THREE.Quaternion} World-space rotation (newly allocated).
   */
  _getBoneWorldQuaternion(bone) {
    bone.updateWorldMatrix(true, false);
    const quat = new THREE.Quaternion();
    bone.matrixWorld.decompose(
      _v3A, // position (discarded)
      quat,
      _v3B  // scale (discarded)
    );
    return quat;
  }

  /* -------------------------------------------------------------- */
  /*  Static utilities                                               */
  /* -------------------------------------------------------------- */

  /**
   * Clamp a numeric value to the interval `[min, max]`.
   *
   * @param {number} value - The value to clamp.
   * @param {number} min   - Lower bound.
   * @param {number} max   - Upper bound.
   * @returns {number} Clamped result.
   */
  static clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }
}

export { AnalyticalIKSolver };
export default AnalyticalIKSolver;
