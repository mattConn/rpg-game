/**
 * Every model in the game, built from primitives at load time — there are no
 * asset files. Low-poly means what it says: flat shading and the coarsest
 * geometry that still reads (a 6-sided torso, a 20-face icosahedron for a
 * head), so the silhouette does the work.
 *
 * **Models are built facing +X**, which is the 2D game's `facing: 1` ("right").
 * Everything that turns a model uses `yawFor` from `world.ts`, so facing stays
 * the one convention it is in the 2D client.
 *
 * Limbs hang from pivot groups placed at the hip/shoulder and swing about **Z**
 * — for a body facing +X, that is the forward/back plane.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";

// ------------------------------------------------------------------ palette

const SKIN = 0x4f86c6;
const HAIR = 0x3b2a1c;
/** The tunic the player wears. */
export const TUNIC = 0x8a5a2b;
const TUNIC_DARK = 0x6d4622;
const BELT = 0x46301a;
const TROUSERS = 0x4a4038;
const BOOT = 0x33261a;
const STEEL = 0xc8ccd4;
const STEEL_DARK = 0x8a9099;
const WOOD = 0x5a3f24;

/** Lighter than the floor on purpose — a charcoal wolf on grey stone vanishes. */
const WOLF_FUR = 0x6c6572;
const WOLF_FUR_DARK = 0x4c4653;
const WOLF_BELLY = 0x8c8592;

const STONE = 0x6a6a72;

/**
 * How much the wolf is scaled down from life-size. Exported because anything
 * repositioning its parts — a corpse rolling onto its side, say — has to work
 * in the same scaled units.
 */
export const WOLF_SCALE = 1.4;

let adventurerTexture: THREE.Texture | null = null;

function adventurerMat(tint: THREE.ColorRepresentation): THREE.MeshLambertMaterial {
  if (!adventurerTexture) {
    adventurerTexture = new THREE.TextureLoader().load("/shared-textures/adventurer-brown.png");
    adventurerTexture.colorSpace = THREE.SRGBColorSpace;
    adventurerTexture.wrapS = THREE.RepeatWrapping;
    adventurerTexture.wrapT = THREE.RepeatWrapping;
    adventurerTexture.magFilter = THREE.LinearFilter;
    adventurerTexture.minFilter = THREE.LinearMipmapLinearFilter;
  }
  return new THREE.MeshLambertMaterial({ map: adventurerTexture, color: tint });
}

// ------------------------------------------------------------------ helpers

/** Flat-shaded matte material — the whole look of the game in one line. */
export function flatMat(color: THREE.ColorRepresentation): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color, flatShading: true });
}

function mesh(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function box(w: number, h: number, d: number, color: THREE.ColorRepresentation): THREE.Mesh {
  return mesh(new THREE.BoxGeometry(w, h, d), flatMat(color));
}

function at<T extends THREE.Object3D>(object: T, x: number, y: number, z: number): T {
  object.position.set(x, y, z);
  return object;
}

/** Release everything a discarded rig holds — geometries and materials both. */
export function disposeObject(root: THREE.Object3D): void {
  root.traverse((child) => {
    const m = child as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    const material = m.material;
    if (Array.isArray(material)) material.forEach((mat) => mat.dispose());
    else material.dispose();
  });
}

/** Tint every material in a rig — used to dim a body without a second palette. */
export function tintObject(root: THREE.Object3D, mix: THREE.Color, amount: number): void {
  root.traverse((child) => {
    const m = child as THREE.Mesh;
    if (!m.isMesh) return;
    const materials = Array.isArray(m.material) ? m.material : [m.material];
    for (const material of materials) {
      const coloured = material as THREE.MeshLambertMaterial;
      if (coloured.color) coloured.color.lerp(mix, amount);
    }
  });
}

// ------------------------------------------------------------------ weapons

/**
 * A blade hanging point-down out of a fist, so it simply continues the line of
 * the arm — the swing animation then comes free from rotating the shoulder.
 */
function buildBlade(length: number, width: number): THREE.Group {
  const group = new THREE.Group();

  const shape = new THREE.Shape();
  shape.moveTo(-width / 2, -0.1);
  shape.lineTo(-width * 0.48, -length * 0.73 - 0.1);
  shape.lineTo(-width * 0.32, -length * 0.92 - 0.1);
  shape.lineTo(0, -length - 0.1);
  shape.lineTo(width * 0.32, -length * 0.92 - 0.1);
  shape.lineTo(width * 0.48, -length * 0.73 - 0.1);
  shape.lineTo(width / 2, -0.1);
  shape.closePath();
  const bladeGeometry = new THREE.ExtrudeGeometry(shape, {
    depth: width * 0.28,
    bevelEnabled: true,
    bevelSize: width * 0.08,
    bevelThickness: width * 0.06,
    bevelSegments: 1,
  });
  bladeGeometry.translate(0, 0, -width * 0.14);
  const blade = mesh(bladeGeometry, flatMat(STEEL));
  group.add(blade);

  const fuller = box(width * 0.16, length * 0.72, width * 0.32, STEEL_DARK);
  group.add(at(fuller, 0, -length * 0.43, 0));
  group.add(at(box(width * 0.42, 0.055, width * 4.2, 0x765b32), 0, -0.075, 0));
  const grip = mesh(new THREE.CylinderGeometry(0.04, 0.045, 0.22, 8), flatMat(WOOD));
  group.add(at(grip, 0, 0.055, 0));
  group.add(at(mesh(new THREE.SphereGeometry(0.055, 7, 5), flatMat(0x765b32)), 0, 0.18, 0));

  return group;
}

let importedSwordScene: Promise<THREE.Group> | null = null;

/** Replace the player's fallback blade with the credited medieval sword asset. */
function installImportedSword(sword: THREE.Group): void {
  importedSwordScene ??= new Promise((resolve, reject) => {
    new GLTFLoader().load("/shared-models/sword/scene.gltf", (gltf) => resolve(gltf.scene), undefined, reject);
  });
  importedSwordScene.then((source) => {
    sword.traverse((node) => {
      if (node instanceof THREE.Mesh) node.visible = false;
    });
    const visual = source.clone(true);
    visual.scale.setScalar(0.5);
    // The asset runs from blade tip at -X to pommel at +X. The mouth mount is
    // itself quarter-turned, so rotating the sword into its local Y axis puts
    // the blade horizontally across the jaws after the parent transform.
    // The source blade already runs along its local X axis.  Turn that axis
    // into the imported wolf head's forward (+Z) axis so it lies sideways in
    // the mouth instead of standing vertically through the face.
    visual.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    // Its grip is around source X=0.7. Cancel that offset at half scale, then
    // tuck the complete weapon slightly back into the mouth.
    visual.position.set(-0.32, 0.32, 0.28);
    visual.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        node.castShadow = true;
        node.receiveShadow = true;
      }
    });
    sword.add(visual);
  }).catch((error: unknown) => console.warn("Could not load imported sword model", error));
}

let importedDaggerScene: Promise<THREE.Group> | null = null;

/** Install the steel dagger with its grip at the owning group's origin. */
function installImportedDagger(dagger: THREE.Group, usage: "mouth" | "thrown"): void {
  importedDaggerScene ??= new Promise((resolve, reject) => {
    new GLTFLoader().load("/shared-models/dagger/scene.gltf", (gltf) => resolve(gltf.scene), undefined, reject);
  });
  importedDaggerScene.then((source) => {
    dagger.traverse((node) => {
      if (node instanceof THREE.Mesh) node.visible = false;
    });
    const visual = source.clone(true);
    // FBX export units leave this asset roughly 1,300 units long. At 0.00035 it
    // becomes a compact dagger, with the grip around +Z after
    // the glTF root transforms have been applied.
    visual.scale.setScalar(0.00035);
    if (usage === "mouth") {
      visual.rotation.x = -Math.PI / 2;
      visual.position.set(-0.32, -0.09, 0.08);
    } else {
      visual.rotation.y = -Math.PI / 2;
      visual.position.x = 0.158;
    }
    visual.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        node.castShadow = true;
        node.receiveShadow = true;
      }
    });
    dagger.add(visual);
  }).catch((error: unknown) => console.warn("Could not load imported dagger model", error));
}

