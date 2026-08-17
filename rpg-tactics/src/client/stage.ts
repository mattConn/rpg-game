/**
 * The board: a lit stone chamber with nine flagstones in it, and the camera rig
 * that looks at them.
 *
 * The dungeon look is the real-time game's — flat-shaded stone, warm guttering
 * torchlight, fog eating the far dark — but the room is a different room, so
 * this is built here rather than imported. What *is* imported is every model in
 * it: the torches on these walls are `buildTorch` from `rpg-3d`, because there
 * is one dungeon aesthetic and it lives in one file.
 *
 * **The camera orbits here, and that is safe here.** The real-time client pins
 * its yaw because WASD is world-relative on its server, so a turnable view would
 * quietly change what "w" means. This game has no directional input at all — you
 * click a square — so there is nothing for a rotation to break, and being able
 * to look down the board's diagonals is worth a great deal on a 3x3 grid.
 */

import * as THREE from "three";

import { WORLD_HEIGHT, WORLD_WIDTH } from "../../../src/shared/constants.js";
import { clamp } from "../../../src/shared/movement.js";
import { buildTorch } from "../../../rpg-3d/src/client/models.js";
import { damp, toPixelX, toPixelY, toX, toZ } from "../../../rpg-3d/src/client/world.js";
import {
  ARENA_H,
  ARENA_W,
  ARENA_X,
  ARENA_Y,
  BOARD_REGION,
  FAR_REGION,
  HALL_REGION,
  SQUARE_PX,
  TILE_PX,
  cellAtPoint,
  inRegion,
  regionCentre,
} from "../shared/tactics.js";

// -------------------------------------------------------------- board in 3D

/** The board's extent in scene units — 9x9, three units to a square. */
const BOARD_X0 = toX(ARENA_X);
const BOARD_Z0 = toZ(ARENA_Y);
const BOARD_W = toX(ARENA_W);
const BOARD_D = toZ(ARENA_H);
/** One of the board's original squares, in scene units — the scale of a stride. */
const STRIDE = toX(SQUARE_PX);

const BOARD_CX = BOARD_X0 + BOARD_W / 2;
const BOARD_CZ = BOARD_Z0 + BOARD_D / 2;

/** Bare floor between the flagstones and the masonry. */
const MARGIN = 1.5;

const WALL_H = 2.8;
const WALL_T = 0.7;

/** A chamber: the board plus its margin of bare floor. 12x12 units. */
const CHAMBER_W = BOARD_W + MARGIN * 2;
const CHAMBER_D = BOARD_D + MARGIN * 2;

/**
 * **The corridor is walkable ground now, so the rules own its shape and this
 * file only dresses it.** `HALL_REGION` is where the player may stand; the
 * doorway's width, the masonry either side of it and the second chamber's place
 * in the world are all read off it here, so what you can walk down and what you
 * can see are the same corridor by construction rather than by agreement.
 *
 * It is still the room's own measure long and a fraction of it wide, at the
 * chambers' full wall height: taller than it is broad is the whole of what makes
 * a corridor read as one — shrink the height with the width and it reads as a
 * crawlspace, widen it and it reads as a third room.
 */
const PASSAGE_W = toX(HALL_REGION.cols * TILE_PX);
const ARCH_CENTRE = toX(regionCentre(HALL_REGION).x);

/** The far chamber sits on its own region, a corridor's length to the south. */
const FAR_CZ = toZ(regionCentre(FAR_REGION).y);

/** What is left for the hall itself once both chambers' walls are accounted for. */
const HALL_LEN = FAR_CZ - BOARD_CZ - CHAMBER_D - WALL_T * 2;

/**
 * Framing is expressed as multiples of the board's width rather than in units,
 * so a change to `TILE_PX` carries the camera and the fog with it. Fixed numbers
 * here would quietly leave the view halfway across the dungeon the first time
 * the squares were resized.
 */
const CAMERA_MIN_DISTANCE = BOARD_W * 0.8;
const CAMERA_MAX_DISTANCE = BOARD_W * 3.4;
const CAMERA_START_DISTANCE = BOARD_W * 2.35;

/**
 * Pitch bounds. The floor is the thing being read, so the low end stops well
 * short of the horizon — below about 24 degrees the near wall starts getting
 * between the camera and the back rank.
 */
const PITCH_MIN = 0.42;
const PITCH_MAX = 1.42;
const PITCH_START = 0.95;

/**
 * First person needs its own bounds, because the number means something else
 * there: overhead it is how steeply the camera looks down at the floor, and
 * from the eyes it is where the head is tilted, with the horizon at zero. The
 * range is deliberately lopsided — a fight on the floor is worth a good deal
 * more looking down than up.
 */
const FP_PITCH_MIN = -0.5;
const FP_PITCH_MAX = 0.95;
const FP_PITCH_START = 0.12;

/** Eye level on the 1.9-unit human: the head sits at 1.83, the eyes just above. */
const EYE_HEIGHT = 1.8;

const ROTATE_SPEED = 0.006;
const PAN_SPEED = 0.03;

/** How far a drag may push the view off whatever the camera is framing. */
const PAN_LIMIT = BOARD_W * 0.7;

