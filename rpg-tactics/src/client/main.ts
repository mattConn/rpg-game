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
  isOver,
  sameCell,
  type Cell,
  type TacticsInput,
  type TacticsSnapshot,
} from "../shared/tactics.js";
import { attackRect, drawTacticsChrome, hitsButton, waitRect } from "./chrome.js";
import { createStage, type TileHighlight } from "./stage.js";

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

const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl = `${wsProtocol}//${location.host}`;

function connectWebSocket() {
  const ws = new WebSocket(wsUrl);

  ws.addEventListener("message", (event) => {
    try {
      const snap = JSON.parse(event.data as string) as TacticsSnapshot;
      if (currSnapshot && actors) applyCues(actors, currSnapshot, snap, performance.now(), struckBy);
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
 * Which hellhound just bit, straight from the simulation. `strike.seq` ticks
 * once per blow, so every hound that attacks in a round gets its own lunge —
 * where guessing at the nearest hunter would give two flanking hounds' bites to
 * whichever happened to be a pixel closer.
 */
function struckBy(previous: TacticsSnapshot, snap: TacticsSnapshot): string | null {
  if (!snap.strike) return null;
  return snap.strike.seq === previous.strike?.seq ? null : snap.strike.enemyId;
}

let socket = connectWebSocket();

function send(msg: TacticsInput) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

// ---------------------------------------------------------------- keyboard

window.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();

  if (event.code === "Tab") {
    // Tab cycles the mark, so swallow auto-repeat — held down it would strobe
    // between the two hounds. preventDefault also keeps focus on the canvas.
    event.preventDefault();
    if (!event.repeat) send({ type: "keydown", key, code: event.code });
    return;
  }

  if (key === "v") {
    stage.resetView();
    event.preventDefault();
    return;
  }

  // 1-5 choose a weapon (and only that), space swings it, "." passes the turn,
  // r restarts, escape drops the mark. Nothing here moves you: a step is a
  // click on a square.
  if (
    (key.length === 1 && key >= "1" && key <= "5") ||
    key === " " ||
    key === "." ||
    key === "r" ||
    key === "escape"
  ) {
    send({ type: "keydown", key, code: event.code });
    event.preventDefault();
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
let hoverCell: Cell | null = null;

uiCanvas.addEventListener("mousemove", (event) => {
  if (dragButton !== null) {
    const dx = event.clientX - lastDragX;
    const dy = event.clientY - lastDragY;
    lastDragX = event.clientX;
    lastDragY = event.clientY;
    dragMoved += Math.abs(dx) + Math.abs(dy);
    if (dragMoved > DRAG_THRESHOLD) {
      if (dragPanning) stage.pan(dx, dy);
      else stage.orbit(dx, dy);
    }
  }

  uiCursor = toOverlay(event);
  const ndc = toNdc(event);
  groundCursor = stage.groundAt(ndc.x, ndc.y);
  hoverCell = groundCursor ? cellAtPoint(groundCursor) : null;
});

uiCanvas.addEventListener("mouseleave", () => {
  uiCursor = null;
  groundCursor = null;
  hoverCell = null;
});

uiCanvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  stage.zoom(Math.sign(event.deltaY) * 1.8);
}, { passive: false });

// Right-drag pans, so the browser menu must never appear on the canvas.
uiCanvas.addEventListener("contextmenu", (event) => {
  event.preventDefault();
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

  if (hitsButton(waitRect(barOrigin), uiPoint)) {
    send({ type: "wait" });
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

const MOVE_COLOR = 0x7fd0ff;
const ESCAPE_COLOR = 0xffb45a;

/**
 * Which squares light up. Precedence runs escape → legal step → hover, so the
 * square under the cursor always reports the strongest thing true of it, and the
 * way out stays marked even on a turn you can't reach it.
 */
function tileHighlights(snap: TacticsSnapshot, elapsed: number): TileHighlight[] {
  const byCell = new Map<string, TileHighlight>();
  const put = (cell: Cell, color: number, opacity: number) =>
    byCell.set(`${cell.col},${cell.row}`, { cell, color, opacity });

  put(snap.escapeCell, ESCAPE_COLOR, 0.12 + Math.sin(elapsed * 2.2) * 0.04);

  for (const cell of snap.legalMoves) {
    const escape = sameCell(cell, snap.escapeCell);
    put(cell, escape ? ESCAPE_COLOR : MOVE_COLOR, escape ? 0.34 : 0.17);
  }

  if (hoverCell) {
    const existing = byCell.get(`${hoverCell.col},${hoverCell.row}`);
    const legal = snap.legalMoves.some((c) => sameCell(c, hoverCell!));
    if (legal && existing) put(hoverCell, existing.color, 0.4);
    else if (!existing) put(hoverCell, 0xffffff, 0.1);
  }

  return [...byCell.values()];
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

  if (!actors) actors = new Actors(stage.scene, stage.pickables, snap.player.color);

  actors.player.setWeapon(ACTIONS[snap.activeSlot]?.kind ?? "melee");

  // Both sides square up to what they are fighting. On a board where reach is a
  // rule, "who is looking at whom" is worth reading at a glance.
  const marked = snap.attacking && snap.targetId
    ? snap.enemies.find((e) => e.id === snap.targetId)
    : undefined;

  actors.player.update(snap, marked ? { x: marked.x, y: marked.y } : null, dt, now, elapsed);
  // A woken hound looks at you wherever it is standing — that is the only tell
  // that separates one which has noticed you from one which hasn't.
  actors.syncEnemies(snap, dt, now, elapsed, (enemy) =>
    enemy.aggro ? { x: snap.player.x, y: snap.player.y } : null,
  );
  actors.syncCorpses(snap, dt);
  actors.syncProjectiles(snap, elapsed);
  actors.syncTombstones(snap);

  stage.setTileHighlights(isOver(snap.phase) ? [] : tileHighlights(snap, elapsed));

  // Red under something you are fighting, yellow under a body you have merely
  // selected — the real-time game's ring colours, on a bigger ring.
  const targeted = snap.targetId
    ? snap.enemies.find((e) => e.id === snap.targetId) ?? snap.corpses.find((c) => c.id === snap.targetId)
    : undefined;
  stage.setTargetRing(targeted?.x ?? null, targeted?.y ?? null, marked ? 0xe23b3b : 0xffd633);

  stage.update(dt);
  stage.animateScenery(elapsed);
  stage.render();

  updateCursorStyle(snap);
  // No hurt flash. The real-time game needs one because from behind the
  // shoulder a bite is easy to miss; here the whole board is on screen, the log
  // names what hit you, and a red vignette over a turn-based fight just gets in
  // the way of reading it.
  drawOverlay(ctx, { snap, uiCursor, groundCursor, toScreen, hurt: 0 });
  drawTacticsChrome(ctx, snap, barOrigin, uiCursor);
}

uiCanvas.style.cursor = DEFAULT_CURSOR;
requestAnimationFrame(frame);