let importedCrownScene: Promise<THREE.Group> | null = null;

/** Fit the credited crown between the player wolf's ears and make it gold. */
function installImportedCrown(head: THREE.Object3D): void {
  importedCrownScene ??= new Promise((resolve, reject) => {
    new GLTFLoader().load("/shared-models/crown/scene.gltf", (gltf) => resolve(gltf.scene), undefined, reject);
  });
  importedCrownScene.then((source) => {
    const crown = source.clone(true);
    crown.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      node.castShadow = true;
      node.receiveShadow = true;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      const gold = materials.map(() => new THREE.MeshStandardMaterial({
        color: 0xd6a928,
        metalness: 0.88,
        roughness: 0.26,
      }));
      node.material = Array.isArray(node.material) ? gold : gold[0]!;
    });

    // The source's pivot is several metres away from the crown. Re-centre from
    // rendered bounds and normalize its width before mounting it on the skull.
    crown.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(crown);
    const centre = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    crown.position.sub(centre);
    const mount = new THREE.Group();
    mount.scale.setScalar(0.32 / Math.max(size.x, size.z));
    mount.position.set(-0.02, -0.02, 0.015);
    mount.rotation.set(0, 0, 0);
    mount.add(crown);
    head.add(mount);
  }).catch((error: unknown) => console.warn("Could not load imported crown model", error));
}

// ------------------------------------------------------------------ the human

export interface HumanRig {
  /** Feet on y = 0, facing +X. */
  model: THREE.Group;
  legs: THREE.Group[];
  /** [left, right]; the right one carries the weapon. */
  arms: THREE.Group[];
  torso: THREE.Object3D;
  head: THREE.Object3D;
  sword: THREE.Group;
  dagger: THREE.Group;
}

/**
 * A human in a brown tunic: boots, trousers, a belted tunic that flares out at
 * the hem (a 6-sided cone frustum), bare forearms, and a blade in the right
 * hand. Roughly 1.9 units — a touch under two tiles, so a wolf comes up to
 * about hip height.
 */
export function buildHuman(tunicColor: THREE.ColorRepresentation = TUNIC): HumanRig {
  const model = new THREE.Group();

  const legs: THREE.Group[] = [];
  for (const z of [0.15, -0.15]) {
    const hip = at(new THREE.Group(), 0, 0.78, z);
    const thigh = mesh(new THREE.CapsuleGeometry(0.105, 0.28, 4, 10), flatMat(TROUSERS));
    hip.add(at(thigh, 0, -0.2, 0));
    const shin = mesh(new THREE.CapsuleGeometry(0.085, 0.25, 4, 10), flatMat(0x403a36));
    hip.add(at(shin, 0.015, -0.5, 0));
    const boot = mesh(new THREE.SphereGeometry(0.14, 12, 7), adventurerMat(0x59443a));
    boot.scale.set(1.55, 0.62, 0.82);
    hip.add(at(boot, 0.075, -0.69, 0));
    const cuff = mesh(new THREE.CylinderGeometry(0.115, 0.105, 0.13, 10), adventurerMat(0x4c382f));
    hip.add(at(cuff, 0.01, -0.57, 0));
    model.add(hip);
    legs.push(hip);
  }

  const torso = mesh(new THREE.SphereGeometry(0.43, 14, 9), adventurerMat(0xa77a55));
  torso.scale.set(0.6, 0.92, 0.87);
  torso.position.set(0, 1.3, 0);
  model.add(torso);

  const tunicSkirt = mesh(new THREE.CylinderGeometry(0.34, 0.4, 0.48, 12), adventurerMat(0x9a6d4b));
  tunicSkirt.scale.set(0.68, 1, 0.88);
  model.add(at(tunicSkirt, 0, 0.94, 0));

  const belt = mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.09, 12), flatMat(BELT));
  belt.scale.set(0.7, 1, 0.92);
  belt.rotation.y = Math.PI / 6;
  model.add(at(belt, 0, 0.88, 0));

  const buckle = box(0.045, 0.11, 0.13, 0xb08b4f);
  model.add(at(buckle, 0.275, 0.96, 0));

  const collar = mesh(new THREE.CylinderGeometry(0.23, 0.29, 0.13, 12), flatMat(TUNIC_DARK));
  collar.scale.set(0.72, 1, 0.92);
  collar.rotation.y = Math.PI / 6;
  model.add(at(collar, 0, 1.6, 0));

  const arms: THREE.Group[] = [];
  for (const z of [0.36, -0.36]) {
    const shoulder = at(new THREE.Group(), 0, 1.53, z);
    const sleeve = mesh(new THREE.SphereGeometry(0.15, 12, 7), adventurerMat(0xaa7953));
    sleeve.scale.set(0.85, 1.15, 0.9);
    shoulder.add(at(sleeve, 0, -0.12, 0));
    shoulder.add(at(mesh(new THREE.CapsuleGeometry(0.07, 0.24, 4, 9), flatMat(SKIN)), 0, -0.42, 0));
    const cuff = mesh(new THREE.CylinderGeometry(0.085, 0.095, 0.13, 10), flatMat(0x5d626a));
    shoulder.add(at(cuff, 0, -0.57, 0));
    const gauntlet = mesh(new THREE.SphereGeometry(0.095, 10, 6), flatMat(0x747a83));
    gauntlet.scale.set(0.92, 1.08, 0.9);
    shoulder.add(at(gauntlet, 0, -0.68, 0));
    const knuckles = box(0.055, 0.075, 0.16, 0x8c929b);
    shoulder.add(at(knuckles, 0.065, -0.69, 0));
    model.add(shoulder);
    arms.push(shoulder);
  }

  const head = mesh(new THREE.SphereGeometry(0.23, 14, 9), flatMat(SKIN));
  head.scale.set(0.82, 0.95, 0.82);
  model.add(at(head, 0.02, 1.83, 0));

  // A blunt great helm: one tall, slightly tapered shell enclosing the whole
  // head. The heavy rims and sparse eye openings give it the readable
  // "bucket helm" silhouette without literally resembling modern trashware.
  const helmet = mesh(new THREE.CylinderGeometry(0.255, 0.275, 0.52, 12), flatMat(0x656b74));
  helmet.rotation.y = Math.PI / 12;
  head.add(at(helmet, -0.015, 0.015, 0));
  const upperRim = mesh(new THREE.TorusGeometry(0.255, 0.025, 6, 12), flatMat(0x858c96));
  upperRim.rotation.x = Math.PI / 2;
  head.add(at(upperRim, -0.015, 0.265, 0));
  const lowerRim = mesh(new THREE.TorusGeometry(0.27, 0.026, 6, 12), flatMat(0x50565f));
  lowerRim.rotation.x = Math.PI / 2;
  head.add(at(lowerRim, -0.015, -0.245, 0));
  // The old crown spike now forms the nasal: a short pointed steel projection
  // between the eye holes, with the top of the helmet left blunt and practical.
  const helmetNose = mesh(new THREE.ConeGeometry(0.075, 0.22, 12), flatMat(0x858c96));
  helmetNose.rotation.z = -Math.PI / 2;
  helmetNose.scale.set(0.72, 1, 0.72);
  head.add(at(helmetNose, 0.34, -0.065, 0));

  // Long blue ears emerge through the helmet sides. Their roots sit inside the
  // shell so they read as part of the wearer rather than ornaments glued on.
  for (const side of [1, -1] as const) {
    const ear = mesh(new THREE.ConeGeometry(0.095, 0.4, 7), flatMat(SKIN));
    ear.rotation.x = side * Math.PI / 2;
    ear.scale.set(0.5, 1, 0.72);
    head.add(at(ear, -0.015, 0.035, side * 0.29));
  }

  const eyeHoleMaterial = new THREE.MeshBasicMaterial({ color: 0x09090b });
  for (const side of [1, -1] as const) {
    const hole = new THREE.Mesh(new THREE.OctahedronGeometry(0.06, 0), eyeHoleMaterial);
    hole.scale.set(0.32, 0.52, 1.25);
    hole.rotation.x = -side * 0.62;
    head.add(at(hole, 0.255, 0.025, side * 0.095));
  }

  const eyeMaterial = new THREE.MeshBasicMaterial({ color: 0x24120e });
  const eye = (side: 1 | -1) => {
    const sternEye = new THREE.Mesh(new THREE.OctahedronGeometry(0.035, 0), eyeMaterial);
    sternEye.scale.set(0.42, 0.42, 1.15);
    sternEye.rotation.x = -side * 0.62;
    return sternEye;
  };
  head.add(at(eye(1), 0.266, 0.025, 0.09));
  head.add(at(eye(-1), 0.266, 0.025, -0.09));

  // Both weapons live in the right fist; only the selected one is visible.
  //
  // The fist is turned a quarter turn, so the blade sits **orthogonal to the
  // arm** rather than continuing its line — that is what makes the overhand
  // swing chop: as the arm comes over the top and reaches forward, the blade is
  // pointing down at what it is hitting.
  const rightArm = arms[1]!;
  rightArm.rotation.x = 0.28; // splayed, so the blade passes outside the hip
  const hand = at(new THREE.Group(), 0, -0.74, 0);
  hand.rotation.z = Math.PI / 2;
  rightArm.add(hand);

  const sword = buildBlade(0.72, 0.09);
  const dagger = buildBlade(0.4, 0.07);
  dagger.visible = false;
  hand.add(sword);
  hand.add(dagger);

  return { model, legs, arms, torso, head, sword, dagger };
}

