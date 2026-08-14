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
  ESCAPE_CELL,
  SQUARE_PX,
  cellCenter,
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

const ROTATE_SPEED = 0.006;
const PAN_SPEED = 0.03;

/** How far the pan target may stray from the board's centre. */
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
  resetView(): void;
  update(dt: number): void;
  groundAt(ndcX: number, ndcY: number): { x: number; y: number } | null;
  pickAt(ndcX: number, ndcY: number): THREE.Object3D | null;
  project(point: THREE.Vector3): { x: number; y: number };
  /** Where a click would put them, and whether it is allowed. */
  setDestination(px: number | null, py: number | null, allowed: boolean): void;
  setTargetRing(px: number | null, py: number | null, color: number): void;
  animateScenery(elapsed: number): void;
  render(): void;
}

export function createStage(canvas: HTMLCanvasElement): Stage {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x07070b);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0b0b12, BOARD_W * 3.2, BOARD_W * 7.5);

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

  const chamberW = BOARD_W + MARGIN * 2;
  const chamberD = BOARD_D + MARGIN * 2;

  const floorGeometry = new THREE.PlaneGeometry(chamberW, chamberD, chamberW, chamberD);
  floorGeometry.rotateX(-Math.PI / 2);

  // A few centimetres of noise per vertex so flat shading has something to
  // catch — a perfectly flat plane reads as a void rather than as a floor.
  const position = floorGeometry.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(position.count * 3);
  const stone = new THREE.Color(0x3a3a45);
  for (let i = 0; i < position.count; i++) {
    position.setY(i, (Math.random() - 0.5) * 0.05);
    const shade = 0.82 + Math.random() * 0.36;
    colors[i * 3] = stone.r * shade;
    colors[i * 3 + 1] = stone.g * shade;
    colors[i * 3 + 2] = stone.b * shade;
  }
  floorGeometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  floorGeometry.computeVertexNormals();

  const floor = new THREE.Mesh(
    floorGeometry,
    new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
  );
  floor.position.set(BOARD_CX, 0, BOARD_CZ);
  floor.receiveShadow = true;
  scene.add(floor);

  // The apron: darker stone running out past the walls, so the camera looking
  // in from outside sees a dungeon continuing into the dark rather than a hole.
  const apron = new THREE.Mesh(
    new THREE.PlaneGeometry(chamberW * 3, chamberD * 3).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0x1e1e26 }),
  );
  apron.position.set(BOARD_CX, -0.06, BOARD_CZ);
  scene.add(apron);

  // ------------------------------------------------------------- the board
  //
  // Nothing is drawn on it. The board used to be nine raised flagstones,
  // because back then the grid *was* the game and you hopped from one square to
  // the next. Now that a cell is a fraction of a pace and you stop wherever you
  // like, ruling the floor would advertise a lattice the player never has to
  // think about — the same reason the real-time room leaves its tile grid
  // undrawn. Where you may go isn't drawn either — a disc of reachable ground
  // around the player was tried and removed: it read as a thing painted on the
  // floor rather than as a statement about this turn, and it followed you around
  // the board all game. The footfall ring under the cursor carries the range
  // instead, one click at a time.
  //
  // A slightly lighter slab marks the fighting ground so the arena still reads
  // as a place, with no lines on it.
  const boardSlab = new THREE.Mesh(
    new THREE.BoxGeometry(BOARD_W, 0.1, BOARD_D),
    new THREE.MeshLambertMaterial({ color: 0x4e4e59, flatShading: true }),
  );
  boardSlab.position.set(BOARD_CX, 0.05, BOARD_CZ);
  boardSlab.receiveShadow = true;
  scene.add(boardSlab);

  // -------------------------------------------------------------------- walls

  const wallMaterial = new THREE.MeshLambertMaterial({ color: 0x3b3b45, flatShading: true });
  const capMaterial = new THREE.MeshLambertMaterial({ color: 0x4c4c58, flatShading: true });

  const addWall = (w: number, d: number, x: number, z: number, height = WALL_H) => {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, height, d), wallMaterial);
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
  const north = BOARD_Z0 - MARGIN;
  const south = BOARD_Z0 + BOARD_D + MARGIN;

  addWall(chamberW + WALL_T * 2, WALL_T, BOARD_CX, north - WALL_T / 2);
  addWall(WALL_T, chamberD + WALL_T * 2, west - WALL_T / 2, BOARD_CZ);
  addWall(WALL_T, chamberD + WALL_T * 2, east + WALL_T / 2, BOARD_CZ);

  // The south wall is the one with the way out in it, so it is built in two
  // stretches with a gap where the escape column runs.
  const archCentre = toX(cellCenter(ESCAPE_CELL).x);
  const ARCH_WIDTH = STRIDE * 0.66;
  const archLeft = archCentre - ARCH_WIDTH / 2;
  const archRight = archCentre + ARCH_WIDTH / 2;
  const southZ = south + WALL_T / 2;

  const westSpan = archLeft - (west - WALL_T);
  addWall(westSpan, WALL_T, west - WALL_T + westSpan / 2, southZ);
  const eastSpan = east + WALL_T - archRight;
  addWall(eastSpan, WALL_T, archRight + eastSpan / 2, southZ);

  // --------------------------------------------------------------- the arch

  // Jambs, a lintel, and warm light spilling out of the passage. It is the only
  // bright thing outside the board, which is the point: the way out should be
  // visible from anywhere you can put the camera.
  const archMaterial = new THREE.MeshLambertMaterial({ color: 0x565062, flatShading: true });
  const jamb = (x: number) => {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.34, WALL_H + 0.5, WALL_T + 0.3), archMaterial);
    post.position.set(x, (WALL_H + 0.5) / 2, southZ);
    post.castShadow = true;
    scene.add(post);
  };
  jamb(archLeft + 0.17);
  jamb(archRight - 0.17);

  const lintel = new THREE.Mesh(
    new THREE.BoxGeometry(ARCH_WIDTH + 0.5, 0.4, WALL_T + 0.4),
    archMaterial,
  );
  lintel.position.set(archCentre, WALL_H + 0.3, southZ);
  lintel.castShadow = true;
  scene.add(lintel);

  const archGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(ARCH_WIDTH - 0.4, WALL_H - 0.2),
    new THREE.MeshBasicMaterial({ color: 0xffc478, transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
  );
  archGlow.position.set(archCentre, (WALL_H - 0.2) / 2, southZ + WALL_T / 2 + 0.02);
  scene.add(archGlow);

  // The way out used to be a lit tile on a grid. With the grid gone it needs a
  // mark of its own, or the arch is only visible from angles that show the wall.
  // A ring rather than a filled disc: a pale wash on stone reads as a stain,
  // while a rim reads as somewhere to stand.
  const escapeRadius = toX(SQUARE_PX) * 0.42;
  const escapeGeometry = new THREE.RingGeometry(escapeRadius * 0.86, escapeRadius, 48);
  escapeGeometry.rotateX(-Math.PI / 2);
  const escapeGlow = new THREE.Mesh(
    escapeGeometry,
    new THREE.MeshBasicMaterial({ color: 0xffc478, transparent: true, opacity: 0.6, depthWrite: false }),
  );
  const escapeAt = cellCenter(ESCAPE_CELL);
  escapeGlow.position.set(toX(escapeAt.x), 0.11, toZ(escapeAt.y));
  scene.add(escapeGlow);

  const archLight = new THREE.PointLight(0xffb45a, 5, BOARD_W, 2);
  archLight.position.set(archCentre, 1.6, southZ - 0.6);
  scene.add(archLight);

  // ------------------------------------------------------------------ torches

  // One bracket at the midpoint of each of the four walls. `west`/`east`/
  // `north`/`south` are the walls' *inner faces*, so each offset points into the
  // room — get the sign wrong and the torch is buried in its own masonry.
  //
  // The south one sits over the middle column, not over the arch: the way out
  // has its own light spilling through it, and a torch there would wash the
  // glow out rather than add to it.
  const TORCH_INSET = 0.25;
  const torches: Array<ReturnType<typeof buildTorch>> = [];
  const torchSpots: Array<[number, number]> = [
    [BOARD_CX, north + TORCH_INSET],
    [BOARD_CX, south - TORCH_INSET],
    [west + TORCH_INSET, BOARD_CZ],
    [east - TORCH_INSET, BOARD_CZ],
  ];
  for (const [x, z] of torchSpots) {
    const torch = buildTorch();
    torch.group.position.set(x, 1.9, z);
    scene.add(torch.group);
    torches.push(torch);
  }

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

  let yaw = 0;
  let pitch = PITCH_START;
  let distance = CAMERA_START_DISTANCE;

  /** Where the camera looks. Panning moves this; everything else orbits it. */
  const focus = new THREE.Vector3(BOARD_CX, 0, BOARD_CZ);
  /** Smoothed copy, so a wheel notch or a released drag settles instead of snapping. */
  const smoothed = { yaw, pitch, distance, x: focus.x, z: focus.z };

  const applyCamera = () => {
    const horizontal = Math.cos(smoothed.pitch) * smoothed.distance;
    camera.position.set(
      smoothed.x + Math.sin(smoothed.yaw) * horizontal,
      Math.sin(smoothed.pitch) * smoothed.distance,
      smoothed.z + Math.cos(smoothed.yaw) * horizontal,
    );
    camera.lookAt(smoothed.x, 0.9, smoothed.z);
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
      distance = clamp(distance + delta, CAMERA_MIN_DISTANCE, CAMERA_MAX_DISTANCE);
    },

    orbit(dx, dy) {
      // Dragging right swings the scene right, which means the camera goes the
      // other way around the board.
      yaw -= dx * ROTATE_SPEED;
      pitch = clamp(pitch - dy * ROTATE_SPEED * 0.8, PITCH_MIN, PITCH_MAX);
    },

    pan(dx, dy) {
      // Screen right/up, expressed on the floor at the current yaw — so a drag
      // pulls the room the way the hand went whichever way the view is facing.
      const scale = PAN_SPEED * (distance / CAMERA_START_DISTANCE);
      const rightX = Math.cos(yaw);
      const rightZ = -Math.sin(yaw);
      const forwardX = Math.sin(yaw);
      const forwardZ = Math.cos(yaw);

      focus.x = clamp(focus.x - (dx * rightX + dy * forwardX) * scale, BOARD_CX - PAN_LIMIT, BOARD_CX + PAN_LIMIT);
      focus.z = clamp(focus.z - (dx * rightZ + dy * forwardZ) * scale, BOARD_CZ - PAN_LIMIT, BOARD_CZ + PAN_LIMIT);
    },

    resetView() {
      yaw = 0;
      pitch = PITCH_START;
      distance = CAMERA_START_DISTANCE;
      focus.set(BOARD_CX, 0, BOARD_CZ);
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

    project(point) {
      const projected = point.clone().project(camera);
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

    animateScenery(elapsed) {
      torches.forEach((torch, i) => {
        const flicker = 0.82 + Math.sin(elapsed * 9 + i * 1.7) * 0.09 + Math.sin(elapsed * 23 + i) * 0.05;
        // Four torches over a 9x9 floor. Each has a whole wall to carry, but
        // the room is small enough that the real-time game's brightness would
        // wash the flagstones out.
        torch.light.intensity = 8 * flicker;
        torch.flame.scale.setScalar(0.85 + flicker * 0.25);
      });
      // The way out breathes, so it reads as an exit rather than as decoration.
      const pulse = 0.42 + Math.sin(elapsed * 2.2) * 0.1;
      (escapeGlow.material as THREE.MeshBasicMaterial).opacity = 0.55 + Math.sin(elapsed * 2.2) * 0.18;
      (archGlow.material as THREE.MeshBasicMaterial).opacity = pulse;
      archLight.intensity = 4.5 + Math.sin(elapsed * 2.2) * 1.1;
    },

    render() {
      renderer.render(scene, camera);
    },
  };
}

/** Board dimensions the client's own code needs — kept with the board itself. */
export const BOARD = { x0: BOARD_X0, z0: BOARD_Z0, w: BOARD_W, d: BOARD_D, stride: STRIDE };
