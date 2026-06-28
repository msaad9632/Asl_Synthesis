import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { SignAssemblyEngine } from './SignAssemblyEngine.js';
import { AnalyticalIKSolver } from './AnalyticalIKSolver.js';

// ============================================================================
// THREE.JS SCENE CONFIGURATION
// ============================================================================
const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x08090c);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 1.3, 1.8);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.2, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.maxPolarAngle = Math.PI / 2 + 0.1;
controls.minDistance = 0.5;
controls.maxDistance = 10;

// Lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 0.15);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(2, 4, 3);
scene.add(dirLight);

const fillLight = new THREE.DirectionalLight(0x00f0ff, 0.3);
fillLight.position.set(-2, 1, 1);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0xffffff, 0.6);
rimLight.position.set(0, 4, -3);
scene.add(rimLight);

// Floor grid
const grid = new THREE.GridHelper(10, 20, 0x00f0ff, 0x1f2937);
grid.position.y = 0;
scene.add(grid);

// ============================================================================
// BONE/RIG VISUALIZATION (CANONICAL)
// ============================================================================
// Since the robot has no skeleton, we build a visible canonical skeletal rig 
// from scratch using THREE.Bones, cylinders, and spheres, so the user can see 
// the true IK solver and handshape presets execute on a real skeleton!
const skeletonGroup = new THREE.Group();
scene.add(skeletonGroup);

const bones = [];
const boneMarkers = new Map();

function createBone(name, parent = null, length = 0.1, position = [0, 0, 0]) {
  const bone = new THREE.Bone();
  bone.name = name;
  bone.position.fromArray(position);
  if (parent) {
    parent.add(bone);
  }
  bones.push(bone);

  // Add visual joint sphere
  const jointGeo = new THREE.SphereGeometry(0.015, 16, 16);
  const jointMat = new THREE.MeshStandardMaterial({ color: 0x00f0ff, roughness: 0.1, metalness: 0.8 });
  const joint = new THREE.Mesh(jointGeo, jointMat);
  bone.add(joint);

  // Add segment cylinder (only if length > 0)
  if (length > 0) {
    const cylinderGeo = new THREE.CylinderGeometry(0.007, 0.007, length, 8);
    cylinderGeo.translate(0, length / 2, 0); // align cylinder center to bone axis
    const cylinderMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2, metalness: 0.5 });
    const cylinder = new THREE.Mesh(cylinderGeo, cylinderMat);
    
    // Rotate cylinder to point down the Y-axis (or X-axis depending on bone orientation)
    // Here we align to the local child bone direction
    bone.add(cylinder);
    boneMarkers.set(name, cylinder);
  }

  return bone;
}

// Build Canonical Hierarchy (Z-up in Blender converted to Y-up in Three.js)
const root = createBone('Root', null, 0, [0, 0, 0]);
const hips = createBone('Hips', root, 0.2, [0, 0.8, 0]);
const spine = createBone('Spine', hips, 0.15, [0, 0.2, 0]);
const spine1 = createBone('Spine1', spine, 0.15, [0, 0.15, 0]);
const spine2 = createBone('Spine2', spine1, 0.1, [0, 0.15, 0]);
const neck = createBone('Neck', spine2, 0.08, [0, 0.1, 0]);
const head = createBone('Head', neck, 0, [0, 0.08, 0]);

// Left arm chain
const leftShoulder = createBone('LeftShoulder', spine2, 0.05, [-0.05, 0.08, 0]);
const leftUpperArm = createBone('LeftUpperArm', leftShoulder, 0.25, [-0.1, 0, 0]);
const leftForeArm = createBone('LeftForeArm', leftUpperArm, 0.23, [0, 0.25, 0]); // Point down +Y
const leftHand = createBone('LeftHand', leftForeArm, 0, [0, 0.23, 0]);

// Right arm chain
const rightShoulder = createBone('RightShoulder', spine2, 0.05, [0.05, 0.08, 0]);
const rightUpperArm = createBone('RightUpperArm', rightShoulder, 0.25, [0.1, 0, 0]);
const rightForeArm = createBone('RightForeArm', rightUpperArm, 0.23, [0, 0.25, 0]); // Point down +Y
const rightHand = createBone('RightHand', rightForeArm, 0, [0, 0.23, 0]);