// ------------------------------------------------------------------ the wolf

export interface WolfRig {
  /** Paws on y = 0, facing +X. */
  model: THREE.Group;
  /** Front-left, front-right, back-left, back-right. */
  legs: THREE.Group[];
  /** Imported model thigh bones, populated asynchronously once its GLTF loads. */
  importedLegs: Array<{
    bone: THREE.Object3D;
    bindQuaternion: THREE.Quaternion;
    lowerBone: THREE.Object3D | null;
    lowerBindQuaternion: THREE.Quaternion | null;
    swing: number;
  }>;
  importedHead: {
    bone: THREE.Bone;
    bindQuaternion: THREE.Quaternion;
  } | null;
  importedJaw: { bone: THREE.Bone; bindQuaternion: THREE.Quaternion } | null;
  importedTail: { bone: THREE.Bone; bindQuaternion: THREE.Quaternion } | null;
  importedSpine: Array<{
    bone: THREE.Bone;
    bindQuaternion: THREE.Quaternion;
    flex: number;
  }>;
  head: THREE.Object3D;
  /** Hinged at the back of the muzzle; opens while hunting and snaps on a lunge. */
  jaw: THREE.Group;
  tail: THREE.Group;
  body: THREE.Object3D;
  neck: THREE.Object3D;
  ears: THREE.Object3D[];
  /** Emissive-looking eyes, brightened while the thing is hunting you. */
  eyeMaterial: THREE.MeshBasicMaterial;
  /**
   * What those eyes are lit *to*. On the rig rather than taken from the accent
   * by the caller, so the model owns its own colour and the animation only has
   * to decide how bright it is.
   */
  eyeColor: THREE.Color;
  mixer: THREE.AnimationMixer | null;
  runAction: THREE.AnimationAction | null;
  sprintAction: THREE.AnimationAction | null;
  aggressiveAction: THREE.AnimationAction | null;
  attackAction: THREE.AnimationAction | null;
  eatAction: THREE.AnimationAction | null;
  idleAction: THREE.AnimationAction | null;
}

/**
 * The hellhound: a wolf. Charcoal fur with the enemy's ember colour kept for
 * the eyes and the throat, so it still reads as the orange `♞` it replaces
 * without turning the whole animal orange.
 */
/** A hellhound's eyes, whatever colour the rest of it is. */
const WOLF_EYE = 0xff2018;
/** How far the eye slants down toward the snout, in radians. */
const EYE_TILT = 0.72;
/**
 * The head block's own size. Named because the eyes are placed *against* it —
 * a diamond is a solid, and any part of one reaching past the cheek pokes out
 * of the side of the head and reads as a second diamond on the wolf's flank.
 */
const HEAD_BLOCK = { x: 0.34, y: 0.3, z: 0.3 };
/** Radius of the eye octahedron before it is scaled into a lozenge. */
const EYE_RADIUS = 0.06;
/** Shallow into the face, short in height, long across it. */
const EYE_SCALE = { x: 0.38, y: 0.3, z: 1.22 };

let wolfFurTexture: THREE.Texture | null = null;

/** Shared 256px painted fur: bilinear filtering is part of the N64-era look. */
function wolfMat(tint: THREE.ColorRepresentation): THREE.MeshLambertMaterial {
  if (!wolfFurTexture) {
    wolfFurTexture = new THREE.TextureLoader().load("/shared-textures/hellhound-fur.png");
    wolfFurTexture.colorSpace = THREE.SRGBColorSpace;
    wolfFurTexture.wrapS = THREE.RepeatWrapping;
    wolfFurTexture.wrapT = THREE.RepeatWrapping;
    wolfFurTexture.magFilter = THREE.LinearFilter;
    wolfFurTexture.minFilter = THREE.LinearMipmapLinearFilter;
  }
  // A faint cool lift keeps the painted charcoal readable in the tactics
  // dungeon without bleaching its black guard hairs to gray.
  return new THREE.MeshLambertMaterial({
    map: wolfFurTexture,
    color: tint,
    emissive: 0x17151a,
    emissiveIntensity: 0.45,
  });
}

type WolfVariant = "hellhound" | "player";

let importedWolfScene: Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }> | null = null;
let importedWhiteWolfTexture: THREE.CanvasTexture | null = null;

/** Lighten the imported UV texture while retaining its painted fur detail. */
function makeWhiteWolfTexture(source: THREE.Texture): THREE.Texture {
  if (importedWhiteWolfTexture) return importedWhiteWolfTexture;
  const image = source.image as CanvasImageSource & { width: number; height: number };
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return source;
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < pixels.data.length; index += 4) {
    const luma = pixels.data[index]! * 0.299
      + pixels.data[index + 1]! * 0.587
      + pixels.data[index + 2]! * 0.114;
    // A broad light-gray range keeps the animal white while making the
    // original strokes and guard-hair variation plainly visible.
    const detail = Math.round(112 + luma * 0.55);
    pixels.data[index] = Math.min(238, detail + 7);
    pixels.data[index + 1] = Math.min(240, detail + 9);
    pixels.data[index + 2] = Math.min(246, detail + 15);
  }
  context.putImageData(pixels, 0, 0);
  importedWhiteWolfTexture = new THREE.CanvasTexture(canvas);
  importedWhiteWolfTexture.colorSpace = THREE.SRGBColorSpace;
  importedWhiteWolfTexture.flipY = source.flipY;
  importedWhiteWolfTexture.wrapS = source.wrapS;
  importedWhiteWolfTexture.wrapT = source.wrapT;
  importedWhiteWolfTexture.magFilter = THREE.LinearFilter;
  importedWhiteWolfTexture.minFilter = THREE.LinearMipmapLinearFilter;
  return importedWhiteWolfTexture;
}

