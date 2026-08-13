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

// ------------------------------------------------------------------ palette

const SKIN = 0xd8a373;
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
export const WOLF_SCALE = 0.85;

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

  const blade = box(width, length, width * 0.35, STEEL);
  blade.position.y = -length / 2 - 0.1;
  group.add(blade);

  group.add(at(box(width * 0.5, 0.05, width * 3.4, STEEL_DARK), 0, -0.08, 0));
  group.add(at(box(0.055, 0.2, 0.055, WOOD), 0, 0.03, 0));
  group.add(at(mesh(new THREE.IcosahedronGeometry(0.045, 0), flatMat(STEEL_DARK)), 0, 0.14, 0));

  return group;
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
  /** Where the player's randomised colour goes — the tunic stays brown. */
  cloak: THREE.Mesh;
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
    const hip = at(new THREE.Group(), 0, 0.74, z);
    hip.add(at(box(0.22, 0.6, 0.24, TROUSERS), 0, -0.3, 0));
    hip.add(at(box(0.34, 0.16, 0.26, BOOT), 0.05, -0.66, 0));
    model.add(hip);
    legs.push(hip);
  }

  // Tunic: wider at the hem than the shoulders, which is what reads as cloth.
  const torso = mesh(new THREE.CylinderGeometry(0.3, 0.42, 0.84, 6), flatMat(tunicColor));
  torso.scale.set(0.78, 1, 1.06); // thin front-to-back, broad across the shoulders
  torso.position.set(0, 1.16, 0);
  torso.rotation.y = Math.PI / 6; // put a flat face forward rather than an edge
  model.add(torso);

  const belt = mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.09, 6), flatMat(BELT));
  belt.scale.set(0.82, 1, 1.08);
  belt.rotation.y = Math.PI / 6;
  model.add(at(belt, 0, 0.88, 0));

  const collar = mesh(new THREE.CylinderGeometry(0.26, 0.32, 0.12, 6), flatMat(TUNIC_DARK));
  collar.scale.set(0.8, 1, 1.08);
  collar.rotation.y = Math.PI / 6;
  model.add(at(collar, 0, 1.6, 0));

  // A cloak down the back, and the only part that isn't fixed: it carries the
  // player's randomised colour, which is what the HUD portrait is ringed in.
  const cloak = mesh(new THREE.CylinderGeometry(0.32, 0.48, 0.98, 6), flatMat(0x8a5a2b));
  cloak.scale.set(0.34, 1, 1.06);
  cloak.rotation.y = Math.PI / 6;
  model.add(at(cloak, -0.2, 1.1, 0));

  const arms: THREE.Group[] = [];
  for (const z of [0.34, -0.34]) {
    const shoulder = at(new THREE.Group(), 0, 1.52, z);
    shoulder.add(at(box(0.17, 0.34, 0.17, tunicColor), 0, -0.17, 0)); // sleeve
    shoulder.add(at(box(0.14, 0.32, 0.14, SKIN), 0, -0.5, 0)); // forearm
    shoulder.add(at(box(0.15, 0.13, 0.15, SKIN), 0, -0.71, 0)); // fist
    model.add(shoulder);
    arms.push(shoulder);
  }

  const head = mesh(new THREE.IcosahedronGeometry(0.23, 0), flatMat(SKIN));
  head.scale.set(0.95, 1.12, 0.92);
  model.add(at(head, 0.02, 1.83, 0));

  const hair = mesh(new THREE.IcosahedronGeometry(0.24, 0), flatMat(HAIR));
  hair.scale.set(0.95, 0.72, 0.98);
  head.add(at(hair, -0.04, 0.09, 0));

  const eye = () => mesh(new THREE.BoxGeometry(0.03, 0.04, 0.05), new THREE.MeshBasicMaterial({ color: 0x201a16 }));
  head.add(at(eye(), 0.2, 0.01, 0.09));
  head.add(at(eye(), 0.2, 0.01, -0.09));

  // Both weapons live in the right fist; only the selected one is visible.
  //
  // The fist is turned a quarter turn, so the blade sits **orthogonal to the
  // arm** rather than continuing its line — that is what makes the overhand
  // swing chop: as the arm comes over the top and reaches forward, the blade is
  // pointing down at what it is hitting.
  const rightArm = arms[1]!;
  rightArm.rotation.x = 0.28; // splayed, so the blade passes outside the hip
  const hand = at(new THREE.Group(), 0, -0.74, 0);
  hand.rotation.z = -Math.PI / 2;
  rightArm.add(hand);

  const sword = buildBlade(0.72, 0.09);
  const dagger = buildBlade(0.4, 0.07);
  dagger.visible = false;
  hand.add(sword);
  hand.add(dagger);

  return { model, legs, arms, torso, head, cloak, sword, dagger };
}

// ------------------------------------------------------------------ the wolf

