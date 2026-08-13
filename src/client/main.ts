/**
 * Render-only WebSocket client. Sends user inputs to the server and draws the
 * GameSnapshot received each tick. No simulation logic runs here.
 */

import {
  CELL_SIZE,
  DIRECTIONS,
  NAME_REVEAL_DISTANCE,
  PLAYER_RADIUS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  roomName,
  sameRoom,
  type Direction,
} from "../shared/constants.js";
import {
  clamp,
  type Point,
} from "../shared/movement.js";
import type { GameSnapshot, InputMessage } from "../shared/protocol.js";
import { ACTIONS } from "../shared/actions.js";
import { DAMAGE_NUMBER_LIFETIME } from "../shared/combat.js";
import {
  ACTION_BAR_DEFAULT_ORIGIN,
  drawActionBar,
  squareAtPoint,
} from "./actionbar.js";
import {
  daggerAngle,
  drawDagger,
} from "./combat.js";
import { DEFAULT_CURSOR } from "./cursors.js";
import { HUD_DEFAULT_ORIGIN, HUD_HEIGHT, HUD_WIDTH, NAME_GAP, NAME_HEIGHT, PORTRAIT_SIZE, drawEnemyHud, drawHud } from "./hud.js";
import { drawCorpse, drawEnemy, drawFacingGlyph, drawHealthBar } from "./enemies.js";
import { drawLootMenu } from "./lootmenu.js";
import { LOOT_CLOSE_RECT } from "../shared/loot.js";
import { drawTiles } from "./tilemap.js";
import { worldToCell } from "../shared/tilemap.js";
import { fitToViewport } from "./viewport.js";
import { SERVER_TICK_MS, renderFraction, smoothInterval } from "./interpolation.js";

// ------------------------------------------------------------------ fonts

const GLYPH_FONT = "20px monospace";
const NAME_FONT = "12px monospace";
const ROOM_LABEL_FONT = "13px monospace";
const CLOCK_FONT = "13px monospace";

/** One in-game minute = this many ms of `gameElapsedMs`. Display-only. */
const MS_PER_GAME_MINUTE = 500;

// ------------------------------------------------------------------ canvas

const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

function resizeCanvas() {
  const fit = fitToViewport(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);

  canvas.style.width = `${fit.displayWidth}px`;
  canvas.style.height = `${fit.displayHeight}px`;
  canvas.width = fit.pixelWidth;
  canvas.height = fit.pixelHeight;

  ctx.setTransform(fit.pixelWidth / WORLD_WIDTH, 0, 0, fit.pixelHeight / WORLD_HEIGHT, 0, 0);
}

window.addEventListener("resize", resizeCanvas);
resizeCanvas();

// ---------------------------------------------------------------- websocket

let prevSnapshot: GameSnapshot | null = null;
let currSnapshot: GameSnapshot | null = null;
let prevSnapshotTime = 0;
let currSnapshotTime = 0;

/** Smoothed playback interval for the lerp — see `interpolation.ts`. */
let snapshotInterval = SERVER_TICK_MS;

const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl = `${wsProtocol}//${location.host}`;

function connectWebSocket() {
  const ws = new WebSocket(wsUrl);

  ws.addEventListener("message", (event) => {
    try {
      const snap = JSON.parse(event.data as string) as GameSnapshot;
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
    // Reconnect after a short delay.
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

// ---------------------------------------------------------------------- input

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
    send({ type: "keydown", key: event.key.toLowerCase(), code: event.code });
    event.preventDefault();
  }
});

window.addEventListener("keyup", (event) => {
  send({ type: "keyup", key: event.key.toLowerCase() });
});

// Clear held keys on blur — the server tracks held keys from keydown/keyup,
// but if the tab loses focus we send keyup for all WASD to avoid stuck movement.
window.addEventListener("blur", () => {
  for (const key of ["w", "a", "s", "d"]) {
    send({ type: "keyup", key });
  }
});

/** Convert a mouse event into room coordinates. */
function toWorld(event: MouseEvent) {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - bounds.left) * (WORLD_WIDTH / bounds.width),
    y: (event.clientY - bounds.top) * (WORLD_HEIGHT / bounds.height),
  };
}

// ----------------------------------------------------------- UI layout

const barOrigin: Point = { ...ACTION_BAR_DEFAULT_ORIGIN };

const hudOrigin: Point = { ...HUD_DEFAULT_ORIGIN };