function loadImportedWolf(): Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }> {
  importedWolfScene ??= new Promise((resolve, reject) => {
    new GLTFLoader().load("/shared-models/gray-wolf/scene.gltf", (gltf) => {
      resolve({ scene: gltf.scene, animations: gltf.animations });
    }, undefined, reject);
  });
  return importedWolfScene;
}

function installImportedWolf(rig: WolfRig, variant: WolfVariant): void {
  loadImportedWolf().then(({ scene, animations }) => {
    const visual = cloneSkeleton(scene);
    // The asset faces sideways relative to the game’s +X convention.
    visual.rotation.y = Math.PI / 2;
    visual.updateMatrixWorld(true);
    const size = new THREE.Box3().setFromObject(visual).getSize(new THREE.Vector3());
    visual.scale.setScalar(1.35 / Math.max(size.x, size.y, size.z));
    visual.updateMatrixWorld(true);
    const scaledBounds = new THREE.Box3().setFromObject(visual);
    const centre = scaledBounds.getCenter(new THREE.Vector3());
    visual.position.x -= centre.x;
    visual.position.y -= scaledBounds.min.y;
    visual.position.z -= centre.z;
    visual.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      node.castShadow = true;
      node.receiveShadow = true;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      const replacements = materials.map((sourceMaterial) => {
        // Keep the source texture because it is correctly UV-mapped to this
        // model, then remap its charcoal range into textured white fur.
        if (variant === "player") {
          const whiteFur = sourceMaterial.clone() as THREE.MeshStandardMaterial;
          if (whiteFur.map) whiteFur.map = makeWhiteWolfTexture(whiteFur.map);
          whiteFur.color.setHex(0xffffff);
          whiteFur.roughness = 0.92;
          whiteFur.metalness = 0;
          whiteFur.emissive.setHex(0x24252a);
          whiteFur.emissiveIntensity = 0.1;
          return whiteFur;
        }
        const material = sourceMaterial.clone();
        const name = material.name.toLowerCase();
        if (material instanceof THREE.MeshStandardMaterial) {
          if (name.includes("eye")) {
            material.color.setHex(WOLF_EYE);
            material.emissive.setHex(WOLF_EYE);
            material.emissiveIntensity = 1.25;
            material.map = null;
          } else if (name.includes("mouth")) {
            material.emissive.setHex(0x000000);
            material.emissiveIntensity = 0;
          } else if (!name.includes("mouth")) {
            // The imported asset's gray texture is authored for the enemy
            // wolf.  Its UVs do not match the white-fur texture, so tinting
            // that map produced a dark player (and, in one version, a large
            // face-shaped rectangle).  Remove the map for the player and use
            // a clean ivory material instead.
            material.color.setHex(0x5b515f);
            material.roughness = 0.92;
          }
        }
        return material;
      });
      node.material = Array.isArray(node.material) ? replacements : replacements[0]!;
    });
    rig.mixer = new THREE.AnimationMixer(visual);
    const clip = (animationName: string) => animations.find((item) =>
      item.name.toLowerCase().split("|").at(-1) === animationName,
    );
    const movementClipName = variant === "hellhound" ? "walk fwd aggressive" : "run fwd";
    rig.runAction = clip(movementClipName) ? rig.mixer.clipAction(clip(movementClipName)!) : null;
    rig.sprintAction = clip("sprint fwd") ? rig.mixer.clipAction(clip("sprint fwd")!) : null;
    rig.aggressiveAction = clip("trot fwd aggressive")
      ? rig.mixer.clipAction(clip("trot fwd aggressive")!)
      : null;
    const attackClipName = variant === "player" ? "attack close lft" : "attack fwd";
    rig.attackAction = clip(attackClipName) ? rig.mixer.clipAction(clip(attackClipName)!) : null;
    rig.attackAction?.setLoop(THREE.LoopOnce, 1);
    const eatClip = clip("idle drink pose to low pose");
    rig.eatAction = eatClip ? rig.mixer.clipAction(eatClip) : null;
    const idleNeedle = variant === "player" ? "idle smell" : "idle pose";
    rig.idleAction = clip(idleNeedle) ? rig.mixer.clipAction(clip(idleNeedle)!) : null;
    rig.idleAction?.play();
    if (variant === "hellhound") {
      // The old eye halo used a point light inside the procedural head. Its
      // meshes are hidden by the imported wolf, but lights are not meshes, so
      // it survived and illuminated the open mouth from within.
      rig.head.traverse((node) => {
        if (node instanceof THREE.PointLight) node.visible = false;
      });
    }
    // Read from the SkinnedMesh skeleton itself. These are the exact cloned
    // Bone objects used for vertex deformation, unlike a same-named scene node
    // which may belong to the source skin after SkeletonUtils cloning.
    const boundBones = new Map<string, THREE.Bone>();
    visual.traverse((node) => {
      if (node instanceof THREE.SkinnedMesh) {
        for (const bone of node.skeleton.bones) boundBones.set(bone.uuid, bone);
      }
    });
    const normalizedBoneName = (bone: THREE.Bone) => bone.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const findBone = (part: string, side: "l" | "r", front: boolean) =>
      [...boundBones.values()].find((bone) => {
        const name = normalizedBoneName(bone);
        return name.includes(`${part}${side}`) && (front ? name.includes("front") : !name.includes("front"));
      }) ?? null;
    const findNamedBone = (name: string) =>
      [...boundBones.values()].find((bone) => normalizedBoneName(bone) === name) ?? null;
    const importedLegBones = [
      [findBone("thigh", "l", true), findBone("shin", "l", true)],
      [findBone("thigh", "r", true), findBone("shin", "r", true)],
      [findBone("thigh", "l", false), findBone("shin", "l", false)],
      [findBone("thigh", "r", false), findBone("shin", "r", false)],
    ] as const;
    for (const [bone, lowerBone] of importedLegBones) {
      if (bone) {
        rig.importedLegs.push({
          bone,
          bindQuaternion: bone.quaternion.clone(),
          lowerBone,
          lowerBindQuaternion: lowerBone?.quaternion.clone() ?? null,
          swing: 0,
        });
      }
    }
    const importedHead = findNamedBone("head046")
      ?? [...boundBones.values()].find((bone) => normalizedBoneName(bone).startsWith("head"))
      ?? null;
    const importedJaw = [...boundBones.values()].find((bone) => normalizedBoneName(bone).includes("jaw")) ?? null;
    const importedTail = [...boundBones.values()].find((bone) => normalizedBoneName(bone).includes("tail")) ?? null;
    if (importedHead) {
      rig.importedHead = {
        bone: importedHead,
        bindQuaternion: importedHead.quaternion.clone(),
      };
    }
    if (importedTail) {
      rig.importedTail = { bone: importedTail, bindQuaternion: importedTail.quaternion.clone() };
    }
    if (importedJaw) {
      rig.importedJaw = { bone: importedJaw, bindQuaternion: importedJaw.quaternion.clone() };
    }
    for (const name of ["spine00535", "spine00632", "spine00731", "spine00830", "spine00917", "spine01016"]) {
      const bone = findNamedBone(name);
      if (bone) {
        rig.importedSpine.push({ bone, bindQuaternion: bone.quaternion.clone(), flex: 0 });
      }
    }
    rig.model.traverse((node) => {
      if (node.userData["legacyWolf"] && node instanceof THREE.Mesh) {
        node.visible = false;
      }
    });
    rig.model.add(visual);
    rig.model.updateMatrixWorld(true);
    const importedBodyWorld = new THREE.Box3().setFromObject(visual).getCenter(new THREE.Vector3());
    // The hidden procedural head is the mount carrying the mouth weapons.
    // Reparent it to the real bound head bone while preserving its
    // tuned world transform; from here on the skeleton moves it directly.
    if (importedHead) {
      importedHead.attach(rig.head);
      rig.head.position.set(0, 0, 0);
      rig.head.rotation.set(0, 0, 0);
      rig.head.scale.set(1, 1, 1);
      if (variant === "player") {
        const weaponMount = rig.head.getObjectByName("wolfWeaponMount");
        if (weaponMount) {
          importedHead.attach(weaponMount);
          const headWorld = importedHead.getWorldPosition(new THREE.Vector3());
          const forward = headWorld.clone().sub(importedBodyWorld).setY(0).normalize();
          const up = new THREE.Vector3(0, 1, 0);
          const sideAxis = new THREE.Vector3().crossVectors(up, forward).normalize();
          const mouthWorld = headWorld.clone()
            .addScaledVector(forward, 0.30)
            .addScaledVector(up, -0.13);
          weaponMount.position.copy(importedHead.worldToLocal(mouthWorld));

          // The imported sword runs along the mount's local Z axis. Build a
          // head-relative frame whose Z axis crosses the muzzle sideways.
          const mountWorldMatrix = new THREE.Matrix4().makeBasis(
            forward,
            up,
            sideAxis.clone().negate(),
          );
          const mountWorldQuaternion = new THREE.Quaternion().setFromRotationMatrix(mountWorldMatrix);
          const parentWorldQuaternion = importedHead.getWorldQuaternion(new THREE.Quaternion());
          weaponMount.quaternion.copy(parentWorldQuaternion.invert().multiply(mountWorldQuaternion));
          weaponMount.rotateY(Math.PI);
          weaponMount.scale.set(1, 1, 1);
        }
      }
      if (variant === "player" || variant === "hellhound") {
        const isPlayer = variant === "player";
        const eyeMaterial = new THREE.MeshBasicMaterial({
          color: isPlayer ? 0xffe13b : 0xff2028,
          depthTest: true,
          depthWrite: true,
          polygonOffset: !isPlayer,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        });
        const headWorld = importedHead.getWorldPosition(new THREE.Vector3());
        const forward = headWorld.clone().sub(importedBodyWorld).setY(0).normalize();
        const up = new THREE.Vector3(0, 1, 0);
        const sideAxis = new THREE.Vector3().crossVectors(up, forward).normalize();
        const inheritedScale = importedHead.getWorldScale(new THREE.Vector3());
        const importedEyeBones = [findNamedBone("lefteye052"), findNamedBone("righteye0105")]
          .filter((bone): bone is THREE.Bone => bone !== null);
        // Only compensate for the enemy actor's explicit 1.95x root scale.
        // World scale also contains the stage hierarchy and pushed the
        // player's eyes back up toward its ears.
        const actorScale = isPlayer ? 1 : (rig.model.parent?.scale.x ?? 1);
        const worldRadius = isPlayer ? 0.019 : 0.03;
        const localRadius = worldRadius / Math.max(inheritedScale.x, inheritedScale.y, inheritedScale.z, 0.0001);
        for (const side of [-1, 1] as const) {
          const eye = new THREE.Mesh(
            new THREE.OctahedronGeometry(localRadius, 0),
            eyeMaterial,
          );
          eye.name = "importedWolfEye";
          // Keep the already-approved player setup independent from enemy
          // tuning so later hellhound changes cannot disturb it.
          if (isPlayer) {
            eye.scale.set(1.3, 0.52, 0.5);
            eye.rotation.z = side * 0.56;
          } else {
            eye.scale.set(1.12, 0.68, 0.46);
            eye.rotation.z = side * 0.44;
          }
          const eyeBone = importedEyeBones.length > 0
            ? importedEyeBones.reduce((best, candidate) => {
              const bestSide = best.getWorldPosition(new THREE.Vector3()).dot(sideAxis) * side;
              const candidateSide = candidate.getWorldPosition(new THREE.Vector3()).dot(sideAxis) * side;
              return candidateSide > bestSide ? candidate : best;
            })
            : null;
          const eyeSurfaceNormal = forward.clone().multiplyScalar(0.82)
            .addScaledVector(sideAxis, side * 0.58)
            .normalize();
          const target = eyeBone
            // The dedicated eye-bone pivot is inside the modeled eyeball. A
            // tiny move toward the muzzle exposes the diamond without laying
            // it over the forehead or letting it show through the skull.
            ? eyeBone.getWorldPosition(new THREE.Vector3())
              .addScaledVector(eyeSurfaceNormal, isPlayer ? 0.027 : 0.043)
            : headWorld.clone()
              .addScaledVector(forward, 0.232 * actorScale)
              .addScaledVector(up, -0.025 * actorScale)
              .addScaledVector(sideAxis, side * 0.065 * actorScale);
          eye.position.copy(importedHead.worldToLocal(target));
          importedHead.add(eye);
          if (eyeBone) {
            rig.model.updateMatrixWorld(true);
            eyeBone.attach(eye);
            // Lay the broad X/Y face of the octahedron against the cheek. Its
            // thin local Z axis points out of the corresponding side of the
            // skull; the final roll keeps the approved angry inward slant.
            const outward = eyeSurfaceNormal;
            const acrossFace = new THREE.Vector3().crossVectors(up, outward).normalize();
            const faceFrame = new THREE.Matrix4().makeBasis(acrossFace, up, outward);
            const faceWorldQuaternion = new THREE.Quaternion().setFromRotationMatrix(faceFrame);
            const eyeBoneWorldQuaternion = eyeBone.getWorldQuaternion(new THREE.Quaternion());
            eye.quaternion.copy(eyeBoneWorldQuaternion.invert().multiply(faceWorldQuaternion));
            eye.rotateZ(side * (isPlayer ? 0.5 : 0.44));
          }
        }
      }
    }
  }).catch((error: unknown) => console.warn("Could not load imported wolf model", error));
}

