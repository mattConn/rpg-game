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
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import { WORLD_HEIGHT, WORLD_WIDTH } from "../../../src/shared/constants.js";
import { clamp } from "../../../src/shared/movement.js";
import { damp, toPixelX, toPixelY, toX, toZ } from "../../../rpg-3d/src/client/world.js";
import {
  ARENA_H,
  ARENA_W,
  ARENA_X,
  ARENA_Y,
  BOARD_REGION,
  BAT_HALL_REGION,
  BAT_REGION,
  CHAMBER_MARGIN_PX,
  DOORWAY_WIDTH_PX,
  DUNGEON_CONNECTIONS,
  DUNGEON_ENEMIES,
  DUNGEON_PORTAL,
  DUNGEON_SEED,
  EDITOR_DUNGEON,
  EDITOR_TILE_CELLS,
  type DoorId,
  type DoorStates,
  FAR_REGION,
  HALL_REGION,
  HALL_REGIONS,
  PRESSURE_PLATES,
  PRESSURE_PLATE_ROOMS,
  PURPLE_GEM,
  ROOM_REGIONS,
  SQUARE_PX,
  SPIKE_TRAP_ROOM,
  TILE_PX,
  WALL_THICKNESS_PX,
  cellAtPoint,
  cellCenter,
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
const BAT_CX = toX(regionCentre(BAT_REGION).x);

/** Bare floor between the flagstones and the masonry. */
const MARGIN = toX(CHAMBER_MARGIN_PX);

const WALL_H = 8.4;
const WALL_T = toX(WALL_THICKNESS_PX);
const UPPER_WALL_FOG_HEIGHT = 3.5;
const UPPER_WALL_FOG_OVERHANG = 0.9;
const DUNGEON_SKY_COLOR = 0x111111;

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
const BAT_CZ = toZ(regionCentre(BAT_REGION).y);
const BAT_HALL_LEN = BAT_CZ - FAR_CZ - FAR_CHAMBER_D - WALL_T * 2;

/** What is left for the hall itself once both chambers' walls are accounted for. */
const HALL_LEN = FAR_CZ - BOARD_CZ
  - START_CHAMBER_D / 2 - FAR_CHAMBER_D / 2 - WALL_T * 2;

/**
 * Framing is expressed as multiples of the board's width rather than in units,
 * so a change to `TILE_PX` carries the camera and the fog with it. Fixed numbers
 * here would quietly leave the view halfway across the dungeon the first time
 * the squares were resized.
 */
// Lock the third-person camera at the closest framing that was previously
// reachable with the wheel: maximum zoom is now both the default and the only
// allowed distance.
const CAMERA_START_DISTANCE = BOARD_W * 0.22;

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
  follow(px: number, py: number, facing: 1 | -1, running?: boolean): void;
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
  /** True when a world point lies inside the active camera frustum. */
  isPointVisible(px: number, py: number, height?: number): boolean;
  /** Show a faint floor marker, colored for enemies and interactables. */
  setCursorRing(px: number | null, py: number | null, kind: "floor" | "enemy" | "interactable"): void;
  setAttackReticle(px: number | null, py: number | null, height?: number): void;
  setTargetRing(px: number | null, py: number | null, color: number): void;
  setDoorTargetRing(door: DoorId): void;
  setDoorHoverRing(door: DoorId | null): void;
  doorAt(ndcX: number, ndcY: number): DoorId | null;
  setDoors(doors: DoorStates): void;
  setPressurePlates(plates: Array<{ id: string; roomIndex: number; connectionIndex: number; active: boolean }>): void;
  setSpikeTrap(trap: { roomIndex: number; active: boolean } | null): void;
  setDungeonPortal(state: { unlocked: boolean; fallProgress: number }, gem: { destroyed: boolean }): void;
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

export function createStage(canvas: HTMLCanvasElement, maxAnisotropy = Infinity): Stage {
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
  renderer.setClearColor(DUNGEON_SKY_COLOR);

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
  scene.fog = new THREE.Fog(DUNGEON_SKY_COLOR, BOARD_W * 0.95, BOARD_W * 3.2);

  const loadStoneTexture = (path: string) => {
    const texture = new THREE.TextureLoader().load(path);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = Math.min(maxAnisotropy, renderer.capabilities.getMaxAnisotropy());
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
  const stoneFloor = (w: number, d: number, level = false) => {
    const geometry = new THREE.PlaneGeometry(w, d, Math.ceil(w), Math.ceil(d));
    geometry.rotateX(-Math.PI / 2);

    const position = geometry.attributes.position as THREE.BufferAttribute;
    if (!level) {
      for (let i = 0; i < position.count; i++) {
        position.setY(i, (Math.random() - 0.5) * 0.05);
      }
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
  const westmost = Math.min(...ROOM_REGIONS.map((region) => toX(ARENA_X + region.col * TILE_PX) - MARGIN));
  const eastmost = Math.max(...ROOM_REGIONS.map((region) => toX(ARENA_X + (region.col + region.cols) * TILE_PX) + MARGIN));
  const northmost = Math.min(...ROOM_REGIONS.map((region) => toZ(ARENA_Y + region.row * TILE_PX) - MARGIN));
  const southmost = Math.max(...ROOM_REGIONS.map((region) => toZ(ARENA_Y + (region.row + region.rows) * TILE_PX) + MARGIN));
  const apronW = (eastmost - westmost) * 1.6;
  const apronD = (southmost - northmost) * 1.6;
  const apronTex = floorTexture.clone();
  apronTex.repeat.set(apronW / TEXTURE_SCALE, apronD / TEXTURE_SCALE);
  const apronMaterial = EDITOR_DUNGEON
    ? new THREE.MeshBasicMaterial({ color: DUNGEON_SKY_COLOR })
    : new THREE.MeshLambertMaterial({ map: apronTex, color: 0x606068, flatShading: true });
  const apronCx = (westmost + eastmost) / 2;
  const apronCz = (northmost + southmost) / 2;
  const apronWest = apronCx - apronW / 2;
  const apronEast = apronCx + apronW / 2;
  const apronNorth = apronCz - apronD / 2;
  const apronSouth = apronCz + apronD / 2;
  const apronHoleCx = toX(DUNGEON_PORTAL.holePosition.x);
  const apronHoleCz = toZ(DUNGEON_PORTAL.holePosition.y);
  const apronHoleSize = 10.8;
  const addApron = (width: number, depth: number, x: number, z: number) => {
    const slab = new THREE.Mesh(
      new THREE.PlaneGeometry(width, depth).rotateX(-Math.PI / 2),
      apronMaterial,
    );
    slab.position.set(x, -0.06, z);
    slab.receiveShadow = true;
    scene.add(slab);
  };
  const holeWest = apronHoleCx - apronHoleSize / 2;
  const holeEast = apronHoleCx + apronHoleSize / 2;
  const holeNorth = apronHoleCz - apronHoleSize / 2;
  const holeSouth = apronHoleCz + apronHoleSize / 2;
  addApron(holeWest - apronWest, apronD, (apronWest + holeWest) / 2, apronCz);
  addApron(apronEast - holeEast, apronD, (holeEast + apronEast) / 2, apronCz);
  addApron(apronHoleSize, holeNorth - apronNorth, apronHoleCx, (apronNorth + holeNorth) / 2);
  addApron(apronHoleSize, apronSouth - holeSouth, apronHoleCx, (holeSouth + apronSouth) / 2);

  // -------------------------------------------------------------------- walls

  const upperWallFogMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      fogColor: { value: new THREE.Color(DUNGEON_SKY_COLOR) },
      fogHeight: { value: UPPER_WALL_FOG_HEIGHT },
    },
    vertexShader: `
      uniform float fogHeight;
      varying float vHeight;
      void main() {
        vHeight = position.y / fogHeight + 0.5;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 fogColor;
      varying float vHeight;
      void main() {
        float alpha = smoothstep(0.0, 0.72, vHeight);
        gl_FragColor = vec4(fogColor, alpha);
      }
    `,
  });
  const wallOccluders: THREE.Mesh[] = [];
  const addWall = (
    w: number,
    d: number,
    x: number,
    z: number,
    height = WALL_H,
    centreY = height / 2,
    addUpperFog = true,
  ) => {
    const tex = wallTexture.clone();
    tex.repeat.set(Math.max(w, d) / TEXTURE_SCALE, height / TEXTURE_SCALE);
    const mat = new THREE.MeshLambertMaterial({ map: tex, flatShading: true });
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, height, d), mat);
    wall.position.set(x, centreY, z);
    wall.castShadow = true;
    wall.receiveShadow = true;
    scene.add(wall);
    wall.updateMatrixWorld();
    wallOccluders.push(wall);
    // Door jambs and lintels are much shorter than a full wall. Extending the
    // wall-top fog down from those meshes creates a large black plane across
    // the opening, so only full-height masonry receives this treatment.
    if (!addUpperFog) return;
    // Vertical planes only: a closed box creates its own visible top lip. Two
    // faces cover either side of each wall while leaving no horizontal edge.
    const fogY = height - UPPER_WALL_FOG_HEIGHT / 2 + UPPER_WALL_FOG_OVERHANG;
    if (w >= d) {
      const geometry = new THREE.PlaneGeometry(w + 0.12, UPPER_WALL_FOG_HEIGHT);
      for (const side of [-1, 1]) {
        const fog = new THREE.Mesh(geometry, upperWallFogMaterial);
        fog.position.set(x, fogY, z + side * (d / 2 + 0.061));
        fog.renderOrder = 4;
        scene.add(fog);
      }
    } else {
      const geometry = new THREE.PlaneGeometry(d + 0.12, UPPER_WALL_FOG_HEIGHT);
      for (const side of [-1, 1]) {
        const fog = new THREE.Mesh(geometry, upperWallFogMaterial);
        fog.rotation.y = Math.PI / 2;
        fog.position.set(x + side * (w / 2 + 0.061), fogY, z);
        fog.renderOrder = 4;
        scene.add(fog);
      }
    }
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
    openings: ReadonlySet<"north" | "east" | "south" | "west">,
    centralHole = false,
  ) => {
    if (!centralHole) {
      const floor = stoneFloor(width, depth);
      floor.position.set(cx, 0, cz);
      scene.add(floor);
    } else {
      const holeSize = Math.min(10.5, width * 0.34, depth * 0.34);
      const sideWidth = (width - holeSize) / 2;
      const endDepth = (depth - holeSize) / 2;
      for (const x of [cx - (holeSize + sideWidth) / 2, cx + (holeSize + sideWidth) / 2]) {
        const slab = stoneFloor(sideWidth, depth); slab.position.set(x, 0, cz); scene.add(slab);
      }
      for (const z of [cz - (holeSize + endDepth) / 2, cz + (holeSize + endDepth) / 2]) {
        const slab = stoneFloor(holeSize, endDepth); slab.position.set(cx, 0, z); scene.add(slab);
      }
    }

    const west = cx - width / 2;
    const east = cx + width / 2;
    const north = cz - depth / 2;
    const south = cz + depth / 2;

    const northZ = north - WALL_T / 2;
    const southZ = south + WALL_T / 2;
    const horizontalWall = (z: number, open: boolean) => {
      if (!open) { addWall(width + WALL_T * 2, WALL_T, cx, z); return; }
      const span = (width - DOOR_W) / 2 + WALL_T;
      addWall(span, WALL_T, west - WALL_T + span / 2, z);
      addWall(span, WALL_T, east + WALL_T - span / 2, z);
      for (const x of [cx - DOOR_W / 2 + .17, cx + DOOR_W / 2 - .17])
        addWall(.34, WALL_T + .3, x, z, WALL_H + .5, (WALL_H + .5) / 2, false);
      addWall(DOOR_W + .5, WALL_T + .4, cx, z, .4, WALL_H + .3, false);
    };
    const verticalWall = (x: number, open: boolean) => {
      if (!open) { addWall(WALL_T, depth + WALL_T * 2, x, cz); return; }
      const span = (depth - DOOR_W) / 2 + WALL_T;
      addWall(WALL_T, span, x, north - WALL_T + span / 2);
      addWall(WALL_T, span, x, south + WALL_T - span / 2);
      for (const z of [cz - DOOR_W / 2 + .17, cz + DOOR_W / 2 - .17])
        addWall(WALL_T + .3, .34, x, z, WALL_H + .5, (WALL_H + .5) / 2, false);
      addWall(WALL_T + .4, DOOR_W + .5, x, cz, .4, WALL_H + .3, false);
    };
    horizontalWall(northZ, openings.has("north"));
    horizontalWall(southZ, openings.has("south"));
    verticalWall(west - WALL_T / 2, openings.has("west"));
    verticalWall(east + WALL_T / 2, openings.has("east"));
  };

  if (EDITOR_DUNGEON) {
    for (const tile of EDITOR_DUNGEON.tiles) {
      const centre = cellCenter({
        col: tile.x * EDITOR_TILE_CELLS + Math.floor(EDITOR_TILE_CELLS / 2),
        row: tile.y * EDITOR_TILE_CELLS + Math.floor(EDITOR_TILE_CELLS / 2),
      });
      const x = toX(centre.x);
      const z = toZ(centre.y);
      const size = toX(TILE_PX * EDITOR_TILE_CELLS);
      if (tile.type === "floor" || tile.type === "doorway") {
        const floor = stoneFloor(size, size, true);
        floor.position.set(x, 0, z);
        scene.add(floor);
      } else {
        addWall(size, size, x, z);
      }
    }
  } else ROOM_REGIONS.forEach((region, index) => {
    const centre = regionCentre(region);
    const openings = new Set<"north" | "east" | "south" | "west">();
    for (const connection of DUNGEON_CONNECTIONS) {
      if (connection.from === index) openings.add(connection.side);
      if (connection.to === index) openings.add(
        connection.side === "north" ? "south" : connection.side === "south" ? "north" : connection.side === "east" ? "west" : "east",
      );
    }
    buildChamber(
      toX(centre.x), toZ(centre.y),
      toX(region.cols * TILE_PX) + MARGIN * 2,
      toZ(region.rows * TILE_PX) + MARGIN * 2,
      openings,
      index === DUNGEON_PORTAL.roomIndex,
    );
  });

  // ---------------------------------------------------- pressure-plate gates

  const plateTextureCanvas = document.createElement("canvas");
  plateTextureCanvas.width = plateTextureCanvas.height = 128;
  const plateTextureContext = plateTextureCanvas.getContext("2d")!;
  plateTextureContext.fillStyle = "#34373b";
  plateTextureContext.fillRect(0, 0, 128, 128);
  // Blotchy oxidation and pitting keep the plate from reading as clean,
  // freshly-machined metal. The dungeon seed makes the damage repeatable.
  let plateDamageState = (DUNGEON_SEED ^ 0xbad51ab) >>> 0;
  const plateDamageRandom = () => {
    plateDamageState ^= plateDamageState << 13;
    plateDamageState ^= plateDamageState >>> 17;
    plateDamageState ^= plateDamageState << 5;
    return (plateDamageState >>> 0) / 0x100000000;
  };
  for (let index = 0; index < 420; index++) {
    const shade = Math.floor(20 + plateDamageRandom() * 45);
    const alpha = 0.12 + plateDamageRandom() * 0.32;
    plateTextureContext.fillStyle = `rgba(${shade},${shade + 2},${shade + 3},${alpha})`;
    const radius = 0.4 + plateDamageRandom() * 2.8;
    plateTextureContext.beginPath();
    plateTextureContext.arc(plateDamageRandom() * 128, plateDamageRandom() * 128, radius, 0, Math.PI * 2);
    plateTextureContext.fill();
  }
  plateTextureContext.lineCap = "round";
  for (let index = 0; index < 24; index++) {
    const x = plateDamageRandom() * 128;
    const y = plateDamageRandom() * 128;
    plateTextureContext.strokeStyle = `rgba(8,9,10,${0.28 + plateDamageRandom() * 0.42})`;
    plateTextureContext.lineWidth = 0.7 + plateDamageRandom() * 1.5;
    plateTextureContext.beginPath();
    plateTextureContext.moveTo(x, y);
    plateTextureContext.lineTo(x + (plateDamageRandom() - 0.5) * 30, y + (plateDamageRandom() - 0.5) * 30);
    plateTextureContext.stroke();
  }
  const plateTexture = new THREE.CanvasTexture(plateTextureCanvas);
  plateTexture.colorSpace = THREE.SRGBColorSpace;
  plateTexture.anisotropy = Math.min(maxAnisotropy, renderer.capabilities.getMaxAnisotropy());
  const plateMaterial = new THREE.MeshStandardMaterial({
    map: plateTexture, color: 0x8b9094, metalness: 0.58, roughness: 0.82,
  });
  const plateActiveMaterial = new THREE.MeshStandardMaterial({
    map: plateTexture, color: 0x505358, metalness: 0.66, roughness: 0.76,
  });
  const pressurePlates = new Map<string, THREE.Mesh>();
  for (const definition of PRESSURE_PLATES) {
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(1.22, 1.36, 0.12, 11), plateMaterial);
    plate.position.set(toX(definition.position.x), 0.07, toZ(definition.position.y));
    plate.receiveShadow = true;
    scene.add(plate);
    pressurePlates.set(definition.id, plate);
  }

  const GATE_HEIGHT = 5.6;
  const GATE_RAISED_Y = GATE_HEIGHT + 0.45;
  interface GateVisual { group: THREE.Group; plateId: string; active: boolean }
  const gateVisuals: GateVisual[] = [];
  DUNGEON_CONNECTIONS.forEach((connection, connectionIndex) => {
    const roomIndices = [connection.from, connection.to].filter((index) =>
      PRESSURE_PLATE_ROOMS.includes(index));
    for (const roomIndex of roomIndices) {
    const room = ROOM_REGIONS[roomIndex]!;
    const centre = regionCentre(room);
    const side = connection.from === roomIndex ? connection.side
      : connection.side === "north" ? "south"
        : connection.side === "south" ? "north"
          : connection.side === "east" ? "west" : "east";
    const cx = toX(centre.x);
    const cz = toZ(centre.y);
    const halfW = toX(room.cols * TILE_PX) / 2 + MARGIN;
    const halfD = toZ(room.rows * TILE_PX) / 2 + MARGIN;
    const gate = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: 0x090b0e, metalness: 0.92, roughness: 0.3 });
    const verticalCount = 7;
    for (let index = 0; index < verticalCount; index++) {
      const x = -DOOR_W / 2 + 0.22 + index * (DOOR_W - 0.44) / (verticalCount - 1);
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.16, GATE_HEIGHT, 0.18), steel);
      bar.position.set(x, GATE_HEIGHT / 2, 0);
      bar.castShadow = true;
      gate.add(bar);
    }
    for (const y of [1.25, GATE_HEIGHT - 1.25]) {
      const brace = new THREE.Mesh(new THREE.BoxGeometry(DOOR_W, 0.2, 0.22), steel);
      brace.position.set(0, y, 0);
      brace.castShadow = true;
      gate.add(brace);
    }
    gate.position.set(
      cx + (side === "east" ? halfW : side === "west" ? -halfW : 0),
      GATE_RAISED_Y,
      cz + (side === "south" ? halfD : side === "north" ? -halfD : 0),
    );
    if (side === "east" || side === "west") gate.rotation.y = Math.PI / 2;
    scene.add(gate);
    const plateId = PRESSURE_PLATES.find((plate) =>
      plate.roomIndex === roomIndex && plate.connectionIndex === connectionIndex)!.id;
    gateVisuals.push({ group: gate, plateId, active: false });
    }
  });

  // ---------------------------------------------------------- spike killzone

  const spikeTrapGroup = new THREE.Group();
  let spikeTrapRaised = false;
  const SPIKE_HEIGHT = 2.9;
  if (SPIKE_TRAP_ROOM !== null) {
    const room = ROOM_REGIONS[SPIKE_TRAP_ROOM]!;
    const centre = regionCentre(room);
    const cx = toX(centre.x);
    const cz = toZ(centre.y);
    const width = toX(room.cols * TILE_PX);
    const depth = toZ(room.rows * TILE_PX);
    const safeRadius = toX(TILE_PX * 2.35);
    const spikeGeometry = new THREE.ConeGeometry(0.22, SPIKE_HEIGHT, 6);
    const spikeMaterial = new THREE.MeshStandardMaterial({
      color: 0x101216, metalness: 0.88, roughness: 0.38,
    });
    const positions: Array<[number, number]> = [];
    const spacing = 1.85;
    for (let x = -width / 2 + spacing; x <= width / 2 - spacing; x += spacing) {
      for (let z = -depth / 2 + spacing; z <= depth / 2 - spacing; z += spacing) {
        if (Math.hypot(x, z) <= safeRadius) continue;
        positions.push([x, z]);
      }
    }
    const spikes = new THREE.InstancedMesh(spikeGeometry, spikeMaterial, positions.length);
    const matrix = new THREE.Matrix4();
    positions.forEach(([x, z], index) => {
      matrix.makeTranslation(x, SPIKE_HEIGHT / 2, z);
      spikes.setMatrixAt(index, matrix);
    });
    spikes.castShadow = true;
    spikes.receiveShadow = true;
    spikeTrapGroup.add(spikes);
    spikeTrapGroup.position.set(cx, -SPIKE_HEIGHT - 0.12, cz);
    scene.add(spikeTrapGroup);

    const plate = new THREE.Mesh(new THREE.CylinderGeometry(1.28, 1.42, 0.13, 11), plateMaterial);
    plate.position.set(cx, 0.075, cz);
    plate.receiveShadow = true;
    scene.add(plate);
  }

  // ------------------------------------------------------ purple fog portal

  const portalRoom = ROOM_REGIONS[DUNGEON_PORTAL.roomIndex]!;
  const portalCentre = regionCentre(portalRoom);
  const portalCx = toX(portalCentre.x);
  const portalCz = toZ(portalCentre.y);
  const portalHalfW = toX(portalRoom.cols * TILE_PX) / 2 + MARGIN;
  const portalHalfD = toZ(portalRoom.rows * TILE_PX) / 2 + MARGIN;
  const portalSide = DUNGEON_PORTAL.side;
  const portalX = portalCx + (portalSide === "east" ? portalHalfW : portalSide === "west" ? -portalHalfW : 0);
  const portalZ = portalCz + (portalSide === "south" ? portalHalfD : portalSide === "north" ? -portalHalfD : 0);
  const portalRotation = portalSide === "east" || portalSide === "west" ? Math.PI / 2 : 0;
  const barrierMaterial = new THREE.MeshBasicMaterial({
    color: 0xa02cff, transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const portalBarrier = new THREE.Mesh(new THREE.PlaneGeometry(DOOR_W * 0.94, 5.15, 10, 14), barrierMaterial);
  portalBarrier.position.set(portalX, 2.7, portalZ);
  portalBarrier.rotation.y = portalRotation;
  scene.add(portalBarrier);

  const gemMaterial = new THREE.MeshStandardMaterial({
    color: 0x9d36ff, emissive: 0x6d10c8, emissiveIntensity: 2.2,
    metalness: 0.2, roughness: 0.24,
  });
  const purpleGem = new THREE.Group();
  purpleGem.position.set(toX(PURPLE_GEM.position.x), 0.9, toZ(PURPLE_GEM.position.y));
  const fallbackGem = new THREE.Mesh(new THREE.OctahedronGeometry(0.72, 1), gemMaterial);
  fallbackGem.castShadow = true;
  purpleGem.add(fallbackGem);
  scene.add(purpleGem);
  const gemLight = new THREE.PointLight(0xa335ff, 0.8, 5.5, 2);
  purpleGem.add(gemLight);

  new GLTFLoader().load("/shared-models/purple-gem/scene.gltf", (gltf) => {
    const visual = gltf.scene;
    visual.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(visual);
    const size = bounds.getSize(new THREE.Vector3());
    visual.scale.setScalar(1.55 / Math.max(0.001, size.y));
    visual.updateMatrixWorld(true);
    const scaled = new THREE.Box3().setFromObject(visual);
    const centre = scaled.getCenter(new THREE.Vector3());
    visual.position.set(-centre.x, -centre.y, -centre.z);
    visual.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      node.castShadow = true;
      const sources = Array.isArray(node.material) ? node.material : [node.material];
      const materials = sources.map((source) => {
        const material = source.clone();
        if (material instanceof THREE.MeshStandardMaterial) {
          // The authored albedo has its own hue; remove it so the requested
          // purple is exact while retaining the normal, emissive, and
          // metallic/roughness maps that give the imported gem its detail.
          material.map = null;
          material.color.setHex(0xa92fff);
          material.emissive.setHex(0x7114cc);
          material.emissiveIntensity = 1.55;
          material.metalness = Math.max(0.28, material.metalness);
          material.roughness = Math.min(0.3, material.roughness);
        }
        return material;
      });
      node.material = Array.isArray(node.material) ? materials : materials[0]!;
    });
    purpleGem.remove(fallbackGem);
    fallbackGem.geometry.dispose();
    gemMaterial.dispose();
    purpleGem.add(visual);
  }, undefined, (error) => console.warn("Could not load purple gem model", error));

  const shardGeometry = new THREE.BufferGeometry();
  shardGeometry.setAttribute("position", new THREE.Float32BufferAttribute([
    0, 0.15, 0, -0.11, -0.09, 0, 0.11, -0.09, 0,
  ], 3));
  const shardMaterials = [0xb12cff, 0xf4e9ff].map((color) => new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.95, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  const gemShatters: Array<{
    age: number;
    purpleFlash: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
    whiteFlash: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
    shards: Array<{ mesh: THREE.Mesh; velocity: THREE.Vector3; spin: THREE.Vector3; baseScale: number }>;
  }> = [];
  let gemDestroyedVisualState = false;
  let lastShatterElapsed = 0;

  const spawnGemShatter = () => {
    const origin = purpleGem.position.clone();
    const flash = (color: number, opacity: number) => {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.24, 12, 8),
        new THREE.MeshBasicMaterial({
          color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false,
        }),
      );
      mesh.position.copy(origin);
      scene.add(mesh);
      return mesh;
    };
    const purpleFlash = flash(0x9d20ff, 0.78);
    const whiteFlash = flash(0xffffff, 0.9);
    const shards = Array.from({ length: 24 }, (_, index) => {
      const mesh = new THREE.Mesh(shardGeometry, shardMaterials[index % 3 === 0 ? 1 : 0]!);
      mesh.position.copy(origin);
      const angle = Math.random() * Math.PI * 2;
      const speed = 1.6 + Math.random() * 2.7;
      const baseScale = 0.7 + Math.random() * 1.15;
      mesh.scale.setScalar(baseScale);
      scene.add(mesh);
      return {
        mesh, baseScale,
        velocity: new THREE.Vector3(Math.cos(angle) * speed, 1.1 + Math.random() * 2.8, Math.sin(angle) * speed),
        spin: new THREE.Vector3(
          (Math.random() - 0.5) * 15,
          (Math.random() - 0.5) * 15,
          (Math.random() - 0.5) * 15,
        ),
      };
    });
    gemShatters.push({ age: 0, purpleFlash, whiteFlash, shards });
  };

  const shaftCx = toX(DUNGEON_PORTAL.holePosition.x);
  const shaftCz = toZ(DUNGEON_PORTAL.holePosition.y);
  const shaftSize = 10.3;
  const shaftDepth = 7;
  addWall(0.35, shaftSize, shaftCx - shaftSize / 2, shaftCz, shaftDepth, -shaftDepth / 2, false);
  addWall(0.35, shaftSize, shaftCx + shaftSize / 2, shaftCz, shaftDepth, -shaftDepth / 2, false);
  addWall(shaftSize, 0.35, shaftCx, shaftCz - shaftSize / 2, shaftDepth, -shaftDepth / 2, false);
  addWall(shaftSize, 0.35, shaftCx, shaftCz + shaftSize / 2, shaftDepth, -shaftDepth / 2, false);
  const shaftBottom = new THREE.Mesh(
    new THREE.PlaneGeometry(shaftSize, shaftSize),
    new THREE.MeshBasicMaterial({ color: 0x000000 }),
  );
  shaftBottom.rotation.x = -Math.PI / 2;
  shaftBottom.position.set(shaftCx, -shaftDepth, shaftCz);
  scene.add(shaftBottom);

  // ---------------------------------------------------------- angel statue

  const addAngelStatue = (statueX: number, statueZ: number, yaw: number) => {
    new GLTFLoader().load("/shared-models/angel-statue/scene-low.glb", (gltf) => {
      const statue = gltf.scene;
      statue.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) return;
        node.castShadow = true;
        node.receiveShadow = true;
      });
      statue.updateMatrixWorld(true);
      let bounds = new THREE.Box3().setFromObject(statue);
      const size = bounds.getSize(new THREE.Vector3());
      statue.scale.setScalar(4.5 / Math.max(0.001, size.y));
      statue.updateMatrixWorld(true);
      bounds = new THREE.Box3().setFromObject(statue);
      const modelCentre = bounds.getCenter(new THREE.Vector3());
      statue.position.set(-modelCentre.x, -bounds.min.y, -modelCentre.z);
      const statueRoot = new THREE.Group();
      statueRoot.position.set(statueX, 0, statueZ);
      statueRoot.rotation.y = yaw;
      statueRoot.add(statue);
      scene.add(statueRoot);
    }, undefined, (error) => console.warn("Could not load angel statue", error));
  };

  const jumboRoom = EDITOR_DUNGEON ? undefined : ROOM_REGIONS.find((region) => region.size === "jumbo");
  if (jumboRoom) {
    let statueState = (DUNGEON_SEED ^ 0xa63e15) >>> 0;
    const statueRandom = () => {
      statueState ^= statueState << 13;
      statueState ^= statueState >>> 17;
      statueState ^= statueState << 5;
      return (statueState >>> 0) / 0x100000000;
    };
    const placementRoll = statueRandom();
    // 0–70% centre, 70–90% corner, 90–100% absent.
    if (placementRoll < 0.9) {
      const centre = regionCentre(jumboRoom);
      const cx = toX(centre.x);
      const cz = toZ(centre.y);
      const width = toX(jumboRoom.cols * TILE_PX) + MARGIN * 2;
      const depth = toZ(jumboRoom.rows * TILE_PX) + MARGIN * 2;
      let statueX = cx;
      let statueZ = cz;
      if (placementRoll >= 0.7) {
        const corner = Math.floor(statueRandom() * 4);
        const inset = 2.4;
        statueX = cx + (corner === 0 || corner === 3 ? -1 : 1) * (width / 2 - inset);
        statueZ = cz + (corner < 2 ? -1 : 1) * (depth / 2 - inset);
      }

      addAngelStatue(statueX, statueZ, statueRandom() * Math.PI * 2);
    }
  }
  if (EDITOR_DUNGEON) {
    for (const entity of EDITOR_DUNGEON.entities.filter((candidate) => candidate.type === "angel-statue")) {
      const centre = cellCenter({
        col: entity.x * EDITOR_TILE_CELLS + Math.floor(EDITOR_TILE_CELLS / 2),
        row: entity.y * EDITOR_TILE_CELLS + Math.floor(EDITOR_TILE_CELLS / 2),
      });
      addAngelStatue(toX(centre.x), toZ(centre.y), entity.facing);
    }
  }

  // --------------------------------------------------------------- boulders

  let boulderState = (DUNGEON_SEED ^ 0xb01d3e) >>> 0;
  const boulderRandom = () => {
    boulderState += 0x6d2b79f5;
    let n = boulderState;
    n = Math.imul(n ^ (n >>> 15), n | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
  const boulderPlacements: Array<{
    x: number;
    z: number;
    yaw: number;
    size: number;
  }> = [];

  ROOM_REGIONS.forEach((region) => {
    if (region.size !== "large" && region.size !== "jumbo") return;
    const count = region.size === "large"
      ? (boulderRandom() < 0.7 ? 2 : 1)
      : Math.floor(boulderRandom() * 5);
    if (!count) return;

    const centre = regionCentre(region);
    const cx = toX(centre.x);
    const cz = toZ(centre.y);
    const width = toX(region.cols * TILE_PX) + MARGIN * 2;
    const depth = toZ(region.rows * TILE_PX) + MARGIN * 2;
    const west = cx - width / 2;
    const east = cx + width / 2;
    const north = cz - depth / 2;
    const south = cz + depth / 2;
    const centreCount = region.size === "jumbo"
      ? Math.min(count, 1 + Math.floor(boulderRandom() * 2))
      : 0;
    const centreAngle = boulderRandom() * Math.PI * 2;

    for (let index = 0; index < count; index++) {
      let x: number;
      let z: number;
      if (index < centreCount) {
        // Keep the centre itself clear for a possible angel statue. One or two
        // rocks occupy a loose inner orbit instead of overlapping the plinth.
        const angle = centreAngle + index * Math.PI + (boulderRandom() - 0.5) * 0.45;
        const radius = 3.2 + boulderRandom() * 2.4;
        x = cx + Math.cos(angle) * radius;
        z = cz + Math.sin(angle) * radius;
      } else {
        const inset = 1.4 + boulderRandom() * 1.5;
        const inCorner = boulderRandom() < 0.62;
        if (inCorner) {
          x = boulderRandom() < 0.5 ? west + inset : east - inset;
          z = boulderRandom() < 0.5 ? north + inset : south - inset;
        } else {
          const wall = Math.floor(boulderRandom() * 4);
          if (wall === 0 || wall === 2) {
            x = west + width * (0.15 + boulderRandom() * 0.7);
            z = wall === 0 ? north + inset : south - inset;
          } else {
            x = wall === 1 ? east - inset : west + inset;
            z = north + depth * (0.15 + boulderRandom() * 0.7);
          }
        }
      }
      boulderPlacements.push({
        x,
        z,
        yaw: boulderRandom() * Math.PI * 2,
        // Two deliberate silhouettes rather than continuously random scale.
        size: boulderRandom() < 0.5 ? 2.4 : 3.2,
      });
    }
  });
  if (EDITOR_DUNGEON) {
    for (const entity of EDITOR_DUNGEON.entities.filter((candidate) => candidate.type === "boulder")) {
      const centre = cellCenter({
        col: entity.x * EDITOR_TILE_CELLS + Math.floor(EDITOR_TILE_CELLS / 2),
        row: entity.y * EDITOR_TILE_CELLS + Math.floor(EDITOR_TILE_CELLS / 2),
      });
      boulderPlacements.push({
        x: toX(centre.x), z: toZ(centre.y), yaw: entity.facing, size: 2.4,
      });
    }
  }

  if (boulderPlacements.length) {
    new GLTFLoader().load("/shared-models/simple-rock/scene.gltf", (gltf) => {
      const source = gltf.scene;
      const gritSize = 96;
      const gritPixels = new Uint8Array(gritSize * gritSize * 4);
      for (let y = 0; y < gritSize; y++) {
        for (let x = 0; x < gritSize; x++) {
          let noise = Math.imul(x + 17, 0x45d9f3b) ^ Math.imul(y + 31, 0x119de1f3);
          noise ^= noise >>> 16;
          const fine = noise & 63;
          const coarse = ((Math.floor(x / 6) * 19 + Math.floor(y / 6) * 37) & 31);
          const fleck = (noise & 255) < 12 ? -52 : (noise & 255) > 246 ? 34 : 0;
          const shade = Math.max(60, Math.min(205, 125 + fine + coarse - 31 + fleck));
          const offset = (y * gritSize + x) * 4;
          gritPixels[offset] = shade;
          gritPixels[offset + 1] = shade;
          gritPixels[offset + 2] = shade;
          gritPixels[offset + 3] = 255;
        }
      }
      const gritTexture = new THREE.DataTexture(gritPixels, gritSize, gritSize, THREE.RGBAFormat);
      gritTexture.colorSpace = THREE.SRGBColorSpace;
      gritTexture.wrapS = THREE.RepeatWrapping;
      gritTexture.wrapT = THREE.RepeatWrapping;
      gritTexture.repeat.set(3, 3);
      gritTexture.needsUpdate = true;
      source.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) return;
        node.castShadow = true;
        node.receiveShadow = true;
        const sourceMaterials = Array.isArray(node.material) ? node.material : [node.material];
        const materials = sourceMaterials.map((sourceMaterial) => {
          const material = sourceMaterial.clone();
          if (material instanceof THREE.MeshStandardMaterial) {
            // Keep the supplied normal map, but replace its stark black/cream
            // diffuse pattern with a cheap, repeatable gritty dungeon texture.
            material.map = gritTexture;
            material.color.setHex(0x45474c);
            material.metalness = 0;
            material.roughness = 1;
            if (material.normalMap) material.normalScale.set(1.3, 1.3);
          }
          return material;
        });
        node.material = Array.isArray(node.material) ? materials : materials[0]!;
      });
      source.updateMatrixWorld(true);
      const sourceBounds = new THREE.Box3().setFromObject(source);
      const sourceSize = sourceBounds.getSize(new THREE.Vector3());
      const longestSide = Math.max(sourceSize.x, sourceSize.y, sourceSize.z, 0.001);

      boulderPlacements.forEach((placement) => {
        const visual = source.clone(true);
        visual.scale.setScalar(placement.size / longestSide);
        visual.updateMatrixWorld(true);
        const bounds = new THREE.Box3().setFromObject(visual);
        const centre = bounds.getCenter(new THREE.Vector3());
        visual.position.set(-centre.x, -bounds.min.y, -centre.z);
        const root = new THREE.Group();
        // The authored underside is irregular: its single lowest vertex can
        // touch while the broad base still looks suspended. Embed it slightly
        // in proportion to the selected size so the whole mass reads grounded.
        root.position.set(placement.x, -placement.size * 0.24, placement.z);
        // Yaw only: varied horizontal facing without tipping the grounded rock.
        root.rotation.y = placement.yaw;
        root.add(visual);
        scene.add(root);
      });
    }, undefined, (error) => console.warn("Could not load boulder decorations", error));
  }

  // --------------------------------------------------------------- cobwebs

  /** Seeded independently from layout generation so dressing never changes it. */
  let cobwebState = (DUNGEON_SEED ^ 0xc0b5e85) >>> 0;
  const cobwebRandom = () => {
    cobwebState += 0x6d2b79f5;
    let n = cobwebState;
    n = Math.imul(n ^ (n >>> 15), n | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
  const spiderRooms = new Set(
    DUNGEON_ENEMIES.filter((enemy) => enemy.kind === "spider").map((enemy) => enemy.roomIndex),
  );

  if (spiderRooms.size) {
    new GLTFLoader().load("/shared-models/cobwebs/scene.gltf", (gltf) => {
      // GLTFLoader sanitizes punctuation in node names, so looking up the
      // authored `cobweb.001` names can return nothing. Gather the seven real
      // renderable pieces instead; this is also resilient to renamed exports.
      const variants: THREE.Mesh[] = [];
      gltf.scene.traverse((node) => {
        if (node instanceof THREE.Mesh) variants.push(node);
      });
      if (!variants.length) return;

      spiderRooms.forEach((roomIndex) => {
        const region = ROOM_REGIONS[roomIndex];
        if (!region) return;
        const centre = regionCentre(region);
        const cx = toX(centre.x);
        const cz = toZ(centre.y);
        const width = toX(region.cols * TILE_PX) + MARGIN * 2;
        const depth = toZ(region.rows * TILE_PX) + MARGIN * 2;
        const west = cx - width / 2;
        const east = cx + width / 2;
        const north = cz - depth / 2;
        const south = cz + depth / 2;
        const count = 3 + Math.floor(cobwebRandom() * 4);

        for (let i = 0; i < count; i++) {
          const source = variants[Math.floor(cobwebRandom() * variants.length)]!;
          const piece = source.clone(true);
          piece.updateMatrixWorld(true);
          let bounds = new THREE.Box3().setFromObject(piece);
          const size = bounds.getSize(new THREE.Vector3());
          const centreOffset = bounds.getCenter(new THREE.Vector3());
          piece.position.sub(centreOffset);

          // The supplied variants include their authoring transform. If one
          // arrives lying flat, stand its thinnest plane upright before it is
          // attached to dungeon masonry.
          if (size.y < size.z && size.y < size.x) piece.rotation.x += Math.PI / 2;
          else if (size.x < size.z && size.x < size.y) piece.rotation.y += Math.PI / 2;

          const web = new THREE.Group();
          web.add(piece);
          web.updateMatrixWorld(true);
          bounds = new THREE.Box3().setFromObject(web);
          const uprightSize = bounds.getSize(new THREE.Vector3());
          const targetSize = (1.25 + cobwebRandom() * 1.35) * 5;
          web.scale.setScalar(targetSize / Math.max(uprightSize.x, uprightSize.y, uprightSize.z));
          if (cobwebRandom() < 0.5) web.scale.x *= -1;

          const wall = Math.floor(cobwebRandom() * 4);
          // Always seed one corner web, then retain a strong corner bias for
          // the rest while allowing occasional strands mid-wall.
          const inCorner = i === 0 || cobwebRandom() < 0.62;
          const firstEnd = cobwebRandom() < 0.5;
          const inset = 0.3 + cobwebRandom() * 1.15;
          const height = inCorner
            ? 0.75 + cobwebRandom() * 3.2
            : 1.0 + cobwebRandom() * 3.8;

          if (wall === 0 || wall === 2) {
            const along = inCorner
              ? (firstEnd ? west + inset : east - inset)
              : west + width * (0.18 + cobwebRandom() * 0.64);
            web.position.set(along, height, wall === 0 ? north + 0.035 : south - 0.035);
            web.rotation.y = wall === 0 ? 0 : Math.PI;
          } else {
            const along = inCorner
              ? (firstEnd ? north + inset : south - inset)
              : north + depth * (0.18 + cobwebRandom() * 0.64);
            web.position.set(wall === 1 ? east - 0.035 : west + 0.035, height, along);
            web.rotation.y = wall === 1 ? -Math.PI / 2 : Math.PI / 2;
          }
          scene.add(web);
        }
      });
    }, undefined, (error) => console.warn("Could not load cobweb decorations", error));
  }

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
  HALL_REGIONS.forEach((region) => {
    const centre = regionCentre(region);
    const cx = toX(centre.x);
    const cz = toZ(centre.y);
    const width = toX(region.cols * TILE_PX);
    const depth = toZ(region.rows * TILE_PX);
    if (region.rows > region.cols) {
      const length = depth - MARGIN * 2 - WALL_T * 2;
      const floor = stoneFloor(width + WALL_T * 2, length); floor.position.set(cx, 0, cz); scene.add(floor);
      addWall(WALL_T, length, cx - width / 2 - WALL_T / 2, cz);
      addWall(WALL_T, length, cx + width / 2 + WALL_T / 2, cz);
    } else {
      const length = width - MARGIN * 2 - WALL_T * 2;
      const floor = stoneFloor(length, depth + WALL_T * 2); floor.position.set(cx, 0, cz); scene.add(floor);
      addWall(length, WALL_T, cx, cz - depth / 2 - WALL_T / 2);
      addWall(length, WALL_T, cx, cz + depth / 2 + WALL_T / 2);
    }
  });

  // -------------------------------------------------------------- wall torches

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
  const bracketGeometry = new THREE.CylinderGeometry(0.045, 0.055, 0.42, 7);
  const cupGeometry = new THREE.CylinderGeometry(0.13, 0.075, 0.16, 7);
  const outerFlameGeometry = new THREE.ConeGeometry(0.09, 0.3, 7);
  const innerFlameGeometry = new THREE.ConeGeometry(0.048, 0.18, 7);
  const bracketMaterial = new THREE.MeshLambertMaterial({ color: 0x332d2a, flatShading: true });
  const cupMaterial = new THREE.MeshLambertMaterial({ color: 0x403a36, flatShading: true });
  const torchFlames: Array<{ outer: THREE.Mesh; inner: THREE.Mesh; phase: number }> = [];
  let torchState = (DUNGEON_SEED ^ 0x70ac4e5) >>> 0;
  const torchRandom = () => {
    torchState ^= torchState << 13; torchState ^= torchState >>> 17; torchState ^= torchState << 5;
    return (torchState >>> 0) / 0x100000000;
  };
  const addTorch = (x: number, z: number, roomX: number, roomZ: number) => {
    const fixture = new THREE.Group();
    fixture.position.set(x, 0, z);
    fixture.lookAt(roomX, 0, roomZ);
    fixture.rotateY(Math.PI);
    const bracket = new THREE.Mesh(bracketGeometry, bracketMaterial);
    bracket.castShadow = true;
    bracket.rotation.x = -0.42;
    bracket.position.set(0, 1.73, -0.08);
    fixture.add(bracket);
    const cup = new THREE.Mesh(cupGeometry, cupMaterial);
    cup.castShadow = true;
    cup.position.set(0, 1.97, -0.18);
    fixture.add(cup);
    const outer = new THREE.Mesh(outerFlameGeometry, outerFlameMaterial);
    outer.position.set(0, 2.17, -0.18);
    fixture.add(outer);
    const inner = new THREE.Mesh(innerFlameGeometry, innerFlameMaterial);
    inner.position.set(0, 2.11, -0.2);
    fixture.add(inner);
    scene.add(fixture);
    torchFlames.push({ outer, inner, phase: torchRandom() * Math.PI * 2 });
  };

  (EDITOR_DUNGEON ? [] : ROOM_REGIONS).forEach((room, roomIndex) => {
    const centre = regionCentre(room);
    const cx = toX(centre.x);
    const cz = toZ(centre.y);
    const width = toX(room.cols * TILE_PX) + MARGIN * 2;
    const depth = toZ(room.rows * TILE_PX) + MARGIN * 2;
    const west = cx - width / 2 + WALL_T * 0.22;
    const east = cx + width / 2 - WALL_T * 0.22;
    const north = cz - depth / 2 + WALL_T * 0.22;
    const south = cz + depth / 2 - WALL_T * 0.22;
    const openings = new Set<"north" | "east" | "south" | "west">();
    for (const connection of DUNGEON_CONNECTIONS) {
      if (connection.from === roomIndex) openings.add(connection.side);
      if (connection.to === roomIndex) openings.add(
        connection.side === "north" ? "south"
          : connection.side === "south" ? "north"
            : connection.side === "east" ? "west" : "east",
      );
    }
    let roomTorchCount = 0;
    for (const wall of ["north", "east", "south", "west"] as const) {
      const count = room.size === "jumbo" ? 2 : 1 + Math.floor(torchRandom() * 3);
      const span = wall === "north" || wall === "south" ? width : depth;
      for (let index = 0; index < count; index++) {
        const t = (index + 1) / (count + 1);
        let along = -span / 2 + span * t
          + (torchRandom() - 0.5) * Math.min(0.7, span / (count + 1) * 0.22);
        if (openings.has(wall)) {
          // Map the evenly-spaced position into the two solid wall sections,
          // leaving the doorway and its arch clear. A fixture placed in that
          // central opening has no wall behind it and appears to float.
          const edgeInset = 0.65;
          const doorwayClearance = DOOR_W / 2 + 0.55;
          const sectionLength = Math.max(0.1, span / 2 - edgeInset - doorwayClearance);
          const acrossSolidWall = t * sectionLength * 2;
          along = acrossSolidWall <= sectionLength
            ? -span / 2 + edgeInset + acrossSolidWall
            : doorwayClearance + (acrossSolidWall - sectionLength);
        }
        addTorch(
          wall === "west" ? west : wall === "east" ? east : cx + along,
          wall === "north" ? north : wall === "south" ? south : cz + along,
          cx, cz,
        );
        roomTorchCount++;
      }
    }
    // One pooled light per chamber gives all its flames a warm contribution
    // without compiling dozens of costly point lights into every material.
    const roomLight = new THREE.PointLight(0xff8a3d, Math.min(1.65, 0.46 + roomTorchCount * 0.09), Math.max(width, depth) * 0.72, 2);
    roomLight.position.set(cx, 2.25, cz);
    scene.add(roomLight);
  });
  if (EDITOR_DUNGEON) {
    for (const entity of EDITOR_DUNGEON.entities.filter((candidate) => candidate.type === "torch")) {
      const centre = cellCenter({
        col: entity.x * EDITOR_TILE_CELLS + Math.floor(EDITOR_TILE_CELLS / 2),
        row: entity.y * EDITOR_TILE_CELLS + Math.floor(EDITOR_TILE_CELLS / 2),
      });
      const x = toX(centre.x);
      const z = toZ(centre.y);
      addTorch(x, z, x + Math.sin(entity.facing), z + Math.cos(entity.facing));
    }
  }

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

  const attackReticle = new THREE.Mesh(
    new THREE.RingGeometry(0.1, 0.13, 32),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.5,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  attackReticle.renderOrder = 100;
  attackReticle.visible = false;
  scene.add(attackReticle);

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
  const cameraOrigin = new THREE.Vector3();
  const forward = new THREE.Vector3();
  /** Which way the player's model is facing: +1 east, -1 west. */
  let playerFacing: 1 | -1 = 1;
  let lastFollowX: number | null = null;
  let lastFollowY: number | null = null;
  let playerMoving = false;
  let playerRunning = false;
  let bobPhase = 0;
  let bobWeight = 0;
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
      const amplitude = playerRunning ? 0.085 : 0.05;
      const verticalBob = Math.sin(bobPhase * 2) * amplitude * bobWeight;
      const lateralBob = Math.cos(bobPhase) * amplitude * 0.42 * bobWeight;
      cameraOrigin.set(
        eye.x + Math.cos(smoothed.yaw) * lateralBob,
        eye.y + verticalBob,
        eye.z - Math.sin(smoothed.yaw) * lateralBob,
      );
      camera.position.copy(cameraOrigin);
      forward.set(
        -Math.sin(smoothed.yaw) * Math.cos(smoothed.pitch),
        -Math.sin(smoothed.pitch),
        -Math.cos(smoothed.yaw) * Math.cos(smoothed.pitch),
      );
      camera.lookAt(
        cameraOrigin.x + forward.x,
        cameraOrigin.y + forward.y,
        cameraOrigin.z + forward.z,
      );
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
    attackReticle.quaternion.copy(camera.quaternion);
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

    zoom(_delta) {
      // Camera distance is deliberately locked at maximum zoom.
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

    follow(px, py, facing, running = false) {
      playerFacing = facing;
      playerMoving = lastFollowX !== null && lastFollowY !== null
        && Math.hypot(px - lastFollowX, py - lastFollowY) > 0.01;
      playerRunning = running;
      lastFollowX = px;
      lastFollowY = py;
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
      const bobTarget = firstPerson && playerMoving ? 1 : 0;
      bobWeight = damp(bobWeight, bobTarget, playerMoving ? 14 : 9, dt);
      if (playerMoving) bobPhase += dt * (playerRunning ? 8.8 : 5.8);
      smoothed.yaw = damp(smoothed.yaw, yaw, 16, dt);
      smoothed.pitch = damp(smoothed.pitch, pitch, 16, dt);
      smoothed.distance = damp(smoothed.distance, distance, 12, dt);
      smoothed.x = damp(smoothed.x, focus.x, 14, dt);
      smoothed.z = damp(smoothed.z, focus.z, 14, dt);
      for (const gate of gateVisuals) {
        gate.group.position.y = damp(
          gate.group.position.y,
          gate.active ? 0 : GATE_RAISED_Y,
          gate.active ? 25 : 18,
          dt,
        );
      }
      spikeTrapGroup.position.y = damp(
        spikeTrapGroup.position.y,
        spikeTrapRaised ? 0 : -SPIKE_HEIGHT - 0.12,
        spikeTrapRaised ? 28 : 18,
        dt,
      );
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

    setPressurePlates(states) {
      const activePlates = new Set(states.filter((state) => state.active).map((state) => state.id));
      for (const gate of gateVisuals) {
        gate.active = activePlates.has(gate.plateId);
      }
      for (const [plateId, plate] of pressurePlates) {
        const active = activePlates.has(plateId);
        plate.material = active ? plateActiveMaterial : plateMaterial;
        plate.position.y = active ? 0.025 : 0.07;
      }
    },

    setSpikeTrap(trap) {
      spikeTrapRaised = trap?.active === true;
    },

    setDungeonPortal(state, gem) {
      portalBarrier.visible = !state.unlocked;
      if (gem.destroyed && !gemDestroyedVisualState) spawnGemShatter();
      gemDestroyedVisualState = gem.destroyed;
      purpleGem.visible = !gem.destroyed;
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

    isPointVisible(px, py, height = 1.25) {
      const world = new THREE.Vector3(toX(px), height, toZ(py));
      const projected = world.clone().project(camera);
      if (!(projected.z >= -1 && projected.z <= 1
        && projected.x >= -1 && projected.x <= 1
        && projected.y >= -1 && projected.y <= 1)) return false;
      const sightline = world.sub(camera.position);
      const distance = sightline.length();
      cameraWallRay.set(camera.position, sightline.normalize());
      cameraWallRay.far = distance;
      const wall = cameraWallRay.intersectObjects(wallOccluders, false)[0];
      return !wall || wall.distance >= distance - 0.15;
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

    setAttackReticle(px, py, height = 0.08) {
      if (px === null || py === null) {
        attackReticle.visible = false;
        return;
      }
      attackReticle.visible = true;
      attackReticle.position.set(toX(px), height, toZ(py));
      attackReticle.quaternion.copy(camera.quaternion);
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
      for (const flame of torchFlames) {
        const time = elapsed + flame.phase;
        const flicker = Math.sin(time * 9) * 0.025 + Math.sin(time * 15.7) * 0.015;
        flame.outer.scale.set(1 + flicker, 1 + Math.sin(time * 10) * 0.045, 1 - flicker * 0.4);
        flame.inner.scale.set(1 - flicker * 0.5, 1 + Math.sin(time * 12 + 1.2) * 0.04, 1 + flicker);
        flame.outer.rotation.y = time * 0.55;
        flame.inner.rotation.y = -time * 0.7;
      }
      barrierMaterial.opacity = 0.43 + Math.sin(elapsed * 4.7) * 0.1 + Math.sin(elapsed * 9.1) * 0.04;
      portalBarrier.scale.x = 1 + Math.sin(elapsed * 3.2) * 0.025;
      // A steady, readable turn rather than a frantic pickup-icon spin.
      purpleGem.rotation.y = elapsed * 0.9;
      purpleGem.position.y = 0.9 + Math.sin(elapsed * 2.8) * 0.08;
      const shatterDt = lastShatterElapsed === 0
        ? 1 / 60 : Math.min(0.05, Math.max(0, elapsed - lastShatterElapsed));
      lastShatterElapsed = elapsed;
      for (let index = gemShatters.length - 1; index >= 0; index--) {
        const shatter = gemShatters[index]!;
        shatter.age += shatterDt;
        const t = Math.min(1, shatter.age / 0.72);
        shatter.purpleFlash.scale.setScalar(1 + t * 9);
        shatter.whiteFlash.scale.setScalar(1 + t * 5.5);
        shatter.purpleFlash.material.opacity = 0.78 * (1 - t);
        shatter.whiteFlash.material.opacity = 0.9 * Math.max(0, 1 - t * 1.65);
        for (const shard of shatter.shards) {
          shard.velocity.y -= 5.8 * shatterDt;
          shard.mesh.position.addScaledVector(shard.velocity, shatterDt);
          shard.mesh.rotation.x += shard.spin.x * shatterDt;
          shard.mesh.rotation.y += shard.spin.y * shatterDt;
          shard.mesh.rotation.z += shard.spin.z * shatterDt;
          shard.mesh.scale.setScalar(shard.baseScale * Math.max(0, 1 - t));
        }
        if (t < 1) continue;
        scene.remove(shatter.purpleFlash, shatter.whiteFlash);
        shatter.purpleFlash.geometry.dispose();
        shatter.whiteFlash.geometry.dispose();
        shatter.purpleFlash.material.dispose();
        shatter.whiteFlash.material.dispose();
        for (const shard of shatter.shards) scene.remove(shard.mesh);
        gemShatters.splice(index, 1);
      }
    },

    render() {
      renderer.render(scene, camera);
    },
  };
}

/** Board dimensions the client's own code needs — kept with the board itself. */
export const BOARD = { x0: BOARD_X0, z0: BOARD_Z0, w: BOARD_W, d: BOARD_D, stride: STRIDE };
