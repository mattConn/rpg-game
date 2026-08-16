/**
 * Render-only WebSocket client for the turn-based game. It sends input and
 * draws the `TacticsSnapshot` it gets back; no rule is decided here.
 *
 * Almost none of this is new work. `Actors`, `applyCues`, `interpolateSnapshot`
 * and the entire 2D overlay are **imported from the real-time 3D client** —
 * their job is to turn a snapshot into models, animation and a HUD, and that job
 * did not change when the rules did. What this file adds is the board's own
 * input language:
 *
 * - **a click resolves to a room point before it is sent**, as in the real-time
 *   client, so the server decides what was clicked using the geometry it owns —
 *   here, which of the nine squares the point fell in;
 * - **a drag is a camera move, not a click.** Anything past a few pixels of
 *   travel swallows the click that follows, or every attempt to look around the
 *   board would also order a step.
 */

import * as THREE from "three";

import { ACTIONS } from "../../../src/shared/actions.js";
import { WORLD_HEIGHT, WORLD_WIDTH } from "../../../src/shared/constants.js";
import { LOOT_CLOSE_RECT, hitsRect, lootMenuProxyPoint } from "../../../src/shared/loot.js";
import type { Point } from "../../../src/shared/movement.js";
import { squareAtPoint } from "../../../src/client/actionbar.js";
import { DEFAULT_CURSOR } from "../../../src/client/cursors.js";
import { SERVER_TICK_MS, renderFraction, smoothInterval } from "../../../src/client/interpolation.js";
import { fitToViewport } from "../../../src/client/viewport.js";
import { Actors, applyCues, entityIdOf } from "../../../rpg-3d/src/client/entities.js";
import { autoResRect, barOrigin, drawOverlay, hits, resurrectRect } from "../../../rpg-3d/src/client/overlay.js";
import { interpolateSnapshot } from "../../../rpg-3d/src/client/playback.js";
import { toX, toZ } from "../../../rpg-3d/src/client/world.js";
import {
  cellAtPoint,
  distance,
  isOver,
  type TacticsInput,
  type TacticsSnapshot,
} from "../shared/tactics.js";
import { attackRect, drawTacticsChrome, hitsButton, waitRect } from "./chrome.js";
import { createStage } from "./stage.js";

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

let prevSnapshot: TacticsSnapshot | null = null;
let currSnapshot: TacticsSnapshot | null = null;
let prevSnapshotTime = 0;
let currSnapshotTime = 0;
let snapshotInterval = SERVER_TICK_MS;

let actors: Actors | null = null;

// --------------------------------------------------------------- sword swing
const SWING_DURATION = 250;
let swingStartTime = -Infinity;

const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl = `${wsProtocol}//${location.host}`;