export function buildWolf(accent: THREE.Color, variant: WolfVariant = "hellhound"): WolfRig {
  const model = new THREE.Group();

  const body = mesh(new THREE.SphereGeometry(0.5, 10, 7), wolfMat(0xaaa4ad));
  body.scale.set(1.3, 0.54, 0.5);
  model.add(at(body, -0.05, 0.74, 0));

  const chest = mesh(new THREE.SphereGeometry(0.34, 9, 6), wolfMat(0xb9b3bc));
  chest.scale.set(0.92, 1.08, 0.9);
  model.add(at(chest, 0.42, 0.76, 0));

  const haunch = mesh(new THREE.SphereGeometry(0.27, 9, 6), wolfMat(0x918b96));
  haunch.scale.set(1.12, 1.04, 0.86);
  model.add(at(haunch, -0.49, 0.73, 0));

  const belly = mesh(new THREE.SphereGeometry(0.28, 8, 5), wolfMat(WOLF_BELLY));
  belly.scale.set(1.75, 0.32, 0.62);
  model.add(at(belly, 0, 0.48, 0));

  const neck = mesh(new THREE.CylinderGeometry(0.2, 0.27, 0.4, 9), wolfMat(0xa49da8));
  neck.rotation.z = -0.75;
  model.add(at(neck, 0.66, 0.94, 0));

  // Head as its own group: it can then turn toward the player independently.
  const head = at(new THREE.Group(), 0.84, 1.02, 0);
  const skull = mesh(new THREE.SphereGeometry(0.22, 9, 6), wolfMat(0xaaa4ad));
  skull.scale.set(1.05, 0.9, 0.9);
  head.add(skull);
  // Broader cheeks taper into a long muzzle. Layering the forms keeps the
  // silhouette canine instead of making the head read as one rectangular mask.
  const cheek = mesh(new THREE.SphereGeometry(0.2, 8, 5), wolfMat(0x827b88));
  cheek.scale.set(1.15, 0.75, 1);
  head.add(at(cheek, 0.08, -0.04, 0));
  // With the cylinder laid along +X, its second radius is the nose end. A
  // strong taper gives the hound a proper wedge-shaped wolf muzzle.
  const muzzle = mesh(new THREE.CylinderGeometry(0.145, 0.062, 0.39, 8), wolfMat(0xa39ca7));
  muzzle.rotation.z = Math.PI / 2;
  head.add(at(muzzle, 0.29, -0.08, 0));
  const nose = mesh(new THREE.SphereGeometry(0.055, 8, 5), flatMat(0x120e0d));
  nose.scale.set(0.68, 0.62, 0.9);
  head.add(at(nose, 0.505, -0.06, 0));

  const jaw = at(new THREE.Group(), 0.08, -0.12, 0);
  const jawBone = mesh(new THREE.CylinderGeometry(0.09, 0.043, 0.37, 7), wolfMat(0x716b76));
  jawBone.rotation.z = Math.PI / 2;
  jaw.add(at(jawBone, 0.18, -0.035, 0));
  const mouth = flatMat(0x1a0909);
  jaw.add(at(mesh(new THREE.BoxGeometry(0.27, 0.018, 0.145), mouth), 0.19, 0.012, 0));
  head.add(jaw);

  const ear = () => {
    const cone = mesh(new THREE.ConeGeometry(0.095, 0.24, 7), wolfMat(0x77717d));
    cone.rotation.z = -0.16;
    return cone;
  };
  const ears = [at(ear(), -0.06, 0.22, 0.11), at(ear(), -0.06, 0.22, -0.11)];
  head.add(...ears);

  /**
   * **Angry eyes: a red diamond apiece, and nothing else.** No brow — the shape
   * carries the whole expression now.
   *
   * An octahedron, whose points sit on the axes, so the face it turns toward you
   * is a diamond with its corners at the top, bottom and both ends. Scaled long
   * across the head and shallow into it: a lozenge rather than a gem, which is
   * what stops it reading as a jewel stuck on a wolf. Tilted (`EYE_TILT`) so the
   * inner point drops toward the snout, and head on the pair make a V aimed at
   * the nose — a diamond has a point to *aim*, which is why it can do alone what
   * previously took a bar with a brow over it.
   *
   * Red rather than the enemy's accent: a hellhound's eyes are its own thing,
   * and the ember accent still shows at the throat.
   */
  const eyeMaterial = new THREE.MeshBasicMaterial({ color: WOLF_EYE });

  /**
   * How far the diamond's outer point reaches across the head once it has been
   * scaled and tilted — the tilt is a rotation about X, so it trades some of
   * that reach for height.
   */
  const eyeHalfZ = EYE_RADIUS * EYE_SCALE.z * Math.cos(EYE_TILT);
  /**
   * Placed from the cheek inwards rather than at a number picked by eye, so the
   * outer point always stops short of the side of the head. Set by hand it
   * overhung by 0.03 and the tip showed *through* the cheek as a separate red
   * sliver — one diamond on the face and one on the flank, per eye.
   */
  const eyeZ = HEAD_BLOCK.z / 2 - eyeHalfZ - 0.008;

  const eye = (side: 1 | -1) => {
    const diamond = new THREE.Mesh(new THREE.OctahedronGeometry(EYE_RADIUS, 0), eyeMaterial);
    diamond.scale.set(EYE_SCALE.x, EYE_SCALE.y, EYE_SCALE.z);
    diamond.rotation.x = -side * EYE_TILT;
    return diamond;
  };
  head.add(at(eye(1), 0.16, 0.05, eyeZ));
  head.add(at(eye(-1), 0.16, 0.05, -eyeZ));
  const haloMaterial = new THREE.MeshBasicMaterial({
    color: WOLF_EYE,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const halo = (side: 1 | -1) => {
    const glow = new THREE.Mesh(new THREE.OctahedronGeometry(EYE_RADIUS, 0), haloMaterial);
    glow.scale.set(EYE_SCALE.x * 1.5, EYE_SCALE.y * 1.8, EYE_SCALE.z * 1.45);
    glow.rotation.x = -side * EYE_TILT;
    return glow;
  };
  head.add(at(halo(1), 0.158, 0.05, eyeZ));
  head.add(at(halo(-1), 0.158, 0.05, -eyeZ));
  // A tiny local light gives the eyes a soft bleed onto the muzzle instead of
  // the hard neon glare a large emissive orb would create.
  const eyeGlow = new THREE.PointLight(WOLF_EYE, 0.7, 1.35, 2);
  head.add(at(eyeGlow, 0.2, 0.045, 0));
  model.add(head);

  // Ember throat — the one place the hellhound's colour shows on the body.
  const throat = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.1, 0.2),
    new THREE.MeshBasicMaterial({ color: accent.clone().multiplyScalar(0.55) }),
  );
  model.add(at(throat, 0.62, 0.78, 0));

  const legs: THREE.Group[] = [];
  for (const [x, z] of [[0.44, 0.19], [0.44, -0.19], [-0.46, 0.2], [-0.46, -0.2]] as const) {
    const hind = x < 0;
    const joint = at(new THREE.Group(), x, 0.62, z);
    const angle = hind ? -0.26 : 0.18;
    const length = 0.52;
    const leg = mesh(
      new THREE.CylinderGeometry(0.055, 0.085, length, 7),
      wolfMat(hind ? 0x716b76 : 0x77717d),
    );
    leg.rotation.z = angle;
    joint.add(at(leg, Math.sin(angle) * length * 0.5, -length * 0.5, 0));

    const paw = mesh(new THREE.SphereGeometry(0.065, 7, 4), wolfMat(0x77717d));
    paw.scale.set(1.45, 0.45, 0.86);
    joint.add(at(paw, Math.sin(angle) * length + 0.035, -0.56, 0));
    model.add(joint);
    legs.push(joint);
  }

  const tail = at(new THREE.Group(), -0.78, 0.84, 0);
  const tailMesh = mesh(new THREE.CylinderGeometry(0.065, 0.11, 0.55, 8), wolfMat(0x716b76));
  tailMesh.rotation.z = -0.18;
  tail.add(at(tailMesh, -0.045, 0.26, 0));
  tail.rotation.z = 0.95; // back and up
  model.add(tail);

  // Built life-size, then taken in a notch: the server's hit circle is
  // `ENEMY_RADIUS` (45px = 1.5 units) wide, and a wolf visibly longer than that
  // reads as unclickable at the ends — and buries the player when it closes.
  model.scale.setScalar(WOLF_SCALE);

  const rig: WolfRig = {
    model, legs, importedLegs: [], importedHead: null, importedJaw: null,
    importedTail: null, importedSpine: [],
    head, jaw, tail, body, neck, ears,
    eyeMaterial,
    eyeColor: new THREE.Color(WOLF_EYE),
    mixer: null,
    runAction: null,
    sprintAction: null,
    aggressiveAction: null,
    attackAction: null,
    eatAction: null,
    idleAction: null,
  };
  model.traverse((node) => {
    if (node instanceof THREE.Mesh) node.userData["legacyWolf"] = true;
  });
  installImportedWolf(rig, variant);
  return rig;
}