// Align visual cylinders to point towards their children
boneMarkers.get('LeftShoulder')?.rotation.set(0, 0, Math.PI / 2);
boneMarkers.get('LeftUpperArm')?.rotation.set(0, 0, 0); 
boneMarkers.get('LeftForeArm')?.rotation.set(0, 0, 0);  
boneMarkers.get('RightShoulder')?.rotation.set(0, 0, -Math.PI / 2);
boneMarkers.get('RightUpperArm')?.rotation.set(0, 0, 0);
boneMarkers.get('RightForeArm')?.rotation.set(0, 0, 0);

// Add finger bones (with small joint segments)
const sides = ['Left', 'Right'];
const fingerNames = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];
const jointSuffixes = ['_Proximal', '_Intermediate', '_Distal']; // Match JSON spec

for (const side of sides) {
  const hand = side === 'Left' ? leftHand : rightHand;
  for (const finger of fingerNames) {
    let parent = hand;
    // Create the three joints per finger pointing along local +Y axis
    parent = createBone(`${side}Hand${finger}${jointSuffixes[0]}`, parent, 0.025, [0, 0.02, 0]);
    parent = createBone(`${side}Hand${finger}${jointSuffixes[1]}`, parent, 0.02, [0, 0.025, 0]);
    parent = createBone(`${side}Hand${finger}${jointSuffixes[2]}`, parent, 0.015, [0, 0.02, 0]);
  }
}

skeletonGroup.add(bones[0]); // add root bone
const skeleton = new THREE.Skeleton(bones);
const geom = new THREE.BoxGeometry(0.01, 0.01, 0.01);
const mat = new THREE.MeshBasicMaterial({ visible: false });
const mockSkinnedMesh = new THREE.SkinnedMesh(geom, mat);
mockSkinnedMesh.frustumCulled = false;
mockSkinnedMesh.bind(skeleton);

// Debug Target Visualizers (spheres showing where the wrist targets are)
const rightTargetVisualizer = new THREE.Mesh(
  new THREE.SphereGeometry(0.02, 16, 16),
  new THREE.MeshBasicMaterial({ color: 0xff0055, wireframe: true })
);
scene.add(rightTargetVisualizer);

const leftTargetVisualizer = new THREE.Mesh(
  new THREE.SphereGeometry(0.02, 16, 16),
  new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: true })
);
scene.add(leftTargetVisualizer);

// ============================================================================
// ROBOT AVATAR LOADER
// ============================================================================
const robotGroup = new THREE.Group();
robotGroup.visible = false;
scene.add(robotGroup);

let robotLoaded = false;
const loader = new GLTFLoader();

// Keep track of robot object groups to animate them directly
let robotLeftUpper = null;
let robotLeftLower = null;
let robotRightUpper = null;
let robotRightLower = null;

// Cache the original GLB rest orientations
let robotLeftUpperRest = null;
let robotLeftLowerRest = null;
let robotRightUpperRest = null;
let robotRightLowerRest = null;

loader.load('./readyplayer.me.glb', (gltf) => {
  const model = gltf.scene;
  
  // The Ready Player Me avatar is already in meters (scale 1.0)
  model.scale.set(1, 1, 1);
  model.position.set(0, 0, 0);
  
  // Traverse and adjust materials
  model.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
      // Make metallic surfaces shiny
      if (child.material) {
        child.material.roughness = 0.3;
        child.material.metalness = 0.8;
      }
    }
  });

  robotGroup.add(model);
  robotLoaded = true;

  // Cache animatable joints (Ready Player Me uses standard humanoid bone names)
  robotLeftUpper = model.getObjectByName('LeftArm');
  robotLeftLower = model.getObjectByName('LeftForeArm');
  robotRightUpper = model.getObjectByName('RightArm');
  robotRightLower = model.getObjectByName('RightForeArm');

  // Cache their original rest quaternions directly from the imported GLB!
  if (robotLeftUpper) robotLeftUpperRest = robotLeftUpper.quaternion.clone();
  if (robotLeftLower) robotLeftLowerRest = robotLeftLower.quaternion.clone();
  if (robotRightUpper) robotRightUpperRest = robotRightUpper.quaternion.clone();
  if (robotRightLower) robotRightLowerRest = robotRightLower.quaternion.clone();

  console.log("Ready Player Me model loaded successfully!");
}, undefined, (error) => {
  console.error("Failed to load readyplayer.me.glb:", error);
});

