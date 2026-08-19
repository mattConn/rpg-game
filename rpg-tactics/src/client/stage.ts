/**
 * The board: a lit stone chamber with nine flagstones in it, and the camera rig
 * that looks at them.
 *
 * The dungeon look is the real-time game's — flat-shaded stone, fog eating the
 * far dark — but the room is a different room, so this is built here rather than
 * imported. The walls carry no torches: the rooms are lit by the ambient,
 * hemisphere and directional rig alone, with the one warm point light left being
 * the lamp in the doorway.
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
import { damp, toPixelX, toPixelY, toX, toZ } from "../../../rpg-3d/src/client/world.js";
import {
  ARENA_H,
  ARENA_W,
  ARENA_X,
  ARENA_Y,
  BOARD_REGION,
  CHAMBER_MARGIN_PX,
  DOORWAY_WIDTH_PX,
  type DoorId,
  type DoorStates,
  FAR_REGION,
  HALL_REGION,
  SQUARE_PX,
  TILE_PX,
  WALL_THICKNESS_PX,
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
const FAR_W = toX(FAR_REGION.cols * TILE_PX);
const FAR_D = toZ(FAR_REGION.rows * TILE_PX);
const FAR_CX = toX(regionCentre(FAR_REGION).x);

/** Bare floor between the flagstones and the masonry. */
const MARGIN = toX(CHAMBER_MARGIN_PX);

const WALL_H = 5.6;
const WALL_T = toX(WALL_THICKNESS_PX);

/** A chamber: the board plus its margin of bare floor. 12x12 units. */
const START_CHAMBER_W = BOARD_W + MARGIN * 2;
const START_CHAMBER_D = BOARD_D + MARGIN * 2;
const FAR_CHAMBER_W = FAR_W + MARGIN * 2;
const FAR_CHAMBER_D = FAR_D + MARGIN * 2;

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
const HALL_W = toX(HALL_REGION.cols * TILE_PX);
const DOOR_W = toX(DOORWAY_WIDTH_PX);
const ARCH_CENTRE = toX(regionCentre(HALL_REGION).x);

/** The far chamber sits on its own region, a corridor's length to the south. */
const FAR_CZ = toZ(regionCentre(FAR_REGION).y);

/** What is left for the hall itself once both chambers' walls are accounted for. */
const HALL_LEN = FAR_CZ - BOARD_CZ
  - START_CHAMBER_D / 2 - FAR_CHAMBER_D / 2 - WALL_T * 2;

/**
 * Framing is expressed as multiples of the board's width rather than in units,
 * so a change to `TILE_PX` carries the camera and the fog with it. Fixed numbers
 * here would quietly leave the view halfway across the dungeon the first time
 * the squares were resized.
 */
const CAMERA_MIN_DISTANCE = BOARD_W * 0.42;
const CAMERA_MAX_DISTANCE = BOARD_W * 1.15;
const CAMERA_START_DISTANCE = CAMERA_MIN_DISTANCE;

/**
 * Full vertical orbit: almost level with the floor at one end and almost
 * perfectly top-down at the other. Tiny margins avoid singular camera maths.
 */
const PITCH_MIN = 0.03;
const PITCH_MAX = Math.PI / 2 - 0.01;
const PITCH_START = 0.16;

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
/**
 * How far the view turns against how far the cursor moved.
 *
 * **1 is the natural scale** — the angle the drag actually subtends, so the
 * world keeps pace with the hand — and that is slower than it sounds: a drag
 * clean across the screen turns you only the width of the screen, 79deg at this
 * fov and aspect. At 4 the same drag comes round about 317deg, near a full turn.
 *
 * For scale, the pixels-to-radians constant this replaced (`ROTATE_SPEED`, still
 * used by the overhead orbit) worked out around 880deg for that drag on a wide
 * window — and, being priced in pixels rather than in fov, got twice as
 * sensitive whenever the window doubled. This is the one dial to turn.
 */
const LOOK_GAIN = 4;
const PAN_SPEED = 0.03;

