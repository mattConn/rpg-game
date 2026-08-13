/**
 * The 3D stage: renderer, camera rig, the room itself, and the flat markers
 * that stand in for the 2D game's ground decoration (cursor cell, target ring,
 * move destination).
 *
 * The camera is a fixed-yaw 3/4 view that follows the player. The yaw is
 * deliberately *not* orbitable: WASD is world-relative on the server, so a
 * rotatable camera would quietly break the meaning of "w".
 */

import * as THREE from "three";

import { WORLD_HEIGHT, WORLD_WIDTH } from "../../../src/shared/constants.js";
import { buildTorch } from "./models.js";
import { clamp } from "../../../src/shared/movement.js";
import { ROOM_D, ROOM_W, damp, toPixelX, toPixelY, toX, toZ } from "./world.js";

const CAMERA_PITCH = 0.95; // radians above the horizon
const CAMERA_MIN_DISTANCE = 8;
const CAMERA_MAX_DISTANCE = 34;
/**
 * Close enough that the player reads as a person rather than a chip, far enough
 * that a hellhound entering at `CHASE_RANGE` is already on screen. The wheel
 * pulls back to the whole arena when you want it.
 */
const CAMERA_START_DISTANCE = 16;

export interface Stage {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  /** Everything selectable by a click lives here, so picking is one call. */
  readonly pickables: THREE.Object3D[];
  resize(displayWidth: number, displayHeight: number, dpr: number): void;
  /** Follow the player, in room pixels. */
  updateCamera(px: number, py: number, dt: number, snap: boolean): void;
  zoom(delta: number): void;
  /** Where a screen ray meets the floor, in room pixels — null if it misses. */
  groundAt(ndcX: number, ndcY: number): { x: number; y: number } | null;
  /** What a screen ray hits first among `pickables`, or null. */
  pickAt(ndcX: number, ndcY: number): THREE.Object3D | null;
  /** A world point in the 2D overlay's 1200x900 coordinates. */
  project(point: THREE.Vector3): { x: number; y: number };
  setCursorCell(col: number | null, row: number | null): void;
  setMoveMarker(px: number | null, py: number | null): void;
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
  scene.fog = new THREE.Fog(0x0b0b12, 42, 95);

  const camera = new THREE.PerspectiveCamera(50, WORLD_WIDTH / WORLD_HEIGHT, 0.1, 300);

  // ------------------------------------------------------------------ lights

  // Bright enough to read the arena at a glance — the 2D game was high-contrast
  // glyphs on black, and a murky dungeon would lose the wolf against the floor.
  scene.add(new THREE.AmbientLight(0x6e779c, 2.9));
  scene.add(new THREE.HemisphereLight(0x9aa2cc, 0x46392a, 1.8));