export interface WolfRig {
  /** Paws on y = 0, facing +X. */
  model: THREE.Group;
  /** Front-left, front-right, back-left, back-right. */
  legs: THREE.Group[];
  head: THREE.Object3D;
  tail: THREE.Group;
  body: THREE.Object3D;
  /** Emissive-looking eyes, brightened while the thing is hunting you. */
  eyeMaterial: THREE.MeshBasicMaterial;
}

/**
 * The hellhound: a wolf. Charcoal fur with the enemy's ember colour kept for
 * the eyes and the throat, so it still reads as the orange `♞` it replaces
 * without turning the whole animal orange.
 */
export function buildWolf(accent: THREE.Color): WolfRig {
  const model = new THREE.Group();

  const body = mesh(new THREE.CylinderGeometry(0.3, 0.27, 1.15, 6), flatMat(WOLF_FUR));
  body.rotation.z = Math.PI / 2; // lay the barrel along X
  body.scale.set(1, 1, 0.92);
  model.add(at(body, -0.05, 0.72, 0));

  const chest = mesh(new THREE.IcosahedronGeometry(0.33, 0), flatMat(WOLF_FUR));
  chest.scale.set(0.95, 1, 1.02);
  model.add(at(chest, 0.42, 0.74, 0));

  const haunch = mesh(new THREE.IcosahedronGeometry(0.35, 0), flatMat(WOLF_FUR_DARK));
  haunch.scale.set(0.95, 1.02, 1);
  model.add(at(haunch, -0.5, 0.76, 0));

  model.add(at(box(0.66, 0.16, 0.36, WOLF_BELLY), 0, 0.46, 0)); // pale underside

  const neck = mesh(new THREE.CylinderGeometry(0.19, 0.24, 0.36, 6), flatMat(WOLF_FUR));
  neck.rotation.z = -0.75;
  model.add(at(neck, 0.66, 0.94, 0));

  // Head as its own group: it can then turn toward the player independently.
  const head = at(new THREE.Group(), 0.84, 1.02, 0);
  head.add(at(box(0.34, 0.3, 0.3, WOLF_FUR), 0, 0, 0));
  head.add(at(box(0.3, 0.17, 0.19, WOLF_FUR), 0.26, -0.07, 0)); // snout
  head.add(at(box(0.06, 0.07, 0.1, 0x14110f), 0.43, -0.05, 0)); // nose

  const ear = () => {
    const cone = mesh(new THREE.ConeGeometry(0.09, 0.22, 4), flatMat(WOLF_FUR_DARK));
    cone.rotation.z = -0.16;
    return cone;
  };
  head.add(at(ear(), -0.06, 0.22, 0.11));
  head.add(at(ear(), -0.06, 0.22, -0.11));

  const eyeMaterial = new THREE.MeshBasicMaterial({ color: accent });
  const eye = () => new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.04), eyeMaterial);
  head.add(at(eye(), 0.16, 0.05, 0.11));
  head.add(at(eye(), 0.16, 0.05, -0.11));
  model.add(head);

  // Ember throat — the one place the hellhound's colour shows on the body.
  const throat = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.1, 0.2),
    new THREE.MeshBasicMaterial({ color: accent.clone().multiplyScalar(0.55) }),
  );
  model.add(at(throat, 0.62, 0.78, 0));

  const legs: THREE.Group[] = [];
  for (const [x, z] of [[0.44, 0.19], [0.44, -0.19], [-0.46, 0.2], [-0.46, -0.2]] as const) {
    const joint = at(new THREE.Group(), x, 0.62, z);
    joint.add(at(box(0.14, 0.5, 0.15, WOLF_FUR_DARK), 0, -0.25, 0));
    joint.add(at(box(0.17, 0.12, 0.17, WOLF_FUR_DARK), 0.02, -0.56, 0)); // paw, on the floor
    model.add(joint);
    legs.push(joint);
  }

  const tail = at(new THREE.Group(), -0.78, 0.84, 0);
  const tailMesh = mesh(new THREE.CylinderGeometry(0.09, 0.045, 0.5, 5), flatMat(WOLF_FUR_DARK));
  tail.add(at(tailMesh, 0, 0.25, 0));
  tail.rotation.z = 0.95; // back and up
  model.add(tail);

  // Built life-size, then taken in a notch: the server's hit circle is
  // `ENEMY_RADIUS` (45px = 1.5 units) wide, and a wolf visibly longer than that
  // reads as unclickable at the ends — and buries the player when it closes.
  model.scale.setScalar(WOLF_SCALE);

  return { model, legs, head, tail, body, eyeMaterial };
}

// ------------------------------------------------------------------ scenery

/** A thrown dagger, built along +X so it can be pointed straight down its velocity. */
export function buildDagger(): THREE.Group {
  const group = new THREE.Group();
  group.add(at(box(0.34, 0.05, 0.05, STEEL), 0.1, 0, 0));
  group.add(at(box(0.04, 0.16, 0.04, STEEL_DARK), -0.08, 0, 0));
  group.add(at(box(0.14, 0.055, 0.055, WOOD), -0.16, 0, 0));
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