export interface PlayerWolfRig extends WolfRig {
  sword: THREE.Group;
  dagger: THREE.Group;
}

let playerWolfTexture: THREE.Texture | null = null;

/** White, yellow-eyed player wolf with a blade clenched sideways by its hilt. */
export function buildPlayerWolf(): PlayerWolfRig {
  // Keep the hellhound's throat accent neutral on the player; its only colored
  // light should come from the eye meshes themselves.
  const rig = buildWolf(new THREE.Color(0xf1f0e9), "player");
  const eyeYellow = new THREE.Color(0xffe13b);
  if (!playerWolfTexture) {
    playerWolfTexture = new THREE.TextureLoader().load("/shared-textures/player-wolf-white-fur.png");
    playerWolfTexture.colorSpace = THREE.SRGBColorSpace;
    playerWolfTexture.wrapS = THREE.RepeatWrapping;
    playerWolfTexture.wrapT = THREE.RepeatWrapping;
    playerWolfTexture.magFilter = THREE.LinearFilter;
    playerWolfTexture.minFilter = THREE.LinearMipmapLinearFilter;
  }

  rig.model.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const material = node.material;
    if (material instanceof THREE.MeshLambertMaterial && material.map) {
      const whiteFur = material.clone();
      whiteFur.map = playerWolfTexture;
      whiteFur.color.setHex(0xf1f0e9);
      whiteFur.emissive.setHex(0x24272c);
      whiteFur.emissiveIntensity = 0.2;
      node.material = whiteFur;
    }
  });

  rig.eyeMaterial.color.copy(eyeYellow);
  rig.eyeColor.copy(eyeYellow);
  rig.head.traverse((node) => {
    // The point light washed across the muzzle and made the nose appear to
    // glow. The emissive diamonds and their tight halos provide enough light.
    if (node instanceof THREE.PointLight) node.visible = false;
    if (node instanceof THREE.Mesh && node.material instanceof THREE.MeshBasicMaterial &&
        node.material.color.getHex() === WOLF_EYE) node.material.color.copy(eyeYellow);
  });
  // The stock hellhound neck is deliberately heavy. Narrow it on the player
  // and pull it slightly into the shoulders so it reads as a continuous neck
  // instead of a bulky collar around the head.
  rig.neck.scale.set(0.7, 0.92, 0.7);
  rig.neck.position.x -= 0.035;
  rig.neck.position.y -= 0.025;
  for (const ear of rig.ears) {
    // Keep the longer player silhouette without turning the ears into broad
    // cones. The local Y axis is the cone's length; X/Z control thickness.
    ear.scale.set(0.68, 1.42, 0.68);
    ear.rotation.z = 0.5;
  }

  const weaponMount = at(new THREE.Group(), 0.12, -0.04, 0.055);
  weaponMount.name = "wolfWeaponMount";
  rig.head.add(weaponMount);
  const sword = buildBlade(0.72, 0.09);
  sword.visible = false;
  const dagger = buildBlade(0.4, 0.07);
  dagger.visible = false;
  weaponMount.add(sword, dagger);
  installImportedSword(sword);
  installImportedDagger(dagger, "mouth");
  installImportedCrown(rig.head);
  const playerRig = rig as PlayerWolfRig;
  playerRig.sword = sword;
  playerRig.dagger = dagger;
  return playerRig;
}