export interface Stage {
  readonly scene: THREE.Scene;
  readonly pickables: THREE.Object3D[];
  resize(displayWidth: number, displayHeight: number, dpr: number): void;
  zoom(delta: number): void;
  /** Orbit the view. Deltas are in screen pixels. */
  orbit(dx: number, dy: number): void;
  /** Slide the look-at point across the floor. Deltas are in screen pixels. */
  pan(dx: number, dy: number): void;
  /**
   * Where the player is and which way they are facing, so the camera knows what
   * it should be framing — and, in first person, where it is and where it looks.
   */
  follow(px: number, py: number, facing: 1 | -1): void;
  /** Swap between the overhead view and the player's own eyes. Returns the new mode. */
  toggleFirstPerson(): boolean;
  readonly firstPerson: boolean;
  /** The camera's horizontal angle, in radians. */
  readonly yaw: number;
  resetView(): void;
  update(dt: number): void;
  groundAt(ndcX: number, ndcY: number): { x: number; y: number } | null;
  pickAt(ndcX: number, ndcY: number): THREE.Object3D | null;
  project(point: THREE.Vector3): { x: number; y: number };
  /** Where a click would put them, and whether it is allowed. */
  setDestination(px: number | null, py: number | null, allowed: boolean): void;
  setTargetRing(px: number | null, py: number | null, color: number): void;
  /** Raycast against doors; returns the index of the hit door, or null. */
  toggleDoorAt(ndcX: number, ndcY: number): number | null;
  /** Set door visual states from the server's authoritative state. */
  updateDoors(doorsClosed: readonly boolean[]): void;
  animateScenery(elapsed: number): void;
  render(): void;
}

/** Scene units per texture tile repeat. */
const TEXTURE_SCALE = 2;

/**
 * Classic Perlin-style value noise. A 256-entry permutation table hashed with
 * bit ops, smoothed with Hermite interpolation. Returns values in roughly
 * [-0.5, 0.5] — the caller scales and biases as needed.
 */
const perlinNoise = (() => {
  const perm = new Uint8Array(512);
  const grad = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    perm[i] = i;
    grad[i] = (Math.random() - 0.5) * 2;
  }
  // Fisher-Yates shuffle, then mirror.
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [perm[i], perm[j]] = [perm[j]!, perm[i]!];
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i]!;

  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a: number, b: number, t: number) => a + t * (b - a);

  return (x: number, y: number): number => {
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = fade(xf);
    const v = fade(yf);

    const aa = perm[perm[xi]! + yi]!;
    const ab = perm[perm[xi]! + yi + 1]!;
    const ba = perm[perm[xi + 1]! + yi]!;
    const bb = perm[perm[xi + 1]! + yi + 1]!;

    return lerp(
      lerp(grad[aa]! * xf + grad[aa]! * yf,
           grad[ba]! * (xf - 1) + grad[ba]! * yf, u),
      lerp(grad[ab]! * xf + grad[ab]! * (yf - 1),
           grad[bb]! * (xf - 1) + grad[bb]! * (yf - 1), u),
      v,
    );
  };
})();

/** Sum several octaves of Perlin noise for fractal detail. */
function fbm(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += perlinNoise(x * freq, y * freq) * amp;
    freq *= lacunarity;
    amp *= gain;
  }
  return sum;
}

/** Apply Perlin-based variation to every pixel of a canvas via ImageData. */
function applyPerlinNoise(
  ctx: CanvasRenderingContext2D,
  size: number,
  scale: number,
  strength: number,
  octaves: number,
) {
  const img = ctx.getImageData(0, 0, size, size);
  const data = img.data;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const n = fbm(px / scale, py / scale, octaves) * strength;
      const idx = (py * size + px) * 4;
      data[idx] = Math.max(0, Math.min(255, data[idx]! + n));
      data[idx + 1] = Math.max(0, Math.min(255, data[idx + 1]! + n));
      data[idx + 2] = Math.max(0, Math.min(255, data[idx + 2]! + n));
    }
  }
  ctx.putImageData(img, 0, 0);
}

