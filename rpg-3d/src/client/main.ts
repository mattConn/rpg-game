/**
 * Render-only WebSocket client, exactly like the 2D one: it sends user input
 * and draws the `GameSnapshot` it gets back. No simulation runs here.
 *
 * The only genuinely new problem in 3D is that screen space and room space are
 * no longer the same thing. Two rules keep that from leaking into the game:
 *
 * - **A click is resolved to a room point before it is sent.** Hitting a wolf's
 *   head sends the wolf's own position, so the server's `enemyAtPoint` decides
 *   what was clicked with exactly the radius it always used.
 * - **The UI is hit-tested on the overlay**, in 1200x900 room units, which is
 *   where it is drawn — so the HUD, action bar and loot menu behave identically.
 */

import * as THREE from "three";

import { ACTIONS } from "../../../src/shared/actions.js";
import { WORLD_HEIGHT, WORLD_WIDTH } from "../../../src/shared/constants.js";
import { LOOT_CLOSE_RECT, hitsRect, lootMenuProxyPoint } from "../../../src/shared/loot.js";
import type { Point } from "../../../src/shared/movement.js";
import type { GameSnapshot, InputMessage } from "../../../src/shared/protocol.js";
import { worldToCell } from "../../../src/shared/tilemap.js";
import { squareAtPoint } from "../../../src/client/actionbar.js";
import { DEFAULT_CURSOR } from "../../../src/client/cursors.js";
import { SERVER_TICK_MS, renderFraction, smoothInterval } from "../../../src/client/interpolation.js";
import { fitToViewport } from "../../../src/client/viewport.js";
import { Actors, applyCues, entityIdOf } from "./entities.js";
import { autoResRect, barOrigin, drawOverlay, hits, resurrectRect } from "./overlay.js";
import { interpolateSnapshot } from "./playback.js";
import { createStage } from "./scene.js";
import { toX, toZ } from "./world.js";

// ------------------------------------------------------------------ canvases

const sceneCanvas = document.getElementById("scene") as HTMLCanvasElement;
const uiCanvas = document.getElementById("ui") as HTMLCanvasElement;
const ctx = uiCanvas.getContext("2d")!;

const stage = createStage(sceneCanvas);

function resize() {
  const fit = fitToViewport(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);

  uiCanvas.style.width = `${fit.displayWidth}px`;
  uiCanvas.style.height = `${fit.displayHeight}px`;
  uiCanvas.width = fit.pixelWidth;
  uiCanvas.height = fit.pixelHeight;
  ctx.setTransform(fit.pixelWidth / WORLD_WIDTH, 0, 0, fit.pixelHeight / WORLD_HEIGHT, 0, 0);

  stage.resize(fit.displayWidth, fit.displayHeight, window.devicePixelRatio || 1);
}

window.addEventListener("resize", resize);
resize();

// ---------------------------------------------------------------- websocket

let prevSnapshot: GameSnapshot | null = null;
let currSnapshot: GameSnapshot | null = null;
let prevSnapshotTime = 0;
let currSnapshotTime = 0;

/** Smoothed playback interval for the lerp — see `interpolation.ts`. */
let snapshotInterval = SERVER_TICK_MS;

/** Client-side animation cues, derived from what changed between snapshots. */
let hurt = 0;
let actors: Actors | null = null;

const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl = `${wsProtocol}//${location.host}`;

function connectWebSocket() {
  const ws = new WebSocket(wsUrl);

  ws.addEventListener("message", (event) => {
    try {
      const snap = JSON.parse(event.data as string) as GameSnapshot;
      onSnapshot(snap);
      prevSnapshot = currSnapshot;
      prevSnapshotTime = currSnapshotTime;
      currSnapshot = snap;
      currSnapshotTime = performance.now();
      if (prevSnapshot) snapshotInterval = smoothInterval(snapshotInterval, currSnapshotTime - prevSnapshotTime);
    } catch {
      // Ignore malformed messages.
    }
  });

  ws.addEventListener("close", () => {
    setTimeout(connectWebSocket, 1000);
  });

  ws.addEventListener("error", () => {
    ws.close();
  });

  return ws;
}