export interface BatRig {
  model: THREE.Group;
  mixer: THREE.AnimationMixer | null;
  flightAction: THREE.AnimationAction | null;
  wingJoints: Array<{
    bone: THREE.Bone;
    bindQuaternion: THREE.Quaternion;
    side: -1 | 1;
    order: number;
  }>;
}

export interface SpiderRig {
  model: THREE.Group;
  mixer: THREE.AnimationMixer | null;
  walkAction: THREE.AnimationAction | null;
  limbRoots: THREE.Bone[];
}

let importedSpiderScene: Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }> | null = null;

/** Imported dungeon spider with its authored walking cycle and a dark texture tint. */
export function buildSpider(): SpiderRig {
  const rig: SpiderRig = { model: new THREE.Group(), mixer: null, walkAction: null, limbRoots: [] };
  importedSpiderScene ??= new Promise((resolve, reject) => {
    new GLTFLoader().load(
      "/shared-models/spider/scene.gltf",
      (gltf) => resolve({ scene: gltf.scene, animations: gltf.animations }),
      undefined,
      reject,
    );
  });
  importedSpiderScene.then(({ scene, animations }) => {
    const visual = cloneSkeleton(scene);
    // The authored model faces along its glTF Z axis; actors in this game face
    // local +X before their world yaw is applied.
    visual.rotation.y = Math.PI / 2;
    visual.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(visual);
    const size = bounds.getSize(new THREE.Vector3());
    // Reduced another quarter from the prior 8.625-unit normalization.
    visual.scale.setScalar(6.46875 / Math.max(size.x, size.y, size.z));
    visual.updateMatrixWorld(true);
    const scaled = new THREE.Box3().setFromObject(visual);
    const centre = scaled.getCenter(new THREE.Vector3());
    visual.position.set(-centre.x, -scaled.min.y, -centre.z);
    visual.traverse((node) => {
      if (node instanceof THREE.Bone && /_(?:L|R)$/.test(node.name)) {
        rig.limbRoots.push(node);
      }
      if (!(node instanceof THREE.Mesh)) return;
      node.castShadow = true;
      node.receiveShadow = true;
      const sources = Array.isArray(node.material) ? node.material : [node.material];
      const materials = sources.map((source) => {
        const material = source.clone();
        if (material instanceof THREE.MeshStandardMaterial) {
          const eye = material.name.toLowerCase().includes("eye") || node.name.toLowerCase().includes("eye");
          if (eye) {
            material.color.setHex(0x260202);
            material.emissive.setHex(0xff0000);
            material.emissiveIntensity = 2.2;
            material.map = null;
            // All eight authored eyes share one skinned mesh and one material.
            // The four large upper eyes are separate connected components whose
            // lowest vertices sit above Y=.562; every small lower eye ends below
            // Y=.560. A hard component-safe cutoff lights each selected eye as
            // a complete circle rather than feathering through its geometry.
            material.onBeforeCompile = (shader) => {
              shader.vertexShader = shader.vertexShader
                .replace("void main() {", "varying float vGlowingSpiderEye;\nvoid main() {")
                .replace(
                  "#include <begin_vertex>",
                  "#include <begin_vertex>\n  vGlowingSpiderEye = step(0.561, position.y);",
                );
              shader.fragmentShader = shader.fragmentShader
                .replace("void main() {", "varying float vGlowingSpiderEye;\nvoid main() {")
                .replace(
                  "vec3 totalEmissiveRadiance = emissive;",
                  "vec3 totalEmissiveRadiance = emissive * vGlowingSpiderEye;",
                );
            };
            material.customProgramCacheKey = () => "upper-spider-eyes-v3";
          } else {
            material.color.multiplyScalar(0.1);
          }
          material.roughness = Math.max(material.roughness, 0.72);
        }
        return material;
      });
      node.material = Array.isArray(node.material) ? materials : materials[0]!;
    });
    rig.model.add(visual);
    const walk = animations.find((clip) => /walk-cycle-basic/i.test(clip.name)) ?? animations[0];
    if (walk) {
      rig.mixer = new THREE.AnimationMixer(visual);
      rig.walkAction = rig.mixer.clipAction(walk);
      rig.walkAction.play();
    }
  }).catch((error: unknown) => console.warn("Could not load imported spider model", error));
  return rig;
}

let importedBatScene: Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }> | null = null;