function generateWallTexture(): THREE.CanvasTexture {
  const size = 512;
  const cvs = document.createElement("canvas");
  cvs.width = size;
  cvs.height = size;
  const ctx = cvs.getContext("2d")!;

  ctx.fillStyle = "#2e2e38";
  ctx.fillRect(0, 0, size, size);

  // Irregular dark stone blocks with visible mortar gaps.
  const rows = 8;
  const cols = 6;
  const blockH = size / rows;
  const blockW = size / cols;
  const mortar = 3;

  for (let row = 0; row < rows; row++) {
    const offset = (row % 2) * blockW * 0.5;
    for (let col = -1; col <= cols; col++) {
      const x = col * blockW + offset + (Math.random() - 0.5) * 4;
      const y = row * blockH + (Math.random() - 0.5) * 2;
      const w = blockW - mortar + (Math.random() - 0.5) * 8;
      const h = blockH - mortar + (Math.random() - 0.5) * 4;
      const shade = 38 + Math.floor(Math.random() * 22);
      ctx.fillStyle = `rgb(${shade}, ${shade}, ${shade + 8})`;
      ctx.fillRect(x + mortar / 2, y + mortar / 2, w, h);
    }
  }

  applyPerlinNoise(ctx, size, 64, 18, 4);

  const texture = new THREE.CanvasTexture(cvs);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

function generateFloorTexture(): THREE.CanvasTexture {
  const size = 512;
  const cvs = document.createElement("canvas");
  cvs.width = size;
  cvs.height = size;
  const ctx = cvs.getContext("2d")!;

  ctx.fillStyle = "#2a2a34";
  ctx.fillRect(0, 0, size, size);

  // Rounded cobblestones in a brick-like stagger.
  const rows = 10;
  const cols = 8;
  const stoneH = size / rows;
  const stoneW = size / cols;
  const gap = 4;

  for (let row = 0; row < rows; row++) {
    const offset = (row % 2) * stoneW * 0.5;
    for (let col = -1; col <= cols; col++) {
      const cx = col * stoneW + stoneW / 2 + offset + (Math.random() - 0.5) * 3;
      const cy = row * stoneH + stoneH / 2 + (Math.random() - 0.5) * 3;
      const rw = (stoneW - gap) / 2 + (Math.random() - 0.5) * 4;
      const rh = (stoneH - gap) / 2 + (Math.random() - 0.5) * 3;
      const shade = 38 + Math.floor(Math.random() * 25);
      ctx.fillStyle = `rgb(${shade}, ${shade}, ${shade + 6})`;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rw, rh, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  applyPerlinNoise(ctx, size, 48, 15, 4);

  const texture = new THREE.CanvasTexture(cvs);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

function generateDoorTexture(): THREE.CanvasTexture {
  const size = 512;
  const cvs = document.createElement("canvas");
  cvs.width = size;
  cvs.height = size;
  const ctx = cvs.getContext("2d")!;

  // Dark brown base.
  ctx.fillStyle = "#2e1a10";
  ctx.fillRect(0, 0, size, size);

  // Vertical planks in slightly varying brown shades.
  const plankCount = 6;
  const plankWidth = size / plankCount;
  for (let i = 0; i < plankCount; i++) {
    const shade = 34 + Math.floor(Math.random() * 16);
    ctx.fillStyle = `rgb(${shade + 12}, ${shade}, ${shade - 10})`;
    ctx.fillRect(i * plankWidth + 2, 0, plankWidth - 4, size);
  }

  // Dark grooves between planks.
  ctx.strokeStyle = "#1a0e08";
  ctx.lineWidth = 2;
  for (let i = 1; i < plankCount; i++) {
    ctx.beginPath();
    ctx.moveTo(i * plankWidth, 0);
    ctx.lineTo(i * plankWidth, size);
    ctx.stroke();
  }

  // Horizontal cross-braces at ~1/4 and ~3/4 height.
  const braceH = 28;
  for (const y of [size * 0.25 - braceH / 2, size * 0.75 - braceH / 2]) {
    ctx.fillStyle = "#221410";
    ctx.fillRect(0, y, size, braceH);
    ctx.strokeStyle = "#1a0e08";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(0, y, size, braceH);
  }

  // Rectangular barred window in the upper third.
  const winX = size * 0.2;
  const winY = size * 0.08;
  const winW = size * 0.6;
  const winH = size * 0.2;
  ctx.fillStyle = "#0a0a0e";
  ctx.fillRect(winX, winY, winW, winH);

  // Vertical bars across the window.
  const barCount = 4;
  const barSpacing = winW / (barCount + 1);
  ctx.strokeStyle = "#1a1a1e";
  ctx.lineWidth = 6;
  for (let i = 1; i <= barCount; i++) {
    const bx = winX + i * barSpacing;
    ctx.beginPath();
    ctx.moveTo(bx, winY);
    ctx.lineTo(bx, winY + winH);
    ctx.stroke();
  }

  ctx.strokeStyle = "#1a0e08";
  ctx.lineWidth = 3;
  ctx.strokeRect(winX, winY, winW, winH);

  applyPerlinNoise(ctx, size, 64, 14, 4);

  return new THREE.CanvasTexture(cvs);
}

export function createStage(canvas: HTMLCanvasElement): Stage {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x111111);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x111111, BOARD_W * 0.6, BOARD_W * 2.0);

  const wallTexture = generateWallTexture();
  const floorTexture = generateFloorTexture();

  const camera = new THREE.PerspectiveCamera(50, WORLD_WIDTH / WORLD_HEIGHT, 0.1, 300);

  // ------------------------------------------------------------------ lights

  // Same reasoning as the real-time room: bright enough to read the board at a
  // glance. A murky dungeon loses a charcoal wolf against grey stone, and here
  // you also have to be able to count squares.
  scene.add(new THREE.AmbientLight(0x6e779c, 2.7));
  scene.add(new THREE.HemisphereLight(0x9aa2cc, 0x46392a, 1.7));

  const sun = new THREE.DirectionalLight(0xffe9c4, 2.6);
  sun.position.set(BOARD_CX - BOARD_W * 0.55, BOARD_W * 1.7, BOARD_CZ + BOARD_W * 1.1);
  sun.target.position.set(BOARD_CX, 0, BOARD_CZ);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const shadowExtent = BOARD_W * 0.95;
  sun.shadow.camera.left = -shadowExtent;
  sun.shadow.camera.right = shadowExtent;
  sun.shadow.camera.top = shadowExtent;
  sun.shadow.camera.bottom = -shadowExtent;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = BOARD_W * 4.5;
  sun.shadow.bias = -0.0009;
  scene.add(sun);
  scene.add(sun.target);

  // ------------------------------------------------------------------- floor

  /**
   * A slab of noisy stone. A few centimetres of displacement per vertex so flat
   * shading has something to catch — a perfectly flat plane reads as a void
   * rather than as a floor — and one shade per vertex on top of that.
   */
  const stoneFloor = (w: number, d: number) => {
    const geometry = new THREE.PlaneGeometry(w, d, Math.ceil(w), Math.ceil(d));
    geometry.rotateX(-Math.PI / 2);

    const position = geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < position.count; i++) {
      position.setY(i, (Math.random() - 0.5) * 0.05);
    }
    geometry.computeVertexNormals();

    const tex = floorTexture.clone();
    tex.repeat.set(w / TEXTURE_SCALE, d / TEXTURE_SCALE);
    const floor = new THREE.Mesh(
      geometry,
      new THREE.MeshLambertMaterial({ map: tex, flatShading: true }),
    );
    floor.receiveShadow = true;
    return floor;
  };

  // The apron: darker stone running out past the walls, so the camera looking
  // in from outside sees a dungeon continuing into the dark rather than a hole.
  // It has to cover both rooms and the hall between them, so it is sized from
  // the whole complex rather than from the board.
  const apronW = CHAMBER_W * 3;
  const apronD = (FAR_CZ - BOARD_CZ) + CHAMBER_D * 3;
  const apronTex = floorTexture.clone();
  apronTex.repeat.set(apronW / TEXTURE_SCALE, apronD / TEXTURE_SCALE);
  const apron = new THREE.Mesh(
    new THREE.PlaneGeometry(apronW, apronD).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ map: apronTex, color: 0x606068, flatShading: true }),
  );
  apron.position.set(BOARD_CX, -0.06, (BOARD_CZ + FAR_CZ) / 2);
  scene.add(apron);

  // -------------------------------------------------------------------- walls

  // ------------------------------------------------------------------- doors

  interface Door {
    group: THREE.Group;
    mesh: THREE.Mesh;
    open: boolean;
    angle: number;
    target: number;
  }
  const doors: Door[] = [];

  const capMaterial = new THREE.MeshLambertMaterial({ color: 0x4c4c58, flatShading: true });

  const addWall = (w: number, d: number, x: number, z: number, height = WALL_H) => {
    const tex = wallTexture.clone();
    tex.repeat.set(Math.max(w, d) / TEXTURE_SCALE, height / TEXTURE_SCALE);
    const mat = new THREE.MeshLambertMaterial({ map: tex, flatShading: true });
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, height, d), mat);
    wall.position.set(x, height / 2, z);
    wall.castShadow = true;
    wall.receiveShadow = true;
    scene.add(wall);

    const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.18, 0.2, d + 0.18), capMaterial);
    cap.position.set(x, height + 0.1, z);
    cap.castShadow = true;
    scene.add(cap);
  };

  const west = BOARD_X0 - MARGIN;
  const east = BOARD_X0 + BOARD_W + MARGIN;

  const archLeft = ARCH_CENTRE - PASSAGE_W / 2;
  const archRight = ARCH_CENTRE + PASSAGE_W / 2;

  /** An east-west wall built in two stretches, with the passage's gap in it. */
  const addPiercedWall = (z: number) => {
    const westSpan = archLeft - (west - WALL_T);
    addWall(westSpan, WALL_T, west - WALL_T + westSpan / 2, z);
    const eastSpan = east + WALL_T - archRight;
    addWall(eastSpan, WALL_T, archRight + eastSpan / 2, z);
  };

  /** Jambs and a lintel around a gap, so it reads as a doorway and not a hole. */
  const addDoorFrame = (z: number) => {
    for (const x of [archLeft + 0.17, archRight - 0.17]) {
      const postTex = wallTexture.clone();
      postTex.repeat.set(Math.max(0.34, WALL_T + 0.3) / TEXTURE_SCALE, (WALL_H + 0.5) / TEXTURE_SCALE);
      const postMat = new THREE.MeshLambertMaterial({ map: postTex, flatShading: true });
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.34, WALL_H + 0.5, WALL_T + 0.3), postMat);
      post.position.set(x, (WALL_H + 0.5) / 2, z);
      post.castShadow = true;
      scene.add(post);
    }
    const lintelTex = wallTexture.clone();
    lintelTex.repeat.set((PASSAGE_W + 0.5) / TEXTURE_SCALE, Math.max(0.4, WALL_T + 0.4) / TEXTURE_SCALE);
    const lintelMat = new THREE.MeshLambertMaterial({ map: lintelTex, flatShading: true });
    const lintel = new THREE.Mesh(
      new THREE.BoxGeometry(PASSAGE_W + 0.5, 0.4, WALL_T + 0.4),
      lintelMat,
    );
    lintel.position.set(ARCH_CENTRE, WALL_H + 0.3, z);
    lintel.castShadow = true;
    scene.add(lintel);

    // The door: a thick wooden slab like a wall, hinged at the left jamb.
    const doorWidth = PASSAGE_W - 0.34;
    const DOOR_DEPTH = 4;     // thick as a wall — can't clip through
    const doorTex = generateDoorTexture();
    const doorMat = new THREE.MeshLambertMaterial({ map: doorTex, flatShading: true });
    const doorMesh = new THREE.Mesh(
      new THREE.BoxGeometry(doorWidth, WALL_H, DOOR_DEPTH),
      doorMat,
    );
    doorMesh.position.set(doorWidth / 2, WALL_H / 2, 0);
    doorMesh.castShadow = true;
    doorMesh.receiveShadow = true;

    // Two dark blocker walls on either side of the door. They sit flush
    // against its front and back faces and extend well past the passage
    // width, so the camera can never peek around the door's edges. They
    // swing with the door group and are hidden when the door opens.
    const blockerMat = new THREE.MeshBasicMaterial({ color: 0x111111, fog: false });
    const BLOCKER_W = PASSAGE_W + 4;   // wider than the passage
    const BLOCKER_H = WALL_H + 2;      // taller than the wall
    const frontBlocker = new THREE.Mesh(
      new THREE.PlaneGeometry(BLOCKER_W, BLOCKER_H),
      blockerMat,
    );
    frontBlocker.position.set(doorWidth / 2, BLOCKER_H / 2, -DOOR_DEPTH / 2 - 0.01);

    const backBlocker = new THREE.Mesh(
      new THREE.PlaneGeometry(BLOCKER_W, BLOCKER_H),
      blockerMat,
    );
    backBlocker.position.set(doorWidth / 2, BLOCKER_H / 2, DOOR_DEPTH / 2 + 0.01);
    backBlocker.rotation.y = Math.PI;  // face the other way

    // Horizontal ceiling that blocks the overhead camera from seeing past
    // the door. Extends generously so no orbit angle can peek under.
    const CEILING_DEPTH = 30;
    const ceiling = new THREE.Mesh(
      new THREE.PlaneGeometry(BLOCKER_W, CEILING_DEPTH),
      new THREE.MeshBasicMaterial({ color: 0x0a0a0a, fog: false, side: THREE.DoubleSide }),
    );
    ceiling.rotation.x = -Math.PI / 2;
    ceiling.position.set(doorWidth / 2, WALL_H + 0.05, 0);

    const doorGroup = new THREE.Group();
    doorGroup.position.set(archLeft + 0.17, 0, z);
    doorGroup.add(doorMesh);
    doorGroup.add(frontBlocker);
    doorGroup.add(backBlocker);
    doorGroup.add(ceiling);
    scene.add(doorGroup);

    doors.push({ group: doorGroup, mesh: doorMesh, open: false, angle: 0, target: 0 });
  };

  // ------------------------------------------------------------- a chamber
  //
  // Nothing is drawn on the floor of one. The board used to be nine raised
  // flagstones, because back then the grid *was* the game and you hopped from
  // one square to the next. Now that a cell is a fraction of a pace and you stop
  // wherever you like, ruling the floor would advertise a lattice the player
  // never has to think about — the same reason the real-time room leaves its
  // tile grid undrawn. Where you may go isn't drawn either — a disc of reachable
  // ground around the player was tried and removed: it read as a thing painted
  // on the floor rather than as a statement about this turn, and it followed you
  // around the board all game. The footfall ring under the cursor carries the
  // range instead, one click at a time.
  //
  // A slightly lighter slab marks the fighting ground so the arena still reads
  // as a place, with no lines on it.

  const TORCH_INSET = 0.25;
  const torches: Array<ReturnType<typeof buildTorch>> = [];

  const addTorch = (x: number, z: number, yaw: number) => {
    const torch = buildTorch();
    torch.group.position.set(x, 1.9, z);
    torch.group.rotation.y = yaw;
    scene.add(torch.group);
    torches.push(torch);
  };

  /**
   * One room, and the only room there is: floor, four walls with the passage's
   * gap in one of them, and a torch at the midpoint of each wall.
   *
   * The far room is this same call with the gap on its north side — which is
   * what "identical" means here. There is one room, built twice, so anything
   * done to the arena is done to what you see through the arch by construction.
   */
  const buildChamber = (cz: number, doorway: "north" | "south") => {
    const floor = stoneFloor(CHAMBER_W, CHAMBER_D);
    floor.position.set(BOARD_CX, 0, cz);
    scene.add(floor);

    const north = cz - CHAMBER_D / 2;
    const south = cz + CHAMBER_D / 2;

    addWall(WALL_T, CHAMBER_D + WALL_T * 2, west - WALL_T / 2, cz);
    addWall(WALL_T, CHAMBER_D + WALL_T * 2, east + WALL_T / 2, cz);

    // The pierced wall is the one the hallway leaves by; the other is solid.
    const northZ = north - WALL_T / 2;
    const southZ = south + WALL_T / 2;
    if (doorway === "south") {
      addWall(CHAMBER_W + WALL_T * 2, WALL_T, BOARD_CX, northZ);
      addPiercedWall(southZ);
      addDoorFrame(southZ);
    } else {
      addPiercedWall(northZ);
      addDoorFrame(northZ);
      addWall(CHAMBER_W + WALL_T * 2, WALL_T, BOARD_CX, southZ);
    }

    // One bracket at the midpoint of each wall. These are the walls' *inner*
    // faces, so each offset points into the room — get the sign wrong and the
    // torch is buried in its own masonry.
    //
    // The one over the doorway sits on the middle column, not over the arch
    // itself: the passage has its own light spilling through it, and a torch
    // there would wash the glow out rather than add to it.
    addTorch(BOARD_CX, north + TORCH_INSET, -Math.PI / 2); // north wall, face +Z
    addTorch(BOARD_CX, south - TORCH_INSET, Math.PI / 2); // south wall, face -Z
    addTorch(west + TORCH_INSET, cz, 0);                  // west wall, face +X
    addTorch(east - TORCH_INSET, cz, Math.PI);             // east wall, face -X
  };

  buildChamber(BOARD_CZ, "south");
  buildChamber(FAR_CZ, "north");

  // ------------------------------------------------------------ the hallway

  // Between the two doorways: floor, two long walls a passage-width apart, and a
  // torch on each side at the halfway mark. Nothing else — it is a distance to
  // be crossed, and the room at the end of it should be the thing you look at.
  const hallZ0 = BOARD_CZ + CHAMBER_D / 2 + WALL_T;
  const hallCZ = hallZ0 + HALL_LEN / 2;

  const hallFloor = stoneFloor(PASSAGE_W + WALL_T * 2, HALL_LEN);
  hallFloor.position.set(ARCH_CENTRE, 0, hallCZ);
  scene.add(hallFloor);

  addWall(WALL_T, HALL_LEN, archLeft - WALL_T / 2, hallCZ);
  addWall(WALL_T, HALL_LEN, archRight + WALL_T / 2, hallCZ);

  addTorch(archLeft + TORCH_INSET, hallCZ, 0);       // left wall, face +X
  addTorch(archRight - TORCH_INSET, hallCZ, Math.PI); // right wall, face -X

  // --------------------------------------------------------------- the arch

  // A lamp in the doorway, and nothing in the way of it.
  //
  // Both of the marks that used to be here are gone with the escape rule they
  // belonged to: the amber ring on the floor said "stand here and the encounter
  // ends", and the warm plane hanging in the opening was the light of somewhere
  // else. The doorway is a door now — you walk through it — and a glowing
  // curtain across a thing you can walk through reads as a barrier.
  const southZ = BOARD_CZ + CHAMBER_D / 2 + WALL_T / 2;
  const archLight = new THREE.PointLight(0xffb45a, 5, BOARD_W, 2);
  archLight.position.set(ARCH_CENTRE, 1.6, southZ - 0.6);
  scene.add(archLight);

  // ------------------------------------------------------------- highlights

  /**
   * Where the cursor would put you. Small, so it reads as a footfall.
   *
   * With no disc around the player, this is the whole of the answer to "where
   * can I go": it sits on the cell a click would land on, and goes dark red when
   * that cell is out of this turn's reach or has somebody standing in it.
   */
  const destinationGeometry = new THREE.RingGeometry(STRIDE * 0.12, STRIDE * 0.17, 24);
  destinationGeometry.rotateX(-Math.PI / 2);
  const destinationMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false,
  });
  const destination = new THREE.Mesh(destinationGeometry, destinationMaterial);
  destination.visible = false;
  scene.add(destination);

  const targetRingGeometry = new THREE.RingGeometry(STRIDE * 0.31, STRIDE * 0.38, 32);
  targetRingGeometry.rotateX(-Math.PI / 2);
  const targetRingMaterial = new THREE.MeshBasicMaterial({
    color: 0xffd633, transparent: true, opacity: 0.9, depthWrite: false,
  });
  const targetRing = new THREE.Mesh(targetRingGeometry, targetRingMaterial);
  targetRing.visible = false;
  scene.add(targetRing);


  // ------------------------------------------------------------------ camera

  // Start in first-person — the overhead view is disabled.
  let yaw = -Math.PI / 2; // facing east, matching the player's initial facing
  let pitch = FP_PITCH_START;
  let distance = CAMERA_START_DISTANCE;

  /**
   * What the camera is framing, before the drag offset: **the board while the
   * player is standing on it, and the player once they have left it.**
   *
   * The board is the subject of this game, so pinning the view to it is right
   * for the whole of a fight — and became wrong the moment the door opened,
   * because a player who walks into the corridor walks out of the frame and
   * behind the south wall. Following only off the board keeps the fight framed
   * exactly as it was and costs nothing until you leave.
   */
  const home = new THREE.Vector3(BOARD_CX, 0, BOARD_CZ);
  /** A drag's displacement from that, kept within `PAN_LIMIT` of it. */
  const panOffset = { x: 0, z: 0 };

  /** Where the camera looks: what it is framing, plus wherever you dragged it. */
  const focus = new THREE.Vector3(BOARD_CX, 0, BOARD_CZ);
  const applyFocus = () => focus.set(home.x + panOffset.x, 0, home.z + panOffset.z);
  /** Smoothed copy, so a wheel notch or a released drag settles instead of snapping. */
  const smoothed = { yaw, pitch, distance, x: BOARD_CX, z: BOARD_CZ };

  /**
   * **First person is the same rig with the distance taken out.** `yaw` and
   * `pitch` stop saying where the camera hangs around the board and start saying
   * which way the player is looking out of their own eyes.
   *
   * They therefore mean different things in the two modes, and each mode keeps
   * its own pair. Overhead, pitch is an angle *down* at the floor that never
   * approaches the horizon, and yaw is which corner you are watching the fight
   * from; from the eyes, the horizon is the middle of the pitch range and yaw is
   * the way you are facing. **Entering first person looks the way the character
   * is facing** rather than the way the camera was — the two are unrelated, and
   * inheriting the camera's yaw drops you nose-first into whichever wall it
   * happened to be behind. Leaving puts the overhead view back exactly as you
   * left it, so F is a look through the eyes and not a loss of your framing.
   */
  let firstPerson = true;
  let overheadPitch = PITCH_START;
  let overheadYaw = 0;

  /** The player's head, in scene units — where the eyes are when they are ours. */
  const eye = new THREE.Vector3(BOARD_CX, EYE_HEIGHT, BOARD_CZ);
  const forward = new THREE.Vector3();
  /** Which way the player's model is facing: +1 east, -1 west. */
  let playerFacing: 1 | -1 = 1;

  const clampPitch = (value: number) =>
    firstPerson ? clamp(value, FP_PITCH_MIN, FP_PITCH_MAX) : clamp(value, PITCH_MIN, PITCH_MAX);

  const applyCamera = () => {
    if (firstPerson) {
      // Straight out of the head, along the same yaw/pitch the orbit uses: the
      // overhead camera looks from `+(sin yaw, ., cos yaw)` back at its focus,
      // so the direction it is facing is the negative of that.
      camera.position.set(eye.x, eye.y, eye.z);
      forward.set(
        -Math.sin(smoothed.yaw) * Math.cos(smoothed.pitch),
        -Math.sin(smoothed.pitch),
        -Math.cos(smoothed.yaw) * Math.cos(smoothed.pitch),
      );
      camera.lookAt(eye.x + forward.x, eye.y + forward.y, eye.z + forward.z);
    } else {
      const horizontal = Math.cos(smoothed.pitch) * smoothed.distance;
      let camZ = smoothed.z + Math.cos(smoothed.yaw) * horizontal;

      // Keep both the camera and its look-target on the focus's side of any
      // closed door, well clear of it so the frustum cannot peek through.
      let lookZ = smoothed.z;
      const DOOR_CAM_MARGIN = 3;
      for (const door of doors) {
        if (door.open) continue;
        const dz = door.group.position.z;
        if (smoothed.z < dz) {
          if (camZ > dz - DOOR_CAM_MARGIN) camZ = dz - DOOR_CAM_MARGIN;
          if (lookZ > dz - DOOR_CAM_MARGIN) lookZ = dz - DOOR_CAM_MARGIN;
        } else {
          if (camZ < dz + DOOR_CAM_MARGIN) camZ = dz + DOOR_CAM_MARGIN;
          if (lookZ < dz + DOOR_CAM_MARGIN) lookZ = dz + DOOR_CAM_MARGIN;
        }
      }

      camera.position.set(
        smoothed.x + Math.sin(smoothed.yaw) * horizontal,
        Math.sin(smoothed.pitch) * smoothed.distance,
        camZ,
      );
      camera.lookAt(smoothed.x, 0.9, lookZ);
    }
    // Kept fresh here rather than left to the renderer: picking and the
    // overlay's world-label projection both run before the next render.
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  };
  applyCamera();

  // ----------------------------------------------------------------- picking

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hitPoint = new THREE.Vector3();
  const pickables: THREE.Object3D[] = [];

  return {
    scene,
    pickables,

    resize(displayWidth, displayHeight, dpr) {
      renderer.setPixelRatio(dpr);
      renderer.setSize(displayWidth, displayHeight, false);
      canvas.style.width = `${displayWidth}px`;
      canvas.style.height = `${displayHeight}px`;
      camera.aspect = WORLD_WIDTH / WORLD_HEIGHT;
      camera.updateProjectionMatrix();
    },

    zoom(delta) {
      // Nothing to pull the camera back from when it is your own head.
      if (firstPerson) return;
      distance = clamp(distance + delta, CAMERA_MIN_DISTANCE, CAMERA_MAX_DISTANCE);
    },

    orbit(dx, dy) {
      // Dragging right swings the scene right, which means the camera goes the
      // other way around the board — and in first person the same turn of the
      // yaw is you looking right, which is the same gesture meaning the same
      // thing from inside instead of outside.
      yaw -= dx * ROTATE_SPEED;
      // The vertical flips, though. Overhead the drag pulls the *scene*, so
      // dragging down tips the board up toward the horizon; from the eyes it
      // moves your *head*, and a head that looked up when you dragged down
      // would be the one control in here fighting the hand holding it.
      const step = dy * ROTATE_SPEED * 0.8;
      pitch = clampPitch(firstPerson ? pitch + step : pitch - step);
    },

    toggleFirstPerson() {
      firstPerson = !firstPerson;
      if (firstPerson) {
        overheadPitch = pitch;
        overheadYaw = yaw;
        pitch = FP_PITCH_START;
        // The camera looks along `-(sin yaw, ., cos yaw)`, so a quarter turn
        // either way is due east or due west — which is the whole of what a
        // `facing` says.
        yaw = playerFacing === 1 ? -Math.PI / 2 : Math.PI / 2;
      } else {
        pitch = overheadPitch;
        yaw = overheadYaw;
      }
      // The eye teleports either way, so easing the turn across the cut would
      // only add a spin to it.
      smoothed.pitch = pitch;
      smoothed.yaw = yaw;
      applyCamera();
      return firstPerson;
    },

    get firstPerson() {
      return firstPerson;
    },

    get yaw() {
      return yaw;
    },

    pan(dx, dy) {
      // A pan is a drag of the board, and in first person there is no board to
      // drag — you are standing on it.
      if (firstPerson) return;
      // Screen right/up, expressed on the floor at the current yaw — so a drag
      // pulls the room the way the hand went whichever way the view is facing.
      const scale = PAN_SPEED * (distance / CAMERA_START_DISTANCE);
      const rightX = Math.cos(yaw);
      const rightZ = -Math.sin(yaw);
      const forwardX = Math.sin(yaw);
      const forwardZ = Math.cos(yaw);

      panOffset.x = clamp(panOffset.x - (dx * rightX + dy * forwardX) * scale, -PAN_LIMIT, PAN_LIMIT);
      panOffset.z = clamp(panOffset.z - (dx * rightZ + dy * forwardZ) * scale, -PAN_LIMIT, PAN_LIMIT);
      applyFocus();
    },

    follow(px, py, facing) {
      playerFacing = facing;
      // The eyes ride the *interpolated* position undamped: this is the one
      // point in the scene that has to be exactly where the player is, and a
      // damped head lags a half-step behind its own body on every walk.
      eye.set(toX(px), EYE_HEIGHT, toZ(py));

      // On the board, the board. Off it — in the corridor or the far room —
      // them. `damp` in `update` does the rest, so stepping through the doorway
      // eases the view along instead of cutting to it.
      const cell = cellAtPoint({ x: px, y: py });
      const onBoard = cell !== null && inRegion(BOARD_REGION, cell);
      home.set(onBoard ? BOARD_CX : toX(px), 0, onBoard ? BOARD_CZ : toZ(py));
      applyFocus();
    },

    resetView() {
      // Reset the first-person view to face the character's direction.
      pitch = FP_PITCH_START;
      yaw = playerFacing === 1 ? -Math.PI / 2 : Math.PI / 2;
      smoothed.pitch = pitch;
      smoothed.yaw = yaw;
      applyCamera();
    },

    update(dt) {
      smoothed.yaw = damp(smoothed.yaw, yaw, 16, dt);
      smoothed.pitch = damp(smoothed.pitch, pitch, 16, dt);
      smoothed.distance = damp(smoothed.distance, distance, 12, dt);
      smoothed.x = damp(smoothed.x, focus.x, 14, dt);
      smoothed.z = damp(smoothed.z, focus.z, 14, dt);
      applyCamera();

      for (const door of doors) {
        door.angle = damp(door.angle, door.target, 8, dt);
        door.group.rotation.y = door.angle;
      }
    },

    groundAt(ndcX, ndcY) {
      ndc.set(ndcX, ndcY);
      raycaster.setFromCamera(ndc, camera);
      if (!raycaster.ray.intersectPlane(groundPlane, hitPoint)) return null;
      return { x: toPixelX(hitPoint.x), y: toPixelY(hitPoint.z) };
    },

    pickAt(ndcX, ndcY) {
      if (pickables.length === 0) return null;
      ndc.set(ndcX, ndcY);
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(pickables, true);
      return hits.length > 0 ? hits[0]!.object : null;
    },

    project(point) {
      const projected = point.clone().project(camera);
      // A point behind the camera comes back through the projection mirrored,
      // and would draw its label or its damage number somewhere arbitrary on
      // screen. Overhead nothing the overlay labels is ever behind the camera;
      // in first person your own head is, every time something bites you.
      if (projected.z > 1) return { x: -WORLD_WIDTH, y: -WORLD_HEIGHT };
      return {
        x: ((projected.x + 1) / 2) * WORLD_WIDTH,
        y: ((1 - projected.y) / 2) * WORLD_HEIGHT,
      };
    },

    setDestination(px, py, allowed) {
      destination.visible = px !== null && py !== null;
      if (px === null || py === null) return;
      destinationMaterial.color.setHex(allowed ? 0xffffff : 0x8a4040);
      destinationMaterial.opacity = allowed ? 0.85 : 0.45;
      destination.position.set(toX(px), 0.13, toZ(py));
    },

    setTargetRing(px, py, color) {
      if (px === null || py === null) {
        targetRing.visible = false;
        return;
      }
      targetRing.visible = true;
      targetRingMaterial.color.setHex(color);
      targetRing.position.set(toX(px), 0.14, toZ(py));
    },

    toggleDoorAt(ndcX, ndcY) {
      if (doors.length === 0) return null;
      ndc.set(ndcX, ndcY);
      raycaster.setFromCamera(ndc, camera);
      const doorMeshes = doors.map((d) => d.mesh);
      const hits = raycaster.intersectObjects(doorMeshes, false);
      if (hits.length === 0) return null;
      const hitMesh = hits[0]!.object;
      const idx = doors.findIndex((d) => d.mesh === hitMesh);
      return idx >= 0 ? idx : null;
    },

    updateDoors(doorsClosed) {
      if (!doorsClosed) return;
      for (let i = 0; i < doors.length; i++) {
        const door = doors[i]!;
        const closed = doorsClosed[i] ?? true;
        door.open = !closed;
        door.target = closed ? 0 : -Math.PI / 2;
      }
    },

    animateScenery(elapsed) {
      torches.forEach((torch, i) => {
        const flicker = 0.82 + Math.sin(elapsed * 9 + i * 1.7) * 0.09 + Math.sin(elapsed * 23 + i) * 0.05;
        torch.flame.scale.setScalar(0.85 + flicker * 0.25);
        // Ten brackets — four to a room and two down the hall. Each has a whole
        // wall to carry, but the rooms are small enough that the real-time
        // game's brightness would wash their floors out.
        torch.light.intensity = 8 * flicker;
      });
      // The doorway breathes with the same beat the torches keep, so the way
      // through still draws the eye without being a marker.
      archLight.intensity = 4.5 + Math.sin(elapsed * 2.2) * 1.1;
    },

    render() {
      renderer.render(scene, camera);
    },
  };
}

/** Board dimensions the client's own code needs — kept with the board itself. */
export const BOARD = { x0: BOARD_X0, z0: BOARD_Z0, w: BOARD_W, d: BOARD_D, stride: STRIDE };