/** How far a drag may push the view off whatever the camera is framing. */
const PAN_LIMIT = BOARD_W * 0.7;

export interface Stage {
  readonly scene: THREE.Scene;
  readonly pickables: THREE.Object3D[];
  /**
   * `viewWidth` is the room width the 2D overlay is drawing at. The camera's
   * aspect has to agree with it, or the world and the UI over it disagree about
   * where the middle of the screen is — and `project` puts damage numbers in
   * the wrong place.
   */
  resize(displayWidth: number, displayHeight: number, dpr: number, viewWidth: number): void;
  zoom(delta: number): void;
  /** Orbit the view. Deltas are in screen pixels. */
  orbit(dx: number, dy: number): void;
  /** Slide the look-at point across the floor. Deltas are in screen pixels. */
  pan(dx: number, dy: number): void;
  /** Turn the view by a drag, given in NDC deltas. */
  look(dNdcX: number, dNdcY: number): void;
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
  /** Turn the view a half-circle on the spot. */
  flip(): void;
  update(dt: number): void;
  groundAt(ndcX: number, ndcY: number): { x: number; y: number } | null;
  pickAt(ndcX: number, ndcY: number): THREE.Object3D | null;
  project(point: THREE.Vector3): { x: number; y: number };
  /** Show a faint floor marker, colored for enemies and interactables. */
  setCursorRing(px: number | null, py: number | null, kind: "floor" | "enemy" | "interactable"): void;
  setTargetRing(px: number | null, py: number | null, color: number): void;
  setDoorTargetRing(door: DoorId): void;
  setDoorHoverRing(door: DoorId | null): void;
  doorAt(ndcX: number, ndcY: number): DoorId | null;
  setDoors(doors: DoorStates): void;
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

export function createStage(canvas: HTMLCanvasElement): Stage {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  /**
   * **No shadows, but every light still lights.** This is the one switch for it:
   * with the shadow map off, three renders no shadow pass at all and the
   * `castShadow` / `receiveShadow` flags left on the meshes and the sun below
   * simply do nothing. Nothing about illumination changes — the ambient,
   * hemisphere and directional lights all contribute exactly as before, because
   * a Lambert surface's brightness is the lights hitting it and the shadow map
   * only ever subtracted from that.
   *
   * The rig is deliberately left standing rather than stripped out, so turning
   * shadows back on is this line rather than an archaeology exercise.
   */
  renderer.shadowMap.enabled = false;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x111111);

  const scene = new THREE.Scene();
  /**
   * **The dark closes in near.** Multiples of the board's width, like the camera
   * framing above, so resizing the squares carries the murk with it rather than
   * leaving it stranded at a fixed distance.
   *
   * The broad range keeps nearby rooms crisp and lets visible corridors recede
   * gradually into darkness instead of being swallowed just beyond one wall.
   * The near plane matters as much as the far one — start it too far out and
   * the fog reads as a wall of haze hanging at a fixed distance instead of air.
   */
  scene.fog = new THREE.Fog(0x111111, BOARD_W * 0.95, BOARD_W * 3.2);

  const loadStoneTexture = (path: string) => {
    const texture = new THREE.TextureLoader().load(path);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return texture;
  };

  const wallTexture = loadStoneTexture("/textures/dungeon-wall-stone.png");
  const floorTexture = loadStoneTexture("/textures/dungeon-floor-stone.png");

