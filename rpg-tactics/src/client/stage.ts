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

  /**
   * A slab of noisy stone. A few centimetres of displacement per vertex so flat
   * shading has something to catch — a perfectly flat plane reads as a void
   * rather than as a floor — and one shade per vertex on top of that.
   */
  const stoneFloor = (w: number, d: number) => {
    const geometry = new THREE.PlaneGeometry(w, d, Math.ceil(w), Math.ceil(d));
    geometry.rotateX(-Math.PI / 2);

    const position = geometry.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(position.count * 3);
    const stone = new THREE.Color(0x3a3a45);
    for (let i = 0; i < position.count; i++) {
      position.setY(i, (Math.random() - 0.5) * 0.05);
      const shade = 0.82 + Math.random() * 0.36;
      colors[i * 3] = stone.r * shade;
      colors[i * 3 + 1] = stone.g * shade;
      colors[i * 3 + 2] = stone.b * shade;
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();

    const floor = new THREE.Mesh(
      geometry,
      new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
    );
    floor.receiveShadow = true;
    return floor;
  };

  // The apron: darker stone running out past the walls, so the camera looking
  // in from outside sees a dungeon continuing into the dark rather than a hole.
  // It has to cover both rooms and the hall between them, so it is sized from
  // the whole complex rather than from the board.
  const apron = new THREE.Mesh(
    new THREE.PlaneGeometry(CHAMBER_W * 3, (FAR_CZ - BOARD_CZ) + CHAMBER_D * 3).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0x1e1e26 }),
  );
  apron.position.set(BOARD_CX, -0.06, (BOARD_CZ + FAR_CZ) / 2);
  scene.add(apron);

  // -------------------------------------------------------------------- walls

  const wallMaterial = new THREE.MeshLambertMaterial({ color: 0x3b3b45, flatShading: true });
  const capMaterial = new THREE.MeshLambertMaterial({ color: 0x4c4c58, flatShading: true });
  const archMaterial = new THREE.MeshLambertMaterial({ color: 0x565062, flatShading: true });

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
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.34, WALL_H + 0.5, WALL_T + 0.3), archMaterial);
      post.position.set(x, (WALL_H + 0.5) / 2, z);
      post.castShadow = true;
      scene.add(post);
    }
    const lintel = new THREE.Mesh(
      new THREE.BoxGeometry(PASSAGE_W + 0.5, 0.4, WALL_T + 0.4),
      archMaterial,
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

  const TORCH_INSET = 0.25;
  const torches: Array<ReturnType<typeof buildTorch>> = [];

  const addTorch = (x: number, z: number) => {
    const torch = buildTorch();
    torch.group.position.set(x, 1.9, z);
    scene.add(torch.group);
    torches.push(torch);
  };

  /**
   * One room, and the only room there is: floor, slab, four walls with the
   * passage's gap in one of them, and a torch at the midpoint of each wall.
   *
   * The far room is this same call with the gap on its north side — which is
   * what "identical" means here. There is one room, built twice, so anything
   * done to the arena is done to what you see through the arch by construction.
   */
  const buildChamber = (cz: number, doorway: "north" | "south") => {
    const floor = stoneFloor(CHAMBER_W, CHAMBER_D);
    floor.position.set(BOARD_CX, 0, cz);
    scene.add(floor);

    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(BOARD_W, 0.1, BOARD_D),
      new THREE.MeshLambertMaterial({ color: 0x4e4e59, flatShading: true }),
    );
    slab.position.set(BOARD_CX, 0.05, cz);
    slab.receiveShadow = true;
    scene.add(slab);

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
    addTorch(BOARD_CX, north + TORCH_INSET);
    addTorch(BOARD_CX, south - TORCH_INSET);
    addTorch(west + TORCH_INSET, cz);
    addTorch(east - TORCH_INSET, cz);
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

  addTorch(archLeft + TORCH_INSET, hallCZ);
  addTorch(archRight - TORCH_INSET, hallCZ);

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

  let yaw = 0;
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
  const smoothed = { yaw, pitch, distance, x: focus.x, z: focus.z };

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
      camera.position.set(
        smoothed.x + Math.sin(smoothed.yaw) * horizontal,
        Math.sin(smoothed.pitch) * smoothed.distance,
        smoothed.z + Math.cos(smoothed.yaw) * horizontal,
      );
      camera.lookAt(smoothed.x, 0.9, smoothed.z);
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
      // V is "put the view back", and first person is a view. Being dropped
      // into your own head with no way out but the same key you pressed to get
      // there is the kind of thing a reset exists to undo.
      firstPerson = false;
      yaw = 0;
      pitch = PITCH_START;
      overheadPitch = PITCH_START;
      smoothed.pitch = pitch;
      distance = CAMERA_START_DISTANCE;
      panOffset.x = 0;
      panOffset.z = 0;
      applyFocus();
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

    animateScenery(elapsed) {
      torches.forEach((torch, i) => {
        const flicker = 0.82 + Math.sin(elapsed * 9 + i * 1.7) * 0.09 + Math.sin(elapsed * 23 + i) * 0.05;
        // Ten brackets — four to a room and two down the hall. Each has a whole
        // wall to carry, but the rooms are small enough that the real-time
        // game's brightness would wash their floors out.
        torch.light.intensity = 8 * flicker;
        torch.flame.scale.setScalar(0.85 + flicker * 0.25);
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