const RESURRECT_FONT = "12px monospace";
const AUTO_RES_FONT = "11px monospace";
const AUTO_RES_LABEL = "Auto-Res";

interface Rect { x: number; y: number; width: number; height: number }

const hits = (r: Rect, p: Point) =>
  p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

/** Centred "Resurrect" button under the name plate — only drawn when dead. */
function resurrectRect(): Rect {
  ctx.font = RESURRECT_FONT;
  const width = ctx.measureText("Resurrect").width;
  return {
    x: hudOrigin.x + PORTRAIT_SIZE / 2 - width / 2,
    y: hudOrigin.y + PORTRAIT_SIZE + NAME_GAP + NAME_HEIGHT + 4,
    width,
    height: 12,
  };
}

/** The auto-resurrect toggle, left-aligned under the stats. Always present. */
function autoResRect(): Rect {
  ctx.font = AUTO_RES_FONT;
  return {
    x: hudOrigin.x,
    y: hudOrigin.y + PORTRAIT_SIZE + NAME_GAP + NAME_HEIGHT + 22,
    width: ctx.measureText(AUTO_RES_LABEL).width,
    height: 11,
  };
}

canvas.addEventListener("click", (event) => {

  const point = toWorld(event);

  // Resurrect button when dead — check before other click logic.
  if (currSnapshot?.dead && hits(resurrectRect(), point)) {
    send({ type: "resurrect" });
    return;
  }

  // Auto-resurrect toggle — usable alive or dead.
  if (hits(autoResRect(), point)) {
    send({ type: "toggleAutoResurrect" });
    return;
  }

  // Clicking an action-bar slot selects that attack — send as slot message.
  const slot = squareAtPoint(barOrigin, point);
  if (slot !== null) {
    if (ACTIONS[slot]) send({ type: "slot", index: slot });
    return;
  }

  // Everything else: send click coordinates to the server.
  send({ type: "click", x: point.x, y: point.y });
});

// The browser's own double-click. The leading clicks only ever select a target
// or start a walk, so letting them through before this arrives is harmless.
canvas.addEventListener("dblclick", (event) => {
  const point = toWorld(event);
  send({ type: "dblclick", x: point.x, y: point.y });
});

// Keep the browser menu off the canvas; right-click has no game meaning.
canvas.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

/** Cursor position in room coordinates, or null while the mouse is off-canvas. */
let cursor: { x: number; y: number } | null = null;

canvas.addEventListener("mousemove", (event) => {
  cursor = toWorld(event);
});

canvas.addEventListener("mouseleave", () => {
  cursor = null;
});

let appliedCursor = DEFAULT_CURSOR;

function updateCursorStyle() {
  const snap = currSnapshot;

  const overResurrect = !!snap?.dead && !!cursor && hits(resurrectRect(), cursor);

  let wanted = DEFAULT_CURSOR;
  if (snap?.inspect && cursor && hits(LOOT_CLOSE_RECT, cursor)) wanted = "pointer";
  else if (overResurrect) wanted = "pointer";
  else if (cursor && hits(autoResRect(), cursor)) wanted = "pointer";

  if (wanted !== appliedCursor) {
    canvas.style.cursor = wanted;
    appliedCursor = wanted;
  }
}

// -------------------------------------------------------------- interpolation

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Produce a render-ready snapshot by interpolating between prev and curr.
 * Positional fields are lerped; non-positional fields come from curr.
 */