// ============================================================================
// LOAD ASL SCHEMAS & PRESETS
// ============================================================================
let assemblyEngine = null;

// CUP sign definition
const signCup = {
  id: "CUP",
  timing: { totalDuration: 1.0, easing: "easeSineInOut" },
  dominant: {
    anchor: { bone: "Head", offset: [0.0, -0.15, 0.18] },
    trajectory: {
      type: "linear",
      startOffset: [0.15, 0.2, 0.25],
      endOffset: [0.12, 0.0, 0.15],
      easing: "easeSineInOut"
    },
    handshapes: [
      { time: 0.0, shape: "CUP_HAND" },
      { time: 1.0, shape: "CUP_HAND" }
    ],
    palmOrientation: { quaternion: [0.0, 0.707, 0.0, 0.707] }
  },
  nonDominant: null
};

// TEA sign definition
const signTea = {
  id: "TEA",
  timing: { totalDuration: 1.2, easing: "easeSineInOut" },
  dominant: {
    anchor: { bone: "Spine1", offset: [0.0, 0.15, 0.22] },
    trajectory: {
      type: "oscillatory",
      config: {
        basePosition: { bone: "Spine1", offset: [0.08, 0.15, 0.22] },
        amplitude: 0.04,
        axis: [0.0, -1.0, 0.0],
        frequency: 3.0,
        decayRate: 0.5
      }
    },
    handshapes: [
      { time: 0.0, shape: "PINCH" },
      { time: 1.0, shape: "PINCH" }
    ],
    palmOrientation: { quaternion: [0.707, 0.0, 0.0, 0.707] }
  },
  nonDominant: {
    anchor: { bone: "Spine1", offset: [0.0, 0.12, 0.20] },
    trajectory: {
      type: "linear",
      startOffset: [-0.08, 0.12, 0.20],
      endOffset: [-0.08, 0.12, 0.20],
      easing: "linear"
    },
    handshapes: [
      { time: 0.0, shape: "C_SHAPE" },
      { time: 1.0, shape: "C_SHAPE" }
    ],
    palmOrientation: { quaternion: [0.0, 0.707, 0.0, 0.707] }
  }
};

// COFFEE sign definition
const signCoffee = {
  id: "COFFEE",
  timing: { totalDuration: 1.5, easing: "linear" },
  dominant: {
    anchor: { bone: "Spine1", offset: [0.08, 0.15, 0.25] },
    trajectory: {
      type: "arc",
      config: {
        center: { bone: "Spine1", offset: [0.0, 0.15, 0.25] },
        radius: 0.06,
        startAngle: 0,
        endAngle: Math.PI * 4, // 2 full grinding circles
        planeNormal: [0, 1, 0], // Horizontal plane
        easing: "linear"
      }
    },
    handshapes: [
      { time: 0.0, shape: "FIST" },
      { time: 1.0, shape: "FIST" }
    ],
    palmOrientation: { quaternion: [0, 0.707, 0, 0.707] }
  },
  nonDominant: {
    anchor: { bone: "Spine1", offset: [0.0, 0.08, 0.25] },
    trajectory: {
      type: "linear",
      startOffset: [0, 0, 0],
      endOffset: [0, 0, 0],
      easing: "linear"
    },
    handshapes: [
      { time: 0.0, shape: "FIST" },
      { time: 1.0, shape: "FIST" }
    ],
    palmOrientation: { quaternion: [0, 0.707, 0, -0.707] }
  }
};

const signMap = { CUP: signCup, TEA: signTea, COFFEE: signCoffee };
let currentSignId = "CUP";

fetch('./handshapePresets.json')
  .then(res => res.json())
  .then(presets => {
    assemblyEngine = new SignAssemblyEngine(mockSkinnedMesh, presets);
    assemblyEngine.initialize();
    assemblyEngine.loadSignDefinition(signCup);
    updateSchemaDisplay();
  });

// ============================================================================
// PLAYBACK CONTROL ENGINE
// ============================================================================
let isPlaying = true;
let animProgress = 0.0;
let totalDuration = 1.0;
const clock = new THREE.Clock();