let socket = connectWebSocket();

function send(msg: InputMessage) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

/** Derive this frame's animation cues from the state that just changed. */
function onSnapshot(snap: GameSnapshot): void {
  if (!currSnapshot || !actors) return;
  if (applyCues(actors, currSnapshot, snap, performance.now())) hurt = 1;
}

// -------------------------------------------------------------------- input

window.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();

  if (event.code === "Tab") {
    // Tab toggles the nearest target, so swallow the browser's auto-repeat —
    // held down it would strobe engage/disengage. preventDefault also keeps
    // focus from walking off the canvas.
    event.preventDefault();
    if (!event.repeat) send({ type: "keydown", key, code: event.code });
    return;
  }

  if ((key.length === 1 && key >= "1" && key <= "5") || "wasd".includes(key)) {
    send({ type: "keydown", key, code: event.code });
    event.preventDefault();
  }
});

window.addEventListener("keyup", (event) => {
  send({ type: "keyup", key: event.key.toLowerCase() });
});

window.addEventListener("blur", () => {
  for (const key of ["w", "a", "s", "d"]) send({ type: "keyup", key });
});

/** Mouse position in the overlay's room units — where the UI is hit-tested. */
function toOverlay(event: MouseEvent): Point {
  const bounds = uiCanvas.getBoundingClientRect();
  return {
    x: (event.clientX - bounds.left) * (WORLD_WIDTH / bounds.width),
    y: (event.clientY - bounds.top) * (WORLD_HEIGHT / bounds.height),
  };
}

/** Mouse position in normalised device coordinates — where the 3D is picked. */
function toNdc(event: MouseEvent): { x: number; y: number } {
  const bounds = uiCanvas.getBoundingClientRect();
  return {
    x: ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
    y: -(((event.clientY - bounds.top) / bounds.height) * 2 - 1),
  };
}

/**
 * The room point a click means. An entity under the cursor resolves to *its
 * own* position rather than to the floor behind it, which is what makes
 * clicking a tall model land inside the server's flat `ENEMY_RADIUS` circle.
 */
function pickRoomPoint(event: MouseEvent): Point | null {
  const ndc = toNdc(event);
  const id = entityIdOf(stage.pickAt(ndc.x, ndc.y));

  if (id && currSnapshot) {
    const hit =
      currSnapshot.enemies.find((e) => e.id === id) ??
      currSnapshot.corpses.find((c) => c.id === id);
    if (hit) return { x: hit.x, y: hit.y };
  }

  return stage.groundAt(ndc.x, ndc.y);
}

uiCanvas.addEventListener("click", (event) => {
  const uiPoint = toOverlay(event);

  // Resurrect button when dead — checked before anything else, as in 2D.
  if (currSnapshot?.dead && hits(resurrectRect(ctx), uiPoint)) {
    send({ type: "resurrect" });
    return;
  }

  if (hits(autoResRect(ctx), uiPoint)) {
    send({ type: "toggleAutoResurrect" });
    return;
  }

  const slot = squareAtPoint(barOrigin, uiPoint);
  if (slot !== null) {
    if (ACTIONS[slot]) send({ type: "slot", index: slot });
    return;
  }

  if (currSnapshot?.inspect) {
    const point = lootMenuProxyPoint(uiPoint);
    send({ type: "click", x: point.x, y: point.y });
    return;
  }

  const point = pickRoomPoint(event);
  if (point) send({ type: "click", x: point.x, y: point.y });
});

// The browser's own double-click. The leading clicks only ever select a target
// or start a walk, so letting them through before this arrives is harmless.
uiCanvas.addEventListener("dblclick", (event) => {
  const point = pickRoomPoint(event);
  if (point) send({ type: "dblclick", x: point.x, y: point.y });
});

// Keep the browser menu off the canvas; right-click has no game meaning.
uiCanvas.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

// Zoom is the one camera control. The yaw stays fixed: WASD is world-relative
// on the server, so a turnable camera would quietly change what "w" means.
uiCanvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  stage.zoom(Math.sign(event.deltaY) * 1.6);
}, { passive: false });

/** Cursor in overlay units (UI hit-testing) and on the floor (world reveals). */
let uiCursor: Point | null = null;
let groundCursor: Point | null = null;

