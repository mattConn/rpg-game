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
  neighborRoom,
  roomName,
  sameRoom,
  type Direction,
} from "../shared/constants.js";
import {
  clamp,
  exitAtPoint,
  type Point,
} from "../shared/movement.js";
import type { GameSnapshot, InputMessage } from "../shared/protocol.js";
import { ACTIONS } from "../shared/actions.js";
import {
  ACTION_BAR_DEFAULT_ORIGIN,
  clampActionBarOrigin,
  drawActionBar,
  squareAtPoint,
} from "./actionbar.js";
import {
  daggerAngle,
  drawDagger,
} from "./combat.js";
import { DEFAULT_CURSOR, EXIT_CURSORS } from "./cursors.js";
import { HUD_DEFAULT_ORIGIN, HUD_HEIGHT, HUD_WIDTH, drawEnemyHud, drawHud } from "./hud.js";
import { isOverHandle } from "./panel.js";
import { drawEnemy, drawHealthBar } from "./enemies.js";
import { drawTiles } from "./tilemap.js";
import { worldToCell } from "../shared/tilemap.js";
import { fitToViewport } from "./viewport.js";

// ------------------------------------------------------------------ fonts

const GLYPH_FONT = "20px monospace";
const NAME_FONT = "12px monospace";
const ROOM_LABEL_FONT = "13px monospace";
const AUTO_LABEL_FONT = "11px monospace";
const CLOCK_FONT = "13px monospace";

/** One in-game minute = this many real ms. Must match the server constant. */
const MS_PER_GAME_MINUTE = 500;