  const camera = new THREE.PerspectiveCamera(50, WORLD_WIDTH / WORLD_HEIGHT, 0.1, 300);
  /** Room units across the canvas — kept in step with the camera by `resize`. */
  let roomWidth = WORLD_WIDTH;

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
  const westmost = Math.min(BOARD_CX - START_CHAMBER_W / 2, FAR_CX - FAR_CHAMBER_W / 2);
  const eastmost = Math.max(BOARD_CX + START_CHAMBER_W / 2, FAR_CX + FAR_CHAMBER_W / 2);
  const apronW = (eastmost - westmost) * 3;
  const apronD = (FAR_CZ - BOARD_CZ) + START_CHAMBER_D + FAR_CHAMBER_D;
  const apronTex = floorTexture.clone();
  apronTex.repeat.set(apronW / TEXTURE_SCALE, apronD / TEXTURE_SCALE);
  const apron = new THREE.Mesh(
    new THREE.PlaneGeometry(apronW, apronD).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ map: apronTex, color: 0x606068, flatShading: true }),
  );
  apron.position.set((westmost + eastmost) / 2, -0.06, (BOARD_CZ + FAR_CZ) / 2);
  scene.add(apron);

  // -------------------------------------------------------------------- walls

  const capMaterial = new THREE.MeshLambertMaterial({ color: 0x4c4c58, flatShading: true });
  const wallOccluders: THREE.Mesh[] = [];
  const addWall = (w: number, d: number, x: number, z: number, height = WALL_H) => {
    const tex = wallTexture.clone();
    tex.repeat.set(Math.max(w, d) / TEXTURE_SCALE, height / TEXTURE_SCALE);
    const mat = new THREE.MeshLambertMaterial({ map: tex, flatShading: true });
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, height, d), mat);
    wall.position.set(x, height / 2, z);
    wall.castShadow = true;
    wall.receiveShadow = true;
    scene.add(wall);
    wall.updateMatrixWorld();
    wallOccluders.push(wall);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.18, 0.2, d + 0.18), capMaterial);
    cap.position.set(x, height + 0.1, z);
    cap.castShadow = true;
    scene.add(cap);
  };

  const archLeft = ARCH_CENTRE - DOOR_W / 2;
  const archRight = ARCH_CENTRE + DOOR_W / 2;
  const hallLeft = ARCH_CENTRE - HALL_W / 2;
  const hallRight = ARCH_CENTRE + HALL_W / 2;

  /** An east-west wall built in two stretches, with the passage's gap in it. */
  const addPiercedWall = (z: number, west: number, east: number) => {
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
    lintelTex.repeat.set((DOOR_W + 0.5) / TEXTURE_SCALE, Math.max(0.4, WALL_T + 0.4) / TEXTURE_SCALE);
    const lintelMat = new THREE.MeshLambertMaterial({ map: lintelTex, flatShading: true });
    const lintel = new THREE.Mesh(
      new THREE.BoxGeometry(DOOR_W + 0.5, 0.4, WALL_T + 0.4),
      lintelMat,
    );
    lintel.position.set(ARCH_CENTRE, WALL_H + 0.3, z);
    lintel.castShadow = true;
    scene.add(lintel);
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

  /**
   * One room, and the only room there is: floor and four walls with the
   * passage's gap in one of them. Nothing hangs on the masonry.
   *
   * The far room is this same call with the gap on its north side — which is
   * what "identical" means here. There is one room, built twice, so anything
   * done to the arena is done to what you see through the arch by construction.
   */
  const buildChamber = (
    cx: number,
    cz: number,
    width: number,
    depth: number,
    doorway: "north" | "south",
  ) => {
    const floor = stoneFloor(width, depth);
    floor.position.set(cx, 0, cz);
    scene.add(floor);

    const west = cx - width / 2;
    const east = cx + width / 2;
    const north = cz - depth / 2;
    const south = cz + depth / 2;

    addWall(WALL_T, depth + WALL_T * 2, west - WALL_T / 2, cz);
    addWall(WALL_T, depth + WALL_T * 2, east + WALL_T / 2, cz);

    // The pierced wall is the one the hallway leaves by; the other is solid.
    const northZ = north - WALL_T / 2;
    const southZ = south + WALL_T / 2;
    if (doorway === "south") {
      addWall(width + WALL_T * 2, WALL_T, cx, northZ);
      addPiercedWall(southZ, west, east);
      addDoorFrame(southZ);
    } else {
      addPiercedWall(northZ, west, east);
      addDoorFrame(northZ);
      addWall(width + WALL_T * 2, WALL_T, cx, southZ);
    }
  };

  buildChamber(BOARD_CX, BOARD_CZ, START_CHAMBER_W, START_CHAMBER_D, "south");
  buildChamber(FAR_CX, FAR_CZ, FAR_CHAMBER_W, FAR_CHAMBER_D, "north");

  // --------------------------------------------------------------- doors

  const doors = new Map<DoorId, THREE.Group>();
  const doorSlabs = new Map<DoorId, THREE.Mesh>();
  const doorPickables: THREE.Object3D[] = [];
  // Doorways are bare arches. Keeping these collections empty preserves the
  // stage API while making them impossible to hover, target, or operate.

  // ------------------------------------------------------------ the hallway

  // Between the two doorways: floor and two long walls a passage-width apart.
  // Nothing else — it is a distance to be crossed, and the room at the end of it
  // should be the thing you look at.
  const hallZ0 = BOARD_CZ + START_CHAMBER_D / 2 + WALL_T;
  const hallCZ = hallZ0 + HALL_LEN / 2;

  const hallFloor = stoneFloor(HALL_W + WALL_T * 2, HALL_LEN);
  hallFloor.position.set(ARCH_CENTRE, 0, hallCZ);
  scene.add(hallFloor);

  addWall(WALL_T, HALL_LEN, hallLeft - WALL_T / 2, hallCZ);
  addWall(WALL_T, HALL_LEN, hallRight + WALL_T / 2, hallCZ);

  // --------------------------------------------------------------- the arch

  // A wall torch beside the near doorway: enough warm light to reveal the
  // wood, deliberately too dim to flatten the dungeon's blue-gray darkness.
  //
  // Both of the marks that used to be here are gone with the escape rule they
  // belonged to: the amber ring on the floor said "stand here and the encounter
  // ends", and the warm plane hanging in the opening was the light of somewhere
  // else. The old glowing curtain is still gone: the wooden slab now makes the
  // opening's state visible without pretending light itself is a barrier.
  const southZ = BOARD_CZ + START_CHAMBER_D / 2 + WALL_T / 2;
  const torchX = archLeft - 0.75;
  const torchZ = southZ - WALL_T * 0.72;

  const bracket = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045, 0.055, 0.42, 7),
    new THREE.MeshLambertMaterial({ color: 0x332d2a, flatShading: true }),
  );
  bracket.castShadow = true;
  bracket.rotation.x = -0.42;
  bracket.position.set(torchX, 1.73, torchZ - 0.08);
  scene.add(bracket);
  const ironCup = new THREE.Mesh(
    new THREE.CylinderGeometry(0.13, 0.075, 0.16, 7),
    new THREE.MeshLambertMaterial({ color: 0x403a36, flatShading: true }),
  );
  ironCup.castShadow = true;
  ironCup.position.set(torchX, 1.97, torchZ - 0.18);
  scene.add(ironCup);

  const outerFlameMaterial = new THREE.MeshBasicMaterial({
    color: 0xf06a24,
    transparent: true,
    opacity: 0.88,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const innerFlameMaterial = new THREE.MeshBasicMaterial({
    color: 0xffd86a,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const outerFlame = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.3, 7), outerFlameMaterial);
  outerFlame.position.set(torchX, 2.17, torchZ - 0.18);
  scene.add(outerFlame);
  const innerFlame = new THREE.Mesh(new THREE.ConeGeometry(0.048, 0.18, 7), innerFlameMaterial);
  innerFlame.position.set(torchX, 2.11, torchZ - 0.2);
  scene.add(innerFlame);

  const torchLight = new THREE.PointLight(0xff8a3d, 0.85, STRIDE * 2.4, 2);
  torchLight.position.set(torchX, 2.17, torchZ - 0.38);
  scene.add(torchLight);

  const EMBER_COUNT = 5;
  const emberPositions = new Float32Array(EMBER_COUNT * 3);
  const emberGeometry = new THREE.BufferGeometry();
  emberGeometry.setAttribute("position", new THREE.BufferAttribute(emberPositions, 3));
  const emberMaterial = new THREE.PointsMaterial({
    color: 0xff9b47,
    size: 0.035,
    transparent: true,
    opacity: 0.45,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const embers = new THREE.Points(emberGeometry, emberMaterial);
  scene.add(embers);

  // ------------------------------------------------------------- highlights

  const targetRingGeometry = new THREE.RingGeometry(STRIDE * 0.34, STRIDE * 0.365, 40);
  targetRingGeometry.rotateX(-Math.PI / 2);
  const targetRingMaterial = new THREE.MeshBasicMaterial({
    color: 0xffd633, transparent: true, opacity: 1, depthWrite: false,
  });
  const targetRing = new THREE.Mesh(targetRingGeometry, targetRingMaterial);
  targetRing.visible = false;
  scene.add(targetRing);

  const targetGlowGeometry = new THREE.RingGeometry(STRIDE * 0.315, STRIDE * 0.39, 40);
  targetGlowGeometry.rotateX(-Math.PI / 2);
  const targetGlowMaterial = new THREE.MeshBasicMaterial({
    color: 0xffd633,
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const targetGlow = new THREE.Mesh(targetGlowGeometry, targetGlowMaterial);
  targetGlow.visible = false;
  scene.add(targetGlow);

  const cursorRingGeometry = new THREE.RingGeometry(STRIDE * 0.16, STRIDE * 0.18, 32);
  cursorRingGeometry.rotateX(-Math.PI / 2);
  const cursorRingMaterial = new THREE.MeshBasicMaterial({
    color: 0xd8cba6,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const cursorRing = new THREE.Mesh(cursorRingGeometry, cursorRingMaterial);
  cursorRing.visible = false;
  scene.add(cursorRing);

  const doorHoverMaterial = new THREE.MeshBasicMaterial({
    color: 0xffd633,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const doorHoverRing = new THREE.Mesh(targetGlowGeometry, doorHoverMaterial);
  doorHoverRing.scale.setScalar(1.85);
  doorHoverRing.visible = false;
  scene.add(doorHoverRing);


  // ------------------------------------------------------------------ camera

  // Start north of the player, looking across the chamber toward its door.
  let yaw = Math.PI;
  let pitch = PITCH_START;
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
  let firstPerson = false;
  let overheadPitch = PITCH_START;
  let overheadYaw = Math.PI;

  /** The player's head, in scene units — where the eyes are when they are ours. */
  const eye = new THREE.Vector3(BOARD_CX, EYE_HEIGHT, BOARD_CZ);
  const forward = new THREE.Vector3();
  /** Which way the player's model is facing: +1 east, -1 west. */
  let playerFacing: 1 | -1 = 1;
  const doorWorldPosition = new THREE.Vector3();
  const desiredCameraPosition = new THREE.Vector3();
  const cameraSightline = new THREE.Vector3();
  const cameraLookTarget = new THREE.Vector3();
  const cameraWallRay = new THREE.Raycaster();

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
      const armX = Math.sin(smoothed.yaw);
      const armZ = Math.cos(smoothed.yaw);
      const lookX = smoothed.x;
      const lookZ = smoothed.z;

      desiredCameraPosition.set(
        smoothed.x + armX * horizontal,
        Math.sin(smoothed.pitch) * smoothed.distance,
        smoothed.z + armZ * horizontal,
      );
      cameraLookTarget.set(lookX, 0.9, lookZ);
      cameraSightline.copy(desiredCameraPosition).sub(cameraLookTarget);
      const desiredDistance = cameraSightline.length();
      cameraSightline.normalize();
      cameraWallRay.set(cameraLookTarget, cameraSightline);
      cameraWallRay.far = desiredDistance;
      const obstruction = cameraWallRay.intersectObjects(wallOccluders, false)[0];
      if (obstruction) {
        // A hard correction is intentional: once masonry crosses the sightline,
        // never spend a few soft-follow frames looking through solid stone.
        const clearDistance = Math.max(0.7, obstruction.distance - 0.28);
        camera.position.copy(cameraLookTarget).addScaledVector(cameraSightline, clearDistance);
      } else {
        camera.position.copy(desiredCameraPosition);
      }
      camera.lookAt(lookX, 0.9, lookZ);
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

    resize(displayWidth, displayHeight, dpr, viewWidth) {
      renderer.setPixelRatio(dpr);
      renderer.setSize(displayWidth, displayHeight, false);
      canvas.style.width = `${displayWidth}px`;
      canvas.style.height = `${displayHeight}px`;
      // The fov is *vertical*, so widening the aspect shows more of the room to
      // either side rather than stretching what was already there.
      roomWidth = viewWidth;
      camera.aspect = viewWidth / WORLD_HEIGHT;
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

    /**
     * **Drag right, look right.** A delta control: the view turns *with* the
     * hand rather than the world being dragged under it, and it turns further
     * than the cursor travelled — `LOOK_GAIN` is the dial.
     *
     * The angles still come from the camera's own frustum rather than a
     * pixels-to-radians constant: an NDC delta is a fraction of the half-screen,
     * half the vertical fov is the angle to the top edge, and `aspect` widens
     * that for the horizontal. So the same drag turns you the same amount at any
     * window size or shape, which a rad-per-pixel constant cannot manage — it
     * gets twice as sensitive when the window doubles.
     *
     * Signs match everything else here: yaw *decreases* to look right, pitch
     * *increases* to look down (`forward.y` is `-sin pitch`), and NDC y points
     * up while a hand dragging down means looking down.
     */
    look(dNdcX, dNdcY) {
      const tanHalfV = Math.tan((camera.fov * Math.PI) / 360);
      yaw -= Math.atan(dNdcX * tanHalfV * camera.aspect) * LOOK_GAIN;
      pitch = clampPitch(pitch - Math.atan(dNdcY * tanHalfV) * LOOK_GAIN);
      smoothed.yaw = yaw;
      smoothed.pitch = pitch;
      applyCamera();
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

      // Follow the player at every third-person zoom, including the new
      // pulled-back default. Damping keeps the wide view from jolting after
      // each small movement update.
      if (!firstPerson) home.set(toX(px), 0, toZ(py));
      applyFocus();
    },

    resetView() {
      pitch = firstPerson ? FP_PITCH_START : PITCH_START;
      yaw = firstPerson
        ? (playerFacing === 1 ? -Math.PI / 2 : Math.PI / 2)
        : Math.PI;
      // `update` eases to both targets; resetting the view must not cut there.
    },

    flip() {
      // Choose the positive half-turn explicitly, then let `update` ease across
      // it. This keeps the direction deterministic without cutting the camera.
      yaw += Math.PI;
    },

    update(dt) {
      smoothed.yaw = damp(smoothed.yaw, yaw, 16, dt);
      smoothed.pitch = damp(smoothed.pitch, pitch, 16, dt);
      smoothed.distance = damp(smoothed.distance, distance, 12, dt);
      smoothed.x = damp(smoothed.x, focus.x, 14, dt);
      smoothed.z = damp(smoothed.z, focus.z, 14, dt);
      applyCamera();
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

    doorAt(ndcX, ndcY) {
      ndc.set(ndcX, ndcY);
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObjects(doorPickables, false)[0]?.object;
      return (hit?.userData.doorId as DoorId | undefined) ?? null;
    },

    setDoors(states) {
      for (const [id, door] of doors) {
        door.rotation.y = states[id] ? door.userData.openAngle as number : 0;
      }
      applyCamera();
    },

    project(point) {
      const projected = point.clone().project(camera);
      // A point behind the camera comes back through the projection mirrored,
      // and would draw its label or its damage number somewhere arbitrary on
      // screen. Overhead nothing the overlay labels is ever behind the camera;
      // in first person your own head is, every time something bites you.
      if (projected.z > 1) return { x: -roomWidth, y: -WORLD_HEIGHT };
      return {
        x: ((projected.x + 1) / 2) * roomWidth,
        y: ((1 - projected.y) / 2) * WORLD_HEIGHT,
      };
    },

    setCursorRing(px, py, kind) {
      if (px === null || py === null) {
        cursorRing.visible = false;
        return;
      }
      cursorRing.visible = true;
      cursorRingMaterial.color.setHex(
        kind === "enemy" ? 0xe23b3b : kind === "interactable" ? 0xffd633 : 0xd8cba6,
      );
      cursorRingMaterial.opacity = kind === "floor" ? 0.3 : 0.5;
      cursorRing.position.set(toX(px), 0.145, toZ(py));
    },

    setTargetRing(px, py, color) {
      if (px === null || py === null) {
        targetRing.visible = false;
        targetGlow.visible = false;
        return;
      }
      targetRing.visible = true;
      targetGlow.visible = true;
      targetRingMaterial.color.setHex(color);
      targetGlowMaterial.color.setHex(color);
      targetRing.scale.setScalar(1);
      targetGlow.scale.setScalar(1);
      targetRing.position.set(toX(px), 0.14, toZ(py));
      targetGlow.position.set(toX(px), 0.135, toZ(py));
    },

    setDoorTargetRing(door) {
      const slab = doorSlabs.get(door);
      if (!slab) {
        targetRing.visible = false;
        targetGlow.visible = false;
        return;
      }
      targetRing.visible = true;
      targetGlow.visible = true;
      targetRingMaterial.color.setHex(0xffd633);
      targetGlowMaterial.color.setHex(0xffd633);
      targetRing.scale.setScalar(1.85);
      targetGlow.scale.setScalar(1.85);
      slab.getWorldPosition(doorWorldPosition);
      targetRing.position.set(doorWorldPosition.x, 0.14, doorWorldPosition.z);
      targetGlow.position.set(doorWorldPosition.x, 0.135, doorWorldPosition.z);
    },

    setDoorHoverRing(door) {
      if (!door) {
        doorHoverRing.visible = false;
        return;
      }
      const slab = doorSlabs.get(door);
      if (!slab) {
        doorHoverRing.visible = false;
        return;
      }
      doorHoverRing.visible = true;
      slab.getWorldPosition(doorWorldPosition);
      doorHoverRing.position.set(doorWorldPosition.x, 0.15, doorWorldPosition.z);
    },

    animateScenery(elapsed) {
      const flicker = Math.sin(elapsed * 9) * 0.025 + Math.sin(elapsed * 15.7) * 0.015;
      outerFlame.scale.set(1 + flicker, 1 + Math.sin(elapsed * 10) * 0.045, 1 - flicker * 0.4);
      innerFlame.scale.set(1 - flicker * 0.5, 1 + Math.sin(elapsed * 12 + 1.2) * 0.04, 1 + flicker);
      outerFlame.rotation.y = elapsed * 0.55;
      innerFlame.rotation.y = -elapsed * 0.7;
      torchLight.intensity = 0.78 + Math.sin(elapsed * 8.3) * 0.035 + Math.sin(elapsed * 13.1) * 0.02;

      for (let i = 0; i < EMBER_COUNT; i++) {
        const age = (elapsed * 0.28 + i / EMBER_COUNT) % 1;
        const idx = i * 3;
        emberPositions[idx] = torchX + Math.sin(elapsed * 3.1 + i * 2.4) * 0.055 * age;
        emberPositions[idx + 1] = 2.22 + age * 0.48;
        emberPositions[idx + 2] = torchZ - 0.2 + Math.cos(elapsed * 2.7 + i * 1.9) * 0.04 * age;
      }
      (emberGeometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    },

    render() {
      renderer.render(scene, camera);
    },
  };
}

/** Board dimensions the client's own code needs — kept with the board itself. */
export const BOARD = { x0: BOARD_X0, z0: BOARD_Z0, w: BOARD_W, d: BOARD_D, stride: STRIDE };