const playPauseBtn = document.getElementById('btn-play-pause');
const timeScrubber = document.getElementById('time-scrubber');
const scrubberDisplay = document.getElementById('scrubber-display');

playPauseBtn.addEventListener('click', () => {
  isPlaying = !isPlaying;
  playPauseBtn.textContent = isPlaying ? '⏸' : '▶';
});

timeScrubber.addEventListener('input', (e) => {
  animProgress = parseFloat(e.target.value);
  isPlaying = false;
  playPauseBtn.textContent = '▶';
});

// UI Inputs
const btnGroup = document.querySelectorAll('.sign-btn-group button');
btnGroup.forEach(btn => {
  btn.addEventListener('click', (e) => {
    const target = e.currentTarget;
    btnGroup.forEach(b => b.classList.remove('active'));
    target.classList.add('active');
    
    currentSignId = target.dataset.sign;
    const signDef = signMap[currentSignId];
    
    totalDuration = signDef.timing.totalDuration;
    document.getElementById('param-duration').value = totalDuration;
    document.getElementById('val-duration').textContent = `${totalDuration.toFixed(1)}s`;
    
    // Toggle oscillatory params display
    const dominantTraj = signDef.dominant.trajectory;
    if (dominantTraj.type === 'oscillatory') {
      document.getElementById('param-oscillation-group').style.display = 'flex';
      const config = dominantTraj.config;
      document.getElementById('param-amplitude').value = config.amplitude;
      document.getElementById('val-amplitude').textContent = `${config.amplitude.toFixed(2)}m`;
      document.getElementById('param-frequency').value = config.frequency;
      document.getElementById('val-frequency').textContent = `${config.frequency.toFixed(1)}Hz`;
    } else {
      document.getElementById('param-oscillation-group').style.display = 'none';
    }

    if (assemblyEngine) {
      assemblyEngine.loadSignDefinition(signDef);
    }
    
    updateSchemaDisplay();
    animProgress = 0.0;
  });
});

// Parameter modification listeners
document.getElementById('param-duration').addEventListener('input', (e) => {
  const val = parseFloat(e.target.value);
  document.getElementById('val-duration').textContent = `${val.toFixed(1)}s`;
  totalDuration = val;
  signMap[currentSignId].timing.totalDuration = val;
  if (assemblyEngine) {
    assemblyEngine.loadSignDefinition(signMap[currentSignId]);
  }
  updateSchemaDisplay();
});

document.getElementById('param-amplitude').addEventListener('input', (e) => {
  const val = parseFloat(e.target.value);
  document.getElementById('val-amplitude').textContent = `${val.toFixed(2)}m`;
  const signDef = signMap[currentSignId];
  if (signDef.dominant.trajectory.config) {
    signDef.dominant.trajectory.config.amplitude = val;
    if (assemblyEngine) {
      assemblyEngine.loadSignDefinition(signDef);
    }
    updateSchemaDisplay();
  }
});

document.getElementById('param-frequency').addEventListener('input', (e) => {
  const val = parseFloat(e.target.value);
  document.getElementById('val-frequency').textContent = `${val.toFixed(1)}Hz`;
  const signDef = signMap[currentSignId];
  if (signDef.dominant.trajectory.config) {
    signDef.dominant.trajectory.config.frequency = val;
    if (assemblyEngine) {
      assemblyEngine.loadSignDefinition(signDef);
    }
    updateSchemaDisplay();
  }
});

// Panel Views toggles
const toggleCanonical = document.getElementById('toggle-canonical');
const toggleRobot = document.getElementById('toggle-robot');

toggleCanonical.addEventListener('click', () => {
  toggleCanonical.classList.add('active');
  toggleRobot.classList.remove('active');
  skeletonGroup.visible = true;
  rightTargetVisualizer.visible = true;
  leftTargetVisualizer.visible = true;
  robotGroup.visible = false;
});

toggleRobot.addEventListener('click', () => {
  if (!robotLoaded) {
    alert("Robot model is still loading. Please wait a moment.");
    return;
  }
  toggleRobot.classList.add('active');
  toggleCanonical.classList.remove('active');
  skeletonGroup.visible = false;
  rightTargetVisualizer.visible = false;
  leftTargetVisualizer.visible = false;
  robotGroup.visible = true;
});