function connectWebSocket() {
  const ws = new WebSocket(wsUrl);

  ws.addEventListener("message", (event) => {
    try {
      const snap = JSON.parse(event.data as string) as TacticsSnapshot;
      const now = performance.now();
      if (currSnapshot && actors) applyCues(actors, currSnapshot, snap, now, struckBy);

      // Detect a fresh melee cooldown to trigger the sword swing overlay.
      const before = currSnapshot?.cooldown;
      const after = snap.cooldown;
      if (
        after &&
        (!before || before.slot !== after.slot || after.remainingMs > before.remainingMs + 1) &&
        ACTIONS[snap.activeSlot]?.kind === "melee"
      ) {
        swingStartTime = now;
      }

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

/**
 * Which hellhounds just bit, straight from the simulation. A round resolves
 * whole, so both of them can land in the same snapshot; each blow carries a seq
 * that only ever rises, and anything above the highest already seen is new.
 * Guessing at the nearest hunter would give both bites to whichever happened to
 * be a pixel closer.
 */
function struckBy(previous: TacticsSnapshot, snap: TacticsSnapshot): string[] {
  const seen = previous.strikes.reduce((highest, s) => Math.max(highest, s.seq), 0);
  return snap.strikes.filter((s) => s.seq > seen).map((s) => s.enemyId);
}

let socket = connectWebSocket();

function send(msg: TacticsInput) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

// ---------------------------------------------------------------- keyboard

/**
 * Tank controls. A/D and arrow left/right turn the camera (yaw). W moves
 * forward, S moves backward — always along the direction the camera faces.
 * The camera yaw *is* the player's heading.
 */

/** Yaw turn speed in radians per second. */
const TURN_SPEED = 2.8;

const heldKeys = new Set<string>();

function sendMoveDir(): void {
  const cameraYaw = stage.yaw;
  const fwdX = -Math.sin(cameraYaw);
  const fwdY = -Math.cos(cameraYaw);

  let dx = 0;
  let dy = 0;
  if (heldKeys.has("w")) { dx += fwdX; dy += fwdY; }
  if (heldKeys.has("s")) { dx -= fwdX; dy -= fwdY; }

  send({ type: "move", dx, dy });
}

/** Apply held-key turning each frame. Called from the game loop. */
function updateTankControls(dt: number): void {
  let turn = 0;
  if (heldKeys.has("a") || heldKeys.has("arrowleft")) turn += TURN_SPEED * dt;
  if (heldKeys.has("d") || heldKeys.has("arrowright")) turn -= TURN_SPEED * dt;
  // Reverse steering while walking backwards, like driving a car in reverse.
  if (heldKeys.has("s") && !heldKeys.has("w")) turn = -turn;
  if (turn !== 0) {
    // orbit expects screen-pixel deltas; convert radians to the equivalent.
    // stage.orbit applies yaw -= dx * ROTATE_SPEED, so dx = -turn / ROTATE_SPEED.
    stage.orbit(-turn / 0.006, 0);
  }

  // Re-send movement direction whenever keys are held, since the yaw may have
  // changed from turning.
  if (heldKeys.has("w") || heldKeys.has("s")) sendMoveDir();
}

window.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();

  if (event.code === "Tab") {
    event.preventDefault();
    if (!event.repeat) send({ type: "keydown", key, code: event.code });
    return;
  }

  if (key === "v") {
    stage.resetView();
    event.preventDefault();
    return;
  }

  // Tank movement and turning keys.
  if (key === "w" || key === "a" || key === "s" || key === "d" ||
      key === "arrowleft" || key === "arrowright" ||
      key === "arrowup" || key === "arrowdown") {
    // Map arrow up/down to forward/back.
    const mapped = key === "arrowup" ? "w" : key === "arrowdown" ? "s" : key;
    if (!heldKeys.has(mapped)) {
      heldKeys.add(mapped);
      if (mapped === "w" || mapped === "s") sendMoveDir();
    }
    event.preventDefault();
    return;
  }

  // 1-5 choose a weapon, space swings it, r restarts, escape drops the mark.
  if (
    (key.length === 1 && key >= "1" && key <= "5") ||
    key === " " ||
    key === "r" ||
    key === "escape"
  ) {
    send({ type: "keydown", key, code: event.code });
    event.preventDefault();
  }
});

window.addEventListener("keyup", (event) => {
  const key = event.key.toLowerCase();
  const mapped = key === "arrowup" ? "w" : key === "arrowdown" ? "s" : key;
  if (heldKeys.has(mapped)) {
    heldKeys.delete(mapped);
    if (mapped === "w" || mapped === "s") sendMoveDir();
  }
});

// --------------------------------------------------------------- pointer

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
 * The room point a click means. An entity under the cursor resolves to *its own*
 * position rather than to the floor behind it — so clicking a hellhound's head,
 * which hangs over the square in front of it at a low camera angle, still names
 * the square the hellhound is standing on.
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

// -------------------------------------------------------------- camera drag

/** Past this much travel a press is a camera move, and the click is swallowed. */
const DRAG_THRESHOLD = 4;

let dragButton: number | null = null;
let dragPanning = false;
let dragMoved = 0;
let lastDragX = 0;
let lastDragY = 0;
let swallowNextClick = false;

uiCanvas.addEventListener("mousedown", (event) => {
  dragButton = event.button;
  dragPanning = event.button === 2 || event.button === 1 || event.shiftKey;
  dragMoved = 0;
  lastDragX = event.clientX;
  lastDragY = event.clientY;
  if (dragPanning) event.preventDefault();
});

window.addEventListener("mouseup", () => {
  if (dragButton !== null && dragMoved > DRAG_THRESHOLD) swallowNextClick = true;
  dragButton = null;
});

/** Cursor in overlay units (UI hit-testing) and on the floor (world reveals). */
let uiCursor: Point | null = null;
let groundCursor: Point | null = null;

uiCanvas.addEventListener("mousemove", (event) => {
  if (dragButton !== null) {
    const dx = event.clientX - lastDragX;
    const dy = event.clientY - lastDragY;
    lastDragX = event.clientX;
    lastDragY = event.clientY;
    dragMoved += Math.abs(dx) + Math.abs(dy);
    if (dragMoved > DRAG_THRESHOLD) {
      if (dragPanning && !stage.firstPerson) stage.pan(dx, dy);
      else stage.orbit(dx, dy);
    }
  }

  uiCursor = toOverlay(event);
  const ndc = toNdc(event);
  groundCursor = stage.groundAt(ndc.x, ndc.y);
});

uiCanvas.addEventListener("mouseleave", () => {
  uiCursor = null;
  groundCursor = null;
});

uiCanvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  stage.zoom(Math.sign(event.deltaY) * 1.8);
}, { passive: false });

