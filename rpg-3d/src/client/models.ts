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
    visual.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    visual.quaternion.premultiply(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2),
    );
    // Its grip is around source X=0.7. Cancel that offset at half scale, then
    // tuck the complete weapon slightly back into the mouth.
    visual.position.set(-0.32, -0.28, 0.04);
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
    mount.scale.setScalar(0.46 / Math.max(size.x, size.z));
    mount.position.set(-0.05, 0.06, 0);
    mount.rotation.x = 0.12;
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

let importedWolfScene: Promise<THREE.Group> | null = null;

function loadImportedWolf(): Promise<THREE.Group> {
  importedWolfScene ??= new Promise((resolve, reject) => {
    new GLTFLoader().load("/shared-models/wolf/scene.gltf", (gltf) => resolve(gltf.scene), undefined, reject);
  });
  return importedWolfScene;
}

function installImportedWolf(rig: WolfRig, variant: WolfVariant): void {
  loadImportedWolf().then((source) => {
    const visual = cloneSkeleton(source);
    visual.scale.setScalar(0.26);
    visual.position.x = 0.35;
    visual.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      node.castShadow = true;
      node.receiveShadow = true;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      const replacements = materials.map((sourceMaterial) => {
        const material = sourceMaterial.clone();
        const name = material.name.toLowerCase();
        if (material instanceof THREE.MeshStandardMaterial) {
          if (name.includes("eye")) {
            const eye = variant === "player" ? 0xffe13b : WOLF_EYE;
            material.color.setHex(eye);
            material.emissive.setHex(eye);
            material.emissiveIntensity = variant === "player" ? 1.6 : 1.25;
            material.map = null;
          } else if (!name.includes("mouth")) {
            material.color.setHex(variant === "player" ? 0xf4f3ed : 0x5b515f);
            if (variant === "player" && playerWolfTexture) material.map = playerWolfTexture;
            material.roughness = 0.92;
          }
        }
        return material;
      });
      node.material = Array.isArray(node.material) ? replacements : replacements[0]!;
    });
    if (variant === "player") {
      const jaw = visual.getObjectByName("Jaw_9");
      if (jaw) jaw.rotateX(-0.3);
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
    const importedHead = findNamedBone("head15");
    const importedTail = findNamedBone("spine0033");
    if (importedHead) {
      rig.importedHead = {
        bone: importedHead,
        bindQuaternion: importedHead.quaternion.clone(),
      };
    }
    if (importedTail) {
      rig.importedTail = { bone: importedTail, bindQuaternion: importedTail.quaternion.clone() };
    }
    for (const name of ["spine00535", "spine00632", "spine00731", "spine00830", "spine00917", "spine01016"]) {
      const bone = findNamedBone(name);
      if (bone) {
        rig.importedSpine.push({ bone, bindQuaternion: bone.quaternion.clone(), flex: 0 });
      }
    }
    rig.model.traverse((node) => {
      if (node.userData["legacyWolf"] && node instanceof THREE.Mesh) node.visible = false;
    });
    rig.model.add(visual);
    rig.model.updateMatrixWorld(true);
    // The hidden procedural head is the mount carrying the crown and mouth
    // weapons. Reparent it to the real bound head bone while preserving its
    // tuned world transform; from here on the skeleton moves it directly.
    if (importedHead) importedHead.attach(rig.head);
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
    model, legs, importedLegs: [], importedHead: null, importedTail: null, importedSpine: [],
    head, jaw, tail, body, neck, ears,
    eyeMaterial,
    eyeColor: new THREE.Color(WOLF_EYE),
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

  const weaponMount = at(new THREE.Group(), 0.43, -0.13, 0);
  weaponMount.rotation.x = Math.PI / 2;
  rig.head.add(weaponMount);
  const sword = buildBlade(0.72, 0.09);
  const dagger = buildBlade(0.4, 0.07);
  dagger.visible = false;
  weaponMount.add(sword, dagger);
  installImportedSword(sword);
  installImportedDagger(dagger, "mouth");
  installImportedCrown(rig.head);
  return { ...rig, sword, dagger };
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
export function buildTombstone(): THREE.Group {
  const group = new THREE.Group();

  group.add(at(box(0.15, 1.06, 0.15, STONE), 0, 0.53, 0)); // upright
  group.add(at(box(0.62, 0.15, 0.15, STONE), 0, 0.78, 0)); // crossbar

  group.add(at(box(0.44, 0.11, 0.44, 0x4e4e56), 0, 0.05, 0)); // plinth
  group.rotation.z = 0.06; // nothing in a dungeon stands straight

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