uiCanvas.addEventListener("mousemove", (event) => {
  uiCursor = toOverlay(event);
  const ndc = toNdc(event);
  groundCursor = stage.groundAt(ndc.x, ndc.y);
});

uiCanvas.addEventListener("mouseleave", () => {
  uiCursor = null;
  groundCursor = null;
});

let appliedCursor = DEFAULT_CURSOR;

function updateCursorStyle(snap: GameSnapshot) {
  let wanted = DEFAULT_CURSOR;
  if (uiCursor) {
    if (snap.inspect && hitsRect(LOOT_CLOSE_RECT, uiCursor)) wanted = "pointer";
    else if (snap.dead && hits(resurrectRect(ctx), uiCursor)) wanted = "pointer";
    else if (hits(autoResRect(ctx), uiCursor)) wanted = "pointer";
  }

  if (wanted !== appliedCursor) {
    uiCanvas.style.cursor = wanted;
    appliedCursor = wanted;
  }
}

// ----------------------------------------------------------------- game loop

const projectionPoint = new THREE.Vector3();

/** Room point at a height in 3D units -> overlay coordinates, for labels. */
function toScreen(px: number, py: number, height: number): Point {
  projectionPoint.set(toX(px), height, toZ(py));
  return stage.project(projectionPoint);
}

let lastFrameTime = performance.now();
let firstFrame = true;

function frame(now: number) {
  requestAnimationFrame(frame);

  const dt = Math.min((now - lastFrameTime) / 1000, 0.1);
  lastFrameTime = now;
  const elapsed = now / 1000;

  if (!currSnapshot) return;

  const t = renderFraction(now, currSnapshotTime, snapshotInterval, prevSnapshot !== null);
  const snap = prevSnapshot
    ? interpolateSnapshot(prevSnapshot, currSnapshot, t, now - currSnapshotTime)
    : currSnapshot;

  if (!actors) actors = new Actors(stage.scene, stage.pickables, snap.player.color);

  // The blade in the fist follows the action bar, like the 2D glyph did.
  actors.player.setWeapon(ACTIONS[snap.activeSlot]?.kind ?? "melee");

  // Engaged fighters square up to their target — rendering only; nothing about
  // range or facing is a rule in this game.
  const engaged = snap.attacking && snap.targetId
    ? snap.enemies.find((e) => e.id === snap.targetId)
    : undefined;

  actors.player.update(snap, engaged ? { x: engaged.x, y: engaged.y } : null, dt, now, elapsed);
  actors.syncEnemies(snap, dt, now, elapsed);
  actors.syncCorpses(snap, dt);
  actors.syncProjectiles(snap, elapsed);
  actors.syncTombstones(snap);

  // Ground decoration, laid flat on the floor: where you're headed, and the
  // tile under the cursor.
  stage.setMoveMarker(snap.moveTarget?.x ?? null, snap.moveTarget?.y ?? null);

  if (groundCursor) {
    const cell = worldToCell(groundCursor.x, groundCursor.y);
    stage.setCursorCell(cell.col, cell.row);
  } else {
    stage.setCursorCell(null, null);
  }

  // The ring under the target: red while fighting it, yellow when merely
  // selected — the 2D ring's colours, moved to the floor.
  const targeted = snap.targetId
    ? snap.enemies.find((e) => e.id === snap.targetId) ?? snap.corpses.find((c) => c.id === snap.targetId)
    : undefined;
  const fighting = !!engaged && engaged.id === snap.targetId;
  stage.setTargetRing(targeted?.x ?? null, targeted?.y ?? null, fighting ? 0xe23b3b : 0xffd633);

  stage.updateCamera(snap.player.x, snap.player.y, dt, firstFrame);
  stage.animateScenery(elapsed);
  stage.render();

  hurt = Math.max(0, hurt - dt * 1.6);
  updateCursorStyle(snap);
  drawOverlay(ctx, { snap, uiCursor, groundCursor, toScreen, hurt });

  firstFrame = false;
}

uiCanvas.style.cursor = DEFAULT_CURSOR;
requestAnimationFrame(frame);
