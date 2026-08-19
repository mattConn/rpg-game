/**
 * Render-only WebSocket client for the real-time tactical game. It sends input and
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

import { WORLD_HEIGHT, WORLD_WIDTH } from "../../../src/shared/constants.js";
import { LOOT_CLOSE_RECT, hitsRect, lootMenuProxyPoint } from "../../../src/shared/loot.js";
import type { Point } from "../../../src/shared/movement.js";
import { actionBarHandleRect, actionBarSize, squareAtPoint } from "../../../src/client/actionbar.js";
import { DEFAULT_CURSOR } from "../../../src/client/cursors.js";
import { SERVER_TICK_MS, renderFraction, smoothInterval } from "../../../src/client/interpolation.js";
import { fillViewport } from "../../../src/client/viewport.js";
import { Actors, applyCues, entityIdOf } from "../../../rpg-3d/src/client/entities.js";
import { barOrigin, centreShift, drawOverlay, hits, resurrectRect } from "../../../rpg-3d/src/client/overlay.js";
import { interpolateSnapshot } from "../../../rpg-3d/src/client/playback.js";
import { toX, toZ } from "../../../rpg-3d/src/client/world.js";
import {
  isOver,
  TACTICS_ACTIONS,
  type TacticsInput,
  type TacticsSnapshot,
} from "../shared/tactics.js";
import { BAR_LAYOUT, drawTacticsChrome } from "./chrome.js";
import { createStage } from "./stage.js";
import { drawHeldWeapon } from "./viewmodel.js";

// ------------------------------------------------------------------ canvases

const sceneCanvas = document.getElementById("scene") as HTMLCanvasElement;
const uiCanvas = document.getElementById("ui") as HTMLCanvasElement;
const ctx = uiCanvas.getContext("2d")!;

const stage = createStage(sceneCanvas);

/**
 * How many room units wide the canvas currently is. The room's *height* is
 * always `WORLD_HEIGHT`; its width follows the browser, so this is the number
 * anything centred or right-anchored has to be placed against — and the number
 * a screen coordinate is converted back through.
 */
let viewWidth = WORLD_WIDTH;
let barPositioned = false;