/** Imported flying bat, normalized to game scale with bright red eyes. */
export function buildBat(): BatRig {
  const rig: BatRig = { model: new THREE.Group(), mixer: null, flightAction: null, wingJoints: [] };
  importedBatScene ??= new Promise((resolve, reject) => {
    new GLTFLoader().load(
      "/shared-models/bat/scene.gltf",
      (gltf) => resolve({ scene: gltf.scene, animations: gltf.animations }),
      undefined,
      reject,
    );
  });
  importedBatScene.then(({ scene, animations }) => {
    const visual = cloneSkeleton(scene);
    visual.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(visual);
    const size = bounds.getSize(new THREE.Vector3());
    visual.scale.setScalar(9.6 / Math.max(size.x, size.y, size.z));
    visual.updateMatrixWorld(true);
    const scaledBounds = new THREE.Box3().setFromObject(visual);
    const centre = scaledBounds.getCenter(new THREE.Vector3());
    visual.position.sub(centre);
    visual.traverse((node) => {
      if (node instanceof THREE.Bone) {
        const name = node.name.toLowerCase();
        const wingPart = /(?:clavicle|arm[12]|wing[123])\.[lr]_armature/.exec(name);
        if (wingPart) {
          const order = name.includes("clavicle") ? 0
            : name.includes("arm1") ? 1
              : name.includes("arm2") ? 2
                : Number(/wing([123])/.exec(name)?.[1] ?? 1) + 2;
          rig.wingJoints.push({
            bone: node,
            bindQuaternion: node.quaternion.clone(),
            side: name.includes(".l_") ? -1 : 1,
            order,
          });
        }
      }
      if (!(node instanceof THREE.Mesh)) return;
      // The oversized skinned bat moving rapidly through the view is expensive
      // to include in every shadow-map update during a swoop.
      node.castShadow = false;
      node.receiveShadow = true;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      const replacements = materials.map((source) => {
        const material = source.clone();
        const isEye = material.name.toLowerCase().includes("eyes")
          || node.name.toLowerCase().includes("eyes");
        if (isEye && material instanceof THREE.MeshStandardMaterial) {
          material.color.setHex(0xff1010);
          material.emissive.setHex(0xff0000);
          material.emissiveIntensity = 1.4;
          material.map = null;
        } else if (
          material instanceof THREE.MeshStandardMaterial
          || material instanceof THREE.MeshPhongMaterial
          || material instanceof THREE.MeshLambertMaterial
        ) {
          // Multiply the imported texture darker without replacing its natural
          // colour variation or the detail across the wings and body.
          material.color.setHex(0xbcbcc4);
          if ("emissive" in material) material.emissive.setHex(0x000000);
        }
        return material;
      });
      node.material = Array.isArray(node.material) ? replacements : replacements[0]!;
    });
    rig.model.add(visual);
    if (animations[0]) {
      rig.mixer = new THREE.AnimationMixer(visual);
      rig.flightAction = rig.mixer.clipAction(animations[0]);
      rig.flightAction.play();
    }
  }).catch((error: unknown) => console.warn("Could not load imported bat model", error));
  return rig;
}

const importedBloodSplatterScene = new Promise<THREE.Group>((resolve, reject) => {
  new GLTFLoader().load(
    "/shared-models/blood-splatter/scene.gltf",
    (gltf) => resolve(gltf.scene),
    undefined,
    reject,
  );
});

/** A short-lived imported 3D splash layered beneath the procedural droplets. */
export function buildBloodSplatter(color = 0x520006): THREE.Group {
  const root = new THREE.Group();
  importedBloodSplatterScene.then((scene) => {
    if (root.userData["disposed"]) return;
    const visual = scene.clone(true);
    visual.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(visual);
    const size = bounds.getSize(new THREE.Vector3());
    visual.scale.setScalar(1 / Math.max(size.x, size.y, size.z, 0.0001));
    visual.updateMatrixWorld(true);
    const scaledBounds = new THREE.Box3().setFromObject(visual);
    const centre = scaledBounds.getCenter(new THREE.Vector3());
    visual.position.sub(centre);
    visual.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      node.castShadow = false;
      node.receiveShadow = false;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      const replacements = materials.map(() => new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.82,
        depthWrite: false,
        side: THREE.DoubleSide,
      }));
      node.material = Array.isArray(node.material) ? replacements : replacements[0]!;
    });
    root.add(visual);
  }).catch((error: unknown) => console.warn("Could not load blood splatter model", error));
  return root;
}

// ------------------------------------------------------------------ scenery

/** A thrown dagger, built along +X so it can be pointed straight down its velocity. */
export function buildDagger(): THREE.Group {
  const group = new THREE.Group();
  const shape = new THREE.Shape();
  shape.moveTo(-0.04, -0.055);
  shape.lineTo(0.28, -0.05);
  shape.lineTo(0.43, 0);
  shape.lineTo(0.28, 0.05);
  shape.lineTo(-0.04, 0.055);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.025,
    bevelEnabled: true,
    bevelSize: 0.008,
    bevelThickness: 0.006,
    bevelSegments: 1,
  });
  geometry.translate(0, 0, -0.0125);
  group.add(mesh(geometry, flatMat(STEEL)));
  group.add(at(box(0.25, 0.012, 0.03, STEEL_DARK), 0.1, 0, 0)); // fuller
  group.add(at(box(0.045, 0.2, 0.045, 0x765b32), -0.065, 0, 0));
  const grip = mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.18, 8), flatMat(WOOD));
  grip.rotation.z = Math.PI / 2;
  group.add(at(grip, -0.17, 0, 0));
  group.add(at(mesh(new THREE.SphereGeometry(0.045, 7, 5), flatMat(0x765b32)), -0.275, 0, 0));
  installImportedDagger(group, "thrown");
  return group;
}

/**
 * The marker a death leaves: a grave cross, which is what the 2D game's `†`
 * glyph always was.
 *
 * The arms run along **X** — screen-horizontal under the fixed camera yaw — so
 * it reads as a cross rather than as a post. Whatever places one should jitter
 * its yaw only slightly, for the same reason.
 */
let importedCelticCrossScene: Promise<THREE.Group> | null = null;

export function buildTombstone(): THREE.Group {
  const group = new THREE.Group();

  importedCelticCrossScene ??= new Promise((resolve, reject) => {
    new GLTFLoader().load(
      "/shared-models/celtic-cross/scene-low.glb",
      (gltf) => resolve(gltf.scene),
      undefined,
      reject,
    );
  });
  importedCelticCrossScene.then((source) => {
    const visual = source.clone(true);
    visual.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      node.castShadow = true;
      node.receiveShadow = true;
      const sources = Array.isArray(node.material) ? node.material : [node.material];
      const materials = sources.map((sourceMaterial) => {
        const material = sourceMaterial.clone();
        if (material instanceof THREE.MeshStandardMaterial) {
          material.color.setHex(0xc8cdd3);
          material.metalness = 0.9;
          material.roughness = 0.24;
        }
        return material;
      });
      node.material = Array.isArray(node.material) ? materials : materials[0]!;
    });
    visual.updateMatrixWorld(true);
    let bounds = new THREE.Box3().setFromObject(visual);
    const size = bounds.getSize(new THREE.Vector3());
    visual.scale.setScalar(1.8 / Math.max(0.001, size.y));
    visual.updateMatrixWorld(true);
    bounds = new THREE.Box3().setFromObject(visual);
    const centre = bounds.getCenter(new THREE.Vector3());
    visual.position.x -= centre.x;
    visual.position.y -= bounds.min.y;
    visual.position.z -= centre.z;
    group.add(visual);
  }).catch((error: unknown) => console.warn("Could not load Celtic death cross", error));

  return group;
}

/** A wall torch: bracket, flame, and the light it casts. */
export function buildTorch(): { group: THREE.Group; flame: THREE.Mesh; light: THREE.PointLight } {
  const group = new THREE.Group();
  group.add(at(box(0.1, 0.42, 0.1, 0x2c2c30), 0, 0, 0));

  const flame = mesh(new THREE.IcosahedronGeometry(0.16, 0), new THREE.MeshBasicMaterial({ color: 0xffa33a }));
  flame.castShadow = false;
  flame.receiveShadow = false;
  group.add(at(flame, 0, 0.3, 0));

  const light = new THREE.PointLight(0xffa23a, 9, 16, 2);
  group.add(at(light, 0, 0.45, 0));

  return { group, flame, light };
}