// Right-drag pans, so the browser menu must never appear on the canvas.
uiCanvas.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

// A right-click (that wasn't a pan drag) toggles whichever door is under it.
uiCanvas.addEventListener("auxclick", (event) => {
  if (event.button !== 2) return;
  if (dragMoved > DRAG_THRESHOLD) return;
  const ndc = toNdc(event);
  const doorIndex = stage.toggleDoorAt(ndc.x, ndc.y);
  if (doorIndex !== null) send({ type: "toggleDoor", index: doorIndex });
});

// ----------------------------------------------------------------- clicking

uiCanvas.addEventListener("click", (event) => {
  if (swallowNextClick) {
    swallowNextClick = false;
    return;
  }

  const uiPoint = toOverlay(event);

  // The HUD's own buttons first, exactly as in the other two clients — here
  // they restart the encounter rather than revive you mid-fight.
  if (currSnapshot?.dead && hits(resurrectRect(ctx), uiPoint)) {
    send({ type: "resurrect" });
    return;
  }

  if (hits(autoResRect(ctx), uiPoint)) {
    send({ type: "toggleAutoResurrect" });
    return;
  }

  // The two buttons that spend a turn, then the bar's squares, which only
  // choose a weapon.
  if (hitsButton(attackRect(barOrigin), uiPoint)) {
    send({ type: "attack" });
    return;
  }

  // Wait button removed — no turns to pass.

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

uiCanvas.addEventListener("dblclick", (event) => {
  if (swallowNextClick) return;
  const point = pickRoomPoint(event);
  if (point) send({ type: "dblclick", x: point.x, y: point.y });
});

let appliedCursor = DEFAULT_CURSOR;

function updateCursorStyle(snap: TacticsSnapshot) {
  let wanted = DEFAULT_CURSOR;
  if (uiCursor) {
    if (snap.inspect && hitsRect(LOOT_CLOSE_RECT, uiCursor)) wanted = "pointer";
    else if (snap.dead && hits(resurrectRect(ctx), uiCursor)) wanted = "pointer";
    else if (hits(autoResRect(ctx), uiCursor)) wanted = "pointer";
    else if (squareAtPoint(barOrigin, uiCursor) !== null) wanted = "pointer";
    else if (hitsButton(attackRect(barOrigin), uiCursor)) wanted = "pointer";
    else if (hitsButton(waitRect(barOrigin), uiCursor)) wanted = "pointer";
  }

  if (wanted !== appliedCursor) {
    uiCanvas.style.cursor = wanted;
    appliedCursor = wanted;
  }
}

// ------------------------------------------------------------- board paint

/**
 * Where the cursor is on the floor — no grid snapping. Shows a ring at the
 * exact cursor position; red when an enemy is standing there.
 */
function hoverDestination(snap: TacticsSnapshot): { at: Point; allowed: boolean } | null {
  if (!groundCursor || isOver(snap.phase)) return null;
  const cell = cellAtPoint(groundCursor);
  if (!cell) return null;

  const at = { ...groundCursor };
  const occupied = snap.enemies.some((e) => distance(at, { x: e.x, y: e.y }) < snap.meleeRange * 0.5);
  return { at, allowed: !occupied };
}

// ----------------------------------------------------------------- game loop

const projectionPoint = new THREE.Vector3();

/** Room point at a height in 3D units -> overlay coordinates, for labels. */
function toScreen(px: number, py: number, height: number): Point {
  projectionPoint.set(toX(px), height, toZ(py));
  return stage.project(projectionPoint);
}

let lastFrameTime = performance.now();

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

  stage.updateDoors(currSnapshot.doorsClosed);

  if (!actors) actors = new Actors(stage.scene, stage.pickables, snap.player.color);

  actors.player.setWeapon(ACTIONS[snap.activeSlot]?.kind ?? "melee");

  // Both sides square up to what they are fighting. On a board where reach is a
  // rule, "who is looking at whom" is worth reading at a glance.
  const marked = snap.attacking && snap.targetId
    ? snap.enemies.find((e) => e.id === snap.targetId)
    : undefined;

  actors.player.update(snap, marked ? { x: marked.x, y: marked.y } : null, dt, now, elapsed);
  // Behind your own eyes you are the inside of a cloak. The rig still runs —
  // it is what the camera is riding — it just isn't drawn.
  actors.player.root.visible = !stage.firstPerson;
  // A woken hound looks at you wherever it is standing — that is the only tell
  // that separates one which has noticed you from one which hasn't.
  actors.syncEnemies(snap, dt, now, elapsed, (enemy) =>
    enemy.aggro ? { x: snap.player.x, y: snap.player.y } : null,
  );
  actors.syncCorpses(snap, dt);
  actors.syncProjectiles(snap, elapsed);
  actors.syncTombstones(snap);

  // Nothing is drawn on the floor around the player: the footfall ring under the
  // cursor is what says whether a click would land, and where.
  const destination = hoverDestination(snap);
  stage.setDestination(destination?.at.x ?? null, destination?.at.y ?? null, destination?.allowed ?? false);

  // Red under something you are fighting, yellow under a body you have merely
  // selected — the real-time game's ring colours, on a bigger ring.
  const targeted = snap.targetId
    ? snap.enemies.find((e) => e.id === snap.targetId) ?? snap.corpses.find((c) => c.id === snap.targetId)
    : undefined;
  stage.setTargetRing(targeted?.x ?? null, targeted?.y ?? null, marked ? 0xe23b3b : 0xffd633);

  // The board frames itself while you are standing on it; walk out through the
  // doorway and the camera comes with you, or the corridor would be somewhere
  // you can go but not somewhere you can see.
  stage.follow(snap.player.x, snap.player.y, snap.player.facing);
  stage.update(dt);
  stage.animateScenery(elapsed);
  stage.render();

  // Tank controls: apply turning and keep movement direction in sync.
  updateTankControls(dt);

  updateCursorStyle(snap);
  // No hurt flash. The real-time game needs one because from behind the
  // shoulder a bite is easy to miss; here the whole board is on screen, the log
  // names what hit you, and a red vignette over a turn-based fight just gets in
  // the way of reading it.
  drawOverlay(ctx, { snap, uiCursor, groundCursor, toScreen, hurt: 0 });
  drawTacticsChrome(ctx, snap, barOrigin, uiCursor);

  // ---- sword swing overlay ----
  const swingElapsed = now - swingStartTime;
  if (swingElapsed < SWING_DURATION) {
    const t = swingElapsed / SWING_DURATION;

    // Pivot near the bottom-right corner of the screen.
    const pivotX = WORLD_WIDTH * 0.85;
    const pivotY = WORLD_HEIGHT * 1.1;

    // Sweep from -30 degrees (top-right) to 60 degrees (toward center).
    const angle = (-30 + 90 * t) * (Math.PI / 180);

    // Blade length in room units.
    const bladeLen = WORLD_HEIGHT * 0.7;
    const bladeWidth = 12;

    // Fade out over the last 40% of the swing.
    const alpha = t < 0.6 ? 0.85 : 0.85 * (1 - (t - 0.6) / 0.4);

    ctx.save();
    ctx.translate(pivotX, pivotY);
    ctx.rotate(-angle);

    // Blade: a pointed polygon — wide at the hilt, tapering to a point.
    ctx.beginPath();
    ctx.moveTo(-bladeWidth * 0.5, 0);             // hilt left
    ctx.lineTo(-bladeWidth * 0.4, -bladeLen * 0.9); // taper left
    ctx.lineTo(0, -bladeLen);                      // tip
    ctx.lineTo(bladeWidth * 0.4, -bladeLen * 0.9);  // taper right
    ctx.lineTo(bladeWidth * 0.5, 0);               // hilt right
    ctx.closePath();

    ctx.fillStyle = `rgba(220, 225, 230, ${alpha})`;
    ctx.fill();

    // Thin bright edge highlight down the centre.
    ctx.beginPath();
    ctx.moveTo(0, -bladeLen * 0.05);
    ctx.lineTo(0, -bladeLen);
    ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.6})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.restore();
  }
}

uiCanvas.style.cursor = DEFAULT_CURSOR;
requestAnimationFrame(frame);