function resize() {
  const fit = fillViewport(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
  viewWidth = fit.roomWidth;

  uiCanvas.style.width = `${fit.displayWidth}px`;
  uiCanvas.style.height = `${fit.displayHeight}px`;
  uiCanvas.width = fit.pixelWidth;
  uiCanvas.height = fit.pixelHeight;
  // Square room units: both axes get the same scale, since roomWidth was
  // derived from the height and the aspect in the first place.
  ctx.setTransform(fit.pixelWidth / viewWidth, 0, 0, fit.pixelHeight / WORLD_HEIGHT, 0, 0);

  const barSize = actionBarSize(BAR_LAYOUT);
  if (!barPositioned) {
    barOrigin.x = Math.max(9, Math.min(viewWidth - barSize.width, (viewWidth - barSize.width) / 2 + 140));
    barOrigin.y = (WORLD_HEIGHT - barSize.height) / 2 - 105;
    barPositioned = true;
  } else {
    barOrigin.x = Math.max(9, Math.min(viewWidth - barSize.width, barOrigin.x));
    barOrigin.y = Math.max(9, Math.min(WORLD_HEIGHT - barSize.height, barOrigin.y));
  }

  stage.resize(fit.displayWidth, fit.displayHeight, window.devicePixelRatio || 1, viewWidth);
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

// ------------------------------------------------------- the weapon in hand
// The sword's swing is stamped from a *fresh cooldown*, the protocol's way of
// saying "an attack just happened" — the same derivation `applyCues` uses,
// rather than a second event on the wire. The dagger needs no stamp: it has no
// animation, and whether it is in your hand is read from the cooldown itself.
let swingStartTime = -Infinity;
/** A deliberately faint edge glow, stamped whenever a hound lands a bite. */
let hurt = 0;

const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl = `${wsProtocol}//${location.host}`;

function connectWebSocket() {
  const ws = new WebSocket(wsUrl);

  ws.addEventListener("message", (event) => {
    try {
      const snap = JSON.parse(event.data as string) as TacticsSnapshot;
      const now = performance.now();
      // Keep local interaction facing aligned with the authoritative model
      // whenever direct movement is not actively choosing a new direction.
      if (heldKeys.size === 0) {
        playerYaw = Math.atan2(-snap.playerHeading.x, -snap.playerHeading.y);
      }
      if (currSnapshot && actors && applyCues(actors, currSnapshot, snap, now, struckBy)) {
        hurt = 0.32;
      }

      // A fresh cooldown means an attack just landed. Which animation plays is
      // read off `cooldown.slot` — the slot that actually fired — and not off
      // `activeSlot`, or swapping weapons mid-cooldown would replay the swing
      // as a throw.
      const before = currSnapshot?.cooldown;
      const after = snap.cooldown;
      if (
        after &&
        (!before || before.slot !== after.slot || after.remainingMs > before.remainingMs + 1)
      ) {
        if (TACTICS_ACTIONS[after.slot]?.kind === "melee") swingStartTime = now;
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

/** Direct movement oriented to the camera's current horizontal heading. */

const heldKeys = new Set<string>();
let playerYaw = -Math.PI / 2;

function sendMoveDir(): void {
  const across = Number(heldKeys.has("d")) - Number(heldKeys.has("a"));
  const forward = Number(heldKeys.has("w")) - Number(heldKeys.has("s"));
  const cameraYaw = stage.yaw;
  const dx = Math.cos(cameraYaw) * across - Math.sin(cameraYaw) * forward;
  const dy = -Math.sin(cameraYaw) * across - Math.cos(cameraYaw) * forward;

  if (dx !== 0 || dy !== 0) playerYaw = Math.atan2(-dx, -dy);
  send({ type: "move", dx, dy, turn: true });
}

function facingDirection(): Point {
  return { x: -Math.sin(playerYaw), y: -Math.cos(playerYaw) };
}

/**
 * Half-turn on the spot. Purely a camera move — W and S read `stage.yaw`, so
 * turning the view is turning the player — but a held W has to be re-sent, or
 * the server keeps walking them the old way until the key is let go.
 */
function flipAbout() {
  stage.flip();
  if (heldKeys.size > 0) sendMoveDir();
}

/**
 * Wait is the one control that is *held* rather than pressed, so it needs a
 * release for every way a hold can end — key up, mouse up anywhere on the page,
 * and the window losing focus. Miss the last one and tabbing away leaves the
 * world running with hellhounds eating you off-screen, which is precisely what
 * the pause exists to prevent.
 */
let waitHeld = false;
function holdWait(held: boolean) {
  if (held === waitHeld) return; // idempotent: key auto-repeat must not spam
  waitHeld = held;
  send({ type: "wait", held });
}
window.addEventListener("blur", () => holdWait(false));
document.addEventListener("visibilitychange", () => { if (document.hidden) holdWait(false); });

window.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();

  if (key === ".") {
    holdWait(true);
    event.preventDefault();
    return;
  }

  // Firefox opens quick-find on "/", so this has to be swallowed either way.
  if (key === "/") {
    if (!event.repeat) flipAbout();
    event.preventDefault();
    return;
  }

  if (event.code === "Tab") {
    event.preventDefault();
    if (!event.repeat) send({ type: "keydown", key, code: event.code });
    return;
  }

  if (key === "v") {
    stage.resetView();
    if (heldKeys.size > 0) sendMoveDir();
    event.preventDefault();
    return;
  }

  // Direct movement keys.
  if (key === "w" || key === "a" || key === "s" || key === "d" ||
      key === "arrowleft" || key === "arrowright" ||
      key === "arrowup" || key === "arrowdown") {
    const mapped = key === "arrowup" ? "w"
      : key === "arrowdown" ? "s"
      : key === "arrowleft" ? "a"
      : key === "arrowright" ? "d"
      : key;
    if (!heldKeys.has(mapped)) {
      heldKeys.add(mapped);
      sendMoveDir();
    }
    event.preventDefault();
    return;
  }

  // Space uses a faced door when there is one, otherwise it swings the weapon.
  if (key === " ") {
    if (!event.repeat) {
      const facing = facingDirection();
      send({ type: "interact", dx: facing.x, dy: facing.y });
    }
    event.preventDefault();
    return;
  }

  // 1-5 choose a weapon, r restarts, escape drops the mark.
  if (
    (key.length === 1 && key >= "1" && key <= "5") ||
    key === "r" ||
    key === "escape"
  ) {
    send({ type: "keydown", key, code: event.code });
    event.preventDefault();
  }
});

window.addEventListener("keyup", (event) => {
  const key = event.key.toLowerCase();
  if (key === ".") { holdWait(false); return; }
  const mapped = key === "arrowup" ? "w"
    : key === "arrowdown" ? "s"
    : key === "arrowleft" ? "a"
    : key === "arrowright" ? "d"
    : key;
  if (heldKeys.has(mapped)) {
    heldKeys.delete(mapped);
    sendMoveDir();
  }
});

// --------------------------------------------------------------- pointer

/** Mouse position in the overlay's room units — where the UI is hit-tested. */
function toOverlay(event: MouseEvent): Point {
  const bounds = uiCanvas.getBoundingClientRect();
  return {
    x: (event.clientX - bounds.left) * (viewWidth / bounds.width),
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
let rightDragWasMove = false;
let barDragging = false;

uiCanvas.addEventListener("mousedown", (event) => {
  if (event.button === 0 && hits(actionBarHandleRect(barOrigin), toOverlay(event))) {
    barDragging = true;
    dragMoved = 0;
    lastDragX = event.clientX;
    lastDragY = event.clientY;
    event.preventDefault();
    return;
  }
  dragButton = event.button;
  dragPanning = event.button === 2 || event.button === 1 || event.shiftKey;
  dragMoved = 0;
  lastDragX = event.clientX;
  lastDragY = event.clientY;
  if (event.button === 2) rightDragWasMove = false;
  if (dragPanning) event.preventDefault();
});

window.addEventListener("mouseup", (event) => {
  // Released anywhere, not just over the button: dragging off it and letting go
  // there is still letting go.
  holdWait(false);
  if (barDragging) {
    barDragging = false;
    swallowNextClick = true;
    return;
  }
  // Only the primary button produces the ordinary click event we need to
  // swallow. Leaving this armed after a right-drag would eat the next real
  // world click instead.
  if (dragButton === 0 && dragMoved > DRAG_THRESHOLD) swallowNextClick = true;
  if (event.button === 2) rightDragWasMove = dragMoved > DRAG_THRESHOLD;
  dragButton = null;
});

/** Cursor in overlay units (UI hit-testing) and on the floor (world reveals). */
let uiCursor: Point | null = null;
let groundCursor: Point | null = null;
let hoveredEntityId: string | null = null;
let hoveredDoor: import("../shared/tactics.js").DoorId | null = null;
const PLAYER_CURSOR_ID = "__player";


uiCanvas.addEventListener("mousemove", (event) => {
  if (barDragging) {
    const bounds = uiCanvas.getBoundingClientRect();
    const dx = (event.clientX - lastDragX) * (viewWidth / bounds.width);
    const dy = (event.clientY - lastDragY) * (WORLD_HEIGHT / bounds.height);
    lastDragX = event.clientX;
    lastDragY = event.clientY;
    dragMoved += Math.abs(dx) + Math.abs(dy);
    const size = actionBarSize(BAR_LAYOUT);
    barOrigin.x = Math.max(9, Math.min(viewWidth - size.width, barOrigin.x + dx));
    barOrigin.y = Math.max(9, Math.min(WORLD_HEIGHT - size.height, barOrigin.y + dy));
  } else if (dragButton !== null) {
    const dx = event.clientX - lastDragX;
    const dy = event.clientY - lastDragY;
    lastDragX = event.clientX;
    lastDragY = event.clientY;
    dragMoved += Math.abs(dx) + Math.abs(dy);
    if (dragMoved > DRAG_THRESHOLD) {
      if (dragPanning && !stage.firstPerson) stage.pan(dx, dy);
      else {
        const bounds = uiCanvas.getBoundingClientRect();
        stage.look((dx / bounds.width) * 2, -(dy / bounds.height) * 2);
        if (heldKeys.size > 0) sendMoveDir();
      }
    }
  }

  uiCursor = toOverlay(event);
  const ndc = toNdc(event);
  groundCursor = stage.groundAt(ndc.x, ndc.y);
  hoveredEntityId = entityIdOf(stage.pickAt(ndc.x, ndc.y));
  hoveredDoor = stage.doorAt(ndc.x, ndc.y);
});

uiCanvas.addEventListener("mouseleave", () => {
  uiCursor = null;
  groundCursor = null;
  hoveredEntityId = null;
  hoveredDoor = null;
});

uiCanvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  stage.zoom(Math.sign(event.deltaY) * 1.8);
}, { passive: false });

// Right-drag pans, so the browser menu must never appear on the canvas.
uiCanvas.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  if (rightDragWasMove) {
    rightDragWasMove = false;
  }
});

// ----------------------------------------------------------------- clicking

uiCanvas.addEventListener("click", (event) => {
  if (swallowNextClick) {
    swallowNextClick = false;
    return;
  }

  const uiPoint = toOverlay(event);
  const ndc = toNdc(event);

  if (hits(actionBarHandleRect(barOrigin), uiPoint)) return;

  // The HUD's own buttons first, exactly as in the other two clients — here
  // they restart the encounter rather than revive you mid-fight.
  if (currSnapshot?.dead && hits(resurrectRect(ctx), uiPoint)) {
    send({ type: "resurrect" });
    return;
  }

  const slot = squareAtPoint(barOrigin, uiPoint, BAR_LAYOUT);
  if (slot !== null) {
    if (TACTICS_ACTIONS[slot]) send({ type: "useSlot", index: slot });
    return;
  }

  const clickedDoor = stage.doorAt(ndc.x, ndc.y);
  if (clickedDoor) {
    send({ type: "targetDoor", door: clickedDoor });
    return;
  }

  if (currSnapshot?.inspect) {
    // The menu is drawn shifted to sit centred on a wide canvas, so a click on
    // it has to be shifted back before the server, which knows only the
    // 1200-unit room its rectangle lives in, is asked about it.
    const shift = centreShift(viewWidth);
    const point = lootMenuProxyPoint({ x: uiPoint.x - shift, y: uiPoint.y });
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
  if (barDragging) wanted = "grabbing";
  else if (uiCursor) {
    if (hits(actionBarHandleRect(barOrigin), uiCursor)) wanted = "grab";
    else if (snap.inspect && hitsRect(LOOT_CLOSE_RECT, { x: uiCursor.x - centreShift(viewWidth), y: uiCursor.y })) wanted = "pointer";
    else if (snap.dead && hits(resurrectRect(ctx), uiCursor)) wanted = "pointer";
    else if (squareAtPoint(barOrigin, uiCursor, BAR_LAYOUT) !== null) wanted = "pointer";
  }

  if (wanted !== appliedCursor) {
    uiCanvas.style.cursor = wanted;
    appliedCursor = wanted;
  }
}

// ------------------------------------------------------------- board paint

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
  hurt = Math.max(0, hurt - dt * 0.8);

  if (!currSnapshot) return;

  const t = renderFraction(now, currSnapshotTime, snapshotInterval, prevSnapshot !== null);
  const snap = prevSnapshot
    ? interpolateSnapshot(prevSnapshot, currSnapshot, t, now - currSnapshotTime)
    : currSnapshot;

  if (!actors) {
    actors = new Actors(stage.scene, stage.pickables, snap.player.color, true);
    actors.player.root.userData["entityId"] = PLAYER_CURSOR_ID;
    stage.pickables.push(actors.player.root);
  }

  const actingKind = snap.cooldown && snap.cooldown.remainingMs > 0
    ? TACTICS_ACTIONS[snap.cooldown.slot]?.kind
    : TACTICS_ACTIONS[snap.activeSlot]?.kind;
  actors.player.setWeapon(actingKind === "ranged" ? "ranged" : "melee");

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

  const hoveredEnemy = hoveredEntityId
    ? snap.enemies.find((enemy) => enemy.id === hoveredEntityId)
    : undefined;
  const hoveringPlayer = hoveredEntityId === PLAYER_CURSOR_ID;
  stage.setCursorRing(
    hoveredDoor ? null : hoveredEnemy?.x ?? (hoveringPlayer ? snap.player.x : groundCursor?.x) ?? null,
    hoveredDoor ? null : hoveredEnemy?.y ?? (hoveringPlayer ? snap.player.y : groundCursor?.y) ?? null,
    hoveredEnemy ? "enemy" : hoveringPlayer ? "interactable" : "floor",
  );
  stage.setDoorHoverRing(hoveredDoor);

  // Red under something you are fighting, yellow under a body you have merely
  // selected — the real-time game's ring colours, on a bigger ring.
  const targeted = snap.targetId
    ? snap.enemies.find((e) => e.id === snap.targetId) ?? snap.corpses.find((c) => c.id === snap.targetId)
    : undefined;
  stage.setDoors(snap.doors);
  if (snap.targetDoor) stage.setDoorTargetRing(snap.targetDoor);
  else stage.setTargetRing(targeted?.x ?? null, targeted?.y ?? null, marked ? 0xe23b3b : 0xffd633);

  // The board frames itself while you are standing on it; walk out through the
  // doorway and the camera comes with you, or the corridor would be somewhere
  // you can go but not somewhere you can see.
  stage.follow(snap.player.x, snap.player.y, snap.player.facing);
  stage.update(dt);
  stage.animateScenery(elapsed);
  stage.render();

  updateCursorStyle(snap);
  drawOverlay(ctx, {
    snap, uiCursor, groundCursor, toScreen, hurt,
    showAutoRes: false,
    showRoomLabel: false,
    showGameClock: false,
    actions: TACTICS_ACTIONS,
    viableActions: snap.viableActions,
    barLayout: BAR_LAYOUT,
    viewWidth,
  });
  drawTacticsChrome(ctx, snap, viewWidth);

  // ---- the weapon in hand ----
  // Drawn last so nothing covers it: it is the closest thing to the camera
  // there is. Hidden once the encounter is over, when the outcome card owns
  // the screen.
  const heldAction = TACTICS_ACTIONS[snap.activeSlot];
  if (stage.firstPerson && (heldAction?.kind === "melee" || heldAction?.kind === "ranged") && !isOver(snap.phase)) {
    // `spent` comes off the live cooldown rather than a timer of the client's
    // own: `interpolateSnapshot` counts `remainingMs` down in real time, so the
    // dagger reappears exactly when the server would let you throw the next one.
    const cd = snap.cooldown;
    drawHeldWeapon(ctx, {
      kind: heldAction.kind,
      sinceSwing: Number.isFinite(swingStartTime) ? now - swingStartTime : null,
      spent: !!cd && cd.remainingMs > 0 && TACTICS_ACTIONS[cd.slot]?.kind === "ranged",
    });
  }
}

uiCanvas.style.cursor = DEFAULT_CURSOR;
requestAnimationFrame(frame);