function interpolateSnapshot(prev: GameSnapshot, curr: GameSnapshot, t: number, now: number): GameSnapshot {
  const player = {
    ...curr.player,
    x: lerp(prev.player.x, curr.player.x, t),
    y: lerp(prev.player.y, curr.player.y, t),
  };

  // Enemies: match by id, lerp positions. New/removed enemies use curr position.
  const prevEnemyMap = new Map(prev.enemies.map((e) => [e.id, e]));
  const enemies = curr.enemies.map((ce) => {
    const pe = prevEnemyMap.get(ce.id);
    if (!pe) return ce;
    return { ...ce, x: lerp(pe.x, ce.x, t), y: lerp(pe.y, ce.y, t) };
  });

  // Projectiles: extrapolate from curr using vx/vy (they travel in straight
  // lines). Clamped at 0 for the same reason as `t` — see frame().
  const sinceSnapshot = Math.max(0, now - currSnapshotTime);
  const elapsed = sinceSnapshot / 1000; // seconds since curr arrived
  const projectiles = curr.projectiles.map((p) => ({
    ...p,
    x: p.x + p.vx * elapsed,
    y: p.y + p.vy * elapsed,
  }));

  // Paired by id, not by position: numbers expire out of the middle of the
  // array while newer ones live on, and matching by index would lerp a survivor
  // against a different number entirely.
  const prevDamage = new Map(prev.damageNumbers.map((d) => [d.id, d]));
  const damageNumbers = curr.damageNumbers.map((cd) => {
    const pd = prevDamage.get(cd.id);
    if (!pd) return cd;
    return { ...cd, y: lerp(pd.y, cd.y, t), age: lerp(pd.age, cd.age, t) };
  });

  // Move target: lerp if both snapshots have one.
  const moveTarget =
    prev.moveTarget && curr.moveTarget
      ? { x: lerp(prev.moveTarget.x, curr.moveTarget.x, t), y: lerp(prev.moveTarget.y, curr.moveTarget.y, t) }
      : curr.moveTarget;

  const gameElapsedMs = lerp(prev.gameElapsedMs, curr.gameElapsedMs, t);

  // Cooldown counts down in real time, so run it forward from when the snapshot
  // arrived — at 600ms a snapshot-stepped blind would visibly stair-step.
  const cooldown = curr.cooldown
    ? { ...curr.cooldown, remainingMs: Math.max(0, curr.cooldown.remainingMs - sinceSnapshot) }
    : null;

  return {
    ...curr,
    player,
    enemies,
    projectiles,
    damageNumbers,
    moveTarget,
    gameElapsedMs,
    cooldown,
  };
}

// --------------------------------------------------------------------- render