function updateSchemaDisplay() {
  const pre = document.getElementById('schema-display');
  pre.textContent = JSON.stringify(signMap[currentSignId], null, 2);
}

// ============================================================================
// ROBOT MANUAL PROCEDURAL ANIMATOR
// ============================================================================
// If the robot is loaded and active, we translate/rotate its empties directly 
// based on the active sign's trajectories since the robot has no skeleton bones
function syncRobotToProceduralSkeleton() {
  if (!robotLoaded) return;

  // The procedural skeleton generates exact local-space delta rotations (because its rest pose is identity).
  // To apply them to the visual meshes without shattering the geometry, we must PRE-MULTIPLY 
  // the visual mesh's original rest pose by the procedural delta.

  if (robotLeftUpper && robotLeftUpperRest) {
    robotLeftUpper.quaternion.copy(leftUpperArm.quaternion).multiply(robotLeftUpperRest);
  }
  if (robotLeftLower && robotLeftLowerRest) {
    robotLeftLower.quaternion.copy(leftForeArm.quaternion).multiply(robotLeftLowerRest);
  }
  
  if (robotRightUpper && robotRightUpperRest) {
    robotRightUpper.quaternion.copy(rightUpperArm.quaternion).multiply(robotRightUpperRest);
  }
  if (robotRightLower && robotRightLowerRest) {
    robotRightLower.quaternion.copy(rightForeArm.quaternion).multiply(robotRightLowerRest);
  }
}

// ============================================================================
// ANIMATION FRAME UPDATE LOOP
// ============================================================================
function update() {
  const delta = clock.getDelta();

  if (isPlaying) {
    animProgress += delta / totalDuration;
    if (animProgress > 1.0) {
      animProgress = 0.0; // loop sign animation
    }
    timeScrubber.value = animProgress;
  }

  // Scrubber label display
  scrubberDisplay.textContent = `${(animProgress * totalDuration).toFixed(2)} / ${totalDuration.toFixed(1)}s`;

  // 1. Update Skeletal Rig via SignAssemblyEngine
  if (assemblyEngine && skeletonGroup.visible) {
    assemblyEngine.executeFrame(animProgress);

    // Update target debug visualizers
    const dominantPlan = assemblyEngine._executionPlan?.dominant;
    if (dominantPlan) {
      const wristTarget = dominantPlan.trajectory.evaluate(animProgress).add(dominantPlan.anchorWorldPos);
      rightTargetVisualizer.position.copy(wristTarget);
    }

    const nonDominantPlan = assemblyEngine._executionPlan?.nonDominant;
    if (nonDominantPlan) {
      const wristTarget = nonDominantPlan.trajectory.evaluate(animProgress).add(nonDominantPlan.anchorWorldPos);
      leftTargetVisualizer.position.copy(wristTarget);
    }

    // Capture rot feedback for right upper arm and elbow
    const shoulderQ = rightUpperArm.quaternion;
    const elbowQ = rightForeArm.quaternion;
    
    // Euler angles converted to degrees
    const shEuler = new THREE.Euler().setFromQuaternion(shoulderQ);
    const elEuler = new THREE.Euler().setFromQuaternion(elbowQ);

    document.getElementById('stat-shoulder-rot').textContent = `${(shEuler.x * (180 / Math.PI)).toFixed(1)}°`;
    document.getElementById('stat-elbow-rot').textContent = `${(elEuler.x * (180 / Math.PI)).toFixed(1)}°`;
    
    const wristPos = new THREE.Vector3();
    rightHand.getWorldPosition(wristPos);
    document.getElementById('stat-wrist-pos').textContent = 
      `${wristPos.x.toFixed(2)}, ${wristPos.y.toFixed(2)}, ${wristPos.z.toFixed(2)}`;
  }

  // 2. Update Robot Group joint transforms
  if (robotGroup.visible && robotLoaded) {
    syncRobotToProceduralSkeleton();
  }

  controls.update();
}

function render() {
  renderer.render(scene, camera);
}

function animateLoop() {
  requestAnimationFrame(animateLoop);
  update();
  render();
}

animateLoop();

// Handle responsive resizing
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