/** Floating damage number lifetime in seconds. */
const DAMAGE_NUMBER_LIFETIME = 1.0;

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

  if (event.code === "Space" || (key.length === 1 && key >= "1" && key <= "5") || "wasd".includes(key)) {
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

// ----------------------------------------------------------- panel dragging (local UI)

type PanelName = "bar";

const panels: Record<PanelName, { origin: Point; clamp: (o: Point) => Point }> = {
  bar: { origin: { ...ACTION_BAR_DEFAULT_ORIGIN }, clamp: clampActionBarOrigin },
};

const hudOrigin: Point = { ...HUD_DEFAULT_ORIGIN };

function handleUnder(point: Point): PanelName | null {
  let grabbed: PanelName | null = null;
  let grabbedDistance = Infinity;

  for (const name of Object.keys(panels) as PanelName[]) {
    const { origin } = panels[name];
    const distance = Math.hypot(point.x - origin.x, point.y - origin.y);
    if (isOverHandle(origin, point) && distance < grabbedDistance) {
      grabbed = name;
      grabbedDistance = distance;
    }
  }

  return grabbed;
}

let drag: { panel: PanelName; offsetX: number; offsetY: number } | null = null;
let swallowNextClick = false;

canvas.addEventListener("mousedown", (event) => {
  const point = toWorld(event);
  const panel = handleUnder(point);
  swallowNextClick = panel !== null;

  if (panel) {
    const { origin } = panels[panel];
    drag = { panel, offsetX: point.x - origin.x, offsetY: point.y - origin.y };
    event.preventDefault();
  }
});

window.addEventListener("mousemove", (event) => {
  if (!drag) return;
  const point = toWorld(event);
  const panel = panels[drag.panel];
  panel.origin = panel.clamp({ x: point.x - drag.offsetX, y: point.y - drag.offsetY });
});

window.addEventListener("mouseup", () => {
  drag = null;
});

canvas.addEventListener("click", (event) => {
  if (swallowNextClick) {
    swallowNextClick = false;
    return;
  }

  const point = toWorld(event);

  // Clicking an action-bar slot selects that attack — send as slot message.
  const slot = squareAtPoint(panels.bar.origin, point);
  if (slot !== null) {
    if (ACTIONS[slot]) send({ type: "slot", index: slot });
    return;
  }

  // Everything else: send click coordinates to the server.
  send({ type: "click", x: point.x, y: point.y });
});

canvas.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  const point = toWorld(event);
  send({ type: "rightclick", x: point.x, y: point.y });
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
  const room = snap?.player.room ?? { col: 1, row: 1 };
  const exit = cursor ? exitAtPoint(room, cursor) : null;

  let wanted = DEFAULT_CURSOR;
  if (drag) wanted = "grabbing";
  else if (cursor && handleUnder(cursor)) wanted = "grab";
  else if (exit) wanted = EXIT_CURSORS[exit];

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

  // Projectiles: extrapolate from curr using vx/vy (they travel in straight lines).
  const elapsed = (now - currSnapshotTime) / 1000; // seconds since curr arrived
  const projectiles = curr.projectiles.map((p) => ({
    ...p,
    x: p.x + p.vx * elapsed,
    y: p.y + p.vy * elapsed,
  }));

  // Damage numbers: lerp y and age by index.
  const damageNumbers = curr.damageNumbers.map((cd, i) => {
    const pd = prev.damageNumbers[i];
    if (!pd) return cd;
    return { ...cd, y: lerp(pd.y, cd.y, t), age: lerp(pd.age, cd.age, t) };
  });

  // Move target: lerp if both snapshots have one.
  const moveTarget =
    prev.moveTarget && curr.moveTarget
      ? { x: lerp(prev.moveTarget.x, curr.moveTarget.x, t), y: lerp(prev.moveTarget.y, curr.moveTarget.y, t) }
      : curr.moveTarget;

  const gameElapsedMs = lerp(prev.gameElapsedMs, curr.gameElapsedMs, t);

  return {
    ...curr,
    player,
    enemies,
    projectiles,
    damageNumbers,
    moveTarget,
    gameElapsedMs,
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
    const open = neighborRoom(room, direction) !== null;
    const [x1, y1, x2, y2] = edges[direction];

    ctx.strokeStyle = open ? "#2f4f57" : "#3a3a3a";
    ctx.lineWidth = 4;
    ctx.setLineDash(open ? [10, 12] : []);

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  ctx.setLineDash([]);

  ctx.font = ROOM_LABEL_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillStyle = "#555555";
  ctx.fillText(roomName(room), 14, WORLD_HEIGHT - 12);
}

function drawPlayer(x: number, y: number, color: string) {
  ctx.font = GLYPH_FONT;
  ctx.fillStyle = color;
  ctx.fillText("@", x, y);
}

function drawLabelIfHovered(x: number, y: number, label: string) {
  if (!cursor || !label) return;
  if (Math.hypot(cursor.x - x, cursor.y - y) > NAME_REVEAL_DISTANCE) return;

  ctx.font = NAME_FONT;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(label, x, y + PLAYER_RADIUS + 10);
}

function drawAutoLabel(autoMode: boolean) {
  const margin = 14;
  const x = WORLD_WIDTH - margin;
  const y = margin + 38;

  ctx.font = AUTO_LABEL_FONT;
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillStyle = autoMode ? "#ffd633" : "#444444";
  ctx.fillText("Auto", x, y);
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

  ctx.font = CLOCK_FONT;
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#aaaaaa";
  ctx.fillText(`Day ${day}`, x, y);
  ctx.fillText(timeStr, x, y + 16);
}

function drawDamageNumbers(damageNumbers: GameSnapshot["damageNumbers"]) {
  ctx.font = "bold 14px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const dn of damageNumbers) {
    const alpha = Math.max(0, 1 - dn.age / DAMAGE_NUMBER_LIFETIME);
    ctx.fillStyle = `rgba(255, 214, 51, ${alpha.toFixed(2)})`;
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

  if (snap.moveTarget) {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
    ctx.beginPath();
    ctx.arc(snap.moveTarget.x, snap.moveTarget.y, 5, 0, Math.PI * 2);
    ctx.stroke();
  }

  drawPlayer(snap.player.x, snap.player.y, snap.player.color);
  drawLabelIfHovered(snap.player.x, snap.player.y, "(You)");

  // Daggers in flight.
  for (const p of snap.projectiles) {
    drawDagger(ctx, p.x, p.y, daggerAngle(p.vx, p.vy), 20);
  }

  // Overlays.
  drawHud(ctx, hudOrigin, { name: snap.player.name, color: snap.player.color, ...snap.stats });

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

  drawActionBar(ctx, panels.bar.origin, ACTIONS, snap.activeSlot);
  drawAutoLabel(snap.autoMode);
  drawGameClock(snap.gameElapsedMs);
}

// ------------------------------------------------------------------ game loop

function frame(now: number) {
  if (currSnapshot) {
    const elapsed = now - currSnapshotTime;
    const interval = currSnapshotTime - prevSnapshotTime || 50;
    const t = prevSnapshot ? Math.min(elapsed / interval, 1) : 1;
    const renderSnap = prevSnapshot ? interpolateSnapshot(prevSnapshot, currSnapshot, t, now) : currSnapshot;
    updateCursorStyle();
    render(renderSnap);
  }

  requestAnimationFrame(frame);
}

canvas.style.cursor = DEFAULT_CURSOR;
requestAnimationFrame(frame);