function drawRoom(snap: GameSnapshot) {
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

  const room = snap.player.room;
  const inset = 2;
  const edges: Record<Direction, [number, number, number, number]> = {
    north: [0, inset, WORLD_WIDTH, inset],
    south: [0, WORLD_HEIGHT - inset, WORLD_WIDTH, WORLD_HEIGHT - inset],
    west: [inset, 0, inset, WORLD_HEIGHT],
    east: [WORLD_WIDTH - inset, 0, WORLD_WIDTH - inset, WORLD_HEIGHT],
  };

  for (const direction of DIRECTIONS) {
    const [x1, y1, x2, y2] = edges[direction];

    ctx.strokeStyle = "#3a3a3a";
    ctx.lineWidth = 4;

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  ctx.font = ROOM_LABEL_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillStyle = "#555555";
  ctx.fillText(roomName(room), 14, WORLD_HEIGHT - 12);
}

function drawPlayer(x: number, y: number, color: string, facing: 1 | -1) {
  ctx.font = GLYPH_FONT;
  ctx.fillStyle = color;
  drawFacingGlyph(ctx, "@", x, y, facing);
}

function drawLabelIfHovered(x: number, y: number, label: string) {
  if (!cursor || !label) return;
  if (Math.hypot(cursor.x - x, cursor.y - y) > NAME_REVEAL_DISTANCE) return;

  ctx.font = NAME_FONT;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(label, x, y + PLAYER_RADIUS + 10);
}

/** Draw a filled time-of-day icon (sun/moon/sunset) centred at (cx, cy). */
function drawTimeIcon(c: CanvasRenderingContext2D, cx: number, cy: number, r: number, hourOfDay: number) {
  if (hourOfDay >= 6 && hourOfDay < 18) {
    // 6am–6pm: filled yellow sun.
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fillStyle = "#ffd633";
    c.fill();
  } else if (hourOfDay >= 18 && hourOfDay < 22) {
    // 6pm–10pm: orange half circle rotated so flat edge is horizontal (sunset).
    c.save();
    c.translate(cx, cy + r * 0.45);
    c.rotate(Math.PI / 2);
    c.beginPath();
    c.arc(0, 0, r, Math.PI * 0.5, Math.PI * 1.5);
    c.fillStyle = "#e68a00";
    c.fill();
    c.restore();
  } else {
    // Night: filled crescent moon (full circle minus offset cutout).
    const moonColor = (hourOfDay >= 3 && hourOfDay < 6) ? "#cc3333" : "#ffffff";
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fillStyle = moonColor;
    c.fill();
    c.beginPath();
    c.arc(cx + r * 0.65, cy, r, 0, Math.PI * 2);
    c.fillStyle = "#000000";
    c.fill();
  }
}

function drawGameClock(gameElapsedMs: number) {
  const totalMinutes = Math.floor(gameElapsedMs / MS_PER_GAME_MINUTE);
  const totalHours = Math.floor(totalMinutes / 60);
  const day = Math.floor(totalHours / 24) + 1;
  const hourOfDay = totalHours % 24;
  const minute = totalMinutes % 60;

  const ampm = hourOfDay < 12 ? "AM" : "PM";
  const display12 = hourOfDay === 0 ? 12 : hourOfDay > 12 ? hourOfDay - 12 : hourOfDay;
  const timeStr = `${display12}:${String(minute).padStart(2, "0")} ${ampm}`;

  const margin = 14;
  const x = WORLD_WIDTH - margin;
  const y = margin;

  const clockColor = "#aaaaaa";

  ctx.font = CLOCK_FONT;
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillStyle = clockColor;
  const dayText = `Day ${day}`;
  ctx.fillText(dayText, x, y);

  // Draw time-of-day icon to the left of "Day N".
  const dayWidth = ctx.measureText(dayText).width;
  drawTimeIcon(ctx, x - dayWidth - 12, y + 7, 6, hourOfDay);

  ctx.fillStyle = clockColor;
  ctx.fillText(timeStr, x, y + 16);
}

function drawDamageNumbers(damageNumbers: GameSnapshot["damageNumbers"]) {
  ctx.font = "bold 14px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const dn of damageNumbers) {
    const alpha = Math.max(0, 1 - dn.age / DAMAGE_NUMBER_LIFETIME);
    // Parse hex color to rgba for alpha fading.
    const r = parseInt(dn.color.slice(1, 3), 16);
    const g = parseInt(dn.color.slice(3, 5), 16);
    const b = parseInt(dn.color.slice(5, 7), 16);
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`;
    ctx.fillText(dn.text, dn.x, dn.y);
  }
}

function render(snap: GameSnapshot) {
  drawRoom(snap);

  // Glyph tiles — the client doesn't have the dungeon, so we skip drawTiles
  // for now (tiles are decorative and not part of the snapshot). If tiles are
  // needed, the snapshot can be extended. For now the room is plain.

  // Highlight precomputed path cells.
  if (snap.pathCells.length > 0) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.06)";
    for (const { col, row } of snap.pathCells) {
      ctx.fillRect(col * CELL_SIZE, row * CELL_SIZE, CELL_SIZE, CELL_SIZE);
    }
  }

  // Grid-snapped cursor highlight.
  if (cursor) {
    const { col, row } = worldToCell(cursor.x, cursor.y);
    ctx.fillStyle = "rgba(255, 255, 255, 0.18)";
    ctx.fillRect(col * CELL_SIZE, row * CELL_SIZE, CELL_SIZE, CELL_SIZE);
  }

  // Tombstones in this room.
  ctx.font = GLYPH_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#666666";
  for (const t of snap.tombstones ?? []) {
    if (!sameRoom(t.room, snap.player.room)) continue;
    ctx.fillText("\u2020", t.x, t.y);

    // Show death timestamp on hover with time-of-day icon.
    if (cursor && Math.hypot(cursor.x - t.x, cursor.y - t.y) <= NAME_REVEAL_DISTANCE) {
      const totalMinutes = Math.floor(t.gameElapsedMs / MS_PER_GAME_MINUTE);
      const totalHours = Math.floor(totalMinutes / 60);
      const day = Math.floor(totalHours / 24) + 1;
      const hourOfDay = totalHours % 24;
      const minute = totalMinutes % 60;
      const ampm = hourOfDay < 12 ? "AM" : "PM";
      const display12 = hourOfDay === 0 ? 12 : hourOfDay > 12 ? hourOfDay - 12 : hourOfDay;
      const label = `${day} ${display12}:${String(minute).padStart(2, "0")} ${ampm}`;
      ctx.font = NAME_FONT;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#999999";
      const labelWidth = ctx.measureText(label).width;
      const iconR = 4;
      const iconGap = 3;
      const totalWidth = iconR * 2 + iconGap + labelWidth;
      const startX = t.x - totalWidth / 2;
      const labelY = t.y + 16;

      // Draw time-of-day icon.
      const iconCx = startX + iconR;
      const iconCy = labelY;
      drawTimeIcon(ctx, iconCx, iconCy, iconR, hourOfDay);

      // Draw label text after the icon.
      ctx.font = NAME_FONT;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#999999";
      ctx.fillText(label, startX + iconR * 2 + iconGap, labelY);

      ctx.font = GLYPH_FONT;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#666666";
    }
  }

  // Bodies in this room, under the living — a corpse never hides a hellhound.
  for (const corpse of snap.corpses ?? []) {
    if (!sameRoom(corpse.room, snap.player.room)) continue;
    drawCorpse(ctx, corpse, {
      targeted: corpse.id === snap.targetId,
      showName: !!cursor && Math.hypot(cursor.x - corpse.x, cursor.y - corpse.y) <= NAME_REVEAL_DISTANCE,
    });
  }

  // Enemies in this room.
  for (const enemy of snap.enemies) {
    if (!sameRoom(enemy.room, snap.player.room)) continue;
    const showName = !!cursor && Math.hypot(cursor.x - enemy.x, cursor.y - enemy.y) <= NAME_REVEAL_DISTANCE;
    // The drawEnemy function expects an Enemy-shaped object — the snapshot
    // fields are a superset of what it needs.
    drawEnemy(ctx, enemy as any, {
      targeted: enemy.id === snap.targetId,
      attacking: snap.attacking && enemy.id === snap.targetId,
      showName,
    });
  }

  // Floating damage numbers.
  drawDamageNumbers(snap.damageNumbers);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  drawPlayer(snap.player.x, snap.player.y, snap.dead ? "#444444" : snap.player.color, snap.player.facing);
  drawLabelIfHovered(snap.player.x, snap.player.y, "(You)");

  // Daggers in flight.
  for (const p of snap.projectiles) {
    drawDagger(ctx, p.x, p.y, daggerAngle(p.vx, p.vy), 20);
  }

  // Overlays.
  drawHud(ctx, hudOrigin, { name: snap.player.name, color: snap.player.color, ...snap.stats, dead: snap.dead });

  // "Resurrect" button below the HUD when dead.
  if (snap.dead) {
    const rect = resurrectRect();
    ctx.font = RESURRECT_FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = cursor && hits(rect, cursor) ? "#ffd633" : "#ffffff";
    ctx.fillText("Resurrect", rect.x, rect.y);
  }

  // Auto-resurrect toggle under the stats, with a countdown while one is due —
  // three frozen seconds with no feedback reads as a hang.
  {
    const rect = autoResRect();
    ctx.font = AUTO_RES_FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = cursor && hits(rect, cursor)
      ? "#ffffff"
      : snap.autoResurrect ? "#ffd633" : "#444444";
    ctx.fillText(AUTO_RES_LABEL, rect.x, rect.y);

    if (snap.resurrectInMs !== null) {
      ctx.fillStyle = "#aaaaaa";
      ctx.fillText(`${(snap.resurrectInMs / 1000).toFixed(1)}s`, rect.x + rect.width + 8, rect.y);
    }
  }

  // Enemy portrait next to player HUD when in combat.
  if (snap.attacking && snap.targetId) {
    const currentTarget = snap.enemies.find(
      (e) => e.id === snap.targetId && sameRoom(e.room, snap.player.room),
    );
    if (currentTarget) {
      const enemyHudOrigin = { x: hudOrigin.x + HUD_WIDTH + 16, y: hudOrigin.y };
      drawEnemyHud(ctx, enemyHudOrigin, {
        name: currentTarget.name,
        glyph: currentTarget.glyph,
        color: currentTarget.color,
        health: currentTarget.health,
        maxHealth: currentTarget.maxHealth,
      });
    }
  }

  drawActionBar(ctx, barOrigin, ACTIONS, snap.activeSlot, snap.cooldown, snap.selectedCanAttack);
  drawGameClock(snap.gameElapsedMs);

  // Last, so the inspect menu sits over the overlays as well as the room.
  if (snap.inspect) drawLootMenu(ctx, snap.inspect, cursor);
}

// ------------------------------------------------------------------ game loop

function frame(now: number) {
  if (currSnapshot) {
    const t = renderFraction(now, currSnapshotTime, snapshotInterval, prevSnapshot !== null);
    const renderSnap = prevSnapshot ? interpolateSnapshot(prevSnapshot, currSnapshot, t, now) : currSnapshot;
    updateCursorStyle();
    render(renderSnap);
  }

  requestAnimationFrame(frame);
}

canvas.style.cursor = DEFAULT_CURSOR;
requestAnimationFrame(frame);