  // Lit from the camera's side of the room, so faces, muzzles and the inner
  // face of the far wall all catch the light instead of falling into shadow.
  const sun = new THREE.DirectionalLight(0xffe9c4, 3.4);
  sun.position.set(ROOM_W * 0.35, 26, ROOM_D + 8);
  sun.target.position.set(ROOM_W / 2, 0, ROOM_D / 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -30;
  sun.shadow.camera.right = 30;
  sun.shadow.camera.top = 30;
  sun.shadow.camera.bottom = -30;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 70;
  sun.shadow.bias = -0.0009;
  scene.add(sun);
  scene.add(sun.target);

  // -------------------------------------------------------------------- floor

  const floorGeometry = new THREE.PlaneGeometry(ROOM_W, ROOM_D, ROOM_W, ROOM_D);
  floorGeometry.rotateX(-Math.PI / 2);

  // Nudge each vertex a few centimetres so flat shading has something to catch;
  // a perfectly flat plane reads as a void, not a floor.
  const position = floorGeometry.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(position.count * 3);
  const stone = new THREE.Color(0x41414d);
  for (let i = 0; i < position.count; i++) {
    position.setY(i, (Math.random() - 0.5) * 0.06);
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
  floor.position.set(ROOM_W / 2, 0, ROOM_D / 2);
  floor.receiveShadow = true;
  scene.add(floor);

  // An apron of darker stone well past the walls. The camera trails behind the
  // player, so at the south edge it looks in from outside the room — without
  // this it would be looking over the parapet into a hole. Fog swallows the far
  // end of it, which reads as a dungeon continuing into the dark.
  const apronGeometry = new THREE.PlaneGeometry(ROOM_W * 2.4, ROOM_D * 2.6);
  apronGeometry.rotateX(-Math.PI / 2);
  const apron = new THREE.Mesh(apronGeometry, new THREE.MeshLambertMaterial({ color: 0x22222b }));
  apron.position.set(ROOM_W / 2, -0.04, ROOM_D / 2);
  apron.receiveShadow = true;
  scene.add(apron);

  // The 30px tile grid is deliberately *not* drawn. Movement is pixel-based and
  // ignores the grid, so ruling it across the floor advertises a structure the
  // game doesn't have. The cursor highlight still snaps to it — that reads as a
  // highlight, not as a lattice.

  // -------------------------------------------------------------------- walls

  const wallMaterial = new THREE.MeshLambertMaterial({ color: 0x3b3b45, flatShading: true });
  const capMaterial = new THREE.MeshLambertMaterial({ color: 0x4c4c58, flatShading: true });
  const WALL_H = 3.4;
  const WALL_T = 0.8;

  const addWall = (w: number, d: number, x: number, z: number, height = WALL_H) => {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, height, d), wallMaterial);
    wall.position.set(x, height / 2, z);
    wall.castShadow = true;
    wall.receiveShadow = true;
    scene.add(wall);

    const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.2, 0.22, d + 0.2), capMaterial);
    cap.position.set(x, height + 0.11, z);
    cap.castShadow = true;
    scene.add(cap);
  };

  addWall(ROOM_W + WALL_T * 2, WALL_T, ROOM_W / 2, -WALL_T / 2);
  addWall(WALL_T, ROOM_D + WALL_T * 2, -WALL_T / 2, ROOM_D / 2);
  addWall(WALL_T, ROOM_D + WALL_T * 2, ROOM_W + WALL_T / 2, ROOM_D / 2);
  // The south wall is a low parapet. The camera yaw is fixed, so this is always
  // the *near* wall: at full height it fills the bottom of the screen whenever
  // the player backs into it, and you end up looking at masonry instead of the
  // fight.
  addWall(ROOM_W + WALL_T * 2, WALL_T, ROOM_W / 2, ROOM_D + WALL_T / 2, 0.9);

  // ------------------------------------------------------------------ torches

  const torches: Array<ReturnType<typeof buildTorch>> = [];
  // On the three full-height walls only — the south parapet is too low to hold
  // a bracket, and a torch floating over it reads as a bug.
  const torchSpots: Array<[number, number]> = [
    [ROOM_W * 0.3, 0.3], [ROOM_W * 0.7, 0.3],
    [0.3, ROOM_D * 0.3], [0.3, ROOM_D * 0.72],
    [ROOM_W - 0.3, ROOM_D * 0.3], [ROOM_W - 0.3, ROOM_D * 0.72],
  ];
  for (const [x, z] of torchSpots) {
    const torch = buildTorch();
    torch.group.position.set(x, 2.1, z);
    scene.add(torch.group);
    torches.push(torch);
  }

  // ------------------------------------------------------------------ markers

  const flatQuad = (color: number, opacity: number) => {
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    return new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
    );
  };

  const cursorCell = flatQuad(0xffffff, 0.16);
  cursorCell.position.y = 0.03;
  cursorCell.visible = false;
  scene.add(cursorCell);

  // The walked path isn't drawn. `snapshot.pathCells` is still computed server
  // side for the 2D client; here the destination ring is the whole answer to
  // "where am I going", and a trail of lit tiles behind it only added clutter.

  const moveRingGeometry = new THREE.RingGeometry(0.24, 0.34, 20);
  moveRingGeometry.rotateX(-Math.PI / 2);
  const moveMarker = new THREE.Mesh(
    moveRingGeometry,
    new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.75, depthWrite: false }),
  );
  moveMarker.visible = false;
  scene.add(moveMarker);

  const targetRingGeometry = new THREE.RingGeometry(0.62, 0.8, 28);
  targetRingGeometry.rotateX(-Math.PI / 2);
  const targetRingMaterial = new THREE.MeshBasicMaterial({
    color: 0xffd633, transparent: true, opacity: 0.9, depthWrite: false,
  });
  const targetRing = new THREE.Mesh(targetRingGeometry, targetRingMaterial);
  targetRing.visible = false;
  scene.add(targetRing);

  // ------------------------------------------------------------------ camera

  const followTarget = new THREE.Vector3(ROOM_W / 2, 0, ROOM_D / 2);
  let distance = CAMERA_START_DISTANCE;

  const applyCamera = () => {
    // Held inside the east/west/north walls, because outside them the masonry
    // gets between the camera and the player. It may trail past the south wall,
    // which is only a parapet and blocks nothing. When a clamp bites, the
    // player slides off-centre rather than the view leaving the room.
    camera.position.set(
      clamp(followTarget.x, 1, ROOM_W - 1),
      followTarget.y + Math.sin(CAMERA_PITCH) * distance,
      clamp(followTarget.z + Math.cos(CAMERA_PITCH) * distance, 1, ROOM_D + 5),
    );
    camera.lookAt(followTarget.x, followTarget.y + 0.9, followTarget.z);
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
    camera,
    renderer,
    pickables,

    resize(displayWidth, displayHeight, dpr) {
      renderer.setPixelRatio(dpr);
      renderer.setSize(displayWidth, displayHeight, false);
      canvas.style.width = `${displayWidth}px`;
      canvas.style.height = `${displayHeight}px`;
      camera.aspect = WORLD_WIDTH / WORLD_HEIGHT;
      camera.updateProjectionMatrix();
    },

    updateCamera(px, py, dt, snap) {
      const x = toX(px);
      const z = toZ(py);
      if (snap) followTarget.set(x, 0, z);
      else {
        followTarget.x = damp(followTarget.x, x, 7, dt);
        followTarget.z = damp(followTarget.z, z, 7, dt);
      }
      applyCamera();
    },

    zoom(delta) {
      distance = Math.min(CAMERA_MAX_DISTANCE, Math.max(CAMERA_MIN_DISTANCE, distance + delta));
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

    setCursorCell(col, row) {
      if (col === null || row === null) {
        cursorCell.visible = false;
        return;
      }
      cursorCell.visible = true;
      cursorCell.position.set(col + 0.5, 0.03, row + 0.5);
    },

    setMoveMarker(px, py) {
      if (px === null || py === null) {
        moveMarker.visible = false;
        return;
      }
      moveMarker.visible = true;
      moveMarker.position.set(toX(px), 0.04, toZ(py));
    },

    setTargetRing(px, py, color) {
      if (px === null || py === null) {
        targetRing.visible = false;
        return;
      }
      targetRing.visible = true;
      targetRingMaterial.color.setHex(color);
      targetRing.position.set(toX(px), 0.04, toZ(py));
    },

    animateScenery(elapsed) {
      // Torches flicker on their own offset so they don't pulse in unison.
      torches.forEach((torch, i) => {
        const flicker = 0.82 + Math.sin(elapsed * 9 + i * 1.7) * 0.09 + Math.sin(elapsed * 23 + i) * 0.05;
        torch.light.intensity = 9 * flicker;
        torch.flame.scale.setScalar(0.85 + flicker * 0.25);
      });
      moveMarker.scale.setScalar(1 + Math.sin(elapsed * 6) * 0.08);
    },

    render() {
      renderer.render(scene, camera);
    },
  };
}
